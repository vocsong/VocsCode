/**
 * One-time and startup repair migrations for the analytics store and transcripts.
 *
 * Kept separate from AnalyticsStore so historical schema repairs (Codex cached-input double-count,
 * Claude CLI fallback-rate repricing, fork-inheritance reconciliation, legacy day-slice
 * reconstruction) stay pure and independently testable without bloating the live ledger.
 */
import type {
  FileUsage,
  ProviderConfig,
  SessionMeta,
  ToolUsage,
  TranscriptItem,
  UsageCounters,
  UsageDay,
  UsageDayDimensions,
  UsageSessionRecord,
  UsageTotals
} from '../shared/types';
import { modelKeyLabel } from '../shared/model-names';
import {
  addFileUsage,
  addSlice,
  addToolUsage,
  COUNTER_FIELDS,
  emptyDimensions,
  emptyFileUsage,
  emptyToolUsage,
  harnessModelKey,
  toolNameKey,
  toolUsageRows,
  totalTokens
} from '../shared/usage-rollup';
import { dayKey } from '../shared/analytics/usage-summary';
import type { Logger } from './log';
import { modelsForProvider } from './models/static-models';
import { errorMessage } from './util/async';
import {
  inheritedUsageOf,
  LEDGER_FIELDS,
  pricedModelOf,
  repricingOf,
  turnUsageTotals,
  type ForkInheritance,
  type LedgerField
} from './util/usage-repair';

export interface AnalyticsFile {
  /**
   * 1 → the codex cached-input double count; 2 → the Claude fallback-rate repricing; 3 → fork
   * inheritance taken back. The fork sweep is the only one that reads every transcript, so it is
   * the only gate that has to hold across a restart: the file says 2 until the sweep finishes,
   * which is what makes an interrupted sweep retry on the next boot instead of leaving the rest of
   * history uncorrected.
   */
  version: 2 | 3;
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
  /** Live tool outcomes by known session harness; never reconstructed from legacy aggregates. */
  harnessTools: Record<string, Record<string, ToolUsage>>;
  /** Bounded recent-call replay protection, persisted atomically with the counters. */
  recordedTools: string[];
  /** User-submission receipt ids, persisted atomically with their day counters (no prompt text). */
  recordedUserInputs: string[];
  /**
   * Last scanned transcript file stamp (`size:mtimeMs:ctimeMs`) per session id, persisted
   * atomically with day totals and receipt ids. Tied to the transcript file itself (never
   * `meta.updatedAt`), so a crash that appended a transcript without flushing analytics still
   * invalidates the stamp while untouched historical transcripts are skipped on subsequent boots.
   */
  scannedTranscripts?: Record<string, string>;
  /** Completed tool calls per tool name, keyed by harness and model (`harness|provider/model`). */
  harnessModelTools: Record<string, Record<string, ToolUsage>>;
  /** File-change counts per path, aggregated from tool results. */
  files: Record<string, FileUsage>;
  /** Last `--version` each harness reported, stamped on execution records. */
  harnessVersions?: Record<string, string>;
}

