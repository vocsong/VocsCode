/**
 * Execution log behind the reliability analytics: one record per finished tool call and one per
 * agent turn, kept as JSONL beside analytics.json. Raw facts and derived classification are stored
 * side by side; when the classifier version moves, every record is re-derived from its facts on load
 * and the file is rewritten, so history is never reinterpreted silently.
 *
 * Retention is bounded (records and days). Long-horizon totals live in the day buckets of the
 * usage store; this log answers the questions that need individual executions: signatures,
 * incidents, recovery, drill-down.
 */
import os from 'node:os';
import path from 'node:path';
import type { ModelRef, SubagentCompletion, TranscriptItem } from '../shared/types';
import { classifyExecution, deriveOutcome, type ExecutionFacts } from '../shared/analytics/classify';
import { addedLinesOf } from '../shared/analytics/lines';
import { EXECUTION_RETENTION, modelKeyOf, usageTokens, type ExecutionRecord, type IngestKind, type TurnRecord, type TurnUsageFacts } from '../shared/analytics/records';
import { ANALYTICS_SCHEMA_VERSION, OUTCOME_CLASSIFIER_VERSION } from '../shared/analytics/taxonomy';
import { appendLine, readJson, readJsonl, writeJson, writeText } from './util/fs';

export { EXECUTION_RETENTION };

export interface ExecutionLogDeps {
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Overridable for tests; default to the running process. */
  platform?: string;
  release?: string;
  arch?: string;
  retention?: { maxRecords: number; maxDays: number };
}

/** What the log needs to know about the session a call belongs to. */
export interface ExecutionContext {
  harness: string;
  projectRoot: string;
  /** The session's active model (the parent agent's). */
  activeModel?: ModelRef;
  /** The model captured when the call began, when the manager tracked it. */
  model?: ModelRef;
  harnessVersion?: string;
  ingest: IngestKind;
  now: number;
}

interface LogMeta {
  version: number;
  classifierVersion: number;
  /** Sessions whose transcripts were replayed into the log, with the count of items taken. */
  backfilled: Record<string, number>;
}

type Line = ({ k: 'x' } & ExecutionRecord) | ({ k: 't' } & TurnRecord);

export type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;
export type TurnItem = Extract<TranscriptItem, { kind: 'turn' }>;
export type UserItem = Extract<TranscriptItem, { kind: 'user' }>;

export interface ExecutionQuery {
  ids?: string[];
  signature?: string;
  sessionId?: string;
  /** Only records started within the last `days` days; 0 or absent = all retained. */
  days?: number;
  limit?: number;
}

export class ExecutionLog {
  private records: ExecutionRecord[] = [];
  private turns: TurnRecord[] = [];
  private ids = new Set<string>();
  private turnIndex = new Map<string, number>();
  private openTurns = new Map<string, TurnRecord>();
  private meta: LogMeta = { version: ANALYTICS_SCHEMA_VERSION, classifierVersion: OUTCOME_CLASSIFIER_VERSION, backfilled: {} };
  private pending: string[] = [];
  private writeTimer: NodeJS.Timeout | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly metaFile: string;
  private readonly osKey: string;
  private readonly arch: string;
  private readonly platform: string;
  readonly retention: { maxRecords: number; maxDays: number };
  /** Increments on every accepted record, so a summary cache can tell whether anything changed. */
  version = 0;

  constructor(userData: string, private readonly deps: ExecutionLogDeps) {
    this.file = path.join(userData, 'analytics-executions.jsonl');
    this.metaFile = path.join(userData, 'analytics-executions.meta.json');
    this.platform = deps.platform ?? process.platform;
    this.osKey = `${this.platform}-${deps.release ?? os.release()}`;
    this.arch = deps.arch ?? process.arch;
    this.retention = deps.retention ?? EXECUTION_RETENTION;
  }

