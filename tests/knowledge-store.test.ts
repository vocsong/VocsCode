/** Layer 2 store + service: scoping, automated ingestion, the evidence rule, search and publish. */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { KnowledgeStore } from '../src/main/knowledge/store';
import { KnowledgeService } from '../src/main/knowledge/service';
import type { AppSettings } from '../src/shared/types';
import { claimKey, type KnowledgePageMeta, type KnowledgeScope } from '../src/shared/knowledge';
import { withKnowledgeWriteLock } from '../resources/mcp/knowledge-write.mjs';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

function tmpDir(prefix: string): string {
  const d = fsSync.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function service(over: { autoDistill?: boolean } = {}): KnowledgeService {
  const settings = { knowledge: { prime: true, autoDistill: over.autoDistill ?? false } } as AppSettings;
  return new KnowledgeService({ log: () => undefined, settings: () => settings });
}

function pageMeta(over: Partial<KnowledgePageMeta> = {}): KnowledgePageMeta {
  return {
    id: 'conventions/harness-lifecycle',
    title: 'Harness lifecycle',
    kind: 'convention',
    status: 'current',
    scope: 'repo',
    keywords: ['harness', 'session'],
    labels: [],
    sources: [],
    anchors: [],
    related: [],
    supersedes: [],
    contradicts: [],
    ...over
  };
}

describe('knowledge store scoping', () => {
  it('keeps branch pages inside the project wiki and merges them by id', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const cwd = path.join(projectRoot, '.vocs-code', 'worktrees', 'feature');
    await fs.mkdir(cwd, { recursive: true });
    const store = new KnowledgeStore();
    const repoScope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const branchScope: KnowledgeScope = { projectRoot, cwd, branch: 'vocscode/feature' };

    await store.write(repoScope, pageMeta({ id: 'architecture/standalone', title: 'Standalone', scope: 'repo' }), 'repo body');
    await store.write(repoScope, pageMeta({ title: 'Harness lifecycle' }), 'repo body');
    await store.write(branchScope, pageMeta({ title: 'Harness lifecycle (branch)', scope: 'branch', branch: 'vocscode/feature' }), 'branch body');

    // The branch page lives in the project wiki, never in the worktree that will be deleted.
    const branchFile = path.join(projectRoot, '.vocs-code', 'wiki', 'branches', 'vocscode-feature', 'conventions', 'harness-lifecycle.md');
    expect(await fs.readFile(branchFile, 'utf8')).toContain('branch: vocscode/feature');
    await expect(fs.stat(path.join(cwd, '.vocs-code'))).rejects.toThrow();

    const merged = await store.load(branchScope);
    expect(merged.map((p) => p.meta.id).sort()).toEqual(['architecture/standalone', 'conventions/harness-lifecycle']);
    const overridden = merged.find((p) => p.meta.id === 'conventions/harness-lifecycle');
    expect(overridden?.body).toBe('branch body');
    expect(overridden?.meta.scope).toBe('branch');

    // A session in the project root sees only the repo page; other branches never leak in.
    const plain = await store.load(repoScope);
    expect(plain.find((p) => p.meta.id === 'conventions/harness-lifecycle')?.body).toBe('repo body');
    expect(plain.map((p) => p.meta.id)).not.toContain('branches');
    const otherBranch = await store.load({ projectRoot, cwd, branch: 'vocscode/other' });
    expect(otherBranch.find((p) => p.meta.id === 'conventions/harness-lifecycle')?.body).toBe('repo body');
  });

  it('files a worktree discovery into the project wiki, not the worktree', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const cwd = path.join(projectRoot, '.vocs-code', 'worktrees', 'feature');
    await fs.mkdir(cwd, { recursive: true });
    const repoScope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const branchScope: KnowledgeScope = { projectRoot, cwd, branch: 'vocscode/feature' };
    const svc = service();

    const filed = await svc.propose(branchScope, { title: 'PTY ownership', claim: 'Only the main process owns a PTY.', body: 'Body text long enough to be a real page.', kind: 'gotcha' }, 'agent:pi', 's1');
    expect(filed.promoted).toBe(true);

    // The page belongs to the project: a session in the main checkout can read it.
    const fromRoot = await svc.detail(repoScope, 'gotcha/pty-ownership');
    expect(fromRoot?.page.meta.scope).toBe('repo');
    expect(await fs.readFile(path.join(projectRoot, '.vocs-code', 'wiki', 'gotcha', 'pty-ownership.md'), 'utf8')).toContain('Only the main process owns a PTY.');
    await expect(fs.stat(path.join(cwd, '.vocs-code'))).rejects.toThrow();
  });

  it('reports a delete only when a file was actually removed', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const cwd = path.join(projectRoot, '.vocs-code', 'worktrees', 'feature');
    await fs.mkdir(cwd, { recursive: true });
    const repoScope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const branchScope: KnowledgeScope = { projectRoot, cwd, branch: 'vocscode/feature' };
    const store = new KnowledgeStore();
    await store.write(repoScope, pageMeta({ scope: 'repo' }), 'repo body');

    // The branch dir holds nothing, and `fs.rm(force: true)` resolves for a missing path: without a
    // real existence check the branch slice would claim the delete and this page would survive.
    expect(await store.deletePage(branchScope, 'conventions/harness-lifecycle')).toBe(true);
    expect(await store.read(repoScope, 'conventions/harness-lifecycle')).toBeNull();
    expect(await store.load(branchScope)).toHaveLength(0);

    // Nothing left to remove in either scope, so a second delete must not report success.
    expect(await store.deletePage(branchScope, 'conventions/harness-lifecycle')).toBe(false);
  });

  it('reports a page stale when a cited file disappears or changes', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const store = new KnowledgeStore();
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    await fs.writeFile(path.join(projectRoot, 'code.ts'), 'export const x = 1;\n', 'utf8');
    const written = await store.write(scope, pageMeta({ sources: [{ type: 'file', ref: 'code.ts' }] }), 'body');
    // A file changed after the page was written is the stale signal; backdate the page's stamp.
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(projectRoot, 'code.ts'), later, later);
    const fresh = await store.staleness(scope, written);
    expect(fresh.stale).toBe(true);
    expect(fresh.reasons.join(' ')).toContain('code.ts');
    await fs.rm(path.join(projectRoot, 'code.ts'));
    const gone = await store.staleness(scope, written);
    expect(gone.reasons.join(' ')).toContain('no longer exists');
  });
});

