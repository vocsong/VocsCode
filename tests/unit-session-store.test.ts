import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import { SessionManager } from '../src/main/session-manager';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import type { SessionEvent, SessionMeta, TranscriptItem } from '../src/shared/types';

describe('SessionStore round-trip', () => {
  const tmpRoot = path.join(os.tmpdir(), `vocs-code-store-test-${Date.now()}-${process.pid}`);
  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  const meta = (id: string, status: SessionMeta['status'] = 'idle'): SessionMeta => ({
    id,
    title: `session ${id}`,
    createdAt: 1_000,
    updatedAt: 2_000,
    config: { harness: 'native', projectRoot: tmpRoot, permissionMode: 'auto' },
    cwd: tmpRoot,
    status,
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    queued: 3
  });

  it('publishes live running status to session list listeners', () => {
    const session = meta('status_session');
    const published: SessionMeta[][] = [];
    const store = {
      list: () => [session],
      get: (id: string) => (id === session.id ? session : undefined)
    } as unknown as SessionStore;
    const manager = new SessionManager({
      store,
      settings: { get: () => defaultSettings() } as unknown as SettingsStore,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn() } as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: (list) => published.push(list),
      notify: vi.fn(),
      log: vi.fn()
    });

    (manager as unknown as { emit: (id: string, event: SessionEvent) => void }).emit(session.id, { type: 'status', status: 'running', detail: 'Working' });

    expect(session.status).toBe('running');
    expect(session.statusDetail).toBe('Working');
    expect(published).toHaveLength(1);
    expect(published[0][0]).toMatchObject({ id: session.id, status: 'running', statusDetail: 'Working' });
  });

  it('applies an intermediate usage event to the live session and analytics listeners', () => {
    const session = meta('usage_session');
    const published: SessionMeta[][] = [];
    const analytics = { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn() };
    const store = {
      list: () => [session],
      get: (id: string) => (id === session.id ? session : undefined),
      upsert: vi.fn(async () => undefined)
    } as unknown as SessionStore;
    const manager = new SessionManager({
      store,
      settings: { get: () => defaultSettings() } as unknown as SettingsStore,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: analytics as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: (list) => published.push(list),
      notify: vi.fn(),
      log: vi.fn()
    });
    const totals = { ...session.usage, inputTokens: 120, outputTokens: 24, costUsd: 0.12 };

    (manager as unknown as { emit: (id: string, event: SessionEvent) => void }).emit(session.id, { type: 'usage', totals });

    expect(session.usage).toEqual(totals);
    expect(analytics.recordUsage).toHaveBeenCalledWith(session, totals, undefined, undefined);
    expect(published.at(-1)?.[0]).toMatchObject({ id: session.id, usage: totals });
  });

  it('persists session meta and transcripts that a fresh store over the same directory reads back', async () => {
    const first = new SessionStore(tmpRoot);
    await first.load();
    const m = meta('sess_1', 'running');
    await first.upsert(m);
    await first.appendTranscript('sess_1', { id: 'i1', kind: 'user', ts: 1, text: 'hello' } as TranscriptItem);
    await first.appendTranscript('sess_1', { id: 'i2', kind: 'user', ts: 2, text: 'again' } as TranscriptItem);
    await first.appendTranscript('sess_1', { id: 'i1', kind: 'user', ts: 1, text: 'hello edited' } as TranscriptItem);

    // A brand-new store instance over the same userData directory survives the "restart".
    const second = new SessionStore(tmpRoot);
    const loaded = await second.load();
    expect(loaded.map((s) => s.id)).toContain('sess_1');
    const restored = second.get('sess_1');
    expect(restored?.title).toBe('session sess_1');
    expect(restored?.config.harness).toBe('native');
    // A session that was running when the app closed is downgraded to idle with an empty queue.
    expect(restored?.status).toBe('idle');
    expect(restored?.queued).toBe(0);

    const items = await second.readTranscript('sess_1');
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe('i1');
    // Last write wins per id, first-occurrence order preserved.
    expect(items[0]).toMatchObject({ kind: 'user', text: 'hello edited' });
    expect(items[1].id).toBe('i2');
  });

  it('remove deletes the meta entry and the transcript directory', async () => {
    const store = new SessionStore(tmpRoot);
    await store.load();
    await store.upsert(meta('sess_2'));
    await store.appendTranscript('sess_2', { id: 'j1', kind: 'user', ts: 1, text: 'x' } as TranscriptItem);
    await store.remove('sess_2');
    expect(store.get('sess_2')).toBeUndefined();
    const again = new SessionStore(tmpRoot);
    await again.load();
    expect(again.get('sess_2')).toBeUndefined();
    expect(await again.readTranscript('sess_2')).toEqual([]);
  });

  it('rejects traversal before transcript reads, rewrites, or removal can touch an outside directory', async () => {
    const securityRoot = path.join(os.tmpdir(), `vocs-code-store-security-${Date.now()}-${process.pid}`);
    const sentinelDir = path.join(securityRoot, 'sentinel');
    const sentinelFile = path.join(sentinelDir, 'transcript.jsonl');
    const sentinel = `${JSON.stringify({ id: 'secret', kind: 'user', ts: 1, text: 'do not touch' })}\n`;
    await fs.mkdir(sentinelDir, { recursive: true });
    await fs.writeFile(sentinelFile, sentinel, 'utf8');
    try {
      const store = new SessionStore(securityRoot);
      await store.load();

      await expect(store.readTranscript('../sentinel')).rejects.toThrow('Invalid session ID');
      await expect(store.rewriteTranscript('../sentinel', [])).rejects.toThrow('Invalid session ID');
      await expect(store.remove('../sentinel')).rejects.toThrow('Invalid session ID');
      await expect(store.upsert({ ...meta('s1'), id: '../sentinel' })).rejects.toThrow('Invalid session ID');

      expect(store.list()).toEqual([]);
      expect(await fs.readFile(sentinelFile, 'utf8')).toBe(sentinel);
      expect(await fs.stat(sentinelDir)).toBeTruthy();
      expect(() => store.sessionDir('.')).toThrow('Invalid session ID');
      expect(() => store.sessionDir('..')).toThrow('Invalid session ID');
      expect(() => store.sessionDir('C:\\sentinel')).toThrow('Invalid session ID');
      expect(store.sessionDir('a')).toBe(path.join(securityRoot, 'sessions', 'a'));
    } finally {
      await fs.rm(securityRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('filters malformed persisted session IDs while retaining safe legacy IDs', async () => {
    const loadedRoot = path.join(os.tmpdir(), `vocs-code-store-loaded-${Date.now()}-${process.pid}`);
    await fs.mkdir(loadedRoot, { recursive: true });
    await fs.writeFile(
      path.join(loadedRoot, 'sessions.json'),
      JSON.stringify([
        meta('s1'),
        meta('sess_1'),
        meta('a'),
        meta('../sentinel'),
        meta('.'),
        meta('..'),
        meta('bad/slash'),
        meta('bad\\slash'),
        meta('C:\\drive')
      ]),
      'utf8'
    );
    try {
      const store = new SessionStore(loadedRoot);
      const loaded = await store.load();
      expect(loaded.map((session) => session.id)).toEqual(['s1', 'sess_1', 'a']);
    } finally {
      await fs.rm(loadedRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('upsert rejects when the index write fails instead of resolving silently', async () => {
    // A directory where sessions.json belongs makes the atomic rename fail deterministically.
    const brokenRoot = path.join(os.tmpdir(), `vocs-code-store-broken-${Date.now()}-${process.pid}`);
    await fs.mkdir(path.join(brokenRoot, 'sessions.json'), { recursive: true });
    try {
      const store = new SessionStore(brokenRoot);
      await store.load();
      await expect(store.upsert(meta('sess_x'))).rejects.toThrow();
    } finally {
      await fs.rm(brokenRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