  /** Loads the log, reclassifies records written by an older classifier, and applies retention. */
  async load(): Promise<void> {
    const meta = await readJson<Partial<LogMeta> | undefined>(this.metaFile, undefined, { log: this.deps.log });
    this.meta = {
      version: ANALYTICS_SCHEMA_VERSION,
      classifierVersion: typeof meta?.classifierVersion === 'number' ? meta.classifierVersion : OUTCOME_CLASSIFIER_VERSION,
      backfilled: meta?.backfilled && typeof meta.backfilled === 'object' ? meta.backfilled : {}
    };
    const lines = await readJsonl<Partial<Line>>(this.file, { log: this.deps.log });
    const records = new Map<string, ExecutionRecord>();
    const turns = new Map<string, TurnRecord>();
    let reclassified = 0;
    for (const line of lines) {
      if (!line || typeof line !== 'object' || typeof line.id !== 'string') continue;
      if (line.k === 'x') {
        const r = line as ExecutionRecord;
        if (!r.facts || typeof r.facts !== 'object' || typeof r.ts !== 'number') continue;
        if (!r.derived || r.derived.classifier !== OUTCOME_CLASSIFIER_VERSION) {
          r.derived = deriveOutcome(r.facts);
          reclassified++;
        }
        records.set(r.id, stripKind(r));
      } else if (line.k === 't') {
        const t = line as TurnRecord;
        if (typeof t.startTs !== 'number' || typeof t.turn !== 'number') continue;
        turns.set(t.id, stripKind(t));
      }
    }
    this.records = [...records.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    this.turns = [...turns.values()].sort((a, b) => a.startTs - b.startTs || a.id.localeCompare(b.id));
    const pruned = this.prune(Date.now());
    this.ids = new Set(this.records.map((r) => r.id));
    for (const t of this.turns) {
      this.turnIndex.set(t.sessionId, Math.max(this.turnIndex.get(t.sessionId) ?? 0, t.turn));
      if (t.status === 'open') this.openTurns.set(t.sessionId, t);
    }
    const duplicates = lines.length - records.size - turns.size;
    if (reclassified) this.deps.log('info', `analytics: reclassified ${reclassified} execution record(s) with outcome classifier v${OUTCOME_CLASSIFIER_VERSION}`);
    if (reclassified || pruned || duplicates > 0) await this.rewrite();
    if (this.meta.classifierVersion !== OUTCOME_CLASSIFIER_VERSION) {
      this.meta.classifierVersion = OUTCOME_CLASSIFIER_VERSION;
      await this.saveMeta();
    }
  }

  /** Drops records past the retention window; returns how many went. */
  private prune(now: number): number {
    const cutoff = now - this.retention.maxDays * 86_400_000;
    const before = this.records.length + this.turns.length;
    this.records = this.records.filter((r) => r.ts >= cutoff);
    if (this.records.length > this.retention.maxRecords) this.records = this.records.slice(this.records.length - this.retention.maxRecords);
    const oldest = this.records[0]?.ts ?? cutoff;
    this.turns = this.turns.filter((t) => t.startTs >= Math.min(cutoff, oldest));
    return before - (this.records.length + this.turns.length);
  }

  /** Whether the session's transcript has already been replayed into the log. */
  isBackfilled(sessionId: string): boolean {
    return this.meta.backfilled[sessionId] !== undefined;
  }

  /** Marks a session replayed once its records are on disk, so a crash in between replays rather than loses. */
  async markBackfilled(sessionId: string, count: number): Promise<void> {
    await this.flush();
    this.meta.backfilled[sessionId] = count;
    await this.saveMeta();
  }

  /** Every retained execution, oldest first. */
  all(): readonly ExecutionRecord[] {
    return this.records;
  }

  allTurns(): readonly TurnRecord[] {
    return this.turns;
  }

  /** Start of the oldest retained record, for "the log begins here" notes. */
  retainedFirstTs(): number | undefined {
    return this.records[0]?.ts;
  }

  query(q: ExecutionQuery, now = Date.now()): ExecutionRecord[] {
    const ids = q.ids ? new Set(q.ids) : undefined;
    const cutoff = q.days && q.days > 0 ? now - q.days * 86_400_000 : -Infinity;
    const out: ExecutionRecord[] = [];
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (ids && !ids.has(r.id)) continue;
      if (q.signature !== undefined && r.derived.signature !== q.signature) continue;
      if (q.sessionId !== undefined && r.sessionId !== q.sessionId) continue;
      if (r.ts < cutoff) continue;
      out.push(r);
      if (out.length >= (q.limit ?? 50)) break;
    }
    return out;
  }

  /** Records a finished tool call once; a running item or a repeat of a known id records nothing. */
  recordTool(sessionId: string, item: ToolItem, ctx: ExecutionContext): ExecutionRecord | null {
    if (item.status === 'running') return null;
    const id = `${sessionId}:${item.id}`;
    if (this.ids.has(id)) return null;
    const { facts, derived } = classifyExecution({
      harness: ctx.harness,
      tool: item.name,
      hint: item.hint,
      status: item.status,
      exitCode: item.exitCode,
      output: item.output,
      input: item.input,
      durationMs: item.durationMs,
      platform: this.platform
    });
    const attribution = attributeModel(item, ctx);
    const record: ExecutionRecord = {
      v: ANALYTICS_SCHEMA_VERSION,
      id,
      sessionId,
      ts: item.ts,
      endTs: ctx.ingest === 'live' ? ctx.now : item.ts + (item.durationMs ?? 0),
      harness: ctx.harness,
      harnessVersion: ctx.harnessVersion,
      model: attribution.model,
      parentModel: attribution.parentModel,
      role: item.parentId ? 'subagent' : 'parent',
      projectRoot: ctx.projectRoot,
      os: this.osKey,
      arch: this.arch,
      turn: this.turnIndex.get(sessionId) ?? 0,
      ingest: ctx.ingest,
      facts,
      derived,
      addedLines: addedLinesOf(item.changes)
    };
    this.push(record);
    return record;
  }

