/**
 * Pure rollups over daily usage buckets, shared by the analytics store (main) and the dashboard
 * (renderer). Bounded date ranges are built here from each day's per-dimension slices; all-time
 * views keep using the session records, which also cover usage recorded before slices existed.
 */
import type {
  AnalyticsDayPoint,
  FileUsage,
  FileUsageRow,
  HarnessToolRow,
  ModelToolRow,
  ToolUsage,
  ToolUsageRow,
  UsageBucket,
  UsageCounters,
  UsageDayDimensions,
  UsageSlice,
  UsageSpeed
} from './types';

export const COUNTER_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'costUsd', 'turns', 'durationMs', 'toolCalls', 'speedTokens', 'speedMs'] as const;

export function emptyCounters(): UsageCounters {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0, durationMs: 0, toolCalls: 0, speedTokens: 0, speedMs: 0 };
}

/** Adds the positive numeric fields of `from` into `into`; anything else is ignored so old files load cleanly. */
export function addCounters(into: UsageCounters, from: Partial<UsageCounters>): void {
  for (const f of COUNTER_FIELDS) {
    const v = from[f];
    if (typeof v === 'number' && v > 0) into[f] += v;
  }
}

export function emptySlice(label: string): UsageSlice {
  return { ...emptyCounters(), label, sessions: [] };
}

export function emptyDimensions(): UsageDayDimensions {
  return { harness: {}, model: {}, project: {}, tool: {}, modelTool: {}, harnessTool: {}, file: {} };
}

export function emptyToolUsage(): ToolUsage {
  return { calls: 0, errors: 0, declined: 0, durationMs: 0 };
}

export function emptyFileUsage(): FileUsage {
  return { adds: 0, updates: 0, deletes: 0, renames: 0 };
}

export function addToolUsage(into: ToolUsage, from: ToolUsage): void {
  into.calls += from.calls;
  into.errors += from.errors;
  into.declined += from.declined;
  into.durationMs += from.durationMs;
}

/** Case-insensitive identity for harness tool names (`Bash` and `bash` are the same tool). */
export function toolNameKey(name: string): string {
  return name.toLowerCase();
}

function preferredToolName(current: string, candidate: string, key: string): string {
  if (candidate === key) return candidate;
  return current || candidate;
}

/** Combines differently-cased spellings while retaining a harness-supplied display name. */
export function toolUsageRows(tools: Record<string, ToolUsage>): ToolUsageRow[] {
  const grouped = new Map<string, ToolUsageRow>();
  for (const [name, usage] of Object.entries(tools)) {
    const key = toolNameKey(name);
    const row = grouped.get(key) ?? { name, ...emptyToolUsage() };
    row.name = preferredToolName(row.name, name, key);
    addToolUsage(row, usage);
    grouped.set(key, row);
  }
  return [...grouped.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

/** Builds per-model rows with case-insensitive tool identity and optional model display labels. */
export function modelToolUsageRows(modelTools: Record<string, Record<string, ToolUsage>>, modelLabels: ReadonlyMap<string, string> = new Map()): ModelToolRow[] {
  const toolLabels = new Map<string, string>();
  for (const perTool of Object.values(modelTools)) {
    for (const name of Object.keys(perTool)) {
      const nameKey = toolNameKey(name);
      toolLabels.set(nameKey, preferredToolName(toolLabels.get(nameKey) ?? '', name, nameKey));
    }
  }
  const rows: ModelToolRow[] = [];
  for (const [key, perTool] of Object.entries(modelTools)) {
    const grouped = new Map<string, ToolUsage>();
    for (const [name, usage] of Object.entries(perTool)) {
      const nameKey = toolNameKey(name);
      const target = grouped.get(nameKey) ?? emptyToolUsage();
      addToolUsage(target, usage);
      grouped.set(nameKey, target);
    }
    for (const [nameKey, usage] of grouped) rows.push({ key, label: modelLabels.get(key) || key.slice(key.indexOf('/') + 1), name: toolLabels.get(nameKey) || nameKey, ...usage });
  }
  return rows.sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key) || a.name.localeCompare(b.name));
}

/** Harness identities stay distinct; only tool-name casing is combined, never aliases. */
export function harnessToolUsageRows(harnessTools: Record<string, Record<string, ToolUsage>>): HarnessToolRow[] {
  return modelToolUsageRows(harnessTools, new Map(Object.keys(harnessTools).map((key) => [key, key])));
}

export function addFileUsage(into: FileUsage, from: FileUsage): void {
  into.adds += from.adds;
  into.updates += from.updates;
  into.deletes += from.deletes;
  into.renames += from.renames;
}

