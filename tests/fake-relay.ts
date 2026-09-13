import http from 'node:http';
/** Shared test double: a minimal relay hub implementing the pairing + routing protocol
 *  over the REAL relay core (relay/src/core.ts). Used by remote-e2e.test.ts and
 *  web-client.test.ts. Metadata-only routing, like the real Durable Object. */
import { WebSocketServer, type WebSocket as WsLike } from 'ws';
import { claimPairing, pollPairing, resolvePairing, startPairing, verifyDeviceToken, type RelayStore } from '../relay/src/core';
import type { PublicIdentity } from '../src/shared/crypto';

export const ENROLL = 'enroll-secret';

export function memStore(): RelayStore {
  const map = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => map.get(k) as T | undefined,
    put: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
    list: async <T,>(prefix: string) => [...map.entries()].filter(([k]) => k.startsWith(prefix)) as Array<[string, T]>
  };
}

export class FakeRelay {
  readonly store: RelayStore = memStore();
  readonly sockets = new Map<WsLike, { role: 'host' | 'client'; id: string }>();
  private server: http.Server | null = null;
  private wss = new WebSocketServer({ noServer: true });

  async start(): Promise<number> {
    const server = http.createServer((req, res) => void this.rest(req, res));
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.server = server;
    return (server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    this.server?.close();
    this.server?.closeAllConnections();
  }

  private async rest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = await new Promise<string>((r) => {
      let s = '';
      req.on('data', (c) => (s += c));
      req.on('end', () => r(s));
    });
    const reply = (v: unknown, status = 200): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    const auth = (req.headers.authorization ?? '').replace('Bearer ', '') || new URL(req.url ?? '/', 'http://x').searchParams.get('token') || '';
    if (url.pathname === '/v1/pair/start' && req.method === 'POST') {
      if (auth !== ENROLL) {
        reply({ error: 'forbidden' }, 403);
        return;
      }
      const parsed = JSON.parse(body) as { hostPub: PublicIdentity; name: string; platform: string };
      reply(await startPairing(this.store, { accountId: 'a', hostName: parsed.name, hostPlatform: parsed.platform, hostPub: parsed.hostPub }, Date.now()));
      return;
    }
    if (url.pathname === '/v1/pair/claim' && req.method === 'POST') {
      const parsed = JSON.parse(body) as { code: string; webPub: PublicIdentity; name: string };
      await claimPairing(this.store, { code: parsed.code, webName: parsed.name, webPlatform: 'node-test', webPub: parsed.webPub }, Date.now());
      for (const [ws, meta] of this.sockets) if (meta.role === 'host') ws.send(JSON.stringify({ t: 'pair.request', code: parsed.code, name: parsed.name, platform: 'node-test' }));
      reply({ ok: true });
      return;
    }
    if (url.pathname === '/v1/pair/poll' && req.method === 'GET') {
      reply(await pollPairing(this.store, url.searchParams.get('code') ?? '', Date.now()));
      return;
    }
    reply({ error: 'not found' }, 404);
  }

  private upgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://x');
    const auth = (req.headers.authorization ?? '').replace('Bearer ', '') || url.searchParams.get('token') || '';
    const fail = (): void => {
      socket.destroy();
    };
    if (url.pathname === '/v1/ws/host') {
      if (url.searchParams.get('device') === 'enrolling') {
        if (auth !== ENROLL) return fail();
        return this.accept(req, socket, head, 'host', 'enrolling');
      }
      void verifyDeviceToken(this.store, { accountId: 'a', deviceId: url.searchParams.get('device') ?? '', token: auth }, Date.now())
        .then((device) => this.accept(req, socket, head, 'host', device.deviceId))
        .catch(fail);
      return;
    }
    if (url.pathname === '/v1/ws/client') {
      void verifyDeviceToken(this.store, { accountId: 'a', deviceId: url.searchParams.get('device') ?? '', token: auth }, Date.now())
        .then((device) => this.accept(req, socket, head, 'client', device.deviceId))
        .catch(fail);
      return;
    }
    fail();
  }

  private accept(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer, role: 'host' | 'client', id: string): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.sockets.set(ws, { role, id });
      ws.on('message', (d) => this.route(ws, String(d)));
      ws.on('close', () => this.sockets.delete(ws));
    });
  }

  /** Hub routing: host frames carry `to`; client frames go to the host they greeted. */
  private route(ws: WsLike, raw: string): void {
    const meta = this.sockets.get(ws);
    if (!meta) return;
    const msg = JSON.parse(raw) as Record<string, unknown>;
    if (msg.t === 'pair.respond') {
      void (async () => {
        const result = await resolvePairing(this.store, { code: String(msg.code), decision: msg.decision as 'approve' | 'deny' }, Date.now());
        if ('denied' in result) return;
        ws.send(JSON.stringify({ t: 'pair.result', code: msg.code, decision: msg.decision, hostToken: result.hostToken, hostDeviceId: result.hostDeviceId, webDeviceId: result.webDeviceId, webPub: result.webPub }));
      })();
      return;
    }
    if (meta.role === 'host') {
      for (const [peer, peerMeta] of this.sockets) {
        if (peerMeta.role === 'client' && peerMeta.id === msg.to) peer.send(JSON.stringify({ t: msg.t, from: meta.id, seq: msg.seq, payload: msg.payload }));
      }
      return;
    }
    for (const [peer, peerMeta] of this.sockets) {
      if (peerMeta.role === 'host') peer.send(JSON.stringify({ t: msg.t, from: meta.id, seq: msg.seq, payload: msg.payload }));
    }
  }
}

