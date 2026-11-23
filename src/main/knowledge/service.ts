/**
 * The Layer 2 facade: one place that turns the markdown store into the shapes the panel, the MCP
 * server and the synthesis jobs consume. Retrieval is a scored scan over a project's pages — a
 * wiki is tens to low hundreds of files, so a rebuildable search index (let alone embeddings) has
 * not earned its keep yet. The seam is `search()`: swap the scorer and nothing else changes.
 *
 * Authority is enforced here, not in prompts: `authorityOf` travels with every summary, historical
 * pages are never served as current, and a rejected claim is remembered so an agent cannot refile
 * it every session.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppSettings } from '../../shared/types';
import {
  KNOWLEDGE_PUBLISH_DIR,
  authorityOf,
  buildKnowledgeGraph,
  expandKnowledgeQuery,
  graphNeighbours,
  isPendingStatus,
  isServable,
  renderKnowledgeDigest,
  serializeKnowledgeDocument,
  type KnowledgeEpisode,
  type KnowledgeGraph,
  type KnowledgeJobState,
  type KnowledgePage,
  type KnowledgePageDetail,
  type KnowledgePageMeta,
  type KnowledgePageSummary,
  type KnowledgeProposalInput,
  type KnowledgeScope,
  type KnowledgeSearchResult,
  type KnowledgeSettings,
  type KnowledgeStatusSummary,
  type KnowledgeView
} from '../../shared/knowledge';
import { errorMessage } from '../util/async';
import { KnowledgeProtectedError, KnowledgeStore, writeFileAtomic, type StoredPage } from './store';
import { bootstrapKnowledge, distillKnowledge, type KnowledgeJobResult, type KnowledgeSynthDeps } from './synth';
import type { AnchorResolver } from './anchors';

export type { KnowledgeScope, KnowledgeSettings } from '../../shared/knowledge';

export interface KnowledgeServiceDeps {
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  settings: () => AppSettings;
  /** Bounded plain-text lines from a session transcript, used as distillation evidence. */
  transcript?: (sessionId: string) => Promise<string[]>;
  store?: KnowledgeStore;
  /** Injected by tests; production wires the provider clients in llm.ts. */
  synth?: Omit<KnowledgeSynthDeps, 'store' | 'log' | 'transcript' | 'settings'>;
  /** Resolves page anchors through GitNexus; absent leaves them unresolved (the panel says so). */
  anchors?: AnchorResolver;
}

/** A change to a human-reviewed page that was not applied, handed on so it is not simply lost. */
export interface KnowledgeProtectedChange {
  scope: KnowledgeScope;
  pageId: string;
  input: KnowledgeProposalInput;
  origin: string;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface KnowledgeProposeResult {
  id: string;
  evidenceCount: number;
  /** True when the model may not edit anything: the claim was rejected before. */
  rejected: boolean;
  /** True when the page was written. */
  promoted: boolean;
  /**
   * Set when the target is human-reviewed: `kept` — the same claim, so only the evidence was added
   * and the human's text stands; `refused` — a different claim, so the page was not touched.
   */
  protected?: 'kept' | 'refused';
}

const DEFAULT_SETTINGS: KnowledgeSettings = { prime: true, autoDistill: true };

export class KnowledgeService {
  readonly store: KnowledgeStore;
  private readonly deps: KnowledgeServiceDeps;
  private readonly jobs = new Map<string, Promise<KnowledgeJobResult>>();
  /** Projects whose one passive bootstrap attempt has already been made this app run. */
  private readonly seedAttempts = new Set<string>();
  /** Last job outcome per project; the panel shows it so a failure cannot vanish into a toast. */
  private readonly lastJobs = new Map<string, KnowledgeJobState>();
  private protectedSink: ((change: KnowledgeProtectedChange) => Promise<void>) | null = null;
  private projectIdOf: ((scope: KnowledgeScope) => Promise<string | undefined>) | null = null;

  constructor(deps: KnowledgeServiceDeps) {
    this.deps = deps;
    this.store = deps.store ?? new KnowledgeStore();
  }

