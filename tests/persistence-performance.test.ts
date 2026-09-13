import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../src/main/store';
import { SessionManager } from '../src/main/session-manager';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import { createAdapter } from '../src/main/harness/registry';
import type { HarnessContext } from '../src/main/harness/types';
import { emptyUsage } from '../src/main/models/static-models';
import { deferred } from '../src/main/util/async';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn() }));

let root: string;
let store: SessionStore;
let snapshots: SessionMeta[][];
let releases: (() => void)[];

function meta(id: string): SessionMeta {
  return {
    id, title: id, createdAt: 1, updatedAt: 1,
    config: { harness: 'native', permissionMode: 'ask', projectRoot: root },
    cwd: root, status: 'idle', harnessRef: {}, usage: emptyUsage(), queued: 0,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-persistence-perf-'));
  store = new SessionStore(root);
  await store.load();
  snapshots = [];
  releases = [];
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    const snapshot = String(to) === path.join(root, 'sessions.json')
      ? JSON.parse(await fs.readFile(from, 'utf8')) as SessionMeta[] : undefined;
    await rename(from, to);
    if (snapshot) snapshots.push(snapshot);
  });
});

afterEach(async () => {
  for (const release of releases) release();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

/** Pause real writes before serialization, not just before rename, to catch mutable snapshots. */
function gateWrites(count: number) {
  const gates = Array.from({ length: count }, () => ({
    entered: deferred<void>(), release: deferred<void>(), error: undefined as Error | undefined,
  }));
  releases.push(...gates.map((gate) => () => gate.release.resolve()));
  const open = fs.open.bind(fs);
  let calls = 0;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]).startsWith(path.join(root, 'sessions.json.'))) {
      const gate = gates[calls++];
      if (gate) {
        gate.entered.resolve();
        await gate.release.promise;
        if (gate.error) throw gate.error;
      }
    }
    return open(...args);
  });
  return gates;
}

async function reload(): Promise<SessionMeta[]> {
  return new SessionStore(root).load();
}

