import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EffortLevel, FileChange, ModelInfo, ModelRef, PermissionMode, TranscriptItem, UsageTotals, UserInput } from '../../shared/types';
import { deferred, errorMessage, shortId, truncate, withTimeout, type Deferred } from '../util/async';
import { estimateCostUsd, findPricing, CODEX_STATIC_MODELS } from '../models/static-models';
import { JsonRpcStdioClient } from './jsonrpc';
import { gateAction, OPTIONS_ALLOW_DENY } from './permissions';
import { killTree, spawnTool } from './spawn';
import type { HarnessAdapter, HarnessContext } from './types';

/* ---- Minimal protocol shapes (from `codex app-server generate-ts`) ---- */
type AskForApproval = 'untrusted' | 'on-request' | 'never';
type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };

interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
  inputModalities: string[];
  isDefault: boolean;
}

type ThreadItem =
  | { type: 'userMessage'; id: string }
  | { type: 'agentMessage'; id: string; text: string; phase: string | null }
  | { type: 'plan'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd: string;
      status: 'inProgress' | 'completed' | 'failed' | 'declined';
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs: number | null;
    }
  | { type: 'fileChange'; id: string; changes: { path: string; kind: { type: 'add' | 'delete' | 'update'; move_path?: string | null }; diff: string }[]; status: 'inProgress' | 'completed' | 'failed' | 'declined' }
  | { type: 'mcpToolCall'; id: string; server: string; tool: string; status: string; arguments: unknown; result: { content: unknown[]; structuredContent: unknown } | null; error: { message: string } | null; durationMs: number | null }
  | { type: 'dynamicToolCall'; id: string; tool: string; arguments: unknown; status: string; contentItems: unknown[] | null; success: boolean | null }
  | { type: 'webSearch'; id: string; query?: string }
  | { type: 'contextCompaction'; id: string }
  | { type: 'subAgentActivity'; id: string; [k: string]: unknown }
  | { type: 'collabAgentToolCall'; id: string; tool: string; [k: string]: unknown }
  | { type: string; id: string; [k: string]: unknown };

/**
 * Codex approval policies: `untrusted` asks for every command except known read-only ones
 * (what our Ask / Accept-edits modes promise), `on-request` asks only when the sandboxed run
 * needs escalation (our Auto), `never` for full access.
 */
function approvalPolicyFor(mode: PermissionMode): AskForApproval {
  switch (mode) {
    case 'full-auto':
      return 'never';
    case 'auto':
      return 'on-request';
    default:
      return 'untrusted';
  }
}

