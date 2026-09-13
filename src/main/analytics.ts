/** Collects usage data into daily buckets and per-session records, powering the analytics dashboard. */
import path from 'node:path';
import type {
  AnalyticsDayPoint,
  AnalyticsSummary,
  FileUsage,
  FileUsageRow,
  ModelRateRow,
  ModelRef,
  ModelToolRow,
  SessionMeta,
  ToolUsage,
  ToolUsageRow,
  TranscriptItem,
  UsageBucket,
  UsageCounters,
  UsageDay,
  UsageSessionRecord,
  UsageSpeed,
  UsageTotals
} from '../shared/types';
import { addCounters, addFileUsage, addSlice, addToolUsage, COUNTER_FIELDS, emptyCounters, emptyDimensions, emptyFileUsage, emptyToolUsage, modelToolUsageRows, toolNameKey, toolUsageRows, totalTokens } from '../shared/usage-rollup';
import { readJson, writeJson } from './util/fs';

export { emptyFileUsage, emptyToolUsage };

interface AnalyticsFile {
  version: 1;
  /** UTC day -> aggregated usage. */
  days: Record<string, UsageDay>;
  /** Last recorded cumulative totals per session, for delta computation. */
  recorded: Record<string, UsageTotals>;
  /** Last known session snapshot; kept after deletion so history survives. */
  sessions: Record<string, UsageSessionRecord>;
  /** Completed tool calls per tool name. */
  tools: Record<string, ToolUsage>;
  /** Completed tool calls per tool name, keyed by model (`provider/model`). */
  modelTools: Record<string, Record<string, ToolUsage>>;
  /** File-change counts per path, aggregated from tool results. */
  files: Record<string, FileUsage>;
}

const EMPTY_FILE: AnalyticsFile = { version: 1, days: {}, recorded: {}, sessions: {}, tools: {}, modelTools: {}, files: {} };

const EMPTY_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

export function emptyDay(): UsageDay {
  return emptyCounters();
}

export function emptySpeed(): UsageSpeed {
  return { tokens: 0, ms: 0 };
}

/**
 * Output speed sample of one finished turn: its output tokens paired with its wall time. Turns
 * missing either (ACP agents report no tokens; interrupted turns are cut short) contribute nothing,
 * so averages are only ever built from complete pairs.
 */
export function turnSpeed(turn: Extract<TranscriptItem, { kind: 'turn' }>): UsageSpeed | null {
  if (turn.status !== 'completed') return null;
  const tokens = turn.usage?.outputTokens ?? 0;
  const ms = turn.durationMs ?? 0;
  if (tokens <= 0 || ms <= 0) return null;
  return { tokens, ms };
}

/** Tokens per second for a speed sample, or null when nothing was sampled. */
export function tokensPerSecond(speed: UsageSpeed | undefined): number | null {
  if (!speed || speed.ms <= 0 || speed.tokens <= 0) return null;
  return (speed.tokens / speed.ms) * 1000;
}

function addSpeed(into: UsageSpeed, from: UsageSpeed | undefined): void {
  if (!from) return;
  into.tokens += from.tokens;
  into.ms += from.ms;
}

/** UTC calendar day for a timestamp, e.g. '2025-06-07'. */
export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Adds `delta` into `day` in place; unknown fields are ignored so old files load cleanly. */
export function addDay(day: UsageDay, delta: Partial<UsageDay>): void {
  addCounters(day, delta);
}

/**
 * Delta between two cumulative totals, clamped at zero: a harness that resets its counters
 * (resume, compaction) must never subtract from already-recorded history.
 */
export function usageDelta(prev: UsageTotals, next: UsageTotals): Partial<UsageDay> {
  const d: Partial<UsageDay> = {};
  for (const f of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'costUsd', 'turns'] as const) {
    d[f] = Math.max(0, (next[f] ?? 0) - (prev[f] ?? 0));
  }
  return d;
}

