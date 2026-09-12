/** Cursor adapter: the Cursor agent loop via @cursor/sdk on the local runtime. There is no per-tool approval callback, so the safety boundary is Cursor's sandbox (Auto) and Plan mode's read-only tool allowlist. */
import { Agent, Cursor, AgentBusyError } from '@cursor/sdk';
import type {
  AgentModeOption,
  AgentOptions,
  ModelSelection,
  Run,
  SDKAgent,
  SDKMessage,
  SDKToolUseMessage,
  SteerAckOutcome,
  ToolName
} from '@cursor/sdk';
import type {
  EffortLevel,
  FileChange,
  ImageAttachment,
  ModelInfo,
  ModelRef,
  PermissionMode,
  ToolKindHint,
  TranscriptItem,
  UsageTotals,
  UserInput
} from '../../shared/types';
import { errorMessage, shortId, truncate } from '../util/async';
import type { HarnessAdapter, HarnessContext } from './types';
import { CURSOR_STATIC_MODELS, cursorModelToInfo } from '../models/static-models';

const TEXT_LIMIT = 40_000;

/** Read-only toolset enforced on top of Cursor's own plan mode. No shell, no edit, no task (subagents keep their own toolsets, so restricting the main loop is not enough). */
const PLAN_TOOLS: ToolName[] = ['read', 'grep', 'glob', 'ls', 'readLints', 'semSearch', 'webSearch', 'webFetch', 'updateTodos', 'readTodos'];

interface QueuedInput {
  text: string;
  images?: ImageAttachment[];
}

function toolHint(name: string): ToolKindHint {
  if (name === 'shell') return 'execute';
  if (name === 'edit' || name === 'write' || name === 'delete' || name === 'applyAgentDiff') return 'edit';
  if (name === 'read' || name === 'readLints') return 'read';
  if (name === 'grep' || name === 'glob' || name === 'ls' || name === 'semSearch') return 'search';
  if (name === 'webSearch' || name === 'webFetch') return 'fetch';
  if (name === 'task') return 'agent';
  if (/^mcp([_ ]|$)/i.test(name) || name.includes('__')) return 'mcp';
  return 'other';
}

/** Best-effort one-line summary of a tool call's arguments. Cursor documents arg shapes as unstable, so every field is optional-checked. */
function toolSummary(name: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  if (typeof a.command === 'string') return a.command;
  const file = typeof a.file_path === 'string' ? a.file_path : typeof a.path === 'string' ? a.path : undefined;
  if (file) return file;
  if (typeof a.pattern === 'string') return typeof a.path === 'string' ? `${a.pattern} in ${a.path}` : a.pattern;
  if (typeof a.query === 'string') return a.query;
  if (typeof a.url === 'string') return a.url;
  if (typeof a.description === 'string') return a.description;
  if (typeof a.prompt === 'string') return truncate(a.prompt, 200, '…');
  const s = JSON.stringify(a);
  return s === '{}' ? name : s.length > 200 ? s.slice(0, 200) + '…' : s;
}

