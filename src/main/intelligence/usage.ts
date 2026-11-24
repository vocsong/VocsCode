import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import {
  KNOWLEDGE_USAGE_LATENCY_MS, KNOWLEDGE_USAGE_SOURCES, type KnowledgeUsageDays, type KnowledgeUsageLatency,
  type KnowledgeUsageLookup, type KnowledgeUsageOutcome, type KnowledgeUsageReport, type KnowledgeUsageSource,
  type KnowledgeUsageSurface, type KnowledgeUsageTotals, type KnowledgeUsageVote, type RecentKnowledgeLookup
} from '../../shared/knowledge-usage';
import type { Logger } from '../log';
import { readJson, writeJson } from '../util/fs';
import { normalizeRoot } from './registry';

export interface KnowledgeUsageSample {
  outcome: KnowledgeUsageOutcome;
  sources?: readonly KnowledgeUsageSource[];
  staleGraph?: boolean;
  truncated?: boolean;
  responseBytes?: number;
}

export type FinishKnowledgeLookup = (sample: KnowledgeUsageSample) => string | undefined;

type Scope = { projectRoot: string; sessionId: string };
const DAY_MS = 86_400_000;
const RETAIN_DAYS = 30;
const RECEIPT_MS = 60 * 60_000;
const MAX_RECEIPTS = 256;
const MAX_PROJECTS = 128;
const HISTOGRAM_SIZE = KNOWLEDGE_USAGE_LATENCY_MS.length + 1;
const count = z.number().int().nonnegative();
const counters = z.object({
  hit: count, empty: count, failed: count, helped: count, notHelpful: count, staleGraph: count, truncated: count,
  sources: z.partialRecord(z.enum(KNOWLEDGE_USAGE_SOURCES), count),
  latency: z.array(count).length(HISTOGRAM_SIZE),
  responseBytes: count
});
type Counters = z.infer<typeof counters>;
const bucket = z.object({ day: count, desktop: counters.optional(), agent: counters.optional() });
type Bucket = z.infer<typeof bucket>;
const projectState = z.object({ enabled: z.boolean(), days: z.array(bucket).max(RETAIN_DAYS) });
type Project = z.infer<typeof projectState>;
const usageFile = z.object({ version: z.literal(1), projects: z.record(z.string().regex(/^[0-9a-f]{64}$/), projectState) });

interface Receipt extends RecentKnowledgeLookup {
  project: string;
  sessionId: string;
  surface: KnowledgeUsageSurface;
  day: number;
}

function empty(): Counters {
  return { hit: 0, empty: 0, failed: 0, helped: 0, notHelpful: 0, staleGraph: 0, truncated: 0, sources: {}, latency: Array<number>(HISTOGRAM_SIZE).fill(0), responseBytes: 0 };
}

function totals(project: Project | undefined, surface: KnowledgeUsageSurface, today: number, days: KnowledgeUsageDays): KnowledgeUsageTotals {
  const total = empty();
  for (const bucket of project?.days ?? []) {
    const value = bucket[surface];
    if (!value || bucket.day <= today - days || bucket.day > today) continue;
    for (const key of ['hit', 'empty', 'failed', 'helped', 'notHelpful', 'staleGraph', 'truncated', 'responseBytes'] as const) total[key] += value[key];
    for (const source of KNOWLEDGE_USAGE_SOURCES) {
      if (value.sources[source]) total.sources[source] = (total.sources[source] ?? 0) + value.sources[source];
    }
    value.latency.forEach((n, i) => { total.latency[i] += n; });
  }
  const { latency, responseBytes, ...rest } = total;
  const calls = total.hit + total.empty + total.failed;
  const responses = total.hit + total.empty;
  const percentile = (p: number): KnowledgeUsageLatency => {
    let rank = Math.ceil(calls * p);
    for (let i = 0; i < latency.length; i++) {
      rank -= latency[i];
      if (rank <= 0) return KNOWLEDGE_USAGE_LATENCY_MS[i] ?? 'overflow';
    }
    return null;
  };
  return {
    ...rest, p50: calls ? percentile(0.5) : null, p95: calls >= 20 ? percentile(0.95) : null,
    meanResponseBytes: surface === 'agent' && responses ? Math.round(responseBytes / responses) : null
  };
}

