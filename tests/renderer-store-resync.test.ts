import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

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
const settings = {} as never;

let useStore: typeof import('../src/renderer/src/store').useStore;
let invoke: ReturnType<typeof vi.fn>;
let onSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  invoke = vi.fn();
  onSpy = vi.fn(() => () => undefined);
  vi.stubGlobal('window', { harness: { platform: 'win32', invoke, on: onSpy } });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0));
  useStore = (await import('../src/renderer/src/store')).useStore;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('resync and reset', () => {
  it('resync re-reads settings, list and focus, then replaces the transcript without blanking it', async () => {
    useStore.setState({ sessions: [meta('s1')], activeId: 's1', transcripts: { s1: [assistant('old', 'old')] }, loaded: { s1: true } });
    const fresh = deferred<TranscriptItem[]>();
    invoke.mockImplementation((channel: string) => {
      if (channel === 'settings:get') return Promise.resolve(settings);
      if (channel === 'sessions:list') return Promise.resolve([meta('s1')]);
      if (channel === 'desktop:focus') return Promise.resolve({ sessionId: 's1', at: 4, windowFocused: true });
      if (channel === 'sessions:transcript') return fresh.promise;
      return Promise.reject(new Error(`unexpected ${channel}`));
    });
    const syncing = useStore.getState().resync();
    await Promise.resolve();
    await Promise.resolve();
    // The old items stay on screen while the fresh transcript is in flight.
    expect(useStore.getState().transcripts.s1).toEqual([assistant('old', 'old')]);
    fresh.resolve([assistant('new', 'new')]);
    await syncing;
    expect(useStore.getState().transcripts.s1).toEqual([assistant('new', 'new')]);
    expect(useStore.getState().desktopFocus).toMatchObject({ sessionId: 's1' });
  });

  it('reset discards an in-flight transcript read and keeps one push subscription', async () => {
    const stale = deferred<TranscriptItem[]>();
    invoke.mockImplementation((channel: string) => {
      if (channel === 'settings:get') return Promise.resolve(settings);
      if (channel === 'sessions:list') return Promise.resolve([]);
      if (channel === 'desktop:focus') return Promise.resolve({ sessionId: null, at: 0, windowFocused: false });
      if (channel === 'terminal:list') return Promise.resolve([]);
      if (channel === 'sessions:transcript') return stale.promise;
      return Promise.reject(new Error(`unexpected ${channel}`));
    });
    useStore.setState({ sessions: [meta('s1')] });
    await useStore.getState().boot();
    const subscriptions = onSpy.mock.calls.length;
    const loading = useStore.getState().loadTranscript('s1');
    await Promise.resolve();
    useStore.getState().reset();
    expect(useStore.getState().transcripts).toEqual({});
    stale.resolve([assistant('stale', 'stale')]);
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
    // The refused set above is what must never be invoked, so boot's call list is exactly the
    // channels it can serve.
    expect(invoke.mock.calls.map(([channel]) => channel).sort()).toEqual(['sessions:list', 'settings:get']);
    expect(useStore.getState().terminals).toEqual([]);
  });
});
