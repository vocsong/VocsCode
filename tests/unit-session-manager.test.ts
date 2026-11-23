import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AnalyticsStore } from '../src/main/analytics';
import { branchGitState, createForkWorktree } from '../src/main/git';
import type { RuntimeResolver } from '../src/main/runtime';
import { SessionManager } from '../src/main/session-manager';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import { deferred } from '../src/main/util/async';
import type { AppSettings, SessionEvent, SessionMeta, TranscriptItem } from '../src/shared/types';

// branchGitState is stubbed so PR-state refresh tests stay offline, and createForkWorktree keeps the
// fake project roots (no repository) from shelling out: these forks share the source's directory.
// The real worktree a fork gets is exercised against a real repo in session-worktree-isolation.test.ts.
vi.mock('../src/main/git', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  branchGitState: vi.fn(async (): Promise<{ pr: boolean; merged: boolean }> => ({ pr: false, merged: false })),
  createForkWorktree: vi.fn(async () => null)
}));

describe('SessionManager folder tracking', () => {
  it('registers a project folder on create so it survives its last session being archived or deleted', async () => {
    const stored = defaultSettings();
    const settings = {
      get: () => stored,
      update: async (patch: Partial<AppSettings>) => {
        Object.assign(stored, patch);
      }
    } as unknown as SettingsStore;
    const store = { list: () => [], get: () => undefined, upsert: async () => undefined } as unknown as SessionStore;
    const manager = new SessionManager({
      store,
      settings,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn() } as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: vi.fn(),
      notify: vi.fn(),
      log: vi.fn()
    });
    const cfg = { harness: 'native', projectRoot: 'G:/proj/a', permissionMode: 'ask' } as const;
    await manager.create({ config: { ...cfg } });
    expect(stored.folders).toEqual(['G:/proj/a']);
    // Creating another session in the same folder must not duplicate the entry.
    await manager.create({ config: { ...cfg } });
    expect(stored.folders).toEqual(['G:/proj/a']);
  });

  it('refreshes the analytics snapshot when a harness discovers or switches its active model', async () => {
    const session: SessionMeta = {
      id: 'model-discovery',
      title: 'model discovery',
      createdAt: 1,
      updatedAt: 1,
      config: { harness: 'pi', projectRoot: 'G:/proj/a', permissionMode: 'ask' },
      cwd: 'G:/proj/a',
      status: 'idle',
      harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
    };
    const analytics = { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn() };
    const store = {
      list: () => [session],
      get: (id: string) => (id === session.id ? session : undefined),
      upsert: vi.fn(),
      appendTranscript: vi.fn(async () => undefined),
      sessionDir: () => os.tmpdir()
    } as unknown as SessionStore;
    const manager = new SessionManager({
      store,
      settings: { get: () => defaultSettings() } as unknown as SettingsStore,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: analytics as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: vi.fn(),
      notify: vi.fn(),
      log: vi.fn()
    });
    const ctx = (manager as unknown as { buildContext: (meta: SessionMeta, id: string) => { updateMeta: (patch: Partial<SessionMeta>) => void } }).buildContext(session, session.id);
    ctx.updateMeta({ activeModel: { provider: 'openai', model: 'gpt-6-terra' } });
    expect(analytics.touchSession).toHaveBeenCalledWith(expect.objectContaining({ activeModel: { provider: 'openai', model: 'gpt-6-terra' } }));
    analytics.touchSession.mockClear();
    await manager.setModel(session.id, { provider: 'anthropic', model: 'claude-opus-5' });
    expect(analytics.touchSession).toHaveBeenCalledWith(expect.objectContaining({ activeModel: { provider: 'anthropic', model: 'claude-opus-5' } }));

    const adapterSetModel = vi.fn(async () => undefined);
    const active = { adapter: { setModel: adapterSetModel }, liveItems: new Map(), toolModels: new Map(), dirty: new Set() };
    (manager as unknown as { active: Map<string, typeof active> }).active.set(session.id, active);
    analytics.touchSession.mockClear();
    adapterSetModel.mockRejectedValueOnce(new Error('switch rejected'));
    await expect(manager.setModel(session.id, { provider: 'openai', model: 'gpt-6-terra' })).rejects.toThrow('switch rejected');
    expect(session.activeModel).toEqual({ provider: 'anthropic', model: 'claude-opus-5' });
    expect(analytics.touchSession).not.toHaveBeenCalled();

    const emit = (manager as unknown as { emit: (id: string, event: SessionEvent) => void }).emit.bind(manager);
    const running = { id: 'tool-1', kind: 'tool', ts: 2, name: 'Bash', status: 'running' } as const;
    emit(session.id, { type: 'item.upsert', item: running });
    ctx.updateMeta({ activeModel: { provider: 'openai', model: 'gpt-6-terra' } });
    const done = { ...running, status: 'done' as const };
    emit(session.id, { type: 'item.upsert', item: done });
    expect(analytics.recordToolCall).toHaveBeenCalledWith(session.id, done, undefined, { provider: 'anthropic', model: 'claude-opus-5' });
  });
});

