import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitIdentityFacts } from '../src/main/git';
import { GraphifyProvider } from '../src/main/intelligence/graphify';
import { MemoryStore } from '../src/main/intelligence/memory-store';
import { ProjectRegistry, normalizeRoot, type ProjectFacts } from '../src/main/intelligence/registry';
import { IntelligenceService, type IntelligenceContext, type IntelligenceServiceDeps, type SessionRef } from '../src/main/intelligence/service';
import { KnowledgeService } from '../src/main/knowledge/service';
import { resolveIntelligenceSettings, type CollectionMember, type IntelligenceSearchRequest } from '../src/shared/intelligence';
import type { AppSettings } from '../src/shared/types';

const SHA = 'ab'.repeat(20);
const dirs: string[] = [];
const ledgers: MemoryStore[] = [];
const log = () => undefined;

afterEach(async () => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
  vi.restoreAllMocks();
});

async function fixture(ports: Partial<Pick<IntelligenceServiceDeps, 'history' | 'transcript' | 'completer' | 'git' | 'graph'>> = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-intel-'));
  dirs.push(temp);
  const root = await fs.realpath(temp);
  const data = path.join(root, 'app');
  const settings = { intelligence: resolveIntelligenceSettings(undefined), knowledge: { prime: false, autoDistill: false } } as AppSettings;
  const sessions: SessionRef[] = [];
  const facts = new Map<string, ProjectFacts>();
  let time = Date.parse('2026-01-05T00:00:00Z');
  const deps = { log, now: () => time };
  const advance = (days: number) => { time += days * 86_400_000; };
  const factsForRoot = vi.fn(async (cwd: string) => facts.get(normalizeRoot(cwd)) ?? {});
  const registryAt = () => new ProjectRegistry(data, { ...deps, facts: factsForRoot });
  const open = () => {
    const registry = registryAt();
    const memory = new MemoryStore(data, deps);
    ledgers.push(memory);
    memory.init();
    expect(memory.reason).toBeNull(); // Deliberately fail if no real SQLite ledger opened.
    const knowledge = new KnowledgeService({ log, settings: () => settings });
    const service = new IntelligenceService({ ...deps, ...ports, settings: () => settings, registry, memory, knowledge, sessions: () => sessions });
    return { service, registry, memory, knowledge };
  };
  const checkout = async (name: string, projectFacts?: ProjectFacts): Promise<IntelligenceContext> => {
    const projectRoot = path.join(root, name);
    await fs.mkdir(projectRoot, { recursive: true });
    if (projectFacts) facts.set(normalizeRoot(projectRoot), projectFacts);
    return { sessionId: `session-${name}`, projectRoot, cwd: projectRoot };
  };
  return { ...open(), root, settings, sessions, open, checkout, advance, factsForRoot };
}

function member(projectId: string, share: CollectionMember['share'] = 'promoted'): CollectionMember {
  return { projectId, share };
}

const federation = { scope: 'collection', providers: ['collection'] } satisfies Partial<IntelligenceSearchRequest>;

function add(service: IntelligenceService, ctx: IntelligenceContext, text: string) {
  return service.addRecord(ctx, { title: 'Reviewed procedure', text, type: 'procedural', scope: 'project' });
}

function capture(service: IntelligenceService, ctx: IntelligenceContext, claim: string) {
  return service.record(ctx, { title: 'Agent lesson', claim, memoryType: 'episodic' }, 'agent:test');
}

