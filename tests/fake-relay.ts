import http from 'node:http';
/** Shared test double: a minimal relay hub implementing the pairing + routing protocol
 *  over the REAL relay core (relay/src/core.ts). Used by remote-e2e.test.ts and
 *  web-client.test.ts. Metadata-only routing, like the real Durable Object. */
import { WebSocketServer, type WebSocket as WsLike } from 'ws';
import { claimPairing, clearMirror, deleteMirrorSession, deviceInfos, getMirrorIndex, getMirrorSession, MirrorError, PairError, pollPairing, putMirrorIndex, putMirrorSession, resolvePairing, revokeDevice, startPairing, verifyDeviceToken, type DeviceRecord, type MirrorBlob, type RelayStorage, type RelayStore } from '../relay/src/core';
import { FixedWindowLimiter } from '../relay/src/rate';
import { authorizeSocket, handleHttp, type RouteContext } from '../relay/src/routes';
import type { PublicIdentity } from '../src/shared/crypto';

export const ENROLL = 'enroll-secret';

export function memStore(): RelayStore {
  const map = new Map<string, unknown>();
  let tail = Promise.resolve();
  const adapt = (target: Map<string, unknown>): RelayStorage => ({
    get: async <T,>(k: string) => target.has(k) ? structuredClone(target.get(k)) as T : undefined,
    put: async (k, v) => void target.set(k, structuredClone(v)),
    delete: async (k) => void target.delete(k),
    list: async <T,>(prefix: string) => [...target.entries()].filter(([k]) => k.startsWith(prefix)) as Array<[string, T]>
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
  readonly sockets = new Map<WsLike, { role: 'host' | 'client'; id: string }>();
  private server: http.Server | null = null;
  private wss = new WebSocketServer({ noServer: true });
  private readonly rate = new FixedWindowLimiter();

  private context(): RouteContext {
    return { store: this.store, accountId: 'a', enrollToken: ENROLL, now: Date.now(), ip: '127.0.0.1', rate: this.rate,
      sockets: (tag) => [...this.sockets].filter(([, meta]) => tag === (meta.role === 'host' ? 'hosts' : 'clients') || tag === `${meta.role}:${meta.id}`).map(([ws]) => ws) };
  }

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
    const auth = (req.headers.authorization ?? '').replace('Bearer ', '');
    if (url.pathname === '/v1/ws/ticket') {
      const response = await handleHttp(new Request(`http://relay.test${url.pathname.slice(3)}${url.search}`, {
        method: req.method, headers: { authorization: req.headers.authorization ?? '' }
      }), this.context());
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
      return;
    }
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
      const { pollToken, hostPub } = await claimPairing(this.store, { code: parsed.code, webName: parsed.name, webPlatform: 'node-test', webPub: parsed.webPub }, Date.now());
      for (const [ws, meta] of this.sockets) if (meta.role === 'host') ws.send(JSON.stringify({ t: 'pair.request', code: parsed.code, name: parsed.name, platform: 'node-test', hostPub, webPub: parsed.webPub }));
      reply({ pollToken });
      return;
    }
    if (url.pathname === '/v1/pair/poll' && req.method === 'GET') {
      try {
        reply(await pollPairing(this.store, url.searchParams.get('code') ?? '', auth, Date.now()));
      } catch (error) {
        if (!(error instanceof PairError)) throw error;
        reply({ error: error.code }, 401);
      }
      return;
    }
    if (url.pathname === '/v1/devices' && (req.method === 'GET' || req.method === 'DELETE')) {
      // Matches the Worker: device/bearer authenticate the caller, target names the victim,
      // and only public metadata is returned.
      let caller: DeviceRecord;
      try {
        caller = await verifyDeviceToken(this.store, { accountId: 'a', deviceId: url.searchParams.get('device') ?? '', token: auth }, Date.now());
      } catch {
        reply({ error: 'invalid' }, 401);
        return;
      }
      if (req.method === 'GET') {
        reply(await deviceInfos(this.store, 'a'));
        return;
      }
      const target = url.searchParams.get('target');
      if (!target) {
        reply({ error: 'invalid' }, 400);
        return;
      }
      await revokeDevice(this.store, 'a', target);
      for (const [ws, meta] of this.sockets) if (meta.id === target) ws.close();
      reply({ ok: true });
      return;
    }
    if (url.pathname === '/v1/mirror' || url.pathname.startsWith('/v1/mirror/')) {
      // Mirror routing mirrors the Worker: device/bearer authenticate, only the desktop may
      // write, and the blobs stay opaque.
      let caller: DeviceRecord;
      try {
        caller = await verifyDeviceToken(this.store, { accountId: 'a', deviceId: url.searchParams.get('device') ?? '', token: auth }, Date.now());
      } catch {
        reply({ error: 'invalid' }, 401);
        return;
      }
      const sessionId = url.pathname.startsWith('/v1/mirror/') ? decodeURIComponent(url.pathname.slice('/v1/mirror/'.length)) : undefined;
      const hostId = url.searchParams.get('host') || caller.deviceId;
      if (req.method !== 'GET' && caller.kind !== 'host') {
        reply({ error: 'forbidden' }, 403);
        return;
      }
      try {
        if (sessionId) {
          if (req.method === 'PUT') {
            await putMirrorSession(this.store, { accountId: 'a', hostId: caller.deviceId, sessionId, blob: JSON.parse(body) as MirrorBlob }, Date.now());
            reply({ ok: true });
            return;
          }
          if (req.method === 'DELETE') {
            await deleteMirrorSession(this.store, 'a', caller.deviceId, sessionId);
            reply({ ok: true });
            return;
          }
          reply((await getMirrorSession(this.store, { accountId: 'a', hostId, sessionId }, Date.now())) ?? null);
          return;
        }
        if (req.method === 'PUT') {
          await putMirrorIndex(this.store, { accountId: 'a', hostId: caller.deviceId, blob: JSON.parse(body) as MirrorBlob }, Date.now());
          reply({ ok: true });
          return;
        }
        if (req.method === 'DELETE') {
          await clearMirror(this.store, 'a', caller.deviceId);
          reply({ ok: true });
          return;
        }
        reply((await getMirrorIndex(this.store, 'a', hostId, Date.now()))?.blob ?? null);
        return;
      } catch (e) {
        if (e instanceof MirrorError) {
          reply({ error: e.code }, e.code === 'too-large' ? 413 : 400);
          return;
        }
        throw e;
      }
    }
    reply({ error: 'not found' }, 404);
  }

  private upgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!['/v1/ws/host', '/v1/ws/client'].includes(url.pathname) || req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    const role = url.pathname === '/v1/ws/host' ? 'host' : 'client';
    void authorizeSocket(role, new Request(`http://relay.test${url.pathname.slice(3)}${url.search}`, {
      headers: req.headers.authorization ? { authorization: req.headers.authorization } : undefined
    }), this.context()).then((auth) => {
      if (!auth.ok || socket.destroyed) socket.destroy();
      else this.accept(req, socket, head, role, auth.deviceId);
    }).catch(() => socket.destroy());
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
      if (meta.role !== 'host') return;
      void (async () => {
        try {
          const result = await resolvePairing(this.store, { code: msg.code as string, decision: msg.decision as 'approve' | 'deny', signature: msg.signature as string }, Date.now());
          if ('denied' in result) {
            ws.send(JSON.stringify({ t: 'pair.result', code: msg.code, decision: msg.decision }));
            return;
          }
          ws.send(JSON.stringify({ t: 'pair.result', code: msg.code, decision: msg.decision, hostToken: result.hostToken, hostDeviceId: result.hostDeviceId, webDeviceId: result.webDeviceId, webPub: result.webPub }));
        } catch (error) {
          if (!(error instanceof PairError)) throw error;
          ws.send(JSON.stringify({ t: 'pair.error', error: 'forbidden' }));
        }
      })();
      return;
    }
    if (meta.role === 'host') {
      for (const [peer, peerMeta] of this.sockets) {
        if (peerMeta.role === 'client' && peerMeta.id === msg.to) {
          peer.send(JSON.stringify({ t: msg.t, from: meta.id, seq: msg.seq, payload: msg.payload }));
        }
      }
      return;
    }
    for (const [peer, peerMeta] of this.sockets) {
      if (peerMeta.role === 'host') peer.send(JSON.stringify({ t: msg.t, from: meta.id, seq: msg.seq, payload: msg.payload }));
    }
  }
}

