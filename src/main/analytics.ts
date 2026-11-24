/** Collects usage data into daily buckets and per-session records, powering the analytics dashboard. */
import path from 'node:path';
import type {
  AnalyticsSummary,
  FileUsage,
  ModelRef,
  ProviderConfig,
  SessionMeta,
  SubagentCompletion,
  SubagentCost,
  ToolUsage,
  TranscriptItem,
  UsageCounters,
  UsageDay,
  UsageSessionRecord,
  UsageSpeed,
  UsageTotals
} from '../shared/types';
import { modelKeyLabel, UNKNOWN_MODEL_KEY } from '../shared/model-names';
import { addCounters, addFileUsage, addSlice, addToolUsage, COUNTER_FIELDS, emptyCounters, emptyDimensions, emptyFileUsage, emptyToolUsage, emptySlice, harnessModelKey } from '../shared/usage-rollup';
import { addSpeed, addTotals, dayKey, emptySpeed, summarize, type UsageSummary } from '../shared/analytics/usage-summary';
import { buildAnalyticsSnapshot, SNAPSHOT_RANGES, type AnalyticsSnapshot, type AnalyticsSnapshotMeta, type SnapshotReports } from '../shared/analytics/snapshot';
import { codeOutputReport, type CodeOutputReport } from '../shared/analytics/code-output';
import type { ExecutionRecord } from '../shared/analytics/records';
import { reliabilityReport, type ReliabilityReport } from '../shared/analytics/reliability';
import { ExecutionLog, type ExecutionContext, type ExecutionQuery } from './analytics-executions';
import {
  apportion,
  attribute,
  estimateDaySlices,
  estimateLegacyDays,
  migrateClaudeFallbackSpend,
  migrateCodexCachedInput,
  reconcileForkInheritedSpend,
  recoverHarnessModelDays,
  usageDelta,
  type AnalyticsFile,
  type Attribution
} from './analytics-migrations';
import type { ForkInheritance } from './util/usage-repair';
import { readJson, writeJson } from './util/fs';

export { emptyFileUsage, emptyToolUsage };
export { addTotals, dayKey, emptySpeed, summarize, type UsageSummary };
export { EXECUTION_RETENTION } from './analytics-executions';
export {
  apportion,
  attribute,
  estimateDaySlices,
  migrateClaudeFallbackSpend,
  migrateCodexCachedInput,
  reconcileForkInheritedSpend,
  usageDelta,
  type AnalyticsFile
};

const EMPTY_FILE: AnalyticsFile = {
  version: 2,
  days: {},
  recorded: {},
  sessions: {},
  tools: {},
  modelTools: {},
  harnessModelTools: {},
  harnessTools: {},
  recordedTools: [],
  recordedUserInputs: [],
  scannedTranscripts: {},
  files: {}
};

/** Older calls remain deduped in memory; only this recent window survives restart. */
const RECENT_TOOL_LIMIT = 10_000;

/** Synthetic tool name for a subagent's internal calls, which pi never puts in the parent transcript. */
export const SUBAGENT_TOOL = 'subagent';

const EMPTY_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

