/** Vocs relay (docs/REMOTE-ACCESS.md): routes opaque e2e frames between paired desktops
 *  and web clients for one provisioned account. Routing metadata only — never keys or
 *  plaintext. One Hub Durable Object per account hosts every socket.
 *
 *  This file is only the platform glue: the HTTP surface and its authentication live in the
 *  deny-by-default route table in ./routes, and the pairing/registry logic in ./core — both
 *  Cloudflare-free and unit-tested in plain Node. What stays here is what genuinely needs the
 *  runtime: the Durable Object, its storage adapter, WebSocket hibernation and frame routing. */
import { PairError, resolvePairing, type DeviceRecord, type RelayStorage, type RelayStore } from './core';
import { FixedWindowLimiter } from './rate';
import { authorizeSocket, BROADCAST_TAG, handleHttp, json, type RouteContext } from './routes';

export interface Env {
  HUB: DurableObjectNamespace;
  /** The single provisioned account id (accounts-lite v1). */
  RELAY_ACCOUNT: string;
  /** Enrollment secret: the desktop must present it to request pairing codes. */
  ENROLL_TOKEN: string;
}

type DataMessage = { t: 'd' | 'hs'; seq: number; payload: unknown };
type HostIn = { t: 'pair.respond'; code: string; decision: 'approve' | 'deny'; signature: string } | { t: 'd' | 'hs'; to: string; seq: number; payload: unknown };
type ClientIn = { t: 'hello'; host: string } | { t: 'd' | 'hs'; seq: number; payload: unknown };

const MAX_WS_FRAME_BYTES = 1024 * 1024;
const MAX_QUEUED_CIPHERTEXT_BYTES = 64 * 1024;
const MAX_QUEUE_BYTES = 512 * 1024;
const MAX_QUEUED = 64;
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

