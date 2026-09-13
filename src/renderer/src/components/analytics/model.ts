/**
 * View model for the analytics dashboard: the scoped slice of a summary (all time or a bounded
 * range), the chart series derived from it, and the display formatters the tabs share.
 */
import type { AnalyticsDayPoint, AnalyticsSummary, FileUsageRow, HarnessToolRow, ModelToolRow, ToolUsage, ToolUsageRow, UsageBucket, UsageCounters, UsageSessionRecord } from '../../../../shared/types';
import { addCounters, COUNTER_FIELDS, dimensionSeries, emptyCounters, fillDays, rollupDays, speedTps, totalTokens, type SliceDimension } from '../../../../shared/usage-rollup';
import { basename, fmtCost, fmtTokens } from '../../format';
import type { AnalyticsRange, AnalyticsTab } from '../../store';
import { harnessShort } from '../../format';

export const RANGES: { value: AnalyticsRange; label: string }[] = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 0, label: 'All time' }
];

export const TABS: { id: AnalyticsTab; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'chart' },
  { id: 'spend', label: 'Spend', icon: 'dollar' },
  { id: 'tokens', label: 'Tokens', icon: 'layers' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'tools', label: 'Tools & files', icon: 'wrench' },
  { id: 'sessions', label: 'Sessions', icon: 'list' }
];

/** The summary narrowed to the selected range; every tab reads from this so the numbers agree. */
export interface Scope {
  range: AnalyticsRange;
  allTime: boolean;
  /** 'all time' or 'last 30 days'. */
  label: string;
  /** 'previous 30 days'; absent for all time. */
  previousLabel?: string;
  days: AnalyticsDayPoint[];
  totals: UsageCounters;
  previous?: UsageCounters;
  byHarness: UsageBucket[];
  byModel: UsageBucket[];
  byProject: UsageBucket[];
  tools: ToolUsageRow[];
  toolTotals: ToolUsage;
  /** Per-tool call counts keyed by model, sorted by volume. */
  modelTools: ModelToolRow[];
  harnessTools: HarnessToolRow[];
  files: FileUsageRow[];
  /** Sessions active in range (all time: every recorded session), highest spend first. */
  sessions: UsageSessionRecord[];
  sessionCount: number;
  activeDays: number;
  /** Usage recorded before per-model tracking existed: counted in the totals but in no breakdown. */
  unattributed?: UsageCounters;
  /** Days in range whose breakdowns were estimated from session totals. */
  estimatedDays: number;
}

const DAY_MS = 86_400_000;

export function buildScope(summary: AnalyticsSummary, range: AnalyticsRange, now = Date.now()): Scope {
  // A continuous calendar: the last `range` days including today, or first recorded day to today.
  const recorded = summary.days;
  const start = range === 0 ? (recorded[0] ? Date.parse(`${recorded[0].date}T00:00:00Z`) : now) : now - (range - 1) * DAY_MS;
  const days = fillDays(recorded, Math.min(start, now), now);
  const activeDays = days.filter((d) => d.usage.costUsd > 0 || d.usage.turns > 0 || d.usage.toolCalls > 0).length;
  if (range === 0) {
    const totals = emptyCounters();
    for (const d of days) addCounters(totals, d.usage);
    // The all-time token, cost and turn totals also cover sessions whose deltas never reached a day bucket.
    for (const f of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'costUsd', 'turns'] as const) totals[f] = summary.totals[f];
    return {
      range,
      allTime: true,
      label: 'all time',
      days,
      totals,
      byHarness: summary.byHarness,
      byModel: summary.byModel,
      byProject: summary.byProject,
      tools: summary.tools,
      toolTotals: summary.toolTotals,
      modelTools: summary.modelTools,
      harnessTools: summary.harnessTools,
      files: summary.files,
      sessions: summary.sessions,
      sessionCount: summary.sessionCount,
      activeDays: summary.activeDays,
      estimatedDays: days.filter((d) => d.usage.by?.estimated).length
    };
  }
  const r = rollupDays(days);
  const cutoff = start;
  const ids = new Set(r.sessionIds);
  // Slices name the sessions that recorded usage; a session last touched inside the range was active too.
  const sessions = summary.sessions.filter((s) => ids.has(s.id) || s.updatedAt >= cutoff);
  return {
    range,
    allTime: false,
    label: `last ${range} days`,
    previousLabel: `previous ${range} days`,
    days,
    totals: r.totals,
    previous: summary.previous,
    byHarness: r.byHarness,
    byModel: r.byModel,
    byProject: r.byProject,
    tools: r.tools,
    toolTotals: r.toolTotals,
    modelTools: r.modelTools,
    harnessTools: r.harnessTools,
    files: r.files,
    sessions,
    sessionCount: sessions.length,
    activeDays,
    unattributed: COUNTER_FIELDS.some((f) => r.unattributed[f] > 0) ? r.unattributed : undefined,
    estimatedDays: r.estimatedDays
  };
}