describe('SessionStore coalesced index persistence', () => {
  it('writes a synchronous burst once and reloads the exact latest ordered index', async () => {
    const entries = Array.from({ length: 40 }, (_, i) => meta(`s_${i}`));
    const pending = entries.map((entry) => store.upsert(entry));
    const revised = { ...entries[0], title: 'latest' };
    pending.push(store.upsert(revised));
    await Promise.all(pending);
    const expected = [...entries.slice(1).reverse(), revised];
    expect(await reload()).toEqual(expected);
    expect(snapshots).toHaveLength(1);
    expect(snapshots).toEqual([expected]);
  });

  it('freezes each in-flight snapshot and waits for one follow-up generation', async () => {
    const [first, second] = gateWrites(2);
    const entry = meta('s_1');
    const original = structuredClone(entry);
    const initial = store.upsert(entry);
    await first.entered.promise;
    entry.title = 'changed while writing';
    entry.config.permissionMode = 'full-auto';
    entry.usage.inputTokens = 123;
    let settled = 0;
    const pending = Array.from({ length: 30 }, () => store.upsert(entry).then(() => { settled++; }));
    first.release.resolve();
    await initial;
    await second.entered.promise;
    try {
      expect(await reload()).toEqual([original]);
      expect(settled).toBe(0);
      expect(snapshots).toEqual([[original]]);
    } finally {
      second.release.resolve();
      await Promise.all(pending);
    }
    expect(settled).toBe(30);
    expect(await reload()).toEqual([entry]);
    expect(snapshots).toEqual([[original], [entry]]);
  });

  it('rejects every caller in a failed batch, runs queued changes, and accepts future writes', async () => {
    const [first, second] = gateWrites(2);
    first.error = new Error('injected index write failure');
    const failed = Promise.allSettled([store.upsert(meta('a')), store.upsert(meta('b'))]);
    await first.entered.promise;
    const queued = Array.from({ length: 20 }, (_, i) => store.upsert({ ...meta('c'), title: `revision ${i}` }));
    first.release.resolve();
    await second.entered.promise;
    second.release.resolve();
    const failures = await failed;
    await Promise.all(queued);
    expect(failures).toEqual([
      { status: 'rejected', reason: first.error },
      { status: 'rejected', reason: first.error },
    ]);
    const recovered = [{ ...meta('c'), title: 'revision 19' }, meta('b'), meta('a')];
    expect(await reload()).toEqual(recovered);
    expect(snapshots).toEqual([recovered]);
    await store.upsert(meta('d'));
    expect(await reload()).toEqual([meta('d'), ...recovered]);
    expect(snapshots).toHaveLength(2);
  });

  it('rejects a failed follow-up without undoing the persisted generation and recovers later', async () => {
    const [first, second] = gateWrites(2);
    second.error = new Error('injected follow-up failure');
    const initial = store.upsert(meta('a'));
    await first.entered.promise;
    const failed = Promise.allSettled([store.upsert(meta('b')), store.upsert(meta('c'))]);
    first.release.resolve();
    await initial;
    await second.entered.promise;
    second.release.resolve();
    expect(await failed).toEqual([
      { status: 'rejected', reason: second.error },
      { status: 'rejected', reason: second.error },
    ]);
    expect(await reload()).toEqual([meta('a')]);
    await store.upsert(meta('d'));
    const expected = ['d', 'c', 'b', 'a'].map(meta);
    expect(await reload()).toEqual(expected);
    expect(snapshots).toEqual([[meta('a')], expected]);
  });

  it('orders remove behind an in-flight snapshot and never resurrects removed metadata', async () => {
    await store.upsert(meta('a'));
    await store.appendTranscript('a', { id: 'u', kind: 'user', ts: 1, text: 'saved' });
    snapshots.length = 0;
    const [first, second] = gateWrites(2);
    const initial = store.upsert({ ...meta('a'), title: 'before removal' });
    await first.entered.promise;
    let removed = false;
    store.hooks.onRemove = () => { removed = true; };
    const removal = store.remove('a');
    const queued = [store.upsert(meta('b')), store.upsert(meta('c'))];
    first.release.resolve();
    await initial;
    await second.entered.promise;
    try {
      expect(removed).toBe(false);
      await expect(fs.access(store.sessionDir('a'))).resolves.toBeUndefined();
      expect(await reload()).toEqual([{ ...meta('a'), title: 'before removal' }]);
    } finally {
      second.release.resolve();
      await Promise.all([removal, ...queued]);
    }
    expect(removed).toBe(true);
    await expect(fs.access(store.sessionDir('a'))).rejects.toThrow();
    expect(await reload()).toEqual([meta('c'), meta('b')]);
    expect(snapshots).toHaveLength(2);
    await store.upsert(meta('a'));
    expect(await reload()).toEqual([meta('a'), meta('c'), meta('b')]);
  });

  it('preserves last-call ordering for upsert/remove and remove/upsert in the same burst', async () => {
    const operations = [
      store.upsert(meta('removed')),
      store.remove('removed'),
      store.upsert(meta('restored')),
      store.remove('restored'),
      store.upsert({ ...meta('restored'), title: 'restored last' }),
    ];
    await Promise.all(operations);
    const expected = [{ ...meta('restored'), title: 'restored last' }];
    expect(await reload()).toEqual(expected);
    expect(snapshots).toHaveLength(1);
    expect(snapshots).toEqual([expected]);
  });

  it('keeps transcript files when the removal generation fails and supports a retry', async () => {
    await store.upsert(meta('a'));
    const item: TranscriptItem = { id: 'u', kind: 'user', ts: 1, text: 'keep until removed' };
    await store.appendTranscript('a', item);
    const [first] = gateWrites(1);
    first.error = new Error('removal write failed');
    const removal = Promise.allSettled([store.remove('a')]);
    await first.entered.promise;
    first.release.resolve();
    expect(await removal).toEqual([{ status: 'rejected', reason: first.error }]);
    expect(await reload()).toEqual([meta('a')]);
    expect(await store.readTranscript('a')).toEqual([item]);
    await store.remove('a');
    expect(await reload()).toEqual([]);
    await expect(fs.access(store.sessionDir('a'))).rejects.toThrow();
  });
});

