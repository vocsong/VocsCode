/**
 * Worktree isolation at session creation and forking. `git worktree add` only works inside a
 * repository, so a request that asks for isolation on a plain folder (a freshly created one, a
 * remembered default, a spawned agent's `use_worktree`) must lose the isolation, not the session:
 * creation used to fail with "Worktrees require a git repository." A fork of a worktree session
 * used to share its source's directory, so archiving the source with its worktree removed deleted
 * the folder the fork was running in; the fork owns a worktree and branch of its own instead.
 * The branch is `vocscode/<slug>` unless the session asks for another prefix (`feat/`, `fix/`, a
 * team's own), which repositories with branch-naming rules require; forks keep that prefix.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import { defaultSettings } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import type { SessionManagerDeps } from '../src/main/session-manager';
import { SessionManager } from '../src/main/session-manager';

vi.mock('../src/main/harness/registry', () => ({
  createAdapter: (id: string, ctx: HarnessContext) =>
    ({
      id,
      get busy() {
        return false;
      },
      start: async () => undefined,
      send: async () => undefined,
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setEffort: async () => undefined,
      setPermissionMode: async () => undefined,
      dispose: async () => undefined,
      _ctx: ctx
    }) as unknown as HarnessAdapter
}));

let tmpRoot = '';
let counter = 0;
beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-worktree-'));
});
afterAll(async () => {
  // Worktrees keep read-only files under .git; force the removal so a failed run cannot wedge the next.
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

const logs: string[] = [];

async function makeManager(): Promise<SessionManager> {
  const store = new SessionStore(path.join(tmpRoot, `store${++counter}`));
  await store.load();
  const settings = { ...defaultSettings(), providers: [] };
  const deps: SessionManagerDeps = {
    store,
    settings: { get: () => settings, update: vi.fn(async () => settings) } as never,
    runtime: {} as never,
    analytics: { touchSession: vi.fn(), recordToolCall: vi.fn(), recordUsage: vi.fn(), recordTurn: vi.fn(), recordUserMessage: vi.fn() } as never,
    getSecret: async () => undefined,
    pushEvent: vi.fn(),
    pushSessions: vi.fn(),
    notify: vi.fn(),
    log: (_level, msg) => void logs.push(msg)
  };
  return new SessionManager(deps);
}

/** Runs git in `cwd` and fails the test on a non-zero exit. */
async function runGit(cwd: string, args: string[]): Promise<void> {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

/** A folder with a repository and one commit — what isolation actually needs. */
async function repoFolder(): Promise<string> {
  const dir = path.join(tmpRoot, `repo${++counter}`);
  await fs.mkdir(dir, { recursive: true });
  await runGit(dir, ['init', '--initial-branch=main', '.']);
  await runGit(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init']);
  return dir;
}

/** A folder deleted outside the app is what the archive/fork tests assert about. */
const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false);

describe('worktree isolation at session creation', () => {
  it('drops isolation for a folder that is not a git repository', async () => {
    const projectRoot = path.join(tmpRoot, `plain${++counter}`);
    await fs.mkdir(projectRoot, { recursive: true });
    logs.length = 0;
    const manager = await makeManager();

    const meta = await manager.create({ config: { harness: 'native', projectRoot, permissionMode: 'ask', useWorktree: true } } as never);

    expect(meta.cwd).toBe(projectRoot);
    expect(meta.worktreeBranch).toBeUndefined();
    // The session must not claim an isolation it does not have; the Changes panel reads this.
    expect(meta.config.useWorktree).toBe(false);
    expect(logs.some((l) => l.includes('worktree isolation skipped'))).toBe(true);
    // Nothing was written into the folder.
    expect(await fs.readdir(projectRoot)).toEqual([]);
  });

  it('still isolates a folder that is a git repository', async () => {
    const projectRoot = await repoFolder();
    const manager = await makeManager();

    const meta = await manager.create({ config: { harness: 'native', projectRoot, permissionMode: 'ask', useWorktree: true }, title: 'isolate me' } as never);

    expect(meta.worktreeBranch).toBe('vocscode/isolate-me');
    expect(meta.cwd).toBe(path.join(projectRoot, '.vocs-code', 'worktrees', 'isolate-me'));
    expect(meta.config.useWorktree).toBe(true);
  });

  it('starts the worktree on a branch under the requested prefix', async () => {
    const projectRoot = await repoFolder();
    const manager = await makeManager();

    // A trailing slash, as a user types it, is the same prefix.
    const meta = await manager.create({ config: { harness: 'native', projectRoot, permissionMode: 'ask', useWorktree: true, branchPrefix: 'team/feat/' }, title: 'prefixed work' } as never);

    expect(meta.worktreeBranch).toBe('team/feat/prefixed-work');
    expect(meta.cwd).toBe(path.join(projectRoot, '.vocs-code', 'worktrees', 'prefixed-work'));
    expect(meta.config.branchPrefix).toBe('team/feat');
    // The branch git actually checked out in the worktree, not only what the session recorded.
    const { spawnSync } = await import('node:child_process');
    expect(spawnSync('git', ['branch', '--show-current'], { cwd: meta.cwd, encoding: 'utf8' }).stdout.trim()).toBe('team/feat/prefixed-work');
    expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/vocscode/prefixed-work'], { cwd: projectRoot }).status).not.toBe(0);
  });

  it('names the branch as asked and starts it from the chosen base branch', async () => {
    const projectRoot = await repoFolder();
    await runGit(projectRoot, ['checkout', '-qb', 'develop']);
    await fs.writeFile(path.join(projectRoot, 'develop.txt'), 'from develop\n');
    await runGit(projectRoot, ['add', 'develop.txt']);
    await runGit(projectRoot, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'develop work']);
    // The main checkout is back on main, so only an explicit base reaches develop's commit.
    await runGit(projectRoot, ['checkout', '-q', 'main']);
    const manager = await makeManager();

    const meta = await manager.create({ config: { harness: 'native', projectRoot, permissionMode: 'ask', useWorktree: true, branchPrefix: 'feat' }, title: 'ignored title', worktreeName: 'Fix Login Redirect', worktreeBase: 'develop' } as never);

    expect(meta.worktreeBranch).toBe('feat/fix-login-redirect');
    expect(meta.cwd).toBe(path.join(projectRoot, '.vocs-code', 'worktrees', 'fix-login-redirect'));
    expect((await fs.readFile(path.join(meta.cwd, 'develop.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('from develop\n');
  });

  it('refuses a base branch that would reach git as an option', async () => {
    const projectRoot = await repoFolder();
    const manager = await makeManager();

    await expect(manager.create({ config: { harness: 'native', projectRoot, permissionMode: 'ask', useWorktree: true }, title: 'opt', worktreeBase: '--orphan' } as never)).rejects.toThrow('Invalid base branch');

    expect(manager.list()).toHaveLength(0);
    expect(await exists(path.join(projectRoot, '.vocs-code', 'worktrees', 'opt'))).toBe(false);
  });

  it('refuses a prefix git cannot take, creating no session, worktree or branch', async () => {
    const projectRoot = await repoFolder();
    const manager = await makeManager();

    await expect(manager.create({ config: { harness: 'native', projectRoot, permissionMode: 'ask', useWorktree: true, branchPrefix: 'bad..prefix' }, title: 'nope' } as never)).rejects.toThrow('Invalid branch prefix');

    expect(manager.list()).toHaveLength(0);
    expect(await exists(path.join(projectRoot, '.vocs-code', 'worktrees', 'nope'))).toBe(false);
    const { spawnSync } = await import('node:child_process');
    expect(spawnSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: projectRoot, encoding: 'utf8' }).stdout.trim()).toBe('main');
  });
});

describe('forking a worktree session', () => {
  it('gives the fork its own worktree, so archiving the source with its worktree leaves the fork intact', async () => {
    const projectRoot = await repoFolder();
    const manager = await makeManager();
    const src = await manager.create({ config: { harness: 'native', projectRoot, permissionMode: 'ask', useWorktree: true }, title: 'fork source' } as never);
    expect(src.worktreeBranch).toBe('vocscode/fork-source');
    // Committed work in the source is the fork's starting point.
    await fs.writeFile(path.join(src.cwd, 'work.txt'), 'carried\n');
    await runGit(src.cwd, ['add', 'work.txt']);
    await runGit(src.cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'work']);

    const fork = (await manager.fork(src.id))!;

    // Its own checkout on its own branch, branched from the source's committed HEAD.
    expect(fork.cwd).not.toBe(src.cwd);
    expect(fork.cwd.startsWith(path.join(projectRoot, '.vocs-code', 'worktrees') + path.sep)).toBe(true);
    expect(fork.worktreeBranch).toBe('vocscode/fork-source-fork');
    expect(fork.forkedFrom).toBe(src.id);
    expect((await fs.readFile(path.join(fork.cwd, 'work.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('carried\n');

    // Archive the source with its worktree removed: the fork keeps running in its own.
    await manager.setArchived(src.id, true, true);
    expect(await exists(src.cwd)).toBe(false);
    expect(await exists(fork.cwd)).toBe(true);
    expect(manager.get(fork.id)!.cwd).toBe(fork.cwd);
    expect(manager.get(fork.id)!.worktreeBranch).toBe('vocscode/fork-source-fork');
  });

  it('gives the fork a branch under its source session\'s prefix', async () => {
    const projectRoot = await repoFolder();
    const manager = await makeManager();
    const src = await manager.create({ config: { harness: 'native', projectRoot, permissionMode: 'ask', useWorktree: true, branchPrefix: 'fix' }, title: 'bug source' } as never);
    expect(src.worktreeBranch).toBe('fix/bug-source');

    const fork = (await manager.fork(src.id))!;

    expect(fork.worktreeBranch).toBe('fix/bug-source-fork');
    const { spawnSync } = await import('node:child_process');
    expect(spawnSync('git', ['branch', '--show-current'], { cwd: fork.cwd, encoding: 'utf8' }).stdout.trim()).toBe('fix/bug-source-fork');
  });

  it('starts from the kept branch when the source worktree is already gone', async () => {
    const projectRoot = await repoFolder();
    const manager = await makeManager();
    const src = await manager.create({ config: { harness: 'native', projectRoot, permissionMode: 'ask', useWorktree: true }, title: 'gone source' } as never);
    await fs.writeFile(path.join(src.cwd, 'kept.txt'), 'kept\n');
    await runGit(src.cwd, ['add', 'kept.txt']);
    await runGit(src.cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'kept']);
    // Archiving removes the folder and keeps the branch — the state a fork may still be asked from.
    await manager.setArchived(src.id, true, true);
    expect(await exists(src.cwd)).toBe(false);

    const fork = (await manager.fork(src.id))!;

    expect(await exists(fork.cwd)).toBe(true);
    expect((await fs.readFile(path.join(fork.cwd, 'kept.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('kept\n');
  });
});
