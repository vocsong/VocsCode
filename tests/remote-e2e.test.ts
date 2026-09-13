/** Integration test for P2 (docs/REMOTE-ACCESS.md): the real RemoteHost against a fake
 *  relay implementing the hub protocol with the real relay core, driven by a fake web
 *  client. Full loop: enable → pair/start → claim → desktop approve → handshake →
 *  filtered invoke over e2e → push fan-out → disallowed channel refused. */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer, type WebSocket as WsLike } from 'ws';
import { RemoteHost } from '../src/main/remote/host';
import { claimPairing, pollPairing, resolvePairing, startPairing, verifyDeviceToken, type RelayStore } from '../relay/src/core';
import { clientFinish, createHello, generateIdentity, openFrame, publicOf, sealFrame, type PublicIdentity } from '../src/shared/crypto';
import type { HandlerRegistry } from '../src/main/handlers';

const ENROLL = 'enroll-secret';

function memStore(): RelayStore {
  const map = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => map.get(k) as T | undefined,
    put: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
    list: async <T,>(prefix: string) => [...map.entries()].filter(([k]) => k.startsWith(prefix)) as Array<[string, T]>
  };
}

/** Minimal hub over the real core: REST pairing + WS routing, metadata only. */
class FakeRelay {
  readonly store: RelayStore = memStore();
  private sockets = new Map<WsLike, { role: 'host' | 'client'; id: string }>();
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
    const reply = (v: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    const auth = (req.headers.authorization ?? '').replace('Bearer ', '');
    if (url.pathname === '/v1/pair/start' && req.method === 'POST') {
      if (auth !== ENROLL) return reply({ error: 'forbidden' }, 403);
      const parsed = JSON.parse(body) as { hostPub: PublicIdentity; name: string; platform: string };
      return reply(await startPairing(this.store, { accountId: 'a', hostName: parsed.name, hostPlatform: parsed.platform, hostPub: parsed.hostPub }, Date.now()));
    }
    if (url.pathname === '/v1/pair/claim' && req.method === 'POST') {
      const parsed = JSON.parse(body) as { code: string; webPub: PublicIdentity; name: string };
      await claimPairing(this.store, { code: parsed.code, webName: parsed.name, webPlatform: 'node-test', webPub: parsed.webPub }, Date.now());
      for (const [ws, meta] of this.sockets) if (meta.role === 'host') ws.send(JSON.stringify({ t: 'pair.request', code: parsed.code, name: parsed.name, platform: 'node-test' }));
      return reply({ ok: true });
    }
    if (url.pathname === '/v1/pair/poll' && req.method === 'GET') {
      return reply(await pollPairing(this.store, url.searchParams.get('code') ?? '', Date.now()));
    }
    reply({ error: 'not found' }, 404);
  }

  private upgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://x');
    const auth = (req.headers.authorization ?? '').replace('Bearer ', '');
    const fail = (): void => { socket.destroy(); };
    if (url.pathname === '/v1/ws/host') {
      if (url.searchParams.get('device') === 'enrolling') {
        if (auth !== ENROLL) return fail();
        return this.accept(socket, head, 'host', 'enrolling', req);
      }
      void verifyDeviceToken(this.store, { accountId: 'a', deviceId: url.searchParams.get('device') ?? '', token: auth }, Date.now())
        .then((device) => this.accept(socket, head, 'host', device.deviceId, req))
        .catch(fail);
      return;
    }
    if (url.pathname === '/v1/ws/client') {
      void verifyDeviceToken(this.store, { accountId: 'a', deviceId: url.searchParams.get('device') ?? '', token: auth }, Date.now())
        .then((device) => this.accept(socket, head, 'client', device.deviceId, req))
        .catch(fail);
      return;
    }
    fail();
  }

  private accept(socket: import('node:stream').Duplex, head: Buffer, role: 'host' | 'client', id: string, req: http.IncomingMessage): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.sockets.set(ws, { role, id });
      ws.on('message', (data) => this.route(ws, String(data)));
      ws.on('close', () => this.sockets.delete(ws));
    });
  }

  /** Hub routing: host frames carry `to`; client frames go to their bound host. */
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
      // host → client: deliver to the addressed web device.
      for (const [peer, peerMeta] of this.sockets) {
        if (peerMeta.role === 'client' && peerMeta.id === msg.to) peer.send(JSON.stringify({ t: msg.t, from: meta.id, seq: msg.seq, payload: msg.payload }));
      }
      return;
    }
    // client → host: deliver to the host the client greeted.
    for (const [peer, peerMeta] of this.sockets) {
      if (peerMeta.role === 'host') peer.send(JSON.stringify({ t: msg.t, from: meta.id, seq: msg.seq, payload: msg.payload }));
    }
  }
}