it('overlays streamed items in persisted order with linear ID work and survives teardown/reload', async () => {
  const persisted: TranscriptItem[] = Array.from({ length: 128 }, (_, i) => ({
    id: `a_${i}`, kind: 'assistant', ts: i, text: `persisted ${i}`,
  }));
  const live: TranscriptItem[] = [
    { id: 'new_first', kind: 'assistant', ts: 200, text: 'first', streaming: true },
    ...[...persisted].reverse().map((item) => ({ ...item, text: `live ${item.id}`, streaming: true })),
    { id: 'new_last', kind: 'assistant', ts: 201, text: 'last', streaming: true },
  ];
  let context!: HarnessContext;
  vi.mocked(createAdapter).mockImplementation((_id, ctx) => {
    context = ctx;
    return {
      id: 'native', busy: false,
      start: async () => undefined,
      send: async () => {
        ctx.emit({ type: 'status', status: 'running' });
        for (const item of live) ctx.emit({ type: 'item.upsert', item });
        ctx.emit({ type: 'item.delta', id: 'a_0', textDelta: ' delta' });
      },
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setEffort: async () => undefined,
      setPermissionMode: async () => undefined,
      dispose: vi.fn(async () => undefined),
    };
  });
  const deps = {
    store,
    settings: { get: () => defaultSettings() } as SettingsStore,
    runtime: undefined as unknown as RuntimeResolver,
    analytics: {} as AnalyticsStore,
    getSecret: async () => undefined,
    pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn(),
  };
  const manager = new SessionManager(deps);
  await store.upsert(meta('s'));
  await store.rewriteTranscript('s', persisted);
  try {
    await manager.send('s', { text: 'continue' });
    const disk = await store.readTranscript('s');
    expect(disk.slice(0, persisted.length)).toEqual(persisted);
    expect(disk.at(-1)).toMatchObject({ kind: 'user', text: 'continue' });
    let idReads = 0;
    const readTranscript = store.readTranscript.bind(store);
    const readSpy = vi.spyOn(store, 'readTranscript').mockImplementation(async (id) => {
      const items = await readTranscript(id);
      return items.map((item) => ({ ...item, get id() { idReads++; return item.id; } }));
    });
    const result = await manager.transcript('s');
    readSpy.mockRestore();
    // Counts work at the real persistence boundary rather than relying on machine timing.
    expect(idReads).toBeLessThanOrEqual(8 * disk.length);
    const liveById = new Map(live.map((item) => [item.id, item]));
    const expected = [...disk.map((item) => liveById.get(item.id) ?? item), live[0], live.at(-1)!];
    expect(result).toEqual(expected);
    expect(result[0]).toMatchObject({ text: 'live a_0 delta' });
    for (const item of live) context.emit({ type: 'item.upsert', item: { ...item, streaming: false } as TranscriptItem });
    await manager.stopAll();
    await manager.flushPendingPersists();
    const restartedStore = new SessionStore(root);
    await restartedStore.load();
    const restarted = new SessionManager({ ...deps, store: restartedStore });
    expect(restarted.get('s')?.status).toBe('idle');
    expect(await restarted.transcript('s')).toEqual(expected.map((item) => item.kind === 'assistant' ? { ...item, streaming: false } : item));
    expect(deps.log.mock.calls.filter(([level]) => level === 'warn' || level === 'error')).toEqual([]);
  } finally {
    await manager.stopAll();
    await manager.flushPendingPersists();
  }
});