/** Pull human-readable text out of a tool result of arbitrary shape (string, {content:[{type:'text',text}]}, {status,value:{stdout,…}}, JSON…). */
function toolOutput(result: unknown): string | undefined {
  if (result == null) return undefined;
  if (typeof result === 'string') return result.length ? result : undefined;
  if (Array.isArray(result)) {
    const parts = result.map((x) => toolOutput(x)).filter((x): x is string => !!x);
    return parts.length ? parts.join('\n') : undefined;
  }
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.text === 'string') return r.text;
    if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
      return [r.stdout, r.stderr].filter((x): x is string => typeof x === 'string' && x.length > 0).join('\n') || undefined;
    }
    if (Array.isArray(r.content)) return toolOutput(r.content);
    if (r.value !== undefined) return toolOutput(r.value);
    if (r.result !== undefined) return toolOutput(r.result);
    if (typeof r.message === 'string') return r.message;
    try {
      const s = JSON.stringify(r, null, 2);
      return s === '{}' ? undefined : s;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** File-change hints for edit-family tools, derived from the args' path field. Cursor does not report an inline diff; kinds are inferred from the tool name. */
function toolChanges(name: string, args: unknown): FileChange[] | undefined {
  if (name !== 'edit' && name !== 'write' && name !== 'delete') return undefined;
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  const path = typeof a.file_path === 'string' ? a.file_path : typeof a.path === 'string' ? a.path : undefined;
  if (!path) return undefined;
  const kind: FileChange['kind'] = name === 'write' ? 'add' : name === 'delete' ? 'delete' : 'update';
  return [{ path, kind }];
}

/** Shell results carry an exit code inside {status:'success',value:{exitCode,…}}; best effort only. */
function resultExitCode(result: unknown): number | null | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const value = (result as Record<string, unknown>).value;
  if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).exitCode === 'number') {
    return (value as Record<string, unknown>).exitCode as number;
  }
  return undefined;
}

function toModelSelection(ref: ModelRef | undefined): ModelSelection | undefined {
  return ref?.model ? { id: ref.model } : undefined;
}

/** UserInput → SDK message. Images are base64 without the data: prefix on both sides. */
function toSdkMessage(input: UserInput): { text: string; images?: { data: string; mimeType: string }[] } {
  return {
    text: input.text,
    images: input.images?.length ? input.images.map((i) => ({ data: i.data, mimeType: i.mimeType })) : undefined
  };
}

/** Live model catalog from Cursor's backend. Throws on auth/network failure so callers can fall back. */
export async function listCursorModels(apiKey?: string): Promise<ModelInfo[]> {
  const models = await Cursor.models.list({ apiKey });
  return models.map(cursorModelToInfo);
}

/**
 * Cursor through the official SDK, local runtime. Runs on the user's Cursor plan
 * (API key from the provider store, env, or a stored Cursor.auth.login()). Like codex-exec
 * there are no interactive approvals; sandbox and the plan-mode allowlist are the boundary.
 */
