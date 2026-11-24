/**
 * The Layer 2 store: a project wiki on disk, nothing but markdown and a couple of JSON ledgers.
 *
 * Layout, relative to a project root (`<project>/.vocs-code/wiki/`; the worktree keeps its own):
 *   any `name.md`          a page, one file per page, path = id
 *   _proposals/           legacy proposals and a separate, desktop-only automatic draft queue
 *   _observations/*.jsonl durable outcomes (commit / PR / merge / session) awaiting distillation
 *   _rejected.json        claim tombstones, so an agent does not refile a rejected claim
 *   _evidence.json        how many independent sessions have seen a claim (the promotion rule)
 *
 * Repo-scope pages live in the main checkout's wiki and are shared by every worktree; branch-scope
 * pages live in the worktree's own wiki and are overlaid on top for matching sessions. Writes are
 * temp-file + rename so a crash never leaves a half-written page, and the store never touches
 * anything outside its own wiki directory.
 */
import { createHash } from 'node:crypto';
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

export interface KnowledgeDraftResult {
  id: string;
  /** False when this claim is already queued, recorded in this slice, or rejected. */
  saved: boolean;
  rejected?: boolean;
}

const DRAFT_NAMESPACE = 'auto-draft';
const DRAFT_ORIGIN = 'auto:evidence-draft';

export function isAutomaticDraftId(id: unknown): boolean {
  return typeof id === 'string' && (id === DRAFT_NAMESPACE || id.startsWith(`${DRAFT_NAMESPACE}/`));
}

function draftHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function draftSlice(branch?: string): string {
  return `${DRAFT_NAMESPACE}/${branch ? `branch-${draftHash(branch)}` : 'repo'}`;
}

function draftId(claim: string, branch?: string): string {
  return `${draftSlice(branch)}/${draftHash(claim.replace(/\s+/g, ' ').trim())}`;
}

