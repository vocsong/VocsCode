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
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

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

/** A fresh store and manager over the same directory: what the next app launch sees. */
async function restart(): Promise<SessionManager> {
  const restartedStore = new SessionStore(root);
  await restartedStore.load();
  return manager(restartedStore);
}

/** Every copy of an item on disk, in write order (the store collapses them on read). */
async function diskCopies(id: string): Promise<TranscriptItem[]> {
  await store.readTranscript('s'); // waits out the append queue
  const raw = await fs.readFile(path.join(store.sessionDir('s'), 'transcript.jsonl'), 'utf8');
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as TranscriptItem).filter((item) => item.id === id);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-stream-checkpoint-'));
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
  // Real timers first: on Windows two stores writing sessions.json retry the rename on a timer.
  vi.useRealTimers();
  for (const m of managers) {
    await m.stopAll();
    await m.flushPendingPersists();
  }
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it('recovers the partial answer of a stream that crashed mid-response, no longer streaming', async () => {
  const live = manager();
  await live.send('s', { text: 'explain' });
  context.emit({ type: 'item.delta', id: 'a1', thinkingDelta: 'weighing it' });
  context.emit({ type: 'item.delta', id: 'a1', textDelta: 'The answer is' });
  // Deltas arrived, then the stream went quiet: the timer must still save what was said.
  await vi.advanceTimersByTimeAsync(2_000);
  context.emit({ type: 'item.delta', id: 'a1', textDelta: ' forty' });
  await vi.advanceTimersByTimeAsync(2_000);
  // The process dies here: no stop, no flush, no final upsert.
  await store.readTranscript('s');

  const restarted = await restart();
  const assistant = (await restarted.transcript('s')).filter((item) => item.kind === 'assistant');
  expect(assistant).toEqual([{ id: 'a1', kind: 'assistant', ts: 1, text: 'The answer is forty', thinking: 'weighing it', streaming: false }]);
});

it('saves a partial answer as final when the session stops before any checkpoint', async () => {
  const live = manager();
  await live.send('s', { text: 'explain' });
  context.emit({ type: 'item.delta', id: 'a1', textDelta: 'Half an ans' });
  expect(await diskCopies('a1')).toEqual([]);
  const { pushEvent } = lastDeps;
  pushEvent.mockClear();

  await live.stop('s');

  const settled = { id: 'a1', kind: 'assistant', ts: 1, text: 'Half an ans', streaming: false };
  // The renderer is told the bubble stopped streaming, so its turn stops showing Working….
  expect(pushEvent).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's', event: { type: 'item.upsert', item: settled } }));
  const restarted = await restart();
  expect((await restarted.transcript('s')).filter((item) => item.kind === 'assistant')).toEqual([settled]);
});

it('bounds checkpoint writes for a long stream by interval and geometric growth', async () => {
  const live = manager();
  await live.send('s', { text: 'write a lot' });
  const chunk = 'x'.repeat(50);
  // Ten minutes of a delta every 100 ms: 6000 deltas, 300 000 characters.
  for (let i = 0; i < 6_000; i++) {
    context.emit({ type: 'item.delta', id: 'a1', textDelta: chunk });
    await vi.advanceTimersByTimeAsync(100);
  }
  const finalSize = 6_000 * chunk.length;
  const copies = await diskCopies('a1');
  // Each checkpoint needs 25% growth, so they are few and the bytes stay under 5× the answer.
  expect(copies.length).toBeGreaterThan(1);
  expect(copies.length).toBeLessThanOrEqual(40);
  expect(copies.reduce((sum, item) => sum + (item.kind === 'assistant' ? item.text.length : 0), 0)).toBeLessThan(5 * finalSize);
  expect(copies.every((item) => item.kind === 'assistant' && item.streaming)).toBe(true);

  context.emit({ type: 'item.upsert', item: { id: 'a1', kind: 'assistant', ts: 1, text: chunk.repeat(6_000), streaming: false } });
  const after = await diskCopies('a1');
  expect(after.at(-1)).toMatchObject({ streaming: false, text: chunk.repeat(6_000) });
  // A settled answer is never checkpointed again.
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await diskCopies('a1')).toHaveLength(after.length);
});

it('settles a checkpoint left streaming by an earlier run while a new run is live', async () => {
  await store.appendTranscript('s', { id: 'old', kind: 'assistant', ts: 0, text: 'cut off', streaming: true });
  const live = manager();
  await live.send('s', { text: 'next' });
  context.emit({ type: 'item.delta', id: 'a1', textDelta: 'still going' });
  const items = await live.transcript('s');
  expect(items.find((item) => item.id === 'old')).toMatchObject({ streaming: false, text: 'cut off' });
  // The live answer keeps streaming.
  expect(items.find((item) => item.id === 'a1')).toMatchObject({ streaming: true, text: 'still going' });
});

it.each([
  ['the harness exits on its own', { type: 'status', status: 'stopped' }],
  ['the harness fails fatally', { type: 'error', message: 'engine crashed', fatal: true }],
] as const)('saves the partial answer as final when %s', async (_case, event) => {
  const live = manager();
  await live.send('s', { text: 'explain' });
  context.emit({ type: 'item.delta', id: 'a1', textDelta: 'Partly there' });
  context.emit(event);
  // The flush runs in the background of the event; the store's queue orders the read after it.
  await vi.advanceTimersByTimeAsync(0);
  await store.readTranscript('s');

  const restarted = await restart();
  expect((await restarted.transcript('s')).filter((item) => item.kind === 'assistant'))
    .toEqual([{ id: 'a1', kind: 'assistant', ts: 1, text: 'Partly there', streaming: false }]);
});

it('keeps checkpointing after a failed checkpoint write and recovers the later copy', async () => {
  const live = manager();
  await live.send('s', { text: 'explain' });
  const append = store.appendTranscript.bind(store);
  let failures = 0;
  vi.spyOn(store, 'appendTranscript').mockImplementation(async (id, item) => {
    if (item.kind === 'assistant' && failures++ === 0) throw new Error('disk full');
    return append(id, item);
  });
  context.emit({ type: 'item.delta', id: 'a1', textDelta: 'first part' });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(failures).toBe(1);
  expect(lastDeps.log).toHaveBeenCalledWith('warn', expect.stringContaining('transcript append failed (assistant a1): disk full'));
  expect(await diskCopies('a1')).toEqual([]);

  context.emit({ type: 'item.delta', id: 'a1', textDelta: ', then the second part' });
  await vi.advanceTimersByTimeAsync(2_000);
  // Crash: only the checkpoint that succeeded can bring the answer back.
  const restarted = await restart();
  expect((await restarted.transcript('s')).filter((item) => item.kind === 'assistant'))
    .toEqual([{ id: 'a1', kind: 'assistant', ts: 1, text: 'first part, then the second part', streaming: false }]);
});