/** Input, output and cache tokens together; reasoning tokens are already inside the output count. */
export function totalTokens(u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

/** Adds `delta` to the slice for `key`, creating it on first sight, and remembers the session. */
export function addSlice(map: Record<string, UsageSlice>, key: string, label: string, delta: Partial<UsageCounters>, sessionId: string): void {
  const slice = (map[key] ??= emptySlice(label));
  slice.label = label;
  addCounters(slice, delta);
  if (!slice.sessions.includes(sessionId)) slice.sessions.push(sessionId);
}

export type SliceDimension = 'harness' | 'model' | 'project';

export interface RangeRollup {
  totals: UsageCounters;
  byHarness: UsageBucket[];
  byModel: UsageBucket[];
  byProject: UsageBucket[];
  tools: ToolUsageRow[];
  toolTotals: ToolUsage;
  /** Per-tool call counts keyed by model. */
  modelTools: ModelToolRow[];
  /** Live per-tool outcomes keyed by harness; legacy days contribute nothing. */
  harnessTools: HarnessToolRow[];
  files: FileUsageRow[];
  /** Distinct sessions that recorded usage on the days in range. */
  sessionIds: string[];
  /** Usage on days that predate per-dimension tracking: inside the totals, but in no bucket. */
  unattributed: UsageCounters;
  /** Days whose slices were estimated from session totals rather than recorded live. */
  estimatedDays: number;
}

function bucketsOf(days: AnalyticsDayPoint[], dim: SliceDimension): UsageBucket[] {
  const map = new Map<string, UsageBucket & { ids: Set<string> }>();
  for (const d of days) {
    const slices = d.usage.by?.[dim];
    if (!slices) continue;
    for (const [key, s] of Object.entries(slices)) {
      const b = map.get(key) ?? { key, label: s.label, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }, toolCalls: 0, durationMs: 0, sessions: 0, speed: { tokens: 0, ms: 0 }, ids: new Set<string>() };
      b.label = s.label || b.label;
      b.usage.inputTokens += s.inputTokens;
      b.usage.outputTokens += s.outputTokens;
      b.usage.cacheReadTokens += s.cacheReadTokens;
      b.usage.cacheWriteTokens += s.cacheWriteTokens;
      b.usage.reasoningTokens += s.reasoningTokens;
      b.usage.costUsd += s.costUsd;
      b.usage.turns += s.turns;
      b.toolCalls += s.toolCalls;
      b.durationMs += s.durationMs;
      b.speed.tokens += s.speedTokens;
      b.speed.ms += s.speedMs;
      for (const id of s.sessions) b.ids.add(id);
      map.set(key, b);
    }
  }
  return [...map.values()]
    .map(({ ids, ...b }) => ({ ...b, sessions: ids.size }))
    .sort((a, b) => b.usage.costUsd - a.usage.costUsd || b.usage.turns - a.usage.turns || a.label.localeCompare(b.label));
}

/** Rolls the days of a bounded range up into totals, per-dimension buckets and tool/file leaderboards. */
export function rollupDays(days: AnalyticsDayPoint[]): RangeRollup {
  const totals = emptyCounters();
  const attributed = emptyCounters();
  const ids = new Set<string>();
  const tools: Record<string, ToolUsage> = {};
  const modelTools: Record<string, Record<string, ToolUsage>> = {};
  const harnessTools: Record<string, Record<string, ToolUsage>> = {};
  const files: Record<string, FileUsage> = {};
  const modelToolLabels = new Map<string, string>();
  for (const d of days) {
    addCounters(totals, d.usage);
    const by = d.usage.by;
    if (!by) continue;
    // Every attributed record carries a harness, so the harness slices are the attributed whole.
    for (const s of Object.values(by.harness)) {
      addCounters(attributed, s);
      for (const id of s.sessions) ids.add(id);
    }
    for (const [name, t] of Object.entries(by.tool)) addToolUsage((tools[name] ??= emptyToolUsage()), t);
    for (const [key, s] of Object.entries(by.model)) if (s.label) modelToolLabels.set(key, s.label);
    for (const [key, perTool] of Object.entries(by.modelTool)) {
      for (const [name, t] of Object.entries(perTool)) addToolUsage(((modelTools[key] ??= {})[name] ??= emptyToolUsage()), t);
    }
    for (const [key, perTool] of Object.entries(by.harnessTool ?? {})) {
      for (const [name, t] of Object.entries(perTool)) addToolUsage(((harnessTools[key] ??= {})[name] ??= emptyToolUsage()), t);
    }
    for (const [p, f] of Object.entries(by.file)) addFileUsage((files[p] ??= emptyFileUsage()), f);
  }
  const unattributed = emptyCounters();
  for (const f of COUNTER_FIELDS) unattributed[f] = Math.max(0, totals[f] - attributed[f]);
  const estimatedDays = days.filter((d) => d.usage.by?.estimated).length;

  const toolRows = toolUsageRows(tools);
  const toolTotals = toolRows.reduce<ToolUsage>((acc, t) => {
    addToolUsage(acc, t);
    return acc;
  }, emptyToolUsage());
  toolTotals.calls = Math.max(toolTotals.calls, totals.toolCalls);
  const fileRows: FileUsageRow[] = Object.entries(files)
    .map(([path, f]) => ({ path, ...f, total: f.adds + f.updates + f.deletes + f.renames }))
    .filter((f) => f.total > 0)
    .sort((a, b) => b.total - a.total || a.path.localeCompare(b.path));

  const modelToolRows = modelToolUsageRows(modelTools, modelToolLabels);

  return {
    totals,
    byHarness: bucketsOf(days, 'harness'),
    byModel: bucketsOf(days, 'model'),
    byProject: bucketsOf(days, 'project'),
    tools: toolRows,
    toolTotals,
    modelTools: modelToolRows,
    harnessTools: harnessToolUsageRows(harnessTools),
    files: fileRows,
    sessionIds: [...ids],
    unattributed,
    estimatedDays
  };
}

