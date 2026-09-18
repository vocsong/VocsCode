/** Collects usage data into daily buckets and per-session records, powering the analytics dashboard. */
import path from 'node:path';
import type {
  AnalyticsDayPoint,
  AnalyticsSummary,
  FileUsage,
  FileUsageRow,
  HarnessModelToolRow,
  ModelRateRow,
  ModelRef,
  ModelToolRow,
  ProviderConfig,
  SessionMeta,
  SubagentCompletion,
  SubagentCost,
  ToolUsage,
  ToolUsageRow,
  TranscriptItem,
  UsageBucket,
  UsageCounters,
  UsageDay,
  UsageDayDimensions,
  UsageSessionRecord,
  UsageSpeed,
  UsageTotals
} from '../shared/types';
import { modelKeyLabel } from '../shared/model-names';
import { addCounters, addFileUsage, addSlice, addToolUsage, COUNTER_FIELDS, emptyCounters, emptyDimensions, emptyFileUsage, emptyToolUsage, emptySlice, harnessModelKey, harnessModelToolUsageRows, harnessToolUsageRows, modelToolUsageRows, toolNameKey, toolUsageRows, totalTokens } from '../shared/usage-rollup';
import { codeOutputReport, type CodeOutputReport } from '../shared/analytics/code-output';
import type { ExecutionRecord } from '../shared/analytics/records';
import { reliabilityReport, type ReliabilityReport } from '../shared/analytics/reliability';
import { ExecutionLog, type ExecutionContext, type ExecutionQuery } from './analytics-executions';
import { modelsForProvider } from './models/static-models';
import { LEDGER_FIELDS, pricedModelOf, repricingOf, type ForkInheritance, type LedgerField } from './util/usage-repair';
import { readJson, writeJson } from './util/fs';

export { emptyFileUsage, emptyToolUsage };
export { EXECUTION_RETENTION } from './analytics-executions';

interface AnalyticsFile {
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
  /** Completed tool calls per tool name, keyed by harness and model (`harness|provider/model`). */
  harnessModelTools: Record<string, Record<string, ToolUsage>>;
  /** File-change counts per path, aggregated from tool results. */
  files: Record<string, FileUsage>;
  /** Last `--version` each harness reported, stamped on execution records. */
  harnessVersions?: Record<string, string>;
}

const EMPTY_FILE: AnalyticsFile = { version: 2, days: {}, recorded: {}, sessions: {}, tools: {}, modelTools: {}, harnessModelTools: {}, harnessTools: {}, recordedTools: [], files: {} };

/** Older calls remain deduped in memory; only this recent window survives restart. */
const RECENT_TOOL_LIMIT = 10_000;

/** Synthetic tool name for a subagent's internal calls, which pi never puts in the parent transcript. */
export const SUBAGENT_TOOL = 'subagent';

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
 * One-time repair for spend the Claude adapter recorded at the Claude CLI's fallback rates, which
 * overstated a third-party model by two orders of magnitude — see `util/usage-repair` for why the
 * record looks the way it does and how one is recognised.
 *
 * Every copy of the figure moves together, because each is read on its own:
 *   - the session meta, which also seeds the adapter's next cumulative sample — a repaired session
 *     whose meta kept the old dollars would report a spend that can never grow;
 *   - the analytics snapshot the dashboard's session rows and totals are built from;
 *   - `recorded`, the same delta baseline, which is why the codex repair moves it too;
 *   - the day slices the usage was attributed to, so the day, harness, model, harness × model and
 *     project breakdowns all lose the phantom dollars rather than only the top line.
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
 * One-time correction for the spend, tokens and turns a fork inherited from the session it was
 * forked from — see `util/usage-repair` for how the split is drawn and why `createdAt` is the cut.
 *
 * Every copy of the figure moves together, for the same reason the two repairs above move theirs:
 * the session meta (which the adapter seeds its next cumulative sample from), the analytics
 * snapshot the dashboard's rows are built from, `recorded`, and the day slices the usage was
 * attributed to, so the day, harness, model, harness × model and project breakdowns all lose the
 * inherited share rather than only the top line. The amount removed from a day is its counter
 * delta, taken off each field in turn; a session spanning several days has it split evenly between
 * them, so the session total is exact either way and only the day it is charted under is
 * approximate.
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

