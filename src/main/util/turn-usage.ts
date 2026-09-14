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
  /** Per-request samples added since the last cumulative snapshot, awaiting reconciliation. */
  private pendingAdditions: SourceTotals = {};
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
      if (typeof value === 'number' && Number.isFinite(value)) {
        this.totals[field] += value;
        this.pendingAdditions[field] = (this.pendingAdditions[field] ?? 0) + value;
      }
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
      const pending = this.pendingAdditions[field] ?? 0;
      if (previous === undefined) {
        // The app total may include an earlier provider process. Do not subtract it when the
        // first sample belongs to a freshly-reset provider counter. A live per-request sample may
        // already be included in the app total, so only replace it when the cumulative value is
        // greater than what we have.
        if (value > this.totals[field]) this.totals[field] = value;
      } else if (value >= previous) {
        // Live per-request samples are provisional until a provider cumulative snapshot arrives.
        // Reconcile against the total before those samples, otherwise the same tokens are counted
        // once when streamed and again when the final session counter is observed.
        const base = Math.max(0, this.totals[field] - pending);
        this.totals[field] = Math.max(this.totals[field], base + value - previous);
      }
      // A decrease is a reset (or an out-of-order sample): keep totals monotonic and rebase.
      this.sourceTotals[field] = value;
      this.pendingAdditions[field] = 0;
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
    this.pendingAdditions = {};
    return { totals: this.snapshot(), usage };
  }
}