describe('SessionManager fork', () => {
  const sourceSession = (): SessionMeta => ({
    id: 's_src',
    title: 'source session',
    createdAt: 1_000,
    updatedAt: 2_000,
    config: {
      harness: 'claude',
      projectRoot: 'G:/proj/a',
      permissionMode: 'auto',
      model: { provider: 'anthropic', model: 'claude-sonnet-4-5' }
    },
    cwd: 'G:/proj/a/.vocs-code/worktrees/wt',
    worktreeBranch: 'agent/source-session',
    status: 'idle',
    harnessRef: { claudeSessionId: 'claude_abc' },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
  });

  const forkManager = (src: SessionMeta) => {
    const sessions: SessionMeta[] = [src];
    const transcripts = new Map<string, TranscriptItem[]>();
    const settings = defaultSettings();
    settings.defaultModelByHarness.pi = { provider: 'anthropic', model: 'claude-sonnet-4-5' };
    const store = {
      list: () => sessions,
      get: (id: string) => sessions.find((s) => s.id === id),
      upsert: async (m: SessionMeta) => {
        const i = sessions.findIndex((s) => s.id === m.id);
        if (i >= 0) sessions[i] = m;
        else sessions.push(m);
      },
      readTranscript: async (id: string) => transcripts.get(id) ?? [],
      rewriteTranscript: async (id: string, items: TranscriptItem[]) => void transcripts.set(id, items),
      readNativeHistory: async () => null,
      writeNativeHistory: async () => undefined,
      readBlob: async () => null,
      writeBlob: async () => 'fork-context.md',
      sessionDir: (id: string) => path.join(os.tmpdir(), `fork-test-${id}`)
    } as unknown as SessionStore;
    const manager = new SessionManager({
      store,
      settings: { get: () => settings } as unknown as SettingsStore,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn() } as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: vi.fn(),
      notify: vi.fn(),
      log: vi.fn()
    });
    return { manager, transcripts };
  };

  it('forks into a different harness with a fresh provider session', async () => {
    const src = sourceSession();
    src.config.acpAgent = 'dsh';
    src.config.codexModelProvider = { id: 'x', name: 'x', baseUrl: 'https://x' };
    const items: TranscriptItem[] = [
      { id: 'u_1', kind: 'user', ts: 1, text: 'fix the login bug' },
      { id: 'a_1', kind: 'assistant', ts: 2, text: 'done' }
    ];
    const { manager, transcripts } = forkManager(src);
    transcripts.set(src.id, items);
    const fork = await manager.fork(src.id, 'pi');
    expect(fork).toBeTruthy();
    expect(fork!.id).not.toBe(src.id);
    expect(fork!.config.harness).toBe('pi');
    // No repository behind this fake project root, so the fork shares the source's directory and
    // must not claim the source's worktree: archiving the fork would otherwise remove it.
    expect(fork!.cwd).toBe(src.cwd);
    expect(fork!.worktreeBranch).toBeUndefined();
    expect(fork!.config.useWorktree).toBe(false);
    // The new harness cannot resume the source's provider session; the transcript is handed over as text.
    expect(fork!.harnessRef).toEqual({});
    expect(fork!.pendingForkContext).toBe(true);
    // Harness-specific config does not transfer; the model falls back to the target default.
    expect(fork!.config.acpAgent).toBeUndefined();
    expect(fork!.config.codexModelProvider).toBeUndefined();
    expect(fork!.config.model).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
    expect(fork!.activeModel).toEqual(fork!.config.model);
    // The transcript is carried over for reference plus an explanatory info note.
    const copied = transcripts.get(fork!.id) ?? [];
    expect(copied.map((i) => i.id)).toContain('u_1');
    const note = copied.find((i) => i.kind === 'info');
    expect(note?.kind === 'info' && note.text).toContain('Forked from');
    expect(fork!.title).toContain('fork');
  });

  it('keeps same-harness fork semantics in a shared directory: drops the worktree claim and carries provider state', async () => {
    const src = sourceSession();
    const items: TranscriptItem[] = [{ id: 'u_1', kind: 'user', ts: 1, text: 'hi' }];
    const { manager, transcripts } = forkManager(src);
    transcripts.set(src.id, items);
    const fork = await manager.fork(src.id);
    expect(fork!.config.harness).toBe('claude');
    expect(fork!.worktreeBranch).toBeUndefined();
    expect(fork!.harnessRef).toEqual({ claudeSessionId: 'claude_abc', forkOnResume: true });
    expect(fork!.pendingForkContext).toBeUndefined();
    const copied = transcripts.get(fork!.id) ?? [];
    expect(copied.some((i) => i.kind === 'info')).toBe(false);
    expect(copied.map((i) => i.id)).toContain('u_1');
  });

  it('gives a worktree fork its own worktree, and hands over the conversation the provider resume can no longer reach', async () => {
    const src = sourceSession();
    const items: TranscriptItem[] = [{ id: 'u_1', kind: 'user', ts: 1, text: 'hi' }];
    const { manager, transcripts } = forkManager(src);
    transcripts.set(src.id, items);
    vi.mocked(createForkWorktree).mockResolvedValueOnce({ path: 'G:/proj/a/.vocs-code/worktrees/source-fork', branch: 'vocscode/source-fork' });

    const fork = await manager.fork(src.id);

    // The fork runs in its own checkout on its own branch, so archiving the source (and removing
    // its worktree) leaves the fork's directory alone.
    expect(fork!.cwd).toBe('G:/proj/a/.vocs-code/worktrees/source-fork');
    expect(fork!.worktreeBranch).toBe('vocscode/source-fork');
    // A provider session id is bound to its directory: the relocated fork cannot resume claude_abc.
    expect(fork!.harnessRef).toEqual({});
    expect(fork!.pendingForkContext).toBe(true);
    // The note says where the fork landed and why the next message carries the conversation.
    const note = (transcripts.get(fork!.id) ?? []).find((i) => i.kind === 'info');
    expect(note?.kind === 'info' && note.text).toContain('vocscode/source-fork');
  });
});

