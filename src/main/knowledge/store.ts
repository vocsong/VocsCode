/**
 * The Layer 2 store: a project wiki on disk, nothing but markdown and a couple of JSON ledgers.
 *
 * Layout, relative to a project root (`<project>/.vocs-code/wiki/`; the worktree keeps its own):
 *   any `name.md`          a page, one file per page, path = id
 *   _proposals/*.md       proposals waiting for a human decision
 *   _observations/*.jsonl durable outcomes (commit / PR / merge / session) awaiting distillation
 *   _rejected.json        claim tombstones, so an agent does not refile a rejected claim
 *   _evidence.json        how many independent sessions have seen a claim (the promotion rule)
 *
 * Repo-scope pages live in the main checkout's wiki and are shared by every worktree; branch-scope
 * pages live in the worktree's own wiki and are overlaid on top for matching sessions. Writes are
 * temp-file + rename so a crash never leaves a half-written page, and the store never touches
 * anything outside its own wiki directory.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { knowledgeCollision, sameKnowledgeClaim, sameRejectedKnowledgeClaim, withKnowledgeWriteLock, writeKnowledgeFileAtomic } from '../../../resources/mcp/knowledge-write.mjs';
import {
  KNOWLEDGE_BRANCHES_DIR,
  KNOWLEDGE_DIR,
  KNOWLEDGE_GRAPH_FILE,
  KNOWLEDGE_OBSERVATIONS_DIR,
  KNOWLEDGE_PROPOSALS_DIR,
  KNOWLEDGE_SCAN_FILE,
  branchSlug,
  claimKey,
  isKnowledgeId,
  isSameClaim,
  normalizeLabels,
  pathForProposal,
  parseKnowledgeDocument,
  serializeKnowledgeDocument,
  type KnowledgeEpisode,
  type KnowledgeGraph,
  type KnowledgeKind,
  type KnowledgePage,
  type KnowledgePageMeta,
  type KnowledgePageScope,
  type KnowledgeProposalInput,
  type KnowledgeScope,
  type KnowledgeSource,
  type KnowledgeStatus
} from '../../shared/knowledge';
import { ensureDir, exists, readJson } from '../util/fs';
import { excludeVocsCodeDir } from '../git';

export type { KnowledgeScope } from '../../shared/knowledge';

/** A loaded page plus where it came from, which the merged view otherwise loses. */
export interface StoredPage extends KnowledgePage {
  /** Absolute file path. */
  abs: string;
  scopeDir: string;
  mtimeMs: number;
}

interface EvidenceEntry {
  count: number;
  sessions: string[];
  firstAt: string;
  lastAt: string;
}