  /** Where a refused change to a human-reviewed page goes: the intelligence core files a candidate. */
  onProtectedChange(sink: (change: KnowledgeProtectedChange) => Promise<void>): void {
    this.protectedSink = sink;
  }

  /** Stamps new writes with the project's stable id once the registry is wired in. */
  useProjectIds(resolve: (scope: KnowledgeScope) => Promise<string | undefined>): void {
    this.projectIdOf = resolve;
  }

  settings(): KnowledgeSettings {
    const stored = this.deps.settings().knowledge;
    return {
      prime: stored?.prime ?? DEFAULT_SETTINGS.prime,
      autoDistill: stored?.autoDistill ?? DEFAULT_SETTINGS.autoDistill
    };
  }

  /** The scope a session reads and writes: repo pages at the project root, branch pages in a worktree. */
  scopeFor(meta: { config: { projectRoot: string }; cwd: string; worktreeBranch?: string }): KnowledgeScope {
    return { projectRoot: meta.config.projectRoot, cwd: meta.cwd, branch: meta.worktreeBranch };
  }

  /* ------------------------------------------------------------------ */
  /* Reading                                                            */
  /* ------------------------------------------------------------------ */

  async status(scope: KnowledgeScope): Promise<KnowledgeStatusSummary> {
    const pages = await this.store.load(scope);
    const proposals = await this.store.proposals(scope);
    let stale = 0;
    for (const page of pages.slice(0, 100)) {
      try {
        if ((await this.store.staleness(scope, page)).stale) stale++;
      } catch {
        /* staleness is advisory; never fail the view over it */
      }
    }
    const updated = pages.map((p) => p.meta.updatedAt).filter((v): v is string => !!v).sort().pop();
    const job = this.lastJobs.get(scope.projectRoot);
    const running = this.jobs.has(scope.projectRoot);
    return {
      hasWiki: await this.store.hasWiki(scope),
      pages: pages.length,
      // A deprecated or superseded page is history, not a pending decision. With ingestion
      // automated, only pages still in the legacy queue are pending at all.
      needsReview: pages.filter((p) => isPendingStatus(p.meta.status)).length,
      proposals: proposals.length,
      stale,
      ...(updated ? { lastUpdated: updated } : {}),
      ...(running ? { generating: true } : {}),
      ...(job ? { job } : {})
    };
  }

  async view(scope: KnowledgeScope): Promise<KnowledgeView> {
    // Opening the panel is a passive trigger, and anything left in the old review queue is accepted
    // on sight: ingestion is automatic now.
    void this.ensureSeeded(scope);
    return this.render(scope);
  }

  /**
   * Starts an empty wiki for a project: the directory, no pages, no model needed. It deliberately
   * does not run the passive seed — the point of this button is a wiki that starts empty.
   */
  async createWiki(scope: KnowledgeScope): Promise<KnowledgeView> {
    await this.store.createWiki(scope);
    this.deps.log('info', `knowledge: wiki created at ${this.store.repoDir(scope)}`);
    return this.render(scope);
  }

  private async render(scope: KnowledgeScope): Promise<KnowledgeView> {
    await this.autoAcceptLegacy(scope);
    const [pages, proposals, rejectedClaims] = await Promise.all([this.store.load(scope), this.store.proposals(scope), this.store.rejectedClaims(scope)]);
    const summaries = pages.map((p) => this.summarize(p)).sort(byKindThenUpdated);
    const status = await this.status(scope);
    return {
      projectRoot: scope.projectRoot,
      cwd: scope.cwd,
      ...(scope.branch ? { branch: scope.branch } : {}),
      wikiDir: this.store.repoDir(scope),
      status,
      pages: summaries,
      proposals: proposals.map((p) => this.summarize(p)).sort(byKindThenUpdated),
      rejectedClaims: rejectedClaims.slice(0, 50),
      settings: this.settings()
    };
  }

