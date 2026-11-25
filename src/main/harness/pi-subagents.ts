/** Tracks live Vocs Code subagent runs, wakeup indicators, and legacy pi-subagents completions/cost attribution. */
import { modelName, UNKNOWN_MODEL_KEY } from '../../shared/model-names';
import type { ModelInfo, SessionEvent, SubagentCompletion, SubagentCost, SubagentRunUpdate } from '../../shared/types';
import { resolveSubagentModel } from './pi-models';

/** Vocs Code's own subagent extension reports run activity as these notifications. */
export const PI_SUBAGENT_MARKER = 'VCODE_SUBAGENT::';
/** Tool names our subagent extension registers; their cards read as agent work, not shell work. */
export const SUBAGENT_TOOLS = new Set(['subagent', 'subagent_result', 'subagent_steer']);

/** pi-subagents' completion payload, as it reaches us on the tool result or the custom notification. */
interface PiSubagentDetails {
  id?: string;
  agentId?: string;
  description?: string;
  status?: string;
  modelName?: string;
  toolUses?: number;
  /** Foreground tool-result name for the cost. */
  cost?: number;
  /** Background notification name for the cost. */
  totalCost?: number;
  totalTokens?: number;
  durationMs?: number;
  error?: string;
  others?: PiSubagentDetails[];
}

/** A pi-subagents run is only counted once its own status is terminal. */
function isTerminalSubagentStatus(status: string | undefined): status is string {
  return status === 'completed' || status === 'error' || status === 'stopped' || status === 'aborted';
}

export class PiSubagentTracker {
  /** agentId -> the model name its Agent call reported, for attributing the completion notification. */
  private readonly subagentModelNames = new Map<string, string>();
  /** agentIds already counted, so a background run's tool result and notification are not both recorded. */
  private readonly recordedSubagents = new Set<string>();
  /** Subagent spend since the last usage report, keyed `provider/model`, for model re-attribution. */
  private readonly pendingSubagentCost = new Map<string, SubagentCost>();
  /** Live Vocs Code subagent runs by run id, until their terminal record arrives. */
  private readonly subagentRuns = new Map<string, { agent: string; description: string; mode: 'foreground' | 'background'; provider?: string; model?: string; startedAt: number; costUsd: number; turns: number; toolUses: number }>();
  /** True during the completion debounce after a background child ends and before the parent turn starts. */
  private wakeupPending = false;

  constructor(
    private readonly deps: {
      emit: (event: SessionEvent) => void;
      info: (text: string, level?: 'info' | 'warn' | 'error') => void;
      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
      getModels: () => readonly ModelInfo[];
    }
  ) {}

  reset(): void {
    this.subagentModelNames.clear();
    this.recordedSubagents.clear();
    this.pendingSubagentCost.clear();
    this.subagentRuns.clear();
    this.wakeupPending = false;
  }

  clearWakeup(): void {
    if (!this.wakeupPending) return;
    this.wakeupPending = false;
    this.deps.emit({ type: 'ongoing', source: 'wakeup', items: [] });
  }

  drainPendingCost(): SubagentCost[] | undefined {
    if (!this.pendingSubagentCost.size) return undefined;
    const out = [...this.pendingSubagentCost.values()];
    this.pendingSubagentCost.clear();
    return out;
  }