export interface ChartSeries {
  key: string;
  label: string;
  /** One value per day in the scope; null is a gap (no sample), 0 is a measured zero. */
  values: (number | null)[];
  /** A CSS colour, normally a `var(--chart-n)` token so it follows the theme's light/dark base. */
  color: string;
}

export type Metric = 'cost' | 'tokens' | 'turns' | 'toolCalls' | 'duration';
export type Split = 'none' | SliceDimension;

export const SPLITS: { value: Split; label: string }[] = [
  { value: 'none', label: 'Total' },
  { value: 'harness', label: 'Harness' },
  { value: 'model', label: 'Model' },
  { value: 'project', label: 'Project' }
];

export interface MetricDef {
  label: string;
  of: (c: UsageCounters) => number;
  /** Full value for tooltips and tables. */
  fmt: (v: number) => string;
  /** Compact value for axis ticks. */
  axis: (v: number) => string;
}

export const METRICS: Record<Metric, MetricDef> = {
  cost: { label: 'Spend', of: (c) => c.costUsd, fmt: fmtCost, axis: fmtCostAxis },
  tokens: { label: 'Tokens', of: (c) => totalTokens(c), fmt: fmtTokens, axis: fmtTokens },
  turns: { label: 'Turns', of: (c) => c.turns, fmt: fmtCompact, axis: fmtCompact },
  toolCalls: { label: 'Tool calls', of: (c) => c.toolCalls, fmt: fmtCompact, axis: fmtCompact },
  duration: { label: 'Agent time', of: (c) => c.durationMs, fmt: fmtMs, axis: fmtMsAxis }
};

/** Fixed colour slot per harness, so a harness keeps its colour whichever others are on screen. */
export const HARNESS_ORDER = ['claude', 'codex', 'codex-exec', 'cursor', 'pi', 'acp', 'native'];

export function harnessColor(id: string): string {
  const i = HARNESS_ORDER.indexOf(id);
  return `var(--chart-${(i === -1 ? HARNESS_ORDER.length - 1 : i) + 1})`;
}

export const OTHER_COLOR = 'var(--chart-other)';
export const UNATTRIBUTED_COLOR = 'var(--chart-unattributed)';

/**
 * The entities of a dimension in colour-slot order: harnesses have a fixed slot each, models and
 * projects take the range's spend ranking. Every chart on the dashboard shares this order, so a
 * model is the same colour whether the chart shows spend, tokens or turns.
 */
export function slotOrder(scope: Scope, dim: SliceDimension): string[] {
  if (dim === 'harness') return HARNESS_ORDER;
  return (dim === 'model' ? scope.byModel : scope.byProject).map((b) => b.key).slice(0, 6);
}

function slotColor(order: string[], key: string, dim: SliceDimension): string {
  if (dim === 'harness') return harnessColor(key);
  return `var(--chart-${Math.max(0, order.indexOf(key)) + 1})`;
}

/**
 * Per-day series of a metric, either as one total or split across the entities of a dimension.
 * Models and projects keep the top five by spend as series and fold the rest into "Other". Days
 * from before per-model tracking show their remainder as "Unattributed".
 */