  async listPages(scope: KnowledgeScope): Promise<KnowledgePageSummary[]> {
    return (await this.store.load(scope)).map((p) => this.summarize(p)).sort(byKindThenUpdated);
  }

  async detail(scope: KnowledgeScope, id: string): Promise<KnowledgePageDetail | null> {
    const page = await this.store.read(scope, id);
    if (!page) return null;
    const all = await this.store.load(scope);
    const relatedIds = new Set(page.meta.related);
    for (const other of all) {
      if (other.meta.related.includes(id) || linksTo(other.body, id)) relatedIds.add(other.meta.id);
    }
    // Shared labels and anchors are relations too, not just the authored `related` list.
    for (const edge of graphNeighbours(buildKnowledgeGraph(all), id)) relatedIds.add(edge.from === id ? edge.to : edge.from);
    const related = all.filter((p) => relatedIds.has(p.meta.id) && p.meta.id !== id).map((p) => this.summarize(p));
    const { stale, reasons } = await this.store.staleness(scope, page);
    const anchors = this.deps.anchors ? await this.deps.anchors.resolve(scope, page.meta.anchors) : page.meta.anchors.map((a) => ({ ...a, status: 'unavailable' as const, note: 'Anchor resolution is unavailable.' }));
    return { page: toPage(page), related, anchors, stale, staleReasons: reasons };
  }