export class CursorAdapter implements HarnessAdapter {
  readonly id = 'cursor' as const;
  private agent: SDKAgent | null = null;
  private run: Run | null = null;
  private _busy = false;
  private disposed = false;
  private apiKey: string | undefined;
  private model: ModelSelection | undefined;
  private permissionMode: PermissionMode;
  private totals: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };
  /** Per-turn usage from the latest `usage` message, attached to that turn's item. */
  private turnUsage: Partial<UsageTotals> | undefined;
  /** Follow-up runs drained sequentially after the current turn (queue mode, or steers the SDK bounced back). */
  private followUps: QueuedInput[] = [];
  /** Streaming state for the current turn's assistant bubble. */
  private bubble: { id: string; text: string; thinking: string } | null = null;
  /** Tool items of the current turn, so later events merge instead of dropping fields. */
  private toolItems = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>();
  private turnStartedAt = 0;

  constructor(private readonly ctx: HarnessContext) {
    this.permissionMode = ctx.permissionMode();
  }

  get busy(): boolean {
    return this._busy;
  }

  async start(): Promise<void> {
    const meta = this.ctx.session();
    this.model = toModelSelection(meta.config.model);
    this.totals = { ...meta.usage };
    this.apiKey = await this.ctx.getApiKey('cursor');
    this.ctx.emit({ type: 'status', status: 'idle' });
    // Best-effort live catalog for the header picker; the New Session dialog uses the registry path.
    void this.listModels()
      .then((models) => models.length && this.ctx.emit({ type: 'models', models }))
      .catch(() => undefined);
  }

  private buildOptions(): Partial<AgentOptions> {
    const meta = this.ctx.session();
    const plan = this.permissionMode === 'plan';
    return {
      apiKey: this.apiKey,
      model: this.model,
      name: meta.title && meta.title !== 'New session' ? meta.title : undefined,
      mode: (plan ? 'plan' : 'agent') as AgentModeOption,
      tools: plan ? PLAN_TOOLS : undefined,
      local: {
        cwd: meta.cwd,
        sandboxOptions: { enabled: this.permissionMode === 'auto' }
      }
    };
  }

  private async ensureAgent(): Promise<SDKAgent> {
    if (this.agent) return this.agent;
    const opts = this.buildOptions();
    const resumeId = this.ctx.session().harnessRef.cursorAgentId;
    if (resumeId) {
      try {
        const agent = await Agent.resume(resumeId, opts);
        this.agent = agent;
        this.ctx.updateRef({ cursorAgentId: agent.agentId });
        return agent;
      } catch (e) {
        // A stale/missing stored agent must not wedge the session: drop the id and start fresh.
        this.ctx.updateRef({ cursorAgentId: undefined });
        this.ctx.log('warn', `cursor resume failed (${errorMessage(e)}); starting a new agent.`);
      }
    }
    const agent = await Agent.create(opts);
    this.agent = agent;
    this.ctx.updateRef({ cursorAgentId: agent.agentId });
    return agent;
  }

  async send(input: UserInput): Promise<void> {
    if (this.disposed) throw new Error('Cursor adapter was disposed.');
    if (this._busy) {
      if (input.mode === 'steer') await this.steer(input);
      else this.queueFollowUp(input);
      return;
    }
    await this.runTurn(input);
  }

  /** One follow-up run; the busy path funnels here so the guard stays in one place. Resolves once the run is accepted — the turn keeps streaming in the background. */
  private async runTurn(input: UserInput): Promise<void> {
    let agent: SDKAgent;
    try {
      agent = await this.ensureAgent();
    } catch (e) {
      this.ctx.emit({ type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level: 'error', text: `Cursor agent could not start: ${errorMessage(e)}` } });
      throw e;
    }
    this._busy = true;
    this.bubble = null;
    this.toolItems.clear();
    this.turnUsage = undefined;
    this.turnStartedAt = Date.now();
    this.ctx.emit({ type: 'status', status: 'running' });
    void (async () => {
      try {
        await this.startRun(agent, input);
      } catch (e) {
        if (e instanceof AgentBusyError && this.ctx.session().harnessRef.cursorAgentId) {
          // A run left persisted by a crashed process blocks new sends; recover with force.
          this.ctx.log('warn', 'cursor reported a busy agent; expiring the stale run and retrying.');
          try {
            await this.startRun(agent, input, { force: true });
          } catch (e2) {
            this.finishFailed(e2);
          }
        } else {
          this.finishFailed(e);
        }
      } finally {
        this.run = null;
        this._busy = false;
        this.bubble = null;
        this.ctx.emit({ type: 'status', status: 'idle' });
        void this.drainFollowUps();
      }
    })();
  }

  private async startRun(agent: SDKAgent, input: UserInput, local?: { force: boolean }): Promise<void> {
    const run = await agent.send(toSdkMessage(input), { model: this.model, local });
    this.run = run;
    await this.pump(run);
  }

  private async steer(input: UserInput): Promise<void> {
    const run = this.run;
    if (!run || !run.steer) return this.queueFollowUp(input);
    try {
      const ack: SteerAckOutcome = await run.steer(input.text);
      // Ownership transfers only on complete_delivered; anything else is an ordinary follow-up.
      if (ack !== 'complete_delivered') this.queueFollowUp(input);
    } catch {
      this.queueFollowUp(input);
    }
  }

  private queueFollowUp(input: UserInput): void {
    this.followUps.push({ text: input.text, images: input.images });
    this.ctx.updateMeta({ queued: this.followUps.length });
  }

  private async drainFollowUps(): Promise<void> {
    if (this.disposed || this._busy || !this.followUps.length) return;
    const next = this.followUps.shift()!;
    this.ctx.updateMeta({ queued: this.followUps.length });
    await this.runTurn({ text: next.text, images: next.images, mode: 'now' });
  }

  /** Consume one run's event stream and normalize it to SessionEvents. */
  private async pump(run: Run): Promise<void> {
    for await (const msg of run.stream()) this.handle(msg);
    const status = run.status;
    if (status === 'cancelled') this.finishTurn('interrupted');
    else if (status === 'error' || run.error) this.finishFailed(new Error(run.error?.message ?? 'Cursor run failed.'));
    else this.finishTurn('completed');
  }

  private handle(msg: SDKMessage): void {
    switch (msg.type) {
      case 'system':
        if (msg.model?.id) this.ctx.updateMeta({ activeModel: { provider: 'cursor', model: msg.model.id } });
        return;
      case 'assistant':
        this.handleAssistant(msg);
        return;
      case 'thinking':
        this.handleThinking(msg.text ?? '');
        return;
      case 'tool_call':
        this.closeBubble();
        this.upsertTool(msg);
        return;
      case 'task':
        if (msg.text) this.ctx.emit({ type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level: 'info', text: truncate(msg.text, 400) } });
        return;
      case 'usage': {
        const u = msg.usage;
        const turn: Partial<UsageTotals> = {
          inputTokens: u.inputTokens ?? 0,
          outputTokens: u.outputTokens ?? 0,
          cacheReadTokens: u.cacheReadTokens ?? 0,
          cacheWriteTokens: u.cacheWriteTokens ?? 0,
          reasoningTokens: u.reasoningTokens ?? 0
        };
        this.totals.inputTokens += turn.inputTokens ?? 0;
        this.totals.outputTokens += turn.outputTokens ?? 0;
        this.totals.cacheReadTokens += turn.cacheReadTokens ?? 0;
        this.totals.cacheWriteTokens += turn.cacheWriteTokens ?? 0;
        this.totals.reasoningTokens += turn.reasoningTokens ?? 0;
        // No dollar cost: usage is billed to the Cursor plan, not a per-token meter we can price.
        this.totals.costUsd = 0;
        this.totals.turns += 1;
        this.turnUsage = turn;
        this.ctx.emit({ type: 'usage', totals: { ...this.totals } });
        return;
      }
      default:
        // 'user' echoes and cloud-only 'request' ids carry nothing to render.
        return;
    }
  }

  private handleAssistant(msg: Extract<SDKMessage, { type: 'assistant' }>): void {
    for (const block of msg.message?.content ?? []) {
      if (block.type === 'text' && block.text) {
        const b = this.ensureBubble();
        // The stream may carry snapshots (full text so far) or chunks; the prefix check tells them apart.
        const incoming = block.text;
        if (incoming.startsWith(b.text)) {
          const delta = incoming.slice(b.text.length);
          b.text = incoming;
          if (delta) this.ctx.emit({ type: 'item.delta', id: b.id, textDelta: delta });
        } else {
          b.text += incoming;
          this.ctx.emit({ type: 'item.delta', id: b.id, textDelta: incoming });
        }
        this.emitBubble(true);
      } else if (block.type === 'tool_use' && block.id && block.name) {
        this.closeBubble();
        this.upsertTool({ type: 'tool_call', agent_id: '', run_id: '', call_id: block.id, name: block.name, status: 'running', args: block.input });
      }
    }
  }

  private handleThinking(text: string): void {
    if (!text) return;
    const b = this.ensureBubble();
    if (text.startsWith(b.thinking)) {
      const delta = text.slice(b.thinking.length);
      b.thinking = text;
      if (delta) this.ctx.emit({ type: 'item.delta', id: b.id, thinkingDelta: delta });
    } else {
      b.thinking += text;
      this.ctx.emit({ type: 'item.delta', id: b.id, thinkingDelta: text });
    }
    this.emitBubble(true);
  }

  private ensureBubble(): { id: string; text: string; thinking: string } {
    if (!this.bubble) this.bubble = { id: shortId('a_'), text: '', thinking: '' };
    return this.bubble;
  }

  private closeBubble(): void {
    if (!this.bubble) return;
    this.emitBubble(false);
    this.bubble = null;
  }

  private emitBubble(streaming: boolean): void {
    const b = this.bubble;
    if (!b || (!b.text && !b.thinking)) return;
    this.ctx.emit({
      type: 'item.upsert',
      item: { id: b.id, kind: 'assistant', ts: Date.now(), text: truncate(b.text, TEXT_LIMIT), thinking: b.thinking || undefined, streaming, model: this.model?.id }
    });
  }

  private upsertTool(msg: SDKToolUseMessage): void {
    const id = msg.call_id || shortId('t_');
    const existing = this.toolItems.get(id);
    const args = msg.args ?? existing?.input;
    const status = msg.status === 'running' ? 'running' : msg.status === 'error' ? 'error' : 'done';
    const item: Extract<TranscriptItem, { kind: 'tool' }> = {
      id,
      kind: 'tool',
      ts: existing?.ts ?? Date.now(),
      name: msg.name || existing?.name || 'tool',
      hint: existing?.hint ?? toolHint(msg.name ?? ''),
      input: args,
      summary: existing?.summary ?? toolSummary(msg.name ?? '', args),
      output: msg.result !== undefined ? truncate(toolOutput(msg.result) ?? '', TEXT_LIMIT) : existing?.output,
      status,
      changes: existing?.changes ?? toolChanges(msg.name ?? '', args),
      exitCode: msg.result !== undefined ? resultExitCode(msg.result) : existing?.exitCode
    };
    this.toolItems.set(id, item);
    this.ctx.emit({ type: 'item.upsert', item: { ...item } });
  }

  private finishTurn(status: 'completed' | 'interrupted'): void {
    this.closeBubble();
    this.ctx.emit({
      type: 'item.upsert',
      item: {
        id: shortId('turn_'),
        kind: 'turn',
        ts: Date.now(),
        status,
        durationMs: Date.now() - this.turnStartedAt,
        usage: this.turnUsage
      }
    });
    this.turnUsage = undefined;
  }

  private finishFailed(e: unknown): void {
    this.ctx.emit({
      type: 'item.upsert',
      item: { id: shortId('turn_'), kind: 'turn', ts: Date.now(), status: 'failed', durationMs: Date.now() - this.turnStartedAt, error: errorMessage(e) }
    });
    this.turnUsage = undefined;
  }

  async interrupt(): Promise<void> {
    const run = this.run;
    if (!run) return;
    try {
      await run.cancel();
    } catch (e) {
      this.ctx.log('warn', `cursor cancel failed: ${errorMessage(e)}`);
    }
  }

  async setModel(model: ModelRef): Promise<void> {
    // Cursor keeps the model sticky after a send({ model }); applied on the next turn.
    this.model = toModelSelection(model);
    this.ctx.updateMeta({ activeModel: model });
  }

  async setEffort(_effort: EffortLevel): Promise<void> {
    // The Cursor SDK has no reasoning-effort knob; the header hides the control (capabilities.effort).
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (mode === this.permissionMode) return;
    this.permissionMode = mode;
    // tools/sandbox are not persisted on the agent: drop the handle so the next turn re-resumes
    // with the new options (the conversation itself lives in Cursor's local agent store).
    if (!this._busy) {
      this.agent?.close();
      this.agent = null;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const models = await listCursorModels(this.apiKey);
      return models.length ? models : CURSOR_STATIC_MODELS;
    } catch (e) {
      this.ctx.log('debug', `Cursor.models.list failed (${errorMessage(e)}); using the built-in catalog.`);
      return CURSOR_STATIC_MODELS;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.run?.cancel().catch(() => undefined);
    this.run = null;
    this.agent?.close();
    this.agent = null;
  }
}