export function addTotals(into: UsageTotals, from: UsageTotals): void {
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.cacheWriteTokens += from.cacheWriteTokens;
  into.reasoningTokens += from.reasoningTokens;
  into.costUsd += from.costUsd;
  into.turns += from.turns;
}

/** The three attribution dimensions of a usage record; sessions carry all of them. */
interface Attribution {
  id: string;
  harness: string;
  provider?: string;
  model?: string;
  projectRoot: string;
}

function attributionOf(meta: SessionMeta): Attribution {
  return { id: meta.id, harness: meta.config.harness, provider: meta.activeModel?.provider, model: meta.activeModel?.model, projectRoot: meta.config.projectRoot };
}

/** Adds `delta` to the day's harness, model and project slices for the session that produced it. */
export function attribute(day: UsageDay, who: Attribution, delta: Partial<UsageCounters>): void {
  const by = (day.by ??= emptyDimensions());
  addSlice(by.harness, who.harness, who.harness, delta, who.id);
  if (who.model) addSlice(by.model, `${who.provider ?? ''}/${who.model}`, who.model, delta, who.id);
  addSlice(by.project, who.projectRoot, who.projectRoot, delta, who.id);
}

/**
 * Splits `total` across `weights` proportionally. Integer splits use largest-remainder rounding so
 * the parts add up to the total exactly; all-zero weights fall back to an even split.
 */
export function apportion(total: number, weights: number[], integer: boolean): number[] {
  if (weights.length === 0 || !(total > 0)) return weights.map(() => 0);
  const sum = weights.reduce((a, w) => a + Math.max(0, w), 0);
  const w = sum > 0 ? weights.map((x) => Math.max(0, x) / sum) : weights.map(() => 1 / weights.length);
  if (!integer) return w.map((x) => total * x);
  const raw = w.map((x) => total * x);
  const parts = raw.map(Math.floor);
  let left = Math.round(total) - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0 && k < order.length; k++, left--) parts[order[k][1]] += 1;
  return parts;
}

const INTEGER_FIELDS = new Set<keyof UsageCounters>(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'turns', 'toolCalls']);

/** Each session's own total of a counter, the weight used to share a legacy day's total between them. */
function sessionWeight(s: UsageSessionRecord, f: keyof UsageCounters): number {
  switch (f) {
    case 'toolCalls':
      return s.toolCalls;
    case 'speedTokens':
      return s.speed?.tokens ?? 0;
    case 'speedMs':
      return s.speed?.ms ?? 0;
    case 'durationMs':
      return s.durationMs ?? 0;
    default:
      return s.usage[f];
  }
}

/**
 * Estimates the slices of a day recorded before slice tracking from the sessions last active that
 * day: every counter is shared between them in proportion to their own totals of it (falling back
 * to spend, then an even split). The original backfill put a whole session on its last active day,
 * so for sessions that lived within one day this reproduces exactly what live tracking would have.
 */
export function estimateDaySlices(day: UsageDay, sessions: UsageSessionRecord[]): boolean {
  const active = sessions.filter((s) => s.usage.costUsd > 0 || s.usage.turns > 0 || s.toolCalls > 0 || totalTokens(s.usage) > 0);
  if (day.by || active.length === 0) return false;
  const shares: Partial<UsageCounters>[] = active.map(() => ({}));
  for (const f of COUNTER_FIELDS) {
    if (!(day[f] > 0)) continue;
    let weights = active.map((s) => sessionWeight(s, f));
    if (!weights.some((w) => w > 0)) weights = active.map((s) => s.usage.costUsd);
    apportion(day[f], weights, INTEGER_FIELDS.has(f)).forEach((v, i) => (shares[i][f] = v));
  }
  day.by = { ...emptyDimensions(), estimated: true };
  active.forEach((s, i) => attribute(day, { id: s.id, harness: s.harness, provider: s.provider, model: s.model, projectRoot: s.projectRoot }, shares[i]));
  return true;
}

