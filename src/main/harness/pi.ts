import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import type { EffortLevel, FileChange, ModelInfo, ModelRef, PermissionMode, TranscriptItem, UsageTotals, UserInput } from '../../shared/types';
import { EFFORT_LEVELS, isEffortLevel } from '../../shared/harness-meta';
import { LineSplitter, deferred, errorMessage, shortId, truncate, withTimeout, type Deferred } from '../util/async';
import { shutdownChild, spawnTool } from './spawn';
import type { HarnessAdapter, HarnessContext } from './types';
import { OPTIONS_ALLOW_DENY } from './permissions';

export const PI_APPROVAL_MARKER = 'VCODE_APPROVAL::';

/** Env var names pi understands for each of our provider ids. */
const PI_ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  xai: 'XAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  gemini: 'GEMINI_API_KEY'
};

interface PiModel {
  id: string;
  name: string;
  provider: string;
  api?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  thinkingLevelMap?: Record<string, string | null>;
}

export function piModelToInfo(m: PiModel): ModelInfo {
  const efforts = piSupportedEfforts(m);
  return {
    id: m.id,
    provider: m.provider,
    displayName: m.name || m.id,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxTokens,
    supportsImages: (m.input ?? []).includes('image'),
    supportsReasoning: !!m.reasoning,
    supportedEfforts: efforts && efforts.length ? efforts : undefined,
    pricing: m.cost ? { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite } : undefined
  };
}

/**
 * Mirrors pi's own getSupportedThinkingLevels: a level is hidden only by an explicit `null`, a
 * missing standard level keeps the provider's default mapping, and the extended `xhigh`/`max`
 * levels need an explicit mapping. `off` is dropped — leaving effort unset already runs the model
 * default. Without a map we keep the full list; pi clamps anything the model cannot use.
 */