describe('intelligence core on disk', () => {
  it('admits background Graphify through exact checkout metadata, without the legacy Git identity probe', async () => {
    const graph = new GraphifyProvider({ command: () => null, log });
    const refresh = vi.spyOn(graph, 'refresh');
    const f = await fixture({ graph });
    const ordinary = await f.checkout('background graph');
    const unrelated = await f.checkout('different checkout');
    const { signal } = new AbortController();
    await f.service.refreshGraph(ordinary, signal);
    expect(await f.registry.projects()).toEqual([]);
    for (const ctx of [ordinary, unrelated]) {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: ctx.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      git('init', '-q', '-b', 'main');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture');
    }
    await f.service.refreshGraph({ ...ordinary, cwd: unrelated.cwd }, signal);
    expect(refresh).not.toHaveBeenCalled();
    await f.service.refreshGraph(ordinary, signal);
    expect(f.factsForRoot).not.toHaveBeenCalled();
    const project = await f.registry.known(ordinary.projectRoot);
    expect(project).not.toBeNull();
    expect(refresh).toHaveBeenCalledExactlyOnceWith({ projectRoot: ordinary.projectRoot, cwd: ordinary.cwd, projectId: project?.id }, signal, expect.stringMatching(/^[a-f0-9]{40,64}$/));
    f.settings.intelligence!.graphify.excludedProjects = [project!.id];
    await f.service.refreshGraph(ordinary, signal);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('uses real Git registration, not just origin or history, to identify a linked worktree', async () => {
    const f = await fixture();
    const main = (await f.checkout('real main')).cwd;
    const linked = path.join(f.root, 'real linked');
    const clone = path.join(f.root, 'real clone');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(main, 'init', '-q', '-b', 'main');
    git(main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture');
    git(main, 'worktree', 'add', '-q', '-b', 'linked', linked);
    git(f.root, 'clone', '-q', main, clone);
    const origin = 'https://example.invalid/Org/Repo.git';
    git(main, 'remote', 'add', 'origin', origin);
    git(clone, 'remote', 'set-url', 'origin', origin);
    const registry = new ProjectRegistry(path.join(f.root, 'real-registry'), { log, facts: gitIdentityFacts });
    const parent = await registry.resolve(main);
    expect(await gitIdentityFacts(linked)).toMatchObject({ commonDir: await fs.realpath(path.join(main, '.git')), origin });
    expect((await registry.resolve(linked)).id).toBe(parent.id);
    expect((await registry.resolve(clone)).id).not.toBe(parent.id);
    const nested = path.join(main, 'nested');
    await fs.mkdir(nested);
    expect(await gitIdentityFacts(nested)).toEqual({});
  });

  it('shares an identity with registered worktrees, not with separate checkouts until the user links them', async () => {
    const f = await fixture();
    const origin = 'https://user:fixture-password@example.invalid/Org/Repo.git';
    const commonDir = path.join(f.root, 'main', '.git');
    const a = await f.checkout('main', { origin, rootCommit: SHA, commonDir });
    const worktree = await f.checkout('worktree', { origin, rootCommit: SHA, commonDir });
    const clone = await f.checkout('clone', { origin: 'git@example.invalid:Org/Repo.git', rootCommit: SHA, commonDir: path.join(f.root, 'clone', '.git') });
    const fork = await f.checkout('fork', { origin: 'git@example.invalid:Fork/Repo.git', rootCommit: SHA });
    const original = await f.service.project(a);
    expect(original.origin).toBe('example.invalid/org/repo');
    expect((await f.service.project(worktree)).id).toBe(original.id);
    expect((await f.service.project(clone)).id).not.toBe(original.id);
    expect((await f.service.project(fork)).id).not.toBe(original.id);

    const secret = await add(f.service, a, 'Private quinquina guidance.');
    expect((await f.service.recall(worktree, { query: 'quinquina' })).records.map((r) => r.id)).toEqual([secret.id]);
    expect((await f.service.recall(clone, { query: 'quinquina' })).records).toEqual([]);
    expect((await f.service.recall(fork, { query: 'quinquina' })).records).toEqual([]);
    expect(await fs.readFile(f.registry.file, 'utf8')).not.toContain('fixture-password');

    await f.registry.link(clone.projectRoot, original.id);
    const restarted = f.open();
    const lateWorktree = await f.checkout('late-worktree', { commonDir });
    expect((await restarted.service.project(lateWorktree)).id).toBe(original.id);
    expect((await restarted.service.project(clone)).id).toBe(original.id);
    expect((await restarted.service.recall(clone, { query: 'quinquina' })).records.map((r) => r.id)).toEqual([secret.id]);
    expect((await restarted.service.project(fork)).id).not.toBe(original.id);
  });

  it('scopes wiki and FTS before reading/ranking, and resolves collections only when requested and allowed', async () => {
    const f = await fixture();
    const a = await f.checkout('reader');
    const b = await f.checkout('sharing');
    const c = await f.checkout('promoted-only');
    const outside = await f.checkout('outside');
    const [pa, pb, pc] = await Promise.all([a, b, c].map((ctx) => f.service.project(ctx)));
    const saved = await f.service.saveCollection({ name: 'Release guild', members: [member(pa.id), member(pb.id, 'wiki'), member(pc.id)] });

    for (const [ctx, claim] of [[b, 'Quartz wiki guideline.'], [c, 'Quartz unshared wiki.'], [outside, 'Quartz unapproved wiki.']] as const) {
      await f.service.record(ctx, { title: claim, claim, body: 'A sourced explanation with PRIVATESIDEBAR only in the body.', kind: 'decision' }, 'agent:test');
    }
    const branchPage = await f.service.record({ ...b, branch: 'private' }, { title: 'Quartz branch wiki', claim: 'Quartz branch guidance.', body: 'Private branch rationale.', scope: 'branch' }, 'agent:test');
    const source = await add(f.service, b, 'Quartz quartz quartz: promoted recipe.');
    const copy = await f.service.promote(b, { recordId: source.id, to: 'collection', collectionId: saved.id });
    const local = await add(f.service, a, 'Quartz handling stays inside this checkout.');
    const sensitive = f.memory.create(pa.id, { title: 'Quartz quartz quartz quartz', text: 'Quartz session-only evidence.', type: 'working', scope: 'session', sessionId: 'private-session' }, 'agent:test')!;
    const branch = f.memory.create(pa.id, { title: 'Quartz branch record', text: 'Quartz branch-only finding.', type: 'episodic', scope: 'branch', branch: 'feature' }, 'agent:test')!;
    const preferences = await f.service.addRecord(a, { title: 'Quartz preference', text: 'Quartz personal preference.', type: 'preference', scope: 'personal' });

    const search = vi.spyOn(f.memory, 'search');
    const load = vi.spyOn(f.knowledge.store, 'load');
    const grants = vi.spyOn(f.registry, 'grantsFor');
    const own = await f.service.search(a, { query: 'quartz', providers: ['memory', 'collection'], limit: 1 });
    expect(own.scope.collections).toEqual([]);
    expect(own.results.map((r) => r.ref)).toEqual([local.id]);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ collectionIds: [], personal: false, sessionId: a.sessionId }), ['quartz'], expect.objectContaining({ limit: 1 }));
    const packet = await f.service.compile(a, { query: 'quartz', scope: 'project' });
    expect(packet.scope.collections).toEqual([]);
    expect(JSON.stringify(packet)).not.toMatch(/Release guild|promoted recipe|session-only|branch-only|personal preference/);
    expect(grants).not.toHaveBeenCalled();
    expect(load.mock.calls.every(([scope]) => scope.projectRoot === a.projectRoot)).toBe(true);

    const onlyLocal = await f.service.search(a, { query: 'quartz', scope: 'collection', providers: ['memory'], limit: 1 });
    expect(onlyLocal.results.map((r) => r.ref)).toEqual([local.id]);
    expect(grants).not.toHaveBeenCalled();
    expect((await f.service.recall({ ...a, sessionId: 'private-session', branch: 'feature' }, { query: 'quartz' })).records.map((r) => r.id).sort()).toEqual([branch.id, local.id, sensitive.id].sort());
    expect((await f.service.recall(a, { query: 'quartz' })).records.map((r) => r.id)).toEqual([local.id]);

    load.mockClear();
    f.settings.intelligence!.collections = false;
    expect((await f.service.search(a, { query: 'quartz', ...federation })).results).toEqual([]);
    expect(load).not.toHaveBeenCalled();
    expect(grants).not.toHaveBeenCalled();
    f.settings.intelligence!.collections = true;
    expect((await f.service.search(outside, { query: 'quartz', ...federation })).results).toEqual([]);
    expect(load).not.toHaveBeenCalled();
    const shared = await f.service.search(a, { query: 'quartz', ...federation, includeHistorical: true });
    expect(shared.scope.collections).toEqual(['Release guild']);
    expect(shared.results.map((r) => r.ref).sort()).toEqual([copy.id, 'decision/quartz-wiki-guideline'].sort());
    expect(shared.results.some((r) => r.ref === branchPage.id)).toBe(false);
    expect(load.mock.calls.map(([scope]) => normalizeRoot(scope.projectRoot))).toEqual([normalizeRoot(b.projectRoot)]);
    expect((await f.service.search(a, { query: 'privatesidebar', ...federation })).results).toEqual([]);

    f.settings.intelligence!.personalMemory = true;
    expect((await f.service.recall(a, { query: 'quartz' })).records.map((r) => r.id)).toContain(preferences.id);
    const restricted = { ...a, restricted: true };
    expect((await f.service.recall(restricted, { query: 'quartz' })).records.map((r) => r.id)).toEqual([local.id]);
    expect((await f.service.compile(restricted, { query: 'quartz', scope: 'collection' })).scope.collections).toEqual([]);

    // Removing the source from the collection withdraws both its wiki and its prior snapshots.
    await f.service.saveCollection({ id: saved.id, name: saved.name, members: [member(pa.id), member(pc.id)] });
    load.mockClear();
    expect((await f.service.search(a, { query: 'quartz', ...federation })).results).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it('passes only authorized session ids to transcript recall and never invokes it for a restricted session', async () => {
    const history = vi.fn<NonNullable<IntelligenceServiceDeps['history']>>((_query, ids) => ({
      available: true,
      partial: false,
      results: ids.map((sessionId) => ({ sessionId, kind: 'assistant', ts: 1, snippet: `Quartz in ${sessionId}` }))
    }));
    const f = await fixture({ history });
    const a = await f.checkout('current');
    const b = await f.checkout('other');
    f.sessions.push(
      { id: a.sessionId, projectRoot: a.projectRoot, title: 'Current' },
      { id: 'private', projectRoot: a.projectRoot, title: 'Private', private: true },
      { id: 'archived', projectRoot: a.projectRoot, title: 'Archived', archived: true },
      { id: b.sessionId, projectRoot: b.projectRoot, title: 'Another project' }
    );
    await f.service.saveCollection({ name: 'Joined', members: await Promise.all([a, b].map(async (ctx) => member((await f.service.project(ctx)).id, 'wiki'))) });
    const found = await f.service.search(a, { query: 'quartz', scope: 'collection', providers: ['history'], includeHistorical: true });
    expect(found.results.map((r) => r.ref)).toEqual([a.sessionId, 'archived']);
    expect(history.mock.calls[0][1]).toEqual([a.sessionId, 'archived']);
    await f.service.recall(a, { query: 'quartz' });
    expect(history.mock.calls[1][1]).toEqual([a.sessionId]);
    const privateHits = await f.service.search({ ...a, sessionId: 'private' }, { query: 'quartz', providers: ['history'] });
    expect(privateHits.results.find((r) => r.ref === 'private')?.scope).toBe('session');

    history.mockClear();
    const restricted = { ...a, restricted: true };
    expect((await f.service.historySearch(restricted, 'quartz')).results).toEqual([]);
    expect((await f.service.recall(restricted, { query: 'quartz' })).history).toEqual([]);
    expect((await f.service.search(restricted, { query: 'quartz', providers: ['history'] })).results).toEqual([]);
    expect(history).not.toHaveBeenCalled();
  });

  it('queues promotions without publishing and shares only the reviewed preview, never private evidence', async () => {
    const f = await fixture();
    const a = await f.checkout('source');
    const b = await f.checkout('receiver');
    const owner = await f.service.project(a);
    const group = await f.service.saveCollection({ name: 'Team', members: [member(owner.id), member((await f.service.project(b)).id)] });
    const draft = await f.service.record(a, {
      title: 'Retry procedure', claim: 'Bastion retries use a bounded delay.', body: 'INTERNALLOG from a private run.', memoryType: 'episodic',
      sources: [{ type: 'transcript', ref: 'PRIVATE-SESSION-ID', note: 'INTERNALNOTE' }]
    }, 'agent:test');
    const input = { recordId: draft.id, to: 'collection', collection: group.id } as const;
    const request = await f.service.requestPromotion(a, input, 'agent:test');
    expect((await f.service.requestPromotion(a, input, 'agent:test')).id).toBe(request.id);
    expect(request.text).toBe('Bastion retries use a bounded delay.');
    expect((await f.service.search(b, { query: 'bastion', ...federation })).results).toEqual([]);
    await expect(f.service.requestPromotion(b, input, 'agent:test')).rejects.toThrow(/No memory record/);
    await expect(f.service.decidePromotion(b, request.id, 'approve')).rejects.toThrow(/no longer waiting/);
    await expect(f.service.decidePromotion(a, request.id, 'approve')).rejects.toThrow(/verified/);
    expect(await f.service.decidePromotion(a, request.id, 'reject')).toBeNull();
    expect(await f.registry.promotions(owner.id)).toEqual([]);

    const review = await f.service.decide(a, draft.id, 'verified', { note: 'INTERNALREVIEW' });
    expect(review.verification?.method).toBe('human-review');
    const requestedAgain = await f.service.requestPromotion(a, input, 'agent:test');
    const copy = (await f.service.decidePromotion(a, requestedAgain.id, 'approve'))!;
    expect(copy.text).toBe(requestedAgain.text);
    expect(copy.sources).toEqual([{ type: 'doc', ref: `memory:${draft.id}`, projectId: owner.id }]);
    expect(JSON.stringify(copy)).not.toMatch(/PRIVATE-SESSION-ID|INTERNAL|sessionId|branch/);
    const remote = await f.service.search(b, { query: 'bastion', ...federation });
    expect(remote.results).toMatchObject([{ ref: copy.id, projectId: owner.id, authority: 'human-reviewed' }]);
    expect(JSON.stringify(remote)).not.toMatch(/PRIVATE-SESSION-ID|INTERNAL/);
    expect((await f.service.search(b, { query: 'internallog', ...federation })).results).toEqual([]);
    await expect(f.service.forget(b, copy.id, 'agent')).rejects.toThrow();
    await expect(f.service.forget(a, draft.id, 'agent')).rejects.toThrow(/reviewed or shared/);
    await f.service.decide(a, copy.id, 'revoked');
    expect(f.memory.getAny(copy.id)).toBeNull();
    expect((await f.service.search(b, { query: 'bastion', ...federation, includeHistorical: true })).results).toEqual([]);
    expect(f.memory.getAny(draft.id)?.state).toBe('verified');
    await expect(f.service.promote(a, { ...input, collectionId: group.id })).rejects.toThrow(/tombstoned/);
  });

  it('binds a pending approval to its exact reviewed preview and serializes rejection against approval', async () => {
    const f = await fixture();
    const a = await f.checkout('author');
    const scope = { ...a, branch: 'feature' };
    const page = await f.service.record(scope, { title: 'Runbook', claim: 'Bastion restarts after a check.', body: 'A private appendix.', scope: 'branch' }, 'human');
    const source = { pageId: page.id, to: 'personal' } as const;
    const stale = await f.service.requestPromotion(scope, source, 'agent:test');
    await expect(f.service.decidePromotion(a, stale.id, 'approve')).rejects.toThrow(/source checkout and branch/);
    await f.service.record(scope, { pageId: page.id, title: 'Runbook', claim: 'Bastion restarts without a check.', body: 'A different private appendix.', scope: 'branch' }, 'human');
    await expect(f.service.decidePromotion(scope, stale.id, 'approve')).rejects.toThrow(/source changed/);
    expect((await f.service.view(scope)).personal).toEqual([]);
    const fresh = await f.service.requestPromotion(scope, source, 'agent:test');
    expect(fresh.id).not.toBe(stale.id);
    const rejected = f.service.decidePromotion(scope, fresh.id, 'reject');
    const racedApproval = f.service.decidePromotion(scope, fresh.id, 'approve');
    await expect(Promise.allSettled([rejected, racedApproval])).resolves.toMatchObject([{ status: 'fulfilled', value: null }, { status: 'rejected', reason: { message: expect.stringMatching(/no longer waiting/) } }]);
    expect((await f.service.view(scope)).personal).toEqual([]);
  });

  it('retires pending requests and both kinds of shared snapshot when the originating wiki page is removed', async () => {
    const f = await fixture();
    const a = await f.checkout('retiring-author');
    const b = await f.checkout('retaining-author');
    const [pa, pb] = await Promise.all([a, b].map((ctx) => f.service.project(ctx)));
    const group = await f.service.saveCollection({ name: 'Team', members: [member(pa.id), member(pb.id)] });
    const pageInput = { title: 'Runbook', claim: 'Marjoram uses a temporary directory.', body: 'Private implementation details.' };
    const [pageA, pageB] = await Promise.all([a, b].map((ctx) => f.service.record(ctx, pageInput, 'human')));
    expect(pageA.id).toBe(pageB.id);
    const collection = { pageId: pageA.id, to: 'collection', collection: group.id } as const;
    const pending = await f.service.requestPromotion(a, collection, 'agent:test');
    const unrelated = await f.service.requestPromotion(b, collection, 'agent:test');
    const shared = await f.service.promote(a, { pageId: pageA.id, to: 'collection', collectionId: group.id });
    const personal = await f.service.promote(a, { pageId: pageA.id, to: 'personal' });
    expect((await f.service.search(b, { query: 'marjoram', ...federation })).results).toMatchObject([{ ref: shared.id }]);
    expect(await f.knowledge.store.deletePage(a, pageA.id)).toBe(true);
    await f.service.retireWikiPromotions(a, pageA.id);

    f.memory.close();
    const reopened = f.open();
    expect(await reopened.registry.promotions(pa.id)).toEqual([]);
    expect((await reopened.registry.promotions(pb.id)).map((request) => request.id)).toEqual([unrelated.id]);
    expect(reopened.memory.getAny(shared.id)).toBeNull();
    expect(reopened.memory.getAny(personal.id)).toBeNull();
    await expect(reopened.service.decidePromotion(a, pending.id, 'approve')).rejects.toThrow(/no longer waiting/);
    expect((await reopened.service.search(b, { query: 'marjoram', ...federation })).results).toEqual([]);
    expect((await reopened.knowledge.store.read(b, pageB.id))?.meta.claim).toBe(pageInput.claim);
  });

  it('does not verify a claim merely because its Git citation exists, or overwrite a human review', async () => {
    const f = await fixture({ git: { head: async () => SHA, resolveCommit: async () => SHA } });
    const a = await f.checkout('workspace');
    const cited = [{ type: 'commit' as const, ref: SHA.slice(0, 12) }];
    const episode = await f.service.record(a, { title: 'Incident', claim: 'Fennel recovered on the third attempt.', sources: cited, memoryType: 'episodic' }, 'agent:test');
    expect(episode).toMatchObject({ authority: 'candidate', state: 'candidate' });
    expect(episode.verification).toBeUndefined();
    expect((await f.service.recall(a, { query: 'fennel', includeUnverified: false })).records).toEqual([]);
    expect(f.memory.getAny(episode.id)?.sources[0].revision).toBe(SHA);
    expect(() => f.memory.transition(episode.id, 'verified', 'agent')).toThrow(/needs recorded verification/);
    expect(() => f.memory.transition(episode.id, 'active', 'agent')).toThrow(/Only the user/);
    const reviewed = await f.service.decide(a, episode.id, 'verified');
    expect(reviewed.expiresAt).toBeUndefined();
    expect((await f.service.recall(a, { query: 'fennel', includeUnverified: false })).records).toMatchObject([{ id: episode.id, servable: true }]);

    const page = await f.service.record(a, { title: 'Fennel restart', claim: 'Fennel intentionally starts once.', body: 'The design tradeoff.', sources: cited, kind: 'decision' }, 'agent:test');
    expect(page).toMatchObject({ state: 'active', authority: 'accepted' });
    await f.knowledge.review(a, page.id, 'accept', { by: 'human' });
    const mutation = await f.service.record(a, { pageId: page.id, title: 'Fennel reset', claim: 'Fennel should never start.', body: 'An unsupported counterclaim.', kind: 'decision' }, 'agent:test');
    expect(mutation).toMatchObject({ state: 'candidate', authority: 'candidate' });
    expect((await f.knowledge.store.read(a, page.id))?.meta.claim).toBe('Fennel intentionally starts once.');
    const suggestion = (await f.service.recall(a, { query: 'counterclaim' })).records[0];
    expect(suggestion).toMatchObject({ state: 'candidate', servable: false });
    await f.knowledge.store.patch(a, page.id, { status: 'superseded' });
    const history = await f.service.search(a, { query: 'fennel', providers: ['wiki'], includeHistorical: true });
    expect(history.results).toMatchObject([{ ref: page.id, historical: true, authority: 'history' }]);
    f.advance(365);
    expect((await f.service.recall(a, { query: 'fennel', includeUnverified: false })).records.map((r) => r.id)).toEqual([episode.id]);
  });

  it('revokes copies with their source, then deletes source, derived FTS rows and pending previews across reopen', async () => {
    const f = await fixture();
    const a = await f.checkout('author');
    const b = await f.checkout('reader');
    const p = await f.service.project(a);
    const group = await f.service.saveCollection({ name: 'Team', members: [member(p.id), member((await f.service.project(b)).id)] });
    const withdrawn = await add(f.service, a, 'Butterscotch will be withdrawn from the collection.');
    const withdrawnCopy = await f.service.promote(a, { recordId: withdrawn.id, to: 'collection', collectionId: group.id });
    await f.service.decide(a, withdrawn.id, 'revoked');
    expect(f.memory.getAny(withdrawnCopy.id)).toBeNull();
    expect((await f.service.search(b, { query: 'butterscotch', ...federation, includeHistorical: true })).results).toEqual([]);

    const source = await capture(f.service, a, 'Scarletborage requires an isolated fixture.');
    await f.service.decide(a, source.id, 'verified');
    const approved = await f.service.promote(a, { recordId: source.id, to: 'collection', collectionId: group.id });
    await f.service.requestPromotion(a, { recordId: source.id, to: 'personal', reason: 'REVIEWPREVIEW' }, 'agent:test');
    const bundle = await f.service.exportMemory(a);
    expect((await f.service.search(b, { query: 'scarletborage', ...federation })).results).toMatchObject([{ ref: approved.id }]);

    // If the derived delete fails, the source delete and its tombstone must roll back too.
    const connection = new DatabaseSync(f.memory.file);
    try {
      connection.exec(`CREATE TRIGGER deny_shared_delete BEFORE DELETE ON records WHEN old.scope = 'collection' BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END`);
      await expect(f.service.forget(a, source.id, 'human')).rejects.toThrow(/injected delete failure/);
      expect(f.memory.getAny(source.id)).not.toBeNull();
      expect(f.memory.getAny(approved.id)).not.toBeNull();
      expect(f.memory.isTombstoned(p.id, bundle.records[0].text)).toBe(false);
      connection.exec('DROP TRIGGER deny_shared_delete');
    } finally {
      connection.close();
    }
    expect(await f.service.forget(a, source.id, 'human')).toEqual({ forgotten: true, derived: 1 });
    f.memory.close();

    const resumed = f.open();
    expect(await resumed.registry.promotions(p.id)).toEqual([]);
    expect(await fs.readFile(resumed.registry.file, 'utf8')).not.toContain('REVIEWPREVIEW');
    expect(resumed.memory.getAny(source.id)).toBeNull();
    expect(resumed.memory.getAny(approved.id)).toBeNull();
    expect((await resumed.service.search(a, { query: 'scarletborage', providers: ['memory'], includeHistorical: true })).results).toEqual([]);
    expect((await resumed.service.search(b, { query: 'scarletborage', ...federation })).results).toEqual([]);
    const inspector = new DatabaseSync(resumed.memory.file, { readOnly: true });
    try {
      // Query the FTS table itself: a stale index row could otherwise be hidden by the JOIN.
      expect(inspector.prepare("SELECT COUNT(*) AS n FROM records_fts WHERE records_fts MATCH 'scarletborage'").get()?.n).toBe(0);
    } finally {
      inspector.close();
    }
    expect(await capture(resumed.service, a, 'SCARLETBORAGE requires an isolated fixture!')).toMatchObject({ stored: 'none', state: 'rejected' });
    expect(await resumed.service.importMemory(a, bundle)).toEqual({ imported: 0, skipped: 1 });
    expect((await capture(resumed.service, b, 'Scarletborage requires an isolated fixture.')).stored).toBe('memory');
    expect(JSON.stringify(resumed.memory.auditTrail(p.id))).not.toMatch(/scarletborage|REVIEWPREVIEW/i);
  });

  it('never recaptures rejected text and will not widen or verify an imported untrusted bundle', async () => {
    const f = await fixture();
    const ctx = await f.checkout('author');
    const proposal = await capture(f.service, ctx, 'Ironbark must remain unapproved.');
    await f.service.decide(ctx, proposal.id, 'rejected');
    expect((await capture(f.service, ctx, 'Ironbark must remain unapproved!')).stored).toBe('none');
    await expect(f.service.applyToWiki(ctx, proposal.id)).rejects.toThrow(/live record/);

    const input = { type: 'procedural', title: 'Imported claim', text: 'Wormwood import testing.', state: 'verified', origin: 'human', verification: { method: 'human-review' } };
    const records = ['personal', 'collection', 'session', 'project'].map((scope, index) => ({ ...input, id: `mem_import${index}`, scope }));
    expect(await f.service.importMemory(ctx, { format: 'vocs-memory-export', version: 1, records })).toEqual({ imported: 1, skipped: 3 });
    expect((await f.service.recall(ctx, { query: 'wormwood' })).records).toMatchObject([{ id: 'mem_import3', origin: 'import', state: 'candidate', servable: false }]);
  });

  it('honors grant cancellation during async source checks and refuses to persist a pending request after cancellation', async () => {
    const stopped = new AbortController();
    const f = await fixture({ git: { head: async () => SHA, resolveCommit: async () => { stopped.abort(); return SHA; } } });
    const a = await f.checkout('author');
    await expect(f.service.record({ ...a, signal: stopped.signal }, { title: 'Canceled', claim: 'Canceled claim.', body: 'Must not write.', sources: [{ type: 'commit', ref: SHA }] }, 'agent:test')).rejects.toThrow(/abort/i);
    expect(await f.knowledge.store.load(a)).toEqual([]);
    expect((await f.service.recall(a, {})).records).toEqual([]);
    const wiki = await f.service.record(a, { title: 'Reviewed note', claim: 'Reviewed note about wax.', body: 'Reviewed before publication.' }, 'human');
    const abortDuringRead = new AbortController();
    const originalRead = f.knowledge.store.read.bind(f.knowledge.store);
    vi.spyOn(f.knowledge.store, 'read').mockImplementationOnce(async (...args) => {
      const page = await originalRead(...args);
      abortDuringRead.abort();
      return page;
    });
    await expect(f.service.requestPromotion({ ...a, signal: abortDuringRead.signal }, { pageId: wiki.id, to: 'personal' }, 'agent:test')).rejects.toThrow(/abort/i);
    expect(await f.registry.promotions()).toEqual([]);
  });

  it('reflects only with consent and redacts before both the prompt and candidate persistence', async () => {
    const token = 'ghp_' + 'x'.repeat(32);
    const fixtureKey = 'KEY-FIXTURE-CONTENT';
    const knowledgeTitle = `Retry lesson ${token}`;
    const transcript = vi.fn(async () => [`user: Investigate quartz ${token}`, '-----BEGIN PRIVATE KEY-----', fixtureKey, '-----END PRIVATE KEY-----', 'assistant: A bounded retry resolved the failure.']);
    const complete = vi.fn(async (_: Parameters<NonNullable<IntelligenceServiceDeps['completer']>['complete']>[0]) => JSON.stringify({
      lessons: [
        { title: knowledgeTitle, kind: 'procedure', text: `The bounded retry was successful on the fixture using ${token}.`, commit: SHA },
        { title: 'Inferred preference', kind: 'preference', text: 'This must not enter project or personal memory.' }
      ]
    }));
    const f = await fixture({ transcript, completer: { complete, label: () => 'fixture/utility' }, git: { head: async () => SHA, resolveCommit: async () => SHA } });
    const a = await f.checkout('work');
    const session = { title: `Work session ${token}` };
    f.settings.intelligence!.reflection = 'off';
    expect(await f.service.reflect(a, session, 'manual')).toMatchObject({ ok: false, captured: 0 });
    f.settings.intelligence!.reflection = 'manual';
    expect(await f.service.reflect(a, session, 'auto')).toMatchObject({ ok: true, captured: 0 });
    expect(await f.service.reflect({ ...a, restricted: true }, session, 'manual')).toMatchObject({ ok: false, captured: 0 });
    expect(transcript).not.toHaveBeenCalled();
    expect(await f.service.reflect(a, session, 'manual')).toMatchObject({ ok: true, captured: 1, candidates: 0 });
    expect(complete).not.toHaveBeenCalled();

    f.settings.utilityModel = { provider: 'fixture', model: 'utility' };
    f.settings.intelligence!.reflection = 'auto';
    const next = { ...a, sessionId: 'clean-auto-session' };
    expect(await f.service.reflect(next, session, 'auto')).toMatchObject({ ok: true, captured: 1, candidates: 1 });
    expect(await f.service.reflect(next, session, 'auto')).toMatchObject({ ok: true, captured: 0, candidates: 0 });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].prompt).toContain('<private-key>');
    expect(JSON.stringify(complete.mock.calls)).not.toContain(fixtureKey);
    expect(JSON.stringify(complete.mock.calls)).not.toContain(token);
    const records = (await f.service.recall(a, {})).records;
    expect(records.map((r) => `${r.type}:${r.state}:${r.scope}`).sort()).toEqual(['episodic:captured:project', 'episodic:captured:project', 'procedural:candidate:project']);
    expect(JSON.stringify(records)).not.toContain(token);
    expect(await f.knowledge.store.hasWiki(a)).toBe(false);
  });

  it('does not make a failed registry write visible and can retry the operation', async () => {
    const f = await fixture();
    const a = await f.checkout('author');
    const project = await f.service.project(a);
    const backup = `${f.registry.file}.backup`;
    await fs.rename(f.registry.file, backup);
    await fs.mkdir(f.registry.file);
    try {
      await expect(f.registry.rename(project.id, 'Uncommitted name')).rejects.toThrow();
      expect((await f.registry.project(project.id))?.name).toBe(project.name);
    } finally {
      await fs.rmdir(f.registry.file);
      await fs.rename(backup, f.registry.file);
    }
    await expect(f.registry.rename(project.id, 'Committed name')).resolves.toMatchObject({ name: 'Committed name' });
    expect((await f.open().registry.project(project.id))?.name).toBe('Committed name');
  });
});
