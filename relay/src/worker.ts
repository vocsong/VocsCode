/** Vocs relay (docs/REMOTE-ACCESS.md): routes opaque e2e frames between paired desktops
 *  and web clients for one provisioned account. Routing metadata only — never keys or
 *  plaintext. One Hub Durable Object per account hosts every socket. */
import type { PublicIdentity } from '../../src/shared/crypto';
import { claimPairing, listDevices, pollPairing, resolvePairing, revokeDevice, startPairing, verifyDeviceToken, type RelayStore } from './core';

export interface Env {
  HUB: DurableObjectNamespace;
  /** The single provisioned account id (accounts-lite v1). */
  RELAY_ACCOUNT: string;
  /** Enrollment secret: the desktop must present it to request pairing codes. */
  ENROLL_TOKEN: string;
}

type DataMessage = { t: 'd' | 'hs'; seq: number; payload: unknown };
type HostIn = { t: 'pair.respond'; code: string; decision: 'approve' | 'deny' } | { t: 'd' | 'hs'; to: string; seq: number; payload: unknown };
type ClientIn = { t: 'hello'; host: string } | { t: 'd' | 'hs'; seq: number; payload: unknown };

const MAX_QUEUED = 64;

export class Hub {
  private readonly store: RelayStore;

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    this.store = {
      get: (k) => state.storage.get(k),
      put: (k, v) => state.storage.put(k, v),
      delete: async (k) => {
        await state.storage.delete(k);
      },
      list: async <T,>(prefix: string) => {
        const out: Array<[string, T]> = [];
        let cursor = await state.storage.list({ prefix, limit: 100 });
        while (true) {
          for (const [k, v] of cursor) out.push([k, v as T]);
          if (cursor.size < 100) break;
          cursor = await state.storage.list({ prefix, startAfter: [...cursor.keys()].at(-1), limit: 100 });
        }
        return out;
      }
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/pair/start') return await this.pairStart(request);
      if (request.method === 'POST' && url.pathname === '/pair/claim') return await this.pairClaim(request);
      if (request.method === 'GET' && url.pathname === '/pair/poll') return json(await pollPairing(this.store, url.searchParams.get('code') ?? '', Date.now()));
      if (request.method === 'GET' && url.pathname === '/devices') return json(listDevices(this.store, this.env.RELAY_ACCOUNT));
      if (request.method === 'DELETE' && url.pathname === '/devices') return await this.deviceRevoke(url, request);
      if (url.pathname === '/ws/host') return await this.wsConnect(request, 'host');
      if (url.pathname === '/ws/client') return await this.wsConnect(request, 'client');
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof PairingHttpError ? e.status : 500);
    }
  }

  private async pairStart(request: Request): Promise<Response> {
    if (bearer(request) !== this.env.ENROLL_TOKEN) throw new PairingHttpError('forbidden', 403);
    const body = (await request.json()) as { name?: string; platform?: string; hostPub?: PublicIdentity };
    if (!body.hostPub) throw new PairingHttpError('invalid', 400);
    const r = await startPairing(this.store, { accountId: this.env.RELAY_ACCOUNT, hostName: body.name ?? 'desktop', hostPlatform: body.platform ?? '', hostPub: body.hostPub }, Date.now());
    return json(r);
  }

  private async pairClaim(request: Request): Promise<Response> {
    const body = (await request.json()) as { code?: string; name?: string; platform?: string; webPub?: PublicIdentity };
    if (!body.code || !body.webPub) throw new PairingHttpError('invalid', 400);
    await claimPairing(this.store, { code: body.code, webName: body.name ?? 'browser', webPlatform: body.platform ?? '', webPub: body.webPub }, Date.now());
    // Ask every online desktop of the account to confirm; first responder wins.
    // ('host:enrolling' — a pre-pairing socket — matches the same prefix.)
    for (const ws of this.state.getWebSockets('host:')) {
      ws.send(JSON.stringify({ t: 'pair.request', code: body.code, name: body.name ?? 'browser', platform: body.platform ?? '' }));
    }
    return json({ ok: true });
  }

  private async deviceRevoke(url: URL, request: Request): Promise<Response> {
    await this.authDevice(request);
    const target = url.searchParams.get('device');
    if (!target) throw new PairingHttpError('invalid', 400);
    await revokeDevice(this.store, this.env.RELAY_ACCOUNT, target);
    for (const tag of [`client:${target}`, `host:${target}`]) {
      for (const ws of this.state.getWebSockets(tag)) ws.close(1008, 'device revoked');
    }
    return json({ ok: true });
  }

  private async authDevice(request: Request): Promise<{ deviceId: string }> {
    // Browsers cannot set custom WS headers, so the device token may ride in the query.
    const url = new URL(request.url);
    const token = bearer(request) || url.searchParams.get('token') || '';
    const deviceId = url.searchParams.get('device') ?? '';
    await verifyDeviceToken(this.store, { accountId: this.env.RELAY_ACCOUNT, deviceId, token }, Date.now());
    return { deviceId };
  }

  private async wsConnect(request: Request, kind: 'host' | 'client'): Promise<Response> {
    const url = new URL(request.url);
    // A freshly enabled desktop has no device token yet: it authenticates with the
    // enrollment secret and stays in pairing-only mode until pair.result mints one.
    const enrolling = kind === 'host' && url.searchParams.get('device') === 'enrolling';
    let deviceId: string;
    if (enrolling) {
      if (bearer(request) !== this.env.ENROLL_TOKEN) throw new PairingHttpError('invalid', 401);
      deviceId = 'enrolling';
    } else {
      deviceId = (await this.authDevice(request)).deviceId;
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1], [`${kind}:${deviceId}`]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** A revived (hibernated) or fresh socket: for clients, drain frames queued offline. */
  async webSocketOpen(ws: WebSocket): Promise<void> {
    const tags = this.state.getTags(ws);
    const clientId = tags.find((t) => t.startsWith('client:'))?.slice(7);
    if (!clientId) return;
    const key = `q:${clientId}`;
    const queued = await this.state.storage.get<DataMessage[]>(key);
    if (queued?.length) {
      for (const m of queued) ws.send(JSON.stringify(m));
    }
    await this.state.storage.delete(key);
    // Tell hosts this client is back.
    for (const host of this.state.getWebSockets('host:')) host.send(JSON.stringify({ t: 'client.here', client: clientId }));
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let msg: HostIn | ClientIn;
    try {
      msg = JSON.parse(message) as HostIn | ClientIn;
    } catch {
      return;
    }
    const tags = this.state.getTags(ws);
    const hostId = tags.find((t) => t.startsWith('host:'))?.slice(5);
    const clientId = tags.find((t) => t.startsWith('client:'))?.slice(7);
    if (hostId) await this.fromHost(ws, hostId, msg as HostIn);
    else if (clientId) await this.fromClient(ws, clientId, msg as ClientIn);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const tags = this.state.getTags(ws);
    const clientId = tags.find((t) => t.startsWith('client:'))?.slice(7);
    const hostId = tags.find((t) => t.startsWith('host:'))?.slice(5);
    if (clientId) for (const host of this.state.getWebSockets('host:')) host.send(JSON.stringify({ t: 'client.gone', client: clientId }));
    if (hostId) for (const client of this.state.getWebSockets('client:')) client.send(JSON.stringify({ t: 'host.gone', host: hostId }));
  }

  private async fromHost(ws: WebSocket, hostId: string, msg: HostIn): Promise<void> {
    if (msg.t === 'pair.respond') {
      const result = await resolvePairing(this.store, { code: msg.code, decision: msg.decision }, Date.now());
      if ('denied' in result) {
        ws.send(JSON.stringify({ t: 'pair.result', code: msg.code, decision: msg.decision }));
        return;
      }
      ws.send(JSON.stringify({ t: 'pair.result', code: msg.code, decision: msg.decision, hostToken: result.hostToken, hostDeviceId: result.hostDeviceId, webDeviceId: result.webDeviceId, webPub: result.webPub }));
      return;
    }
    if (!msg.to) return;
    const targets = this.state.getWebSockets(`client:${msg.to}`);
    if (targets.length) {
      const frame = JSON.stringify({ t: msg.t, from: hostId, seq: msg.seq, payload: msg.payload });
      for (const c of targets) c.send(frame);
      return;
    }
    if (msg.t === 'd') {
      // Queue data for the offline client (bounded); handshake frames are not queued.
      const key = `q:${msg.to}`;
      const q = (await this.state.storage.get<DataMessage[]>(key)) ?? [];
      q.push({ t: 'd', seq: msg.seq, payload: msg.payload });
      while (q.length > MAX_QUEUED) q.shift();
      await this.state.storage.put(key, q);
    }
    ws.send(JSON.stringify({ t: 'client.gone', client: msg.to }));
  }

  private async fromClient(ws: WebSocket, clientId: string, msg: ClientIn): Promise<void> {
    if (msg.t === 'hello') {
      ws.serializeAttachment({ host: (msg as { host: string }).host });
      return;
    }
    const host = (ws.deserializeAttachment() as { host?: string } | null)?.host;
    if (!host) return;
    const targets = this.state.getWebSockets(`host:${host}`);
    if (targets.length) {
      const frame = JSON.stringify({ t: msg.t, from: clientId, seq: msg.seq, payload: msg.payload });
      for (const h of targets) h.send(frame);
      return;
    }
    ws.send(JSON.stringify({ t: 'host.gone', host }));
  }
}

class PairingHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function bearer(request: Request): string {
  const h = request.headers.get('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/v1/')) return new Response('not found', { status: 404 });
    const stub = env.HUB.get(env.HUB.idFromName(env.RELAY_ACCOUNT));
    const inner = new URL(request.url);
    inner.pathname = url.pathname.slice(3); // strip /v1
    return stub.fetch(new Request(inner, request));
  }
} as ExportedHandler<Env>;