function piSupportedEfforts(m: PiModel): EffortLevel[] | undefined {
  const map = m.thinkingLevelMap;
  if (!m.reasoning || !map) return undefined;
  return EFFORT_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

function piThinkingLevel(effort: EffortLevel | undefined): string | undefined {
  return effort;
}

export class PiAdapter implements HarnessAdapter {
  readonly id = 'pi' as const;
  private child: ChildProcess | null = null;
  private pending = new Map<string, Deferred<unknown>>();
  private _busy = false;
  private currentAssistant: Extract<TranscriptItem, { kind: 'assistant' }> | null = null;
  private toolItems = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>();
  private turnStartedAt = 0;
  private lastCost = 0;
  private lastTokens = { input: 0, output: 0 };
  private totals: UsageTotals;
  /** stopReason/errorMessage of the last assistant message — pi reports turn failures here, not as events. */
  private lastStopReason: string | null = null;
  private lastErrorMessage: string | null = null;
  private models: ModelInfo[] = [];
  private nextId = 1;
  private exited = false;
  private modeFile: string | null = null;

  constructor(private readonly ctx: HarnessContext) {
    this.totals = { ...ctx.session().usage };
  }

  get busy(): boolean {
    return this._busy;
  }

  async start(): Promise<void> {
    const meta = this.ctx.session();
    const s = this.ctx.settings();
    const bin = this.ctx.runtime.resolve('pi');
    if (!bin) throw new Error('pi is not installed. Run `npm install -g @earendil-works/pi-coding-agent` or set the path in Settings.');
    const ext = this.ctx.runtime.resource('pi', 'vocs-code-approvals.ts');
    const sessionDir = path.join(this.ctx.sessionDir, 'pi');
    await fs.mkdir(sessionDir, { recursive: true });

    const args = ['--mode', 'rpc', '-e', ext, '--session-dir', sessionDir];
    if (meta.harnessRef.piSessionFile) args.push('--session', meta.harnessRef.piSessionFile);
    if (meta.config.model) {
      if (meta.config.model.provider) args.push('--provider', meta.config.model.provider);
      args.push('--model', meta.config.model.model);
    }
    const level = piThinkingLevel(this.ctx.effort());
    if (level) args.push('--thinking', level);
    if (meta.config.appendSystemPrompt) args.push('--append-system-prompt', meta.config.appendSystemPrompt);
    args.push(...(s.pi.extraArgs ?? []));

    this.modeFile = path.join(sessionDir, 'permission-mode.txt');
    await fs.writeFile(this.modeFile, this.ctx.permissionMode(), 'utf8');
    const env: NodeJS.ProcessEnv = { ...process.env, VOCS_CODE_PERMISSION_MODE: this.ctx.permissionMode(), VOCS_CODE_MODE_FILE: this.modeFile, VOCS_CODE: '1' };
    for (const [pid, envKey] of Object.entries(PI_ENV_KEYS)) {
      if (!env[envKey]) {
        const key = await this.ctx.getApiKey(pid);
        if (key) env[envKey] = key;
      }
    }

    const child = spawnTool(bin.path, args, { cwd: meta.cwd, env });
    this.child = child;
    const splitter = new LineSplitter((line) => this.handleLine(line));
    child.stdout?.on('data', (d: Buffer) => splitter.push(d));
    const err = new LineSplitter((line) => this.ctx.log('debug', `[pi] ${line}`));
    child.stderr?.on('data', (d: Buffer) => err.push(d));
    child.on('close', (code) => {
      this.exited = true;
      this._busy = false;
      for (const d of this.pending.values()) d.reject(new Error(`pi exited (${code})`));
      this.pending.clear();
      this.ctx.emit({ type: 'status', status: 'stopped', detail: `pi exited (${code})` });
    });
    child.on('error', (e) => this.ctx.emit({ type: 'error', message: `pi failed to start: ${errorMessage(e)}`, fatal: true }));

    const state = await withTimeout(this.request<{ model?: PiModel; thinkingLevel?: string; sessionFile?: string; sessionId?: string }>('get_state'), 60_000, 'pi get_state');
    if (state.sessionFile) this.ctx.updateRef({ piSessionFile: state.sessionFile });
    if (state.model) this.ctx.updateMeta({ activeModel: { provider: state.model.provider, model: state.model.id }, activeEffort: isEffortLevel(state.thinkingLevel) ? state.thinkingLevel : undefined });
    this.ctx.emit({ type: 'status', status: 'idle' });
    void this.listModels().then((models) => models.length && this.ctx.emit({ type: 'models', models }));
  }

  private write(cmd: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable || this.exited) throw new Error('pi process is not running');
    this.child.stdin.write(JSON.stringify(cmd) + '\n');
  }

  private request<T = unknown>(type: string, extra: Record<string, unknown> = {}): Promise<T> {
    const id = `r${this.nextId++}`;
    const d = deferred<unknown>();
    this.pending.set(id, d);
    try {
      this.write({ id, type, ...extra });
    } catch (e) {
      this.pending.delete(id);
      return Promise.reject(e);
    }
    return d.promise as Promise<T>;
  }

  private handleLine(line: string): void {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.ctx.log('debug', `[pi stdout] ${line}`);
      return;
    }
    const type = ev.type as string;
    if (type === 'response') {
      const id = ev.id as string | undefined;
      const d = id ? this.pending.get(id) : undefined;
      if (d && id) {
        this.pending.delete(id);
        if (ev.success) d.resolve(ev.data);
        else d.reject(new Error(String(ev.error ?? `${ev.command} failed`)));
      } else if (ev.success === false) this.ctx.log('warn', `[pi] ${ev.command}: ${ev.error}`);
      return;
    }
    switch (type) {
      case 'agent_start':
        this._busy = true;
        this.turnStartedAt = this.turnStartedAt || Date.now();
        this.ctx.emit({ type: 'status', status: 'running' });
        return;
      case 'agent_end': {
        // A retry (or compaction) follows this run; wait for the final agent_end so the
        // turn item reflects the whole prompt, not the failed attempt.
        if ((ev as { willRetry?: boolean }).willRetry) return;
        void this.finishTurn();
        return;
      }
      case 'turn_start':
      case 'turn_end':
        return;
      case 'message_start': {
        const msg = ev.message as { role?: string; provider?: string; model?: string };
        if (msg?.role === 'assistant') {
          this.currentAssistant = { id: shortId('a_'), kind: 'assistant', ts: Date.now(), text: '', thinking: '', streaming: true, model: msg.model };
          this.ctx.emit({ type: 'item.upsert', item: { ...this.currentAssistant } });
        }
        return;
      }
      case 'message_update': {
        const ame = ev.assistantMessageEvent as { type: string; delta?: string; toolCall?: { id: string; name: string; arguments: Record<string, unknown> } } | undefined;
        if (!ame) return;
        const a = this.ensureAssistant();
        if (ame.type === 'text_delta' && ame.delta) {
          a.text += ame.delta;
          this.ctx.emit({ type: 'item.delta', id: a.id, textDelta: ame.delta });
        } else if (ame.type === 'thinking_delta' && ame.delta) {
          a.thinking = (a.thinking ?? '') + ame.delta;
          this.ctx.emit({ type: 'item.delta', id: a.id, thinkingDelta: ame.delta });
        } else if (ame.type === 'toolcall_end' && ame.toolCall) {
          this.startTool(ame.toolCall.id, ame.toolCall.name, ame.toolCall.arguments);
        }
        return;
      }
      case 'message_end': {
        const msg = ev.message as { role?: string; content?: { type: string; text?: string; thinking?: string }[]; model?: string; stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } };
        if (msg?.role === 'assistant') {
          this.lastStopReason = msg.stopReason ?? null;
          this.lastErrorMessage = msg.errorMessage ?? null;
        }
        if (msg?.role === 'assistant' && this.currentAssistant) {
          const a = this.currentAssistant;
          const text = (msg.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
          const thinking = (msg.content ?? []).filter((c) => c.type === 'thinking').map((c) => c.thinking ?? '').join('\n');
          a.text = text || a.text;
          a.thinking = thinking || a.thinking;
          a.streaming = false;
          a.model = msg.model ?? a.model;
          this.ctx.emit({ type: 'item.upsert', item: { ...a } });
          this.currentAssistant = null;
        }
        return;
      }
      case 'tool_execution_start': {
        const e = ev as { toolCallId: string; toolName: string; args: Record<string, unknown> };
        this.startTool(e.toolCallId, e.toolName, e.args);
        return;
      }
      case 'tool_execution_update': {
        const e = ev as { toolCallId: string; partialResult?: { content?: { type: string; text?: string }[] } };
        const item = this.toolItems.get(e.toolCallId);
        if (item && e.partialResult?.content) {
          const text = e.partialResult.content.map((c) => c.text ?? '').join('');
          if (text.length > (item.output ?? '').length) {
            const delta = text.slice((item.output ?? '').length);
            item.output = text;
            this.ctx.emit({ type: 'item.delta', id: item.id, outputDelta: delta });
          }
        }
        return;
      }
      case 'tool_execution_end': {
        const e = ev as { toolCallId: string; toolName: string; result?: { content?: { type: string; text?: string }[]; details?: Record<string, unknown> }; isError: boolean };
        const item = this.toolItems.get(e.toolCallId);
        if (!item) return;
        const text = (e.result?.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : '[image]')).join('\n');
        item.output = truncate(text, 40_000);
        item.status = e.isError ? 'error' : 'done';
        const details = e.result?.details;
        if (details && typeof details.diff === 'string') {
          const file = String((item.input as Record<string, unknown>)?.path ?? item.summary ?? '');
          const changes: FileChange[] = [{ path: file, kind: 'update', diff: details.diff }];
          item.changes = changes;
        } else if (item.name === 'write') {
          item.changes = [{ path: String((item.input as Record<string, unknown>)?.path ?? ''), kind: 'update' }];
        }
        if (typeof details?.exitCode === 'number') item.exitCode = details.exitCode;
        this.ctx.emit({ type: 'item.upsert', item: { ...item } });
        return;
      }
      case 'extension_ui_request':
        void this.handleUiRequest(ev as { id: string; method: string; title?: string; message?: string; options?: string[]; notifyType?: string });
        return;
      case 'queue_update': {
        const e = ev as { steering?: unknown[]; followUp?: unknown[] };
        this.ctx.updateMeta({ queued: (e.steering?.length ?? 0) + (e.followUp?.length ?? 0) });
        return;
      }
      case 'compaction_start':
        this.info('Compacting context…');
        return;
      case 'compaction_end': {
        const e = ev as { aborted?: boolean; errorMessage?: string; result?: { tokensBefore?: number; estimatedTokensAfter?: number } };
        if (e.aborted) this.info('Compaction aborted.');
        else if (e.errorMessage) this.info(e.errorMessage, 'error');
        else this.info(`Context compacted${e.result ? ` (${e.result.tokensBefore} → ~${e.result.estimatedTokensAfter} tokens)` : ''}.`);
        return;
      }
      case 'auto_retry_start': {
        const e = ev as { attempt: number; maxAttempts: number; errorMessage: string };
        this.info(`Retrying (${e.attempt}/${e.maxAttempts}): ${e.errorMessage}`, 'warn');
        return;
      }
      case 'extension_error': {
        const e = ev as { extensionPath?: string; error?: string };
        this.info(`Extension error (${e.extensionPath}): ${e.error}`, 'error');
        return;
      }
      default:
        return;
    }
  }

  private ensureAssistant(): Extract<TranscriptItem, { kind: 'assistant' }> {
    if (!this.currentAssistant) {
      this.currentAssistant = { id: shortId('a_'), kind: 'assistant', ts: Date.now(), text: '', thinking: '', streaming: true };
      this.ctx.emit({ type: 'item.upsert', item: { ...this.currentAssistant } });
    }
    return this.currentAssistant;
  }

  private startTool(id: string, name: string, args: Record<string, unknown>): void {
    if (this.toolItems.has(id)) return;
    const summary =
      typeof args?.command === 'string' ? (args.command as string) : typeof args?.path === 'string' ? (args.path as string) : typeof args?.pattern === 'string' ? (args.pattern as string) : truncate(JSON.stringify(args ?? {}), 200, '…');
    const hint = name === 'bash' ? 'execute' : name === 'edit' || name === 'write' ? 'edit' : name === 'read' ? 'read' : name === 'grep' || name === 'find' || name === 'ls' ? 'search' : 'other';
    const item: Extract<TranscriptItem, { kind: 'tool' }> = { id, kind: 'tool', ts: Date.now(), name, hint, input: args, summary, status: 'running' };
    this.toolItems.set(id, item);
    this.ctx.emit({ type: 'item.upsert', item });
    // Close the current text bubble so later text appears after the tool card.
    if (this.currentAssistant && this.currentAssistant.text) {
      this.currentAssistant.streaming = false;
      this.ctx.emit({ type: 'item.upsert', item: { ...this.currentAssistant } });
      this.currentAssistant = null;
    }
  }

  private async handleUiRequest(req: { id: string; method: string; title?: string; message?: string; options?: string[]; notifyType?: string }): Promise<void> {
    const respond = (payload: Record<string, unknown>) => {
      try {
        this.write({ type: 'extension_ui_response', id: req.id, ...payload });
      } catch {
        /* process gone */
      }
    };
    switch (req.method) {
      case 'select': {
        const title = req.title ?? '';
        if (title.startsWith(PI_APPROVAL_MARKER)) {
          let payload: { tool: string; input: Record<string, unknown>; summary?: string } = { tool: 'tool', input: {} };
          try {
            payload = JSON.parse(title.slice(PI_APPROVAL_MARKER.length));
          } catch {
            /* keep default */
          }
          const command = typeof payload.input?.command === 'string' ? (payload.input.command as string) : undefined;
          const isEdit = payload.tool === 'edit' || payload.tool === 'write';
          const decision = await this.ctx.requestApproval({
            kind: command ? 'command' : isEdit ? 'file_change' : 'tool',
            title: command ? 'pi wants to run a command' : `pi wants to use ${payload.tool}`,
            toolName: payload.tool,
            command,
            cwd: this.ctx.session().cwd,
            input: payload.input,
            description: payload.summary,
            changes: isEdit ? [{ path: String(payload.input?.path ?? ''), kind: 'update' }] : undefined,
            options: OPTIONS_ALLOW_DENY
          });
          const map: Record<string, string> = { allow: 'Allow once', allow_session: 'Allow for session', deny: 'Deny' };
          respond({ value: map[decision.optionId] ?? 'Deny' });
          return;
        }
        const decision = await this.ctx.requestApproval({
          kind: 'question',
          title: title || 'pi asks',
          options: [
            { id: 'allow', label: 'Choose', kind: 'allow' },
            { id: 'deny', label: 'Cancel', kind: 'cancel' }
          ],
          questions: [{ id: 'choice', question: title || 'Select an option', options: (req.options ?? []).map((o) => ({ label: o })) }]
        });
        if (decision.optionId === 'allow' && decision.answers?.choice) respond({ value: decision.answers.choice });
        else respond({ cancelled: true });
        return;
      }
      case 'confirm': {
        const decision = await this.ctx.requestApproval({
          kind: 'permission',
          title: req.title ?? 'Confirm',
          description: req.message,
          options: [
            { id: 'allow', label: 'Yes', kind: 'allow' },
            { id: 'deny', label: 'No', kind: 'deny' }
          ]
        });
        respond({ confirmed: decision.optionId === 'allow' });
        return;
      }
      case 'input':
      case 'editor': {
        const decision = await this.ctx.requestApproval({
          kind: 'question',
          title: req.title ?? 'Input requested',
          options: [
            { id: 'allow', label: 'Submit', kind: 'allow' },
            { id: 'deny', label: 'Cancel', kind: 'cancel' }
          ],
          questions: [{ id: 'value', question: req.title ?? 'Enter a value', allowOther: true }]
        });
        if (decision.optionId === 'allow') respond({ value: decision.answers?.value ?? '' });
        else respond({ cancelled: true });
        return;
      }
      case 'notify':
        if (req.message) this.info(req.message, req.notifyType === 'error' ? 'error' : req.notifyType === 'warning' ? 'warn' : 'info');
        return;
      default:
        return; // setStatus / setWidget / setTitle / set_editor_text are TUI-only
    }
  }

  private async finishTurn(): Promise<void> {
    this._busy = false;
    if (this.currentAssistant) {
      this.currentAssistant.streaming = false;
      this.ctx.emit({ type: 'item.upsert', item: { ...this.currentAssistant } });
      this.currentAssistant = null;
    }
    let turnCost = 0;
    let turnUsage: Partial<UsageTotals> | undefined;
    try {
      const stats = await withTimeout(
        this.request<{ tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; cost?: number; contextUsage?: { tokens?: number; contextWindow?: number } | null; sessionFile?: string }>('get_session_stats'),
        10_000,
        'get_session_stats'
      );
      if (stats.sessionFile) this.ctx.updateRef({ piSessionFile: stats.sessionFile });
      const t = stats.tokens ?? {};
      this.totals = {
        ...this.totals,
        inputTokens: t.input ?? this.totals.inputTokens,
        outputTokens: t.output ?? this.totals.outputTokens,
        cacheReadTokens: t.cacheRead ?? this.totals.cacheReadTokens,
        cacheWriteTokens: t.cacheWrite ?? this.totals.cacheWriteTokens,
        costUsd: stats.cost ?? this.totals.costUsd,
        turns: this.totals.turns + 1,
        contextTokens: stats.contextUsage?.tokens ?? this.totals.contextTokens,
        contextWindow: stats.contextUsage?.contextWindow ?? this.totals.contextWindow
      };
      turnCost = Math.max(0, (stats.cost ?? 0) - this.lastCost);
      this.lastCost = stats.cost ?? this.lastCost;
      turnUsage = { inputTokens: (t.input ?? 0) - this.lastTokens.input, outputTokens: (t.output ?? 0) - this.lastTokens.output };
      this.lastTokens = { input: t.input ?? 0, output: t.output ?? 0 };
      this.ctx.emit({ type: 'usage', totals: { ...this.totals } });
    } catch (e) {
      this.ctx.log('debug', `get_session_stats failed: ${errorMessage(e)}`);
    }
    // pi ends a failed turn with an assistant message (stopReason 'error'), not an error event.
    const stopReason = this.lastStopReason;
    const errorMsg = this.lastErrorMessage;
    this.lastStopReason = null;
    this.lastErrorMessage = null;
    const failed = stopReason === 'error' && errorMsg;
    if (failed) this.info(`Turn failed: ${errorMsg}`, 'error');
    this.ctx.emit({
      type: 'item.upsert',
      item: {
        id: shortId('turn_'),
        kind: 'turn',
        ts: Date.now(),
        status: failed ? 'failed' : stopReason === 'aborted' ? 'interrupted' : 'completed',
        durationMs: Date.now() - this.turnStartedAt,
        costUsd: turnCost,
        usage: turnUsage,
        error: failed ? errorMsg : undefined
      }
    });
    this.turnStartedAt = 0;
    this.ctx.emit({ type: 'status', status: 'idle' });
  }

  private info(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.ctx.emit({ type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level, text } });
  }

  async send(input: UserInput): Promise<void> {
    if (!this.child) await this.start();
    const images = (input.images ?? []).map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }));
    if (this._busy) {
      const type = input.mode === 'queue' ? 'follow_up' : 'steer';
      await this.request(type, { message: input.text, images });
      return;
    }
    this._busy = true;
    this.turnStartedAt = Date.now();
    this.ctx.emit({ type: 'status', status: 'running' });
    try {
      await this.request('prompt', { message: input.text, images });
    } catch (e) {
      this._busy = false;
      this.ctx.emit({ type: 'status', status: 'idle' });
      throw e;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.child) return;
    await this.request('abort').catch((e) => this.ctx.log('warn', `abort failed: ${errorMessage(e)}`));
  }

  async setModel(model: ModelRef): Promise<void> {
    await this.request('set_model', { provider: model.provider, modelId: model.model });
    this.ctx.updateMeta({ activeModel: model });
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    await this.request('set_thinking_level', { level: piThinkingLevel(effort) });
    this.ctx.updateMeta({ activeEffort: effort });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    // The approvals extension re-reads this file before every tool call.
    if (!this.modeFile) return;
    try {
      await fs.writeFile(this.modeFile, mode, 'utf8');
    } catch (e) {
      // Surface the failure: silently keeping the old mode active would grant or withhold
      // permissions behind the user's back.
      this.ctx.log('warn', `failed to write permission mode file: ${errorMessage(e)}`);
    }
  }

  async compact(): Promise<void> {
    await this.request('compact', {});
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.child) return [];
    try {
      const res = await withTimeout(this.request<{ models: PiModel[] }>('get_available_models'), 20_000, 'get_available_models');
      this.models = res.models.map(piModelToInfo);
      return this.models;
    } catch (e) {
      this.ctx.log('warn', `get_available_models failed: ${errorMessage(e)}`);
      return this.models;
    }
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    await shutdownChild(child, 1500);
  }
}

/** One-shot model listing: `pi --mode rpc --no-session` + get_available_models. */
export async function listPiModels(piPath: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<ModelInfo[]> {
  const child = spawnTool(piPath, ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills'], { env: { ...process.env, ...extraEnv } });
  const d = deferred<ModelInfo[]>();
  const splitter = new LineSplitter((line) => {
    try {
      const ev = JSON.parse(line) as { type: string; command?: string; success?: boolean; data?: { models: PiModel[] }; error?: string };
      if (ev.type === 'response' && ev.command === 'get_available_models') {
        if (ev.success && ev.data) d.resolve(ev.data.models.map(piModelToInfo));
        else d.reject(new Error(ev.error ?? 'get_available_models failed'));
      }
    } catch {
      /* ignore non-json */
    }
  });
  child.stdout?.on('data', (b: Buffer) => splitter.push(b));
  child.on('error', (e) => d.reject(e));
  child.on('close', () => d.reject(new Error('pi exited before answering')));
  child.stdin?.write(JSON.stringify({ id: 'm1', type: 'get_available_models' }) + '\n');
  try {
    return await withTimeout(d.promise, 45_000, 'pi model list');
  } finally {
    await shutdownChild(child, 1000);
  }
}
