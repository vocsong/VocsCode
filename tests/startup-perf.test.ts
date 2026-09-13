/** Regression coverage for the startup spawn-storm fixes: memoized PATH scans, shared repo-root
 *  resolution, transcript-stamp PR-ref caching, staggered boot-time git checks, and the deferred
 *  boot availability probe. */
import { promises as fs } from 'node:fs';
import * as nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionManagerDeps } from '../src/main/session-manager';
import { SessionManager } from '../src/main/session-manager';
import { clearWhichCache, which } from '../src/main/runtime';
import type { AppSettings, SessionMeta, UsageTotals } from '../src/shared/types';
import { defaultSettings } from '../src/main/settings';

const { gitRoot, statSync, existsMock } = vi.hoisted(() => ({ gitRoot: vi.fn(), statSync: vi.fn(), existsMock: vi.fn() }));

// which() counts PATH-scan stats through node:fs statSync; util/fs exists() is stubable per test.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  if (!statSync.getMockName() || statSync.getMockName() === 'statSync') {
    statSync.mockImplementation((...a: Parameters<typeof actual.statSync>) => actual.statSync(...a));
  }
  return { ...actual, statSync };
});
vi.mock('../src/main/util/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/util/fs')>();
  existsMock.mockName('exists');
  return { ...actual, exists: existsMock };
});

/** Default: real filesystem behavior; tests stub from here. */
beforeEach(() => {
  existsMock.mockImplementation((p: string) => nodeFsPromisesAccess(p));
  // vi.restoreAllMocks() (afterEach) resets hoisted vi.fn()s too, so re-prime the statSync
  // passthrough that the node:fs mock factory installed for the which() tests.
  const actualStat = nodeFs.statSync;
  statSync.mockImplementation((...a: Parameters<typeof nodeFs.statSync>) => actualStat(...a));
});

async function nodeFsPromisesAccess(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

vi.mock('../src/main/git', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitRoot,
  // PR-state refresh stays offline; these tests count probes rather than parse gh output.
  branchGitState: vi.fn(async () => ({ pr: false, merged: false }))
}));

const usage: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

function meta(id: string, cwd: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    createdAt: 1_000,
    updatedAt: 2_000,
    config: { harness: 'native', projectRoot: cwd, permissionMode: 'auto' },
    cwd,
    status: 'idle',
    harnessRef: {},
    usage,
    ...extra
  };
}

function makeDeps(sessions: SessionMeta[], extra: Partial<SessionManagerDeps> = {}): SessionManagerDeps {
  return {
    store: { list: () => sessions } as unknown as SessionManagerDeps['store'],
    settings: { get: () => defaultSettings() } as unknown as SessionManagerDeps['settings'],
    runtime: {} as never,
    analytics: { touchSession: vi.fn(), recordToolCall: vi.fn(), recordUsage: vi.fn(), recordTurn: vi.fn() } as never,
    getSecret: async () => undefined,
    pushEvent: vi.fn(),
    pushSessions: vi.fn(),
    notify: vi.fn(),
    log: vi.fn(),
    ...extra
  };
}

let tmpRoot = '';
beforeEach(() => {
  tmpRoot = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'vocs-perf-'));
});
afterEach(() => {
  clearWhichCache();
  vi.restoreAllMocks();
  vi.useRealTimers();
  nodeFs.rmSync(tmpRoot, { recursive: true, force: true });
});
describe('which() PATH scan memoization', () => {
  beforeEach(() => {
    clearWhichCache();
    statSync.mockClear();
  });

  it('scans the PATH once per command and serves repeats from the memo', () => {
    expect(which('vocs-code-no-such-tool')).toBeNull();
    const firstScan = statSync.mock.calls.length;
    expect(firstScan).toBeGreaterThan(0);
    expect(which('vocs-code-no-such-tool')).toBeNull();
    expect(statSync.mock.calls.length).toBe(firstScan);
    // An installed binary must be discoverable again: the cache is dropped on install.
    clearWhichCache();
    expect(which('vocs-code-no-such-tool')).toBeNull();
    expect(statSync.mock.calls.length).toBeGreaterThan(firstScan);
  });

  it('caches hits and misses independently of extra search dirs', () => {
    statSync.mockClear();
    expect(which('vocs-code-no-such-tool')).toBeNull();
    // extraDirs change the key: the same command with extra dirs is scanned separately.
    expect(which('vocs-code-no-such-tool', [tmpRoot])).toBeNull();
    const afterSecondKey = statSync.mock.calls.length;
    expect(afterSecondKey).toBeGreaterThan(0);
    expect(which('vocs-code-no-such-tool', [tmpRoot])).toBeNull();
    expect(statSync.mock.calls.length).toBe(afterSecondKey);
  });
});

describe('knownRepoRoots concurrent resolution', () => {
  it('resolves each existing cwd once despite concurrent callers and answers stale paths without spawning git', async () => {
    const repoDir = path.join(tmpRoot, 'repo-a');
    nodeFs.mkdirSync(repoDir, { recursive: true });
    const staleWorktree = path.join(tmpRoot, 'deleted-worktree');
    const sessions = [
      meta('s_repo', repoDir),
      meta('s_stale', staleWorktree),
      meta('s_self', path.join(tmpRoot, 'self')),
      meta('s_archived', repoDir, { archived: true })
    ];
    gitRoot.mockResolvedValue(path.join(tmpRoot, 'repo-root'));
    const manager = new SessionManager(makeDeps(sessions));

    const [roots, rootsAgain] = await Promise.all([
      manager.knownRepoRoots('s_self'),
      manager.knownRepoRoots('s_self')
    ]);
    await manager.knownRepoRoots('s_self');

    // One git spawn for the one existing cwd; the deleted worktree never reaches git.
    expect(gitRoot).toHaveBeenCalledTimes(1);
    expect(gitRoot).toHaveBeenCalledWith(repoDir);
    expect(roots).toEqual([path.join(tmpRoot, 'repo-root')]);
    expect(rootsAgain).toEqual([path.join(tmpRoot, 'repo-root')]);
    expect(await manager.knownRepoRoots('s_self')).toEqual([path.join(tmpRoot, 'repo-root')]);
  });

  it('survives git failing for a cwd that exists', async () => {
    const repoDir = path.join(tmpRoot, 'repo-b');
    nodeFs.mkdirSync(repoDir, { recursive: true });
    gitRoot.mockRejectedValue(new Error('git exploded'));
    const manager = new SessionManager(makeDeps([meta('s_b', repoDir)]));
    await expect(manager.knownRepoRoots('s_other')).resolves.toEqual([]);
  });
});

