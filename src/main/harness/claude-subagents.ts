/**
 * Subagent run capture for the Claude Agent SDK adapter.
 *
 * Claude Code runs its own subagents: the `Agent`/`Task` tool spawns a child whose messages come
 * back on the same stream with `parent_tool_use_id` set to the spawning `tool_use_id`. The adapter
 * needs `forwardSubagentText: true` for the child's text to be forwarded at all — without it only
 * the child's tool calls arrive. This turns that stream into the run records the Subagents panel
 * reads, in the same format the pi extension writes.
 *
 * One run per spawning tool call, keyed by its `tool_use_id` (which doubles as the run id, so the
 * transcript card can link straight to it). No Electron imports, so it is unit-testable in Node.
 */

import { estimateCostUsd, findPricing } from '../models/static-models';
import { isValidRunId } from '../subagents';
import { RunStore } from '../subagent-runs';
import { emptyRunTotals, type SubagentItem, type SubagentRunMeta, type SubagentRunMode, type SubagentRunStatus, type SubagentRunTotals } from '../../shared/subagents';
import type { ModelInfo, SessionEvent } from '../../shared/types';

/** Tool names that spawn a Claude Code subagent. */
export const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

/**
 * The SDK's sentinel for a message it composed itself — an API error notice, a context-limit
 * warning — rather than one a model produced. It arrives on the nested stream shaped like an
 * ordinary assistant message, so it is never the child's model and never a model call.
 */
export const SYNTHETIC_MODEL = '<synthetic>';

/**
 * Characters kept from a failure reason. It is rendered inline in the run's detail pane, and an
 * erroring tool result can carry a whole dump behind the line that explains it.
 */
const ERROR_CHARS = 2_000;

/** A failure reason the panel can render inline: trimmed, and bounded to one message's worth. */
function clipError(error: string | undefined): string | undefined {
  const text = error?.trim();
  if (!text) return undefined;
  return text.length > ERROR_CHARS ? `${text.slice(0, ERROR_CHARS)}…` : text;
}

/** True for a model id a model actually reported, as opposed to the SDK's own sentinel. */
export function isRealModel(model: string | undefined): model is string {
  return typeof model === 'string' && model.length > 0 && model !== SYNTHETIC_MODEL;
}

/** `system`/`task_started`, narrowed to the fields this tracker consumes. */
export interface TaskStartedLike {
  task_id: string;
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  is_backgrounded?: boolean;
  /** Ambient/housekeeping tasks are not user-visible activity, so they never become runs. */
  ambient?: boolean;
  skip_transcript?: boolean;
}

/** `system`/`task_progress`. */
export interface TaskProgressLike {
  task_id: string;
  tool_use_id?: string;
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
}

/** `system`/`task_updated`. */
export interface TaskUpdatedLike {
  task_id: string;
  tool_use_id?: string;
  patch?: { status?: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused'; error?: string; is_backgrounded?: boolean };
}

/** `system`/`task_notification` — the terminal record. */
export interface TaskNotificationLike {
  task_id: string;
  tool_use_id?: string;
  status: 'completed' | 'failed' | 'stopped';
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
}

/** One block of a nested assistant message, as far as this tracker reads it. */
export interface NestedAssistantLike {
  message: {
    id?: string;
    model?: string;
    stop_reason?: string | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      output_tokens_details?: { thinking_tokens?: number };
    };
    content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
  };
}

interface CallDraft {
  id: string;
  index: number;
  model?: string;
  stopReason?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  toolsInvoked: string[];
}

interface RunState {
  runId: string;
  toolUseId: string;
  agent: string;
  description: string;
  mode: SubagentRunMode;
  model?: string;
  startedAt: number;
  ended: boolean;
  /** The assistant bubble text is appended to, so consecutive blocks read as one answer. */
  text: { id: string; value: string } | null;
  /** Nested tool calls by their own tool_use id, so a result can close the right one. */
  tools: Map<string, SubagentItem>;
  call: CallDraft | null;
  calls: number;
  toolUses: number;
  totals: SubagentRunTotals;
}