  /**
   * Ranked scan. Every query term must appear somewhere (title, keywords, claim or body), which is
   * the right default for a curated corpus: a page that matches half the words is not evidence.
   */
  async search(scope: KnowledgeScope, query: string, opts: { limit?: number; includeHistorical?: boolean; match?: 'all' | 'any' } = {}): Promise<KnowledgeSearchResult[]> {
    const terms = tokenize(query);
    if (!terms.length) return [];
    const pages = await this.store.load(scope);
    const out: KnowledgeSearchResult[] = [];
    const exact = query.trim().toLowerCase();
    for (const page of pages) {
      const meta = page.meta;
      if (!opts.includeHistorical && !isServable(meta)) continue;
      const hay = { id: meta.id, title: meta.title, keywords: meta.keywords.join(' '), claim: meta.claim ?? '', body: page.body };
      let score = 0;
      let matched = 0;
      for (const term of terms) {
        const inId = occur(hay.id, term) * 6;
        const inTitle = occur(hay.title, term) * 6;
        const inKeywords = occur(hay.keywords, term) * 4;
        const inClaim = occur(hay.claim, term) * 3;
        const inBody = Math.min(occur(hay.body, term), 5) * 1;
        const total = inId + inTitle + inKeywords + inClaim + inBody;
        if (total > 0) matched++;
        score += total;
      }
      // `any` is for a natural-language question no page holds every word of: a partial match is
      // admitted, and scored down by how much of the question it actually covers.
      if (score <= 0 || (opts.match === 'any' ? matched === 0 : matched < terms.length)) continue;
      if (matched < terms.length) score *= (matched / terms.length) ** 2;
      // An exact id or title is the strongest lexical signal there is.
      if (exact && (meta.id === exact || meta.title.toLowerCase() === exact)) score += 20;
      score += Math.max(0, 4 - authorityOf(meta));
      if (meta.status === 'uncertain') score -= 1;
      out.push({ ...this.summarize(page, snippetFor(page.body, terms)), score });
    }
    // Graph expansion: a page one or two hops from a strong match surfaces even when it shares no
    // query terms — the point of maintaining relations rather than searching pages in isolation.
    if (out.length) {
      const byId = new Map(pages.map((p) => [p.meta.id, p]));
      const seeds = [...out].sort((a, b) => b.score - a.score).slice(0, 8).map((r) => r.id);
      for (const [id, boost] of expandKnowledgeQuery(buildKnowledgeGraph(pages), seeds, 2, 0.5)) {
        if (out.some((r) => r.id === id)) continue;
        const page = byId.get(id);
        if (!page || (!opts.includeHistorical && !isServable(page.meta))) continue;
        out.push({ ...this.summarize(page), score: boost * 4 + Math.max(0, 4 - authorityOf(page.meta)) });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, Math.min(opts.limit ?? 12, 40));
  }

  /** The bounded, always-on block a new session is primed with; null when there is nothing to say. */
  async digest(scope: KnowledgeScope): Promise<string | null> {
    const pages = await this.store.load(scope);
    const summaries = pages.filter((p) => p.meta.status === 'current' || p.meta.status === 'uncertain').map((p) => this.summarize(p));
    if (!summaries.length) return null;
    return renderKnowledgeDigest(summaries, { projectName: path.basename(scope.projectRoot), wikiDir: this.store.repoDir(scope) });
  }

  /* ------------------------------------------------------------------ */
  /* Writing                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Records durable knowledge. Ingestion is fully automated: the claim becomes a `current` page
   * immediately, ranked below anything human-reviewed by the authority ladder. An implicit id
   * collision refuses the write; intentionally changing a claim requires an explicit pageId.
   */
  async propose(scope: KnowledgeScope, input: KnowledgeProposalInput, origin: string, sessionId?: string, signal?: AbortSignal): Promise<KnowledgeProposeResult> {
    signal?.throwIfAborted();
    const claim = input.claim.trim();
    const title = input.title.trim();
    if (!title || !claim) throw new Error('A proposal needs a title and a one-line claim');
    let projectId: string | undefined;
    try {
      projectId = await this.projectIdOf?.(scope);
    } catch {
      projectId = undefined; // identity is provenance, never a reason to lose the write
    }
    let ingested: Awaited<ReturnType<KnowledgeStore['ingest']>>;
    try {
      ingested = await this.store.ingest(scope, { ...input, title, claim, ...(projectId ? { projectId } : {}) }, origin, sessionId, signal);
    } catch (error) {
      if (!(error instanceof KnowledgeProtectedError)) throw error;
      // The human-reviewed page stands. The change is handed on rather than dropped, so a person
      // can still decide to apply it.
      this.deps.log('info', `knowledge: ${error.pageId} is human-reviewed; change from ${origin} was not applied`);
      signal?.throwIfAborted();
      if (this.protectedSink) {
        await this.protectedSink({ scope, pageId: error.pageId, input: { ...input, title, claim }, origin, sessionId, signal }).catch((e) => {
          signal?.throwIfAborted();
          this.deps.log('warn', `knowledge: could not file the refused change to ${error.pageId}: ${errorMessage(e)}`);
        });
      }
      return { id: error.pageId, evidenceCount: 0, rejected: false, promoted: false, protected: 'refused' };
    }
    const { page, evidenceCount } = ingested;
    if (!page) return { id: '', evidenceCount: 0, rejected: true, promoted: false };
    if (ingested.kept) {
      this.deps.log('info', `knowledge: evidence added to human-reviewed ${page.meta.id} (origin ${origin})`);
      return { id: page.meta.id, evidenceCount, rejected: false, promoted: true, protected: 'kept' };
    }
    for (const superseded of page.meta.supersedes) {
      await this.store.patch(scope, superseded, { status: 'superseded', supersededBy: page.meta.id });
    }
    this.deps.log('info', `knowledge: ingested ${page.meta.id} (evidence ${evidenceCount}, origin ${origin})`);
    return { id: page.meta.id, evidenceCount, rejected: false, promoted: true };
  }

  /** Records that a page's claim was checked against a source; null when the page is gone. */
  async verify(scope: KnowledgeScope, id: string, verification: NonNullable<KnowledgePageMeta['verification']>): Promise<KnowledgePageSummary | null> {
    const page = await this.store.patch(scope, id, { verification });
    return page ? this.summarize(page) : null;
  }

  /** Accept (human review) or reject a proposal or an unreviewed page. */
  async review(scope: KnowledgeScope, id: string, action: 'accept' | 'reject', opts: { by?: string; body?: string; title?: string; note?: string } = {}): Promise<KnowledgePageSummary | null> {
    const proposals = await this.store.proposals(scope);
    const proposal = proposals.find((p) => p.meta.id === id);
    if (proposal) return this.reviewProposal(scope, proposal, action, opts);
    return this.reviewPage(scope, id, action, opts);
  }

  private async reviewProposal(
    scope: KnowledgeScope,
    proposal: KnowledgePage,
    action: 'accept' | 'reject',
    opts: { by?: string; body?: string; title?: string; note?: string }
  ): Promise<KnowledgePageSummary | null> {
    const id = proposal.meta.id;
    const claim = proposal.meta.claim ?? proposal.meta.title;
    if (action === 'reject') {
      await this.store.removeProposal(scope, id);
      await this.store.reject(scope, claim, opts.by);
      this.deps.log('info', `knowledge: proposal rejected (${id})`);
      return null;
    }
    const targetId = proposal.meta.targetPageId ?? proposal.meta.id;
    const existing = await this.store.read(scope, targetId);
    const pageScope = existing?.meta.scope ?? proposal.meta.scope;
    const meta: KnowledgePageMeta = {
      ...proposal.meta,
      id: targetId,
      title: opts.title?.trim() || proposal.meta.title,
      status: 'current',
      scope: pageScope,
      evidenceCount: (existing?.meta.evidenceCount ?? proposal.meta.evidenceCount ?? 1),
      review: { state: 'reviewed', ...(opts.by ? { by: opts.by } : {}), at: new Date().toISOString(), ...(opts.note ? { note: opts.note } : {}) }
    };
    delete meta.targetPageId;
    const body = opts.body && opts.body.trim() ? opts.body : proposal.body;
    const written = await this.store.write(scope, meta, body);
    await this.store.removeProposal(scope, id);
    for (const superseded of meta.supersedes) {
      await this.store.patch(scope, superseded, { status: 'superseded', supersededBy: targetId });
    }
    this.deps.log('info', `knowledge: proposal accepted (${id} → ${targetId})`);
    return this.summarize(written);
  }

  /**
   * A generated draft (or a page promoted by repeated evidence) is accepted in place. Discarding one
   * deletes the file and tombstones its claim, so the same candidate is not regenerated every run.
   */
  private async reviewPage(
    scope: KnowledgeScope,
    id: string,
    action: 'accept' | 'reject',
    opts: { by?: string; body?: string; title?: string; note?: string }
  ): Promise<KnowledgePageSummary | null> {
    const page = await this.store.read(scope, id);
    if (!page) return null;
    const claim = page.meta.claim ?? page.meta.title;
    if (action === 'reject') {
      // Tombstoning is what makes a rejection stick; a claim whose page survived on disk must not be
      // remembered as removed, or the panel reports a delete that did not happen.
      if (!(await this.store.deletePage(scope, id))) throw new Error(`Could not remove ${id}, so its claim was not tombstoned.`);
      await this.store.reject(scope, claim, opts.by);
      this.deps.log('info', `knowledge: page discarded (${id})`);
      return null;
    }
    const meta: KnowledgePageMeta = {
      ...page.meta,
      title: opts.title?.trim() || page.meta.title,
      status: 'current',
      review: { state: 'reviewed', ...(opts.by ? { by: opts.by } : {}), at: new Date().toISOString(), ...(opts.note ? { note: opts.note } : {}) }
    };
    const written = await this.store.write(scope, meta, opts.body && opts.body.trim() ? opts.body : page.body);
    this.deps.log('info', `knowledge: page accepted (${id})`);
    return this.summarize(written);
  }

  /**
   * Accepts every pending candidate at once: proposals through the normal review path
   * (supersession and evidence handling still apply), then the pages still in the legacy queue.
   * Everything else is left alone — accepting in bulk must not resurrect a deprecated or
   * superseded page, and `uncertain` is a recorded judgement about a claim, not an unreviewed one.
   */
  async acceptAll(scope: KnowledgeScope, opts: { by?: string } = {}): Promise<{ accepted: number }> {
    let accepted = 0;
    for (const proposal of await this.store.proposals(scope)) {
      if (await this.reviewProposal(scope, proposal, 'accept', { by: opts.by })) accepted++;
    }
    for (const page of await this.store.load(scope)) {
      if (!isPendingStatus(page.meta.status)) continue;
      if (await this.reviewPage(scope, page.meta.id, 'accept', { by: opts.by })) accepted++;
    }
    this.deps.log('info', `knowledge: accepted ${accepted} item(s)`);
    return { accepted };
  }

  /**
   * Copies reviewed pages into the tracked `docs/wiki/` path; committing them stays the user's act.
   * The destination is the session's own checkout: publishing from a worktree session must drop the
   * copies next to the work that produced them, not into the main checkout's working tree.
   */
  async publish(scope: KnowledgeScope, ids: string[]): Promise<{ ok: boolean; dir: string; written: string[]; error?: string }> {
    const dir = path.join(scope.cwd, KNOWLEDGE_PUBLISH_DIR);
    const written: string[] = [];
    try {
      for (const id of ids.slice(0, 50)) {
        const page = await this.store.read(scope, id);
        if (!page) continue;
        const dest = path.join(dir, `${page.meta.id}.md`);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        const text = `${serializeForPublish(page)}\n`;
        await writeFileAtomic(dest, text);
        written.push(path.relative(scope.cwd, dest).replace(/\\/g, '/'));
      }
      this.deps.log('info', `knowledge: published ${written.length} page(s) to ${KNOWLEDGE_PUBLISH_DIR}`);
      return { ok: true, dir, written };
    } catch (e) {
      return { ok: false, dir, written, error: errorMessage(e) };
    }
  }

  /* ------------------------------------------------------------------ */
  /* Episodes and jobs                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Records an L3 outcome at a git boundary (commit / PR / merge) for later distillation.
   *
   * Distillation writes through the service so its dedupe, evidence and rejection rules apply.
   */
  async recordEpisode(scope: KnowledgeScope, episode: KnowledgeEpisode): Promise<void> {
    // A project that never opted into the wiki gets no files written for it: episodes exist to
    // feed distillation, and distillation needs a wiki to write into.
    if (!(await this.store.hasWiki(scope))) return;
    try {
      await this.store.appendEpisode(scope, episode);
    } catch (e) {
      this.deps.log('warn', `knowledge: could not record episode: ${errorMessage(e)}`);
    }
    if (this.settings().autoDistill && this.deps.synth?.completer) {
      void this.generate(scope, 'distill').catch((e) => this.deps.log('warn', `knowledge: auto-distill failed: ${errorMessage(e)}`));
    }
  }

  /**
   * Passive seed: the first time a project with no pages is opened, draft the wiki from its own
   * docs. Attempted once per project per app run; a project with too little documentation simply
   * gets no wiki until it has some.
   */
  async ensureSeeded(scope: KnowledgeScope): Promise<void> {
    if (!this.deps.synth?.completer) return;
    if (this.seedAttempts.has(scope.projectRoot) || this.jobs.has(scope.projectRoot) || this.lastJobs.has(scope.projectRoot)) return;
    let pages = 0;
    try {
      pages = (await this.store.load(scope)).length;
    } catch {
      return;
    }
    if (pages) return;
    this.seedAttempts.add(scope.projectRoot);
    void this.generate(scope, 'bootstrap').catch((e) => this.deps.log('debug', `knowledge: passive seed skipped: ${errorMessage(e)}`));
  }

  /** The relation graph for this project, rebuilt from the markdown and cached best-effort. */
  async graph(scope: KnowledgeScope): Promise<KnowledgeGraph> {
    const graph = buildKnowledgeGraph(await this.store.load(scope));
    try {
      await this.store.writeGraph(scope, graph);
    } catch (e) {
      this.deps.log('debug', `knowledge: could not cache the relation graph: ${errorMessage(e)}`);
    }
    return graph;
  }

  /** Deletes one page without tombstoning its claim; a rejected claim is what stays refused. */
  async remove(scope: KnowledgeScope, id: string): Promise<boolean> {
    return this.store.deletePage(scope, id);
  }

  /**
   * PR reflection: the PR's commits and a bounded diff are reflected over the whole wiki, then
   * ingested automatically. The episode is written first so the evidence survives a failed model
   * call; the reflection itself is a background job.
   */
  async reflectPr(scope: KnowledgeScope, episode: KnowledgeEpisode): Promise<void> {
    if (!(await this.store.hasWiki(scope))) return;
    try {
      await this.store.appendEpisode(scope, episode);
    } catch (e) {
      this.deps.log('warn', `knowledge: could not record PR episode: ${errorMessage(e)}`);
    }
    if (this.settings().autoDistill && this.deps.synth?.completer) {
      void this.generate(scope, 'reflect').catch((e) => this.deps.log('warn', `knowledge: PR reflection failed: ${errorMessage(e)}`));
    }
  }

  /** Accepts any candidate left over from the old review queue, so nothing ever waits for a human. */
  private async autoAcceptLegacy(scope: KnowledgeScope): Promise<void> {
    for (const proposal of await this.store.proposals(scope)) {
      try {
        const targetId = proposal.meta.targetPageId ?? proposal.meta.id;
        const existing = await this.store.read(scope, targetId);
        const meta: KnowledgePageMeta = {
          ...proposal.meta,
          ...(existing?.meta ?? {}),
          id: targetId,
          status: 'current',
          scope: existing?.meta.scope ?? proposal.meta.scope,
          updatedBy: 'auto:accept'
        };
        delete meta.targetPageId;
        delete meta.review;
        await this.store.write(scope, meta, proposal.body);
        await this.store.removeProposal(scope, proposal.meta.id);
      } catch (e) {
        this.deps.log('debug', `knowledge: could not auto-accept ${proposal.meta.id}: ${errorMessage(e)}`);
      }
    }
    for (const page of await this.store.load(scope)) {
      // Only the legacy queue is promoted; `uncertain` is a deliberate state a page keeps.
      if (!isPendingStatus(page.meta.status)) continue;
      try {
        const meta: KnowledgePageMeta = { ...page.meta, status: 'current', updatedBy: 'auto:accept' };
        delete meta.targetPageId;
        delete meta.review;
        await this.store.write(scope, meta, page.body);
      } catch (e) {
        this.deps.log('debug', `knowledge: could not auto-accept ${page.meta.id}: ${errorMessage(e)}`);
      }
    }
  }

  /** One job per project; the panel polls status and sees `generating`. */
  async generate(scope: KnowledgeScope, mode: 'bootstrap' | 'distill' | 'reflect'): Promise<KnowledgeJobResult> {
    if (!this.deps.synth?.completer) return { ok: false, error: 'No background model is configured (Settings → General → Utility model).' };
    const running = this.jobs.get(scope.projectRoot);
    if (running) return running;
    const deps: KnowledgeSynthDeps = {
      store: this.store,
      log: this.deps.log,
      transcript: this.deps.transcript,
      settings: this.settings(),
      // Distillation writes through the service so its dedupe, evidence and rejection rules apply.
      // Tests may inject their own `propose` through deps.synth below.
      propose: (input, origin, sessionId) => this.propose(scope, input, origin, sessionId),
      ...this.deps.synth
    };
    const model = this.deps.synth.completer.label() ?? undefined;
    this.setJob(scope, { mode, state: 'running', at: new Date().toISOString(), ...(model ? { model } : {}) });
    const job = (mode === 'bootstrap' ? bootstrapKnowledge(scope, deps) : distillKnowledge(scope, deps, { mode: mode === 'reflect' ? 'reflect' : 'distill' }))
      .catch((e): KnowledgeJobResult => ({ ok: false, error: errorMessage(e) }))
      .then((result): KnowledgeJobResult => {
        this.setJob(scope, {
          mode,
          state: result.ok ? 'done' : 'failed',
          at: new Date().toISOString(),
          ...(model ? { model } : {}),
          ...(result.detail ? { detail: result.detail } : {}),
          ...(result.error ? { error: result.error } : {})
        });
        return result;
      })
      .finally(() => this.jobs.delete(scope.projectRoot));
    this.jobs.set(scope.projectRoot, job);
    const result = await job;
    this.deps.log(result.ok ? 'info' : 'warn', `knowledge: ${mode} finished: ${result.ok ? (result.detail ?? 'ok') : result.error}`);
    return result;
  }

  private setJob(scope: KnowledgeScope, job: KnowledgeJobState): void {
    this.lastJobs.set(scope.projectRoot, job);
  }

  generating(projectRoot: string): boolean {
    return this.jobs.has(projectRoot);
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                          */
  /* ------------------------------------------------------------------ */

  private summarize(page: KnowledgePage, snippet?: string): KnowledgePageSummary {
    const meta = page.meta;
    return {
      id: meta.id,
      title: meta.title,
      kind: meta.kind,
      status: meta.status,
      scope: meta.scope,
      ...(meta.branch ? { branch: meta.branch } : {}),
      path: `${meta.id}.md`,
      ...(meta.claim ? { claim: meta.claim } : {}),
      ...(meta.targetPageId ? { targetPageId: meta.targetPageId } : {}),
      keywords: meta.keywords,
      labels: meta.labels,
      ...(meta.updatedAt ? { updatedAt: meta.updatedAt } : {}),
      ...(meta.updatedBy ? { updatedBy: meta.updatedBy } : {}),
      ...(meta.confidence ? { confidence: meta.confidence } : {}),
      authority: authorityOf(meta),
      ...(meta.verification ? { verifiedBy: meta.verification.method } : {}),
      ...(meta.memoryType ? { memoryType: meta.memoryType } : {}),
      ...(meta.evidenceCount !== undefined ? { evidenceCount: meta.evidenceCount } : {}),
      ...(snippet ? { snippet } : {})
    };
  }
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                       */
/* ------------------------------------------------------------------ */

function toPage(page: StoredPage): KnowledgePage {
  return { meta: page.meta, body: page.body, path: `${page.meta.id}.md` };
}

function byKindThenUpdated(a: KnowledgePageSummary, b: KnowledgePageSummary): number {
  const rank = (s: KnowledgePageSummary) => (s.status === 'proposed' || s.status === 'draft' ? 1 : 0);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.authority !== b.authority) return a.authority - b.authority;
  return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
}

function tokenize(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1)
    )
  ].slice(0, 8);
}