/** The usage half of a summary; `AnalyticsStore.summary` adds the reports built from the execution log. */
export type UsageSummary = Omit<AnalyticsSummary, 'reliability' | 'codeOutput'>;

export function summarize(sessions: UsageSessionRecord[], dayMap: Record<string, UsageDay>, tools: Record<string, ToolUsage>, modelTools: Record<string, Record<string, ToolUsage>>, harnessModelTools: Record<string, Record<string, ToolUsage>>, files: Record<string, FileUsage>, dayLimit: number, now: number, harnessTools: Record<string, Record<string, ToolUsage>> = {}): UsageSummary {
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
  const byModel = rollup((s) => {
    if (!s.model) return null;
    const key = `${s.provider ?? ''}/${s.model}`;
    return { key, label: modelKeyLabel(key) };
  });
  const byHarnessModel = rollup((s) => {
    if (!s.model) return null;
    const key = `${s.provider ?? ''}/${s.model}`;
    return { key: harnessModelKey(s.harness, key), label: modelKeyLabel(key) };
  });
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
  const harnessModelToolRows: HarnessModelToolRow[] = harnessModelToolUsageRows(harnessModelTools);
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
    byHarnessModel,
    byProject,
    modelRates,
    toolTotals,
    tools: toolRows,
    modelTools: modelToolRows,
    harnessTools: harnessToolUsageRows(harnessTools),
    harnessModelTools: harnessModelToolRows,
    files: fileRows,
    sessions: sortedSessions,
    sessionCount: sessions.length,
    activeDays: dayList.length,
    firstDay: dayList[0]
  };
}

export interface AnalyticsDeps {
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Test hooks for the execution log's environment stamp and retention. */
  executionLog?: { platform?: string; release?: string; arch?: string; retention?: { maxRecords: number; maxDays: number } };
}

/** Reads back a session's transcript so sessions predating the store can be backfilled. */
export type TranscriptReader = (sessionId: string) => Promise<TranscriptItem[]>;

export class AnalyticsStore {
  private data: AnalyticsFile = { ...EMPTY_FILE, days: {}, recorded: {}, sessions: {}, tools: {}, modelTools: {}, harnessModelTools: {}, harnessTools: {}, recordedTools: [], files: {} };
  private readonly file: string;
  private writeTimer: NodeJS.Timeout | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  /** Tool item ids already counted, so repeated upserts of one call never double-record. */
  private recordedTools = new Set<string>();
  /** Subagent spend awaiting model re-attribution, keyed by session then `provider/model`. */
  private readonly pendingSubagentCost = new Map<string, Map<string, SubagentCost>>();
  /** Per-execution records behind the reliability analytics. */
  readonly executions: ExecutionLog;
  /** Resolves when historical transcripts have been replayed into the execution log. */
  private backfill: Promise<void> = Promise.resolve();
  /** Sessions whose spend the load-time repair repriced; their transcript turn rows follow. */
  repricedSessions: string[] = [];
  /**
   * True while stored history predates fork-inheritance accounting. The sweep it asks for is the
   * one repair that has to read every transcript, so it runs after the window is up rather than in
   * `load`; see `settleForkSweep` for why the file version only moves once it is done.
   */
  forkSweepPending = false;
  private reliabilityCache?: { key: string; report: ReliabilityReport };
  private codeOutputCache?: { key: string; report: CodeOutputReport };

  constructor(userData: string, private readonly deps: AnalyticsDeps) {
    this.file = path.join(userData, 'analytics.json');
    this.executions = new ExecutionLog(userData, { log: deps.log, ...deps.executionLog });
  }