function snapshotSession(meta: SessionMeta, prev?: UsageSessionRecord): UsageSessionRecord {
  return {
    id: meta.id,
    title: meta.title,
    harness: meta.config.harness,
    provider: meta.activeModel?.provider,
    model: meta.activeModel?.model,
    projectRoot: meta.config.projectRoot,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    usage: { ...meta.usage },
    toolCalls: prev?.toolCalls ?? 0,
    durationMs: prev?.durationMs ?? 0,
    speed: prev?.speed ? { ...prev.speed } : emptySpeed()
  };
}

/** Collapses a tool transcript item into a single call record; running items yield nothing yet. */
export function toolCallFromItem(item: Extract<TranscriptItem, { kind: 'tool' }>): { usage: ToolUsage; changes: Record<string, FileUsage> } | null {
  if (item.status === 'running') return null;
  const usage: ToolUsage = { calls: 1, errors: item.status === 'error' ? 1 : 0, declined: item.status === 'declined' ? 1 : 0, durationMs: Math.max(0, item.durationMs ?? 0) };
  const changes: Record<string, FileUsage> = {};
  for (const c of item.changes ?? []) {
    const f = (changes[c.path] ??= emptyFileUsage());
    if (c.kind === 'add') f.adds += 1;
    else if (c.kind === 'update') f.updates += 1;
    else if (c.kind === 'delete') f.deletes += 1;
    else if (c.kind === 'rename') f.renames += 1;
  }
  return { usage, changes };
}