  /**
   * Live activity from Vocs Code's own subagent extension. Runs are already durable in
   * `<sessionDir>/subagents/<runId>.jsonl`; this translates them into app events: a live run view
   * for the panel and, on the terminal record, the completion analytics has always consumed.
   */
  handleSubagentEvent(raw: string, extensionNonce: string): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.deps.log('warn', 'pi: malformed subagent notification');
      return;
    }
    if (extensionNonce && (payload.version !== 1 || payload.nonce !== extensionNonce)) return;
    const kind = payload.kind;
    const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
    if (kind === 'wakeup') {
      const pending = payload.pending === true;
      if (pending) {
        this.wakeupPending = true;
        const count = Math.max(1, number(payload.count) || 1);
        this.deps.emit({
          type: 'ongoing',
          source: 'wakeup',
          items: [{
            id: 'wakeup:subagent',
            kind: 'task',
            label: count > 1 ? `Delivering ${count} subagent results…` : 'Delivering subagent result…',
            detail: 'wakeup',
            startedAt: number(payload.startedAt) || Date.now()
          }]
        });
      } else {
        this.clearWakeup();
      }
      return;
    }
    const runId = typeof payload.runId === 'string' ? payload.runId : '';
    if (!runId) return;
    if (kind === 'start') {
      if (this.subagentRuns.has(runId) || this.recordedSubagents.has(runId)) return;
      const run = {
        agent: text(payload.agent) ?? 'general-purpose',
        description: text(payload.description) ?? '',
        mode: payload.mode === 'background' ? ('background' as const) : ('foreground' as const),
        provider: text(payload.provider),
        model: text(payload.model),
        startedAt: number(payload.startedAt) || Date.now(),
        costUsd: 0,
        turns: 0,
        toolUses: 0
      };
      this.subagentRuns.set(runId, run);
      this.deps.emit({ type: 'subagent.run', run: { runId, agent: run.agent, description: run.description, mode: run.mode, status: 'running', ...(run.provider ? { provider: run.provider } : {}), ...(run.model ? { model: run.model } : {}), startedAt: run.startedAt } });
      return;
    }
    const run = this.subagentRuns.get(runId);
    if (kind === 'call' && run) {
      const call = (payload.call ?? {}) as Record<string, unknown>;
      run.costUsd += number(call.costUsd);
      run.turns += 1;
      const live: SubagentRunUpdate = { runId, agent: run.agent, description: run.description, mode: run.mode, status: 'running', costUsd: run.costUsd, turns: run.turns, toolUses: run.toolUses, startedAt: run.startedAt };
      this.deps.emit({ type: 'subagent.run', run: live });
      return;
    }
    if (kind === 'item' && run) {
      const item = (payload.item ?? {}) as Record<string, unknown>;
      if (item.kind === 'tool' && item.status && item.status !== 'running') {
        run.toolUses += 1;
        this.deps.emit({ type: 'subagent.run', run: { runId, agent: run.agent, description: run.description, mode: run.mode, status: 'running', costUsd: run.costUsd, turns: run.turns, toolUses: run.toolUses, startedAt: run.startedAt } });
      }
      return;
    }
    if (kind === 'uncertain' && run) {
      this.deps.info(`Subagent ${runId} has not settled: ${text(payload.error) ?? 'child disposal is unproven'}`, 'warn');
      return;
    }
    if (kind !== 'end' || !run || !['completed', 'error', 'stopped', 'interrupted'].includes(String(payload.status))) return;
    this.recordedSubagents.add(runId);
    const totals = (payload.totals ?? {}) as Record<string, unknown>;
    const status = String(payload.status);
    const endedAt = number(payload.endedAt) || Date.now();
    const model = run?.provider && run.model ? { provider: run.provider, model: run.model } : undefined;
    const tokens = number(totals.inputTokens) + number(totals.outputTokens) + number(totals.cacheReadTokens) + number(totals.cacheWriteTokens);
    this.deps.emit({
      type: 'subagent',
      completion: {
        agentId: runId,
        ...(run?.description ? { description: run.description } : {}),
        status,
        ...(model ? { model } : {}),
        toolUses: number(totals.toolUses) || run?.toolUses || 0,
        costUsd: number(totals.costUsd),
        tokens,
        durationMs: number(totals.durationMs),
        ...(text(payload.error) ? { error: text(payload.error) } : {}),
        ...(run?.agent ? { agentType: run.agent } : {}),
        // A background run's spend never reaches the harness totals, so analytics adds it here.
        // Foreground spend is already folded in through the tool result; reporting it again would double it.
        ...(run?.mode === 'background'
          ? {
              usage: {
                inputTokens: number(totals.inputTokens),
                outputTokens: number(totals.outputTokens),
                cacheReadTokens: number(totals.cacheReadTokens),
                cacheWriteTokens: number(totals.cacheWriteTokens),
                reasoningTokens: number(totals.reasoningTokens),
                costUsd: number(totals.costUsd),
                turns: number(totals.turns)
              }
            }
          : {})
      }
    });
    this.deps.emit({
      type: 'subagent.run',
      run: {
        runId,
        agent: run?.agent ?? 'general-purpose',
        description: run?.description ?? '',
        mode: run?.mode ?? 'foreground',
        status: status === 'completed' || status === 'error' || status === 'stopped' || status === 'interrupted' ? status : 'error',
        ...(run?.provider ? { provider: run.provider } : {}),
        ...(run?.model ? { model: run.model } : {}),
        startedAt: run?.startedAt ?? endedAt,
        endedAt,
        costUsd: number(totals.costUsd),
        turns: number(totals.turns),
        toolUses: number(totals.toolUses),
        ...(text(payload.error) ? { error: text(payload.error) } : {})
      }
    });
    this.subagentRuns.delete(runId);
  }

  /** Captures the model and terminal stats pi-subagents puts on an Agent / get_subagent_result tool result. */
  captureSubagentResult(details: unknown): void {
    const d = details as PiSubagentDetails | undefined;
    if (!d || typeof d !== 'object') return;
    const agentId = d.agentId ?? d.id;
    if (!agentId) return;
    if (d.modelName) this.subagentModelNames.set(agentId, d.modelName);
    // Foreground runs return their full stats here; a background spawn's result is zeros, not
    // settlement. Track that known child in the same normalized stream as our shipped extension.
    if (isTerminalSubagentStatus(d.status)) this.recordSubagent(d, agentId);
    else if (!this.recordedSubagents.has(agentId) && !this.subagentRuns.has(agentId)) {
      const run = { agent: 'Agent', description: d.description ?? '', mode: 'background' as const, startedAt: Date.now(), costUsd: 0, turns: 0, toolUses: 0 };
      this.subagentRuns.set(agentId, run);
      this.deps.emit({ type: 'subagent.run', run: { ...run, runId: agentId, status: 'running' } });
    }
  }

  /** Handles a background completion, including a group notification's `others`. */
  handleSubagentNotification(details: unknown): void {
    const d = details as PiSubagentDetails | undefined;
    if (!d || typeof d !== 'object') return;
    for (const rec of [d, ...(Array.isArray(d.others) ? d.others : [])]) {
      const agentId = rec.id ?? rec.agentId;
      if (agentId && isTerminalSubagentStatus(rec.status)) this.recordSubagent(rec, agentId);
    }
  }

  /** Records one finished run once: tool uses go to analytics, spend to the model that actually ran it. */
  private recordSubagent(d: PiSubagentDetails, agentId: string): void {
    if (this.recordedSubagents.has(agentId)) return;
    this.recordedSubagents.add(agentId);
    const costUsd = typeof d.cost === 'number' ? d.cost : typeof d.totalCost === 'number' ? d.totalCost : undefined;
    const model = resolveSubagentModel(this.deps.getModels(), d.modelName ?? this.subagentModelNames.get(agentId));
    if (costUsd && Number.isFinite(costUsd) && costUsd > 0) {
      const key = model ? modelName(model.provider, model.model) : UNKNOWN_MODEL_KEY;
      const cur = this.pendingSubagentCost.get(key) ?? { ...(model ?? { provider: null, model: null }), costUsd: 0 };
      cur.costUsd += costUsd;
      this.pendingSubagentCost.set(key, cur);
    }
    const completion: SubagentCompletion = {
      agentId,
      description: d.description,
      status: d.status ?? 'completed',
      model,
      toolUses: typeof d.toolUses === 'number' ? d.toolUses : 0,
      costUsd,
      tokens: typeof d.totalTokens === 'number' ? d.totalTokens : undefined,
      durationMs: d.durationMs,
      error: d.error
    };
    this.deps.emit({ type: 'subagent', completion });
    const run = this.subagentRuns.get(agentId);
    if (run) {
      this.deps.emit({ type: 'subagent.run', run: { ...run, runId: agentId, status: d.status === 'completed' ? 'completed' : d.status === 'error' ? 'error' : 'stopped', endedAt: Date.now() } });
      this.subagentRuns.delete(agentId);
    }
    const bits: string[] = [completion.status === 'error' ? 'failed' : 'finished'];
    bits.push(model ? modelName(model.provider, model.model) : 'model unknown');
    if (completion.toolUses) bits.push(`${completion.toolUses} tool ${completion.toolUses === 1 ? 'use' : 'uses'}`);
    if (completion.tokens) bits.push(`${completion.tokens.toLocaleString()} tokens`);
    if (costUsd) bits.push(`$${costUsd.toFixed(4)}`);
    this.deps.info(`Subagent${d.description ? ` "${d.description}"` : ''}: ${bits.join(' · ')}`, completion.status === 'error' ? 'error' : 'info');
  }
}