function sandboxPolicyFor(mode: PermissionMode, cwd: string): SandboxPolicy {
  switch (mode) {
    case 'plan':
      return { type: 'readOnly', networkAccess: false };
    case 'full-auto':
      return { type: 'dangerFullAccess' };
    case 'auto':
      return { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    default:
      return { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  }
}

function sandboxModeFor(mode: PermissionMode): 'read-only' | 'workspace-write' | 'danger-full-access' {
  return mode === 'plan' ? 'read-only' : mode === 'full-auto' ? 'danger-full-access' : 'workspace-write';
}

export class CodexAppServerAdapter implements HarnessAdapter {
  readonly id = 'codex' as const;
  private rpc: JsonRpcStdioClient | null = null;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private _busy = false;
  private model: string | undefined;
  private modelProvider: string | undefined;
  private effort: EffortLevel | undefined;
  private items = new Map<string, TranscriptItem>();
  private fileChangeItems = new Map<string, FileChange[]>();
  /** Exact command lines the user approved "for session"; Codex keeps its own per-command memory too. */
  private sessionAllowedCommands = new Set<string>();
  private queue: UserInput[] = [];
  private totals: UsageTotals;
  private turnStartedAt = 0;
  /** Totals when the current turn started; the turn item reports the delta. */
  private turnBase: UsageTotals | null = null;
  private models: ModelInfo[] = [];
  private compactionWaiter: Deferred<void> | null = null;

  constructor(private readonly ctx: HarnessContext) {
    this.totals = { ...ctx.session().usage };
  }

  get busy(): boolean {
    return this._busy;
  }

  async start(): Promise<void> {
    const meta = this.ctx.session();
    const bin = this.ctx.runtime.resolve('codex');
    if (!bin) throw new Error('Codex CLI not found. Install it with `npm install -g @openai/codex` or set the path in Settings.');
    const env: NodeJS.ProcessEnv = { ...process.env };
    const key = await this.ctx.getApiKey('openai');
    if (key && !env.OPENAI_API_KEY && !env.CODEX_API_KEY) env.OPENAI_API_KEY = key;
    if (meta.config.codexModelProvider?.envKey) {
      const custom = await this.ctx.getApiKey(meta.config.codexModelProvider.id);
      if (custom) env[meta.config.codexModelProvider.envKey] = custom;
    }
    const child = spawnTool(bin.path, ['app-server'], { cwd: meta.cwd, env });
    this.rpc = new JsonRpcStdioClient(child);
    try {
      this.rpc.onStderr = (l) => this.ctx.log('debug', `[codex] ${l}`);
      this.rpc.onClose = (code) => {
        this.compactionWaiter?.reject(new Error(`Codex stopped during context compaction (${code}).`));
        this._busy = false;
        this.ctx.emit({ type: 'status', status: 'stopped', detail: `codex app-server exited (${code})` });
      };
      this.wireNotifications(this.rpc);
      this.wireServerRequests(this.rpc);

      await withTimeout(
        this.rpc.request('initialize', {
          clientInfo: { name: 'vocs-code', title: 'Vocs Code', version: '0.1.0' },
          capabilities: { experimentalApi: true, requestAttestation: false }
        }),
        30_000,
        'codex initialize'
      );

      this.model = meta.config.model?.model || meta.activeModel?.model;
      this.modelProvider = meta.config.codexModelProvider?.id;
      this.effort = this.ctx.effort();
      const mode = this.ctx.permissionMode();
      const common: Record<string, unknown> = {
        model: this.model ?? null,
        modelProvider: this.modelProvider ?? null,
        cwd: meta.cwd,
        approvalPolicy: approvalPolicyFor(mode),
        sandbox: sandboxModeFor(mode)
      };
      if (meta.config.codexModelProvider) {
        const p = meta.config.codexModelProvider;
        common.config = {
          model_providers: {
            [p.id]: { name: p.name, base_url: p.baseUrl, env_key: p.envKey, wire_api: p.wireApi ?? 'chat' }
          }
        };
      }
      let res: { thread: { id: string }; model: string; modelProvider: string; reasoningEffort: string | null };
      if (meta.harnessRef.codexThreadId) {
        try {
          res = await withTimeout(this.rpc.request('thread/resume', { threadId: meta.harnessRef.codexThreadId, ...common }), 30_000, 'thread/resume');
        } catch (e) {
          this.info(`Could not resume Codex thread (${errorMessage(e)}); starting a new one.`, 'warn');
          res = await withTimeout(this.rpc.request('thread/start', { ...common, sessionStartSource: null }), 30_000, 'thread/start');
        }
      } else {
        res = await withTimeout(this.rpc.request('thread/start', common), 30_000, 'thread/start');
      }
      this.threadId = res.thread.id;
      this.ctx.updateRef({ codexThreadId: this.threadId });
      this.ctx.updateMeta({
        activeModel: { provider: res.modelProvider || 'openai', model: res.model },
        activeEffort: (res.reasoningEffort as EffortLevel | null) ?? undefined
      });
      this.ctx.emit({ type: 'status', status: 'idle' });
      void this.listModels().then((models) => models.length && this.ctx.emit({ type: 'models', models }));
    } catch (e) {
      // Handshake failed after spawn: tear the transport down so no app-server (with its
      // injected API keys) is orphaned, then rethrow.
      const rpc = this.rpc;
      this.rpc = null;
      rpc?.close();
      setTimeout(() => killTree(child), 2000);
      throw e;
    }
  }

  private wireNotifications(rpc: JsonRpcStdioClient): void {
    rpc.onNotification('turn/started', (p) => {
      const n = p as { turn: { id: string } };
      this.turnId = n.turn.id;
      this._busy = true;
      this.turnStartedAt = this.turnStartedAt || Date.now();
      this.turnBase ??= { ...this.totals };
      this.ctx.emit({ type: 'status', status: 'running' });
    });
    rpc.onNotification('item/started', (p) => this.upsertItem((p as { item: ThreadItem }).item, false));
    rpc.onNotification('item/completed', (p) => this.upsertItem((p as { item: ThreadItem }).item, true));
    rpc.onNotification('item/agentMessage/delta', (p) => {
      const n = p as { itemId: string; delta: string };
      const item = this.items.get(n.itemId);
      if (item && item.kind === 'assistant') {
        item.text += n.delta;
        this.ctx.emit({ type: 'item.delta', id: n.itemId, textDelta: n.delta });
      }
    });
    rpc.onNotification('item/plan/delta', (p) => {
      const n = p as { itemId: string; delta: string };
      const item = this.items.get(n.itemId);
      if (item && item.kind === 'assistant') {
        item.text += n.delta;
        this.ctx.emit({ type: 'item.delta', id: n.itemId, textDelta: n.delta });
      }
    });
    const reasoningDelta = (p: unknown) => {
      const n = p as { itemId: string; delta: string };
      let item = this.items.get(n.itemId);
      if (!item) {
        item = { id: n.itemId, kind: 'assistant', ts: Date.now(), text: '', thinking: '', streaming: true, phase: 'commentary' };
        this.items.set(n.itemId, item);
        this.ctx.emit({ type: 'item.upsert', item });
      }
      if (item.kind === 'assistant') {
        item.thinking = (item.thinking ?? '') + n.delta;
        this.ctx.emit({ type: 'item.delta', id: n.itemId, thinkingDelta: n.delta });
      }
    };
    rpc.onNotification('item/reasoning/summaryTextDelta', reasoningDelta);
    rpc.onNotification('item/reasoning/textDelta', reasoningDelta);
    rpc.onNotification('item/reasoning/summaryPartAdded', (p) => {
      const n = p as { itemId: string };
      const item = this.items.get(n.itemId);
      if (item && item.kind === 'assistant' && item.thinking) {
        item.thinking += '\n\n';
        this.ctx.emit({ type: 'item.delta', id: n.itemId, thinkingDelta: '\n\n' });
      }
    });
    rpc.onNotification('item/commandExecution/outputDelta', (p) => {
      const n = p as { itemId: string; delta: string };
      const item = this.items.get(n.itemId);
      if (item && item.kind === 'tool') {
        item.output = (item.output ?? '') + n.delta;
        this.ctx.emit({ type: 'item.delta', id: n.itemId, outputDelta: n.delta });
      }
    });
    rpc.onNotification('item/fileChange/outputDelta', (p) => {
      const n = p as { itemId: string; delta: string };
      const item = this.items.get(n.itemId);
      if (item && item.kind === 'tool') {
        item.output = (item.output ?? '') + n.delta;
        this.ctx.emit({ type: 'item.delta', id: n.itemId, outputDelta: n.delta });
      }
    });
    rpc.onNotification('turn/completed', (p) => {
      const n = p as { turn: { id: string; status: 'completed' | 'interrupted' | 'failed' | 'inProgress'; error: { message: string } | null; durationMs: number | null } };
      this._busy = false;
      this.turnId = null;
      for (const item of this.items.values()) if (item.kind === 'assistant' && item.streaming) this.ctx.emit({ type: 'item.upsert', item: { ...item, streaming: false } });
      const status = n.turn.status === 'failed' ? 'failed' : n.turn.status === 'interrupted' ? 'interrupted' : 'completed';
      this.totals.turns += 1;
      this.ctx.emit({ type: 'usage', totals: { ...this.totals } });
      const base = this.turnBase;
      const usage: Partial<UsageTotals> | undefined = base
        ? {
            inputTokens: Math.max(0, this.totals.inputTokens - base.inputTokens),
            outputTokens: Math.max(0, this.totals.outputTokens - base.outputTokens),
            cacheReadTokens: Math.max(0, this.totals.cacheReadTokens - base.cacheReadTokens),
            cacheWriteTokens: Math.max(0, this.totals.cacheWriteTokens - base.cacheWriteTokens),
            reasoningTokens: Math.max(0, this.totals.reasoningTokens - base.reasoningTokens)
          }
        : undefined;
      const turnCost = base ? Math.max(0, this.totals.costUsd - base.costUsd) : undefined;
      this.ctx.emit({
        type: 'item.upsert',
        item: { id: shortId('turn_'), kind: 'turn', ts: Date.now(), status, durationMs: n.turn.durationMs ?? Date.now() - this.turnStartedAt, usage, costUsd: turnCost, error: n.turn.error?.message }
      });
      this.turnStartedAt = 0;
      this.turnBase = null;
      this.ctx.emit({ type: 'status', status: 'idle' });
      const next = this.queue.shift();
      this.ctx.updateMeta({ queued: this.queue.length });
      if (next) void this.send({ ...next, mode: 'now' }).catch((e) => this.info(errorMessage(e), 'error'));
    });
    rpc.onNotification('thread/tokenUsage/updated', (p) => {
      const n = p as { tokenUsage: { total: { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number; totalTokens: number }; last: { totalTokens: number }; modelContextWindow: number | null } };
      const t = n.tokenUsage.total;
      const base = this.ctx.session().usage;
      // total is per thread (cumulative); use it directly.
      this.totals = {
        ...this.totals,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        cacheReadTokens: t.cachedInputTokens,
        cacheWriteTokens: t.cacheWriteInputTokens,
        reasoningTokens: t.reasoningOutputTokens,
        contextWindow: n.tokenUsage.modelContextWindow ?? base.contextWindow,
        contextTokens: n.tokenUsage.last?.totalTokens ?? base.contextTokens
      };
      const pricing = findPricing(this.modelProvider ?? 'openai', this.model ?? '', this.models);
      this.totals.costUsd = estimateCostUsd(pricing, this.totals);
      this.ctx.emit({ type: 'usage', totals: { ...this.totals } });
    });
    rpc.onNotification('error', (p) => {
      const n = p as { error: { message: string }; willRetry: boolean };
      this.info(`${n.error.message}${n.willRetry ? ' (retrying)' : ''}`, n.willRetry ? 'warn' : 'error');
    });
    rpc.onNotification('warning', (p) => this.ctx.log('warn', `[codex] ${JSON.stringify(p)}`));
    rpc.onNotification('configWarning', (p) => this.ctx.log('warn', `[codex config] ${JSON.stringify(p)}`));
    rpc.onNotification('thread/name/updated', (p) => {
      const n = p as { name?: string | null };
      if (n.name && /^New session|^Untitled/i.test(this.ctx.session().title)) this.ctx.updateMeta({ title: n.name });
    });
    rpc.onNotification('thread/compacted', () => {
      this.info('Codex compacted the conversation context.');
      this.compactionWaiter?.resolve();
    });
    rpc.onNotification('model/rerouted', (p) => this.info(`Model rerouted: ${JSON.stringify(p)}`, 'warn'));
    rpc.onNotification('account/rateLimits/updated', (p) => this.ctx.log('debug', `[codex rate limits] ${JSON.stringify(p)}`));
  }

  private wireServerRequests(rpc: JsonRpcStdioClient): void {
    rpc.onServerRequest('item/commandExecution/requestApproval', async (p) => {
      const n = p as { itemId: string; command?: string | null; cwd?: string | null; reason?: string | null; proposedExecpolicyAmendment?: unknown };
      const command = n.command ?? '(command)';
      const mode = this.ctx.permissionMode();
      const verdict = gateAction(mode, { mutating: true, isEdit: false, command, sessionAllowed: this.sessionAllowedCommands.has(command) });
      if (mode === 'plan') return { decision: 'decline' };
      if (verdict === 'allow') return { decision: 'accept' };
      const decision = await this.ctx.requestApproval({
        kind: 'command',
        title: 'Codex wants to run a command',
        description: n.reason ?? undefined,
        command,
        cwd: n.cwd ?? this.ctx.session().cwd,
        toolItemId: n.itemId,
        options: OPTIONS_ALLOW_DENY
      });
      if (decision.optionId === 'allow') return { decision: 'accept' };
      if (decision.optionId === 'allow_session') {
        this.sessionAllowedCommands.add(command);
        return { decision: 'acceptForSession' };
      }
      return { decision: 'decline' };
    });
    rpc.onServerRequest('item/fileChange/requestApproval', async (p) => {
      const n = p as { itemId: string; reason?: string | null; grantRoot?: string | null };
      const mode = this.ctx.permissionMode();
      if (mode === 'plan') return { decision: 'decline' };
      // A grantRoot request means the patch writes outside the sandboxed workspace: always ask below full access.
      if (mode === 'full-auto' || ((mode === 'accept-edits' || mode === 'auto') && !n.grantRoot)) return { decision: 'accept' };
      const changes = this.fileChangeItems.get(n.itemId);
      const decision = await this.ctx.requestApproval({
        kind: 'file_change',
        title: changes?.length ? `Apply changes to ${changes.length} file${changes.length === 1 ? '' : 's'}?` : 'Apply file changes?',
        description: n.reason ?? (n.grantRoot ? `Requests write access under ${n.grantRoot}` : undefined),
        changes,
        toolItemId: n.itemId,
        options: OPTIONS_ALLOW_DENY
      });
      if (decision.optionId === 'allow') return { decision: 'accept' };
      if (decision.optionId === 'allow_session') return { decision: 'acceptForSession' };
      return { decision: 'decline' };
    });
    rpc.onServerRequest('item/tool/requestUserInput', async (p) => {
      const n = p as { questions: { id: string; header: string; question: string; isOther: boolean; isSecret: boolean; options: { label: string; description: string }[] | null }[] };
      const decision = await this.ctx.requestApproval({
        kind: 'question',
        title: 'Codex has a question',
        options: [
          { id: 'allow', label: 'Answer', kind: 'allow' },
          { id: 'deny', label: 'Skip', kind: 'deny' }
        ],
        questions: n.questions.map((q) => ({ id: q.id, header: q.header, question: q.question, options: q.options ?? undefined, allowOther: q.isOther, secret: q.isSecret }))
      });
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of n.questions) {
        const a = decision.answers?.[q.id];
        answers[q.id] = { answers: a ? [a] : [] };
      }
      return { answers };
    });
    rpc.onServerRequest('mcpServer/elicitation/request', async () => ({ action: 'decline', content: null, _meta: null }));
    rpc.onServerRequest('execCommandApproval', async (p) => {
      const n = p as { command?: string[] | string; cwd?: string; reason?: string };
      const command = Array.isArray(n.command) ? n.command.join(' ') : (n.command ?? '(command)');
      const mode = this.ctx.permissionMode();
      if (mode === 'plan') return { decision: { denied: { rejection: 'Plan mode' } } };
      if (gateAction(mode, { mutating: true, isEdit: false, command, sessionAllowed: this.sessionAllowedCommands.has(command) }) === 'allow') return { decision: 'approved' };
      const d = await this.ctx.requestApproval({ kind: 'command', title: 'Codex wants to run a command', command, cwd: n.cwd, description: n.reason, options: OPTIONS_ALLOW_DENY });
      if (d.optionId === 'allow') return { decision: 'approved' };
      if (d.optionId === 'allow_session') {
        this.sessionAllowedCommands.add(command);
        return { decision: 'approved_for_session' };
      }
      return { decision: { denied: { rejection: d.note || 'User declined' } } };
    });
    rpc.onServerRequest('applyPatchApproval', async (p) => {
      const n = p as { reason?: string; fileChanges?: Record<string, unknown> };
      const mode = this.ctx.permissionMode();
      if (mode === 'plan') return { decision: { denied: { rejection: 'Plan mode' } } };
      if (mode !== 'ask') return { decision: 'approved' };
      const files = Object.keys(n.fileChanges ?? {});
      const d = await this.ctx.requestApproval({ kind: 'file_change', title: 'Apply file changes?', description: n.reason ?? files.join(', '), changes: files.map((f) => ({ path: f, kind: 'update' as const })), options: OPTIONS_ALLOW_DENY });
      if (d.optionId === 'allow') return { decision: 'approved' };
      if (d.optionId === 'allow_session') return { decision: 'approved_for_session' };
      return { decision: { denied: { rejection: d.note || 'User declined' } } };
    });
  }

  private upsertItem(item: ThreadItem, completed: boolean): void {
    const existing = this.items.get(item.id);
    const ts = existing?.ts ?? Date.now();
    let out: TranscriptItem | null = null;
    switch (item.type) {
      case 'userMessage':
      case 'hookPrompt':
      case 'sleep':
        return;
      case 'agentMessage': {
        const it = item as Extract<ThreadItem, { type: 'agentMessage' }>;
        const prev = existing && existing.kind === 'assistant' ? existing : undefined;
        const text = completed || !prev ? it.text : prev.text.length > it.text.length ? prev.text : it.text;
        out = { id: it.id, kind: 'assistant', ts, text, streaming: !completed, model: this.model, phase: it.phase === 'commentary' ? 'commentary' : 'final', thinking: prev?.thinking };
        break;
      }
      case 'plan': {
        const it = item as Extract<ThreadItem, { type: 'plan' }>;
        out = { id: it.id, kind: 'assistant', ts, text: it.text, streaming: !completed, phase: 'plan' };
        break;
      }
      case 'reasoning': {
        const it = item as Extract<ThreadItem, { type: 'reasoning' }>;
        const prev = existing && existing.kind === 'assistant' ? existing.thinking ?? '' : '';
        const full = [...(it.summary ?? []), ...(it.content ?? [])].join('\n\n');
        out = { id: it.id, kind: 'assistant', ts, text: '', thinking: full.length >= prev.length ? full : prev, streaming: !completed, phase: 'commentary' };
        break;
      }
      case 'commandExecution': {
        const it = item as Extract<ThreadItem, { type: 'commandExecution' }>;
        const prevOut = existing && existing.kind === 'tool' ? existing.output ?? '' : '';
        out = {
          id: it.id,
          kind: 'tool',
          ts,
          name: 'shell',
          hint: 'execute',
          summary: it.command,
          input: { command: it.command, cwd: it.cwd },
          output: truncate((it.aggregatedOutput ?? '').length >= prevOut.length ? it.aggregatedOutput ?? '' : prevOut, 40_000),
          status: it.status === 'inProgress' ? 'running' : it.status === 'failed' ? 'error' : it.status === 'declined' ? 'declined' : 'done',
          exitCode: it.exitCode,
          durationMs: it.durationMs ?? undefined
        };
        break;
      }
      case 'fileChange': {
        const it = item as Extract<ThreadItem, { type: 'fileChange' }>;
        const changes: FileChange[] = it.changes.map((c) => ({
          path: c.path,
          kind: c.kind.type === 'update' && c.kind.move_path ? 'rename' : c.kind.type,
          diff: c.diff,
          oldPath: c.kind.type === 'update' ? c.kind.move_path ?? undefined : undefined
        }));
        this.fileChangeItems.set(it.id, changes);
        out = {
          id: it.id,
          kind: 'tool',
          ts,
          name: 'apply_patch',
          hint: 'edit',
          summary: changes.map((c) => c.path).join(', '),
          changes,
          status: it.status === 'inProgress' ? 'running' : it.status === 'failed' ? 'error' : it.status === 'declined' ? 'declined' : 'done'
        };
        break;
      }
      case 'mcpToolCall': {
        const it = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
        out = {
          id: it.id,
          kind: 'tool',
          ts,
          name: `${it.server}.${it.tool}`,
          hint: 'mcp',
          input: it.arguments,
          summary: truncate(JSON.stringify(it.arguments ?? {}), 200, '…'),
          output: it.error ? it.error.message : it.result ? truncate(JSON.stringify(it.result.structuredContent ?? it.result.content ?? '', null, 2), 40_000) : undefined,
          status: it.status === 'inProgress' ? 'running' : it.status === 'failed' ? 'error' : 'done',
          durationMs: it.durationMs ?? undefined
        };
        break;
      }
      case 'dynamicToolCall': {
        const it = item as Extract<ThreadItem, { type: 'dynamicToolCall' }>;
        out = {
          id: it.id,
          kind: 'tool',
          ts,
          name: it.tool,
          hint: 'other',
          input: it.arguments,
          summary: truncate(JSON.stringify(it.arguments ?? {}), 200, '…'),
          output: it.contentItems ? truncate(JSON.stringify(it.contentItems, null, 2), 40_000) : undefined,
          status: it.status === 'inProgress' ? 'running' : it.success === false ? 'error' : 'done'
        };
        break;
      }
      case 'webSearch': {
        const it = item as Extract<ThreadItem, { type: 'webSearch' }>;
        out = { id: it.id, kind: 'tool', ts, name: 'web_search', hint: 'fetch', summary: it.query ?? '', status: completed ? 'done' : 'running' };
        break;
      }
      case 'contextCompaction':
        out = { id: item.id, kind: 'info', ts, level: 'info', text: 'Codex compacted the conversation context.' };
        break;
      case 'subAgentActivity':
      case 'collabAgentToolCall': {
        const it = item as { id: string; tool?: string; [k: string]: unknown };
        out = { id: it.id, kind: 'tool', ts, name: typeof it.tool === 'string' ? `agent.${it.tool}` : 'subagent', hint: 'agent', input: it, summary: 'Sub-agent activity', status: completed ? 'done' : 'running' };
        break;
      }
      case 'enteredReviewMode':
        out = { id: item.id, kind: 'info', ts, level: 'info', text: 'Codex entered review mode.' };
        break;
      case 'exitedReviewMode':
        out = { id: item.id, kind: 'info', ts, level: 'info', text: 'Codex exited review mode.' };
        break;
      case 'imageGeneration':
      case 'imageView':
        out = { id: item.id, kind: 'info', ts, level: 'info', text: `${item.type} item (not rendered).` };
        break;
      default:
        out = { id: item.id, kind: 'info', ts, level: 'info', text: `${item.type}: ${truncate(JSON.stringify(item), 500, '…')}` };
    }
    if (out) {
      this.items.set(item.id, out);
      this.ctx.emit({ type: 'item.upsert', item: out });
    }
  }

  private info(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.ctx.emit({ type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level, text } });
  }

  async send(input: UserInput): Promise<void> {
    if (!this.rpc) await this.start();
    if (!this.rpc || !this.threadId) throw new Error('Codex thread is not ready');
    const content: unknown[] = [];
    if (input.text) content.push({ type: 'text', text: input.text, text_elements: [] });
    for (const img of input.images ?? []) {
      const ext = img.mimeType.split('/')[1] ?? 'png';
      const file = path.join(this.ctx.sessionDir, 'images', `${shortId('img_')}.${ext}`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, Buffer.from(img.data, 'base64'));
      content.push({ type: 'localImage', path: file });
    }
    if (this._busy && this.turnId) {
      if (input.mode === 'steer') {
        await withTimeout(this.rpc.request('turn/steer', { threadId: this.threadId, input: content, expectedTurnId: this.turnId }), 30_000, 'turn/steer');
        return;
      }
      this.queue.push({ ...input, mode: 'now' });
      this.ctx.updateMeta({ queued: this.queue.length });
      return;
    }
    const mode = this.ctx.permissionMode();
    const params: Record<string, unknown> = {
      threadId: this.threadId,
      input: content,
      cwd: this.ctx.session().cwd,
      approvalPolicy: approvalPolicyFor(mode),
      sandboxPolicy: sandboxPolicyFor(mode, this.ctx.session().cwd),
      model: this.model ?? null,
      effort: this.effort ?? null
    };
    this._busy = true;
    this.turnStartedAt = Date.now();
    this.turnBase = { ...this.totals };
    this.ctx.emit({ type: 'status', status: 'running' });
    try {
      const res = await withTimeout(this.rpc.request<{ turn: { id: string } }>('turn/start', params), 300_000, 'turn/start');
      this.turnId = res.turn.id;
    } catch (e) {
      this._busy = false;
      this.ctx.emit({ type: 'status', status: 'idle' });
      throw e;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.rpc || !this.threadId || !this.turnId) return;
    try {
      await withTimeout(this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }), 30_000, 'turn/interrupt');
    } catch (e) {
      this.ctx.log('warn', `interrupt failed: ${errorMessage(e)}`);
    }
  }

  async setModel(model: ModelRef): Promise<void> {
    this.model = model.model;
    if (model.provider && model.provider !== 'openai' && model.provider !== 'codex') this.modelProvider = model.provider;
    this.ctx.updateMeta({ activeModel: model });
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    this.effort = effort;
    this.ctx.updateMeta({ activeEffort: effort });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    // Session grants made under a looser mode must not carry into a stricter one.
    this.sessionAllowedCommands.clear();
    if (this._busy) this.info(`Permission mode "${mode}" applies to Codex from the next turn; the running turn keeps its current sandbox.`, 'warn');
  }

  async compact(): Promise<void> {
    if (!this.rpc || !this.threadId) throw new Error('Codex thread is not ready');
    if (this.compactionWaiter) return withTimeout(this.compactionWaiter.promise, 180_000, 'Codex context compaction');
    const waiter = deferred<void>();
    // Process shutdown can reject this before compact/start's request rejects; mark it observed now.
    void waiter.promise.catch(() => undefined);
    this.compactionWaiter = waiter;
    try {
      await withTimeout(this.rpc.request('thread/compact/start', { threadId: this.threadId }), 30_000, 'thread/compact/start');
      await withTimeout(waiter.promise, 180_000, 'Codex context compaction');
    } finally {
      if (this.compactionWaiter === waiter) this.compactionWaiter = null;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.rpc) return CODEX_STATIC_MODELS;
    try {
      const res = await withTimeout(this.rpc.request<{ data: CodexModel[] }>('model/list', { limit: 100, includeHidden: false }), 20_000, 'model/list');
      this.models = res.data.map((m) => codexModelToInfo(m, this.modelProvider ?? 'openai'));
      return this.models.length ? this.models : CODEX_STATIC_MODELS;
    } catch (e) {
      this.ctx.log('warn', `model/list failed: ${errorMessage(e)}`);
      return CODEX_STATIC_MODELS;
    }
  }

  async dispose(): Promise<void> {
    this.compactionWaiter?.reject(new Error('Codex stopped during context compaction.'));
    const rpc = this.rpc;
    this.rpc = null;
    if (!rpc) return;
    try {
      if (this.threadId) await withTimeout(rpc.request('thread/unsubscribe', { threadId: this.threadId }), 2000, 'unsubscribe').catch(() => undefined);
    } finally {
      rpc.close();
    }
  }
}