export function summarize(sessions: UsageSessionRecord[], dayMap: Record<string, UsageDay>, tools: Record<string, ToolUsage>, modelTools: Record<string, Record<string, ToolUsage>>, files: Record<string, FileUsage>, dayLimit: number, now: number): AnalyticsSummary {
  const seed = (): UsageTotals => ({ ...EMPTY_USAGE });
  const sessionTotals = sessions.reduce<UsageTotals>((acc, s) => {
    addTotals(acc, s.usage);
    return acc;
  }, seed());
  const dayTotals = Object.values(dayMap).reduce<UsageTotals>((acc, d) => {
    addTotals(acc, d);
    return acc;
  }, seed());
  // Day buckets never subtract (counter resets are clamped), while session records always carry the
  // latest cumulative totals; the larger of the two is the best estimate of all-time usage.
  const totals = {
    inputTokens: Math.max(sessionTotals.inputTokens, dayTotals.inputTokens),
    outputTokens: Math.max(sessionTotals.outputTokens, dayTotals.outputTokens),
    cacheReadTokens: Math.max(sessionTotals.cacheReadTokens, dayTotals.cacheReadTokens),
    cacheWriteTokens: Math.max(sessionTotals.cacheWriteTokens, dayTotals.cacheWriteTokens),
    reasoningTokens: Math.max(sessionTotals.reasoningTokens, dayTotals.reasoningTokens),
    costUsd: Math.max(sessionTotals.costUsd, dayTotals.costUsd),
    turns: Math.max(sessionTotals.turns, dayTotals.turns)
  };

  // The range is the last `dayLimit` calendar days including today: the days after the cutoff day.
  const cutoff = dayLimit > 0 ? dayKey(now - dayLimit * 86_400_000) : '';
  const days: AnalyticsDayPoint[] = Object.entries(dayMap)
    .filter(([date]) => !cutoff || date > cutoff)
    .map(([date, usage]) => ({ date, usage }))
    .sort((a, b) => a.date.localeCompare(b.date));
  // The window of equal length just before the range, so the dashboard can show period-over-period deltas.
  let previous: UsageCounters | undefined;
  if (dayLimit > 0) {
    const prevCutoff = dayKey(now - 2 * dayLimit * 86_400_000);
    previous = emptyCounters();
    for (const [date, usage] of Object.entries(dayMap)) if (date > prevCutoff && date <= cutoff) addCounters(previous, usage);
  }

  const rollup = (key: (s: UsageSessionRecord) => { key: string; label: string } | null): UsageBucket[] => {
    const map = new Map<string, UsageBucket>();
    for (const s of sessions) {
      const k = key(s);
      if (!k) continue;
      const b = map.get(k.key) ?? { key: k.key, label: k.label, usage: { ...EMPTY_USAGE }, toolCalls: 0, durationMs: 0, sessions: 0, speed: emptySpeed() };
      addTotals(b.usage, s.usage);
      b.toolCalls += s.toolCalls;
      b.durationMs += s.durationMs ?? 0;
      addSpeed(b.speed, s.speed);
      b.sessions += 1;
      map.set(k.key, b);
    }
    return [...map.values()].sort((a, b) => b.usage.costUsd - a.usage.costUsd || b.usage.turns - a.usage.turns);
  };

  const byHarness = rollup((s) => ({ key: s.harness, label: s.harness }));
  const byModel = rollup((s) => (s.model ? { key: `${s.provider ?? ''}/${s.model}`, label: s.model } : null));
  const byProject = rollup((s) => ({ key: s.projectRoot, label: s.projectRoot }));
  // Effective rates per model: blended $/M tokens across input, output and cache, and $/call where
  // one call is one model turn. Rates stay undefined while the denominator was never measured.
  const modelRates: ModelRateRow[] = byModel.map((b) => {
    const tokens = b.usage.inputTokens + b.usage.outputTokens + b.usage.cacheReadTokens + b.usage.cacheWriteTokens;
    return {
      key: b.key,
      label: b.label,
      usdPerMTok: tokens > 0 ? (b.usage.costUsd / tokens) * 1_000_000 : undefined,
      usdPerCall: b.usage.turns > 0 ? b.usage.costUsd / b.usage.turns : undefined,
      costUsd: b.usage.costUsd,
      tokens,
      calls: b.usage.turns
    };
  });

  const toolRows: ToolUsageRow[] = toolUsageRows(tools);
  const modelToolRows: ModelToolRow[] = modelToolUsageRows(modelTools);
  const toolTotals: ToolUsage = Object.values(tools).reduce<ToolUsage>((acc, t) => {
    addToolUsage(acc, t);
    return acc;
  }, emptyToolUsage());
  // Day buckets also count calls; keep all-time call totals consistent with the other totals.
  const dayToolCalls = Object.values(dayMap).reduce((acc, d) => acc + d.toolCalls, 0);
  const sessionToolCalls = sessions.reduce((acc, s) => acc + s.toolCalls, 0);
  toolTotals.calls = Math.max(toolTotals.calls, dayToolCalls, sessionToolCalls);

  const fileRows: FileUsageRow[] = Object.entries(files)
    .map(([path, f]) => ({ path, ...f, total: f.adds + f.updates + f.deletes + f.renames }))
    .filter((f) => f.total > 0)
    .sort((a, b) => b.total - a.total || a.path.localeCompare(b.path));

  const sortedSessions = [...sessions].sort((a, b) => b.usage.costUsd - a.usage.costUsd || b.usage.turns - a.usage.turns || b.updatedAt - a.updatedAt);
  const dayList = Object.keys(dayMap).sort();
  // Speed samples are add-only in both places; day buckets also cover sessions recorded before
  // per-session speed existed, so they are the all-time source.
  const speed = Object.values(dayMap).reduce<UsageSpeed>((acc, d) => {
    addSpeed(acc, { tokens: d.speedTokens, ms: d.speedMs });
    return acc;
  }, emptySpeed());

  return {
    totals,
    speed,
    days,
    previous,
    byHarness,
    byModel,
    byProject,
    modelRates,
    toolTotals,
    tools: toolRows,
    modelTools: modelToolRows,
    files: fileRows,
    sessions: sortedSessions,
    sessionCount: sessions.length,
    activeDays: dayList.length,
    firstDay: dayList[0]
  };
}

