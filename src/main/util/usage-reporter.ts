import type { SessionEvent, SubagentCost, UsageTotals } from '../../shared/types';

/** Keep live usage broadcasts useful without pushing a full session list for every token delta. */
export const USAGE_REPORT_INTERVAL_MS = 1_000;

type UsageEvent = Extract<SessionEvent, { type: 'usage' }>;
type PendingUsage = Omit<UsageEvent, 'type'>;

const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'costUsd', 'turns', 'contextWindow', 'contextTokens'] as const;

function sameTotals(a: UsageTotals, b: UsageTotals): boolean {
  return USAGE_FIELDS.every((field) => a[field] === b[field]);
}

function cloneCosts(costs: SubagentCost[] | undefined): SubagentCost[] | undefined {
  return costs?.map((cost) => ({ ...cost }));
}

/** Coalesces live snapshots and emits at most one usage event per interval. */
export class UsageReporter {
  private pending: PendingUsage | null = null;
  private reported: UsageTotals | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastReportedAt = 0;
  private closed = false;

  constructor(
    private readonly emit: (event: UsageEvent) => void,
    private readonly intervalMs = USAGE_REPORT_INTERVAL_MS
  ) {}

  report(totals: UsageTotals, subagentCostByModel?: SubagentCost[]): void {
    if (this.closed) return;
    const costs = cloneCosts(subagentCostByModel);
    if (this.reported && sameTotals(this.reported, totals) && !costs?.length) return;
    this.pending = { totals: { ...totals }, ...(costs?.length ? { subagentCostByModel: costs } : {}) };
    if (!this.reported) {
      this.flush();
      return;
    }
    if (this.timer) return;
    const delay = Math.max(0, this.intervalMs - (Date.now() - this.lastReportedAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delay);
    this.timer.unref?.();
  }

  /** Emits the newest snapshot immediately, normally at turn completion or shutdown. */
  flush(): void {
    if (!this.pending) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const pending = this.pending;
    this.pending = null;
    if (this.reported && sameTotals(this.reported, pending.totals) && !pending.subagentCostByModel?.length) return;
    this.reported = { ...pending.totals };
    this.lastReportedAt = Date.now();
    this.emit({ type: 'usage', ...pending });
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}
