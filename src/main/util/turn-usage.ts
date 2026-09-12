import type { UsageTotals } from '../../shared/types';

const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'costUsd'] as const;
type UsageField = (typeof USAGE_FIELDS)[number];
export type TurnUsage = Partial<Pick<UsageTotals, UsageField>>;
type CumulativeUsage = TurnUsage & Partial<Pick<UsageTotals, 'contextTokens' | 'contextWindow'>>;

type SourceTotals = Partial<Record<UsageField, number>>;

/** Tracks session totals while deriving the delta for each completed turn. */
export class TurnUsageTracker {
  private totals: UsageTotals;
  /** Last counters reported by the harness. Kept separate so a provider reset starts a new epoch. */
  private sourceTotals: SourceTotals = {};
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

  /**
   * Applies counters reported cumulatively by a harness. Deltas are clamped at zero when a
   * counter moves backwards; the lower value becomes the new epoch baseline so usage after a
   * provider restart is counted again instead of being lost forever.
   */
  setCumulative(usage: CumulativeUsage): void {
    for (const field of USAGE_FIELDS) {
      const value = usage[field];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const previous = this.sourceTotals[field];
      if (previous === undefined) {
        // The app total may include an earlier provider process. Do not subtract it when the
        // first sample belongs to a freshly-reset provider counter.
        if (value > this.totals[field]) this.totals[field] = value;
      } else if (value >= previous) {
        this.totals[field] += value - previous;
      }
      // A decrease is a reset (or an out-of-order sample): keep totals monotonic and rebase.
      this.sourceTotals[field] = value;
    }
    if (typeof usage.contextTokens === 'number' && Number.isFinite(usage.contextTokens)) this.totals.contextTokens = usage.contextTokens;
    if (typeof usage.contextWindow === 'number' && Number.isFinite(usage.contextWindow)) this.totals.contextWindow = usage.contextWindow;
  }

  /** Ends an active turn, optionally incrementing completed turns, and returns its usage delta. */
  finishTurn(count = true): { totals: UsageTotals; usage?: TurnUsage } {
    const base = this.turnBase;
    if (!base) return { totals: this.snapshot() };
    this.turnBase = null;
    if (count) this.totals.turns += 1;
    const usage: TurnUsage = {};
    for (const field of USAGE_FIELDS) usage[field] = Math.max(0, this.totals[field] - base[field]);
    return { totals: this.snapshot(), usage };
  }
}