describe('knowledge service ingestion', () => {
  it.each([
    ['C++ is required.', 'C# is required.'],
    ['The key is Foo.', 'The key is foo.'],
    ['缓存必须持久化。', '缓存不可持久化。']
  ])('preserves exact claim identity, including punctuation, case and Unicode (%s)', async (claim, different) => {
    const projectRoot = tmpDir('vocs-kb-exact-');
    const scope = { projectRoot, cwd: projectRoot };
    const svc = service();
    const first = await svc.propose(scope, { title: 'Exact identity', claim, body: 'first body' }, 'agent', 's1');
    await svc.propose(scope, { title: 'Exact identity', claim, body: 'repeated body' }, 'agent', 's2');
    const file = path.join(svc.store.repoDir(scope), `${first.id}.md`);
    const before = await fs.readFile(file, 'utf8');
    await expect(svc.propose(scope, { title: 'Exact identity', claim: different, body: 'replacement' }, 'agent', 's3')).rejects.toThrow(/different claim/);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect((await svc.store.load(scope)).map((p) => p.meta.claim)).toEqual([claim]);
  });

  it.each([
    ['Same title', 'Same title'],
    ['A & B', 'A / B'],
    [`${'a'.repeat(60)} first`, `${'a'.repeat(60)} second`]
  ])('refuses unrelated claims whose titles generate the same id (%s)', async (firstTitle, secondTitle) => {
    const projectRoot = tmpDir('vocs-kb-collision-');
    const scope = { projectRoot, cwd: projectRoot };
    const svc = service();
    const first = await svc.propose(scope, { title: firstTitle, claim: 'The original claim.', body: 'original body', labels: ['original'] }, 'agent:first', 's1');
    const wiki = svc.store.repoDir(scope);
    const file = path.join(wiki, `${first.id}.md`);
    const before = await fs.readFile(file, 'utf8');
    const evidence = await fs.readFile(path.join(wiki, '_evidence.json'), 'utf8');
    await expect(svc.propose(scope, { title: secondTitle, claim: 'An unrelated claim.', body: 'replacement', supersedes: [first.id] }, 'agent:second', 's2')).rejects.toThrow(/different title.*pageId.*page_id/i);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(await fs.readFile(path.join(wiki, '_evidence.json'), 'utf8')).toBe(evidence);
    expect(await svc.store.load(scope)).toHaveLength(1);
  });

  it('does not mistake a hash collision, a substring or a truncated claim for identity', async () => {
    const scopeRoot = tmpDir('vocs-kb-identity-');
    const scope = { projectRoot: scopeRoot, cwd: scopeRoot };
    const svc = service();
    const claims = ['claim ep3txk14adwdaeyh1085rcn12yo1a63otbxug55a', 'claim puezp2ukksp1y031bb819jg1c3pufk171h1clm19oq'];
    expect(claimKey(claims[0])).toBe(claimKey(claims[1]));
    await svc.propose(scope, { title: 'First hash', claim: claims[0], body: 'first' }, 'agent');
    await svc.propose(scope, { title: 'Second hash', claim: claims[1], body: 'second' }, 'agent');
    expect(await svc.store.load(scope)).toHaveLength(2);
    for (const claim of ['A sufficiently long claim about main process ownership', 'a'.repeat(310)]) {
      const filed = await svc.propose(scope, { title: claim, claim, body: 'first' }, 'agent');
      await expect(svc.propose(scope, { title: claim, claim: `${claim} but not always`, body: 'second' }, 'agent')).rejects.toThrow(/different claim/);
      expect((await svc.store.read(scope, filed.id))?.body).toBe('first');
    }
  });

  it('serializes competing service instances so only one unrelated implicit proposal wins', async () => {
    const projectRoot = tmpDir('vocs-kb-race-');
    const scope = { projectRoot, cwd: projectRoot };
    const services = Array.from({ length: 4 }, () => service());
    const results = await Promise.allSettled(services.map((svc, index) => svc.propose(scope, { title: index % 2 ? 'Race / title' : 'Race & title', claim: `Claim ${index}.`, body: `Complete body ${index}`, labels: [`winner-${index}`] }, 'agent', `s${index}`)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3);
    const winner = results.findIndex((r) => r.status === 'fulfilled');
    const pages = await new KnowledgeStore().load(scope);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ body: `Complete body ${winner}`, meta: { claim: `Claim ${winner}.`, labels: [`winner-${winner}`], evidenceCount: 1 } });
    const evidence = JSON.parse(await fs.readFile(path.join(services[0].store.repoDir(scope), '_evidence.json'), 'utf8'));
    expect(Object.values(evidence)).toEqual([expect.objectContaining({ count: 1, sessions: [`s${winner}`] })]);
  });

  it('merges explicit updates from fresh metadata across instances and retains provenance', async () => {
    const projectRoot = tmpDir('vocs-kb-update-');
    const scope = { projectRoot, cwd: projectRoot };
    const svc = service();
    const id = 'concept/shared';
    await svc.store.write(scope, pageMeta({ id, claim: 'Original claim.', createdAt: '2020-01-01T00:00:00.000Z', labels: ['original'], review: { state: 'reviewed', by: 'human', note: 'Keep this provenance.' }, confidence: 'high' }), 'old');
    const writers = Array.from({ length: 4 }, () => service());
    await Promise.all(writers.map((writer) => writer.store.read(scope, id))); // prime stale caches
    const results = await Promise.all(writers.map((writer, index) => writer.propose(scope, { pageId: id, title: 'Shared', claim: `Replacement ${index}`, body: `Complete ${index}`, labels: [`label-${index}`], sources: [{ type: 'file', ref: `${index}.ts` }] }, 'agent', `s${index}`)));
    expect(results).toHaveLength(4);
    const page = await new KnowledgeStore().read(scope, id);
    expect(page?.meta).toMatchObject({ createdAt: '2020-01-01T00:00:00.000Z', confidence: 'high', evidenceCount: 4, review: { state: 'reviewed', by: 'human', note: 'Keep this provenance.' } });
    expect(page?.meta.labels.slice().sort()).toEqual(['label-0', 'label-1', 'label-2', 'label-3', 'original']);
    expect(page?.meta.sources.map((s) => s.ref).sort()).toEqual(['0.ts', '1.ts', '2.ts', '3.ts']);
    expect(page?.body).toBe(`Complete ${page?.meta.claim?.slice(-1)}`);
  });

  it('keeps normalized same-claim updates on one page and records every session', async () => {
    const projectRoot = tmpDir('vocs-kb-repeat-');
    const scope = { projectRoot, cwd: projectRoot };
    const first = await service().propose(scope, { title: 'First name', claim: 'The main process owns state.', body: 'original' }, 'agent', 's0');
    const results = await Promise.all(Array.from({ length: 3 }, (_, index) => service().propose(scope, { title: `New name ${index}`, claim: 'The main  process  owns state.', body: `body ${index}`, labels: [`label-${index}`] }, 'agent', `s${index + 1}`)));
    expect(results.map((r) => r.id)).toEqual([first.id, first.id, first.id]);
    expect(results.map((r) => r.evidenceCount).sort()).toEqual([2, 3, 4]);
    const pages = await new KnowledgeStore().load(scope);
    expect(pages).toHaveLength(1);
    expect(pages[0].meta.evidenceCount).toBe(4);
  });

  it('keeps the old complete page and releases the lock after a failed rename, then recovers', async () => {
    const projectRoot = tmpDir('vocs-kb-failure-');
    const scope = { projectRoot, cwd: projectRoot };
    const svc = service();
    const first = await svc.propose(scope, { title: 'Failure recovery', claim: 'Original claim.', body: 'original body' }, 'agent', 's1');
    const wiki = svc.store.repoDir(scope);
    const file = path.join(wiki, `${first.id}.md`);
    const before = await fs.readFile(file, 'utf8');
    const evidence = await fs.readFile(path.join(wiki, '_evidence.json'), 'utf8');
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === file) throw Object.assign(new Error('injected rename failure'), { code: 'EACCES' });
      return originalRename(from, to);
    });
    try {
      await expect(svc.propose(scope, { pageId: first.id, title: 'Failure recovery', claim: 'Changed claim.', body: 'replacement body' }, 'agent', 's2')).rejects.toThrow('injected rename failure');
    } finally {
      rename.mockRestore();
    }
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(await fs.readFile(path.join(wiki, '_evidence.json'), 'utf8')).toBe(evidence);
    expect(await fs.readdir(path.dirname(file))).toEqual(['failure-recovery.md']);
    await expect(fs.stat(path.join(wiki, '_write.lock'))).rejects.toThrow();
    expect((await svc.propose(scope, { pageId: first.id, title: 'Failure recovery', claim: 'Changed claim.', body: 'recovered body' }, 'agent', 's2')).promoted).toBe(true);
    expect((await new KnowledgeStore().read(scope, first.id))?.body).toBe('recovered body');
  });

  it('fails closed on an abandoned lock and requires deliberate offline recovery', async () => {
    const root = tmpDir('vocs-kb-lock-');
    const lock = path.join(root, '_write.lock');
    await fs.mkdir(lock);
    await fs.utimes(lock, new Date(0), new Date(0));
    let executed = false;
    await expect(withKnowledgeWriteLock(root, async () => { executed = true; }, { timeoutMs: 30 })).rejects.toThrow(/stop all app\/MCP writers/);
    expect(executed).toBe(false);
    expect((await fs.stat(lock)).isDirectory()).toBe(true);
    await fs.rmdir(lock); // operator recovery only after all writers have stopped
    const scope = { projectRoot: root, cwd: root };
    expect((await service().propose(scope, { title: 'Recovered', claim: 'Recovery works.', body: 'complete' }, 'agent')).promoted).toBe(true);
  });

  it('refuses a malformed existing destination rather than treating it as absent', async () => {
    const projectRoot = tmpDir('vocs-kb-invalid-');
    const scope = { projectRoot, cwd: projectRoot };
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    await fs.mkdir(path.join(wiki, 'concept'), { recursive: true });
    const file = path.join(wiki, 'concept', 'damaged.md');
    await fs.writeFile(file, 'hand-written document without frontmatter');
    await expect(service().propose(scope, { title: 'Damaged', claim: 'New claim.', body: 'replacement' }, 'agent')).rejects.toThrow(/invalid knowledge page/);
    expect(await fs.readFile(file, 'utf8')).toBe('hand-written document without frontmatter');
    await expect(fs.stat(path.join(wiki, '_evidence.json'))).rejects.toThrow();
  });

  it('ingests a claim into a current, servable page immediately (no review step)', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const svc = service();
    const filed = await svc.propose(scope, { title: 'PTY ownership', claim: 'Renderer reconnects can double PTYs.', body: '## Why\n\nThe main process owns PTY lifetime.', kind: 'gotcha' }, 'agent:pi', 's1');
    expect(filed.promoted).toBe(true);
    expect(filed.rejected).toBe(false);

    const view = await svc.view(scope);
    expect(view.proposals).toHaveLength(0);
    expect(view.status.proposals).toBe(0);
    expect(view.pages).toHaveLength(1);
    expect(view.pages[0].status).toBe('current');

    const detail = await svc.detail(scope, view.pages[0].id);
    expect(detail?.page.body).toContain('main process owns PTY lifetime');
  });

  it('records repeated evidence on the same page instead of queueing it', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const svc = service();
    const first = await svc.propose(scope, { title: 'Reconnect safety', claim: 'Reconnects must happen in the main process.', body: 'Body text long enough to be a real page body.' }, 'agent:pi', 's1');
    expect(first.promoted).toBe(true);
    const second = await svc.propose(scope, { title: 'Reconnect safety', claim: 'Reconnects must happen in the main process.', body: 'Body text long enough to be a real page body.' }, 'agent:codex', 's2');
    expect(second.evidenceCount).toBe(2);

    const view = await svc.view(scope);
    expect(view.proposals).toHaveLength(0);
    expect(view.pages).toHaveLength(1);
    expect(view.pages[0].status).toBe('current');
    expect(view.pages[0].evidenceCount).toBe(2);
  });

  it.each(['We should cache transcripts in the repo.', 'WE SHOULD cache transcripts in the repo!'])('remembers a rejected claim and refuses to refile it (%s)', async (claim) => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const svc = service();
    const filed = await svc.propose(scope, { title: 'Bad idea', claim: 'We should cache transcripts in the repo.', body: 'Body.' }, 'agent:pi', 's1');
    await svc.review(scope, filed.id, 'reject', { by: 'human' });
    const again = await svc.propose(scope, { title: 'Bad idea again', claim, body: 'Body.' }, 'agent:pi', 's2');
    expect(again.rejected).toBe(true);
    const view = await svc.view(scope);
    expect(view.rejectedClaims).toContain('We should cache transcripts in the repo.');
    expect(await svc.store.read(scope, 'concept/bad-idea')).toBeNull();
  });

  it('refuses to tombstone a claim whose page survived the delete', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const store = new KnowledgeStore();
    const svc = new KnowledgeService({ log: () => undefined, settings: () => ({ knowledge: { prime: true, autoDistill: false } }) as AppSettings, store });
    await store.write(scope, pageMeta({ claim: 'A claim that will not go away.' }), 'body');
    // A store whose unlink succeeds without removing anything — what `fs.rm(force)` did.
    Object.assign(store, { deletePage: async () => false });

    await expect(svc.review(scope, 'conventions/harness-lifecycle', 'reject', { by: 'human' })).rejects.toThrow(/not tombstoned/);
    // The page is still served, so remembering the claim as removed would be a lie the tools act on.
    expect(await store.rejectedClaims(scope)).toEqual([]);
    expect(await store.read(scope, 'conventions/harness-lifecycle')).not.toBeNull();
  });

  it('leaves an uncertain page alone when everything pending is accepted at once', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const store = new KnowledgeStore();
    const svc = new KnowledgeService({ log: () => undefined, settings: () => ({ knowledge: { prime: true, autoDistill: false } }) as AppSettings, store });
    await store.write(scope, pageMeta({ id: 'conventions/doubtful', title: 'Doubtful', status: 'uncertain', claim: 'A doubted claim.' }), 'body');
    await store.write(scope, pageMeta({ id: 'conventions/queued', title: 'Queued', status: 'proposed', claim: 'A queued claim.' }), 'body');
    await store.write(scope, pageMeta({ id: 'conventions/old', title: 'Old', status: 'superseded', claim: 'An old claim.' }), 'body');

    const result = await svc.acceptAll(scope, { by: 'human' });
    expect(result.accepted).toBe(1);
    // `uncertain` is a recorded judgement about a claim, not an undecided one.
    expect((await store.read(scope, 'conventions/doubtful'))?.meta.status).toBe('uncertain');
    expect((await store.read(scope, 'conventions/old'))?.meta.status).toBe('superseded');
    expect((await store.read(scope, 'conventions/queued'))?.meta.status).toBe('current');
  });

  it('supersedes the pages a claim names as soon as it is ingested', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const store = new KnowledgeStore();
    const svc = new KnowledgeService({ log: () => undefined, settings: () => ({ knowledge: { prime: true, autoDistill: false } }) as AppSettings, store });
    await store.write(scope, pageMeta({ id: 'architecture/old', title: 'Old', status: 'current' }), 'old body');
    await svc.propose(scope, { title: 'New', claim: 'The layout is different now.', body: 'new body', supersedes: ['architecture/old'] }, 'human');
    const old = await store.read(scope, 'architecture/old');
    expect(old?.meta.status).toBe('superseded');
    expect(old?.meta.supersededBy).toBeDefined();
  });
});

