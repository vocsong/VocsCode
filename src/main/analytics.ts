/** Collects usage data into daily buckets and per-session records, powering the analytics dashboard. */
import path from 'node:path';
import type {
  AnalyticsDayPoint,
  AnalyticsSummary,
  SessionMeta,
  UsageBucket,
  UsageDay,
  UsageSessionRecord,
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
}

const EMPTY_FILE: AnalyticsFile = { version: 1, days: {}, recorded: {}, sessions: {} };

const DAY_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'costUsd', 'turns', 'durationMs'] as const;

export function emptyDay(): UsageDay {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0, durationMs: 0 };
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

export function snapshotSession(meta: SessionMeta): UsageSessionRecord {
  return {
    id: meta.id,
    title: meta.title,
    harness: meta.config.harness,
    provider: meta.activeModel?.provider,
    model: meta.activeModel?.model,
    projectRoot: meta.config.projectRoot,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    usage: { ...meta.usage }
  };
}

export function summarize(sessions: UsageSessionRecord[], dayMap: Record<string, UsageDay>, dayLimit: number, now: number): AnalyticsSummary {
  const seed = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 });
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
      const b = map.get(k.key) ?? { key: k.key, label: k.label, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }, sessions: 0 };
      addTotals(b.usage, s.usage);
      b.sessions += 1;
      map.set(k.key, b);
    }
    return [...map.values()].sort((a, b) => b.usage.costUsd - a.usage.costUsd || b.usage.turns - a.usage.turns);
  };

  const byHarness = rollup((s) => ({ key: s.harness, label: s.harness }));
  const byModel = rollup((s) => (s.model ? { key: `${s.provider ?? ''}/${s.model}`, label: s.model } : null));
  const byProject = rollup((s) => ({ key: s.projectRoot, label: s.projectRoot }));

  const sortedSessions = [...sessions].sort((a, b) => b.usage.costUsd - a.usage.costUsd || b.usage.turns - a.usage.turns || b.updatedAt - a.updatedAt);
  const dayList = Object.keys(dayMap).sort();

  return {
    totals,
    days,
    byHarness,
    byModel,
    byProject,
    sessions: sortedSessions,
    sessionCount: sessions.length,
    activeDays: dayList.length,
    firstDay: dayList[0]
  };
}

export interface AnalyticsDeps {
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export class AnalyticsStore {
  private data: AnalyticsFile = { ...EMPTY_FILE, days: {}, recorded: {}, sessions: {} };
  private readonly file: string;
  private writeTimer: NodeJS.Timeout | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(userData: string, private readonly deps: AnalyticsDeps) {
    this.file = path.join(userData, 'analytics.json');
  }

  /** Loads the store and backfills sessions that predate it, attributing their totals to their last active day. */
  async load(existing: SessionMeta[]): Promise<void> {
    const stored = await readJson<Partial<AnalyticsFile> | undefined>(this.file, undefined);
    this.data = {
      version: 1,
      days: stored?.days && typeof stored.days === 'object' ? stored.days : {},
      recorded: stored?.recorded && typeof stored.recorded === 'object' ? stored.recorded : {},
      sessions: stored?.sessions && typeof stored.sessions === 'object' ? stored.sessions : {}
    };
    let backfilled = 0;
    for (const meta of existing) {
      if (this.data.recorded[meta.id]) {
        // Still refresh the snapshot: the title/model may have changed since the last write.
        this.data.sessions[meta.id] = snapshotSession(meta);
        continue;
      }
      this.data.recorded[meta.id] = { ...meta.usage };
      this.data.sessions[meta.id] = snapshotSession(meta);
      if (meta.usage.costUsd > 0 || meta.usage.turns > 0) {
        const day = this.dayFor(dayKey(meta.updatedAt));
        addDay(day, usageDelta({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }, meta.usage));
        backfilled++;
      }
    }
    if (backfilled) this.deps.log('info', `analytics: backfilled ${backfilled} existing session(s)`);
    await this.flush();
  }

  /** Records cumulative usage totals from the harness, adding the delta to today's bucket. */
  recordUsage(meta: SessionMeta, totals: UsageTotals, now = Date.now()): void {
    const prev = this.data.recorded[meta.id];
    const delta = usageDelta(prev ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }, totals);
    this.data.recorded[meta.id] = { ...totals };
    this.data.sessions[meta.id] = snapshotSession(meta);
    addDay(this.dayFor(dayKey(now)), delta);
    this.scheduleWrite();
  }

  /** Records a completed turn's wall time (turn counts come through the usage deltas). */
  recordTurn(meta: SessionMeta, durationMs: number, now = Date.now()): void {
    if (!durationMs || durationMs <= 0) return;
    addDay(this.dayFor(dayKey(now)), { durationMs });
    this.scheduleWrite();
  }

  /** Upserts the session snapshot without touching usage (creation, rename, model switch). */
  touchSession(meta: SessionMeta): void {
    this.data.sessions[meta.id] = snapshotSession(meta);
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
    return summarize(sessions, this.data.days, dayLimit, now);
  }
}