export interface ClaudeSubagentRunsOptions {
  /** Where run files go (`subagentDir(sessionDir, 'claude')`); null disables capture entirely. */
  dir: string | null;
  cwd: string;
  /** Read lazily: the adapter resolves which endpoint backs the session during `start()`. */
  providerId: () => string | undefined;
  /** The endpoint's own cached catalog, so a call on a model only the gateway knows prices correctly. */
  models: () => ModelInfo[];
  emit: (event: SessionEvent) => void;
  log: (level: 'debug' | 'warn', message: string) => void;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

/** A tool_use id is usually already a safe file name; anything else is folded into one. */
export function safeRunId(toolUseId: string): string {
  const folded = toolUseId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64).replace(/^\.+/, '');
  return isValidRunId(folded) ? folded : `run_${Date.now().toString(36)}`;
}

function statusFromTask(status: 'completed' | 'failed' | 'stopped'): SubagentRunStatus {
  return status === 'completed' ? 'completed' : status === 'failed' ? 'error' : 'stopped';
}

export class ClaudeSubagentRuns {
  private readonly runs = new Map<string, RunState>();
  /** task id → spawning tool_use id, for task messages that omit `tool_use_id`. */
  private readonly tasks = new Map<string, string>();
  /** A `task_started` that arrived before its tool_use block; applied when the run opens. */
  private readonly pending = new Map<string, { agent?: string; description?: string; mode?: SubagentRunMode; taskId: string }>();
  private readonly store: RunStore | null;
  private readonly cwd: string;
  private readonly provider: () => string | undefined;
  private readonly models: () => ModelInfo[];
  private readonly emit: (event: SessionEvent) => void;
  private readonly log: (level: 'debug' | 'warn', message: string) => void;
  private seq = 0;

  constructor(options: ClaudeSubagentRunsOptions) {
    this.cwd = options.cwd;
    this.provider = options.providerId;
    this.models = options.models;
    this.emit = options.emit;
    this.log = options.log;
    this.store = options.dir ? new RunStore(options.dir, (message) => this.log('warn', message)) : null;
  }

  /**
   * The endpoint backing the session. The SDK's own login is Anthropic, and pricing already assumes
   * as much, so the label on a call row says the same thing the cost was computed with.
   */
  private get endpoint(): string {
    return this.provider() ?? 'anthropic';
  }

  /** True while at least one captured run has not ended. */
  get active(): boolean {
    return this.runs.size > 0;
  }

  /** Live run metadata for a task id, so `background_tasks_changed` can enrich subagent entries. */
  lookupByTaskId(taskId: string): { runId: string; agent: string; description: string; startedAt: number; turns: number; toolUses: number } | undefined {
    const id = this.tasks.get(taskId);
    const state = id ? this.runs.get(id) : undefined;
    if (!state || state.ended) return undefined;
    return {
      runId: state.runId,
      agent: state.agent,
      description: state.description,
      startedAt: state.startedAt,
      turns: state.totals.turns,
      toolUses: state.toolUses
    };
  }

  /**
   * A main-thread `Agent`/`Task` tool call opens a run. Returns the run id so the transcript card
   * can link to it, or null when this session is not recording runs.
   */
  start(toolUseId: string, input: Record<string, unknown>, model: string | undefined): string | null {
    if (!this.store) return null;
    const deferred = this.pending.get(toolUseId);
    this.pending.delete(toolUseId);
    const state: RunState = {
      runId: safeRunId(toolUseId),
      toolUseId,
      agent: deferred?.agent ?? (typeof input.subagent_type === 'string' && input.subagent_type ? input.subagent_type : 'general-purpose'),
      description: deferred?.description ?? (typeof input.description === 'string' ? input.description : ''),
      // The call's own flag is known before any task message arrives, and it decides whether the
      // spawning tool result ends the run or a later task_notification does.
      mode: input.run_in_background === true || deferred?.mode === 'background' ? 'background' : 'foreground',
      ...(model ? { model } : {}),
      startedAt: Date.now(),
      ended: false,
      text: null,
      tools: new Map(),
      call: null,
      calls: 0,
      toolUses: 0,
      totals: emptyRunTotals()
    };
    if (deferred?.taskId) this.tasks.set(deferred.taskId, toolUseId);
    this.runs.set(toolUseId, state);
    void this.store.start(this.metaOf(state));
    this.announce(state, 'running');
    return state.runId;
  }

