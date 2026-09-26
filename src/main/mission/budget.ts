/** Observed thresholds, never a billing guarantee. Session totals already include native usage;
 * neither turn deltas, reasoning subsets, subagent notifications nor source history are added. */
import { isDeepStrictEqual } from 'node:util';
import type { MissionOperation, MissionRecord } from '../../shared/mission';
import type { SessionMeta, UsageTotals } from '../../shared/types';
import { totalTokens } from '../../shared/usage-rollup';

export interface MissionBudgetUsage { tokens: number; costUsd: number }
export interface MissionBudgetObservation { operationId: string; usage: MissionBudgetUsage }

export function budgetUsage(usage: UsageTotals): MissionBudgetUsage {
  return { tokens: totalTokens(usage), costUsd: usage.costUsd };
}

function sample(value: unknown): MissionBudgetUsage | undefined {
  if (!value || typeof value !== 'object') return;
  const entry = value as MissionBudgetUsage;
  if (Number.isFinite(entry.tokens) && entry.tokens >= 0 && Number.isFinite(entry.costUsd) && entry.costUsd >= 0) return entry;
}

/** Telemetry is durable history, but not a changed plan or a new authorization. Used on both
 * commit and replay: even a host-labelled observation cannot quietly edit control-plane data. */
export function assertMissionUsageObservation(before: MissionRecord, after: MissionRecord): void {
  const previous = structuredClone(before), next = structuredClone(after);
  for (const [index, operation] of next.operations.entries()) {
    const prior = previous.operations[index];
    const value = operation.payload.budgetUsage, old = prior?.payload.budgetUsage;
    if (!isDeepStrictEqual(value, old)) {
      const current = sample(value), earlier = sample(old);
      if (!prior || operation.id !== prior.id || operation.kind !== 'dispatch' || !current
        || !isDeepStrictEqual(value, { tokens: current.tokens, costUsd: current.costUsd })
        || earlier && (current.tokens < earlier.tokens || current.costUsd < earlier.costUsd)) throw new Error('Usage observation must retain monotonic dispatch counters.');
    }
    delete operation.payload.budgetUsage;
  }
  for (const operation of previous.operations) delete operation.payload.budgetUsage;
  next.revision = previous.revision; next.lastEventSequence = previous.lastEventSequence; next.updatedAt = previous.updatedAt;
  if (!isDeepStrictEqual(previous, next)) throw new Error('Usage observation cannot change Mission coordination or authority.');
}

/** Normalized totals are cumulative. Keep a high-water snapshot, never sum successive reports. */
export function mergeBudgetUsage(a: MissionBudgetUsage, b: MissionBudgetUsage): MissionBudgetUsage {
  return { tokens: Math.max(a.tokens, b.tokens), costUsd: Math.max(a.costUsd, b.costUsd) };
}

function dispatches(record: MissionRecord): MissionOperation[] {
  return record.operations.filter((op) => op.kind === 'dispatch' && !op.payload.infrastructure && typeof op.payload.sessionId === 'string');
}

/** Retained observations protect against a stale, debounced session index after a host crash. */
export function missionBudgetSessions(record: MissionRecord, sessions: readonly SessionMeta[], observations: readonly MissionBudgetObservation[] = []): Map<string, MissionBudgetUsage> {
  const result = new Map<string, MissionBudgetUsage>();
  const latest = new Map(observations.map((entry) => [entry.operationId, entry.usage]));
  const add = (id: string, value: MissionBudgetUsage | undefined) => {
    if (value) result.set(id, mergeBudgetUsage(result.get(id) ?? { tokens: 0, costUsd: 0 }, value));
  };
  for (const session of sessions) if (session.mission?.missionId === record.id) add(session.id, sample(budgetUsage(session.usage)));
  for (const op of dispatches(record)) {
    add(String(op.payload.sessionId), sample(op.payload.budgetBaseline));
    add(String(op.payload.sessionId), sample(op.payload.budgetUsage));
    add(String(op.payload.sessionId), sample(latest.get(op.id)));
  }
  return result;
}

export function missionBudgetIssue(record: MissionRecord, sessions: readonly SessionMeta[], observations: readonly MissionBudgetObservation[] = []): string | undefined {
  const { maxTokens, maxBudgetUsd } = record.config.limits;
  if (maxTokens === undefined && maxBudgetUsd === undefined) return;
  const totals = [...missionBudgetSessions(record, sessions, observations).values()].reduce((sum, usage) => ({ tokens: sum.tokens + usage.tokens, costUsd: sum.costUsd + usage.costUsd }), { tokens: 0, costUsd: 0 });
  const warning = 'Whole-Mission observed usage includes all lead/worker attempts. In-flight work and delayed or estimated telemetry can overshoot; this is not a hard financial ceiling.';
  if (maxTokens !== undefined && totals.tokens >= maxTokens) return `Mission token threshold reached (${totals.tokens} / ${maxTokens}). ${warning}`;
  if (maxBudgetUsd !== undefined && totals.costUsd >= maxBudgetUsd) return `Mission observed USD threshold reached (${totals.costUsd} / ${maxBudgetUsd}). ${warning}`;
  const latest = new Map(observations.map((entry) => [entry.operationId, entry.usage]));
  for (const op of dispatches(record)) {
    // Do not interrupt healthy long work for silence. Missing counters become a blocker at a
    // settled/reconciled turn, not on elapsed time or before the first report of a live turn.
    if (op.payload.dispatchStartedAt === undefined || !op.payload.terminalTurnId && !['succeeded', 'failed'].includes(op.state)) continue;
    const baseline = sample(op.payload.budgetBaseline);
    const observed = sample(op.payload.budgetUsage);
    const live = sample(latest.get(op.id));
    const usage = observed && live ? mergeBudgetUsage(observed, live) : observed ?? live;
    if (maxTokens !== undefined && (!baseline || !usage || usage.tokens <= baseline.tokens)) return `Mission token usage is unknown after dispatched work; automation is paused rather than treating missing telemetry as zero. ${warning}`;
    // A normalized zero cannot distinguish absent billing from free/subscription activity.
    // Previous positive cost also cannot certify this turn: require an advance over its base.
    if (maxBudgetUsd !== undefined && (!baseline || !usage || usage.costUsd <= baseline.costUsd)) return `Mission cost is unknown after dispatched work; automation is paused rather than treating missing billing telemetry as zero. Clear the optional USD threshold or use a runtime with cost telemetry. ${warning}`;
  }
}
