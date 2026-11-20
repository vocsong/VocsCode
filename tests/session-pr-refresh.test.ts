/** Sidebar git labels through the real manager/store: polling must outlive unchanged results and outages. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { branchGitState, type BranchGitState } from '../src/main/git';
import { SessionManager } from '../src/main/session-manager';
import { defaultSettings } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import type { SessionEvent, SessionStatus } from '../src/shared/types';

vi.mock('../src/main/git', async (original) => ({
  ...await original<Record<string, unknown>>(),
  branchGitState: vi.fn()
}));

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-pr-refresh-'));
  vi.mocked(branchGitState).mockReset();
});
afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  await fs.rm(root, { recursive: true, force: true });
});

async function setup(status: SessionStatus = 'pr') {
  const store = new SessionStore(root);
  await store.load();
  await store.upsert({
    id: 's_pr', title: 'Ship the widget', createdAt: 1_000, updatedAt: 2_000,
    config: { harness: 'native', projectRoot: root, permissionMode: 'auto' },
    cwd: root, worktreeBranch: 'pi/widget', status, harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
  });
  const published: SessionStatus[] = [];
  const manager = new SessionManager({
    store, settings: { get: () => defaultSettings() } as never, runtime: {} as never,
    analytics: {} as never, getSecret: async () => undefined, pushEvent: vi.fn(),
    pushSessions: (sessions) => published.push(sessions[0].status), notify: vi.fn(), log: vi.fn()
  });
  // The network boundary is scripted; transcript parsing is independently covered.
  vi.spyOn(manager, 'sessionPrRefs').mockResolvedValue([]);
  vi.useFakeTimers();
  return { manager, store, published };
}

const open: BranchGitState = { pr: true, merged: false };
const merged: BranchGitState = { pr: false, merged: true };

describe('reliable sidebar PR refresh', () => {
  it('keeps polling an unchanged restored PR, publishes its merge exactly once and persists it across restart', async () => {
    const { manager, store, published } = await setup();
    vi.mocked(branchGitState).mockResolvedValueOnce(open).mockResolvedValueOnce(open).mockResolvedValue(merged);
    manager.list();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(branchGitState).toHaveBeenCalledTimes(1);
    expect(store.get('s_pr')?.status).toBe('pr');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(branchGitState).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(branchGitState).toHaveBeenCalledTimes(3);
    expect(store.get('s_pr')?.status).toBe('merged');
    expect(published).toEqual(['merged']);
    await manager.flushPendingPersists();
    const restarted = new SessionStore(root);
    await restarted.load();
    expect(restarted.get('s_pr')?.status).toBe('merged');
    await vi.advanceTimersByTimeAsync(240_000);
    expect(branchGitState).toHaveBeenCalledTimes(3); // terminal state stops polling
  });

  it.each(['rejection', 'unknown'] as const)('preserves PR and recovers after a %s lookup', async (failure) => {
    const { manager, store, published } = await setup();
    const probe = vi.mocked(branchGitState);
    if (failure === 'rejection') probe.mockRejectedValueOnce(new Error('offline'));
    else probe.mockResolvedValueOnce({ pr: false, merged: false, unknown: true });
    probe.mockResolvedValue(merged);
    manager.list();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(store.get('s_pr')?.status).toBe('pr');
    expect(published).toEqual([]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(store.get('s_pr')?.status).toBe('merged');
    expect(published).toEqual(['merged']);
    await manager.flushPendingPersists();
  });

  it('retries an unavailable post-turn lookup, but bounds retries for sessions without a known PR', async () => {
    const { manager, store } = await setup('idle');
    vi.mocked(branchGitState).mockResolvedValue({ pr: false, merged: false, unknown: true });
    manager.refreshGitState('s_pr');
    await vi.advanceTimersByTimeAsync(1_000 + 4 * 120_000);
    expect(branchGitState).toHaveBeenCalledTimes(3);
    expect(store.get('s_pr')?.status).toBe('idle');
  });

  it('ignores an older lookup that finishes after a newer refresh has confirmed the PR', async () => {
    const { manager, store, published } = await setup();
    let resolveOld!: (state: BranchGitState) => void;
    vi.mocked(branchGitState).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue(open);
    manager.refreshGitState('s_pr');
    await vi.advanceTimersByTimeAsync(1_000);
    manager.refreshGitState('s_pr');
    await vi.advanceTimersByTimeAsync(1_000);
    resolveOld({ pr: false, merged: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(branchGitState).toHaveBeenCalledTimes(2);
    expect(store.get('s_pr')?.status).toBe('pr');
    expect(published).toEqual([]);
  });

  it('does not publish a network result after the session was deleted', async () => {
    const { manager, store, published } = await setup();
    let finish!: (state: BranchGitState) => void;
    vi.mocked(branchGitState).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    manager.refreshGitState('s_pr');
    await vi.advanceTimersByTimeAsync(1_000);
    await store.remove('s_pr');
    finish(merged);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(store.list()).toEqual([]);
    expect(published).toEqual([]);
    expect(branchGitState).toHaveBeenCalledTimes(1);
  });

  it('fences an old lookup across a turn that stops without idle, then refreshes the stopped turn', async () => {
    const { manager, store, published } = await setup();
    let finishOld!: (state: BranchGitState) => void;
    vi.mocked(branchGitState).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; })).mockResolvedValue(open);
    manager.refreshGitState('s_pr');
    await vi.advanceTimersByTimeAsync(1_000);
    const emit = (manager as unknown as { emit: (id: string, event: SessionEvent) => void }).emit.bind(manager);
    emit('s_pr', { type: 'status', status: 'running' });
    emit('s_pr', { type: 'status', status: 'stopped' });
    finishOld(merged);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get('s_pr')?.status).toBe('stopped');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(branchGitState).toHaveBeenCalledTimes(2);
    expect(store.get('s_pr')?.status).toBe('pr');
    expect(published).toEqual(['running', 'stopped', 'pr']);
    await manager.flushPendingPersists();
  });

  it('does not overwrite a running turn with a delayed merge result', async () => {
    const { manager, store, published } = await setup();
    let finish!: (state: BranchGitState) => void;
    vi.mocked(branchGitState).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    manager.refreshGitState('s_pr');
    await vi.advanceTimersByTimeAsync(1_000);
    store.get('s_pr')!.status = 'running';
    finish(merged);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(store.get('s_pr')?.status).toBe('running');
    expect(published).toEqual([]);
    expect(branchGitState).toHaveBeenCalledTimes(1);
  });
});
