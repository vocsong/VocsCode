/** "Done · not viewed" (docs/superpowers/specs/2026-11-09-session-activity-tray-design.md): main
 *  marks a turn that finished while nobody was looking, keeps the mark until the session is viewed,
 *  and never lets viewing reshuffle the sidebar's ordering. */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { SessionEvent, SessionMeta, TranscriptItem } from '../src/shared/types';
import { defaultSettings } from '../src/main/settings';
import { SessionManager } from '../src/main/session-manager';
import { SessionStore } from '../src/main/store';
import { createHandlerRegistry, type HandlerDeps } from '../src/main/handlers';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import type { SettingsStore } from '../src/main/settings';
import type { MissionOwnership } from '../src/shared/mission';
import type { HarnessAdapter } from '../src/main/harness/types';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) fsSync.rmSync(dir, { recursive: true, force: true });
});

function session(patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's1',
    title: 'Work',
    createdAt: 1,
    updatedAt: 100,
    config: { harness: 'native', projectRoot: 'G:/project', permissionMode: 'ask' },
    cwd: 'G:/project',
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    ...patch
  };
}

async function fixture(meta: SessionMeta, viewing = false) {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'vocs-unseen-'));
  dirs.push(dir);
  const store = new SessionStore(dir);
  await store.load();
  await store.upsert(meta);
  const upsert = vi.spyOn(store, 'upsert');
  const pushSessions = vi.fn();
  const isViewing = vi.fn(() => viewing);
  const manager = new SessionManager({
    store,
    settings: { get: () => ({ ...defaultSettings(), notifications: false }) } as unknown as SettingsStore,
    runtime: undefined as unknown as RuntimeResolver,
    analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn() } as unknown as AnalyticsStore,
    getSecret: async () => undefined,
    pushEvent: vi.fn(),
    pushSessions,
    notify: vi.fn(),
    log: vi.fn(),
    isViewing
  });
  const emit = (event: SessionEvent) => (manager as unknown as { emit: (id: string, value: SessionEvent) => void }).emit(meta.id, event);
  const finishTurn = (status: 'completed' | 'failed' | 'interrupted', ts = 5_000) =>
    emit({ type: 'item.upsert', item: { id: `t_${ts}`, kind: 'turn', ts, status } as TranscriptItem });
  return { dir, store, upsert, pushSessions, isViewing, manager, finishTurn, get: () => manager.get(meta.id)! };
}

const worker: MissionOwnership = { missionId: 'm1', role: 'worker', generation: 1, sourceAccess: 'read_only', requestedTools: [], reasoningDefault: false };

describe('marking a turn that finished unviewed', () => {
  it('marks a completed turn nobody was looking at, and says so to the sidebar', async () => {
    const f = await fixture(session());
    f.finishTurn('completed', 5_000);
    expect(f.get().unseenAt).toBe(5_000);
    expect(f.isViewing).toHaveBeenCalledWith('s1');
    expect(f.pushSessions).toHaveBeenCalled();
    expect(f.pushSessions.mock.lastCall?.[0].find((s: SessionMeta) => s.id === 's1')?.unseenAt).toBe(5_000);
  });

  it('marks a failed turn too', async () => {
    const f = await fixture(session());
    f.finishTurn('failed');
    expect(f.get().unseenAt).toBe(5_000);
  });

  it('never marks a turn the user interrupted', async () => {
    const f = await fixture(session());
    f.finishTurn('interrupted');
    expect(f.get().unseenAt).toBeUndefined();
  });

  it('does not mark a turn that ended on screen in the focused window', async () => {
    const f = await fixture(session(), true);
    f.finishTurn('completed');
    expect(f.get().unseenAt).toBeUndefined();
  });

  it('does not mark a Mission worker, which is never a sidebar row', async () => {
    const f = await fixture(session({ mission: worker }));
    f.finishTurn('completed');
    expect(f.get().unseenAt).toBeUndefined();
  });

  it('does not mark an archived session', async () => {
    const f = await fixture(session({ archived: true }));
    f.finishTurn('completed');
    expect(f.get().unseenAt).toBeUndefined();
  });

  it('keeps the mark across a restart', async () => {
    const f = await fixture(session());
    f.finishTurn('completed', 7_000);
    await vi.waitFor(async () => {
      const reloaded = new SessionStore(f.dir);
      await reloaded.load();
      expect(reloaded.get('s1')?.unseenAt).toBe(7_000);
    }, { timeout: 3_000 });
  });
});

describe('sending', () => {
  it('clears the mark, because writing to a session is looking at it', async () => {
    const f = await fixture(session({ unseenAt: 5_000 }));
    const send = vi.fn(async () => undefined);
    const adapter = {
      id: 'native', busy: false, start: vi.fn(async () => undefined), send, interrupt: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined), setEffort: vi.fn(async () => undefined), setPermissionMode: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined)
    } as unknown as HarnessAdapter;
    (f.manager as unknown as { active: Map<string, unknown> }).active.set('s1', {
      adapter, approvals: new Map(), liveItems: new Map(), dirty: new Set<string>(), lastAssistantText: '', starting: null, models: null,
      autoCompactionThreshold: undefined, autoCompactionLatched: false, autoCompactionRetryAt: 0, autoCompactionRetryTimer: null,
      compactionInFlight: null, autoCompactionWindow: undefined, goalContinuationTimer: null
    });
    await f.manager.send('s1', { text: 'next step' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.get().unseenAt).toBeUndefined();
  });
});

describe('markViewed', () => {
  it('clears the mark and stamps the view without reshuffling the sidebar', async () => {
    const f = await fixture(session({ unseenAt: 5_000, updatedAt: 100 }));
    const before = Date.now();
    const meta = await f.manager.markViewed('s1');
    expect(meta.unseenAt).toBeUndefined();
    expect('unseenAt' in meta).toBe(false);
    expect(meta.lastViewedAt).toBeGreaterThanOrEqual(before);
    // The sidebar orders by updatedAt when there is no user message: viewing must not move a row.
    expect(meta.updatedAt).toBe(100);
    expect(f.upsert).toHaveBeenCalledTimes(1);
    expect(f.pushSessions).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown session', async () => {
    const f = await fixture(session());
    await expect(f.manager.markViewed('nope')).rejects.toThrow('Session not found');
  });

  it('is reachable over IPC and rejects a malformed id', async () => {
    const f = await fixture(session({ unseenAt: 5_000 }));
    const registry = createHandlerRegistry({ sessions: f.manager, log: () => undefined } as unknown as HandlerDeps);
    const meta = (await registry.invoke('sessions:markViewed', { id: 's1' })) as SessionMeta;
    expect(meta.unseenAt).toBeUndefined();
    await expect(registry.invoke('sessions:markViewed', { id: '../etc' })).rejects.toThrow();
  });
});