function waitFrame(ws: WsLike, match: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const on = (data: unknown): void => {
      const m = JSON.parse(String(data)) as Record<string, unknown>;
      if (match(m)) {
        ws.off('message', on);
        resolve(m);
      }
    };
    ws.on('message', on);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('remote host end-to-end (fake relay, real core)', () => {
  let relay: FakeRelay;
  let port = 0;

  beforeAll(async () => {
    relay = new FakeRelay();
    port = await relay.start();
  });

  afterAll(async () => {
    await relay.stop();
  });

  it('pairs, handshakes, serves filtered invokes and pushes over e2e', async () => {
    const calls: string[] = [];
    const registry = {
      channels: () => ['sessions:list', 'secrets:has'],
      invoke: async (channel: string) => {
        calls.push(channel);
        if (channel === 'sessions:list') return [{ id: 's1', title: 'T' }];
        if (channel === 'secrets:has') return 'LEAK';
        throw new Error('unknown');
      }
    } as unknown as HandlerRegistry;
    const host = new RemoteHost({
      registry,
      secrets: { get: async () => undefined, set: async () => undefined },
      pushState: () => undefined,
      log: () => undefined,
      broadcast: () => undefined
    });

    // Desktop: enable with the enrollment secret, request a pairing code.
    await host.enable(`http://127.0.0.1:${port}`, ENROLL);
    const { code } = await host.startPairing('Test PC');
    expect(code).toMatch(/^[A-Z2-9]{8}$/);

    // Web client claims the code with its identity key.
    const web = await generateIdentity();
    const claim = await fetch(`http://127.0.0.1:${port}/v1/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, webPub: publicOf(web), name: 'Test Browser' })
    });
    expect(claim.status).toBe(200);

    // The desktop (enrolling socket) sees the request; the human approves.
    for (let i = 0; i < 40 && !host.state().pendingRequest; i++) await sleep(100);
    host.respondPairing('approve');

    // The web client polls until approved, learning its token and the host identity.
    let approved: Extract<Awaited<ReturnType<typeof pollPairing>>, { status: 'approved' }> | null = null;
    for (let i = 0; i < 40 && !approved; i++) {
      const poll = (await (await fetch(`http://127.0.0.1:${port}/v1/pair/poll?code=${code}`)).json()) as Awaited<ReturnType<typeof pollPairing>>;
      if (poll.status === 'approved') approved = poll;
      else await sleep(100);
    }
    expect(approved).not.toBeNull();
    expect(approved!.webToken).toBeTruthy();
    expect(approved!.hostPub.sig).toBeDefined();

    // The host reconnected under its new device token; open the web data socket.
    await sleep(300);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws/client?device=${encodeURIComponent(approved!.webDeviceId)}&x=1`, { headers: { authorization: `Bearer ${approved!.webToken}` } } as never);
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'hello', host: approved!.hostDeviceId }));

    // Handshake over the relay (public values only), then sealed traffic.
    const { hello, ephPriv } = await createHello(web);
    ws.send(JSON.stringify({ t: 'hs', seq: 0, payload: hello }));
    const hsReply = await waitFrame(ws, (m) => m.t === 'hs');
    const session = await clientFinish(hello, ephPriv, hsReply.payload as never, approved!.hostPub, web);
    expect(session.key).toBeDefined();

    const send = async (inner: unknown) => {
      const sealed = await sealFrame(session.key, session.salt, sealedSeq(), inner);
      ws.send(JSON.stringify({ t: 'd', seq: sealed.seq, payload: sealed }));
    };

    // Allowed channel: an e2e invoke reaches the real registry.
    send({ type: 'invoke', id: 1, channel: 'sessions:list', request: null });
    const result1 = await openFrame<{ type: string; id: number; ok: boolean; value: unknown }>(session.key, ((await waitFrame(ws, (m) => m.t === 'd')) as { payload: never }).payload);
    expect(result1.ok).toBe(true);
    expect(result1.value).toEqual([{ id: 's1', title: 'T' }]);
    expect(calls).toEqual(['sessions:list']);

    // Disallowed channel: refused before the registry is ever consulted.
    send({ type: 'invoke', id: 2, channel: 'secrets:has', request: { providerId: 'anthropic' } });
    const result2 = await openFrame<{ ok: boolean; error?: string }>(session.key, ((await waitFrame(ws, (m) => m.t === 'd')) as { payload: never }).payload);
    expect(result2.ok).toBe(false);
    expect(calls).toEqual(['sessions:list']); // no leak call reached the registry

    // Local pushes fan out sealed.
    await host.broadcastPush('push:settingsChanged', { notifications: false });
    const push = await openFrame<{ type: string; channel: string; payload: unknown }>(session.key, ((await waitFrame(ws, (m) => m.t === 'd')) as { payload: never }).payload);
    expect(push).toEqual({ type: 'push', channel: 'push:settingsChanged', payload: { notifications: false } });

    ws.close();
    await host.disable();
  });
});

let sealedCounter = 0;
function sealedSeq(): number {
  return ++sealedCounter;
}