export function codexModelToInfo(m: CodexModel, provider = 'openai'): ModelInfo {
  const pricing = findPricing('openai', m.model);
  return {
    id: m.model,
    provider,
    displayName: m.displayName || m.model,
    description: m.description,
    supportsImages: (m.inputModalities ?? []).includes('image'),
    supportsReasoning: true,
    supportedEfforts: (m.supportedReasoningEfforts ?? []).map((o) => o.reasoningEffort as EffortLevel),
    defaultEffort: m.defaultReasoningEffort as EffortLevel,
    isDefault: m.isDefault,
    pricing
  };
}

/**
 * One-shot model listing without a session: spawn app-server, initialize, model/list, exit.
 */
export async function listCodexModels(codexPath: string): Promise<ModelInfo[]> {
  const child = spawnTool(codexPath, ['app-server']);
  const rpc = new JsonRpcStdioClient(child);
  try {
    await withTimeout(rpc.request('initialize', { clientInfo: { name: 'vocs-code', title: 'Vocs Code', version: '0.1.0' }, capabilities: { experimentalApi: false, requestAttestation: false } }), 20_000, 'initialize');
    const res = await withTimeout(rpc.request<{ data: CodexModel[] }>('model/list', { limit: 100 }), 20_000, 'model/list');
    return res.data.map((m) => codexModelToInfo(m));
  } finally {
    rpc.close();
    setTimeout(() => killTree(child), 2000);
  }
}