export interface AnalyticsDeps {
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

/** Reads back a session's transcript so sessions predating the store can be backfilled. */
export type TranscriptReader = (sessionId: string) => Promise<TranscriptItem[]>;

export class AnalyticsStore {
  private data: AnalyticsFile = { ...EMPTY_FILE, days: {}, recorded: {}, sessions: {}, tools: {}, modelTools: {}, files: {} };
  private readonly file: string;
  private writeTimer: NodeJS.Timeout | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  /** Tool item ids already counted, so repeated upserts of one call never double-record. */
  private recordedTools = new Set<string>();

  constructor(userData: string, private readonly deps: AnalyticsDeps) {
    this.file = path.join(userData, 'analytics.json');
  }

  /**
   * Loads the store and backfills sessions that predate it: usage totals are attributed to each
   * session's last active day, and per-tool/per-file stats are rebuilt from its transcript.
   */
  async load(existing: SessionMeta[], readTranscript?: (id: string) => Promise<TranscriptItem[]>): Promise<void> {
    const stored = await readJson<Partial<AnalyticsFile> | undefined>(this.file, undefined, { log: this.deps.log });
    this.data = {
      version: 1,
      days: stored?.days && typeof stored.days === 'object' ? stored.days : {},
      recorded: stored?.recorded && typeof stored.recorded === 'object' ? stored.recorded : {},
      sessions: stored?.sessions && typeof stored.sessions === 'object' ? stored.sessions : {},
      tools: stored?.tools && typeof stored.tools === 'object' ? stored.tools : {},
      modelTools: stored?.modelTools && typeof stored.modelTools === 'object' ? stored.modelTools : {},
      files: stored?.files && typeof stored.files === 'object' ? stored.files : {}
    };
    // Fields added after a file was written (speed samples, dimension slices) load as zero rather than NaN.
    for (const day of Object.values(this.data.days)) {
      for (const f of COUNTER_FIELDS) if (typeof day[f] !== 'number') day[f] = 0;
      if (day.by !== undefined && (typeof day.by !== 'object' || day.by === null)) delete day.by;
      if (day.by) for (const dim of ['harness', 'model', 'project', 'tool', 'modelTool', 'file'] as const) if (typeof day.by[dim] !== 'object' || day.by[dim] === null) day.by[dim] = {};
    }
    const estimated = this.estimateLegacyDays();
    if (estimated) this.deps.log('info', `analytics: estimated per-model slices for ${estimated} day(s) recorded before slice tracking`);
    let backfilled = 0;
    for (const meta of existing) {
      if (this.data.recorded[meta.id]) {
        // Still refresh the snapshot: the title/model may have changed since the last write.
        this.data.sessions[meta.id] = snapshotSession(meta, this.data.sessions[meta.id]);
        continue;
      }
      this.data.recorded[meta.id] = { ...meta.usage };
      this.data.sessions[meta.id] = snapshotSession(meta);
      if (meta.usage.costUsd > 0 || meta.usage.turns > 0) {
        const day = this.dayFor(dayKey(meta.updatedAt));
        const delta = usageDelta({ ...EMPTY_USAGE }, meta.usage);
        addDay(day, delta);
        attribute(day, attributionOf(meta), delta);
        backfilled++;
      }
      if (readTranscript) await this.backfillTranscript(meta.id, meta.updatedAt, readTranscript);
    }
    if (backfilled) this.deps.log('info', `analytics: backfilled ${backfilled} existing session(s)`);
    await this.flush();
  }