  /** The run-header record, written once when the run opens and again if its facts are corrected. */
  private metaOf(state: RunState): SubagentRunMeta {
    return {
      runId: state.runId,
      agent: state.agent,
      description: state.description,
      mode: state.mode,
      provider: this.endpoint,
      ...(state.model ? { model: state.model } : {}),
      cwd: this.cwd,
      startedAt: state.startedAt
    };
  }

  /**
   * The SDK's own task lifecycle, which is authoritative where it speaks: `task_started` names the
   * subagent type and whether it was backgrounded, and `task_notification` is the terminal record.
   */
  onTaskStarted(msg: TaskStartedLike): void {
    if (msg.ambient || msg.skip_transcript) return;
    const state = msg.tool_use_id ? this.runs.get(msg.tool_use_id) : this.find(msg.task_id, msg.tool_use_id);
    const info = {
      ...(msg.subagent_type ? { agent: msg.subagent_type } : {}),
      ...(msg.description ? { description: msg.description } : {}),
      mode: (msg.is_backgrounded ? 'background' : 'foreground') as SubagentRunMode,
      taskId: msg.task_id
    };
    // The tool_use block has not reached us yet; keep the facts for when it does.
    if (!state) {
      if (msg.tool_use_id) this.pending.set(msg.tool_use_id, info);
      return;
    }
    if (state.ended) return;
    state.agent = info.agent ?? state.agent;
    state.description = info.description ?? state.description;
    state.mode = info.mode;
    this.tasks.set(msg.task_id, state.toolUseId);
    this.announce(state, 'running');
  }

  onTaskProgress(msg: TaskProgressLike): void {
    const state = this.find(msg.task_id, msg.tool_use_id);
    if (!state || state.ended) return;
    const toolUses = finite(msg.usage?.tool_uses);
    if (toolUses !== undefined) state.toolUses = toolUses;
    const durationMs = finite(msg.usage?.duration_ms);
    if (durationMs !== undefined) state.totals.durationMs = durationMs;
    this.announce(state, 'running');
  }

  onTaskUpdated(msg: TaskUpdatedLike): void {
    const state = this.find(msg.task_id, msg.tool_use_id);
    if (!state || state.ended) return;
    if (msg.patch?.is_backgrounded === true && state.mode !== 'background') {
      state.mode = 'background';
      this.announce(state, 'running');
    }
    const status = msg.patch?.status;
    if (status === 'completed') void this.finish(state, 'completed');
    else if (status === 'failed') void this.finish(state, 'error', msg.patch?.error);
    else if (status === 'killed') void this.finish(state, 'stopped');
  }

  onTaskNotification(msg: TaskNotificationLike): void {
    const state = this.find(msg.task_id, msg.tool_use_id);
    if (!state || state.ended) return;
    const toolUses = finite(msg.usage?.tool_uses);
    if (toolUses !== undefined) state.toolUses = toolUses;
    const durationMs = finite(msg.usage?.duration_ms);
    if (durationMs !== undefined) state.totals.durationMs = durationMs;
    void this.finish(state, statusFromTask(msg.status));
  }

  /** A message produced inside a subagent: its own answer text and its own tool calls. */
  onNestedAssistant(parentToolUseId: string, msg: NestedAssistantLike): void {
    const state = this.runs.get(parentToolUseId);
    if (!state || state.ended) return;
    // The model the spawning message named is the parent's; a child that runs on its own model
    // (Claude Code's Explore agent, an agent definition pinned to one) corrects the record here,
    // which is also what the panel's run row and its cost attribution should say. A synthetic
    // message is the SDK speaking rather than a model, so it corrects nothing.
    const childModel = msg.message.model;
    if (isRealModel(childModel) && childModel !== state.model) {
      state.model = childModel;
      void this.store?.start(this.metaOf(state));
    }
    // Its text is still shown below — that is how an API error reaches the transcript — but it opens
    // no call row, which would invent a turn and a cost for a request that never reached a model.
    if (isRealModel(childModel)) this.trackCall(state, msg);
    for (const block of msg.message.content ?? []) {
      if (block.type === 'text' && block.text) this.appendText(state, block.text);
      else if (block.type === 'tool_use' && block.id && block.name) {
        // A tool call closes the current bubble so the next text starts below the tool card.
        state.text = null;
        const item: SubagentItem = {
          id: block.id,
          ts: Date.now(),
          kind: 'tool',
          name: block.name,
          summary: summarize((block.input ?? {}) as Record<string, unknown>),
          status: 'running',
          input: (block.input ?? {}) as Record<string, unknown>
        };
        state.tools.set(block.id, item);
        state.toolUses += 1;
        void this.store?.item(state.runId, item);
        this.announce(state, 'running');
      }
    }
  }