  /**
   * Loads the store and backfills sessions that predate it: usage totals are attributed to each
   * session's last active day, and per-tool/per-file stats are rebuilt from its transcript.
   */
  async load(existing: SessionMeta[], readTranscript?: (id: string) => Promise<TranscriptItem[]>, providers: ProviderConfig[] = []): Promise<void> {
    const stored = await readJson<Partial<AnalyticsFile> | undefined>(this.file, undefined, { log: this.deps.log });
    const storedVersion = stored?.version ?? 1;
    const fromV1 = storedVersion < 2;
    // Stays at 2 until the sweep reports back, so a run interrupted partway retries rather than
    // leaving the sessions it never reached charged for someone else's work.
    this.forkSweepPending = storedVersion < 3;
    this.data = {
      version: this.forkSweepPending ? 2 : 3,
      days: stored?.days && typeof stored.days === 'object' ? stored.days : {},
      recorded: stored?.recorded && typeof stored.recorded === 'object' ? stored.recorded : {},
      sessions: stored?.sessions && typeof stored.sessions === 'object' ? stored.sessions : {},
      tools: stored?.tools && typeof stored.tools === 'object' ? stored.tools : {},
      modelTools: stored?.modelTools && typeof stored.modelTools === 'object' ? stored.modelTools : {},
      harnessTools: stored?.harnessTools && typeof stored.harnessTools === 'object' ? stored.harnessTools : {},
      recordedTools: Array.isArray(stored?.recordedTools) ? stored.recordedTools.filter((key) => typeof key === 'string').slice(-RECENT_TOOL_LIMIT) : [],
      harnessModelTools: stored?.harnessModelTools && typeof stored.harnessModelTools === 'object' ? stored.harnessModelTools : {},
      files: stored?.files && typeof stored.files === 'object' ? stored.files : {},
      harnessVersions: stored?.harnessVersions && typeof stored.harnessVersions === 'object' ? stored.harnessVersions : {}
    };
    this.recordedTools = new Set(this.data.recordedTools);
    await this.executions.load();
    // Fields added after a file was written (speed samples, dimension slices) load as zero rather than NaN.
    for (const day of Object.values(this.data.days)) {
      for (const f of COUNTER_FIELDS) if (typeof day[f] !== 'number') day[f] = 0;
      if (day.by !== undefined && (typeof day.by !== 'object' || day.by === null)) delete day.by;
      if (day.by) for (const dim of ['harness', 'model', 'harnessModel', 'project', 'tool', 'modelTool', 'harnessModelTool', 'file'] as const) if (typeof day.by[dim] !== 'object' || day.by[dim] === null) day.by[dim] = {};
      if (day.by?.harnessTool !== undefined && (typeof day.by.harnessTool !== 'object' || day.by.harnessTool === null)) delete day.by.harnessTool;
    }
    // One-time repair before anything reads the numbers: version-1 stores were written entirely by
    // builds that double-counted Codex's cached input, so every codex record on disk needs it.
    if (fromV1) {
      const fixed = migrateCodexCachedInput(this.data, existing);
      if (fixed) this.deps.log('info', `analytics: removed the cached-input double-count from ${fixed} codex day(s) recorded before the fix`);
    }
    const repriced = migrateClaudeFallbackSpend(this.data, existing, providers);
    this.repricedSessions = repriced.ids;
    if (repriced.ids.length) {
      this.deps.log('info', `analytics: repriced ${repriced.ids.length} claude session(s) recorded at the CLI's fallback rates, removing $${repriced.usd.toFixed(2)}`);
    }
    const estimated = this.estimateLegacyDays();
    if (estimated) this.deps.log('info', `analytics: estimated per-model slices for ${estimated} day(s) recorded before slice tracking`);
    const recovered = this.recoverHarnessModelDays();
    if (recovered) this.deps.log('info', `analytics: recovered the harness × model split for ${recovered} day(s) recorded before that dimension existed`);
    let backfilled = 0;
    for (const meta of existing) {
      if (this.data.recorded[meta.id]) {
        // Still refresh the snapshot: the title/model may have changed since the last write.
        this.data.sessions[meta.id] = snapshotSession(meta, this.data.sessions[meta.id]);
        // On upgrade, remember old call ids without replaying their already-counted outcomes.
        if (!Array.isArray(stored?.recordedTools) && readTranscript) {
          try {
            for (const item of await readTranscript(meta.id)) {
              if (item.kind === 'tool' && item.status !== 'running') this.rememberTool(JSON.stringify([meta.id, item.id]));
            }
          } catch {
            this.deps.log('warn', `analytics: could not seed recent tool replay protection for ${meta.id}`);
          }
        }
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
    // Transcript replay into the execution log runs after load returns so startup never waits on it.
    if (readTranscript) this.backfill = this.backfillExecutions(existing, readTranscript);
  }

  /** Resolves once historical transcripts have been replayed into the execution log (tests, shutdown). */
  whenBackfilled(): Promise<void> {
    return this.backfill;
  }

  /**
   * Applies the fork-inheritance correction the sweep read off each transcript, moving the session
   * totals and every rollup built from them. The caller rewrites the transcript rows afterwards —
   * they are the store's to write, not this file's.
   */
  reconcileForks(sessions: SessionMeta[], inheritances: Map<string, ForkInheritance>): { ids: string[]; usd: number } {
    const result = reconcileForkInheritedSpend(this.data, sessions, inheritances);
    if (result.ids.length) this.scheduleWrite();
    return result;
  }

  /**
   * Marks the fork-inheritance sweep finished, and only then moves the file to version 3. The
   * sweep is the one repair that reads every transcript, so the marker is what keeps it from
   * happening again — and writing it only at the end is what makes a run that dies partway retry
   * on the next boot, rather than leaving the sessions it never reached charged for work their
   * fork source did.
   */
  async settleForkSweep(): Promise<void> {
    if (!this.forkSweepPending) return;
    this.forkSweepPending = false;
    this.data.version = 3;
    await this.flush();
  }

  /**
   * Replays each known session's transcript into the execution log once. Records are marked
   * `backfill`; items without output or exit code become `legacy_unclassified`, never guessed.
   */
  private async backfillExecutions(existing: SessionMeta[], readTranscript: TranscriptReader): Promise<void> {
    let sessions = 0;
    let records = 0;
    const started = Date.now();
    for (const meta of existing) {
      if (this.executions.isBackfilled(meta.id)) continue;
      let items: TranscriptItem[];
      try {
        items = await readTranscript(meta.id);
      } catch {
        this.deps.log('warn', `analytics: could not read transcript of ${meta.id} for the execution log`);
        continue;
      }
      const count = this.executions.backfillTranscript(meta.id, items, this.executionContextOf(meta.config.harness, meta.config.projectRoot, meta.activeModel));
      await this.executions.markBackfilled(meta.id, count);
      sessions++;
      records += count;
      // Yield between sessions so a large history never starves the event loop.
      await new Promise((r) => setImmediate(r));
    }
    if (sessions) {
      await this.executions.flush();
      this.deps.log('info', `analytics: replayed ${records} execution(s) from ${sessions} transcript(s) into the execution log in ${Date.now() - started}ms`);
    }
  }

  private executionContextOf(harness: string, projectRoot: string, activeModel?: ModelRef, model?: ModelRef, ingest: ExecutionContext['ingest'] = 'live', now = Date.now()): ExecutionContext {
    return { harness, projectRoot, activeModel, model, harnessVersion: this.data.harnessVersions?.[harness], ingest, now };
  }

  /** Remembers a harness's reported version so records can be compared across upgrades. */
  noteHarnessVersion(harness: string, version: string | undefined): void {
    const v = version?.trim();
    if (!v) return;
    const versions = (this.data.harnessVersions ??= {});
    if (versions[harness] === v) return;
    versions[harness] = v;
    this.scheduleWrite();
  }

  /** A user message opens the session's next turn in the execution log. */
  recordUserMessage(meta: SessionMeta, item: Extract<TranscriptItem, { kind: 'user' }>, now = Date.now()): void {
    this.executions.recordUser(meta.id, item, this.executionContextOf(meta.config.harness, meta.config.projectRoot, meta.activeModel, undefined, 'live', now));
  }

  /** Representative executions for a dashboard drill-down. */
  queryExecutions(query: ExecutionQuery, now = Date.now()): ExecutionRecord[] {
    return this.executions.query(query, now);
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

  /**
   * Fills the harness × model dimension on days recorded before it existed, but only where the
   * day's own slices already prove the answer: a harness whose sessions were all filed under one
   * model used that model for everything it recorded that day, so its slice copies over exactly.
   * A harness that spread across several models that day is left alone — a rate split by guesswork
   * is worse than a gap. Days whose slices were estimated already have the dimension. Returns the
   * number of harness/day pairs recovered.
   */
  private recoverHarnessModelDays(): number {
    let recovered = 0;
    for (const day of Object.values(this.data.days)) {
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
      this.collectToolCall(sessionId, item, dayTs, undefined, false);
      calls++;
    }
    if (durationMs > 0) {
      const session = this.data.sessions[sessionId];
      if (session) session.durationMs = (session.durationMs ?? 0) + durationMs;
    }
    if (calls) this.deps.log('debug', `analytics: backfilled ${calls} tool call(s) from ${sessionId}`);
  }

  /** Records cumulative usage totals from the harness, adding the delta to today's bucket. */
  recordUsage(meta: SessionMeta, totals: UsageTotals, now = Date.now(), subagentCostByModel?: SubagentCost[]): void {
    const prev = this.data.recorded[meta.id];
    const delta = usageDelta(prev ?? { ...EMPTY_USAGE }, totals);
    this.data.recorded[meta.id] = { ...totals };
    this.data.sessions[meta.id] = snapshotSession(meta, this.data.sessions[meta.id]);
    const day = this.dayFor(dayKey(now));
    addDay(day, delta);
    attribute(day, attributionOf(meta), delta);
    if (subagentCostByModel?.length) this.queueSubagentCost(meta.id, subagentCostByModel);
    this.flushSubagentCost(meta, day);
    this.scheduleWrite();
  }

  /**
   * Records a completed subagent's internal tool calls. They never appear in the parent transcript,
   * so without this the delegated work is invisible to the tool volume and reliability views.
   */
  recordSubagent(meta: SessionMeta, completion: SubagentCompletion, now = Date.now()): void {
    const uses = Math.max(0, Math.floor(completion.toolUses));
    const usage = completion.usage;
    if (!uses && !usage) return;
    const day = this.dayFor(dayKey(now));
    if (uses) {
      addDay(day, { toolCalls: uses });
      const by = (day.by ??= emptyDimensions());
      addToolUsage((by.tool[SUBAGENT_TOOL] ??= emptyToolUsage()), { calls: uses, errors: completion.status === 'error' ? uses : 0, declined: 0, durationMs: 0 });
      addToolUsage((this.data.tools[SUBAGENT_TOOL] ??= emptyToolUsage()), { calls: uses, errors: completion.status === 'error' ? uses : 0, declined: 0, durationMs: 0 });
      const session = this.data.sessions[meta.id];
      if (session) session.toolCalls += uses;
      // Live per-harness outcomes, so the reliability table accounts for delegated work too.
      addToolUsage(((this.data.harnessTools[meta.config.harness] ??= {})[SUBAGENT_TOOL] ??= emptyToolUsage()), { calls: uses, errors: completion.status === 'error' ? uses : 0, declined: 0, durationMs: 0 });
      this.executions.recordSubagent(meta.id, completion, this.executionContextOf(meta.config.harness, meta.config.projectRoot, meta.activeModel, undefined, 'live', now));
    }
    // A background run's spend never reaches the harness totals, so it enters the day here instead of
    // through a usage delta. The model slice goes to the model that ran the work, not the active one.
    if (usage) {
      const delta: Partial<UsageCounters> = {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        reasoningTokens: usage.reasoningTokens ?? 0,
        costUsd: usage.costUsd ?? 0,
        turns: usage.turns ?? 0,
        durationMs: completion.durationMs ?? 0
      };
      addDay(day, delta);
      attribute(day, { id: meta.id, harness: meta.config.harness, projectRoot: meta.config.projectRoot }, delta);
      const provider = completion.model?.provider;
      const model = completion.model?.model;
      if (model) {
        const by = (day.by ??= emptyDimensions());
        const modelKey = `${provider ?? ''}/${model}`;
        addSlice(by.model, modelKey, model, delta, meta.id);
        addSlice(by.harnessModel, harnessModelKey(meta.config.harness, modelKey), model, delta, meta.id);
      }
    }
    this.scheduleWrite();
  }

  /**
   * Subagent spend queued for model re-attribution. pi folds it into the session totals (once
   * `reportUsage` is on) already attributed to the session's active model, so it is moved here
   * rather than added — day totals keep the money either way; only the model dimension changes.
   */
  private queueSubagentCost(sessionId: string, costs: SubagentCost[]): void {
    const pending = this.pendingSubagentCost.get(sessionId) ?? new Map<string, SubagentCost>();
    for (const c of costs) {
      if (!c.provider || !c.model || !(c.costUsd > 0)) continue;
      const key = `${c.provider}/${c.model}`;
      const cur = pending.get(key) ?? { provider: c.provider, model: c.model, costUsd: 0 };
      cur.costUsd += c.costUsd;
      pending.set(key, cur);
    }
    if (pending.size) this.pendingSubagentCost.set(sessionId, pending);
  }

  /**
   * Moves queued subagent cost off the session's active model and onto the model each run used.
   * Bounded by the active model's own slice so a day can never go negative, and whatever cannot be
   * moved stays queued for a later delta — so the cumulative split converges even when the spend
   * and the completion land in different turns. The harness × model slice carries the same cost,
   * so it moves in lockstep: only the amount both slices can give up is ever moved.
   */
  private flushSubagentCost(meta: SessionMeta, day: UsageDay): void {
    const pending = this.pendingSubagentCost.get(meta.id);
    const active = meta.activeModel;
    if (!pending?.size || !active?.provider || !active.model) return;
    const by = (day.by ??= emptyDimensions());
    const fromKey = `${active.provider}/${active.model}`;
    const from = by.model[fromKey];
    const fromHarness = by.harnessModel[harnessModelKey(meta.config.harness, fromKey)];
    if (!from || !fromHarness) return;
    for (const [key, c] of pending) {
      if (key === fromKey) {
        pending.delete(key);
        continue;
      }
      const moved = Math.min(c.costUsd, from.costUsd, fromHarness.costUsd);
      if (moved <= 0) continue;
      from.costUsd -= moved;
      const to = (by.model[key] ??= emptySlice(modelKeyLabel(key)));
      to.costUsd += moved;
      if (!to.sessions.includes(meta.id)) to.sessions.push(meta.id);
      fromHarness.costUsd -= moved;
      const toHarness = (by.harnessModel[harnessModelKey(meta.config.harness, key)] ??= emptySlice(modelKeyLabel(key)));
      toHarness.costUsd += moved;
      if (!toHarness.sessions.includes(meta.id)) toHarness.sessions.push(meta.id);
      c.costUsd -= moved;
      if (c.costUsd <= 1e-9) pending.delete(key);
    }
    if (pending.size === 0) this.pendingSubagentCost.delete(meta.id);
  }

  /**
   * Records a completed turn's wall time and, when the turn also reported output tokens, its
   * output-speed sample (turn counts come through the usage deltas).
   */
  recordTurn(meta: SessionMeta, turn: Extract<TranscriptItem, { kind: 'turn' }>, now = Date.now()): void {
    // Every terminal turn closes the execution log's turn, whatever its status; only completed turns time anything.
    this.executions.recordTurn(meta.id, turn, this.executionContextOf(meta.config.harness, meta.config.projectRoot, meta.activeModel, undefined, 'live', now));
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
    this.collectToolCall(sessionId, item, now, activeModel, true);
    // The execution log only files calls under a known session: an unknown harness is never guessed.
    const session = this.data.sessions[sessionId];
    if (!session || item.status === 'running') return;
    const sessionModel = session.model ? { provider: session.provider ?? '', model: session.model } : undefined;
    this.executions.recordTool(sessionId, item, this.executionContextOf(session.harness, session.projectRoot, sessionModel, activeModel, 'live', now));
  }

  private rememberTool(key: string): boolean {
    if (this.recordedTools.has(key)) return false;
    this.recordedTools.add(key);
    this.data.recordedTools.push(key);
    if (this.data.recordedTools.length > RECENT_TOOL_LIMIT) this.data.recordedTools.shift();
    return true;
  }

  private collectToolCall(sessionId: string, item: Extract<TranscriptItem, { kind: 'tool' }>, now: number, activeModel: ModelRef | undefined, live: boolean): void {
    const parsed = toolCallFromItem(item);
    if (!parsed || !this.rememberTool(JSON.stringify([sessionId, item.id]))) return;
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
    if (live && session) {
      addToolUsage(((this.data.harnessTools[session.harness] ??= {})[item.name] ??= emptyToolUsage()), parsed.usage);
      addToolUsage((((by.harnessTool ??= {})[session.harness] ??= {})[item.name] ??= emptyToolUsage()), parsed.usage);
    }
    // Prefer the model captured when the call began; transcript backfills fall back to the session snapshot.
    const provider = activeModel?.provider ?? session?.provider;
    const model = activeModel?.model ?? session?.model;
    const modelKey = model ? `${provider ?? ''}/${model}` : undefined;
    if (modelKey) {
      addToolUsage(((this.data.modelTools[modelKey] ??= {})[item.name] ??= emptyToolUsage()), parsed.usage);
      addToolUsage(((by.modelTool[modelKey] ??= {})[item.name] ??= emptyToolUsage()), parsed.usage);
      if (session?.harness) {
        const ownerKey = harnessModelKey(session.harness, modelKey);
        addToolUsage(((this.data.harnessModelTools[ownerKey] ??= {})[item.name] ??= emptyToolUsage()), parsed.usage);
        addToolUsage(((by.harnessModelTool[ownerKey] ??= {})[item.name] ??= emptyToolUsage()), parsed.usage);
      }
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
    await this.executions.flush();
    return this.writeQueue;
  }

  /** Summary over the last `dayLimit` days (0 = all time), with the preceding window for comparison. */
  summary(dayLimit = 30, now = Date.now()): AnalyticsSummary {
    const sessions = Object.values(this.data.sessions);
    return { ...summarize(sessions, this.data.days, this.data.tools, this.data.modelTools, this.data.harnessModelTools, this.data.files, dayLimit, now, this.data.harnessTools), reliability: this.reliability(dayLimit, now), codeOutput: this.codeOutput(dayLimit, now) };
  }

  /** The reliability report for a range, rebuilt only when the log or the day changed. */
  reliability(dayLimit = 30, now = Date.now()): ReliabilityReport {
    const key = `${this.executions.version}:${dayLimit}:${dayKey(now)}`;
    if (this.reliabilityCache?.key === key) return this.reliabilityCache.report;
    const report = reliabilityReport(this.executions.all() as ExecutionRecord[], [...this.executions.allTurns()], {
      now,
      rangeDays: dayLimit,
      retention: this.executions.retention,
      retainedFirstTs: this.executions.retainedFirstTs()
    });
    this.reliabilityCache = { key, report };
    return report;
  }

  /** The code-output report for a range, rebuilt only when the log or the day changed. */
  codeOutput(dayLimit = 30, now = Date.now()): CodeOutputReport {
    const key = `${this.executions.version}:${dayLimit}:${dayKey(now)}`;
    if (this.codeOutputCache?.key === key) return this.codeOutputCache.report;
    const report = codeOutputReport(this.executions.all() as ExecutionRecord[], [...this.executions.allTurns()], {
      now,
      rangeDays: dayLimit,
      retention: this.executions.retention,
      retainedFirstTs: this.executions.retainedFirstTs()
    });
    this.codeOutputCache = { key, report };
    return report;
  }
}