function matchesRejection(rejected: RejectedEntry, claim: string): boolean {
  return sameRejectedKnowledgeClaim(rejected.claim, claim) || sameKnowledgeClaim(rejected.claim, claim);
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** A desktop-selected root may be an alias, but no repo-controlled wiki path may follow a link. */
async function unlinkedWikiPath(scope: KnowledgeScope, target: string): Promise<boolean> {
  if (!isInside(scope.projectRoot, target)) return false;
  let current = path.resolve(scope.projectRoot);
  for (const part of path.relative(current, target).split(path.sep)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  }
  return true;
}

/** A directory name is only a lookup hint: different branch names can share a legacy slug. */
function pageInSlice(meta: Pick<KnowledgePageMeta, 'scope' | 'branch'>, branch?: string): boolean {
  return branch ? meta.scope === 'branch' && meta.branch === branch : meta.scope === 'repo';
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
    return await unlinkedWikiPath(scope, this.repoDir(scope)) && await exists(this.repoDir(scope));
  }

  /** Creates the wiki directory for manual recording even if the project has no docs to ingest. */
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
    if (!(await unlinkedWikiPath(scope, this.repoDir(scope)))) return [];
    for (const page of await this.walkDir(this.repoDir(scope))) if (pageInSlice(page.meta)) byId.set(page.meta.id, page);
    const branchDir = this.branchDir(scope);
    if (branchDir && await unlinkedWikiPath(scope, branchDir)) {
      for (const page of await this.walkDir(branchDir)) if (pageInSlice(page.meta, scope.branch)) byId.set(page.meta.id, page);
    }
    return [...byId.values()];
  }

  async read(scope: KnowledgeScope, id: string): Promise<StoredPage | null> {
    if (!isKnowledgeId(id)) return null;
    const all = await this.load(scope);
    return all.find((p) => p.meta.id === id) ?? null;
  }

  /** Serialize app instances and standalone MCP writers, then discard every cached page. */
  private async withWriteLock<T>(scope: KnowledgeScope, action: () => Promise<T>): Promise<T> {
    if (!(await unlinkedWikiPath(scope, this.repoDir(scope)))) throw new Error('Refusing to write through a linked wiki directory.');
    return withKnowledgeWriteLock(this.repoDir(scope), async () => {
      this.cache.clear();
      return action();
    });
  }

  /**
   * Resolve identity and merge fresh metadata inside the same cross-process write boundary.
   *
   * A page a human reviewed or wrote is never rewritten by a lower-authority writer. The same claim
   * from an agent adds its evidence and leaves the human's text alone (`kept`); a different claim
   * is refused with `KnowledgeProtectedError`, so the caller can file it as a candidate instead.
   */
  async ingest(
    scope: KnowledgeScope,
    input: KnowledgeProposalInput & { projectId?: string },
    origin: string,
    sessionId?: string,
    signal?: AbortSignal
  ): Promise<{ page: StoredPage | null; evidenceCount: number; kept?: boolean }> {
    signal?.throwIfAborted();
    if (input.pageId !== undefined && !isKnowledgeId(input.pageId)) throw new Error('Invalid knowledge page id');
    return this.withWriteLock(scope, async () => {
      signal?.throwIfAborted();
      if (await this.isRejected(scope, input.claim)) return { page: null, evidenceCount: 0 };
      const pages = await this.load(scope);
      const existing = input.pageId
        ? pages.find((p) => p.meta.id === input.pageId)
        : pages.find((p) => sameKnowledgeClaim(p.meta.claim, input.claim));
      const id = input.pageId ?? existing?.meta.id ?? pathForProposal(input.kind ?? 'concept', input.title).replace(/\.md$/, '');
      const previous = await this.readForWrite(scope, id);
      if (!input.pageId && previous && !sameKnowledgeClaim(previous.meta.claim, input.claim)) throw knowledgeCollision(id);
      const pageScope = input.scope ?? previous?.meta.scope ?? 'repo';
      const protectedPage = !!previous && isHumanAuthored(previous.meta) && !isHumanOrigin(origin);
      if (previous && protectedPage && !sameKnowledgeClaim(previous.meta.claim, input.claim)) throw new KnowledgeProtectedError(id);
      const meta = proposalMeta({ ...input, id, scope: pageScope, branch: pageScope === 'branch' ? scope.branch : undefined, base: previous?.meta });
      delete meta.targetPageId;
      if (previous && protectedPage) {
        // Corroboration only: the human's title, kind, text and authorship stay exactly as they are.
        const kept: KnowledgePageMeta = { ...meta, title: previous.meta.title, kind: previous.meta.kind, status: previous.meta.status };
        if (previous.meta.confidence) kept.confidence = previous.meta.confidence;
        else delete kept.confidence;
        if (previous.meta.updatedBy) kept.updatedBy = previous.meta.updatedBy;
        else delete kept.updatedBy;
        const page = await this.writeUnlocked(scope, kept, previous.body, { signal });
        const evidenceCount = await this.recordEvidenceUnlocked(scope, input.claim, sessionId);
        return { page, evidenceCount, kept: true };
      }
      const page = await this.writeUnlocked(scope, { ...meta, status: 'current', updatedBy: origin }, input.body, { implicitClaim: input.pageId ? undefined : input.claim, signal });
      const evidenceCount = await this.recordEvidenceUnlocked(scope, input.claim, sessionId);
      return { page, evidenceCount };
    });
  }

  /** Writes a page into the scope it names, preserving `createdAt` on an update. */
  async write(scope: KnowledgeScope, meta: KnowledgePageMeta, body: string, opts?: { preserveReview?: boolean }): Promise<StoredPage> {
    return this.withWriteLock(scope, () => this.writeUnlocked(scope, meta, body, opts));
  }

  /** Exact, uncached reads for write decisions; bounded retrieval scans are not identity checks. */
  private async readForWrite(scope: KnowledgeScope, id: string): Promise<StoredPage | null> {
    const branchDir = this.branchDir(scope);
    for (const dir of [branchDir, this.repoDir(scope)]) {
      if (!dir) continue;
      const file = path.join(dir, `${id}.md`);
      if (!(await unlinkedWikiPath(scope, file))) throw new Error('Refusing to update a linked wiki page.');
      try {
        const parsed = parseKnowledgeDocument(await fs.readFile(file, 'utf8'), `${id}.md`);
        if (!parsed || parsed.meta.id !== id) throw new Error(`Cannot update invalid knowledge page "${id}".`);
        if (!pageInSlice(parsed.meta, dir === branchDir ? scope.branch : undefined)) throw new Error(`Cannot update out-of-scope knowledge page "${id}".`);
        return { ...parsed, abs: file, scopeDir: dir, mtimeMs: Date.now() };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return null;
  }

  private async writeUnlocked(scope: KnowledgeScope, meta: KnowledgePageMeta, body: string, opts: { implicitClaim?: string; signal?: AbortSignal; createOnly?: boolean; preserveReview?: boolean } = {}): Promise<StoredPage> {
    if (!isKnowledgeId(meta.id) || isAutomaticDraftId(meta.id)) throw new Error('Invalid knowledge page id');
    const branch = meta.scope === 'branch' ? scope.branch : undefined;
    if (meta.scope === 'branch' && (!branch || (meta.branch && meta.branch !== branch))) throw new Error('A branch-scope page must belong to the active branch');
    const dir = branch ? this.branchDir(scope)! : this.repoDir(scope);
    const file = path.join(dir, `${meta.id}.md`);
    if (!isInside(dir, file) || !(await unlinkedWikiPath(scope, file))) throw new Error('Knowledge page path escapes the wiki or is a link');
    opts.signal?.throwIfAborted();
    await this.ensureIgnored(scope);
    // An unreadable or malformed destination is not an absent page and must never be replaced.
    let previous: KnowledgePage | null = null;
    try {
      if (opts.createOnly) {
        await fs.lstat(file);
        throw new Error(`Knowledge page "${meta.id}" already exists; the draft cannot replace it.`);
      }
      previous = parseKnowledgeDocument(await fs.readFile(file, 'utf8'), `${meta.id}.md`);
      if (!previous || previous.meta.id !== meta.id) throw new Error(`Cannot update invalid knowledge page "${meta.id}".`);
      if (!pageInSlice(previous.meta, branch)) throw new Error(`Cannot update out-of-scope knowledge page "${meta.id}".`);
      if (opts.preserveReview && isHumanAuthored(previous.meta)) throw new KnowledgeProtectedError(meta.id);
      if (opts.implicitClaim !== undefined && !sameKnowledgeClaim(previous.meta.claim, opts.implicitClaim)) throw knowledgeCollision(meta.id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const now = new Date().toISOString();
    const next: KnowledgePageMeta = {
      ...meta,
      branch,
      createdAt: previous?.meta.createdAt ?? meta.createdAt ?? now,
      updatedAt: now
    };
    await ensureDir(path.dirname(file));
    // Do not start a durable write after the gateway call has been revoked while waiting for disk.
    opts.signal?.throwIfAborted();
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
    const branchDir = this.branchDir(scope);
    for (const dir of [branchDir, this.repoDir(scope)]) {
      if (!dir) continue;
      const file = path.join(dir, `${id}.md`);
      if (!isInside(dir, file) || !(await unlinkedWikiPath(scope, file))) continue;
      try {
        const page = parseKnowledgeDocument(await fs.readFile(file, 'utf8'), `${id}.md`);
        if (!page || page.meta.id !== id || !pageInSlice(page.meta, dir === branchDir ? scope.branch : undefined)) continue;
        await fs.rm(file, { force: true });
      } catch {
        continue; // try the next scope
      }
      this.cache.delete(file);
      return true;
    }
    return false;
  }

  /** The preexisting queue only. The desktop lists automatic drafts separately. */
  async proposals(scope: KnowledgeScope): Promise<KnowledgePage[]> {
    const dir = this.proposalsDir(scope);
    if (!(await unlinkedWikiPath(scope, dir))) return [];
    const out: KnowledgePage[] = [];
    for (const abs of await this.mdFiles(dir)) {
      const rel = path.relative(dir, abs).replace(/\\/g, '/');
      const page = await this.readFile(abs);
      if (page && !isAutomaticDraftId(page.meta.id) && page.meta.updatedBy !== DRAFT_ORIGIN) out.push({ meta: page.meta, body: page.body, path: rel });
    }
    return out.sort((a, b) => (b.meta.updatedAt ?? b.meta.createdAt ?? '').localeCompare(a.meta.updatedAt ?? a.meta.createdAt ?? ''));
  }

  async writeProposal(scope: KnowledgeScope, record: { id: string; meta: KnowledgePageMeta; body: string }): Promise<KnowledgePage> {
    const dir = this.proposalsDir(scope);
    const file = path.join(dir, `${record.id}.md`);
    if (!isKnowledgeId(record.id) || isAutomaticDraftId(record.id) || isAutomaticDraftId(record.meta.id) || record.meta.updatedBy === DRAFT_ORIGIN || !isInside(dir, file)) throw new Error('Invalid proposal id');
    if (!(await unlinkedWikiPath(scope, file))) throw new Error('Refusing to write through a linked proposal path.');
    await this.ensureIgnored(scope);
    await ensureDir(path.dirname(file));
    await writeFileAtomic(file, serializeKnowledgeDocument(record.meta, record.body));
    return { meta: record.meta, body: record.body, path: `${record.id}.md` };
  }

  async removeProposal(scope: KnowledgeScope, id: string): Promise<void> {
    if (!isKnowledgeId(id) || isAutomaticDraftId(id)) return;
    const dir = this.proposalsDir(scope);
    const file = path.join(dir, `${id}.md`);
    if (isInside(dir, file) && await unlinkedWikiPath(scope, file)) await fs.rm(file, { force: true });
  }

  /* ------------------------------------------------------------------ */
  /* Automatic drafts: desktop review only                              */
  /* ------------------------------------------------------------------ */

  private draftDir(scope: KnowledgeScope, branch?: string): string {
    // A reserved subdirectory is invisible both to the legacy recursive queue and the standalone
    // MCP status tool, which counts top-level Markdown files in _proposals.
    return path.join(this.proposalsDir(scope), `_${draftSlice(branch)}`);
  }

  private draftLocation(scope: KnowledgeScope, id: string): { file: string; branch?: string } | null {
    const slash = id.lastIndexOf('/');
    if (!/^[a-f0-9]{32}$/.test(id.slice(slash + 1))) return null;
    const slice = id.slice(0, slash);
    const branch = slice === draftSlice() ? undefined : scope.branch;
    if (slice !== draftSlice(branch)) return null;
    return { file: path.join(this.draftDir(scope, branch), `${id.slice(slash + 1)}.md`), branch };
  }

  async drafts(scope: KnowledgeScope): Promise<KnowledgePage[]> {
    const out: KnowledgePage[] = [];
    for (const branch of scope.branch ? [undefined, scope.branch] : [undefined]) {
      const dir = this.draftDir(scope, branch);
      if (!(await unlinkedWikiPath(scope, dir).catch(() => false))) continue;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const draft = await this.readDraft(scope, `${draftSlice(branch)}/${entry.name.slice(0, -3)}`);
        if (draft) out.push(draft);
      }
    }
    return out;
  }

  async readDraft(scope: KnowledgeScope, id: string): Promise<KnowledgePage | null> {
    return this.readDraftExact(scope, id).catch(() => null);
  }

  /** Mutations use a fresh read under the lock; invalid or linked draft files are not absent. */
  private async readDraftExact(scope: KnowledgeScope, id: string): Promise<KnowledgePage | null> {
    const location = this.draftLocation(scope, id);
    if (!location) return null;
    const { file, branch } = location;
    if (!(await unlinkedWikiPath(scope, file))) throw new Error('Refusing to use a linked draft path.');
    try {
      const relative = path.relative(this.repoDir(scope), file).replace(/\\/g, '/');
      const stat = await fs.lstat(file);
      const page = stat.isFile() && stat.nlink === 1 ? parseKnowledgeDocument(await fs.readFile(file, 'utf8'), relative) : null;
      if (!page || page.meta.id !== id || !page.meta.claim || draftId(page.meta.claim, branch) !== id ||
          page.meta.updatedBy !== DRAFT_ORIGIN || page.meta.status !== 'draft' || page.meta.targetPageId ||
          page.meta.branch !== branch || !pageInSlice(page.meta, branch) || isHumanAuthored(page.meta)) {
        throw new Error(`Invalid or out-of-scope knowledge draft "${id}".`);
      }
      return page;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async hasClaimInDraftSlice(scope: KnowledgeScope, claim: string): Promise<boolean> {
    const repo = this.repoDir(scope);
    const dir = this.branchDir(scope) ?? repo;
    if ((scope.branch && !isInside(path.join(repo, KNOWLEDGE_BRANCHES_DIR), dir)) || !(await unlinkedWikiPath(scope, dir))) {
      throw new Error('Draft page path escapes its wiki scope or is a link.');
    }
    return (await this.walkDir(dir)).some((p) => pageInSlice(p.meta, scope.branch) && sameKnowledgeClaim(p.meta.claim, claim));
  }

  /** Save one pending claim per slice, keeping the first durable text and its cited evidence. */
  async writeDraft(scope: KnowledgeScope, input: KnowledgeProposalInput & { projectId?: string }, signal?: AbortSignal): Promise<KnowledgeDraftResult> {
    signal?.throwIfAborted();
    if (input.pageId !== undefined) throw new Error('A draft cannot update a pageId.');
    if (input.scope !== undefined && input.scope !== 'repo' && input.scope !== 'branch') throw new Error('Invalid draft scope.');
    const title = input.title.trim();
    const claim = input.claim.trim();
    const body = input.body.trim();
    if (!title || !claim || /[\r\n]/.test(claim) || !body) throw new Error('A draft needs a title, a one-line claim and a body.');
    const branch = input.scope === 'branch' ? scope.branch : undefined;
    if (input.scope === 'branch' && (!branch || branch.trim() !== branch)) throw new Error('A branch draft requires the active branch.');
    const id = draftId(claim, branch);
    return this.withWriteLock(scope, async () => {
      signal?.throwIfAborted();
      if (await this.isDraftRejected(scope, claim, branch)) return { id, saved: false, rejected: true };
      const previous = await this.readDraftExact(scope, id);
      if (previous && !sameKnowledgeClaim(previous.meta.claim, claim)) throw new Error(`Knowledge draft id collision: "${id}".`);
      if (previous || await this.hasClaimInDraftSlice({ ...scope, branch }, claim)) return { id, saved: false };
      const file = this.draftLocation(scope, id)!.file;
      const meta = {
        ...proposalMeta({ ...input, id, title, claim, scope: branch ? 'branch' : 'repo', branch, status: 'draft', targetPageId: undefined, supersedes: [], verification: undefined }),
        updatedBy: DRAFT_ORIGIN
      };
      signal?.throwIfAborted();
      await this.ensureIgnored(scope, signal);
      await ensureDir(path.dirname(file));
      signal?.throwIfAborted();
      await writeFileAtomic(file, serializeKnowledgeDocument(meta, body));
      return { id, saved: true };
    });
  }

  async reviewDraft(scope: KnowledgeScope, id: string, opts: { by?: string; body?: string; title?: string; note?: string }): Promise<StoredPage | null> {
    const location = this.draftLocation(scope, id);
    if (!location) return null;
    return this.withWriteLock(scope, async () => {
      const draft = await this.readDraftExact(scope, id);
      if (!draft) return null;
      const branch = location.branch;
      const claim = draft.meta.claim!;
      if (await this.isDraftRejected(scope, claim, branch)) throw new Error('This claim has been rejected; the draft cannot be accepted.');
      const title = opts.title?.trim() || draft.meta.title;
      const pageId = pathForProposal(draft.meta.kind, title).replace(/\.md$/, '');
      const targetScope = { ...scope, branch };
      if (await this.hasClaimInDraftSlice(targetScope, claim) || await this.readForWrite(targetScope, pageId)) {
        throw new Error(`A wiki page already exists for this title or claim; draft "${id}" cannot replace it.`);
      }
      const page = await this.writeUnlocked(targetScope, {
        ...draft.meta, id: pageId, title, status: 'current', supersedes: [], verification: undefined,
        review: { state: 'reviewed', by: opts.by, at: new Date().toISOString(), note: opts.note }
      }, opts.body?.trim() ? opts.body : draft.body, { createOnly: true });
      await fs.unlink(location.file);
      return page;
    });
  }

  /** Rejection is durable; a plain delete is not. Both act only on the named visible draft. */
  async deleteDraft(scope: KnowledgeScope, id: string, rejection?: { by?: string }): Promise<boolean> {
    const location = this.draftLocation(scope, id);
    if (!location) return false;
    return this.withWriteLock(scope, async () => {
      const draft = await this.readDraftExact(scope, id);
      if (!draft) return false;
      // Record rejection first: even if cleanup fails, a remaining draft cannot be promoted.
      if (rejection) await this.rememberDraftRejectionUnlocked(scope, draft.meta.claim!, rejection.by, location.branch);
      await fs.unlink(location.file);
      return true;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Claim ledger: evidence + rejection memory                          */
  /* ------------------------------------------------------------------ */

  private evidenceFile(scope: KnowledgeScope): string {
    return path.join(this.repoDir(scope), '_evidence.json');
  }

  /** Records one sighting of a claim; returns the number of distinct sessions that have seen it. */
  async recordEvidence(scope: KnowledgeScope, claim: string, sessionId?: string): Promise<number> {
    return this.withWriteLock(scope, () => this.recordEvidenceUnlocked(scope, claim, sessionId));
  }

  private async recordEvidenceUnlocked(scope: KnowledgeScope, claim: string, sessionId?: string): Promise<number> {
    const file = this.evidenceFile(scope);
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
    const evidence = await readJson<Record<string, EvidenceEntry>>(this.evidenceFile(scope), {});
    return evidence[claimKey(claim)]?.count ?? 0;
  }

  private rejectedFile(scope: KnowledgeScope, branch?: string): string {
    // The repo ledger is also read by the standalone MCP writer. Branch draft decisions stay local.
    return path.join(branch ? this.draftDir(scope, branch) : this.repoDir(scope), '_rejected.json');
  }

  private async readRejections(scope: KnowledgeScope, branch?: string): Promise<Record<string, RejectedEntry>> {
    const file = this.rejectedFile(scope, branch);
    if (!(await unlinkedWikiPath(scope, file))) throw new Error('Refusing to use a linked knowledge tombstone ledger.');
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid knowledge tombstone ledger.');
      const entries = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, RejectedEntry>;
      if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.values(entries).some((entry) => typeof entry?.claim !== 'string')) {
        throw new Error('Invalid knowledge tombstone ledger.');
      }
      return entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private async rememberDraftRejectionUnlocked(scope: KnowledgeScope, claim: string, by?: string, branch?: string): Promise<void> {
    const rejected = await this.readRejections(scope, branch);
    const key = claimKey(claim);
    const previous = rejected[key];
    // Keep the latest rejection at the slot standalone MCP reads. Drafts can also honor older
    // entries displaced by this write if distinct claims collide on that legacy key.
    if (previous && !matchesRejection(previous, claim)) rejected[`${key}-${draftHash(previous.claim)}`] = previous;
    const next = { ...rejected, [key]: { claim, at: new Date().toISOString(), ...(by ? { by } : {}) } };
    await writeFileAtomic(this.rejectedFile(scope, branch), JSON.stringify(next, null, 2));
  }

  async reject(scope: KnowledgeScope, claim: string, by?: string): Promise<void> {
    await this.withWriteLock(scope, async () => {
      const file = this.rejectedFile(scope);
      const rejected = await readJson<Record<string, RejectedEntry>>(file, {});
      const next = { ...rejected, [claimKey(claim)]: { claim, at: new Date().toISOString(), ...(by ? { by } : {}) } };
      await writeFileAtomic(file, JSON.stringify(next, null, 2));
    });
  }

  async rejectedClaims(scope: KnowledgeScope): Promise<string[]> {
    const repo = await this.readRejections(scope).catch(() => null);
    const branch = scope.branch ? await this.readRejections(scope, scope.branch).catch(() => null) : null;
    return [...new Set([...Object.values(repo ?? {}), ...Object.values(branch ?? {})].map((entry) => entry.claim))];
  }

  async isRejected(scope: KnowledgeScope, claim: string): Promise<boolean> {
    const rejected = await readJson<Record<string, RejectedEntry>>(this.rejectedFile(scope), {});
    return sameRejectedKnowledgeClaim(rejected[claimKey(claim)]?.claim, claim);
  }

  private async isDraftRejected(scope: KnowledgeScope, claim: string, branch?: string): Promise<boolean> {
    const repo = await this.readRejections(scope);
    if (Object.values(repo).some((entry) => matchesRejection(entry, claim))) return true;
    return !!branch && Object.values(await this.readRejections(scope, branch)).some((entry) => matchesRejection(entry, claim));
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

  /** Keep local knowledge out of Git status when the checkout has a normal exclude file. */
  private async ensureIgnored(scope: KnowledgeScope, signal?: AbortSignal): Promise<void> {
    if (this.ignored.has(scope.projectRoot)) return;
    this.ignored.add(scope.projectRoot);
    try {
      await excludeVocsCodeDir(scope.projectRoot, signal);
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
  memoryType?: KnowledgePageMeta['memoryType'];
  verification?: KnowledgePageMeta['verification'];
  validFrom?: string;
  validUntil?: string;
  projectId?: string;
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
  const memoryType = input.memoryType ?? existing?.memoryType;
  if (memoryType) meta.memoryType = memoryType;
  const projectId = input.projectId ?? existing?.projectId;
  if (projectId) meta.projectId = projectId;
  // A check made against one claim says nothing about a different one: verification survives an
  // update only while the claim it verified is still the claim on the page.
  const verification = input.verification ?? (existing && sameKnowledgeClaim(existing.claim, input.claim) ? existing.verification : undefined);
  if (verification) meta.verification = verification;
  const validFrom = input.validFrom ?? existing?.validFrom;
  if (validFrom) meta.validFrom = validFrom;
  const validUntil = input.validUntil ?? existing?.validUntil;
  if (validUntil) meta.validUntil = validUntil;
  // Fields this version does not model ride along untouched.
  if (existing?.extra) meta.extra = existing.extra;
  return meta;
}

/** A page a human reviewed or wrote: the top authority rung a wiki page can hold. */
export function isHumanAuthored(meta: Pick<KnowledgePageMeta, 'review' | 'updatedBy'>): boolean {
  return meta.review?.state === 'reviewed' || isHumanOrigin(meta.updatedBy);
}

function isHumanOrigin(origin: string | undefined): boolean {
  return origin === 'human' || !!origin?.startsWith('human:');
}

/** Raised when a lower-authority writer tries to change the claim of a human-reviewed page. */
export class KnowledgeProtectedError extends Error {
  readonly code = 'KNOWLEDGE_PROTECTED';
  constructor(readonly pageId: string) {
    super(`Knowledge page "${pageId}" is human-reviewed and was not changed. A different claim needs the user's review: it can be filed as a candidate, or edited in the Knowledge panel.`);
    this.name = 'KnowledgeProtectedError';
  }
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
