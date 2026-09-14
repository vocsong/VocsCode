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
  claimKey,
  isSameClaim,
  isServable,
  knowledgeSlug,
  pathForProposal,
  renderKnowledgeDigest,
  serializeKnowledgeDocument,
  type KnowledgeEpisode,
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
import { KnowledgeStore, proposalMeta, writeFileAtomic, type StoredPage } from './store';
import { bootstrapKnowledge, distillKnowledge, type KnowledgeJobResult, type KnowledgeSynthDeps } from './synth';

export type { KnowledgeScope, KnowledgeSettings } from '../../shared/knowledge';

export interface KnowledgeServiceDeps {
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  settings: () => AppSettings;
  /** Bounded plain-text lines from a session transcript, used as distillation evidence. */
  transcript?: (sessionId: string) => Promise<string[]>;
  store?: KnowledgeStore;
  /** Injected by tests; production wires the provider clients in llm.ts. */
  synth?: Omit<KnowledgeSynthDeps, 'store' | 'log' | 'transcript' | 'settings'>;
}

export interface KnowledgeProposeResult {
  id: string;
  evidenceCount: number;
  /** True when the model may not edit anything: the claim was rejected before. */
  rejected: boolean;
  /** True when repeated evidence promoted it straight to a proposed page. */
  promoted: boolean;
}

const DEFAULT_SETTINGS: KnowledgeSettings = { prime: true, autoDistill: true };
const MAX_PAGES = 500;

export class KnowledgeService {
  readonly store: KnowledgeStore;
  private readonly deps: KnowledgeServiceDeps;
  private readonly jobs = new Map<string, Promise<KnowledgeJobResult>>();

  constructor(deps: KnowledgeServiceDeps) {
    this.deps = deps;
    this.store = deps.store ?? new KnowledgeStore();
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
    return {
      hasWiki: await this.store.hasWiki(scope),
      pages: pages.length,
      needsReview: pages.filter((p) => !p.meta.review || p.meta.review.state !== 'reviewed').length,
      proposals: proposals.length,
      stale,
      indexed: false,
      ...(updated ? { lastUpdated: updated } : {}),
      ...(this.jobs.has(scope.projectRoot) ? { generating: true } : {})
    };
  }

  async view(scope: KnowledgeScope): Promise<KnowledgeView> {
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
    const related = all.filter((p) => relatedIds.has(p.meta.id) && p.meta.id !== id).map((p) => this.summarize(p));
    const { stale, reasons } = await this.store.staleness(scope, page);
    return { page: toPage(page), related, stale, staleReasons: reasons };
  }