export function emptyDay(): UsageDay {
  return emptyCounters();
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

/** Adds `delta` into `day` in place; unknown fields are ignored so old files load cleanly. */
export function addDay(day: UsageDay, delta: Partial<UsageDay>): void {
  addCounters(day, delta);
}

function attributionOf(meta: SessionMeta): Attribution {
  return { id: meta.id, harness: meta.config.harness, provider: meta.activeModel?.provider, model: meta.activeModel?.model, projectRoot: meta.config.projectRoot };
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

export interface AnalyticsDeps {
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Test hooks for the execution log's environment stamp and retention. */
  executionLog?: { platform?: string; release?: string; arch?: string; retention?: { maxRecords: number; maxDays: number } };
}

/** Reads back a session's transcript so sessions predating the store can be backfilled. */
export type TranscriptReader = (sessionId: string) => Promise<TranscriptItem[]>;

/** Returns a file-level revision stamp for a session's transcript, or `null` when unavailable. */
export type TranscriptStampReader = (sessionId: string) => Promise<string | null>;

export interface AnalyticsLoadOptions {
  /**
   * Optional transcript-file stat stamp reader (`size:mtimeMs:ctimeMs`). When supplied, startup
   * replay skips re-reading already-backfilled transcripts whose on-disk file has not changed
   * since the last persisted scan.
   */
  transcriptStamp?: TranscriptStampReader;
}

export class AnalyticsStore {
  private data: AnalyticsFile = {
    ...EMPTY_FILE,
    days: {},
    recorded: {},
    sessions: {},
    tools: {},
    modelTools: {},
    harnessModelTools: {},
    harnessTools: {},
    recordedTools: [],
    recordedUserInputs: [],
    scannedTranscripts: {},
    files: {}
  };
  private readonly file: string;
  private writeTimer: NodeJS.Timeout | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  /** Tool item ids already counted, so repeated upserts of one call never double-record. */
  private recordedTools = new Set<string>();
  private recordedUserInputs = new Set<string>();
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
  async load(
    existing: SessionMeta[],
    readTranscript?: TranscriptReader,
    providers: ProviderConfig[] = [],
    options?: AnalyticsLoadOptions
  ): Promise<void> {
    const stored = await readJson<Partial<AnalyticsFile> | undefined>(this.file, undefined, { log: this.deps.log });
    const storedVersion = stored?.version ?? 1;
    const fromV1 = storedVersion < 2;
    // Stays at 2 until the sweep reports back, so a run interrupted partway retries rather than
    // leaving the sessions it never reached charged for someone else's work.
    this.forkSweepPending = storedVersion < 3;
    const scannedTranscripts: Record<string, string> = {};
    if (stored?.scannedTranscripts && typeof stored.scannedTranscripts === 'object') {
      for (const [id, stamp] of Object.entries(stored.scannedTranscripts)) {
        if (typeof stamp === 'string' && stamp) scannedTranscripts[id] = stamp;
      }
    }
    this.data = {
      version: this.forkSweepPending ? 2 : 3,
      days: stored?.days && typeof stored.days === 'object' ? stored.days : {},
      recorded: stored?.recorded && typeof stored.recorded === 'object' ? stored.recorded : {},
      sessions: stored?.sessions && typeof stored.sessions === 'object' ? stored.sessions : {},
      tools: stored?.tools && typeof stored.tools === 'object' ? stored.tools : {},
      modelTools: stored?.modelTools && typeof stored.modelTools === 'object' ? stored.modelTools : {},
      harnessTools: stored?.harnessTools && typeof stored.harnessTools === 'object' ? stored.harnessTools : {},
      recordedTools: Array.isArray(stored?.recordedTools) ? stored.recordedTools.filter((key) => typeof key === 'string').slice(-RECENT_TOOL_LIMIT) : [],
      recordedUserInputs: Array.isArray(stored?.recordedUserInputs) ? stored.recordedUserInputs.filter((key) => typeof key === 'string') : [],
      scannedTranscripts,
      harnessModelTools: stored?.harnessModelTools && typeof stored.harnessModelTools === 'object' ? stored.harnessModelTools : {},
      files: stored?.files && typeof stored.files === 'object' ? stored.files : {},
      harnessVersions: stored?.harnessVersions && typeof stored.harnessVersions === 'object' ? stored.harnessVersions : {}
    };
    this.recordedTools = new Set(this.data.recordedTools);
    this.recordedUserInputs = new Set(this.data.recordedUserInputs);
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
    const estimated = estimateLegacyDays(this.data);
    if (estimated) this.deps.log('info', `analytics: estimated per-model slices for ${estimated} day(s) recorded before slice tracking`);
    const recovered = recoverHarnessModelDays(this.data);
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
    if (readTranscript) this.backfill = this.backfillExecutions(existing, readTranscript, options?.transcriptStamp);
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
   * Replays each known session's transcript into the execution log once and recovers any
   * host user-input receipts that survived a crash before `analytics.json` flushed.
   *
   * When `transcriptStamp` is provided, already-backfilled transcripts whose on-disk file stamp
   * (`size:mtimeMs:ctimeMs`) matches the last atomically persisted scan are skipped — avoiding an
   * unbounded full-history parse on every boot while preserving crash recovery (because any
   * persisted append changes the transcript file itself, independent of `meta.updatedAt`).
   */
  private async backfillExecutions(
    existing: SessionMeta[],
    readTranscript: TranscriptReader,
    transcriptStamp?: TranscriptStampReader
  ): Promise<void> {
    let sessions = 0;
    let records = 0;
    const started = Date.now();
    let dirty = false;
    const scanned = (this.data.scannedTranscripts ??= {});
    if (transcriptStamp) {
      const liveIds = new Set(existing.map((meta) => meta.id));
      for (const id of Object.keys(scanned)) {
        if (!liveIds.has(id)) {
          delete scanned[id];
          dirty = true;
        }
      }
    }
    for (const meta of existing) {
      const replayExecutions = !this.executions.isBackfilled(meta.id);
      const stampBefore = transcriptStamp ? await transcriptStamp(meta.id).catch(() => null) : null;
      if (!replayExecutions && stampBefore !== null && scanned[meta.id] === stampBefore) {
        continue;
      }
      let items: TranscriptItem[];
      try {
        items = await readTranscript(meta.id);
      } catch {
        this.deps.log('warn', `analytics: could not read transcript of ${meta.id} for replay`);
        continue;
      }
      if (this.recordUserInputs(meta, items) > 0) dirty = true;
      if (replayExecutions) {
        const count = this.executions.backfillTranscript(meta.id, items, this.executionContextOf(meta.config.harness, meta.config.projectRoot, meta.activeModel));
        await this.executions.markBackfilled(meta.id, count);
        sessions++;
        records += count;
      }
      if (transcriptStamp && stampBefore !== null) {
        const stampAfter = await transcriptStamp(meta.id).catch(() => null);
        // Only commit the stamp if the transcript did not change while we were reading it.
        if (stampAfter === stampBefore && scanned[meta.id] !== stampBefore) {
          scanned[meta.id] = stampBefore;
          dirty = true;
        }
      }
      // Yield between sessions so a large history never starves the event loop.
      await new Promise((r) => setImmediate(r));
    }
    if (dirty) await this.flush();
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

  /** Opens the next execution turn; only a host receipt contributes user-entered text. */
  recordUserMessage(meta: SessionMeta, item: Extract<TranscriptItem, { kind: 'user' }>, now = Date.now()): void {
    this.collectUserInput(meta, item);
    this.executions.recordUser(meta.id, item, this.executionContextOf(meta.config.harness, meta.config.projectRoot, meta.activeModel, undefined, 'live', now));
  }

  /** Receipt-only recovery, also used before a transcript is cleared, deleted or rewound. */
  recordUserInputs(meta: SessionMeta, items: TranscriptItem[]): number {
    let added = 0;
    for (const item of items) {
      if (item.kind === 'user' && this.collectUserInput(meta, item)) added++;
    }
    return added;
  }

  private collectUserInput(meta: SessionMeta, item: Extract<TranscriptItem, { kind: 'user' }>): boolean {
    const receipt = item.userInput;
    if (!receipt || receipt.sessionId !== meta.id || typeof receipt.id !== 'string' || !receipt.id) return false;
    if (!Number.isSafeInteger(receipt.tokens) || receipt.tokens <= 0 || !Number.isFinite(receipt.ts) || !Number.isFinite(new Date(receipt.ts).getTime())) return false;
    const key = JSON.stringify([meta.id, receipt.id]);
    if (this.recordedUserInputs.has(key)) return false;
    this.recordedUserInputs.add(key);
    this.data.recordedUserInputs.push(key);
    const day = this.dayFor(dayKey(receipt.ts));
    const delta = { userInputTokens: receipt.tokens };
    addDay(day, delta);
    attribute(day, attributionOf(meta), delta);
    this.scheduleWrite();
    return true;
  }

  /** Representative executions for a dashboard drill-down. */
  queryExecutions(query: ExecutionQuery, now = Date.now()): ExecutionRecord[] {
    return this.executions.query(query, now);
  }

  /** Aggregates completed tool calls from an old transcript into the store, one-time per session. */
  private async backfillTranscript(sessionId: string, dayTs: number, readTranscript: TranscriptReader): Promise<void> {
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
      const modelKey = completion.model === null ? UNKNOWN_MODEL_KEY : completion.model?.model ? `${completion.model.provider}/${completion.model.model}` : undefined;
      if (modelKey) {
        const by = (day.by ??= emptyDimensions());
        addSlice(by.model, modelKey, modelKeyLabel(modelKey), delta, meta.id);
        addSlice(by.harnessModel, harnessModelKey(meta.config.harness, modelKey), modelKeyLabel(modelKey), delta, meta.id);
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
      if (!(c.costUsd > 0) || !Number.isFinite(c.costUsd)) continue;
      const unknown = c.provider === null && c.model === null;
      if (!unknown && (!c.provider || !c.model)) continue;
      const key = unknown ? UNKNOWN_MODEL_KEY : `${c.provider}/${c.model}`;
      const cur = pending.get(key) ?? { ...c, costUsd: 0 };
      cur.costUsd += c.costUsd;
      pending.set(key, cur);
    }
    if (pending.size) this.pendingSubagentCost.set(sessionId, pending);
  }

  /**
   * Moves queued subagent cost off the session's active model and onto the model each run used
   * (or the explicit unknown slice when a legacy name could not identify a single model).
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

  /** Strict callers must persist accounting before removing its transcript recovery source. */
  async flush(strict = false): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const write = this.writeQueue.then(() => writeJson(this.file, this.data));
    this.writeQueue = write.catch((e) => this.deps.log('warn', `analytics write failed: ${String(e)}`));
    await this.executions.flush();
    return strict ? write : this.writeQueue;
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

  /**
   * The projected snapshot code.vocs.io's dashboard is built from (docs/WEB-DASHBOARD.md): folder
   * names instead of project roots, no file paths or receipts, and the reports for every range.
   */
  snapshot(meta: Omit<AnalyticsSnapshotMeta, 'generatedAt'>, now = Date.now()): AnalyticsSnapshot {
    const reports: Record<string, SnapshotReports> = {};
    for (const range of SNAPSHOT_RANGES) reports[String(range)] = { reliability: this.reliability(range, now), codeOutput: this.codeOutput(range, now) };
    const d = this.data;
    return buildAnalyticsSnapshot({ days: d.days, sessions: Object.values(d.sessions), tools: d.tools, modelTools: d.modelTools, harnessTools: d.harnessTools, harnessModelTools: d.harnessModelTools, reports }, { ...meta, generatedAt: now });
  }
}