  /**
   * One-time reconstruction of days written before slice tracking (see estimateDaySlices), using
   * only the sessions already in the file. Their per-tool and per-file counts are the all-time maps
   * minus whatever later days recorded live, shared between the legacy days by call volume. Runs
   * before the session backfill, so newly seen sessions are attributed exactly on top.
   */
  private estimateLegacyDays(): number {
    const legacy = Object.entries(this.data.days).filter(([, d]) => !d.by);
    if (legacy.length === 0) return 0;
    const byDay = new Map<string, UsageSessionRecord[]>();
    for (const s of Object.values(this.data.sessions)) {
      const key = dayKey(s.updatedAt);
      byDay.set(key, [...(byDay.get(key) ?? []), s]);
    }
    const estimated = legacy.filter(([date, day]) => estimateDaySlices(day, byDay.get(date) ?? [])).map(([, day]) => day);
    const weights = estimated.map((d) => d.toolCalls);
    if (estimated.length > 0 && weights.some((w) => w > 0)) {
      const knownTools: Record<string, ToolUsage> = {};
      const knownFiles: Record<string, FileUsage> = {};
      for (const d of Object.values(this.data.days)) {
        if (!d.by || d.by.estimated) continue;
        for (const [name, t] of Object.entries(d.by.tool)) addToolUsage((knownTools[toolNameKey(name)] ??= emptyToolUsage()), t);
        for (const [p, f] of Object.entries(d.by.file)) addFileUsage((knownFiles[p] ??= emptyFileUsage()), f);
      }
      for (const t of toolUsageRows(this.data.tools)) {
        const name = t.name;
        const k = knownTools[toolNameKey(name)] ?? emptyToolUsage();
        const parts = (['calls', 'errors', 'declined', 'durationMs'] as const).map((f) => apportion(Math.max(0, t[f] - k[f]), weights, f !== 'durationMs'));
        estimated.forEach((d, i) => {
          const share: ToolUsage = { calls: parts[0][i], errors: parts[1][i], declined: parts[2][i], durationMs: parts[3][i] };
          if (share.calls > 0 || share.errors > 0 || share.declined > 0) d.by!.tool[name] = share;
        });
      }
      for (const [p, f] of Object.entries(this.data.files)) {
        const k = knownFiles[p] ?? emptyFileUsage();
        const parts = (['adds', 'updates', 'deletes', 'renames'] as const).map((field) => apportion(Math.max(0, f[field] - k[field]), weights, true));
        estimated.forEach((d, i) => {
          const share: FileUsage = { adds: parts[0][i], updates: parts[1][i], deletes: parts[2][i], renames: parts[3][i] };
          if (share.adds + share.updates + share.deletes + share.renames > 0) d.by!.file[p] = share;
        });
      }
    }
    return estimated.length;
  }

  /** Aggregates completed tool calls from an old transcript into the store, one-time per session. */
  private async backfillTranscript(sessionId: string, dayTs: number, readTranscript: (id: string) => Promise<TranscriptItem[]>): Promise<void> {
    let items: TranscriptItem[];
    try {
      items = await readTranscript(sessionId);
    } catch {
      return;
    }
    let calls = 0;
    let durationMs = 0;
    for (const item of items) {
      if (item.kind === 'turn' && item.status === 'completed') {
        durationMs += Math.max(0, item.durationMs ?? 0);
        continue;
      }
      if (item.kind !== 'tool' || item.status === 'running') continue;
      this.recordToolCall(sessionId, item, dayTs);
      calls++;
    }
    if (durationMs > 0) {
      const session = this.data.sessions[sessionId];
      if (session) session.durationMs = (session.durationMs ?? 0) + durationMs;
    }
    if (calls) this.deps.log('debug', `analytics: backfilled ${calls} tool call(s) from ${sessionId}`);
  }

  /** Records cumulative usage totals from the harness, adding the delta to today's bucket. */
  recordUsage(meta: SessionMeta, totals: UsageTotals, now = Date.now()): void {
    const prev = this.data.recorded[meta.id];
    const delta = usageDelta(prev ?? { ...EMPTY_USAGE }, totals);
    this.data.recorded[meta.id] = { ...totals };
    this.data.sessions[meta.id] = snapshotSession(meta, this.data.sessions[meta.id]);
    const day = this.dayFor(dayKey(now));
    addDay(day, delta);
    attribute(day, attributionOf(meta), delta);
    this.scheduleWrite();
  }