  /** The result of a tool call made inside a subagent. */
  onNestedToolResult(parentToolUseId: string, toolUseId: string, output: string, isError: boolean): void {
    const state = this.runs.get(parentToolUseId);
    if (!state || state.ended) return;
    const item = state.tools.get(toolUseId);
    if (!item) return;
    const done: SubagentItem = { ...item, output, status: isError ? 'error' : 'done' };
    state.tools.set(toolUseId, done);
    void this.store?.item(state.runId, done);
    this.announce(state, 'running');
  }

  /**
   * The spawning tool call returned. For a foreground subagent that is the end of the run; a
   * backgrounded one reports through `task_notification` and so is left alone.
   *
   * `output` is that result as the model saw it, and on an error it is the run's only account of
   * itself: a spawn Claude Code refuses — past its concurrent subagent cap, an agent type it does
   * not know — never becomes a task, so there is no transcript and no `task_notification` to read
   * the reason from. Recording it is what keeps the panel from showing a bare `error` with nothing
   * to explain it, which is how pi already reports a run it could not start.
   */
  onCallResult(toolUseId: string, isError: boolean, output?: string): void {
    const state = this.runs.get(toolUseId);
    if (!state || state.ended || state.mode === 'background') return;
    void this.finish(state, isError ? 'error' : 'completed', isError ? output : undefined);
  }

  /**
   * The session is going away. Runs left open would otherwise read as `running` forever in an app
   * that stays open, so they are closed as interrupted — the same verdict the reader gives a run
   * whose owner vanished.
   */
  async settle(): Promise<void> {
    for (const state of [...this.runs.values()]) if (!state.ended) await this.finish(state, 'interrupted');
    await this.store?.flush();
  }

  private find(taskId: string, toolUseId: string | undefined): RunState | undefined {
    const id = toolUseId ?? this.tasks.get(taskId);
    return id ? this.runs.get(id) : undefined;
  }

  /**
   * One row per model call. The CLI emits a message per completed content block, so several
   * consecutive messages can share a `message.id` and carry partial usage — the row is rewritten
   * while the id stays the same and closed when it changes.
   */
  private trackCall(state: RunState, msg: NestedAssistantLike): void {
    const message = msg.message;
    const id = message.id ?? `call_${state.calls}`;
    if (state.call && state.call.id !== id) void this.closeCall(state);
    state.call ??= {
      id,
      index: state.calls,
      ...(message.model ? { model: message.model } : {}),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      toolsInvoked: []
    };
    const call = state.call;
    if (message.model) call.model = message.model;
    if (message.stop_reason) call.stopReason = message.stop_reason;
    const usage = message.usage;
    // Counters on a shared message id are cumulative for that call, so the largest value wins.
    call.inputTokens = Math.max(call.inputTokens, finite(usage?.input_tokens) ?? 0);
    call.outputTokens = Math.max(call.outputTokens, finite(usage?.output_tokens) ?? 0);
    call.cacheReadTokens = Math.max(call.cacheReadTokens, finite(usage?.cache_read_input_tokens) ?? 0);
    call.cacheWriteTokens = Math.max(call.cacheWriteTokens, finite(usage?.cache_creation_input_tokens) ?? 0);
    call.reasoningTokens = Math.max(call.reasoningTokens, finite(usage?.output_tokens_details?.thinking_tokens) ?? 0);
    for (const block of message.content ?? []) {
      if (block.type === 'tool_use' && block.name && !call.toolsInvoked.includes(block.name)) call.toolsInvoked.push(block.name);
    }
  }