describe('sessionPrRefs transcript caching', () => {
  function managerWithSessionDir(sessions: SessionMeta[], dir = tmpRoot): SessionManager {
    return new SessionManager(makeDeps(sessions, {
      store: { list: () => sessions, sessionDir: (id: string) => path.join(dir, id) } as never
    }));
  }

  it('reads the transcript once per file revision', async () => {
    const session = meta('s_pr_cache', tmpRoot);
    nodeFs.mkdirSync(path.join(tmpRoot, session.id), { recursive: true });
    const file = path.join(tmpRoot, session.id, 'transcript.jsonl');
    await fs.writeFile(file, JSON.stringify({ kind: 'turn', text: 'see https://github.com/vocsong/VocsCode/pull/12 for details' }) + '\n');

    const readSpy = vi.spyOn(fs, 'readFile');
    const manager = managerWithSessionDir([session]);
    expect(await manager.sessionPrRefs(session.id)).toEqual([{ repo: 'vocsong/VocsCode', number: 12 }]);
    expect(await manager.sessionPrRefs(session.id)).toEqual([{ repo: 'vocsong/VocsCode', number: 12 }]);
    expect(readSpy).toHaveBeenCalledTimes(1);

    // A changed transcript (size grows) is re-scanned.
    await fs.appendFile(file, JSON.stringify({ kind: 'turn', text: 'https://github.com/other/repo/pull/7' }) + '\n');
    expect(await manager.sessionPrRefs(session.id)).toEqual([
      { repo: 'vocsong/VocsCode', number: 12 },
      { repo: 'other/repo', number: 7 }
    ]);
    expect(readSpy).toHaveBeenCalledTimes(2);
  });

  it('answers missing transcripts and invalid session ids with no refs', async () => {
    const manager = managerWithSessionDir([meta('s_missing', tmpRoot)]);
    expect(await manager.sessionPrRefs('s_missing')).toEqual([]);
    expect(await manager.sessionPrRefs('not a session id')).toEqual([]);
  });
});

describe('boot-time git state checks are staggered', () => {
  it('spreads parked-pr/stopped checks instead of firing all at the same instant', async () => {
    vi.useFakeTimers();
    // Keep the whole check microtask-only under fake timers: no directory exists, the transcript
    // stat misses, and the branch probe is stubbed.
    existsMock.mockResolvedValue(false);
    const statSpy = vi.spyOn(fs, 'stat').mockRejectedValue(new Error('no transcript'));
    const sessions = [
      meta('s_parked_1', path.join(tmpRoot, 'one'), { status: 'stopped', worktreeBranch: 'harness/one' }),
      meta('s_parked_2', path.join(tmpRoot, 'two'), { status: 'stopped', worktreeBranch: 'harness/two' }),
      meta('s_parked_3', path.join(tmpRoot, 'three'), { status: 'stopped', worktreeBranch: 'harness/three' }),
      meta('s_idle', path.join(tmpRoot, 'four'), { status: 'idle' })
    ];
    const store = {
      list: () => sessions,
      get: (id: string) => sessions.find((s) => s.id === id),
      sessionDir: (id: string) => path.join(tmpRoot, id)
    } as never;
    const manager = new SessionManager(makeDeps(sessions, { store: store as never }));
    const gitMod = await import('../src/main/git');
    const probe = gitMod.branchGitState as unknown as ReturnType<typeof vi.fn>;
    probe.mockClear();

    manager.list();
    await vi.advanceTimersByTimeAsync(4_050);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(probe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(400);
    expect(probe).toHaveBeenCalledTimes(3);
    statSpy.mockRestore();
  });
});

describe('deferred boot availability probe', () => {
  it('does not probe harness availability until 2.5s after boot completes', async () => {
    vi.useFakeTimers();
    const previousWindow = (globalThis as { window?: unknown }).window;
    const settings = defaultSettings() as unknown as AppSettings;
    const invoke = vi.fn((channel: string) => {
      if (channel === 'settings:get') return Promise.resolve(settings);
      if (channel === 'sessions:list') return Promise.resolve([meta('s_first', tmpRoot)]);
      if (channel === 'terminal:list') return Promise.resolve([]);
      if (channel === 'sessions:transcript') return Promise.resolve([]);
      if (channel === 'harness:availability') return Promise.resolve({});
      return Promise.resolve(undefined);
    });
    (globalThis as { window?: unknown }).window = { harness: { invoke, on: vi.fn().mockReturnValue(() => undefined) } };
    const { useStore } = await import('../src/renderer/src/store');
    useStore.setState({ booted: false, settings: null, bootError: null });

    try {
      await useStore.getState().boot();
      expect(useStore.getState().booted).toBe(true);
      expect(invoke.mock.calls.filter(([c]) => c === 'harness:availability')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(invoke.mock.calls.filter(([c]) => c === 'harness:availability')).toHaveLength(1);
    } finally {
      if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = previousWindow;
    }
  });
});