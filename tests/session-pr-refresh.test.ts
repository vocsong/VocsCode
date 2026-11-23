import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { branchGitState, type BranchGitState } from '../src/main/git';
import { SessionManager } from '../src/main/session-manager';
import { defaultSettings } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import { deferred } from '../src/main/util/async';
import type { SessionEvent, SessionStatus } from '../src/shared/types';

vi.mock('../src/main/git', async (original) => ({
  ...await original<typeof import('../src/main/git')>(),
  branchGitState: vi.fn()
}));

const probe = vi.mocked(branchGitState);
const open = { pr: true, merged: false };
const merged = { pr: false, merged: true };
const id = 's_pr';
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-pr-refresh-'));
  probe.mockReset();
});
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  const store = new SessionStore(root);
  await store.load();
  const meta = {
    id, title: 'Ship the widget', createdAt: 1_000, updatedAt: 2_000,
    config: { harness: 'native' as const, projectRoot: root, permissionMode: 'ask' as const },
    cwd: root, worktreeBranch: 'pi/widget', status: 'pr' as SessionStatus, harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
  };
  await store.upsert(meta);
  const published: SessionStatus[] = [];
  const manager = new SessionManager({
    store, settings: { get: () => defaultSettings() } as never, runtime: {} as never,
    analytics: {} as never, getSecret: async () => undefined, pushEvent: vi.fn(),
    pushSessions: (sessions) => { if (sessions[0]) published.push(sessions[0].status); }, notify: vi.fn(), log: vi.fn()
  });
  vi.spyOn(manager, 'sessionPrRefs').mockResolvedValue([]);
  vi.useFakeTimers();
  return { manager, store, published, meta };
}

describe('sidebar PR refresh fencing', () => {
  it.each(['unavailable', 'rejected'] as const)('keeps the PR after an %s lookup and polls again', async (kind) => {
    const { manager, store, published } = await setup();
    if (kind === 'rejected') probe.mockRejectedValueOnce(new Error('offline'));
    else probe.mockResolvedValueOnce({ pr: false, merged: false, unknown: true });
    probe.mockResolvedValueOnce(open).mockResolvedValue(merged);

    manager.list();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(store.get(id)?.status).toBe('pr');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(store.get(id)?.status).toBe('pr');
    expect(published).toEqual([]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(published).toEqual(['merged']);
    await manager.flushPendingPersists();
    const restored = new SessionStore(root);
    await restored.load();
    expect(restored.get(id)?.status).toBe('merged');
  });

  it('discards an old merge as soon as a newer refresh is scheduled', async () => {
    const { manager, store, published } = await setup();
    const old = deferred<BranchGitState>();
    probe.mockReturnValueOnce(old.promise).mockResolvedValueOnce(open).mockResolvedValue(merged);
    manager.refreshGitState(id);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe).toHaveBeenCalledTimes(1);
    manager.refreshGitState(id);
    old.resolve(merged);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get(id)?.status).toBe('pr');
    expect(published).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(published).toEqual(['merged']);
    await manager.flushPendingPersists();
  });

  it.each(['cwd', 'worktreeBranch', 'removed'] as const)('discards the result when the session identity has changed: %s', async (change) => {
    const { manager, store, published, meta } = await setup();
    const old = deferred<BranchGitState>();
    probe.mockReturnValueOnce(old.promise);
    manager.refreshGitState(id);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe).toHaveBeenCalledTimes(1);
    if (change === 'removed') await store.remove(id);
    else meta[change] = change === 'cwd' ? path.join(root, 'other') : 'pi/other';
    old.resolve(merged);
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toEqual([]);
    expect(store.get(id)?.status).toBe(change === 'removed' ? undefined : 'pr');
  });

  it('ignores an old result after a turn stops without an idle event', async () => {
    const { manager, store, published } = await setup();
    const old = deferred<BranchGitState>();
    probe.mockReturnValueOnce(old.promise).mockResolvedValue(open);
    manager.refreshGitState(id);
    await vi.advanceTimersByTimeAsync(1_000);
    const runtime = manager as unknown as { emit: (id: string, event: SessionEvent) => void };
    runtime.emit(id, { type: 'status', status: 'running' });
    runtime.emit(id, { type: 'status', status: 'stopped' });
    old.resolve(merged);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get(id)?.status).toBe('stopped');
    expect(published).toEqual(['running', 'stopped']);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(published).toEqual(['running', 'stopped', 'pr']);
    await manager.flushPendingPersists();
  });
});