function keyFor(root: string): string {
  // The held session's project root links its worktrees without storing the path or touching Git.
  return createHash('sha256').update(normalizeRoot(root)).digest('hex');
}

/** Daily counters only. Request data and ratings' correlation handles never enter the file. */
export class KnowledgeUsage {
  private readonly file: string;
  private readonly projects = new Map<string, Project>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly changing = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private writer = Promise.resolve();
  private dirty = false;
  private closed = false;

  constructor(dir: string, private readonly deps: { log: Logger; now?: () => number; clock?: () => number; persist?: typeof writeJson }) {
    this.file = path.join(dir, 'knowledge-usage.json');
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private clock(): number { return this.deps.clock?.() ?? performance.now(); }
  private today(): number { return Math.floor(this.now() / DAY_MS); }

  async load(): Promise<void> {
    const raw = await readJson<unknown>(this.file, null, { log: () => this.deps.log('warn', 'knowledge usage: could not read local counters') });
    if (raw === null) return;
    const parsed = usageFile.safeParse(raw);
    if (!parsed.success || Object.keys(parsed.data.projects).length > MAX_PROJECTS) {
      this.deps.log('warn', 'knowledge usage: unrecognized local counters; collection stays off');
      return;
    }
    for (const [key, value] of Object.entries(parsed.data.projects)) this.projects.set(key, value);
    if (this.prune()) this.schedule();
  }

  private prune(): boolean {
    const cutoff = this.today() - RETAIN_DAYS;
    let changed = false;
    for (const [key, project] of this.projects) {
      const count = project.days.length;
      project.days = project.days.filter(({ day }) => day > cutoff);
      if (project.days.length < count) changed = true;
      if (!project.enabled && !project.days.length) {
        this.projects.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  /** No async work, hashing of questions or event creation when no project has opted in. */
  begin(scope: Scope, surface: KnowledgeUsageSurface, lookup: KnowledgeUsageLookup): FinishKnowledgeLookup | undefined {
    if (this.closed || !this.projects.size) return;
    const key = keyFor(scope.projectRoot);
    const project = this.projects.get(key);
    if (!project?.enabled || this.changing.has(key)) return;
    const start = this.clock();
    let done = false;
    return (sample) => {
      // A toggle/clear, including off → on, fences requests begun under the old project state.
      if (done || this.closed || this.projects.get(key) !== project || this.changing.has(key)) return;
      done = true;
      const elapsed = this.clock() - start;
      const endedAt = this.now();
      const day = Math.floor(endedAt / DAY_MS);
      let row = project.days.find((b) => b.day === day);
      if (!row) {
        this.prune();
        row = { day };
        project.days.push(row);
        // A wall clock correction cannot make the persisted window unbounded.
        project.days.sort((a, b) => a.day - b.day);
        if (project.days.length > RETAIN_DAYS) project.days.pop();
      }
      const counts = row[surface] ??= empty();
      counts[sample.outcome]++;
      const bin = KNOWLEDGE_USAGE_LATENCY_MS.findIndex((upper) => elapsed <= upper);
      counts.latency[bin < 0 ? HISTOGRAM_SIZE - 1 : bin]++;
      if (sample.staleGraph) counts.staleGraph++;
      if (sample.truncated) counts.truncated++;
      if (sample.outcome !== 'failed' && sample.responseBytes) counts.responseBytes += sample.responseBytes;
      const sources = KNOWLEDGE_USAGE_SOURCES.filter((source) => sample.sources?.includes(source));
      for (const source of sources) counts.sources[source] = (counts.sources[source] ?? 0) + 1;
      const receipt = randomUUID();
      this.receipts.set(receipt, { receipt, project: key, sessionId: scope.sessionId, surface, lookup, day, outcome: sample.outcome, sources, endedAt });
      for (const [id, value] of this.receipts) if (endedAt - value.endedAt >= RECEIPT_MS) this.receipts.delete(id);
      if (this.receipts.size > MAX_RECEIPTS) this.receipts.delete(this.receipts.keys().next().value!);
      this.schedule();
      return receipt;
    };
  }

  report(scope: Scope, days: KnowledgeUsageDays): KnowledgeUsageReport {
    const key = keyFor(scope.projectRoot);
    const project = this.projects.get(key);
    const today = this.today();
    let recentAgent: RecentKnowledgeLookup | undefined;
    if (project?.enabled && !this.changing.has(key)) {
      for (const { project: id, sessionId, surface, day, ...recent } of this.receipts.values()) {
        if (id === key && sessionId === scope.sessionId && surface === 'agent' && day > today - days && this.now() - recent.endedAt < RECEIPT_MS) recentAgent = recent;
      }
    }
    return { enabled: project?.enabled === true, days, desktop: totals(project, 'desktop', today, days), agent: totals(project, 'agent', today, days), ...(recentAgent ? { recentAgent } : {}) };
  }

  vote(scope: Scope, id: string, vote: KnowledgeUsageVote): boolean {
    const record = this.receipts.get(id);
    const key = keyFor(scope.projectRoot);
    const project = this.projects.get(key);
    if (this.closed || !record || record.project !== key || record.sessionId !== scope.sessionId || !project?.enabled || this.changing.has(key) || this.now() - record.endedAt >= RECEIPT_MS) return false;
    const counts = project.days.find(({ day }) => day === record.day)?.[record.surface];
    if (!counts) return false;
    if (record.vote === vote) return true;
    if (record.vote) counts[record.vote === 'helped' ? 'helped' : 'notHelpful']--;
    record.vote = vote;
    counts[vote === 'helped' ? 'helped' : 'notHelpful']++;
    this.schedule();
    return true;
  }

  configure(scope: Scope, enabled: boolean): Promise<void> {
    return this.change(scope, (previous) => enabled === (previous?.enabled ?? false) ? previous : { enabled, days: previous?.days ?? [] });
  }

  clear(scope: Scope): Promise<void> {
    return this.change(scope, (previous) => previous && { enabled: previous.enabled, days: [] });
  }

  private change(scope: Scope, change: (previous?: Project) => Project | undefined): Promise<void> {
    const key = keyFor(scope.projectRoot);
    return this.enqueue(async () => {
      if (this.closed) throw new Error('Knowledge usage is shutting down.');
      if (this.prune()) this.schedule();
      const previous = this.projects.get(key);
      const next = change(previous);
      if (next === previous) return;
      if (!previous && this.projects.size >= MAX_PROJECTS) throw new Error('Too many projects are tracking usage. Turn off and clear usage for a project first.');
      this.changing.add(key);
      try {
        const snapshot = new Map(this.projects);
        if (next && (next.enabled || next.days.length)) snapshot.set(key, next);
        else snapshot.delete(key);
        // The consent/reset is visible only after its atomic write. Writes and control decisions
        // share one queue; a buffered older snapshot cannot restore counters after Clear.
        await this.save(snapshot);
        const saved = snapshot.get(key);
        if (saved) this.projects.set(key, saved);
        else this.projects.delete(key);
        for (const [id, receipt] of this.receipts) if (receipt.project === key) this.receipts.delete(id);
      } finally {
        this.changing.delete(key);
      }
    });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.writer.then(work);
    this.writer = next.catch(() => undefined);
    return next;
  }

  private schedule(): void {
    this.dirty = true;
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => void this.flush().catch(() => undefined), 2_000);
    this.timer.unref();
  }

  private async save(projects: Map<string, Project>): Promise<void> {
    this.dirty = false;
    try {
      const snapshot = structuredClone(Object.fromEntries(projects));
      await (this.deps.persist ?? writeJson)(this.file, { version: 1, projects: snapshot }, { mode: 0o600 });
    } catch {
      this.dirty = true;
      this.deps.log('warn', 'knowledge usage: could not save local counters');
      throw new Error('Could not save local Knowledge usage.');
    }
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.enqueue(async () => {
      const pruned = this.prune();
      if (pruned || this.dirty) await this.save(this.projects);
    });
  }

  close(): Promise<void> {
    this.closed = true;
    this.receipts.clear();
    return this.flush();
  }
}
