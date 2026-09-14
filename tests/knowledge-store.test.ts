/** Layer 2 store + service: scoping, proposals, the repeated-evidence rule, search and publish. */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { KnowledgeStore } from '../src/main/knowledge/store';
import { KnowledgeService } from '../src/main/knowledge/service';
import type { AppSettings } from '../src/shared/types';
import type { KnowledgePageMeta, KnowledgeScope } from '../src/shared/knowledge';

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
    await svc.review(branchScope, filed.id, 'accept', { by: 'human' });

    // The page belongs to the project: a session in the main checkout can read it.
    const fromRoot = await svc.detail(repoScope, 'gotcha/pty-ownership');
    expect(fromRoot?.page.meta.scope).toBe('repo');
    expect(await fs.readFile(path.join(projectRoot, '.vocs-code', 'wiki', 'gotcha', 'pty-ownership.md'), 'utf8')).toContain('Only the main process owns a PTY.');
    await expect(fs.stat(path.join(cwd, '.vocs-code'))).rejects.toThrow();
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

describe('knowledge service proposals', () => {
  it('files a proposal, accepts it into a current page, and records the review', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const svc = service();
    const filed = await svc.propose(scope, { title: 'PTY ownership', claim: 'Renderer reconnects can double PTYs.', body: '## Why\n\nThe main process owns PTY lifetime.', kind: 'gotcha' }, 'agent:pi', 's1');
    expect(filed.promoted).toBe(false);
    expect(filed.rejected).toBe(false);

    const view = await svc.view(scope);
    expect(view.proposals).toHaveLength(1);
    expect(view.proposals[0].kind).toBe('gotcha');
    expect(view.status.proposals).toBe(1);

    await svc.review(scope, view.proposals[0].id, 'accept', { by: 'human' });
    const after = await svc.view(scope);
    expect(after.proposals).toHaveLength(0);
    expect(after.pages).toHaveLength(1);
    expect(after.pages[0].status).toBe('current');

    const detail = await svc.detail(scope, after.pages[0].id);
    expect(detail?.page.body).toContain('main process owns PTY lifetime');
  });

  it('promotes a claim seen in two independent sessions to a proposed page, never current', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const svc = service();
    const first = await svc.propose(scope, { title: 'Reconnect safety', claim: 'Reconnects must happen in the main process.', body: 'Body text long enough to be a real page body.' }, 'agent:pi', 's1');
    expect(first.promoted).toBe(false);
    const second = await svc.propose(scope, { title: 'Reconnect safety', claim: 'Reconnects must happen in the main process.', body: 'Body text long enough to be a real page body.' }, 'agent:codex', 's2');
    expect(second.evidenceCount).toBe(2);
    expect(second.promoted).toBe(true);

    const view = await svc.view(scope);
    expect(view.proposals).toHaveLength(0);
    expect(view.pages).toHaveLength(1);
    expect(view.pages[0].status).toBe('proposed');
    expect(view.status.needsReview).toBe(1);
  });

  it('remembers a rejected claim and refuses to refile it', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const svc = service();
    const filed = await svc.propose(scope, { title: 'Bad idea', claim: 'We should cache transcripts in the repo.', body: 'Body.' }, 'agent:pi', 's1');
    await svc.review(scope, filed.id, 'reject', { by: 'human' });
    const again = await svc.propose(scope, { title: 'Bad idea again', claim: 'We should cache transcripts in the repo.', body: 'Body.' }, 'agent:pi', 's2');
    expect(again.rejected).toBe(true);
    const view = await svc.view(scope);
    expect(view.proposals).toHaveLength(0);
    expect(view.rejectedClaims).toContain('We should cache transcripts in the repo.');
  });

  it('supersedes the pages a proposal names', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const store = new KnowledgeStore();
    const svc = new KnowledgeService({ log: () => undefined, settings: () => ({ knowledge: { prime: true, autoDistill: false } }) as AppSettings, store });
    await store.write(scope, pageMeta({ id: 'architecture/old', title: 'Old', status: 'current' }), 'old body');
    const filed = await svc.propose(scope, { title: 'New', claim: 'The layout is different now.', body: 'new body', supersedes: ['architecture/old'] }, 'human');
    await svc.review(scope, filed.id, 'accept', { by: 'human' });
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

  it('accepts a generated draft in place and discards one on request', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const svc = service();
    await svc.store.write(scope, pageMeta({ id: 'gotcha/draft-one', title: 'Draft one', status: 'draft', claim: 'A draft claim.' }), 'body text');
    expect((await svc.view(scope)).status.needsReview).toBe(1);

    await svc.review(scope, 'gotcha/draft-one', 'accept', { by: 'human' });
    const accepted = await svc.view(scope);
    expect(accepted.pages[0].status).toBe('current');
    expect(accepted.status.needsReview).toBe(0);

    await svc.store.write(scope, pageMeta({ id: 'gotcha/draft-two', title: 'Draft two', status: 'draft', claim: 'A throwaway claim.' }), 'body');
    await svc.review(scope, 'gotcha/draft-two', 'reject', { by: 'human' });
    expect(await svc.store.read(scope, 'gotcha/draft-two')).toBeNull();
    expect(await svc.store.rejectedClaims(scope)).toContain('A throwaway claim.');
  });

  it('accepts every pending item at once and leaves history alone', async () => {
    const projectRoot = tmpDir('vocs-kb-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const svc = service();
    await svc.store.write(scope, pageMeta({ id: 'conventions/settled', status: 'current', review: { state: 'reviewed' } }), 'body');
    await svc.store.write(scope, pageMeta({ id: 'conventions/draft', title: 'Draft', status: 'draft', claim: 'A draft claim.' }), 'body');
    await svc.store.write(scope, pageMeta({ id: 'conventions/old', title: 'Old', status: 'deprecated', claim: 'An old claim.' }), 'body');
    const filed = await svc.propose(scope, { title: 'Pending proposal', claim: 'A proposed claim.', body: 'Body.' }, 'agent:pi', 's1');
    expect(filed.promoted).toBe(false);

    const result = await svc.acceptAll(scope, { by: 'human' });
    expect(result.accepted).toBe(2);
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
    expect(result.detail).toContain('proposed 1');
    expect((await svc.view(scope)).proposals).toHaveLength(1);
  });
});