export function splitSeries(scope: Scope, split: Split, metric: Metric, topN = 5): ChartSeries[] {
  const m = METRICS[metric];
  if (split === 'none') return [{ key: 'total', label: m.label, values: scope.days.map((d) => m.of(d.usage)), color: 'var(--accent)' }];
  const order = slotOrder(scope, split);
  const ds = dimensionSeries(scope.days, split, m.of, split === 'harness' ? HARNESS_ORDER.length : topN, order, true);
  const out: ChartSeries[] = ds.series.map((s) => ({
    key: s.key,
    label: entityLabel(split, s.key, s.label),
    values: s.values,
    color: slotColor(order, s.key, split)
  }));
  if (ds.other) out.push({ key: '__other', label: 'Other', values: ds.other, color: OTHER_COLOR });
  if (ds.unattributed) out.push({ key: '__unattributed', label: 'Unattributed', values: ds.unattributed, color: UNATTRIBUTED_COLOR });
  return out;
}

/** Output speed (tok/s) per day, as one line or one per top entity; days without a sample are gaps. */
export function speedSeries(scope: Scope, split: Split, topN = 4): ChartSeries[] {
  if (split === 'none') return [{ key: 'total', label: 'Output speed', values: scope.days.map((d) => speedTps(d.usage)), color: 'var(--accent)' }];
  const order = slotOrder(scope, split);
  const ranked = dimensionSeries(scope.days, split, (c) => c.speedTokens, split === 'harness' ? HARNESS_ORDER.length : topN, order, true);
  return ranked.series.map((s) => ({
    key: s.key,
    label: entityLabel(split, s.key, s.label),
    values: scope.days.map((d) => speedTps(d.usage.by?.[split]?.[s.key])),
    color: slotColor(order, s.key, split)
  }));
}

export function entityLabel(dim: SliceDimension, key: string, label: string): string {
  if (dim === 'harness') return harnessShort(key);
  if (dim === 'project') return basename(label || key);
  return label || key;
}

export const TOKEN_KINDS = [
  { key: 'inputTokens', label: 'Input', color: 'var(--chart-1)' },
  { key: 'outputTokens', label: 'Output', color: 'var(--chart-2)' },
  { key: 'cacheReadTokens', label: 'Cache read', color: 'var(--chart-3)' },
  { key: 'cacheWriteTokens', label: 'Cache write', color: 'var(--chart-4)' }
] as const;

export function tokenKindSeries(days: AnalyticsDayPoint[]): ChartSeries[] {
  return TOKEN_KINDS.map((k) => ({ key: k.key, label: k.label, values: days.map((d) => d.usage[k.key]), color: k.color }));
}

/** Change kinds wear the app's diff colours, matching the Changes tab. */
export const FILE_KINDS = [
  { key: 'updates', label: 'Modified', color: 'var(--accent)' },
  { key: 'adds', label: 'Added', color: 'var(--green)' },
  { key: 'deletes', label: 'Deleted', color: 'var(--red)' },
  { key: 'renames', label: 'Renamed', color: 'var(--amber)' }
] as const;

export function cumulative(values: (number | null)[]): number[] {
  let acc = 0;
  return values.map((v) => (acc += v ?? 0));
}