export interface DimensionSeries {
  /** Top entities by the metric's total over the range, highest first; one series each. */
  series: { key: string; label: string; values: number[] }[];
  /** Per-day sum of every entity outside the top N; absent when nothing was folded. */
  other?: number[];
  /** Per-day remainder of the day total that no slice explains (legacy days); absent when zero everywhere. */
  unattributed?: number[];
}

/**
 * Splits a per-day metric across the entities of one dimension. Membership is decided over the
 * whole range, so the same entity keeps the same series for every day in the chart. With
 * `fixedOrder` the entities are ranked by that order instead of by the metric (so every chart of a
 * dashboard can agree on who is series one), and `onlyOrdered` folds anything outside it into Other.
 */
export function dimensionSeries(days: AnalyticsDayPoint[], dim: SliceDimension, metric: (c: UsageCounters) => number, topN: number, fixedOrder?: string[], onlyOrdered = false): DimensionSeries {
  const totals = new Map<string, { label: string; total: number }>();
  for (const d of days) {
    for (const [key, s] of Object.entries(d.usage.by?.[dim] ?? {})) {
      const t = totals.get(key) ?? { label: s.label, total: 0 };
      t.total += metric(s);
      t.label = s.label || t.label;
      totals.set(key, t);
    }
  }
  let ranked = [...totals.entries()].filter(([, t]) => t.total > 0).sort((a, b) => b[1].total - a[1].total || a[1].label.localeCompare(b[1].label));
  if (fixedOrder) {
    if (onlyOrdered) ranked = ranked.filter(([key]) => fixedOrder.includes(key));
    ranked = ranked.sort((a, b) => indexOf(fixedOrder, a[0]) - indexOf(fixedOrder, b[0]));
  }
  const top = ranked.slice(0, topN);
  const topKeys = new Set(top.map(([k]) => k));
  const series = top.map(([key, t]) => ({ key, label: t.label, values: days.map((d) => metric(d.usage.by?.[dim]?.[key] ?? emptyCounters())) }));
  const other = days.map((d) => Object.entries(d.usage.by?.[dim] ?? {}).reduce((acc, [k, s]) => (topKeys.has(k) ? acc : acc + metric(s)), 0));
  const unattributed = days.map((d) => {
    const explained = Object.values(d.usage.by?.[dim] ?? {}).reduce((acc, s) => acc + metric(s), 0);
    return Math.max(0, metric(d.usage) - explained);
  });
  return {
    series,
    other: other.some((v) => v > 0) ? other : undefined,
    unattributed: unattributed.some((v) => v > 0) ? unattributed : undefined
  };
}

function indexOf(order: string[], key: string): number {
  const i = order.indexOf(key);
  return i === -1 ? order.length : i;
}

const DAY_MS = 86_400_000;

/** UTC calendar day for a timestamp, e.g. '2025-06-07'. */
export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Every UTC day from `startTs` to `endTs` inclusive, with empty counters where nothing was recorded,
 * so day charts are real calendars rather than a list of active days. Days outside the window are
 * dropped; the span is capped at two years.
 */
export function fillDays(days: AnalyticsDayPoint[], startTs: number, endTs: number): AnalyticsDayPoint[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const out: AnalyticsDayPoint[] = [];
  const start = Date.parse(`${utcDay(startTs)}T00:00:00Z`);
  const end = Date.parse(`${utcDay(endTs)}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return days;
  for (let t = start, i = 0; t <= end && i < 731; t += DAY_MS, i++) {
    const date = utcDay(t);
    out.push(byDate.get(date) ?? { date, usage: emptyCounters() });
  }
  return out;
}

/** Tokens per second for a paired sample, or null when nothing was sampled. */
export function speedTps(speed: UsageSpeed | { speedTokens: number; speedMs: number } | undefined): number | null {
  if (!speed) return null;
  const tokens = 'tokens' in speed ? speed.tokens : speed.speedTokens;
  const ms = 'ms' in speed ? speed.ms : speed.speedMs;
  if (tokens <= 0 || ms <= 0) return null;
  return (tokens / ms) * 1000;
}
