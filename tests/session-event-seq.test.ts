/** Sessions stamp a monotonic sequence on every pushed event, and a transcript snapshot reports
 *  the floor it reflects (src/main/session-manager.ts). Together they let a remote client take a
 *  snapshot mid-stream and follow with deltas without duplicating or losing text. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionStore } from '../src/main/store';
import { SessionManager } from '../src/main/session-manager';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import { createAdapter } from '../src/main/harness/registry';
import type { HarnessContext } from '../src/main/harness/types';
import { emptyUsage } from '../src/main/models/static-models';
import type { SessionEventEnvelope, SessionMeta, TranscriptItem } from '../src/shared/types';

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn() }));

let root: string;
let store: SessionStore;
let context: HarnessContext;
let managers: SessionManager[];
let lastDeps: ReturnType<typeof deps>;

function meta(id: string): SessionMeta {
  return {
    id, title: id, createdAt: 1, updatedAt: 1,
    config: { harness: 'native', permissionMode: 'ask', projectRoot: root },
    cwd: root, status: 'idle', harnessRef: {}, usage: emptyUsage(), queued: 0,
  };
}

function deps(sessionStore: SessionStore) {
  return {
    store: sessionStore,
    settings: { get: () => defaultSettings() } as SettingsStore,
    runtime: undefined as unknown as RuntimeResolver,
    analytics: { recordUserMessage: vi.fn(), touchSession: vi.fn() } as unknown as AnalyticsStore,
    getSecret: async () => undefined,
    pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn(),
  };
}

function manager(sessionStore = store): SessionManager {
  lastDeps = deps(sessionStore);
  const created = new SessionManager(lastDeps);
  managers.push(created);
  return created;
}

/** A promise the test opens when the delayed disk read should finish. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/** Hold the next transcript read open until `when` resolves. */
function delayNextRead(when: Promise<void>): void {
  const read = store.readTranscript.bind(store);
  vi.spyOn(store, 'readTranscript').mockImplementationOnce(async (id) => {
    const items = await read(id);
    await when;
    return items;
  });
}

const pushed = (): SessionEventEnvelope[] => lastDeps.pushEvent.mock.calls.map(([env]) => env as SessionEventEnvelope);
const assistantText = (items: TranscriptItem[]): string => items.filter((i) => i.kind === 'assistant').map((i) => (i.kind === 'assistant' ? i.text : '')).join('');

/** The client's replay rule, mirrored in the renderer store: upserts replace by id, deltas append. */
function replay(snapshot: TranscriptItem[], events: SessionEventEnvelope[]): TranscriptItem[] {
  const items = snapshot.map((i) => ({ ...i }));
  for (const { event } of events) {
    if (event.type === 'item.upsert') {
      const idx = items.findIndex((i) => i.id === event.item.id);
      if (idx >= 0) items[idx] = event.item;
      else items.push(event.item);
    } else if (event.type === 'item.delta') {
      const item = items.find((i) => i.id === event.id);
      if (item?.kind === 'assistant') {
        if (event.textDelta) item.text += event.textDelta;
        if (event.thinkingDelta) item.thinking = (item.thinking ?? '') + event.thinkingDelta;
      }
    }
  }
  return items;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-session-seq-'));
  store = new SessionStore(root);
  await store.load();
  await store.upsert(meta('s'));
  managers = [];
  vi.mocked(createAdapter).mockImplementation((_id, ctx) => {
    context = ctx;
    return {
      id: 'native', busy: true,
      start: async () => undefined,
      send: async () => {
        ctx.emit({ type: 'status', status: 'running' });
        ctx.emit({ type: 'item.upsert', item: { id: 'a1', kind: 'assistant', ts: 1, text: '', streaming: true } });
      },
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setEffort: async () => undefined,
      setPermissionMode: async () => undefined,
      dispose: async () => undefined,
    };
  });
});

afterEach(async () => {
  for (const m of managers) {
    await m.stopAll();
    await m.flushPendingPersists();
  }
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it('stamps a monotonic sequence on every pushed event', async () => {
  const live = manager();
  await live.send('s', { text: 'go' });
  context.emit({ type: 'item.delta', id: 'a1', textDelta: 'one' });
  context.emit({ type: 'item.delta', id: 'a1', textDelta: ' two' });

  const seqs = pushed().map((env) => env.seq);
  expect(seqs.every((seq) => typeof seq === 'number')).toBe(true);
  for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
});

it('snapshots mid-stream and replays only later events, to the exact final text', async () => {
  const live = manager();
  await live.send('s', { text: 'go' });
  context.emit({ type: 'item.delta', id: 'a1', textDelta: 'Hello' });

  // Hold the disk read open while another delta lands: the live overlay must still capture it,
  // and the floor the snapshot reports must already include it.
  const hold = gate();
  delayNextRead(hold.promise);
  const pending = live.transcriptSnapshot('s');
  context.emit({ type: 'item.delta', id: 'a1', textDelta: ', world' });
  hold.open();
  const snapshot = await pending;
  expect(assistantText(snapshot.items)).toBe('Hello, world');

  // A delta after the snapshot: replaying only events past the floor gives the final text once.
  context.emit({ type: 'item.delta', id: 'a1', textDelta: '!' });
  const newer = pushed().filter((env) => (env.seq ?? 0) > snapshot.seq);
  expect(assistantText(replay(snapshot.items, newer))).toBe('Hello, world!');
});

it('falls back to the pre-read floor when the session is replaced during the read', async () => {
  const live = manager();
  await live.send('s', { text: 'go' });
  context.emit({ type: 'item.delta', id: 'a1', textDelta: 'first run' });

  const hold = gate();
  delayNextRead(hold.promise);
  const pending = live.transcriptSnapshot('s');
  const floorBefore = Math.max(...pushed().map((env) => env.seq ?? 0));
  // The run is replaced while the read is open, so its overlay no longer vouches for the window.
  await live.stop('s');
  await live.send('s', { text: 'again' });
  hold.open();
  const snapshot = await pending;
  expect(snapshot.seq).toBe(floorBefore);
});

it('rejects an unknown session instead of snapshotting an empty transcript', async () => {
  const live = manager();
  await expect(live.transcriptSnapshot('nope')).rejects.toThrow('Session not found');
});
