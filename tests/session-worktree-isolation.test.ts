/**
 * Worktree isolation at session creation and forking. `git worktree add` only works inside a
 * repository, so a request that asks for isolation on a plain folder (a freshly created one, a
 * remembered default, a spawned agent's `use_worktree`) must lose the isolation, not the session:
 * creation used to fail with "Worktrees require a git repository." A fork of a worktree session
 * used to share its source's directory, so archiving the source with its worktree removed deleted
 * the folder the fork was running in; the fork owns a worktree and branch of its own instead.
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