  /**
   * Records a completed turn's wall time and, when the turn also reported output tokens, its
   * output-speed sample (turn counts come through the usage deltas).
   */
  recordTurn(meta: SessionMeta, turn: Extract<TranscriptItem, { kind: 'turn' }>, now = Date.now()): void {
    if (turn.status !== 'completed') return;
    const durationMs = turn.durationMs ?? 0;
    const speed = turnSpeed(turn);
    if (durationMs <= 0 && !speed) return;
    const day = this.dayFor(dayKey(now));
    const delta = { durationMs, speedTokens: speed?.tokens, speedMs: speed?.ms };
    addDay(day, delta);
    attribute(day, attributionOf(meta), delta);
    const session = (this.data.sessions[meta.id] ??= snapshotSession(meta));
    session.durationMs = (session.durationMs ?? 0) + durationMs;
    if (speed) {
      addSpeed((session.speed ??= emptySpeed()), speed);
    }
    this.scheduleWrite();
  }

  /** Records one completed tool call: per-tool counts, per-file changes and today's call volume. */
  recordToolCall(sessionId: string, item: Extract<TranscriptItem, { kind: 'tool' }>, now = Date.now(), activeModel?: ModelRef): void {
    const parsed = toolCallFromItem(item);
    if (!parsed) return;
    const key = `${sessionId}:${item.id}`;
    if (this.recordedTools.has(key)) return;
    this.recordedTools.add(key);
    const tool = (this.data.tools[item.name] ??= emptyToolUsage());
    addToolUsage(tool, parsed.usage);
    for (const [p, u] of Object.entries(parsed.changes)) {
      addFileUsage((this.data.files[p] ??= emptyFileUsage()), u);
    }
    const session = this.data.sessions[sessionId];
    if (session) session.toolCalls += 1;
    const day = this.dayFor(dayKey(now));
    addDay(day, { toolCalls: 1 });
    const by = (day.by ??= emptyDimensions());
    addToolUsage((by.tool[item.name] ??= emptyToolUsage()), parsed.usage);
    // Prefer the model captured when the call began; transcript backfills fall back to the session snapshot.
    const provider = activeModel?.provider ?? session?.provider;
    const model = activeModel?.model ?? session?.model;
    const modelKey = model ? `${provider ?? ''}/${model}` : undefined;
    if (modelKey) {
      addToolUsage(((this.data.modelTools[modelKey] ??= {})[item.name] ??= emptyToolUsage()), parsed.usage);
      addToolUsage(((by.modelTool[modelKey] ??= {})[item.name] ??= emptyToolUsage()), parsed.usage);
    }
    for (const [p, u] of Object.entries(parsed.changes)) addFileUsage((by.file[p] ??= emptyFileUsage()), u);
    if (session) attribute(day, { id: session.id, harness: session.harness, provider, model, projectRoot: session.projectRoot }, { toolCalls: 1 });
    this.scheduleWrite();
  }

  /** Upserts the session snapshot without touching usage (creation, rename, model switch). */
  touchSession(meta: SessionMeta): void {
    this.data.sessions[meta.id] = snapshotSession(meta, this.data.sessions[meta.id]);
    this.scheduleWrite();
  }

  private dayFor(date: string): UsageDay {
    return (this.data.days[date] ??= emptyDay());
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, 500);
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.writeQueue = this.writeQueue.then(() => writeJson(this.file, this.data)).catch((e) => this.deps.log('warn', `analytics write failed: ${String(e)}`));
    return this.writeQueue;
  }

  /** Summary over the last `dayLimit` days (0 = all time), with the preceding window for comparison. */
  summary(dayLimit = 30, now = Date.now()): AnalyticsSummary {
    const sessions = Object.values(this.data.sessions);
    return summarize(sessions, this.data.days, this.data.tools, this.data.modelTools, this.data.files, dayLimit, now);
  }
}
