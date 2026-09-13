import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HARNESS_CLIENT_JS } from '../src/main/web-client';
import type { Transport } from '../src/shared/transport';

function client() {
  const sockets: Socket[] = [];
  class Socket {
    readyState = 0;
    sent: string[] = [];
    onopen = () => {};
    onclose = () => {};
    onmessage = (_ev: { data: string }) => {};
    constructor() { sockets.push(this); }
    send(frame: string) { this.sent.push(frame); }
    open() { this.readyState = 1; this.onopen(); }
    close() { this.readyState = 3; this.onclose(); }
  }
  const window = { location: { search: '', protocol: 'http:', host: 'localhost' }, harness: undefined as Transport | undefined };
  runInNewContext(HARNESS_CLIENT_JS, { window, WebSocket: Socket, URLSearchParams, setTimeout });
  return { api: window.harness!, sockets };
}

afterEach(() => vi.useRealTimers());

describe('local browser transport resource bounds', () => {
  it('never replays a queued mutation whose caller already received a disconnect error', async () => {
    vi.useFakeTimers();
    const { api, sockets } = client();
    const rejected = expect(api.invoke('sessions:send', { id: 's1', input: { text: 'do work' } })).rejects.toThrow('connection closed');
    sockets[0].close();
    await rejected;
    await vi.advanceTimersByTimeAsync(500);
    sockets[1].open();
    expect(sockets[1].sent).toEqual([]);
    const fresh = api.invoke('sessions:list', undefined);
    expect(sockets[1].sent).toHaveLength(1);
    const frame = JSON.parse(sockets[1].sent[0]);
    sockets[1].onmessage({ data: JSON.stringify({ type: 'result', id: frame.id, ok: true, value: [] }) });
    await expect(fresh).resolves.toEqual([]);
  });

  it('bounds outstanding requests while offline and frees capacity after failure', async () => {
    vi.useFakeTimers();
    const { api, sockets } = client();
    const pending = Array.from({ length: 256 }, () => api.invoke('sessions:list', undefined).catch((e: Error) => e.message));
    await expect(api.invoke('sessions:list', undefined)).rejects.toThrow('Too many pending');
    sockets[0].close();
    expect(await Promise.all(pending)).toEqual(Array(256).fill('harness connection closed'));
    await vi.advanceTimersByTimeAsync(500);
    sockets[1].open();
    const fresh = api.invoke('sessions:list', undefined);
    const frame = JSON.parse(sockets[1].sent[0]);
    sockets[1].onmessage({ data: JSON.stringify({ type: 'result', id: frame.id, ok: true, value: [] }) });
    await expect(fresh).resolves.toEqual([]);
  });
});