  /**
   * Ranked scan. Every query term must appear somewhere (title, keywords, claim or body), which is
   * the right default for a curated corpus: a page that matches half the words is not evidence.
   */
  async search(scope: KnowledgeScope, query: string, opts: { limit?: number; includeHistorical?: boolean } = {}): Promise<KnowledgeSearchResult[]> {
    const terms = tokenize(query);
    if (!terms.length) return [];
    const pages = await this.store.load(scope);
    const out: KnowledgeSearchResult[] = [];
    for (const page of pages) {
      const meta = page.meta;
      if (!opts.includeHistorical && !isServable(meta)) continue;
      const hay = { id: meta.id, title: meta.title, keywords: meta.keywords.join(' '), claim: meta.claim ?? '', body: page.body };
      let score = 0;
      let matchedAll = true;
      for (const term of terms) {
        const inId = occur(hay.id, term) * 6;
        const inTitle = occur(hay.title, term) * 6;
        const inKeywords = occur(hay.keywords, term) * 4;
        const inClaim = occur(hay.claim, term) * 3;
        const inBody = Math.min(occur(hay.body, term), 5) * 1;
        const total = inId + inTitle + inKeywords + inClaim + inBody;
        if (total === 0) matchedAll = false;
        score += total;
      }
      if (!matchedAll || score <= 0) continue;
      score += Math.max(0, 4 - authorityOf(meta));
      if (meta.status === 'uncertain') score -= 1;
      out.push({ ...this.summarize(page, snippetFor(page.body, terms)), score });
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
   * Records a candidate page. Nothing is edited: a new claim becomes a proposal for review, and the
   * only automatic promotion is a claim independently seen in two sessions, which becomes a
   * *proposed* page (still not current, still never published).
   */
  async propose(scope: KnowledgeScope, input: KnowledgeProposalInput, origin: string, sessionId?: string): Promise<KnowledgeProposeResult> {
    const claim = input.claim.trim();
    const title = input.title.trim();
    if (!title || !claim) throw new Error('A proposal needs a title and a one-line claim');
    if (await this.store.isRejected(scope, claim)) {
      const existing = await this.store.proposals(scope);
      const duplicate = existing.find((p) => isSameClaim(p.meta.claim, claim));
      if (duplicate) await this.store.removeProposal(scope, duplicate.meta.id);
      return { id: '', evidenceCount: 0, rejected: true, promoted: false };
    }
    const evidenceCount = await this.store.recordEvidence(scope, claim, sessionId);
    const targetId = input.pageId ?? pathForProposal(input.kind ?? 'concept', title).replace(/\.md$/, '');
    const existingPage = await this.store.read(scope, targetId);
    const pageScope = input.scope ?? this.defaultScope(scope, existingPage);
    const meta = proposalMeta({
      id: targetId,
      title,
      claim,
      kind: input.kind,
      scope: pageScope,
      branch: pageScope === 'branch' ? scope.branch : undefined,
      keywords: input.keywords,
      sources: input.sources,
      anchors: input.anchors,
      related: input.related,
      supersedes: input.supersedes,
      contradicts: input.contradicts,
      confidence: input.confidence,
      targetPageId: targetId,
      base: existingPage?.meta
    });
    // Repeated independent sightings promote to a proposed *page*; a single sighting waits in the
    // proposal queue. Neither state is treated as current truth.
    if (!existingPage && evidenceCount >= 2 && origin !== 'human') {
      const page = await this.store.write(scope, { ...meta, status: 'proposed', updatedBy: origin }, input.body);
      await this.store.removeProposal(scope, this.proposalFileId(title, claim));
      this.deps.log('info', `knowledge: promoted repeated claim to a proposed page (${page.meta.id}, ${evidenceCount} sessions)`);
      return { id: page.meta.id, evidenceCount, rejected: false, promoted: true };
    }
    const proposalId = this.proposalFileId(title, claim);
    await this.store.writeProposal(scope, {
      id: proposalId,
      meta: { ...meta, id: proposalId, status: 'proposed', targetPageId: targetId, updatedBy: origin },
      body: input.body
    });
    this.deps.log('info', `knowledge: proposal recorded (${proposalId} → ${targetId}, evidence ${evidenceCount}, origin ${origin})`);
    return { id: proposalId, evidenceCount, rejected: false, promoted: false };
  }

  /** Accept (human review) or reject one proposal. Accepting marks the page current and reviewed. */
  async review(scope: KnowledgeScope, id: string, action: 'accept' | 'reject', opts: { by?: string; body?: string; title?: string; note?: string } = {}): Promise<KnowledgePageSummary | null> {
    const proposals = await this.store.proposals(scope);
    const proposal = proposals.find((p) => p.meta.id === id);
    if (!proposal) return null;
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

  /** Copies reviewed pages into the tracked `docs/wiki/` path; committing them stays the user's act. */
  async publish(scope: KnowledgeScope, ids: string[]): Promise<{ ok: boolean; dir: string; written: string[]; error?: string }> {
    const dir = path.join(scope.projectRoot, KNOWLEDGE_PUBLISH_DIR);
    const written: string[] = [];
    try {
      for (const id of ids.slice(0, 50)) {
        const page = await this.store.read(scope, id);
        if (!page) continue;
        const dest = path.join(dir, `${page.meta.id}.md`);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        const text = `${serializeForPublish(page)}\n`;
        await writeFileAtomic(dest, text);
        written.push(path.relative(scope.projectRoot, dest).replace(/\\/g, '/'));
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

  /** Records an L3 outcome at a git boundary (commit / PR / merge) for later distillation. */
  async recordEpisode(scope: KnowledgeScope, episode: KnowledgeEpisode): Promise<void> {
    // A project that never opted into the wiki gets no files written for it: episodes exist to
    // feed distillation, and distillation needs a wiki to write proposals into.
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

  /** One job per project; the panel polls status and sees `generating`. */
  async generate(scope: KnowledgeScope, mode: 'bootstrap' | 'distill'): Promise<KnowledgeJobResult> {
    if (!this.deps.synth?.completer) return { ok: false, error: 'No background model is configured (Settings → General → Utility model).' };
    const running = this.jobs.get(scope.projectRoot);
    if (running) return running;
    const deps: KnowledgeSynthDeps = { store: this.store, log: this.deps.log, transcript: this.deps.transcript, settings: this.settings(), ...this.deps.synth };
    const job = (mode === 'bootstrap' ? bootstrapKnowledge(scope, deps) : distillKnowledge(scope, deps))
      .catch((e): KnowledgeJobResult => ({ ok: false, error: errorMessage(e) }))
      .finally(() => this.jobs.delete(scope.projectRoot));
    this.jobs.set(scope.projectRoot, job);
    const result = await job;
    this.deps.log(result.ok ? 'info' : 'warn', `knowledge: ${mode} finished: ${result.ok ? (result.detail ?? 'ok') : result.error}`);
    return result;
  }

  generating(projectRoot: string): boolean {
    return this.jobs.has(projectRoot);
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                          */
  /* ------------------------------------------------------------------ */

  private defaultScope(scope: KnowledgeScope, existing: KnowledgePage | null): 'repo' | 'branch' {
    if (existing) return existing.meta.scope;
    // A page discovered while working on a branch stays with that branch until it is published;
    // edits to an existing repo page always land in the repo scope.
    return this.store.branchDir(scope) ? 'branch' : 'repo';
  }

  private proposalFileId(title: string, claim: string): string {
    return `${knowledgeSlug(title).slice(0, 40)}-${claimKey(claim)}`;
  }

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
      ...(meta.updatedAt ? { updatedAt: meta.updatedAt } : {}),
      ...(meta.updatedBy ? { updatedBy: meta.updatedBy } : {}),
      ...(meta.confidence ? { confidence: meta.confidence } : {}),
      authority: authorityOf(meta),
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
  let at = -1;
  for (const term of terms) {
    at = lower.indexOf(term);
    if (at >= 0) break;
  }
  if (at < 0) return flat.slice(0, 160);
  const start = Math.max(0, at - 70);
  const end = Math.min(flat.length, at + 110);
  return `${start > 0 ? '…' : ''}${flat.slice(start, at)}\u0001${flat.slice(at, at + Math.min(terms[0].length, flat.length - at))}\u0002${flat.slice(at + Math.min(terms[0].length, flat.length - at), end)}${end < flat.length ? '…' : ''}`;
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
