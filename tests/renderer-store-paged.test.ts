import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent, SessionMeta, TranscriptItem } from '../src/shared/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const assistant = (id: string, text = ''): TranscriptItem => ({ id, kind: 'assistant', ts: 1, text });
const meta = (id: string): SessionMeta => ({
  id, title: id, createdAt: 1, updatedAt: 1, cwd: '/repo', status: 'idle', harnessRef: {},
  config: { harness: 'native', permissionMode: 'ask', projectRoot: '/repo' },
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
});
const settings = { remote: { viewOnly: false } } as never;

type Page = { items: TranscriptItem[]; start: number; total: number; seq: number };

let storeModule: typeof import('../src/renderer/src/store');
let useStore: typeof import('../src/renderer/src/store').useStore;
let frames: FrameRequestCallback[];
let invoke: ReturnType<typeof vi.fn>;
let onSpy: ReturnType<typeof vi.fn>;
const page = (items: TranscriptItem[], start: number, total: number, seq: number): Page => ({ items, start, total, seq });

const emit = (sessionId: string, event: SessionEvent, seq?: number) => useStore.getState().applyEvent({ sessionId, event, ts: 1, seq });
const delta = (sessionId: string, id: string, textDelta: string, seq?: number) => emit(sessionId, { type: 'item.delta', id, textDelta }, seq);
const textOf = (id: string) => useStore.getState().transcripts[id]?.filter((i) => i.kind === 'assistant').map((i) => (i.kind === 'assistant' ? i.text : '')).join('');

function flushFrame() {
  expect(frames).toHaveLength(1);
  frames.shift()!(0);
}

