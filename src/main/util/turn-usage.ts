import type { UsageTotals } from '../../shared/types';

const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'costUsd'] as const;
type UsageField = (typeof USAGE_FIELDS)[number];
export type TurnUsage = Partial<Pick<UsageTotals, UsageField>>;

function emptyTurnUsage(): TurnUsage {
  return {};
}

/** Tracks session-cumulative usage while deriving the delta for each completed turn. */
export class TurnUsageTracker {
  private totals: UsageTotals;
  private turnBase: UsageTotals | null = null;

  constructor(initial: UsageTotals) {
    this.totals = { ...initial };
  }

  snapshot(): UsageTotals {
    return { ...this.totals };
  }

  /** Starts a turn baseline. Calling this while a turn is active resets that baseline. */
  beginTurn(): void {
    this.turnBase = this.snapshot();
  }

  /** Adds a per-request usage sample to the cumulative totals. */
  addUsage(usage: TurnUsage): void {
    for (const field of USAGE_FIELDS) {
      const value = usage[field];
      if (typeof value === 'number' && Number.isFinite(value)) this.totals[field] += value;
    }
  }

  /** Replaces cumulative counters reported by a harness, clamping resets to the known total. */
  setCumulative(usage: TurnUsage & Partial<Pick<UsageTotals, 'contextTokens' | 'contextWindow'>>): void {
    for (const field of USAGE_FIELDS) {
      const value = usage[field];
      if (typeof value === 'number' && Number.isFinite(value)) this.totals[field] = Math.max(this.totals[field], value);
    }
    if (typeof usage.contextTokens === 'number' && Number.isFinite(usage.contextTokens)) this.totals.contextTokens = usage.contextTokens;
    if (typeof usage.contextWindow === 'number' && Number.isFinite(usage.contextWindow)) this.totals.contextWindow = usage.contextWindow;
  }

  /** Ends a turn, optionally incrementing the completed-turn count, and returns its cumulative/delta views. */
  finishTurn(count = true): { totals: UsageTotals; usage?: TurnUsage } {
    const base = this.turnBase;
    this.turnBase = null;
    if (count) this.totals.turns += 1;
    if (!base) return { totals: this.snapshot() };
    const usage = emptyTurnUsage();
    for (const field of USAGE_FIELDS) usage[field] = Math.max(0, this.totals[field] - base[field]);
    return { totals: this.snapshot(), usage };
  }
}