  /**
   * Records a finished pi subagent run as one delegated-work summary. Its internal tool calls never
   * reach the transcript, so they carry `weight` and stay out of the execution denominators.
   */
  recordSubagent(sessionId: string, completion: SubagentCompletion, ctx: ExecutionContext): ExecutionRecord | null {
    const id = `${sessionId}:subagent:${completion.agentId}`;
    if (this.ids.has(id)) return null;
    const status: ExecutionFacts['status'] = completion.status === 'completed' ? 'done' : 'error';
    const { facts, derived } = classifyExecution({
      harness: ctx.harness,
      tool: 'subagent',
      hint: 'agent',
      status,
      output: completion.status === 'completed' ? undefined : `Subagent ${completion.status}${completion.error ? `: ${completion.error}` : ''}${/^(?:stopped|aborted|cancelled)$/i.test(completion.status) ? '\nCommand aborted' : ''}`,
      durationMs: completion.durationMs,
      platform: this.platform
    });
    const record: ExecutionRecord = {
      v: ANALYTICS_SCHEMA_VERSION,
      id,
      sessionId,
      ts: ctx.now - Math.max(0, completion.durationMs ?? 0),
      endTs: ctx.now,
      harness: ctx.harness,
      harnessVersion: ctx.harnessVersion,
      model: modelKeyOf(completion.model) ?? modelKeyOf(ctx.activeModel),
      parentModel: completion.model && modelKeyOf(completion.model) !== modelKeyOf(ctx.activeModel) ? modelKeyOf(ctx.activeModel) : undefined,
      role: 'subagent',
      projectRoot: ctx.projectRoot,
      os: this.osKey,
      arch: this.arch,
      turn: this.turnIndex.get(sessionId) ?? 0,
      ingest: ctx.ingest,
      facts,
      derived,
      weight: Math.max(0, Math.floor(completion.toolUses))
    };
    this.push(record);
    return record;
  }

  /**
   * A user message starts a turn unless it was queued into a running one (steer / follow-up). A turn
   * still open when the next one starts stays `open`: its end was never observed.
   */
  recordUser(sessionId: string, item: UserItem, ctx: ExecutionContext): TurnRecord | null {
    const open = this.openTurns.get(sessionId);
    if (item.queuedAs && open) return null;
    const turn = (this.turnIndex.get(sessionId) ?? 0) + 1;
    this.turnIndex.set(sessionId, turn);
    const record: TurnRecord = {
      v: ANALYTICS_SCHEMA_VERSION,
      id: `${sessionId}:turn:${turn}`,
      sessionId,
      turn,
      harness: ctx.harness,
      model: modelKeyOf(ctx.model ?? ctx.activeModel),
      projectRoot: ctx.projectRoot,
      startTs: item.ts,
      status: 'open',
      ingest: ctx.ingest
    };
    this.openTurns.set(sessionId, record);
    this.turns.push(record);
    this.enqueue({ k: 't', ...record });
    return record;
  }

  /** Closes the session's open turn with the harness's verdict; a turn without a known start gets one. */
  recordTurn(sessionId: string, item: TurnItem, ctx: ExecutionContext): TurnRecord {
    let record = this.openTurns.get(sessionId);
    const endTs = ctx.ingest === 'live' ? ctx.now : item.ts;
    if (!record) {
      const turn = (this.turnIndex.get(sessionId) ?? 0) + 1;
      this.turnIndex.set(sessionId, turn);
      record = {
        v: ANALYTICS_SCHEMA_VERSION,
        id: `${sessionId}:turn:${turn}`,
        sessionId,
        turn,
        harness: ctx.harness,
        model: modelKeyOf(ctx.model ?? ctx.activeModel),
        projectRoot: ctx.projectRoot,
        startTs: endTs - Math.max(0, item.durationMs ?? 0),
        status: 'open',
        ingest: ctx.ingest
      };
      this.turns.push(record);
    }
    record.status = item.status;
    record.endTs = endTs;
    const usage = turnUsageFacts(item);
    if (usage) record.usage = usage;
    this.openTurns.delete(sessionId);
    this.enqueue({ k: 't', ...record });
    this.version++;
    return record;
  }