export class Hub {
  private readonly store: RelayStore;
  /** Per-isolate counters: cheap abuse control that never becomes a storage write. */
  private readonly rate = new FixedWindowLimiter();

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    const adapt = (storage: DurableObjectStorage | DurableObjectTransaction): RelayStorage => ({
      get: (k) => storage.get(k),
      put: (k, v) => storage.put(k, v),
      delete: async (k) => {
        await storage.delete(k);
      },
      list: async <T,>(prefix: string) => {
        const out: Array<[string, T]> = [];
        let cursor = await storage.list({ prefix, limit: 100 });
        while (true) {
          for (const [k, v] of cursor) out.push([k, v as T]);
          if (cursor.size < 100) break;
          cursor = await storage.list({ prefix, startAfter: [...cursor.keys()].at(-1), limit: 100 });
        }
        return out;
      }
    });
    this.store = { ...adapt(state.storage), transaction: (work) => state.storage.transaction((tx) => work(adapt(tx))) };
  }

  private context(request: Request): RouteContext {
    return {
      store: this.store,
      accountId: this.env.RELAY_ACCOUNT,
      enrollToken: this.env.ENROLL_TOKEN,
      now: Date.now(),
      ip: request.headers.get('cf-connecting-ip'),
      rate: this.rate,
      sockets: (tag) => this.state.getWebSockets(tag)
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws/host' || url.pathname === '/ws/client') {
      const kind = url.pathname === '/ws/host' ? 'host' : 'client';
      const auth = await authorizeSocket(kind, request, this.context(request));
      if (!auth.ok) return json({ error: auth.error }, auth.status);
      const pair = new WebSocketPair();
      // Targeted tag for routing to this device, plus the broadcast tag for fan-out; DO tag
      // matching is exact, so the bare tag has to be carried explicitly.
      this.state.acceptWebSocket(pair[1], [`${kind}:${auth.deviceId}`, BROADCAST_TAG[kind]]);
      // The hibernation API has message/close callbacks but no webSocketOpen callback.
      // Drain the offline queue at upgrade time, including after a previous eviction.
      if (kind === 'client') await this.webSocketOpen(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return handleHttp(request, this.context(request));
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
    for (const host of this.state.getWebSockets(BROADCAST_TAG.host)) host.send(JSON.stringify({ t: 'client.here', client: clientId }));
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_WS_FRAME_BYTES || utf8Bytes(message) > MAX_WS_FRAME_BYTES) return;
    let msg: HostIn | ClientIn;
    try {
      msg = JSON.parse(message) as HostIn | ClientIn;
    } catch {
      return;
    }
    // Parsed JSON is untrusted; `null` and arrays must not escape into an event handler.
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return;
    const tags = this.state.getTags(ws);
    const hostId = tags.find((t) => t.startsWith('host:'))?.slice(5);
    const clientId = tags.find((t) => t.startsWith('client:'))?.slice(7);
    if (hostId) await this.fromHost(ws, hostId, msg as HostIn);
    else if (clientId) await this.fromClient(ws, clientId, msg as ClientIn);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const tags = this.state.getTags(ws);
    const clientId = tags.find((t) => t.startsWith('client:'))?.slice(7);
    const hostId = tags.find((t) => t.startsWith('host:'))?.slice(5);
    if (clientId) for (const host of this.state.getWebSockets(BROADCAST_TAG.host)) host.send(JSON.stringify({ t: 'client.gone', client: clientId }));
    if (hostId) for (const client of this.state.getWebSockets(BROADCAST_TAG.client)) client.send(JSON.stringify({ t: 'host.gone', host: hostId }));
    // This Worker's compatibility date predates automatic close-frame replies.
    ws.close(code, reason);
  }

  private async fromHost(ws: WebSocket, hostId: string, msg: HostIn): Promise<void> {
    if (msg.t === 'pair.respond') {
      try {
        const result = await resolvePairing(this.store, { code: msg.code, decision: msg.decision, signature: msg.signature }, Date.now());
        if ('denied' in result) {
          ws.send(JSON.stringify({ t: 'pair.result', code: msg.code, decision: msg.decision }));
          return;
        }
        ws.send(JSON.stringify({ t: 'pair.result', code: msg.code, decision: msg.decision, hostToken: result.hostToken, hostDeviceId: result.hostDeviceId, webDeviceId: result.webDeviceId, webPub: result.webPub }));
      } catch (error) {
        if (!(error instanceof PairError)) throw error;
        ws.send(JSON.stringify({ t: 'pair.error', error: 'forbidden' }));
      }
      return;
    }
    if ((msg.t !== 'd' && msg.t !== 'hs') || typeof msg.to !== 'string' || !msg.to || msg.to.length > 128 ||
        !Number.isSafeInteger(msg.seq) || msg.seq < 0) return;
    const targets = this.state.getWebSockets(`client:${msg.to}`);
    if (targets.length) {
      const frame = JSON.stringify({ t: msg.t, from: hostId, seq: msg.seq, payload: msg.payload });
      for (const c of targets) c.send(frame);
      return;
    }
    if (msg.t === 'd') {
      // Only persist sealed data for a registered browser in this account. An enrolling or
      // paired host must not be able to manufacture unbounded q:<arbitrary-id> storage keys.
      const sealed = msg.payload as { salt?: unknown; seq?: unknown; ct?: unknown } | null;
      if (sealed && typeof sealed.salt === 'string' && sealed.salt.length <= 64 &&
          typeof sealed.seq === 'number' && Number.isSafeInteger(sealed.seq) &&
          typeof sealed.ct === 'string' && sealed.ct.length <= MAX_QUEUED_CIPHERTEXT_BYTES) {
        const device = await this.store.get<DeviceRecord>(`device:${this.env.RELAY_ACCOUNT}:${msg.to}`);
        if (device?.kind === 'web' && device.deviceId === msg.to) {
          const key = `q:${msg.to}`;
          const q = (await this.state.storage.get<DataMessage[]>(key)) ?? [];
          q.push({ t: 'd', seq: msg.seq, payload: { salt: sealed.salt, seq: sealed.seq, ct: sealed.ct } });
          while (q.length > MAX_QUEUED || utf8Bytes(JSON.stringify(q)) > MAX_QUEUE_BYTES) q.shift();
          if (q.length) await this.state.storage.put(key, q);
        }
      }
    }
    ws.send(JSON.stringify({ t: 'client.gone', client: msg.to }));
  }

  private async fromClient(ws: WebSocket, clientId: string, msg: ClientIn): Promise<void> {
    if (msg.t === 'hello') {
      if (typeof msg.host !== 'string' || !msg.host || msg.host.length > 128) return;
      ws.serializeAttachment({ host: msg.host });
      return;
    }
    if ((msg.t !== 'd' && msg.t !== 'hs') || !Number.isSafeInteger(msg.seq) || msg.seq < 0) return;
    const host = (ws.deserializeAttachment() as { host?: string } | null)?.host;
    if (!host || host.length > 128) return;
    const targets = this.state.getWebSockets(`host:${host}`);
    if (targets.length) {
      const frame = JSON.stringify({ t: msg.t, from: clientId, seq: msg.seq, payload: msg.payload });
      for (const h of targets) h.send(frame);
      return;
    }
    ws.send(JSON.stringify({ t: 'host.gone', host }));
  }
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