  private async closeCall(state: RunState): Promise<void> {
    const call = state.call;
    state.call = null;
    if (!call) return;
    const model = call.model ?? state.model;
    const provider = this.endpoint;
    const costUsd = estimateCostUsd(findPricing(provider, model ?? '', this.models()), call);
    state.calls += 1;
    state.totals.turns = state.calls;
    state.totals.inputTokens += call.inputTokens;
    state.totals.outputTokens += call.outputTokens;
    state.totals.cacheReadTokens += call.cacheReadTokens;
    state.totals.cacheWriteTokens += call.cacheWriteTokens;
    state.totals.reasoningTokens += call.reasoningTokens;
    state.totals.costUsd += costUsd;
    // Per-call wall clock is not on the wire; the run's duration comes from the task messages.
    await this.store?.call(state.runId, {
      index: call.index,
      provider: this.endpoint,
      ...(model ? { model } : {}),
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cacheReadTokens: call.cacheReadTokens,
      cacheWriteTokens: call.cacheWriteTokens,
      reasoningTokens: call.reasoningTokens,
      costUsd,
      durationMs: 0,
      ...(call.stopReason ? { stopReason: call.stopReason } : {}),
      toolsInvoked: [...call.toolsInvoked]
    });
  }

  private appendText(state: RunState, text: string): void {
    state.text ??= { id: `${state.runId}-t${this.seq++}`, value: '' };
    state.text.value += text;
    void this.store?.item(state.runId, { id: state.text.id, ts: Date.now(), kind: 'assistant', text: state.text.value });
    this.announce(state, 'running');
  }

  private async finish(state: RunState, status: SubagentRunStatus, error?: string): Promise<void> {
    if (state.ended) return;
    state.ended = true;
    await this.closeCall(state);
    state.totals.toolUses = state.toolUses;
    state.totals.durationMs ||= Date.now() - state.startedAt;
    const reason = clipError(error);
    await this.store?.end(state.runId, status, state.totals, reason);
    this.emit({
      type: 'subagent',
      completion: {
        agentId: state.runId,
        ...(state.description ? { description: state.description } : {}),
        status,
        ...(state.model ? { model: { provider: this.endpoint, model: state.model } } : {}),
        toolUses: state.toolUses,
        costUsd: state.totals.costUsd,
        tokens: state.totals.inputTokens + state.totals.outputTokens + state.totals.cacheReadTokens + state.totals.cacheWriteTokens,
        durationMs: state.totals.durationMs,
        ...(reason ? { error: reason } : {}),
        agentType: state.agent
      }
    });
    // No `usage` on purpose: the SDK's cumulative session totals already include this subagent's
    // spend, so reporting it here as well would double-count it.
    this.emit({ type: 'subagent.run', run: this.update(state, status, Date.now()) });
    this.runs.delete(state.toolUseId);
  }

  private announce(state: RunState, status: SubagentRunStatus): void {
    this.emit({ type: 'subagent.run', run: this.update(state, status) });
  }

  private update(state: RunState, status: SubagentRunStatus, endedAt?: number) {
    return {
      runId: state.runId,
      agent: state.agent,
      description: state.description,
      mode: state.mode,
      status,
      provider: this.endpoint,
      ...(state.model ? { model: state.model } : {}),
      startedAt: state.startedAt,
      ...(endedAt ? { endedAt } : {}),
      costUsd: state.totals.costUsd,
      turns: state.totals.turns,
      toolUses: state.toolUses
    };
  }
}

/** The same one-line summary the transcript gives a tool call. */
function summarize(input: Record<string, unknown>): string {
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.path === 'string') return input.path;
  if (typeof input.command === 'string') return input.command;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.query === 'string') return input.query;
  if (typeof input.url === 'string') return input.url;
  if (typeof input.description === 'string') return input.description;
  const raw = JSON.stringify(input);
  if (raw === '{}' || raw === undefined) return '';
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}