describe('SessionManager PR state refresh', () => {
  it.each(['an already-busy adapter', 'an adapter that becomes busy during the lookup', 'a pending send that later rejects'] as const)(
    'defers publishing or persisting Git labels for %s', async (phase) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-pr-state-'));
      const store = new SessionStore(dir);
      const session: SessionMeta = {
        id: 'pr_live_session', title: 'Live turn', createdAt: 1_000, updatedAt: 2_000,
        config: { harness: 'antigravity', projectRoot: dir, permissionMode: 'ask' },
        cwd: dir, worktreeBranch: 'harness/pr-live-session', status: 'idle', harnessRef: {},
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
      };
      const published: SessionMeta['status'][] = [];
      const manager = new SessionManager({
        store,
        settings: { get: () => defaultSettings() } as unknown as SettingsStore,
        runtime: undefined as unknown as RuntimeResolver,
        analytics: { recordUserMessage: vi.fn(), recordTurn: vi.fn() } as unknown as AnalyticsStore,
        getSecret: async () => undefined,
        pushEvent: vi.fn(),
        pushSessions: ([meta]) => published.push(meta!.status),
        notify: vi.fn(),
        log: vi.fn()
      });
      const lookup = deferred<{ pr: boolean; merged: boolean }>();
      const accepted = deferred<void>();
      const adapter = {
        busy: phase === 'an already-busy adapter',
        send: vi.fn(() => accepted.promise),
        interrupt: vi.fn(async () => undefined)
      };
      const active = { adapter, approvals: new Map(), liveItems: new Map(), dirty: new Set(), starting: null };
      const testManager = manager as unknown as { active: Map<string, typeof active>; emit: (id: string, event: SessionEvent) => void };
      const check = vi.mocked(branchGitState).mockClear().mockReturnValueOnce(lookup.promise).mockResolvedValue({ pr: true, merged: false });
      vi.useFakeTimers();
      try {
        await store.upsert(session);
        testManager.active.set(session.id, active);
        // Keep the fake-clock boundary deterministic; only the Git result is delayed.
        vi.spyOn(manager, 'sessionPrRefs').mockResolvedValue([]);
        manager.refreshGitState(session.id);
        await vi.advanceTimersByTimeAsync(1_000);
        let sending: Promise<void> | undefined;
        if (phase === 'a pending send that later rejects') {
          sending = manager.send(session.id, { text: 'Follow up' });
          await vi.advanceTimersByTimeAsync(0);
          expect(adapter.send).toHaveBeenCalledOnce();
        } else {
          adapter.busy = true;
        }
        published.length = 0;
        // Models a stale idle status while the adapter is busy or accepting the turn.
        expect(session.status).toBe('idle');
        lookup.resolve({ pr: false, merged: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(check).toHaveBeenCalledTimes(phase === 'an already-busy adapter' ? 0 : 1);
        expect(published).toEqual([]);
        expect(session.status).toBe('idle');
        await manager.flushPendingPersists();
        expect(JSON.parse(await fs.readFile(path.join(dir, 'sessions.json'), 'utf8'))[0].status).toBe('idle');
        await manager.interrupt(session.id);
        expect(adapter.interrupt).toHaveBeenCalledOnce();

        check.mockReset().mockResolvedValueOnce({ pr: true, merged: false }).mockResolvedValue({ pr: false, merged: true });
        adapter.busy = false;
        if (sending) {
          // A rejection can return to idle without a terminal turn item (e.g. a refused turn/start).
          testManager.emit(session.id, { type: 'status', status: 'idle' });
          accepted.reject(new Error('Prompt refused'));
          await expect(sending).rejects.toThrow('Prompt refused');
        } else {
          testManager.emit(session.id, { type: 'item.upsert', item: { id: 'finished_turn', kind: 'turn', ts: Date.now(), status: 'interrupted' } });
          testManager.emit(session.id, { type: 'status', status: 'idle' });
        }
        await vi.advanceTimersByTimeAsync(4_000);
        expect(published).toEqual(['idle', 'pr']);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(published).toEqual(['idle', 'pr', 'merged']);
        await manager.flushPendingPersists();
        expect(JSON.parse(await fs.readFile(path.join(dir, 'sessions.json'), 'utf8'))[0].status).toBe('merged');
      } finally {
        check.mockReset().mockResolvedValue({ pr: false, merged: false });
        vi.useRealTimers();
        await store.readTranscript(session.id);
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  );

  it.each([
    { when: 'the first check finds the merge', unchangedPolls: 0 },
    { when: 'the PR stays open across multiple checks', unchangedPolls: 2 }
  ])('updates the sidebar to merged when $when', async ({ unchangedPolls }) => {
    vi.useFakeTimers();
    const session: SessionMeta = {
      id: 'pr_session',
      title: 'pr session',
      createdAt: 1_000,
      updatedAt: 2_000,
      config: { harness: 'native', projectRoot: 'G:/proj/pr', permissionMode: 'auto' },
      cwd: 'G:/proj/pr/.vocs-code/worktrees/wt',
      worktreeBranch: 'harness/pr-session',
      status: 'pr',
      harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
    };
    const upsert = vi.fn();
    const published: SessionMeta['status'][] = [];
    const store = {
      list: () => [session],
      get: (id: string) => (id === session.id ? session : undefined),
      upsert
    } as unknown as SessionStore;
    const manager = new SessionManager({
      store,
      settings: { get: () => defaultSettings() } as unknown as SettingsStore,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn() } as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: ([meta]) => published.push(meta!.status),
      notify: vi.fn(),
      log: vi.fn()
    });
    const check = vi.mocked(branchGitState).mockClear();
    for (let i = 0; i < unchangedPolls; i++) check.mockResolvedValueOnce({ pr: true, merged: false });
    check.mockResolvedValue({ pr: false, merged: true });
    try {
      manager.refreshGitState(session.id);
      expect(session.status).toBe('pr'); // not flipped synchronously
      await vi.advanceTimersByTimeAsync(2_000); // 1s check delay + the 300ms debounced persist
      for (let i = 0; i < unchangedPolls; i++) {
        expect(session.status).toBe('pr');
        expect(published).toEqual([]);
        expect(check).toHaveBeenCalledTimes(i + 1);
        await vi.advanceTimersByTimeAsync(120_000);
      }
      expect(session.status).toBe('merged');
      expect(published).toEqual(['merged']);
      expect(upsert).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(check).toHaveBeenCalledTimes(unchangedPolls + 1);
    } finally {
      check.mockReset().mockResolvedValue({ pr: false, merged: false });
      vi.useRealTimers();
    }
  });

  it('keeps a git-derived status when the harness exits instead of flipping to stopped', () => {
    const session: SessionMeta = {
      id: 'merged_session',
      title: 'merged session',
      createdAt: 1_000,
      updatedAt: 2_000,
      config: { harness: 'pi', projectRoot: 'G:/proj/pr', permissionMode: 'auto' },
      cwd: 'G:/proj/pr/.vocs-code/worktrees/wt',
      worktreeBranch: 'harness/merged-session',
      status: 'merged',
      harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
    };
    const manager = new SessionManager({
      store: { list: () => [session], get: (id: string) => (id === session.id ? session : undefined), upsert: vi.fn() } as unknown as SessionStore,
      settings: { get: () => defaultSettings() } as unknown as SettingsStore,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn() } as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: vi.fn(),
      notify: vi.fn(),
      log: vi.fn()
    });
    // The pi process died (e.g. killed while the app quit) and reported its exit.
    (manager as unknown as { emit: (id: string, event: SessionEvent) => void }).emit(session.id, { type: 'status', status: 'stopped', detail: 'pi exited (0)' });
    expect(session.status).toBe('merged');
  });

  it('stop() keeps a parked pr/merged status', async () => {
    const session: SessionMeta = {
      id: 'merged_session',
      title: 'merged session',
      createdAt: 1_000,
      updatedAt: 2_000,
      config: { harness: 'pi', projectRoot: 'G:/proj/pr', permissionMode: 'auto' },
      cwd: 'G:/proj/pr/.vocs-code/worktrees/wt',
      worktreeBranch: 'harness/merged-session',
      status: 'merged',
      harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
    };
    const manager = new SessionManager({
      store: { list: () => [session], get: (id: string) => (id === session.id ? session : undefined), upsert: vi.fn(), appendTranscript: async () => undefined } as unknown as SessionStore,
      settings: { get: () => defaultSettings() } as unknown as SettingsStore,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn() } as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: vi.fn(),
      notify: vi.fn(),
      log: vi.fn()
    });
    const active = {
      adapter: { dispose: vi.fn(async () => undefined) },
      approvals: new Map(),
      liveItems: new Map(),
      dirty: new Set<string>(),
      lastAssistantText: '',
      starting: null,
      models: null
    };
    (manager as unknown as { active: Map<string, typeof active> }).active.set(session.id, active);
    await manager.stop(session.id);
    expect(active.adapter.dispose).toHaveBeenCalled();
    expect(session.status).toBe('merged');
  });

  it('a stopped session is re-checked at boot and upgraded back to merged', async () => {
    vi.useFakeTimers();
    const session: SessionMeta = {
      id: 'stopped_session',
      title: 'stopped session',
      createdAt: 1_000,
      updatedAt: 2_000,
      config: { harness: 'pi', projectRoot: 'G:/proj/pr', permissionMode: 'auto' },
      cwd: 'G:/proj/pr/.vocs-code/worktrees/wt',
      worktreeBranch: 'harness/merged-session',
      status: 'stopped',
      harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
    };
    const store = {
      list: () => [session],
      get: (id: string) => (id === session.id ? session : undefined),
      // Throwing keeps sessionPrRefs on its synchronous catch path: no real fs I/O that fake
      // timers would not flush before the assertions.
      sessionDir: () => {
        throw new Error('no fs in test');
      },
      upsert: vi.fn()
    } as unknown as SessionStore;
    const manager = new SessionManager({
      store,
      settings: { get: () => defaultSettings() } as unknown as SettingsStore,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn() } as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: vi.fn(),
      notify: vi.fn(),
      log: vi.fn()
    });
    try {
      vi.mocked(branchGitState).mockResolvedValue({ pr: false, merged: true });
      manager.list(); // boot: schedules the one-shot re-check for stopped sessions
      await vi.advanceTimersByTimeAsync(5_000);
      expect(session.status).toBe('merged');

      // Without git evidence the stopped status is kept, never downgraded to idle.
      session.status = 'stopped';
      (manager as unknown as { gitStateChecked: Set<string> }).gitStateChecked.delete(session.id);
      vi.mocked(branchGitState).mockResolvedValue({ pr: false, merged: false });
      manager.list();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(session.status).toBe('stopped');
    } finally {
      vi.mocked(branchGitState).mockResolvedValue({ pr: false, merged: false });
      vi.useRealTimers();
    }
  });
});