/** The three attribution dimensions of a usage record; sessions carry all of them. */
export interface Attribution {
  id: string;
  harness: string;
  provider?: string;
  model?: string;
  projectRoot: string;
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

/** Adds `delta` to the day's harness, model, harness × model and project slices for the session that produced it. */
export function attribute(day: UsageDay, who: Attribution, delta: Partial<UsageCounters>): void {
  const by = (day.by ??= emptyDimensions());
  addSlice(by.harness, who.harness, who.harness, delta, who.id);
  // The slice is named from the key it is filed under: usage recorded before per-model provider
  // tracking has none, so it keeps the bare id rather than showing a leading slash.
  if (who.model) {
    const key = `${who.provider ?? ''}/${who.model}`;
    const label = modelKeyLabel(key);
    addSlice(by.model, key, label, delta, who.id);
    addSlice(by.harnessModel, harnessModelKey(who.harness, key), label, delta, who.id);
  }
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

const INTEGER_FIELDS = new Set<keyof UsageCounters>(['userInputTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'turns', 'toolCalls']);

/** Each session's own total of a counter, the weight used to share a legacy day's total between them. */
function sessionWeight(s: UsageSessionRecord, f: keyof UsageCounters): number {
  switch (f) {
    // User text is only known from host receipts, never inferred from provider/session totals.
    case 'userInputTokens':
      return 0;
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

/**
 * One-time reconstruction of days written before slice tracking (see estimateDaySlices), using
 * only the sessions already in the file. Their per-tool and per-file counts are the all-time maps
 * minus whatever later days recorded live, shared between the legacy days by call volume. Runs
 * before the session backfill, so newly seen sessions are attributed exactly on top.
 */
export function estimateLegacyDays(data: AnalyticsFile): number {
  const legacy = Object.entries(data.days).filter(([, d]) => !d.by);
  if (legacy.length === 0) return 0;
  const byDay = new Map<string, UsageSessionRecord[]>();
  for (const s of Object.values(data.sessions)) {
    const key = dayKey(s.updatedAt);
    byDay.set(key, [...(byDay.get(key) ?? []), s]);
  }
  const estimated = legacy.filter(([date, day]) => estimateDaySlices(day, byDay.get(date) ?? [])).map(([, day]) => day);
  const weights = estimated.map((d) => d.toolCalls);
  if (estimated.length > 0 && weights.some((w) => w > 0)) {
    const knownTools: Record<string, ToolUsage> = {};
    const knownFiles: Record<string, FileUsage> = {};
    for (const d of Object.values(data.days)) {
      if (!d.by || d.by.estimated) continue;
      for (const [name, t] of Object.entries(d.by.tool)) addToolUsage((knownTools[toolNameKey(name)] ??= emptyToolUsage()), t);
      for (const [p, f] of Object.entries(d.by.file)) addFileUsage((knownFiles[p] ??= emptyFileUsage()), f);
    }
    for (const t of toolUsageRows(data.tools)) {
      const name = t.name;
      const k = knownTools[toolNameKey(name)] ?? emptyToolUsage();
      const parts = (['calls', 'errors', 'declined', 'durationMs'] as const).map((f) => apportion(Math.max(0, t[f] - k[f]), weights, f !== 'durationMs'));
      estimated.forEach((d, i) => {
        const share: ToolUsage = { calls: parts[0][i], errors: parts[1][i], declined: parts[2][i], durationMs: parts[3][i] };
        if (share.calls > 0 || share.errors > 0 || share.declined > 0) d.by!.tool[name] = share;
      });
    }
    for (const [p, f] of Object.entries(data.files)) {
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

/**
 * The one model every one of `sessions` was filed under within the day, or undefined when they
 * disagree or one of them is in no model slice at all. Day slices record the model that was active
 * at the time, so this is evidence about the day itself rather than about the sessions' last model.
 */
function dayModelCovering(by: UsageDayDimensions, sessions: string[]): string | undefined {
  if (sessions.length === 0) return undefined;
  const owners = new Set(sessions);
  let found: string | undefined;
  for (const [modelKey, slice] of Object.entries(by.model)) {
    if (!slice.sessions.some((id) => owners.has(id))) continue;
    if (found !== undefined && found !== modelKey) return undefined;
    found = modelKey;
  }
  if (found === undefined) return undefined;
  const covering = new Set(by.model[found].sessions);
  return sessions.every((id) => covering.has(id)) ? found : undefined;
}

/**
 * Fills the harness × model dimension on days recorded before it existed, but only where the
 * day's own slices already prove the answer: a harness whose sessions were all filed under one
 * model used that model for everything it recorded that day, so its slice copies over exactly.
 * A harness that spread across several models that day is left alone — a rate split by guesswork
 * is worse than a gap. Days whose slices were estimated already have the dimension. Returns the
 * number of harness/day pairs recovered.
 */
export function recoverHarnessModelDays(data: AnalyticsFile): number {
  let recovered = 0;
  for (const day of Object.values(data.days)) {
    const by = day.by;
    if (!by) continue;
    for (const [harness, slice] of Object.entries(by.harness)) {
      const modelKey = dayModelCovering(by, slice.sessions ?? []);
      if (!modelKey) continue;
      const key = harnessModelKey(harness, modelKey);
      if (by.harnessModel[key]) continue;
      // Same shape `attribute` writes: the counters of the harness, labelled by the model.
      by.harnessModel[key] = { ...slice, label: modelKeyLabel(modelKey), sessions: [...slice.sessions] };
      recovered++;
    }
  }
  return recovered;
}

/**
 * One-time repair for stores written before the Codex adapters subtracted cached input from their
 * input token count. Codex reports the cached subset inside its input tokens, so pre-fix records
 * carried every cached token twice — once inside inputTokens, once as cacheReadTokens — which
 * roughly halved the cache hit rate and over-billed input cost for codex-sourced usage. Removes
 * the cached part from each codex slice (day total, harness slice, session snapshots and delta
 * baselines) and spreads it across that day's model and project slices weighted by their own
 * cache reads — exact where codex ran a single model, proportional where it did not. Runs when
 * the first build with the fix loads a version-1 store: everything on disk then predates it.
 * Returns the number of days repaired.
 */
export function migrateCodexCachedInput(data: AnalyticsFile, sessions: SessionMeta[]): number {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  let fixed = 0;
  for (const day of Object.values(data.days)) {
    const codex = day.by?.harness?.codex;
    if (!codex) continue;
    const removed = Math.min(codex.inputTokens, codex.cacheReadTokens);
    if (!(removed > 0)) continue;
    codex.inputTokens -= removed;
    day.inputTokens = Math.max(0, day.inputTokens - removed);
    const active = (codex.sessions ?? []).map((id) => byId.get(id)).filter((s): s is SessionMeta => s !== undefined);
    const spread = (dim: 'model' | 'project') => {
      const slices = day.by?.[dim];
      if (!slices) return;
      const keys = [...new Set(active.flatMap((s) => (dim === 'model' ? (s.activeModel?.model ? [`${s.activeModel.provider ?? ''}/${s.activeModel.model}`] : []) : [s.config.projectRoot])))].filter((k) => slices[k]);
      if (!keys.length) return;
      const parts = apportion(removed, keys.map((k) => slices[k].cacheReadTokens), true);
      keys.forEach((k, i) => (slices[k].inputTokens = Math.max(0, slices[k].inputTokens - parts[i])));
    };
    spread('model');
    spread('project');
    fixed++;
  }
  const repair = (u: UsageTotals): void => {
    u.inputTokens = Math.max(0, u.inputTokens - u.cacheReadTokens);
  };
  for (const [id, s] of Object.entries(data.sessions)) {
    if (s.harness !== 'codex') continue;
    repair(s.usage);
    const recorded = data.recorded[id];
    if (recorded) repair(recorded);
  }
  // Live sessions resume from their meta usage; correcting it in place keeps the next cumulative
  // sample from the (fixed) adapter continuous instead of re-counting the old cached tokens.
  for (const m of sessions) {
    if (m.config.harness === 'codex') repair(m.usage);
  }
  return fixed;
}

/**
 * The day buckets a session's usage was attributed to: every day that already names it, or — for a
 * session the store has a record of but no day slice names — its last active day, which is where
 * the backfill would have put it. Empty when the session is on no day at all, so a correction with
 * nothing to take back leaves the day totals alone.
 */
function carrierDaysOf(data: AnalyticsFile, meta: SessionMeta): string[] {
  const carriers = Object.keys(data.days).filter((key) => data.days[key].by?.harness?.[meta.config.harness]?.sessions.includes(meta.id));
  if (carriers.length) return carriers;
  const lastDay = dayKey(meta.updatedAt);
  return (data.recorded[meta.id] || data.sessions[meta.id]) && data.days[lastDay] ? [lastDay] : [];
}

/** Takes `part` off every counter of a slice, floored at zero: slices mirror the day above them. */
function takeCounters(slice: Partial<Record<LedgerField, number>> | undefined, part: Partial<Record<LedgerField, number>>): void {
  if (!slice) return;
  for (const field of LEDGER_FIELDS) slice[field] = Math.max(0, (slice[field] ?? 0) - (part[field] ?? 0));
}

/**
 * One-time repair for spend the Claude adapter recorded at the Claude CLI's fallback rates, which
 * overstated a third-party model by two orders of magnitude — see `util/usage-repair` for why the
 * record looks the way it does and how one is recognised.
 *
 * Unlike the codex repair this runs on every load instead of behind a version gate: the recognition
 * test is self-limiting, since a record that has been repriced no longer matches it. Sessions whose
 * per-day share cannot be recovered (one resumed across midnight, so its usage sits on more than
 * one day) have the dollars split evenly between those days — the session total is exact either
 * way, only the day it is charted under is approximate.
 */
export function migrateClaudeFallbackSpend(data: AnalyticsFile, sessions: SessionMeta[], providers: ProviderConfig[] = []): { ids: string[]; usd: number } {
  const ids: string[] = [];
  let usd = 0;
  const cut = (slice: { costUsd: number } | undefined, by: number): void => {
    if (slice) slice.costUsd = Math.max(0, slice.costUsd - by);
  };
  for (const meta of sessions) {
    if (meta.config.harness !== 'claude') continue;
    const ref = pricedModelOf(meta);
    const repricing = repricingOf(ref, meta.usage, modelsForProvider(providers, ref?.provider));
    if (!ref || !repricing) continue;
    const delta = repricing.from - repricing.to;
    const snapshot = data.sessions[meta.id];
    const recorded = data.recorded[meta.id];
    meta.usage.costUsd = repricing.to;
    if (snapshot) snapshot.usage.costUsd = repricing.to;
    if (recorded) recorded.costUsd = repricing.to;
    const modelKey = `${ref.provider}/${ref.model}`;
    const targets = carrierDaysOf(data, meta);
    const shares = apportion(delta, targets.map(() => 1), false);
    targets.forEach((key, i) => {
      const day = data.days[key];
      day.costUsd = Math.max(0, day.costUsd - shares[i]);
      const by = day.by;
      if (!by) return;
      cut(by.harness?.claude, shares[i]);
      cut(by.model?.[modelKey], shares[i]);
      cut(by.harnessModel?.[harnessModelKey('claude', modelKey)], shares[i]);
      cut(by.project?.[meta.config.projectRoot], shares[i]);
    });
    ids.push(meta.id);
    usd += delta;
  }
  return { ids, usd };
}

/**
 * One-time correction for the spend, tokens and turns a fork inherited from the session it was
 * forked from — see `util/usage-repair` for how the split is drawn and why `createdAt` is the cut.
 *
 * `inheritances` is keyed by session id and holds what `inheritedUsageOf` read off each transcript.
 * Only sessions whose totals actually move are returned; a fork whose harness already reset its
 * counters has nothing taken from it, its copied rows are still handed over by the caller.
 */
export function reconcileForkInheritedSpend(data: AnalyticsFile, sessions: SessionMeta[], inheritances: Map<string, ForkInheritance>): { ids: string[]; usd: number } {
  const ids: string[] = [];
  let usd = 0;
  for (const meta of sessions) {
    const found = inheritances.get(meta.id);
    if (!found) continue;
    const before = { ...meta.usage };
    for (const field of LEDGER_FIELDS) meta.usage[field] = Math.max(0, (meta.usage[field] ?? 0) - (found.inherited[field] ?? 0));
    // The part taken back, field by field: `usageDelta` is the same clamp the day write uses, read
    // the other way round (how much the totals dropped, never how much they grew).
    const drop = usageDelta(meta.usage, before);
    const snapshot = data.sessions[meta.id];
    const recorded = data.recorded[meta.id];
    if (snapshot) takeCounters(snapshot.usage, drop);
    if (recorded) takeCounters(recorded, drop);
    const targets = carrierDaysOf(data, meta);
    const share = targets.length ? 1 / targets.length : 0;
    targets.forEach((key) => {
      const day = data.days[key];
      const part: Partial<UsageCounters> = {};
      for (const field of LEDGER_FIELDS) part[field] = (drop[field] ?? 0) * share;
      takeCounters(day, part);
      const by = day.by;
      if (!by) return;
      takeCounters(by.harness?.[meta.config.harness], part);
      takeCounters(by.project?.[meta.config.projectRoot], part);
      const ref = pricedModelOf(meta);
      if (!ref) return;
      const modelKey = `${ref.provider}/${ref.model}`;
      takeCounters(by.model?.[modelKey], part);
      takeCounters(by.harnessModel?.[harnessModelKey(meta.config.harness, modelKey)], part);
    });
    const moved = LEDGER_FIELDS.some((field) => (drop[field] ?? 0) > 0);
    if (!moved) continue;
    ids.push(meta.id);
    usd += drop.costUsd ?? 0;
  }
  return { ids, usd };
}

export interface MigrationSessionStore {
  list(): SessionMeta[];
  get(id: string): SessionMeta | undefined;
  readTranscript(id: string): Promise<TranscriptItem[]>;
  repriceTurns(id: string, reprice: (turn: Extract<TranscriptItem, { kind: 'turn' }>) => number | undefined): Promise<number>;
  persist(): Promise<void>;
}

/**
 * Rewrites transcript turn rows for sessions whose spend `migrateClaudeFallbackSpend` corrected
 * during `analytics.load`, so the Usage panel's per-turn list matches the repaired session totals
 * from the first paint.
 */
export async function repriceClaudeFallbackTranscripts(
  repricedSessions: readonly string[],
  store: Pick<MigrationSessionStore, 'get' | 'repriceTurns' | 'persist'>,
  providers: ProviderConfig[],
  log: Logger
): Promise<number> {
  if (!repricedSessions.length) return 0;
  let rows = 0;
  for (const id of repricedSessions) {
    const meta = store.get(id);
    const ref = meta ? pricedModelOf(meta) : undefined;
    if (!ref) continue;
    rows += await store.repriceTurns(id, (turn) => repricingOf(ref, turnUsageTotals(turn), modelsForProvider(providers, ref.provider))?.to);
  }
  await store.persist();
  log('info', `usage: repriced ${repricedSessions.length} claude session(s) recorded at the CLI's fallback rates (${rows} turn row(s))`);
  return rows;
}

export interface ForkSweepAnalytics {
  reconcileForks(sessions: SessionMeta[], inheritances: Map<string, ForkInheritance>): { ids: string[]; usd: number };
  settleForkSweep(): Promise<void>;
}

/**
 * One-time sweep for spend a fork inherited from the session it was forked from: reads every
 * transcript once, takes the inherited share off each session's totals and rollups, and zeroes
 * the copied turn rows' cost. Yields between sessions so large histories never freeze the main
 * process, and settles the version marker only after every transcript has been read.
 */
export async function reconcileForkInheritance(
  analytics: ForkSweepAnalytics,
  store: Pick<MigrationSessionStore, 'list' | 'readTranscript' | 'repriceTurns' | 'persist'>,
  log: Logger
): Promise<void> {
  const started = Date.now();
  const metas = store.list();
  const inheritances = new Map<string, ForkInheritance>();
  let failed = 0;
  for (const meta of metas) {
    try {
      const found = inheritedUsageOf(meta, await store.readTranscript(meta.id));
      if (found) inheritances.set(meta.id, found);
    } catch (e) {
      // A transcript that could not be read is one this pass cannot judge. Leaving the version at 2
      // keeps the sweep owed, which costs another read next boot; settling anyway would quietly
      // leave that session's numbers as they were.
      failed++;
      log('warn', `usage: fork sweep could not read ${meta.id}: ${errorMessage(e)}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!inheritances.size) {
    if (!failed) await analytics.settleForkSweep();
    return;
  }
  const { ids, usd } = analytics.reconcileForks(metas, inheritances);
  let rows = 0;
  for (const [id, found] of inheritances) {
    if (!found.carriedIds.length) continue;
    const carried = new Set(found.carriedIds);
    rows += await store.repriceTurns(id, (turn) => (carried.has(turn.id) ? 0 : undefined));
  }
  await store.persist();
  if (!failed) await analytics.settleForkSweep();
  log(
    'info',
    `usage: fork sweep took ${usd.toFixed(2)} USD and ${rows} turn row(s) back from ${ids.length} session(s) out of ${metas.length} read in ${Date.now() - started}ms` +
      (failed ? `; ${failed} transcript(s) unreadable, so it will run again` : '')
  );
}
