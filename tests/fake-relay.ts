import http from 'node:http';
/** Shared test double: the relay's REAL HTTP surface (relay/src/routes.ts) and REAL frame router
 *  (relay/src/hub.ts) over an in-memory store and `ws` sockets. Only the platform glue differs
 *  from the Durable Object — hibernation, and tags held in a Map — so a routing or auth rule
 *  cannot pass here while failing in production. Used by the remote and web-client suites. */
import { WebSocket, WebSocketServer, type WebSocket as WsLike } from 'ws';
import type { RelayStorage, RelayStore } from '../relay/src/core';
import { HubRouter, type SocketRegistry } from '../relay/src/hub';
import { FixedWindowLimiter } from '../relay/src/rate';
import { authorizeSocket, BROADCAST_TAG, handleHttp, type RouteContext } from '../relay/src/routes';

export const ENROLL = 'enroll-secret';
/** The account id the fake provisions, like the Worker's RELAY_ACCOUNT. */
export const ACCOUNT = 'a';

export function memStore(): RelayStore {
  const map = new Map<string, unknown>();
  let tail = Promise.resolve();
  const adapt = (target: Map<string, unknown>): RelayStorage => ({
    get: async <T,>(k: string) => target.has(k) ? structuredClone(target.get(k)) as T : undefined,
    put: async (k, v) => void target.set(k, structuredClone(v)),
    delete: async (k) => void target.delete(k),
    list: async <T,>(prefix: string) => structuredClone([...target.entries()].filter(([k]) => k.startsWith(prefix))) as Array<[string, T]>
  });
  return {
    ...adapt(map),
    transaction: async (work) => {
      // Match the DO's serialized commit, not the read/copy/write race of an unlocked map.
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        const staged = new Map(structuredClone([...map]));
        const result = await work(adapt(staged));
        map.clear();
        for (const [key, value] of staged) map.set(key, value);
        return result;
      } finally {
        release();
      }
    }
  };
}

export class FakeRelay {
  readonly store: RelayStore = memStore();
  private readonly meta = new Map<WsLike, { tags: string[]; attachment: unknown }>();
  private readonly registry: SocketRegistry<WsLike> = {
    byTag: (tag) => [...this.meta].filter(([, m]) => m.tags.includes(tag)).map(([ws]) => ws),
    tags: (ws) => this.meta.get(ws)?.tags ?? [],
    attachment: (ws) => this.meta.get(ws)?.attachment ?? null,
    attach: (ws, value) => {
      const m = this.meta.get(ws);
      if (m) m.attachment = value;
    },
    isOpen: (ws) => ws.readyState === WebSocket.OPEN
  };
  private readonly router = new HubRouter({ store: this.store, accountId: ACCOUNT, sockets: this.registry, now: Date.now });
  private server: http.Server | null = null;
  private wss = new WebSocketServer({ noServer: true });
  private readonly rate = new FixedWindowLimiter();

  /** Connected sockets by role and device id (for assertions about routing). */
  connected(): Array<{ kind: 'host' | 'client'; id: string }> {
    return [...this.meta.values()].flatMap(({ tags }) => {
      const own = tags.find((t) => t.startsWith('host:') || t.startsWith('client:'));
      if (!own) return [];
      const [kind, ...id] = own.split(':');
      return [{ kind: kind as 'host' | 'client', id: id.join(':') }];
    });
  }

  private context(): RouteContext {
    return { store: this.store, accountId: ACCOUNT, enrollToken: ENROLL, accountAuthenticated: true, now: Date.now(), ip: '127.0.0.1', rate: this.rate, sockets: (tag) => this.registry.byTag(tag) };
  }

  async start(): Promise<number> {
    const server = http.createServer((req, res) => void this.rest(req, res));
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.server = server;
    return (server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    for (const ws of this.meta.keys()) ws.terminate();
    this.server?.close();
    this.server?.closeAllConnections();
  }

  /** Every REST call goes through the Worker's own route table, minus the `/v1` prefix it strips. */
  private async rest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://relay.test');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (!url.pathname.startsWith('/v1/')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
    const method = req.method ?? 'GET';
    const response = await handleHttp(new Request(`http://relay.test${url.pathname.slice(3)}${url.search}`, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks)
    }), this.context());
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  }

  private upgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://relay.test');
    if (!['/v1/ws/host', '/v1/ws/client'].includes(url.pathname) || req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    const kind = url.pathname === '/v1/ws/host' ? 'host' : 'client';
    void authorizeSocket(kind, new Request(`http://relay.test${url.pathname.slice(3)}${url.search}`, {
      headers: req.headers.authorization ? { authorization: req.headers.authorization } : undefined
    }), this.context()).then((auth) => {
      if (socket.destroyed) return;
      if (auth.ok) {
        this.accept(req, socket, head, kind, auth.deviceId);
        return;
      }
      // Answer like the Durable Object: an HTTP error status, not a dropped connection.
      const body = JSON.stringify({ error: auth.error });
      socket.end(`HTTP/1.1 ${auth.status} Unauthorized\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
    }).catch(() => socket.destroy());
  }

  private accept(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer, kind: 'host' | 'client', id: string): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      // Like a Durable Object's WebSocket (and unlike `ws`), sending on a closing or closed socket
      // throws: a relay that closes a socket and then broadcasts to it must not reach a 500 here
      // first in production.
      const send = ws.send.bind(ws);
      ws.send = ((data: string) => {
        if (ws.readyState !== WebSocket.OPEN) throw new TypeError("Can't call WebSocket send() after close().");
        send(data);
      }) as typeof ws.send;
      this.meta.set(ws, { tags: [`${kind}:${id}`, BROADCAST_TAG[kind]], attachment: null });
      // Serialize one socket's frames like the Durable Object's per-message delivery.
      let inbox = Promise.resolve();
      ws.on('message', (data) => {
        inbox = inbox.then(() => this.router.message(ws, String(data))).catch(() => undefined);
      });
      ws.on('close', () => {
        this.router.closed(ws);
        this.meta.delete(ws);
      });
      if (kind === 'client') inbox = inbox.then(() => this.router.clientOpened(ws, id)).catch(() => undefined);
    });
  }
}
