/** Vocs relay (docs/REMOTE-ACCESS.md): routes opaque e2e frames between paired desktops
 *  and web clients for one provisioned account. Routing metadata only — never keys or
 *  plaintext. One Hub Durable Object per account hosts every socket.
 *
 *  This file is only the platform glue: the HTTP surface and its authentication live in the
 *  deny-by-default route table in ./routes, frame routing in ./hub, the entry's edge limits in
 *  ./edge and the pairing/registry logic in ./core — all Cloudflare-free and unit-tested in
 *  plain Node. What stays here is what genuinely
 *  needs the runtime: the Durable Object, its storage adapter and WebSocket hibernation. */
import type { RelayStorage, RelayStore } from './core';
import { forwardToHub } from './edge';
import { HubRouter } from './hub';
import { FixedWindowLimiter } from './rate';
import { authorizeSocket, BROADCAST_TAG, handleHttp, json, type RouteContext } from './routes';

export interface Env {
  HUB: DurableObjectNamespace;
  /** The single provisioned account id (accounts-lite v1). */
  RELAY_ACCOUNT: string;
  /** Enrollment secret: the desktop must present it to request pairing codes. */
  ENROLL_TOKEN: string;
  /** Edge rate limits (wrangler.jsonc `ratelimits`); absent from configs that predate them. */
  PAIR_LIMIT?: RateLimit;
  POLL_LIMIT?: RateLimit;
  TOKEN_LIMIT?: RateLimit;
}

export class Hub {
  private readonly store: RelayStore;
  private readonly router: HubRouter<WebSocket>;
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
    this.router = new HubRouter({
      store: this.store,
      accountId: env.RELAY_ACCOUNT,
      now: Date.now,
      sockets: {
        byTag: (tag) => state.getWebSockets(tag),
        tags: (ws) => state.getTags(ws),
        attachment: (ws) => ws.deserializeAttachment(),
        attach: (ws, value) => ws.serializeAttachment(value),
        isOpen: (ws) => ws.readyState === WebSocket.OPEN
      }
    });
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
      // Do not burn a single-use ticket for a plain GET or malformed upgrade. The Worker
      // entry point forwards the Upgrade header unchanged; only a real socket consumes it.
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      if (request.headers.get('upgrade')?.toLowerCase().trim() !== 'websocket') {
        return json({ error: 'upgrade required' }, 426, { upgrade: 'websocket' });
      }
      const kind = url.pathname === '/ws/host' ? 'host' : 'client';
      const auth = await authorizeSocket(kind, request, this.context(request));
      if (!auth.ok) return json({ error: auth.error }, auth.status);
      const pair = new WebSocketPair();
      // Targeted tag for routing to this device, plus the broadcast tag for fan-out; DO tag
      // matching is exact, so the bare tag has to be carried explicitly.
      this.state.acceptWebSocket(pair[1], [`${kind}:${auth.deviceId}`, BROADCAST_TAG[kind]]);
      // Revocation may commit after ticket consumption but before acceptance; the router
      // re-checks the device around the offline-queue drain.
      if (kind === 'client') await this.router.clientOpened(pair[1], auth.deviceId);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return handleHttp(request, this.context(request));
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.router.message(ws, message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.router.closed(ws);
    // This Worker's compatibility date predates automatic close-frame replies. 1005/1006 are
    // reported for a peer that vanished without a close frame and may never be sent back.
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => forwardToHub(request, env, () => env.HUB.get(env.HUB.idFromName(env.RELAY_ACCOUNT)))
} as ExportedHandler<Env>;