describe('SessionManager filesystem guards', () => {
  it('does not touch the store for unknown sessions', async () => {
    const remove = vi.fn(async () => undefined);
    const readTranscript = vi.fn(async () => [] as TranscriptItem[]);
    const rewriteTranscript = vi.fn(async () => undefined);
    const store = {
      list: () => [],
      get: () => undefined,
      remove,
      readTranscript,
      rewriteTranscript
    } as unknown as SessionStore;
    const manager = new SessionManager({
      store,
      settings: { get: () => defaultSettings() } as unknown as SettingsStore,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn() } as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: vi.fn(),
      notify: vi.fn(),
      log: vi.fn()
    });
    const stop = vi.spyOn(manager, 'stop');

    await manager.delete('../sentinel');
    await expect(manager.transcript('../sentinel')).rejects.toThrow('Session not found');
    await expect(manager.clearTranscript('../sentinel')).rejects.toThrow('Session not found');

    expect(stop).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(readTranscript).not.toHaveBeenCalled();
    expect(rewriteTranscript).not.toHaveBeenCalled();
  });
});

describe('SessionManager pin ordering', () => {
  const makeManager = (sessions: SessionMeta[]) => {
    const upsert = vi.fn();
    const store = { list: () => sessions, get: (id: string) => sessions.find((s) => s.id === id), upsert } as unknown as SessionStore;
    const manager = new SessionManager({
      store,
      settings: { get: () => defaultSettings(), update: async () => undefined } as unknown as SettingsStore,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn() } as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: vi.fn(),
      notify: vi.fn(),
      log: vi.fn()
    });
    return { manager, upsert };
  };
  const pinnedSession = (id: string, patch: Partial<SessionMeta>): SessionMeta => ({
    id,
    title: id,
    createdAt: 1_000,
    updatedAt: 1_000,
    config: { harness: 'native', projectRoot: 'G:/proj/a', permissionMode: 'ask' },
    cwd: 'G:/proj/a',
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    ...patch
  });

  it('setPinned stamps the pin time and never bumps updatedAt', async () => {
    const s = pinnedSession('s_a', {});
    const { manager } = makeManager([s]);
    const before = s.updatedAt;
    const pinned = await manager.setPinned(s.id, true);
    expect(pinned.pinned).toBe(true);
    expect(pinned.pinnedAt).toBeGreaterThan(0);
    // The unpinned section orders by updatedAt, so pinning must not reshuffle it.
    expect(pinned.updatedAt).toBe(before);
    const unpinned = await manager.setPinned(s.id, false);
    expect(unpinned.pinned).toBeUndefined();
    expect(unpinned.pinnedAt).toBeUndefined();
  });

  it('setPinOrder rewrites pin stamps in display order and skips unknown ids', async () => {
    const a = pinnedSession('s_a', { pinned: true, pinnedAt: 100 });
    const b = pinnedSession('s_b', { pinned: true, pinnedAt: 200 });
    const { manager, upsert } = makeManager([a, b]);
    await manager.setPinOrder(['s_b', 's_a']);
    // Small ordinals keep future pins (stamped with Date.now()) below the reordered section.
    expect(b.pinnedAt).toBe(1);
    expect(a.pinnedAt).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(2);
    await expect(manager.setPinOrder(['s_missing'])).resolves.toBeUndefined();
  });
});