/** Share of prompt tokens the provider served from cache; null while no prompt tokens were counted. */
export function cacheHitRate(c: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number | null {
  const prompt = c.inputTokens + c.cacheReadTokens + c.cacheWriteTokens;
  return prompt > 0 ? c.cacheReadTokens / prompt : null;
}

export interface Delta {
  pct: number;
  dir: 'up' | 'down' | 'flat';
  text: string;
}

/** Relative change against the previous period; undefined when there is nothing to compare with. */
export function delta(current: number, previous: number | undefined): Delta | undefined {
  if (previous === undefined || !(previous > 0)) return undefined;
  const pct = (current - previous) / previous;
  const dir = Math.abs(pct) < 0.005 ? 'flat' : pct > 0 ? 'up' : 'down';
  const digits = Math.abs(pct) < 0.1 ? 1 : 0;
  return { pct, dir, text: `${pct > 0 ? '+' : ''}${(pct * 100).toFixed(digits)}%` };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 'Sep 12' for a UTC day key. */
export function fmtDay(date: string): string {
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${MONTHS[m - 1] ?? '?'} ${d}`;
}

/** 'Fri, Sep 12 2026' for a UTC day key. */
export function fmtDayLong(date: string): string {
  const dt = new Date(`${date}T00:00:00Z`);
  const wd = Number.isNaN(dt.getTime()) ? '' : `${WEEKDAYS[dt.getUTCDay()]}, `;
  return `${wd}${fmtDay(date)} ${date.slice(0, 4)}`;
}

/** Compact counts for tiles and axes: 950, 1.4k, 12k, 2.50M. */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a < 1000) return Number.isInteger(n) ? String(n) : n.toFixed(1);
  if (a < 1_000_000) return `${(n / 1000).toFixed(a < 10_000 ? 1 : 0)}k`;
  if (a < 1_000_000_000) return `${(n / 1_000_000).toFixed(a < 10_000_000 ? 2 : 1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

/** Axis ticks for dollars: $0, $0.005, $0.50, $12, $1.2k. */
export function fmtCostAxis(v: number): string {
  if (!(v > 0)) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 0.1) return `$${v.toFixed(3)}`;
  if (v < 1) return `$${v.toFixed(2)}`;
  if (v < 1000) return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(v < 10 ? 2 : 1)}`;
  return `$${(v / 1000).toFixed(1)}k`;
}

export function fmtPct(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  const p = ratio * 100;
  if (p === 0) return '0%';
  if (p >= 10) return `${p.toFixed(0)}%`;
  if (p >= 1) return `${p.toFixed(1)}%`;
  return `${p.toFixed(2)}%`;
}

/** Wall time with hours: 350ms, 12.3s, 4m 5s, 3h 12m. */
export function fmtMs(ms: number): string {
  if (!(ms > 0)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s - m * 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m - h * 60}m`;
}

function fmtMsAxis(ms: number): string {
  if (!(ms > 0)) return '0';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(ms < 36_000_000 ? 1 : 0)}h`;
}

export function fmtTps(tps: number | null | undefined): string {
  if (tps === null || tps === undefined || !(tps > 0)) return '—';
  return `${tps >= 100 ? tps.toFixed(0) : tps.toFixed(1)} tok/s`;
}

/** Rates carry decimals so cheap models stay readable: $0.10 per M tokens must not round to $0. */
export function fmtUnit(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 4 : usd < 1 ? 3 : 2)}`;
}

export function plural(n: number, word: string): string {
  return `${fmtCompact(n)} ${word}${n === 1 ? '' : 's'}`;
}

export function sessionTokens(s: UsageSessionRecord): number {
  return totalTokens(s.usage);
}

export type SessionSort = 'cost' | 'tokens' | 'turns' | 'toolCalls' | 'duration' | 'speed' | 'recent';

export const SESSION_SORTS: { value: SessionSort; label: string }[] = [
  { value: 'cost', label: 'Spend' },
  { value: 'tokens', label: 'Tokens' },
  { value: 'turns', label: 'Turns' },
  { value: 'toolCalls', label: 'Tool calls' },
  { value: 'duration', label: 'Agent time' },
  { value: 'speed', label: 'Speed' },
  { value: 'recent', label: 'Last active' }
];

export function sortSessions(sessions: UsageSessionRecord[], sort: SessionSort): UsageSessionRecord[] {
  const key = (s: UsageSessionRecord): number => {
    switch (sort) {
      case 'cost':
        return s.usage.costUsd;
      case 'tokens':
        return sessionTokens(s);
      case 'turns':
        return s.usage.turns;
      case 'toolCalls':
        return s.toolCalls;
      case 'duration':
        return s.durationMs ?? 0;
      case 'speed':
        return speedTps(s.speed) ?? -1;
      default:
        return s.updatedAt;
    }
  };
  return [...sessions].sort((a, b) => key(b) - key(a) || b.updatedAt - a.updatedAt);
}

/** Case-insensitive match over the fields a user would search a session by. */
export function sessionMatches(s: UsageSessionRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [s.title, s.model ?? '', s.provider ?? '', s.projectRoot, harnessShort(s.harness)].some((v) => v.toLowerCase().includes(q));
}