beforeEach(async () => {
  vi.resetModules();
  frames = [];
  invoke = vi.fn();
  onSpy = vi.fn(() => () => undefined);
  vi.stubGlobal('window', { harness: { platform: 'win32', invoke, on: onSpy } });
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }));
  storeModule = await import('../src/renderer/src/store');
  storeModule.configureStore({ pagedTranscripts: true, probeAvailabilityOnBoot: false, openFirstSessionOnBoot: false });
  useStore = storeModule.useStore;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('paged transcript loading', () => {
  it('replays only events past the page floor, to the exact final text', async () => {
    const tail = deferred<Page>();
    invoke.mockImplementation((channel: string) => {
      if (channel === 'sessions:transcriptPage') return tail.promise;
      return Promise.reject(new Error(`unexpected ${channel}`));
    });
    const loading = useStore.getState().loadTranscript('s1');
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith('sessions:transcriptPage', { id: 's1' });

    // These land while the page is in flight, so they must be held, not applied to an empty list.
    delta('s1', 'a1', ' there', 6);
    delta('s1', 'a1', ' stale', 5);
    tail.resolve(page([assistant('a1', 'Hello')], 0, 1, 5));
    await loading;
    flushFrame();
    expect(textOf('s1')).toBe('Hello there');

    delta('s1', 'a1', '!', 7);
    flushFrame();
    expect(textOf('s1')).toBe('Hello there!');
    expect(useStore.getState().transcriptFloors.s1).toBe(5);
  });

  it('prepends earlier pages and keeps applying events against the same floor', async () => {
    const earlier = deferred<Page>();
    invoke.mockImplementation((channel: string, request: { id: string; end?: number }) => {
      if (channel === 'sessions:transcriptPage' && request.end === 2) return earlier.promise;
      if (channel === 'sessions:transcriptPage') return Promise.resolve(page([assistant('b', 'B'), assistant('c', 'C')], 2, 4, 9));
      return Promise.reject(new Error(`unexpected ${channel}`));
    });
    await useStore.getState().loadTranscript('s1');
    expect(useStore.getState().transcriptStarts.s1).toBe(2);

    const first = useStore.getState().loadEarlier('s1');
    const second = useStore.getState().loadEarlier('s1');
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(2);
    delta('s1', 'b', '!', 12);
    earlier.resolve(page([assistant('a', 'A'), assistant('a2', 'A2')], 0, 4, 11));
    await Promise.all([first, second]);
    flushFrame();
    expect(useStore.getState().transcripts.s1).toEqual([assistant('a', 'A'), assistant('a2', 'A2'), assistant('b', 'B!'), assistant('c', 'C')]);
    expect(useStore.getState().transcriptStarts.s1).toBe(0);
    expect(useStore.getState().transcriptFloors.s1).toBe(9);
  });

  it('loadEarlier is a no-op when the window already starts at the transcript head', async () => {
    invoke.mockResolvedValue(page([assistant('a', 'A')], 0, 1, 3));
    await useStore.getState().loadTranscript('s1');
    await useStore.getState().loadEarlier('s1');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('resync and reset', () => {
  it('resync re-reads settings, list and focus, then replaces the window without blanking it', async () => {
    useStore.setState({ sessions: [meta('s1')], activeId: 's1', transcripts: { s1: [assistant('old', 'old')] }, loaded: { s1: true }, transcriptFloors: { s1: 3 } });
    const fresh = deferred<Page>();
    invoke.mockImplementation((channel: string) => {
      if (channel === 'settings:get') return Promise.resolve(settings);
      if (channel === 'sessions:list') return Promise.resolve([meta('s1')]);
      if (channel === 'desktop:focus') return Promise.resolve({ sessionId: 's1', at: 4, windowFocused: true });
      if (channel === 'sessions:transcriptPage') return fresh.promise;
      return Promise.reject(new Error(`unexpected ${channel}`));
    });
    const syncing = useStore.getState().resync();
    await Promise.resolve();
    await Promise.resolve();
    // The old items stay on screen while the fresh window is in flight.
    expect(useStore.getState().transcripts.s1).toEqual([assistant('old', 'old')]);
    fresh.resolve(page([assistant('new', 'new')], 0, 1, 8));
    await syncing;
    expect(useStore.getState().transcripts.s1).toEqual([assistant('new', 'new')]);
    expect(useStore.getState().transcriptFloors.s1).toBe(8);
    expect(useStore.getState().desktopFocus).toMatchObject({ sessionId: 's1' });
  });

  it('reset discards an in-flight page from the previous host and keeps one push subscription', async () => {
    const stale = deferred<Page>();
    invoke.mockImplementation((channel: string) => {
      if (channel === 'settings:get') return Promise.resolve(settings);
      if (channel === 'sessions:list') return Promise.resolve([]);
      if (channel === 'desktop:focus') return Promise.resolve({ sessionId: null, at: 0, windowFocused: false });
      if (channel === 'terminal:list') return Promise.resolve([]);
      if (channel === 'sessions:transcriptPage') return stale.promise;
      return Promise.reject(new Error(`unexpected ${channel}`));
    });
    useStore.setState({ sessions: [meta('s1')] });
    await useStore.getState().boot();
    const subscriptions = onSpy.mock.calls.length;
    const loading = useStore.getState().loadTranscript('s1');
    await Promise.resolve();
    useStore.getState().reset();
    expect(useStore.getState().transcripts).toEqual({});
    stale.resolve(page([assistant('stale', 'stale')], 0, 1, 2));
    await loading;
    expect(useStore.getState().transcripts).toEqual({});

    await useStore.getState().boot();
    expect(onSpy).toHaveBeenCalledTimes(subscriptions);
    expect(useStore.getState().booted).toBe(true);
  });

  it('never invokes a channel the host refuses', async () => {
    const refused = new Set(['terminal:list', 'update:state', 'agent:state', 'desktop:focus']);
    (window as unknown as { harness: { can?: (channel: string) => boolean } }).harness.can = (channel: string) => !refused.has(channel);
    invoke.mockImplementation((channel: string) => {
      if (channel === 'settings:get') return Promise.resolve(settings);
      if (channel === 'sessions:list') return Promise.resolve([]);
      return Promise.reject(new Error(`refused channel invoked: ${channel}`));
    });
    await useStore.getState().boot();
    // `missions:list` is a read channel the host allows here; the refused set above is what must
    // never be invoked, so boot's call list is exactly the channels it can serve.
    expect(invoke.mock.calls.map(([channel]) => channel).sort()).toEqual(['missions:list', 'sessions:list', 'settings:get']);
    expect(useStore.getState().terminals).toEqual([]);
  });
});
