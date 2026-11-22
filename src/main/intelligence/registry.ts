/**
 * The project registry: stable project identity, project collections and pending promotion
 * requests, in one app-owned file (`<userData>/intelligence/registry.json`).
 *
 * Identity also grants access to private project memory. A separate checkout must be explicitly
 * linked before it joins an existing project: neither origin, shared history nor a file inside
 * the checkout proves authorization. Git-registered worktrees of the same local repository share
 * an identity through its verified Git common directory.
 *
 * Collections live here too because membership is the federation policy: `collectionGrantsFor`
 * reads this file's state on every query, so removing a member takes effect immediately.
 *
 * Every mutation is applied to a copy, persisted, and only then becomes the live state, so a failed
 * write can never leave memory ahead of disk. No Electron imports.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  collectionGrantsFor,
  normalizeRemoteUrl,
  projectDisplayName,
  type CollectionGrant,
  type CollectionMember,
  type ProjectCollection,
  type ProjectIdentity,
  type PromotionRequest
} from '../../shared/intelligence';
import { errorMessage } from '../util/async';
import { readJson, writeJson } from '../util/fs';
const MAX_PROMOTIONS = 200;
const MAX_COLLECTIONS = 100;
const MAX_MEMBERS = 200;

/** Extra app-owned binding; the shared request still carries the exact title/text for review. */
interface PendingPromotion extends PromotionRequest {
  binding?: { root: string; branch?: string; digest: string };
}

interface RegistryFile {
  version: 1;
  projects: ProjectIdentity[];
  commonDirs: Record<string, string>;
  collections: ProjectCollection[];
  promotions: PendingPromotion[];
}

export interface ProjectFacts {
  /** The raw origin URL as git reports it; normalized here, never stored raw (it can hold credentials). */
  origin?: string;
  rootCommit?: string;
  /** Canonical absolute Git common directory, only after verifying this root is a registered checkout. */
  commonDir?: string;
}

export interface ProjectRegistryDeps {
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** What git says identifies the repository at a root; empty for a folder that is not one. */
  facts: (root: string) => Promise<ProjectFacts>;
  now?: () => number;
}

/** One comparable form per checkout path: absolute, forward slashes, case-folded on Windows. */
export function normalizeRoot(root: string): string {
  const absolute = path.resolve(root);
  const resolved = absolute === path.parse(absolute).root ? absolute.replace(/\\/g, '/') : absolute.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && /^prj_[0-9a-f]{16}$/.test(value);
}

function sanitize(raw: unknown): RegistryFile {
  const file = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Partial<RegistryFile>) : {};
  const projects: ProjectIdentity[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(file.projects) ? file.projects : []) {
    if (!entry || !isProjectId(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    projects.push({
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : 'project',
      ...(typeof entry.origin === 'string' && entry.origin ? { origin: entry.origin } : {}),
      ...(typeof entry.rootCommit === 'string' && entry.rootCommit ? { rootCommit: entry.rootCommit } : {}),
      roots: Array.isArray(entry.roots) ? [...new Set(entry.roots.filter((r): r is string => typeof r === 'string' && !!r))] : [],
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date(0).toISOString(),
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString()
    });
  }
  const collections: ProjectCollection[] = [];
  for (const entry of Array.isArray(file.collections) ? file.collections : []) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.name !== 'string') continue;
    const members: CollectionMember[] = [];
    for (const m of Array.isArray(entry.members) ? entry.members : []) {
      // A member the registry no longer knows is dropped: a grant must name a real project.
      if (!m || !seen.has(m.projectId) || members.some((x) => x.projectId === m.projectId)) continue;
      members.push({ projectId: m.projectId, share: m.share === 'wiki' ? 'wiki' : 'promoted' });
    }
    collections.push({
      id: entry.id,
      name: entry.name,
      ...(typeof entry.description === 'string' && entry.description ? { description: entry.description } : {}),
      members,
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date(0).toISOString(),
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString()
    });
  }
  const roots = new Set(projects.flatMap((project) => project.roots));
  const commonDirs = Object.fromEntries(Object.entries(file.commonDirs ?? {}).filter(([root, dir]) => roots.has(root) && typeof dir === 'string' && path.isAbsolute(dir)));
  const promotions = (Array.isArray(file.promotions) ? file.promotions : []).filter(
    (p): p is PendingPromotion => !!p && typeof p.id === 'string' && seen.has(p.projectId) && typeof p.title === 'string' && !!p.source && (p.to === 'collection' || p.to === 'personal')
  );
  return { version: 1, projects, commonDirs, collections, promotions };
}

