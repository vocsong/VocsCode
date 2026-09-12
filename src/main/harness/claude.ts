/** Claude Agent SDK adapter: streaming query() turns, canUseTool approvals and file-change hooks, normalized to SessionEvents. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  query,
  type CanUseTool,
  type HookCallback,
  type Options,
  type PermissionMode as SdkPermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel, FileChange, ModelInfo, ModelRef, PermissionMode, TranscriptItem, UsageTotals, UserInput } from '../../shared/types';
import { findContextWindow } from '../models/static-models';
import { AsyncQueue, deferred, errorMessage, shortId, truncate, withTimeout, type Deferred } from '../util/async';
import { makeFileChange } from '../util/file-changes';
import { TurnUsageTracker } from '../util/turn-usage';
import { gateAction, isOutsideWorkspace, OPTIONS_ALLOW_DENY, PLAN_MODE_DENIAL } from './permissions';
import type { HarnessAdapter, HarnessContext } from './types';

const APP_ID = 'vocs-code/0.1.0';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'TodoRead',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'ToolSearch',
  'AskUserQuestion',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'Skill'
]);

function toSdkMode(mode: PermissionMode): SdkPermissionMode {
  switch (mode) {
    case 'ask':
      return 'default';
    case 'accept-edits':
      return 'acceptEdits';
    case 'plan':
      return 'plan';
    case 'auto':
      // Our own gate auto-allows non-dangerous actions; keep the CLI prompting so we see everything.
      return 'default';
    case 'full-auto':
      return 'bypassPermissions';
  }
}

function summarizeInput(toolName: string, input: Record<string, unknown>): string {
  const i = input as Record<string, unknown>;
  if (typeof i.command === 'string') return i.command;
  if (typeof i.file_path === 'string') return i.file_path as string;
  if (typeof i.path === 'string') return i.path as string;
  if (typeof i.pattern === 'string') return `${i.pattern}${typeof i.path === 'string' ? ` in ${i.path}` : ''}`;
  if (typeof i.url === 'string') return i.url as string;
  if (typeof i.query === 'string') return i.query as string;
  if (typeof i.description === 'string') return i.description as string;
  if (typeof i.prompt === 'string') return truncate(i.prompt as string, 200, '…');
  const s = JSON.stringify(i);
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

function toolHint(toolName: string): TranscriptItem extends infer _ ? 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'think' | 'mcp' | 'agent' | 'other' : never {
  if (toolName === 'Bash' || toolName === 'PowerShell') return 'execute';
  if (EDIT_TOOLS.has(toolName)) return 'edit';
  if (toolName === 'Read') return 'read';
  if (toolName === 'Glob' || toolName === 'Grep' || toolName === 'LS') return 'search';
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return 'fetch';
  if (toolName === 'Agent' || toolName === 'Task') return 'agent';
  if (toolName.startsWith('mcp__')) return 'mcp';
  return 'other';
}

interface ContentBlockLike {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export class ClaudeAdapter implements HarnessAdapter {
  readonly id = 'claude' as const;
  private q: Query | null = null;
  private input = new AsyncQueue<SDKUserMessage>();
  private abort = new AbortController();
  private pump: Promise<void> | null = null;
  private _busy = false;
  private sessionId: string | undefined;
  private sessionAllowed = new Set<string>();
  private currentAssistant: { id: string; text: string; thinking: string } | null = null;
  private toolItems = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>();
  private fileSnapshots = new Map<string, string | null>();
  private turnStartedAt = 0;
  private readonly usage: TurnUsageTracker;
  private started = false;
  private modelsEmitted = false;
  private compactionWaiter: Deferred<void> | null = null;

  constructor(private readonly ctx: HarnessContext) {
    this.usage = new TurnUsageTracker(ctx.session().usage);
  }

  get busy(): boolean {
    return this._busy;
  }

  private buildOptions(): Options {
    const s = this.ctx.settings();
    const meta = this.ctx.session();
    const cfg = meta.config;
    const mode = this.ctx.permissionMode();
    const bin = this.ctx.runtime.resolve('claude');
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: APP_ID };
    // Never let this app's own Claude Code host variables leak into a nested session.
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDE_CODE_USE_BEDROCK' && k !== 'CLAUDE_CODE_USE_VERTEX' && k !== 'CLAUDE_CODE_USE_FOUNDRY') delete env[k];
    delete env.CLAUDECODE;

    const options: Options = {
      cwd: meta.cwd,
      model: cfg.model?.model || meta.activeModel?.model,
      permissionMode: toSdkMode(mode),
      allowDangerouslySkipPermissions: mode === 'full-auto',
      canUseTool: this.canUseTool,
      includePartialMessages: true,
      persistSession: true,
      env,
      abortController: this.abort,
      settingSources: s.claude.settingSources,
      systemPrompt: cfg.appendSystemPrompt
        ? { type: 'preset', preset: 'claude_code', append: cfg.appendSystemPrompt }
        : { type: 'preset', preset: 'claude_code' },
      maxBudgetUsd: cfg.maxBudgetUsd,
      enableFileCheckpointing: true,
      stderr: (line: string) => this.ctx.log('debug', `[claude] ${line}`),
      hooks: {
        PreToolUse: [{ hooks: [this.preToolUse] }],
        PostToolUse: [{ hooks: [this.postToolUse] }]
      }
    };
    const effort = this.ctx.effort();
    if (effort && effort !== 'minimal') options.effort = effort;
    if (bin) options.pathToClaudeCodeExecutable = bin.path;
    if (meta.harnessRef.claudeSessionId) {
      options.resume = meta.harnessRef.claudeSessionId;
      if (meta.harnessRef.forkOnResume) {
        options.forkSession = true;
        this.ctx.updateRef({ forkOnResume: false });
      }
    }
    return options;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const options = this.buildOptions();
    const s = this.ctx.settings();
    if (s.claude.useProviderKey) {
      const key = await this.ctx.getApiKey('anthropic');
      if (key) options.env = { ...(options.env ?? {}), ANTHROPIC_API_KEY: key };
    }
    this.q = query({ prompt: this.input, options });
    this.pump = this.consume(this.q).catch((e) => {
      this.compactionWaiter?.reject(e instanceof Error ? e : new Error(errorMessage(e)));
      this.ctx.emit({ type: 'error', message: `Claude harness stopped: ${errorMessage(e)}`, fatal: true });
      this.ctx.emit({ type: 'status', status: 'error', detail: errorMessage(e) });
    });
    this.ctx.emit({ type: 'status', status: 'idle' });
  }

  private canUseTool: CanUseTool = async (toolName, input, { suggestions }): Promise<PermissionResult> => {
    const mode = this.ctx.permissionMode();
    const isEdit = EDIT_TOOLS.has(toolName);
    const mutating = !READ_ONLY_TOOLS.has(toolName);
    const command = typeof (input as Record<string, unknown>).command === 'string' ? ((input as Record<string, unknown>).command as string) : undefined;

    if (toolName === 'AskUserQuestion') return this.askUserQuestion(input);

    const cwd = this.ctx.session().cwd;
    const editTarget = isEdit ? String((input as Record<string, unknown>).file_path ?? (input as Record<string, unknown>).notebook_path ?? '') : '';
    const outsideWorkspace = isEdit && isOutsideWorkspace(cwd, editTarget || undefined, path);
    const verdict = gateAction(mode, { mutating, isEdit, command, sessionAllowed: this.sessionAllowed.has(toolName), outsideWorkspace });
    if (verdict === 'allow') return { behavior: 'allow', updatedInput: input };
    if (verdict === 'deny') return { behavior: 'deny', message: PLAN_MODE_DENIAL };

    const changes = isEdit ? await this.previewChange(toolName, input) : undefined;
    const decision = await this.ctx.requestApproval({
      kind: command ? 'command' : isEdit ? 'file_change' : 'tool',
      title: command ? 'Run command?' : isEdit ? `Allow ${toolName}?` : `Allow ${toolName}?`,
      toolName,
      command,
      cwd,
      input,
      changes,
      description: command ? undefined : outsideWorkspace ? `${summarizeInput(toolName, input)} (outside the project directory)` : summarizeInput(toolName, input),
      options: OPTIONS_ALLOW_DENY
    });
    if (decision.optionId === 'allow') return { behavior: 'allow', updatedInput: (decision.updatedInput as Record<string, unknown>) ?? input };
    if (decision.optionId === 'allow_session') {
      this.sessionAllowed.add(toolName);
      // Keep the grant in-process only. Returning the SDK's suggestions would install a CLI-side
      // session rule that skips canUseTool for later calls, bypassing the host-side dangerous
      // command and outside-workspace checks in gateAction.
      return { behavior: 'allow', updatedInput: input };
    }
    return { behavior: 'deny', message: decision.note?.trim() || 'The user declined this action.' };
  };

  private async askUserQuestion(input: Record<string, unknown>): Promise<PermissionResult> {
    const qs = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : [];
    const decision = await this.ctx.requestApproval({
      kind: 'question',
      title: 'Claude has a question',
      toolName: 'AskUserQuestion',
      input,
      options: [
        { id: 'allow', label: 'Answer', kind: 'allow' },
        { id: 'deny', label: 'Skip', kind: 'deny' }
      ],
      questions: qs.map((q, i) => ({
        id: String(i),
        header: typeof q.header === 'string' ? q.header : undefined,
        question: String(q.question ?? ''),
        options: Array.isArray(q.options)
          ? (q.options as Record<string, unknown>[]).map((o) => ({ label: String(o.label ?? ''), description: typeof o.description === 'string' ? o.description : undefined }))
          : undefined,
        allowOther: true
      }))
    });
    if (decision.optionId !== 'allow') return { behavior: 'deny', message: 'The user skipped the question.' };
    const answers: Record<string, string> = {};
    qs.forEach((q, i) => {
      const a = decision.answers?.[String(i)];
      if (a !== undefined) answers[String(q.question ?? '')] = a;
    });
    return { behavior: 'allow', updatedInput: { ...input, answers } };
  }

  private async previewChange(toolName: string, input: Record<string, unknown>): Promise<FileChange[] | undefined> {
    try {
      const file = String(input.file_path ?? input.path ?? '');
      if (!file) return undefined;
      const abs = path.isAbsolute(file) ? file : path.join(this.ctx.session().cwd, file);
      let before: string | null = null;
      try {
        before = await fs.readFile(abs, 'utf8');
      } catch {
        before = null;
      }
      let after = before ?? '';
      if (toolName === 'Write') after = String(input.content ?? '');
      else if (toolName === 'Edit') {
        const oldS = String(input.old_string ?? '');
        const newS = String(input.new_string ?? '');
        after = input.replace_all ? (before ?? '').split(oldS).join(newS) : (before ?? '').replace(oldS, newS);
      } else if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
        for (const e of input.edits as Record<string, unknown>[]) {
          const oldS = String(e.old_string ?? '');
          const newS = String(e.new_string ?? '');
          after = e.replace_all ? after.split(oldS).join(newS) : after.replace(oldS, newS);
        }
      } else return undefined;
      return [makeFileChange(this.ctx.session().cwd, file, before, after, { newFileHeader: '(new file)' })];
    } catch {
      return undefined;
    }
  }

  private preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name === 'PreToolUse' && EDIT_TOOLS.has(input.tool_name)) {
      const ti = input.tool_input as Record<string, unknown>;
      const file = String(ti?.file_path ?? ti?.notebook_path ?? '');
      if (file) {
        const abs = path.isAbsolute(file) ? file : path.join(this.ctx.session().cwd, file);
        try {
          this.fileSnapshots.set(input.tool_use_id, await fs.readFile(abs, 'utf8'));
        } catch {
          this.fileSnapshots.set(input.tool_use_id, null);
        }
      }
    }
    return { continue: true };
  };

  private postToolUse: HookCallback = async (input) => {
    if (input.hook_event_name === 'PostToolUse' && EDIT_TOOLS.has(input.tool_name)) {
      const ti = input.tool_input as Record<string, unknown>;
      const file = String(ti?.file_path ?? ti?.notebook_path ?? '');
      if (file) {
        const abs = path.isAbsolute(file) ? file : path.join(this.ctx.session().cwd, file);
        const before = this.fileSnapshots.get(input.tool_use_id);
        this.fileSnapshots.delete(input.tool_use_id);
        try {
          const after = await fs.readFile(abs, 'utf8');
          const change = makeFileChange(this.ctx.session().cwd, file, before, after);
          const item = this.toolItems.get(input.tool_use_id);
          if (item) {
            item.changes = [change];
            this.ctx.emit({ type: 'item.upsert', item: { ...item } });
          }
        } catch {
          /* ignore */
        }
      }
    }
    return { continue: true };
  };

  private async consume(q: Query): Promise<void> {
    for await (const msg of q) this.handle(msg, q);
    this.compactionWaiter?.reject(new Error('Claude Code stopped during context compaction.'));
    this._busy = false;
    this.ctx.emit({ type: 'status', status: 'stopped', detail: 'Claude Code process ended' });
  }

  private handle(msg: SDKMessage, q: Query): void {
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          this.ctx.updateRef({ claudeSessionId: msg.session_id });
          if (msg.model) this.ctx.updateMeta({ activeModel: { provider: 'anthropic', model: msg.model } });
          if (!this.modelsEmitted) {
            this.modelsEmitted = true;
            q.supportedModels()
              .then((models) => this.ctx.emit({ type: 'models', models: models.map(claudeModelToInfo) }))
              .catch(() => {
                // Retry on the next init so the model picker is not permanently empty.
                this.modelsEmitted = false;
              });
          }
        } else if (msg.subtype === 'compact_boundary') {
          if (msg.compact_metadata.trigger === 'manual') this.compactionWaiter?.resolve();
        } else if ((msg as { subtype?: string }).subtype === 'status') {
          const m = msg as { compact_result?: 'success' | 'failed'; compact_error?: string };
          if (m.compact_result) {
            this.info(`Context compaction ${m.compact_result}.`, m.compact_result === 'failed' ? 'warn' : 'info');
            if (m.compact_result === 'failed') this.compactionWaiter?.reject(new Error(m.compact_error || 'Claude context compaction failed.'));
            else this.compactionWaiter?.resolve();
          }
        } else if ((msg as { subtype?: string }).subtype === 'permission_denied') {
          const m = msg as { tool_name: string };
          this.info(`Tool ${m.tool_name} was auto-denied by the harness.`, 'warn');
        }
        return;
      }
      case 'stream_event': {
        this.markTurnStarted();
        if (msg.parent_tool_use_id) return; // nested subagent streams are summarized via tool items
        const ev = msg.event as { type: string; index?: number; content_block?: ContentBlockLike; delta?: { type: string; text?: string; thinking?: string } };
        if (ev.type === 'message_start') this.ensureAssistant();
        if (ev.type === 'content_block_delta' && ev.delta) {
          const a = this.ensureAssistant();
          if (ev.delta.type === 'text_delta' && ev.delta.text) {
            a.text += ev.delta.text;
            this.ctx.emit({ type: 'item.delta', id: a.id, textDelta: ev.delta.text });
          } else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
            a.thinking += ev.delta.thinking;
            this.ctx.emit({ type: 'item.delta', id: a.id, thinkingDelta: ev.delta.thinking });
          }
        }
        return;
      }
      case 'assistant': {
        this.markTurnStarted();
        const content = (msg.message.content ?? []) as ContentBlockLike[];
        for (const block of content) {
          if (block.type === 'text' && !msg.parent_tool_use_id) {
            const a = this.ensureAssistant();
            if (block.text && block.text.length >= a.text.length) a.text = block.text;
            this.ctx.emit({ type: 'item.upsert', item: { id: a.id, kind: 'assistant', ts: Date.now(), text: a.text, thinking: a.thinking || undefined, model: msg.message.model, streaming: true } });
          } else if (block.type === 'thinking' && !msg.parent_tool_use_id) {
            const a = this.ensureAssistant();
            if (block.thinking && block.thinking.length >= a.thinking.length) a.thinking = block.thinking;
          } else if (block.type === 'tool_use' && block.id && block.name) {
            const input = (block.input ?? {}) as Record<string, unknown>;
            const item: Extract<TranscriptItem, { kind: 'tool' }> = {
              id: block.id,
              kind: 'tool',
              ts: Date.now(),
              name: block.name,
              hint: toolHint(block.name),
              input,
              summary: summarizeInput(block.name, input),
              status: 'running',
              parentId: msg.parent_tool_use_id ?? null
            };
            this.toolItems.set(block.id, item);
            this.ctx.emit({ type: 'item.upsert', item });
            // A tool call closes the current text bubble so the next text starts fresh below the tool card.
            if (!msg.parent_tool_use_id) this.finishAssistant(msg.message.model);
          }
        }
        return;
      }
      case 'user': {
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content as ContentBlockLike[]) {
          if (block.type !== 'tool_result' || !block.tool_use_id) continue;
          const item = this.toolItems.get(block.tool_use_id);
          if (!item) continue;
          item.output = truncate(extractText(block.content), 40_000);
          item.status = block.is_error ? 'error' : 'done';
          this.ctx.emit({ type: 'item.upsert', item: { ...item } });
        }
        return;
      }
      case 'tool_progress':
        return;
      case 'result': {
        this.finishAssistant();
        this._busy = false;
        let usage: Partial<UsageTotals> | undefined;
        const mu = (msg as { modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number; contextWindow: number }> }).modelUsage;
        let trackerTurn: ReturnType<TurnUsageTracker['finishTurn']>;
        if (typeof msg.total_cost_usd === 'number') this.usage.setCumulative({ costUsd: msg.total_cost_usd });
        if (mu) {
          const cumulative: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };
          for (const v of Object.values(mu)) {
            cumulative.inputTokens += v.inputTokens;
            cumulative.outputTokens += v.outputTokens;
            cumulative.cacheReadTokens += v.cacheReadInputTokens;
            cumulative.cacheWriteTokens += v.cacheCreationInputTokens;
            cumulative.costUsd += v.costUSD;
            cumulative.contextWindow = v.contextWindow || cumulative.contextWindow;
          }
          const u = (msg as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage;
          this.usage.setCumulative({
            inputTokens: cumulative.inputTokens,
            outputTokens: cumulative.outputTokens,
            cacheReadTokens: cumulative.cacheReadTokens,
            cacheWriteTokens: cumulative.cacheWriteTokens,
            costUsd: cumulative.costUsd,
            contextWindow: cumulative.contextWindow,
            contextTokens: u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : undefined
          });
          trackerTurn = this.usage.finishTurn();
          const turnUsage = trackerTurn.usage;
          usage = turnUsage ? { inputTokens: turnUsage.inputTokens, outputTokens: turnUsage.outputTokens, cacheReadTokens: turnUsage.cacheReadTokens, cacheWriteTokens: turnUsage.cacheWriteTokens } : undefined;
          this.ctx.emit({ type: 'usage', totals: trackerTurn.totals });
        } else {
          trackerTurn = this.usage.finishTurn(false);
        }
        const turnCost = trackerTurn.usage?.costUsd ?? 0;
        const turnMsg = msg as { is_error?: boolean; terminal_reason?: string };
        const isError = turnMsg.is_error || msg.subtype !== 'success';
        const interrupted = turnMsg.terminal_reason === 'aborted_streaming' || turnMsg.terminal_reason === 'aborted_tools';
        const status = interrupted ? 'interrupted' : isError ? 'failed' : 'completed';
        this.ctx.emit({
          type: 'item.upsert',
          item: {
            id: shortId('turn_'),
            kind: 'turn',
            ts: Date.now(),
            status,
            durationMs: msg.duration_ms ?? Date.now() - this.turnStartedAt,
            costUsd: turnCost,
            usage,
            error: isError ? `${msg.subtype}${'result' in msg && msg.result ? `: ${msg.result}` : ''}` : undefined
          }
        });
        this.ctx.emit({ type: 'status', status: 'idle' });
        return;
      }
      default:
        return;
    }
  }

  private ensureAssistant(): { id: string; text: string; thinking: string } {
    if (!this.currentAssistant) {
      this.currentAssistant = { id: shortId('a_'), text: '', thinking: '' };
      this.ctx.emit({ type: 'item.upsert', item: { id: this.currentAssistant.id, kind: 'assistant', ts: Date.now(), text: '', streaming: true } });
    }
    return this.currentAssistant;
  }

  private finishAssistant(model?: string): void {
    const a = this.currentAssistant;
    if (!a) return;
    this.currentAssistant = null;
    if (!a.text && !a.thinking) return;
    this.ctx.emit({ type: 'item.upsert', item: { id: a.id, kind: 'assistant', ts: Date.now(), text: a.text, thinking: a.thinking || undefined, model, streaming: false } });
  }

  /** The CLI can begin a turn on its own — queued/steered messages (e.g. right after an interrupt)
   *  run without a send() call — so turn start must also be observed from the message stream. */
  private markTurnStarted(): void {
    if (this._busy) return;
    this._busy = true;
    this.usage.beginTurn();
    this.turnStartedAt = Date.now();
    this.ctx.emit({ type: 'status', status: 'running' });
  }

  private info(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.ctx.emit({ type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level, text } });
  }

  async send(input: UserInput): Promise<void> {
    if (!this.q) await this.start();
    const content: unknown[] = [];
    for (const img of input.images ?? []) content.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } });
    if (input.text) content.push({ type: 'text', text: input.text });
    const message = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? '',
      priority: input.mode === 'steer' ? 'now' : input.mode === 'queue' ? 'next' : undefined
    } as unknown as SDKUserMessage;
    if (!this._busy) {
      this._busy = true;
      this.usage.beginTurn();
      this.turnStartedAt = Date.now();
      this.ctx.emit({ type: 'status', status: 'running' });
    }
    this.input.push(message);
  }

  async interrupt(): Promise<void> {
    try {
      await this.q?.interrupt();
    } catch (e) {
      this.ctx.log('warn', `interrupt failed: ${errorMessage(e)}`);
    }
  }

  async setModel(model: ModelRef): Promise<void> {
    await this.q?.setModel(model.model);
    this.ctx.updateMeta({ activeModel: model });
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    if (!this.q) return;
    const level = effort === 'minimal' ? 'low' : effort;
    await this.q.applyFlagSettings({ effortLevel: level });
    this.ctx.updateMeta({ activeEffort: effort });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (mode === 'full-auto') {
      this.info('Full access requires restarting the Claude process; it will apply on the next session start.', 'warn');
      return;
    }
    await this.q?.setPermissionMode(toSdkMode(mode));
    // Per-tool session grants do not survive a mode change.
    this.sessionAllowed.clear();
  }

  async compact(): Promise<void> {
    if (this.compactionWaiter) {
      await withTimeout(this.compactionWaiter.promise, 120_000, 'Claude context compaction');
      return;
    }
    const waiter = deferred<void>();
    // Process shutdown can reject this before send() reaches its next microtask; mark it observed now.
    void waiter.promise.catch(() => undefined);
    this.compactionWaiter = waiter;
    try {
      await this.send({ text: '/compact' });
      await withTimeout(waiter.promise, 120_000, 'Claude context compaction');
    } finally {
      if (this.compactionWaiter === waiter) this.compactionWaiter = null;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.q) return [];
    return (await this.q.supportedModels()).map(claudeModelToInfo);
  }

  async dispose(): Promise<void> {
    this.compactionWaiter?.reject(new Error('Claude context compaction was cancelled.'));
    this.input.close();
    this.abort.abort();
    try {
      this.q?.close();
    } catch {
      /* ignore */
    }
    this.q = null;
  }
}

export function claudeModelToInfo(m: { value: string; displayName: string; description?: string; resolvedModel?: string }): ModelInfo {
  return {
    id: m.value,
    provider: 'anthropic',
    displayName: m.displayName || m.value,
    description: m.description,
    contextWindow: findContextWindow('anthropic', m.resolvedModel ?? m.value),
    supportsImages: true,
    supportsReasoning: true,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max']
  };
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object') {
          const o = c as { type?: string; text?: string };
          if (o.type === 'text' && o.text) return o.text;
          if (o.type === 'image') return '[image]';
        }
        return '';
      })
      .join('\n');
  }
  return '';
}
