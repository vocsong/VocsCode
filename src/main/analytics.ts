/** Collects usage data into daily buckets and per-session records, powering the analytics dashboard. */
import path from 'node:path';
import type {
  AnalyticsDayPoint,
  AnalyticsSummary,
  FileUsage,
  FileUsageRow,
  SessionMeta,
  ToolUsage,
  ToolUsageRow,
  TranscriptItem,
  UsageBucket,
  UsageDay,
  UsageSessionRecord,
  UsageSpeed,
  UsageTotals
} from '../shared/types';
import { readJson, writeJson } from './util/fs';

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
  /** File-change counts per path, aggregated from tool results. */
  files: Record<string, FileUsage>;
}

const EMPTY_FILE: AnalyticsFile = { version: 1, days: {}, recorded: {}, sessions: {}, tools: {}, files: {} };

const DAY_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'costUsd', 'turns', 'durationMs', 'toolCalls', 'speedTokens', 'speedMs'] as const;

const EMPTY_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

export function emptyDay(): UsageDay {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0, durationMs: 0, toolCalls: 0, speedTokens: 0, speedMs: 0 };
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

export function emptyToolUsage(): ToolUsage {
  return { calls: 0, errors: 0, declined: 0, durationMs: 0 };
}

export function emptyFileUsage(): FileUsage {
  return { adds: 0, updates: 0, deletes: 0, renames: 0 };
}

/** UTC calendar day for a timestamp, e.g. '2025-06-07'. */
export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Adds `delta` into `day` in place; unknown fields are ignored so old files load cleanly. */
export function addDay(day: UsageDay, delta: Partial<UsageDay>): void {
  for (const f of DAY_FIELDS) {
    const v = delta[f];
    if (typeof v === 'number' && v > 0) day[f] += v;
  }
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
    speed: prev?.speed ? { ...prev.speed } : emptySpeed()
  };
}

function addToolUsage(into: ToolUsage, from: ToolUsage): void {
  into.calls += from.calls;
  into.errors += from.errors;
  into.declined += from.declined;
  into.durationMs += from.durationMs;
}

function addFileUsage(into: FileUsage, from: FileUsage): void {
  into.adds += from.adds;
  into.updates += from.updates;
  into.deletes += from.deletes;
  into.renames += from.renames;
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

export function summarize(sessions: UsageSessionRecord[], dayMap: Record<string, UsageDay>, tools: Record<string, ToolUsage>, files: Record<string, FileUsage>, dayLimit: number, now: number): AnalyticsSummary {
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

  const cutoff = dayLimit > 0 ? dayKey(now - dayLimit * 86_400_000) : '';
  const days: AnalyticsDayPoint[] = Object.entries(dayMap)
    .filter(([date]) => !cutoff || date >= cutoff)
    .map(([date, usage]) => ({ date, usage }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const rollup = (key: (s: UsageSessionRecord) => { key: string; label: string } | null): UsageBucket[] => {
    const map = new Map<string, UsageBucket>();
    for (const s of sessions) {
      const k = key(s);
      if (!k) continue;
      const b = map.get(k.key) ?? { key: k.key, label: k.label, usage: { ...EMPTY_USAGE }, toolCalls: 0, sessions: 0, speed: emptySpeed() };
      addTotals(b.usage, s.usage);
      b.toolCalls += s.toolCalls;
      addSpeed(b.speed, s.speed);
      b.sessions += 1;
      map.set(k.key, b);
    }
    return [...map.values()].sort((a, b) => b.usage.costUsd - a.usage.costUsd || b.usage.turns - a.usage.turns);
  };

  const byHarness = rollup((s) => ({ key: s.harness, label: s.harness }));
  const byModel = rollup((s) => (s.model ? { key: `${s.provider ?? ''}/${s.model}`, label: s.model } : null));
  const byProject = rollup((s) => ({ key: s.projectRoot, label: s.projectRoot }));

  const toolRows: ToolUsageRow[] = Object.entries(tools)
    .map(([name, usage]) => ({ name, ...usage }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
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
    byHarness,
    byModel,
    byProject,
    toolTotals,
    tools: toolRows,
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
  private data: AnalyticsFile = { ...EMPTY_FILE, days: {}, recorded: {}, sessions: {}, tools: {}, files: {} };
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
    const stored = await readJson<Partial<AnalyticsFile> | undefined>(this.file, undefined);
    this.data = {
      version: 1,
      days: stored?.days && typeof stored.days === 'object' ? stored.days : {},
      recorded: stored?.recorded && typeof stored.recorded === 'object' ? stored.recorded : {},
      sessions: stored?.sessions && typeof stored.sessions === 'object' ? stored.sessions : {},
      tools: stored?.tools && typeof stored.tools === 'object' ? stored.tools : {},
      files: stored?.files && typeof stored.files === 'object' ? stored.files : {}
    };
    // Fields added after a file was written (speed samples) load as zero rather than NaN.
    for (const day of Object.values(this.data.days)) for (const f of DAY_FIELDS) if (typeof day[f] !== 'number') day[f] = 0;
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
        addDay(day, usageDelta({ ...EMPTY_USAGE }, meta.usage));
        backfilled++;
      }
      if (readTranscript) await this.backfillTranscript(meta.id, meta.updatedAt, readTranscript);
    }
    if (backfilled) this.deps.log('info', `analytics: backfilled ${backfilled} existing session(s)`);
    await this.flush();
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
    for (const item of items) {
      if (item.kind !== 'tool' || item.status === 'running') continue;
      this.recordToolCall(sessionId, item, dayTs);
      calls++;
    }
    if (calls) this.deps.log('debug', `analytics: backfilled ${calls} tool call(s) from ${sessionId}`);
  }

  /** Records cumulative usage totals from the harness, adding the delta to today's bucket. */
  recordUsage(meta: SessionMeta, totals: UsageTotals, now = Date.now()): void {
    const prev = this.data.recorded[meta.id];
    const delta = usageDelta(prev ?? { ...EMPTY_USAGE }, totals);
    this.data.recorded[meta.id] = { ...totals };
    this.data.sessions[meta.id] = snapshotSession(meta, this.data.sessions[meta.id]);
    addDay(this.dayFor(dayKey(now)), delta);
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
    addDay(day, { durationMs, speedTokens: speed?.tokens, speedMs: speed?.ms });
    if (speed) {
      const session = (this.data.sessions[meta.id] ??= snapshotSession(meta));
      addSpeed((session.speed ??= emptySpeed()), speed);
    }
    this.scheduleWrite();
  }

  /** Records one completed tool call: per-tool counts, per-file changes and today's call volume. */
  recordToolCall(sessionId: string, item: Extract<TranscriptItem, { kind: 'tool' }>, now = Date.now()): void {
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
    addDay(this.dayFor(dayKey(now)), { toolCalls: 1 });
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

  summary(dayLimit = 30, now = Date.now()): AnalyticsSummary {
    const sessions = Object.values(this.data.sessions);
    return summarize(sessions, this.data.days, this.data.tools, this.data.files, dayLimit, now);
  }
}