function occur(haystack: string, term: string): number {
  if (!haystack) return 0;
  let count = 0;
  let from = 0;
  const hay = haystack.toLowerCase();
  for (;;) {
    const at = hay.indexOf(term, from);
    if (at < 0) break;
    count++;
    from = at + term.length;
    if (count > 8) break;
  }
  return count;
}

/** A match excerpt with \u0001/\u0002 markers, matching the search modal's convention. */
function snippetFor(body: string, terms: string[]): string | undefined {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  const lower = flat.toLowerCase();
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at < 0) continue;
    const start = Math.max(0, at - 70);
    const matchEnd = Math.min(flat.length, at + term.length);
    const end = Math.min(flat.length, Math.max(matchEnd, at + 110));
    return `${start > 0 ? '…' : ''}${flat.slice(start, at)}\u0001${flat.slice(at, matchEnd)}\u0002${flat.slice(matchEnd, end)}${end < flat.length ? '…' : ''}`;
  }
  return flat.slice(0, 160);
}

/** Published copies drop proposal-only fields and keep the provenance intact. */
function serializeForPublish(page: StoredPage): string {
  const meta: KnowledgePageMeta = { ...page.meta };
  delete meta.targetPageId;
  return serializeKnowledgeDocument(meta, page.body);
}

/** `[[page-id]]`, `[[page-id|label]]` and a relative markdown link all count as a wikilink. */
function linksTo(body: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\[\\[${escaped}(\\||\\]\\])`).test(body) || body.includes(`](${id}.md)`) || body.includes(`](./${id}.md)`);
}