  /**
   * Replays a stored transcript in timestamp order so executions land in their turns. Returns the
   * number of executions taken; the caller marks the session backfilled.
   */
  backfillTranscript(sessionId: string, items: TranscriptItem[], ctx: Omit<ExecutionContext, 'ingest' | 'now'>): number {
    const ordered = items
      .filter((it) => it.kind === 'tool' || it.kind === 'turn' || it.kind === 'user')
      .map((it, i) => ({ it, i }))
      .sort((a, b) => a.it.ts - b.it.ts || a.i - b.i);
    let count = 0;
    for (const { it } of ordered) {
      const c: ExecutionContext = { ...ctx, ingest: 'backfill', now: it.ts };
      if (it.kind === 'user') this.recordUser(sessionId, it, c);
      else if (it.kind === 'turn') this.recordTurn(sessionId, it, c);
      else if (it.status !== 'running' && this.recordTool(sessionId, it, c)) count++;
    }
    return count;
  }

  private push(record: ExecutionRecord): void {
    this.ids.add(record.id);
    this.records.push(record);
    this.version++;
    this.enqueue({ k: 'x', ...record });
  }

  private enqueue(line: Line): void {
    this.pending.push(JSON.stringify(line));
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, 500);
  }

  /** Appends everything queued; a failed append keeps the lines for the next attempt. */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.pending.length === 0) return this.writeQueue;
    const lines = this.pending;
    this.pending = [];
    this.writeQueue = this.writeQueue
      .then(() => appendLine(this.file, lines.join('\n')))
      .catch((e) => {
        this.pending = [...lines, ...this.pending];
        this.deps.log('warn', `analytics: execution log append failed: ${String(e)}`);
      });
    return this.writeQueue;
  }

  /** Rewrites the whole file from memory (after reclassification or pruning). */
  private async rewrite(): Promise<void> {
    const lines: string[] = [];
    for (const t of this.turns) lines.push(JSON.stringify({ k: 't', ...t }));
    for (const r of this.records) lines.push(JSON.stringify({ k: 'x', ...r }));
    this.writeQueue = this.writeQueue.then(() => writeText(this.file, lines.length ? `${lines.join('\n')}\n` : '')).catch((e) => this.deps.log('warn', `analytics: execution log rewrite failed: ${String(e)}`));
    return this.writeQueue;
  }

  private async saveMeta(): Promise<void> {
    try {
      await writeJson(this.metaFile, this.meta);
    } catch (e) {
      this.deps.log('warn', `analytics: execution log meta write failed: ${String(e)}`);
    }
  }
}

function stripKind<T extends object>(line: T & { k?: string }): T {
  const { k, ...rest } = line;
  void k;
  return rest as T;
}

/**
 * The model charged with a call. Claude reports the generating model on each message, so a
 * subagent's call names the subagent's model and keeps the parent's beside it; other harnesses
 * only know the session's active model.
 */
function attributeModel(item: ToolItem, ctx: ExecutionContext): { model?: string; parentModel?: string } {
  const parent = ctx.model ?? ctx.activeModel;
  const parentKey = modelKeyOf(parent);
  if (item.model && parent && item.model !== parent.model) return { model: `${parent.provider}/${item.model}`, parentModel: parentKey };
  if (item.model && !parent) return { model: `/${item.model}` };
  return { model: parentKey };
}

/**
 * The token facts of a finished turn, or undefined when the harness reported nothing.
 *
 * Cost alone is enough to store them: a harness can report what a turn cost without reporting the
 * counters behind it (Claude's `total_cost_usd` without `modelUsage`), and that cost belongs in the
 * ledger. A turn that reported nothing but zeros is unmeasured instead, so it can never be mistaken
 * for a turn that genuinely cost nothing.
 */
function turnUsageFacts(item: TurnItem): TurnUsageFacts | undefined {
  if (!item.usage && typeof item.costUsd !== 'number') return undefined;
  const usage = item.usage;
  const counter = (value: number | undefined): number => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0);
  const facts: TurnUsageFacts = {
    inputTokens: counter(usage?.inputTokens),
    outputTokens: counter(usage?.outputTokens),
    cacheReadTokens: counter(usage?.cacheReadTokens),
    cacheWriteTokens: counter(usage?.cacheWriteTokens),
    costUsd: counter(item.costUsd)
  };
  return usageTokens(facts) > 0 || facts.costUsd > 0 ? facts : undefined;
}