describe('knowledge search and digest', () => {
  it('requires every query term and hides historical pages by default', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const store = new KnowledgeStore();
    await store.write(scope, pageMeta({ id: 'harness/lifecycle', title: 'Harness lifecycle', status: 'current' }), 'A harness process belongs to one session.');
    await store.write(scope, pageMeta({ id: 'harness/old', title: 'Old harness rules', status: 'superseded' }), 'A harness used to be shared.');
    const svc = new KnowledgeService({ log: () => undefined, settings: () => ({ knowledge: { prime: true, autoDistill: false } }) as AppSettings, store });
    const found = await svc.search(scope, 'harness session');
    expect(found.map((r) => r.id)).toEqual(['harness/lifecycle']);
    expect(await svc.search(scope, 'harness nonexistent')).toHaveLength(0);
    const historical = await svc.search(scope, 'harness', { includeHistorical: true });
    expect(historical.map((r) => r.id).sort()).toEqual(['harness/lifecycle', 'harness/old']);
    const digest = await svc.digest(scope);
    expect(digest).toContain('harness/lifecycle.md');
    expect(digest).not.toContain('harness/old.md');
  });

  it('publishes accepted pages into the tracked docs/wiki path', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const store = new KnowledgeStore();
    const svc = new KnowledgeService({ log: () => undefined, settings: () => ({ knowledge: { prime: true, autoDistill: false } }) as AppSettings, store });
    await store.write(scope, pageMeta(), 'body text');
    const result = await svc.publish(scope, ['conventions/harness-lifecycle']);
    expect(result.ok).toBe(true);
    expect(result.written).toEqual(['docs/wiki/conventions/harness-lifecycle.md']);
    const published = await fs.readFile(path.join(projectRoot, 'docs', 'wiki', 'conventions', 'harness-lifecycle.md'), 'utf8');
    expect(published).toContain('Harness lifecycle');
    expect(published).not.toContain('target_page:');
  });

  it('records and reads episodes for distillation', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const svc = service();
    // Episodes only exist for a project that already has a wiki.
    await svc.store.write(scope, pageMeta(), 'body text');
    await svc.recordEpisode(scope, { kind: 'commit', sessionId: 's1', at: new Date().toISOString(), summary: 'Add PTY guard' });
    const episodes = await svc.store.readEpisodes(scope);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].summary).toBe('Add PTY guard');
  });

  it('reads the newest episode first, not the oldest row of the day file', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const svc = service();
    await svc.store.write(scope, pageMeta(), 'body text');
    // Rows are appended oldest-first inside a day file; the reader must not hand `[0]` to callers.
    await svc.recordEpisode(scope, { kind: 'commit', sessionId: 's1', at: '2026-09-14T09:00:00.000Z', summary: 'Yesterday' });
    await svc.recordEpisode(scope, { kind: 'commit', sessionId: 's2', at: '2026-09-15T09:00:00.000Z', summary: 'This morning' });
    await svc.recordEpisode(scope, { kind: 'commit', sessionId: 's3', at: '2026-09-15T18:00:00.000Z', summary: 'This evening' });

    const episodes = await svc.store.readEpisodes(scope, 2);
    expect(episodes.map((e) => e.summary)).toEqual(['This evening', 'This morning']);
    expect(await svc.store.readEpisodes(scope)).toHaveLength(3);
  });

  it('attributes distillation to the newest episode, not the first row of the day', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const asked: string[] = [];
    const svc = new KnowledgeService({
      log: () => undefined,
      settings: () => ({ knowledge: { prime: true, autoDistill: false } }) as AppSettings,
      transcript: async (sessionId) => {
        asked.push(sessionId);
        return [`session ${sessionId}`];
      },
      synth: { completer: { label: () => 'test/model', complete: async () => JSON.stringify({ proposals: [] }) } }
    });
    await svc.store.write(scope, pageMeta(), 'body');
    await svc.recordEpisode(scope, { kind: 'commit', sessionId: 's_old', at: '2026-09-15T08:00:00.000Z', summary: 'Older work' });
    await svc.recordEpisode(scope, { kind: 'commit', sessionId: 's_new', at: '2026-09-15T17:00:00.000Z', summary: 'Newest work' });

    expect((await svc.generate(scope, 'distill')).ok).toBe(true);
    expect(asked).toContain('s_new');
    expect(asked).not.toContain('s_old');
  });

  it('starts an empty wiki for a project whose docs cannot bootstrap one', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const svc = service();
    expect((await svc.view(scope)).status.hasWiki).toBe(false);
    expect(await svc.store.hasWiki(scope)).toBe(false);

    const created = await svc.createWiki(scope);
    expect(created.status.hasWiki).toBe(true);
    expect(created.pages).toHaveLength(0);
    expect((await fs.stat(path.join(projectRoot, '.vocs-code', 'wiki'))).isDirectory()).toBe(true);
    // The directory is what turns the project's memory on for the tools and the panel.
    expect(await svc.store.hasWiki(scope)).toBe(true);
  });

  it('publishes into the session checkout rather than the main project', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const cwd = tmpDir('vocs-kb-wt-');
    const scope: KnowledgeScope = { projectRoot, cwd };
    const store = new KnowledgeStore();
    const svc = new KnowledgeService({ log: () => undefined, settings: () => ({ knowledge: { prime: true, autoDistill: false } }) as AppSettings, store });
    await store.write(scope, pageMeta(), 'body text');

    const result = await svc.publish(scope, ['conventions/harness-lifecycle']);
    expect(result.ok).toBe(true);
    expect(result.dir).toBe(path.join(cwd, 'docs', 'wiki'));
    expect(result.written).toEqual(['docs/wiki/conventions/harness-lifecycle.md']);
    expect(await fs.readFile(path.join(cwd, 'docs', 'wiki', 'conventions', 'harness-lifecycle.md'), 'utf8')).toContain('Harness lifecycle');
    // The main checkout is untouched: a worktree's work publishes with that worktree.
    await expect(fs.stat(path.join(projectRoot, 'docs'))).rejects.toThrow();
  });


  it('keeps the last job outcome on the view so a failure is not just a toast', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    await fs.writeFile(path.join(projectRoot, 'README.md'), `# Demo\n\n${'The main process owns state; the renderer keeps none. '.repeat(15)}\n`, 'utf8');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const svc = new KnowledgeService({
      log: () => undefined,
      settings: () => ({ knowledge: { prime: true, autoDistill: false } }) as AppSettings,
      synth: { completer: { label: () => 'test/model', complete: async () => 'no json at all' } }
    });
    const result = await svc.generate(scope, 'bootstrap');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no usable pages');
    const view = await svc.view(scope);
    expect(view.status.job?.state).toBe('failed');
    expect(view.status.job?.model).toBe('test/model');
    expect(view.status.job?.error).toContain('no usable pages');
  });

  it('auto-accepts a legacy draft on view and discards one on request', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const svc = service();
    await svc.store.write(scope, pageMeta({ id: 'gotcha/draft-one', title: 'Draft one', status: 'draft', claim: 'A draft claim.' }), 'body text');

    // Opening the panel promotes anything left in the old review queue; nothing waits for a human.
    const accepted = await svc.view(scope);
    expect(accepted.pages[0].status).toBe('current');
    expect(accepted.status.needsReview).toBe(0);

    await svc.store.write(scope, pageMeta({ id: 'gotcha/draft-two', title: 'Draft two', status: 'draft', claim: 'A throwaway claim.' }), 'body');
    await svc.review(scope, 'gotcha/draft-two', 'reject', { by: 'human' });
    expect(await svc.store.read(scope, 'gotcha/draft-two')).toBeNull();
    expect(await svc.store.rejectedClaims(scope)).toContain('A throwaway claim.');
  });

  it('resolves page anchors for the detail view, and says so when it cannot', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const store = new KnowledgeStore();
    const anchors = [{ file: 'src/main/session-manager.ts', symbol: 'buildContext' }];
    await store.write(scope, pageMeta({ anchors }), 'body');
    const withResolver = new KnowledgeService({
      log: () => undefined,
      settings: () => ({ knowledge: { prime: true, autoDistill: false } }) as AppSettings,
      store,
      anchors: { resolve: async (_scope, list) => list.map((a) => ({ ...a, status: 'resolved' as const, uid: 'Method:src/main/session-manager.ts:SessionManager.buildContext#2' })) }
    });
    const resolved = await withResolver.detail(scope, 'conventions/harness-lifecycle');
    expect(resolved?.anchors[0]).toMatchObject({ status: 'resolved', uid: 'Method:src/main/session-manager.ts:SessionManager.buildContext#2' });

    // No resolver wired (a run without GitNexus) must still render a page with anchors.
    const bare = await service().detail(scope, 'conventions/harness-lifecycle');
    expect(bare?.anchors[0]).toMatchObject({ status: 'unavailable', note: 'Anchor resolution is unavailable.' });
  });

  it('auto-accepts legacy drafts on view and leaves history alone', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const svc = service();
    await svc.store.write(scope, pageMeta({ id: 'conventions/settled', status: 'current', review: { state: 'reviewed' } }), 'body');
    await svc.store.write(scope, pageMeta({ id: 'conventions/draft', title: 'Draft', status: 'draft', claim: 'A draft claim.' }), 'body');
    await svc.store.write(scope, pageMeta({ id: 'conventions/old', title: 'Old', status: 'deprecated', claim: 'An old claim.' }), 'body');
    await svc.propose(scope, { title: 'Fresh claim', claim: 'A fresh claim.', body: 'Body.' }, 'agent:pi', 's1');

    const after = await svc.view(scope);
    expect(after.proposals).toHaveLength(0);
    expect(after.pages.find((p) => p.id === 'conventions/draft')?.status).toBe('current');
    expect(after.pages.find((p) => p.id === 'conventions/settled')?.status).toBe('current');
    expect(after.pages.find((p) => p.id === 'conventions/old')?.status).toBe('deprecated');
    expect(after.status.needsReview).toBe(0);
  });

  it('distils episodes through the service pipeline (propose must be wired)', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const svc = new KnowledgeService({
      log: () => undefined,
      settings: () => ({ knowledge: { prime: true, autoDistill: false } }) as AppSettings,
      transcript: async () => ['user: fix the double PTY'],
      synth: {
        completer: {
          label: () => 'test/model',
          complete: async () => JSON.stringify({ proposals: [{ title: 'PTY guard', claim: 'Guard reconnects in the main process.', body: 'Explain the guard.', kind: 'gotcha' }] })
        }
      }
    });
    await svc.store.write(scope, pageMeta(), 'body');
    await svc.recordEpisode(scope, { kind: 'merge', sessionId: 's9', at: new Date().toISOString(), summary: 'Merged the PTY fix' });

    const result = await svc.generate(scope, 'distill');
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('recorded 1');
    const after = await svc.view(scope);
    expect(after.proposals).toHaveLength(0);
    expect(after.pages.some((p) => p.id === 'gotcha/pty-guard' && p.status === 'current')).toBe(true);
  });
});
