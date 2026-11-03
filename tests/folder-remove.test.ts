// Removing a folder deletes its whole session list as one operation. The batch must publish the
// sidebar exactly once: a push per deleted session walks the selection through the doomed rows,
// toasting each hop, before it lands anywhere the folder still exists.
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import { SessionManager } from '../src/main/session-manager';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import type { SessionStore } from '../src/main/store';
import type { SessionMeta } from '../src/shared/types';

vi.mock('../src/main/harness/registry', () => ({
  createAdapter: () => ({
    id: 'native',
    busy: false,
    start: async () => undefined,
    send: async () => undefined,
    interrupt: async () => undefined,
    setModel: async () => undefined,
    setEffort: async () => undefined,
    setPermissionMode: async () => undefined,
    dispose: async () => undefined
  })
}));

const removedWorktrees: string[] = [];
vi.mock('../src/main/git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/git')>()),
  removeWorktree: async (_root: string, cwd: string) => void removedWorktrees.push(cwd)
}));

function session(id: string, projectRoot: string, patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    cwd: projectRoot,
    config: { harness: 'native', projectRoot, permissionMode: 'ask' },
    harnessRef: {},
    status: 'idle',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    ...patch
  };
}

function setup(list: SessionMeta[]) {
  removedWorktrees.length = 0;
  const removed: string[] = [];
  const store = {
    list: () => list,
    get: (id: string) => list.find((s) => s.id === id),
    upsert: vi.fn(async () => undefined),
    appendTranscript: vi.fn(async () => undefined),
    readTranscript: vi.fn(async () => []),
    remove: vi.fn(async (id: string) => {
      removed.push(id);
      list.splice(
        list.findIndex((s) => s.id === id),
        1
      );
    }),
    sessionDir: (id: string) => path.join('G:/tmp', id)
  } as unknown as SessionStore;
  const pushSessions = vi.fn();
  const manager = new SessionManager({
    store,
    settings: { get: () => defaultSettings() } as unknown as SettingsStore,
    runtime: undefined as unknown as RuntimeResolver,
    analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn() } as unknown as AnalyticsStore,
    getSecret: async () => undefined,
    pushEvent: vi.fn(),
    pushSessions,
    notify: vi.fn(),
    log: vi.fn()
  });
  return { manager, pushSessions, removed };
}

describe('deleting a folder’s sessions as one batch', () => {
  it('deletes every id and publishes the sidebar once', async () => {
    const list = [session('s_a', 'G:/proj/a'), session('s_b', 'G:/proj/a'), session('s_c', 'G:/proj/b')];
    const { manager, pushSessions, removed } = setup(list);

    const count = await manager.deleteMany(['s_a', 's_b']);

    expect(count).toBe(2);
    expect(removed).toEqual(['s_a', 's_b']);
    expect(list.map((s) => s.id)).toEqual(['s_c']);
    expect(pushSessions).toHaveBeenCalledTimes(1);
  });

  it('removes the worktree of every session that has one, and pushes nothing when the ids are gone', async () => {
    const list = [session('s_wt', 'G:/proj/a', { cwd: 'G:/proj/a/.worktrees/wt', worktreeBranch: 'agent/wt' }), session('s_plain', 'G:/proj/a')];
    const { manager, pushSessions } = setup(list);

    await manager.deleteMany(['s_wt', 's_plain']);
    expect(removedWorktrees).toEqual(['G:/proj/a/.worktrees/wt']);

    pushSessions.mockClear();
    expect(await manager.deleteMany(['s_wt', 'nope'])).toBe(0);
    expect(pushSessions).not.toHaveBeenCalled();
  });
});