interface RejectedEntry {
  claim: string;
  at: string;
  by?: string;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  page: StoredPage | null;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export class KnowledgeStore {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ignored = new Set<string>();

  /** The project's shared wiki; every session of the project writes and reads here. */
  repoDir(scope: KnowledgeScope): string {
    return path.join(scope.projectRoot, KNOWLEDGE_DIR);
  }

  /**
   * Branch-scope pages live *inside* the project wiki, never in a worktree: a worktree is deleted
   * with its session, and knowledge must outlive it. They are keyed by branch name and only surface
   * for a session working on that branch.
   */
  branchDir(scope: KnowledgeScope): string | null {
    if (!scope.branch) return null;
    return path.join(this.repoDir(scope), KNOWLEDGE_BRANCHES_DIR, branchSlug(scope.branch));
  }

  proposalsDir(scope: KnowledgeScope): string {
    return path.join(this.repoDir(scope), KNOWLEDGE_PROPOSALS_DIR);
  }

  observationsDir(scope: KnowledgeScope): string {
    return path.join(this.repoDir(scope), KNOWLEDGE_OBSERVATIONS_DIR);
  }

  async hasWiki(scope: KnowledgeScope): Promise<boolean> {
    return exists(this.repoDir(scope));
  }

  /**
   * Creates the wiki directory without writing a page into it. The directory itself is what turns
   * the project's memory on — the `vocs-memory` MCP server is injected and git-boundary episodes are
   * captured only once it exists — so a project whose docs are too thin to bootstrap from can still
   * start one and fill it by hand.
   */
  async createWiki(scope: KnowledgeScope): Promise<void> {
    await this.ensureIgnored(scope);
    await ensureDir(this.repoDir(scope));
  }

  /** A file's cheap identity, used to skip documents whose content has not changed since last scan. */
  async readScan(scope: KnowledgeScope): Promise<Record<string, { mtimeMs: number; size: number }>> {
    return readJson<Record<string, { mtimeMs: number; size: number }>>(path.join(this.repoDir(scope), KNOWLEDGE_SCAN_FILE), {});
  }

  async writeScan(scope: KnowledgeScope, ledger: Record<string, { mtimeMs: number; size: number }>): Promise<void> {
    await this.ensureIgnored(scope);
    await ensureDir(this.repoDir(scope));
    await writeFileAtomic(path.join(this.repoDir(scope), KNOWLEDGE_SCAN_FILE), JSON.stringify(ledger, null, 2));
  }

  /** The last derived graph, or null when it has not been built yet. */
  async readGraph(scope: KnowledgeScope): Promise<KnowledgeGraph | null> {
    return readJson<KnowledgeGraph | null>(path.join(this.repoDir(scope), KNOWLEDGE_GRAPH_FILE), null);
  }

  async writeGraph(scope: KnowledgeScope, graph: KnowledgeGraph): Promise<void> {
    await this.ensureIgnored(scope);
    await ensureDir(this.repoDir(scope));
    await writeFileAtomic(path.join(this.repoDir(scope), KNOWLEDGE_GRAPH_FILE), JSON.stringify(graph));
  }

  /** Repo pages, then branch pages overriding same-id entries: the merged view a session sees. */
  async load(scope: KnowledgeScope): Promise<StoredPage[]> {
    const byId = new Map<string, StoredPage>();
    for (const page of await this.walkDir(this.repoDir(scope))) byId.set(page.meta.id, page);
    const branchDir = this.branchDir(scope);
    if (branchDir) for (const page of await this.walkDir(branchDir)) byId.set(page.meta.id, page);
    return [...byId.values()];
  }

  async read(scope: KnowledgeScope, id: string): Promise<StoredPage | null> {
    if (!isKnowledgeId(id)) return null;
    const all = await this.load(scope);
    return all.find((p) => p.meta.id === id) ?? null;
  }

  /** Serialize app instances and standalone MCP writers, then discard every cached page. */
  private withWriteLock<T>(scope: KnowledgeScope, action: () => Promise<T>): Promise<T> {
    return withKnowledgeWriteLock(this.repoDir(scope), async () => {
      this.cache.clear();
      return action();
    });
  }

  /** Resolve identity and merge fresh metadata inside the same cross-process write boundary. */
  async ingest(scope: KnowledgeScope, input: KnowledgeProposalInput, origin: string, sessionId?: string): Promise<{ page: StoredPage | null; evidenceCount: number }> {
    if (input.pageId !== undefined && !isKnowledgeId(input.pageId)) throw new Error('Invalid knowledge page id');
    return this.withWriteLock(scope, async () => {
      if (await this.isRejected(scope, input.claim)) return { page: null, evidenceCount: 0 };
      const pages = await this.load(scope);
      const existing = input.pageId
        ? pages.find((p) => p.meta.id === input.pageId)
        : pages.find((p) => sameKnowledgeClaim(p.meta.claim, input.claim));
      const id = input.pageId ?? existing?.meta.id ?? pathForProposal(input.kind ?? 'concept', input.title).replace(/\.md$/, '');
      const previous = await this.readForWrite(scope, id);
      if (!input.pageId && previous && !sameKnowledgeClaim(previous.meta.claim, input.claim)) throw knowledgeCollision(id);
      const pageScope = input.scope ?? previous?.meta.scope ?? 'repo';
      const meta = proposalMeta({ ...input, id, scope: pageScope, branch: pageScope === 'branch' ? scope.branch : undefined, base: previous?.meta });
      delete meta.targetPageId;
      const page = await this.writeUnlocked(scope, { ...meta, status: 'current', updatedBy: origin }, input.body, input.pageId ? undefined : input.claim);
      const evidenceCount = await this.recordEvidenceUnlocked(scope, input.claim, sessionId);
      return { page, evidenceCount };
    });
  }

  /** Writes a page into the scope it names, preserving `createdAt` on an update. */
  async write(scope: KnowledgeScope, meta: KnowledgePageMeta, body: string): Promise<StoredPage> {
    return this.withWriteLock(scope, () => this.writeUnlocked(scope, meta, body));
  }

  /** Exact, uncached reads for write decisions; bounded retrieval scans are not identity checks. */
  private async readForWrite(scope: KnowledgeScope, id: string): Promise<StoredPage | null> {
    for (const dir of [this.branchDir(scope), this.repoDir(scope)]) {
      if (!dir) continue;
      const file = path.join(dir, `${id}.md`);
      try {
        const parsed = parseKnowledgeDocument(await fs.readFile(file, 'utf8'), `${id}.md`);
        if (!parsed || parsed.meta.id !== id) throw new Error(`Cannot update invalid knowledge page "${id}".`);
        return { ...parsed, abs: file, scopeDir: dir, mtimeMs: Date.now() };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return null;
  }

  private async writeUnlocked(scope: KnowledgeScope, meta: KnowledgePageMeta, body: string, implicitClaim?: string): Promise<StoredPage> {
    if (!isKnowledgeId(meta.id)) throw new Error('Invalid knowledge page id');
    const dir = meta.scope === 'branch' ? this.branchDir(scope) : this.repoDir(scope);
    if (!dir) throw new Error('Branch-scope pages need a branch name (only worktree sessions carry one)');
    await this.ensureIgnored(scope);
    const file = path.join(dir, `${meta.id}.md`);
    if (!isInside(dir, file)) throw new Error('Knowledge page path escapes the wiki');
    // An unreadable or malformed destination is not an absent page and must never be replaced.
    let previous: KnowledgePage | null = null;
    try {
      previous = parseKnowledgeDocument(await fs.readFile(file, 'utf8'), `${meta.id}.md`);
      if (!previous || previous.meta.id !== meta.id) throw new Error(`Cannot update invalid knowledge page "${meta.id}".`);
      if (implicitClaim !== undefined && !sameKnowledgeClaim(previous.meta.claim, implicitClaim)) throw knowledgeCollision(meta.id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const now = new Date().toISOString();
    const next: KnowledgePageMeta = {
      ...meta,
      createdAt: previous?.meta.createdAt ?? meta.createdAt ?? now,
      updatedAt: now
    };
    await ensureDir(path.dirname(file));
    await writeFileAtomic(file, serializeKnowledgeDocument(next, body));
    const page: StoredPage = { meta: next, body, path: `${meta.id}.md`, abs: file, scopeDir: dir, mtimeMs: Date.now() };
    this.cache.delete(file);
    return page;
  }

  /** Applies a patch to an existing page and writes it back; null when the page is gone. */
  async patch(scope: KnowledgeScope, id: string, patch: Partial<KnowledgePageMeta>): Promise<StoredPage | null> {
    return this.withWriteLock(scope, async () => {
      const page = await this.read(scope, id);
      if (!page) return null;
      return this.writeUnlocked(scope, { ...page.meta, ...patch, id: page.meta.id }, page.body);
    });
  }

  /**
   * Removes one page from whichever scope holds it; used when a draft is discarded. True only when
   * a file was actually unlinked: `fs.rm` with `force` resolves for a missing path, so the branch
   * scope would otherwise always claim the delete and a repo page discarded from a worktree session
   * would survive on disk while the caller reported success.
   */
  async deletePage(scope: KnowledgeScope, id: string): Promise<boolean> {
    return this.withWriteLock(scope, () => this.deletePageUnlocked(scope, id));
  }

  private async deletePageUnlocked(scope: KnowledgeScope, id: string): Promise<boolean> {
    if (!isKnowledgeId(id)) return false;
    for (const dir of [this.branchDir(scope), this.repoDir(scope)]) {
      if (!dir) continue;
      const file = path.join(dir, `${id}.md`);
      if (!isInside(dir, file) || !(await exists(file))) continue;
      try {
        await fs.rm(file, { force: true });
      } catch {
        continue; // try the next scope
      }
      this.cache.delete(file);
      return true;
    }
    return false;
  }

  async proposals(scope: KnowledgeScope): Promise<KnowledgePage[]> {
    const dir = this.proposalsDir(scope);
    const out: KnowledgePage[] = [];
    for (const abs of await this.mdFiles(dir)) {
      const rel = path.relative(dir, abs).replace(/\\/g, '/');
      const page = await this.readFile(abs);
      if (page) out.push({ meta: page.meta, body: page.body, path: rel });
    }
    return out.sort((a, b) => (b.meta.updatedAt ?? b.meta.createdAt ?? '').localeCompare(a.meta.updatedAt ?? a.meta.createdAt ?? ''));
  }

  async writeProposal(scope: KnowledgeScope, record: { id: string; meta: KnowledgePageMeta; body: string }): Promise<KnowledgePage> {
    const dir = this.proposalsDir(scope);
    const file = path.join(dir, `${record.id}.md`);
    if (!isKnowledgeId(record.id) || !isInside(dir, file)) throw new Error('Invalid proposal id');
    await this.ensureIgnored(scope);
    await ensureDir(dir);
    await writeFileAtomic(file, serializeKnowledgeDocument(record.meta, record.body));
    return { meta: record.meta, body: record.body, path: `${record.id}.md` };
  }

  async removeProposal(scope: KnowledgeScope, id: string): Promise<void> {
    if (!isKnowledgeId(id)) return;
    const file = path.join(this.proposalsDir(scope), `${id}.md`);
    if (isInside(this.proposalsDir(scope), file)) await fs.rm(file, { force: true });
  }

  /* ------------------------------------------------------------------ */
  /* Claim ledger: evidence + rejection memory                          */
  /* ------------------------------------------------------------------ */

  private async ledgerFiles(scope: KnowledgeScope): Promise<{ evidence: string; rejected: string }> {
    const dir = this.repoDir(scope);
    return { evidence: path.join(dir, '_evidence.json'), rejected: path.join(dir, '_rejected.json') };
  }

  /** Records one sighting of a claim; returns the number of distinct sessions that have seen it. */
  async recordEvidence(scope: KnowledgeScope, claim: string, sessionId?: string): Promise<number> {
    return this.withWriteLock(scope, () => this.recordEvidenceUnlocked(scope, claim, sessionId));
  }

  private async recordEvidenceUnlocked(scope: KnowledgeScope, claim: string, sessionId?: string): Promise<number> {
    const { evidence: file } = await this.ledgerFiles(scope);
    // Local fresh snapshots cannot be replaced by concurrent readers on this store instance.
    const evidence = await readJson<Record<string, EvidenceEntry>>(file, {});
    const key = claimKey(claim);
    const now = new Date().toISOString();
    const entry = evidence[key] ?? { count: 0, sessions: [], firstAt: now, lastAt: now };
    const sessions = sessionId && !entry.sessions.includes(sessionId) ? [...entry.sessions, sessionId] : entry.sessions;
    const next: EvidenceEntry = { count: sessions.length, sessions, firstAt: entry.firstAt, lastAt: now };
    await writeFileAtomic(file, JSON.stringify({ ...evidence, [key]: next }, null, 2));
    return next.count;
  }

  async evidenceFor(scope: KnowledgeScope, claim: string): Promise<number> {
    const { evidence: file } = await this.ledgerFiles(scope);
    const evidence = await readJson<Record<string, EvidenceEntry>>(file, {});
    return evidence[claimKey(claim)]?.count ?? 0;
  }

  async reject(scope: KnowledgeScope, claim: string, by?: string): Promise<void> {
    await this.withWriteLock(scope, async () => {
      const { rejected: file } = await this.ledgerFiles(scope);
      const rejected = await readJson<Record<string, RejectedEntry>>(file, {});
      const next = { ...rejected, [claimKey(claim)]: { claim, at: new Date().toISOString(), ...(by ? { by } : {}) } };
      await writeFileAtomic(file, JSON.stringify(next, null, 2));
    });
  }

  async rejectedClaims(scope: KnowledgeScope): Promise<string[]> {
    const { rejected: file } = await this.ledgerFiles(scope);
    const rejected = await readJson<Record<string, RejectedEntry>>(file, {});
    return Object.values(rejected).map((r) => r.claim);
  }

  async isRejected(scope: KnowledgeScope, claim: string): Promise<boolean> {
    const { rejected: file } = await this.ledgerFiles(scope);
    const rejected = await readJson<Record<string, RejectedEntry>>(file, {});
    return sameRejectedKnowledgeClaim(rejected[claimKey(claim)]?.claim, claim);
  }

  /* ------------------------------------------------------------------ */
  /* Episodes (L3 evidence waiting for distillation)                    */
  /* ------------------------------------------------------------------ */

  async appendEpisode(scope: KnowledgeScope, episode: KnowledgeEpisode): Promise<void> {
    const dir = this.observationsDir(scope);
    await this.ensureIgnored(scope);
    await ensureDir(dir);
    const file = path.join(dir, `${episode.at.slice(0, 10)}.jsonl`);
    await fs.appendFile(file, `${JSON.stringify(episode)}\n`, 'utf8');
  }

  /**
   * The newest episodes first: day files sort newest-first by name, but rows are *appended*
   * oldest-first inside a file, so the rows of each file are read backwards too. Callers take `[0]`
   * as "the most recent outcome" and attribute distillation to its session.
   */
  async readEpisodes(scope: KnowledgeScope, limit = 40): Promise<KnowledgeEpisode[]> {
    const dir = this.observationsDir(scope);
    if (!(await exists(dir))) return [];
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort().reverse();
    const out: KnowledgeEpisode[] = [];
    for (const file of files) {
      const rows = (await fs.readFile(path.join(dir, file), 'utf8')).split('\n').reverse();
      for (const row of rows) {
        if (!row.trim()) continue;
        try {
          const parsed = JSON.parse(row) as KnowledgeEpisode;
          if (parsed && typeof parsed === 'object' && typeof parsed.kind === 'string') out.push(parsed);
        } catch {
          /* a torn line is not worth failing a distillation over */
        }
        if (out.length >= limit) return newestFirst(out).slice(0, limit);
      }
    }
    return newestFirst(out).slice(0, limit);
  }

  /* ------------------------------------------------------------------ */
  /* Staleness                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * A page is stale when a file it cites is gone, or changed after the page was written. Anchors
   * are checked the same way: an anchor file that no longer exists is the cheapest possible signal
   * that GitNexus's view of the code moved on.
   */
  async staleness(scope: KnowledgeScope, page: KnowledgePage): Promise<{ stale: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const updated = page.meta.updatedAt ? Date.parse(page.meta.updatedAt) : 0;
    const checked = new Set<string>();
    const files: string[] = [
      ...page.meta.sources.filter((s) => s.type === 'file' || s.type === 'doc').map((s) => s.ref),
      ...page.meta.anchors.map((a) => a.file)
    ];
    for (const ref of files) {
      const rel = ref.replace(/\\/g, '/').replace(/^\.\//, '');
      if (!rel || rel.startsWith('/') || rel.includes('..') || checked.has(rel)) continue;
      checked.add(rel);
      const abs = path.join(scope.projectRoot, rel);
      try {
        const stat = await fs.stat(abs);
        if (updated && stat.mtimeMs > updated) reasons.push(`${rel} changed after this page was written`);
      } catch {
        reasons.push(`${rel} no longer exists`);
      }
    }
    return { stale: reasons.length > 0, reasons: reasons.slice(0, 5) };
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                          */
  /* ------------------------------------------------------------------ */

  /** First write into a project makes sure `.vocs-code/` never shows up as untracked. */
  private async ensureIgnored(scope: KnowledgeScope): Promise<void> {
    if (this.ignored.has(scope.projectRoot)) return;
    this.ignored.add(scope.projectRoot);
    try {
      await excludeVocsCodeDir(scope.projectRoot);
    } catch {
      /* not a git repo, or unreadable: the wiki still works, it is just visible to git */
    }
  }

  private async walkDir(dir: string): Promise<StoredPage[]> {
    const out: StoredPage[] = [];
    for (const abs of await this.mdFiles(dir)) {
      const page = await this.readFile(abs);
      if (page) out.push(page);
    }
    return out;
  }

  /** Every .md under a wiki directory except reserved `_` subdirectories. */
  private async mdFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (current: string, depth: number): Promise<void> => {
      if (depth > 4) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        // `branches` holds other branches' pages; the caller loads its own via branchDir().
        if (entry.name.startsWith('_') || entry.name.startsWith('.') || entry.name === KNOWLEDGE_BRANCHES_DIR) continue;
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(abs, depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.md')) out.push(abs);
      }
    };
    await walk(dir, 0);
    return out;
  }

  private async readFile(abs: string): Promise<StoredPage | null> {
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.stat(abs);
    } catch {
      return null;
    }
    const cached = this.cache.get(abs);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.page;
    let page: StoredPage | null = null;
    try {
      const text = await fs.readFile(abs, 'utf8');
      const parsed = parseKnowledgeDocument(text, path.basename(abs));
      if (parsed) page = { ...parsed, abs, scopeDir: path.dirname(abs), mtimeMs: stat.mtimeMs };
    } catch {
      page = null;
    }
    this.cache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, page });
    return page;
  }
}

/** Newest episode first by the episode's own stamp: a day file is named, a late append is not. */
function newestFirst(episodes: KnowledgeEpisode[]): KnowledgeEpisode[] {
  return [...episodes].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}

/** Serializes only the pages the caller asked for, from a summary list; shared with publish. */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await writeKnowledgeFileAtomic(file, content);
}

/** Builds a proposal record's meta from an input, on top of the page it may edit. */
export function proposalMeta(input: {
  id: string;
  title: string;
  claim: string;
  kind?: KnowledgeKind;
  status?: KnowledgeStatus;
  scope: KnowledgePageScope;
  branch?: string;
  keywords?: string[];
  labels?: string[];
  sources?: KnowledgeSource[];
  anchors?: KnowledgePageMeta['anchors'];
  related?: string[];
  supersedes?: string[];
  contradicts?: string[];
  confidence?: KnowledgePageMeta['confidence'];
  targetPageId?: string;
  base?: KnowledgePageMeta;
}): KnowledgePageMeta {
  const existing = input.base;
  const now = new Date().toISOString();
  const meta: KnowledgePageMeta = {
    id: input.id,
    title: input.title,
    kind: input.kind ?? existing?.kind ?? 'concept',
    status: input.status ?? existing?.status ?? 'proposed',
    scope: input.scope,
    ...(existing?.review ? { review: existing.review } : {}),
    keywords: [...new Set([...(input.keywords ?? []), ...(existing?.keywords ?? [])])].slice(0, 24),
    labels: normalizeLabels([...(input.labels ?? []), ...(existing?.labels ?? [])]),
    sources: dedupeSources([...(input.sources ?? []), ...(existing?.sources ?? [])]),
    anchors: dedupeAnchors([...(input.anchors ?? []), ...(existing?.anchors ?? [])]),
    related: [...new Set([...(input.related ?? []), ...(existing?.related ?? [])])],
    supersedes: input.supersedes ?? existing?.supersedes ?? [],
    contradicts: input.contradicts ?? existing?.contradicts ?? [],
    claim: input.claim,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    evidenceCount: (existing?.evidenceCount ?? 0) + 1
  };
  if (input.branch) meta.branch = input.branch;
  if (input.targetPageId) meta.targetPageId = input.targetPageId;
  if (input.confidence ?? existing?.confidence) meta.confidence = input.confidence ?? existing?.confidence;
  if (input.supersedes?.length) meta.supersededBy = existing?.supersededBy;
  if (existing?.supersededBy && !input.supersedes?.length) meta.supersededBy = existing.supersededBy;
  return meta;
}

function dedupeSources(sources: KnowledgeSource[]): KnowledgeSource[] {
  const seen = new Set<string>();
  const out: KnowledgeSource[] = [];
  for (const s of sources) {
    const key = `${s.type}\u0000${s.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.slice(0, 40);
}

function dedupeAnchors(anchors: KnowledgePageMeta['anchors']): KnowledgePageMeta['anchors'] {
  const seen = new Set<string>();
  const out: KnowledgePageMeta['anchors'] = [];
  for (const a of anchors) {
    const key = `${a.file}\u0000${a.symbol ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out.slice(0, 40);
}

export { isSameClaim, pathForProposal, claimKey };
