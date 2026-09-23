import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserSocket } from '../relay/src/web-client';

class BrowserWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly sent: string[] = [];
  readyState = BrowserWebSocket.CONNECTING;
  private readonly listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const entries = this.listeners.get(type) ?? [];
    entries.push(listener);
    this.listeners.set(type, entries);
  }

  send(raw: string): void {
    if (this.readyState !== BrowserWebSocket.OPEN) throw new Error('WebSocket is still CONNECTING');
    this.sent.push(raw);
  }

  close(): void {
    this.readyState = BrowserWebSocket.CLOSED;
    this.emit('close');
  }

  open(): void {
    this.readyState = BrowserWebSocket.OPEN;
    this.emit('open');
  }

  private emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({} as Event);
  }
}

const sockets: BrowserWebSocket[] = [];
afterEach(() => {
  sockets.length = 0;
  vi.unstubAllGlobals();
});

describe('browser WebSocket transport', () => {
  it('waits for the actual OPEN event before sending the initial hello and handshake in order', () => {
    vi.stubGlobal('WebSocket', BrowserWebSocket);
    const socket = browserSocket('wss://relay.example/v1/ws/client', () => undefined, () => undefined);
    // The real browser throws on send() while CONNECTING; the page calls send immediately.
    expect(() => {
      socket.send('hello');
      socket.send('hs');
    }).not.toThrow();
    expect(sockets[0].sent).toEqual([]);
    sockets[0].open();
    expect(sockets[0].sent).toEqual(['hello', 'hs']);
    socket.send('data');
    expect(sockets[0].sent).toEqual(['hello', 'hs', 'data']);
  });

  it('drops queued frames on close instead of sending an abandoned handshake', () => {
    vi.stubGlobal('WebSocket', BrowserWebSocket);
    const socket = browserSocket('wss://relay.example/v1/ws/client', () => undefined, () => undefined);
    socket.send('hello');
    socket.close();
    // A stale open callback must not send a handshake from a discarded connection.
    sockets[0].open();
    expect(sockets[0].sent).toEqual([]);
  });
});