export class ProjectRegistry {
  private state: RegistryFile = { version: 1, projects: [], commonDirs: {}, collections: [], promotions: [] };
  private loaded: Promise<void> | null = null;
  /** Mutations run one at a time: read-modify-write on one file must not interleave. */
  private chain: Promise<unknown> = Promise.resolve();
  /** In-flight resolutions per root, so a burst of queries runs git once. */
  private readonly resolving = new Map<string, Promise<ProjectIdentity>>();
  readonly file: string;

  constructor(
    dir: string,
    private readonly deps: ProjectRegistryDeps
  ) {
    this.file = path.join(dir, 'registry.json');
  }

  private now(): string {
    return new Date(this.deps.now?.() ?? Date.now()).toISOString();
  }

  private load(): Promise<void> {
    this.loaded ??= readJson<unknown>(this.file, null, { log: this.deps.log }).then((raw) => {
      this.state = sanitize(raw);
    });
    return this.loaded;
  }

  /** Applies `change` to a copy and swaps it in only after the write succeeded. */
  private mutate<T>(change: (draft: RegistryFile) => T, signal?: AbortSignal): Promise<T> {
    const run = this.chain.then(async () => {
      await this.load();
      signal?.throwIfAborted();
      const draft = structuredClone(this.state);
      const result = change(draft);
      await writeJson(this.file, draft);
      this.state = draft;
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /* ------------------------------------------------------------------ */
  /* Projects                                                           */
  /* ------------------------------------------------------------------ */

  async projects(): Promise<ProjectIdentity[]> {
    await this.load();
    return structuredClone(this.state.projects);
  }

  async project(id: string): Promise<ProjectIdentity | null> {
    await this.load();
    const found = this.state.projects.find((p) => p.id === id);
    return found ? structuredClone(found) : null;
  }

  /** The project a root is already registered under, without touching git or the disk. */
  async known(root: string): Promise<ProjectIdentity | null> {
    await this.load();
    const key = normalizeRoot(root);
    const found = this.state.projects.find((p) => p.roots.includes(key));
    return found ? structuredClone(found) : null;
  }

  /** The stable identity of the project at `root`, registering the checkout the first time it is seen. */
  async resolve(root: string): Promise<ProjectIdentity> {
    const hit = await this.known(root);
    if (hit) return hit;
    const key = normalizeRoot(root);
    let pending = this.resolving.get(key);
    if (!pending) {
      pending = this.register(root, key).finally(() => this.resolving.delete(key));
      this.resolving.set(key, pending);
    }
    return pending;
  }

  private async facts(root: string): Promise<ProjectFacts> {
    try {
      return await this.deps.facts(root);
    } catch (e) {
      this.deps.log('debug', `intelligence: no git identity for ${root}: ${errorMessage(e)}`);
      return {};
    }
  }

  private async register(root: string, key: string): Promise<ProjectIdentity> {
    const facts = await this.facts(root);
    const origin = normalizeRemoteUrl(facts.origin) ?? undefined;
    const commonDir = facts.commonDir && path.isAbsolute(facts.commonDir) ? normalizeRoot(facts.commonDir) : undefined;
    const identity = await this.mutate((draft) => {
      const already = draft.projects.find((p) => p.roots.includes(key));
      if (already) return already;
      const stamp = this.now();
      const match = commonDir ? draft.projects.find((p) => p.roots.some((r) => draft.commonDirs[r] === commonDir)) : undefined;
      if (commonDir) draft.commonDirs[key] = commonDir;
      if (match) {
        match.roots.push(key);
        if (!match.origin && origin) match.origin = origin;
        if (!match.rootCommit && facts.rootCommit) match.rootCommit = facts.rootCommit;
        match.updatedAt = stamp;
        return match;
      }
      const created: ProjectIdentity = {
        id: newId('prj'),
        name: projectDisplayName(origin, root),
        ...(origin ? { origin } : {}),
        ...(facts.rootCommit ? { rootCommit: facts.rootCommit } : {}),
        roots: [key],
        createdAt: stamp,
        updatedAt: stamp
      };
      draft.projects.push(created);
      return created;
    });
    this.deps.log('debug', `intelligence: ${root} is project ${identity.id}${identity.origin ? ` (${identity.origin})` : ''}`);
    return structuredClone(identity);
  }

  /** The user's explicit approval for a separate checkout to share a project's identity. */
  async link(root: string, projectId: string): Promise<ProjectIdentity> {
    const key = normalizeRoot(root);
    const facts = await this.facts(root);
    const commonDir = facts.commonDir && path.isAbsolute(facts.commonDir) ? normalizeRoot(facts.commonDir) : undefined;
    return structuredClone(await this.mutate((draft) => {
      const target = draft.projects.find((p) => p.id === projectId);
      if (!target) throw new Error('Unknown project.');
      const stamp = this.now();
      const linked = new Set([key]);
      if (commonDir) {
        draft.commonDirs[key] = commonDir;
        for (const [other, dir] of Object.entries(draft.commonDirs)) if (dir === commonDir) linked.add(other);
      } else {
        delete draft.commonDirs[key];
      }
      for (const other of draft.projects) {
        if (other.id !== projectId && other.roots.some((r) => linked.has(r))) {
          other.roots = other.roots.filter((r) => !linked.has(r));
          other.updatedAt = stamp;
        }
      }
      target.roots = [...new Set([...target.roots, ...linked])];
      target.updatedAt = stamp;
      return target;
    }));
  }

  async rename(projectId: string, name: string): Promise<ProjectIdentity> {
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!clean) throw new Error('A project needs a name.');
    return structuredClone(
      await this.mutate((draft) => {
        const target = draft.projects.find((p) => p.id === projectId);
        if (!target) throw new Error('Unknown project.');
        target.name = clean;
        target.updatedAt = this.now();
        return target;
      })
    );
  }

  /* ------------------------------------------------------------------ */
  /* Collections                                                        */
  /* ------------------------------------------------------------------ */

  async collections(): Promise<ProjectCollection[]> {
    await this.load();
    return structuredClone(this.state.collections);
  }

  /** What a project may read through its collections, resolved from the live membership. */
  async grantsFor(projectId: string): Promise<CollectionGrant[]> {
    await this.load();
    return collectionGrantsFor(projectId, this.state.collections);
  }

  /** Creates a collection, or replaces the name, description and membership of an existing one. */
  async saveCollection(input: { id?: string; name: string; description?: string; members: CollectionMember[] }): Promise<ProjectCollection> {
    const name = input.name.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) throw new Error('A collection needs a name.');
    const description = input.description?.replace(/\s+/g, ' ').trim().slice(0, 300);
    return structuredClone(
      await this.mutate((draft) => {
        const known = new Set(draft.projects.map((p) => p.id));
        const members: CollectionMember[] = [];
        for (const m of input.members.slice(0, MAX_MEMBERS)) {
          if (!m || !known.has(m.projectId)) throw new Error('A collection can only hold projects this app knows.');
          if (members.some((x) => x.projectId === m.projectId)) continue;
          members.push({ projectId: m.projectId, share: m.share === 'wiki' ? 'wiki' : 'promoted' });
        }
        const stamp = this.now();
        const existing = input.id ? draft.collections.find((c) => c.id === input.id) : undefined;
        if (input.id && !existing) throw new Error('Unknown collection.');
        if (draft.collections.some((c) => c !== existing && c.name.toLowerCase() === name.toLowerCase())) throw new Error(`A collection named "${name}" already exists.`);
        if (existing) {
          existing.name = name;
          if (description) existing.description = description;
          else delete existing.description;
          existing.members = members;
          existing.updatedAt = stamp;
          return existing;
        }
        if (draft.collections.length >= MAX_COLLECTIONS) throw new Error('Too many collections.');
        const created: ProjectCollection = { id: newId('col'), name, ...(description ? { description } : {}), members, createdAt: stamp, updatedAt: stamp };
        draft.collections.push(created);
        return created;
      })
    );
  }

  /** Removes a collection and every promotion request that targeted it. True when it existed. */
  async deleteCollection(id: string): Promise<boolean> {
    return this.mutate((draft) => {
      const before = draft.collections.length;
      draft.collections = draft.collections.filter((c) => c.id !== id);
      draft.promotions = draft.promotions.filter((p) => p.collectionId !== id);
      return draft.collections.length !== before;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Promotion requests                                                 */
  /* ------------------------------------------------------------------ */

  async promotions(projectId?: string): Promise<PendingPromotion[]> {
    await this.load();
    return structuredClone(projectId ? this.state.promotions.filter((p) => p.projectId === projectId) : this.state.promotions);
  }

  /** Queues a request for the user; duplicates must name the same source version and checkout. */
  async requestPromotion(input: Omit<PendingPromotion, 'id' | 'createdAt'>, signal?: AbortSignal): Promise<PromotionRequest> {
    const { binding: _binding, ...request } = await this.mutate((draft) => {
      if (input.to === 'collection' && !draft.collections.some((c) => c.id === input.collectionId && c.members.some((m) => m.projectId === input.projectId))) {
        throw new Error('The source project no longer has access to that collection.');
      }
      const same = draft.promotions.find(
        (p) => p.projectId === input.projectId && p.to === input.to && p.collectionId === input.collectionId && p.source.pageId === input.source.pageId && p.source.recordId === input.source.recordId
          && p.binding?.root === input.binding?.root && p.binding?.branch === input.binding?.branch && p.binding?.digest === input.binding?.digest
      );
      if (same) return same;
      if (draft.promotions.length >= MAX_PROMOTIONS) throw new Error('Too many promotion requests are waiting for review.');
      const created: PendingPromotion = { ...input, id: newId('prm'), createdAt: this.now() };
      draft.promotions.push(created);
      return created;
    }, signal);
    return structuredClone(request);
  }

  removeRecordPromotions(recordId: string, signal?: AbortSignal): Promise<void> {
    return this.removePromotions((p) => p.source.recordId === recordId, signal);
  }

  removeWikiPromotions(projectId: string, pageId: string): Promise<void> {
    return this.removePromotions((p) => p.projectId === projectId && p.source.pageId === pageId);
  }

  private async removePromotions(matches: (p: PendingPromotion) => boolean, signal?: AbortSignal): Promise<void> {
    await this.load();
    signal?.throwIfAborted();
    if (!this.state.promotions.some(matches)) return;
    await this.mutate((draft) => {
      draft.promotions = draft.promotions.filter((p) => !matches(p));
    }, signal);
  }

  async takePromotion(id: string): Promise<PromotionRequest | null> {
    return this.mutate((draft) => {
      const found = draft.promotions.find((p) => p.id === id) ?? null;
      draft.promotions = draft.promotions.filter((p) => p.id !== id);
      return found ? structuredClone(found) : null;
    });
  }
}
