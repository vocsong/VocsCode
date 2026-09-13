import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent, SessionMeta, TranscriptItem } from '../src/shared/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const assistant = (id: string, text = ''): TranscriptItem => ({ id, kind: 'assistant', ts: 1, text });
const tool = (id: string, output = ''): TranscriptItem => ({ id, kind: 'tool', ts: 1, name: 'shell', status: 'running', output });
const meta = (id: string): SessionMeta => ({
  id, title: id, createdAt: 1, updatedAt: 1, cwd: '/repo', status: 'idle', harnessRef: {},
  config: { harness: 'native', permissionMode: 'ask', projectRoot: '/repo' },
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
});

let useStore: typeof import('../src/renderer/src/store').useStore;
let frames: FrameRequestCallback[];
let invoke: ReturnType<typeof vi.fn>;
const emit = (sessionId: string, event: SessionEvent) => useStore.getState().applyEvent({ sessionId, event, ts: 1 });
const delta = (sessionId: string, id: string, textDelta: string) => emit(sessionId, { type: 'item.delta', id, textDelta });
function flushFrame() {
  expect(frames).toHaveLength(1);
  frames.shift()!(0);
}

beforeEach(async () => {
  vi.resetModules();
  frames = [];
  invoke = vi.fn();
  vi.stubGlobal('window', { harness: { platform: 'win32', invoke, on: vi.fn() } });
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }));
  useStore = (await import('../src/renderer/src/store')).useStore;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('renderer streaming batches', () => {
  it('indexes history once per session and publishes one immutable, ordered update per frame', () => {
    let idReads = 0;
    const history = Array.from({ length: 1_000 }, (_, index): TranscriptItem => ({
      get id() { idReads++; return `history-${index}`; }, kind: 'assistant', ts: 1, text: 'past',
    }));
    const a = [...history, assistant('reply')];
    const b = [assistant('reply'), tool('tool', 'start:')];
    const untouched = [assistant('untouched')];
    useStore.setState({ transcripts: { a, b, untouched } });
    const notify = vi.fn();
    const unsubscribe = useStore.subscribe(notify);
    for (let i = 0; i < 100; i++) {
      delta('a', 'reply', `${i},`);
      emit('b', { type: 'item.delta', id: 'reply', textDelta: `${i};`, thinkingDelta: `think${i};` });
      emit('b', { type: 'item.delta', id: 'tool', outputDelta: `${i}|` });
      delta('a', 'missing', 'ignored');
    }
    expect(notify).not.toHaveBeenCalled();
    flushFrame();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(idReads).toBeLessThanOrEqual(history.length * 2);
    const next = useStore.getState().transcripts;
    expect(next.a.at(-1)).toEqual(assistant('reply', Array.from({ length: 100 }, (_, i) => `${i},`).join('')));
    expect(next.b[0]).toEqual({ ...assistant('reply', Array.from({ length: 100 }, (_, i) => `${i};`).join('')), thinking: Array.from({ length: 100 }, (_, i) => `think${i};`).join('') });
    expect(next.b[1]).toEqual(tool('tool', `start:${Array.from({ length: 100 }, (_, i) => `${i}|`).join('')}`));
    expect(next.a).not.toBe(a);
    expect(next.b).not.toBe(b);
    expect(next.a[0]).toBe(history[0]);
    expect(next.untouched).toBe(untouched);
    expect(a.at(-1)).toEqual(assistant('reply'));
    expect(b).toEqual([assistant('reply'), tool('tool', 'start:')]);
    delta('a', 'reply', 'next-frame');
    flushFrame();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(useStore.getState().transcripts.a.at(-1)).toEqual({ ...next.a.at(-1), text: (next.a.at(-1) as { text: string }).text + 'next-frame' });
    unsubscribe();
  });

  it('invalidates Git only for activity in the foreground workspace', () => {
    useStore.setState({ activeId: 'a', sessions: [meta('a'), { ...meta('b'), cwd: '/other' }, meta('shared')], changesVersion: 0 });
    emit('b', { type: 'item.upsert', item: { ...tool('t'), status: 'done' } as TranscriptItem });
    emit('b', { type: 'status', status: 'idle' });
    expect(useStore.getState().changesVersion).toBe(0);
    expect(useStore.getState().transcripts.b).toHaveLength(1);
    emit('shared', { type: 'status', status: 'idle' });
    expect(useStore.getState().changesVersion).toBe(1);
    emit('a', { type: 'item.upsert', item: { ...tool('t'), status: 'done' } as TranscriptItem });
    expect(useStore.getState().changesVersion).toBe(2);
  });

  it('caps sequential tool output at 30k, including exact-boundary and later-frame deltas', () => {
    useStore.setState({ transcripts: { a: [tool('overflow', 'x'.repeat(29_999)), tool('exact', 'x'.repeat(29_999))] } });
    for (const outputDelta of ['yz', 'ignored']) emit('a', { type: 'item.delta', id: 'overflow', outputDelta });
    for (const outputDelta of ['y', 'ignored']) emit('a', { type: 'item.delta', id: 'exact', outputDelta });
    flushFrame();
    const expected = [tool('overflow', `${'x'.repeat(29_999)}y\n[output truncated]`), tool('exact', `${'x'.repeat(29_999)}y`)];
    expect(useStore.getState().transcripts.a).toEqual(expected);
    emit('a', { type: 'item.delta', id: 'overflow', outputDelta: 'later' });
    emit('a', { type: 'item.delta', id: 'exact', outputDelta: 'later' });
    flushFrame();
    expect(useStore.getState().transcripts.a).toEqual(expected);
  });

  it('drops only superseded item deltas on final upsert and session deltas on snapshot', async () => {
    const response = deferred<TranscriptItem[]>();
    invoke.mockReturnValue(response.promise);
    useStore.setState({ transcripts: { a: [assistant('reply'), assistant('other')], b: [assistant('reply')] } });
    const loading = useStore.getState().loadTranscript('b');
    delta('a', 'reply', 'stale');
    delta('a', 'other', 'kept');
    delta('b', 'reply', 'already-in-snapshot');
    emit('a', { type: 'item.upsert', item: assistant('reply', 'final') });
    delta('a', 'reply', '+after-upsert');
    response.resolve([assistant('reply', 'snapshot')]);
    await loading;
    delta('b', 'reply', '+after-snapshot');
    const notify = vi.fn();
    const unsubscribe = useStore.subscribe(notify);
    flushFrame();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(useStore.getState().transcripts).toEqual({
      a: [assistant('reply', 'final+after-upsert'), assistant('other', 'kept')],
      b: [assistant('reply', 'snapshot+after-snapshot')],
    });
    delta('a', 'reply', 'stale-again');
    useStore.getState().replaceTranscript('a', [assistant('reply', 'rewritten')]);
    notify.mockClear();
    flushFrame();
    expect(useStore.getState().transcripts.a).toEqual([assistant('reply', 'rewritten')]);
    expect(notify).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('does not publish an update for missing targets', () => {
    const original = { a: [assistant('reply')] };
    useStore.setState({ transcripts: original });
    const notify = vi.fn();
    const unsubscribe = useStore.subscribe(notify);
    delta('a', 'missing', 'ignored');
    delta('deleted', 'missing', 'ignored');
    flushFrame();
    expect(useStore.getState().transcripts).toBe(original);
    expect(notify).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('renderer transcript load singleflight', () => {
  it('shares concurrent reads per session and permits independent sessions', async () => {
    const a = deferred<TranscriptItem[]>();
    const b = deferred<TranscriptItem[]>();
    invoke.mockImplementation((_channel: string, { id }: { id: string }) => id === 'a' ? a.promise : b.promise);
    const loads = [useStore.getState().loadTranscript('a'), useStore.getState().loadTranscript('a'), useStore.getState().loadTranscript('b')];
    await Promise.resolve();
    expect(invoke.mock.calls).toEqual([['sessions:transcript', { id: 'a' }], ['sessions:transcript', { id: 'b' }]]);
    const notify = vi.fn();
    const unsubscribe = useStore.subscribe(notify);
    a.resolve([assistant('a', 'loaded-a')]);
    b.resolve([assistant('b', 'loaded-b')]);
    await Promise.all(loads);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(useStore.getState().loaded).toEqual({ a: true, b: true });
    expect(useStore.getState().transcripts).toEqual({ a: [assistant('a', 'loaded-a')], b: [assistant('b', 'loaded-b')] });
    await useStore.getState().loadTranscript('a');
    expect(invoke).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('settles shared failures once, clears the error on retry, and clears successful flights', async () => {
    const failed = deferred<TranscriptItem[]>();
    const retry = deferred<TranscriptItem[]>();
    invoke.mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise).mockResolvedValueOnce([assistant('reply', 'reloaded')]);
    const loads = [useStore.getState().loadTranscript('a'), useStore.getState().loadTranscript('a')];
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);
    const notify = vi.fn();
    const unsubscribe = useStore.subscribe(notify);
    failed.reject(new Error('read failed'));
    await Promise.all(loads);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(useStore.getState().transcriptErrors).toEqual({ a: 'read failed' });
    expect(useStore.getState().loaded.a).toBeUndefined();
    const retries = [useStore.getState().loadTranscript('a'), useStore.getState().loadTranscript('a')];
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(useStore.getState().transcriptErrors).toEqual({});
    retry.resolve([assistant('reply', 'recovered')]);
    await Promise.all(retries);
    expect(useStore.getState().transcripts.a).toEqual([assistant('reply', 'recovered')]);
    expect(useStore.getState().loaded.a).toBe(true);
    useStore.setState({ loaded: {} });
    await useStore.getState().loadTranscript('a');
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(useStore.getState().transcripts.a).toEqual([assistant('reply', 'reloaded')]);
    unsubscribe();
  });

  it.each(['success', 'failure'] as const)('ignores delayed %s after deletion without cancelling another session', async (outcome) => {
    const stale = deferred<TranscriptItem[]>();
    const kept = deferred<TranscriptItem[]>();
    invoke.mockReturnValueOnce(stale.promise).mockReturnValueOnce(kept.promise);
    useStore.getState().setSessions([meta('a'), meta('b')]);
    const loads = [useStore.getState().loadTranscript('a'), useStore.getState().loadTranscript('b')];
    await Promise.resolve();
    useStore.getState().setSessions([meta('b')]);
    if (outcome === 'success') stale.resolve([assistant('stale')]);
    else stale.reject(new Error('deleted read failed'));
    kept.resolve([assistant('kept')]);
    await Promise.all(loads);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(useStore.getState().transcripts).toEqual({ b: [assistant('kept')] });
    expect(useStore.getState().loaded).toEqual({ b: true });
    expect(useStore.getState().transcriptErrors).toEqual({});
  });

  it('does not let a deleted flight overwrite or clear a replacement flight for the same id', async () => {
    const stale = deferred<TranscriptItem[]>();
    const fresh = deferred<TranscriptItem[]>();
    invoke.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    useStore.getState().setSessions([meta('a')]);
    const oldLoad = useStore.getState().loadTranscript('a');
    await Promise.resolve();
    useStore.getState().setSessions([]);
    useStore.getState().setSessions([meta('a')]);
    const newLoad = useStore.getState().loadTranscript('a');
    await Promise.resolve();
    stale.resolve([assistant('stale')]);
    await oldLoad;
    expect(useStore.getState().transcripts.a).toBeUndefined();
    const duplicate = useStore.getState().loadTranscript('a');
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(2);
    fresh.resolve([assistant('fresh')]);
    await Promise.all([newLoad, duplicate]);
    expect(useStore.getState().transcripts.a).toEqual([assistant('fresh')]);
  });
});
