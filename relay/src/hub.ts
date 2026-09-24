/** Frame routing for the relay Hub (docs/REMOTE-ACCESS.md §5–6): which socket a frame may reach,
 *  what is queued for an offline browser, and who hears about presence changes. Cloudflare-free:
 *  the Durable Object (worker.ts) and the Node test relay (tests/fake-relay.ts) drive this one
 *  implementation through a SocketRegistry, so local suites exercise the production routing rules
 *  rather than a re-implementation of them. A fake that routed a browser's frames to every desktop
 *  once hid a bug where the real Hub, which routes by the greeted host id, dropped them. */
import { PairError, resolvePairing, type DeviceRecord, type RelayStore } from './core';
import { BROADCAST_TAG } from './routes';

/** The slice of a platform socket the router uses. */
export interface HubSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
}

/** The runtime's view of connected sockets: Durable Object hibernation state in production, a
 *  Map in tests. Tag matching is exact, like Durable Object tags. */
export interface SocketRegistry<S extends HubSocket> {
  byTag(tag: string): S[];
  tags(ws: S): string[];
  /** Per-socket state that survives hibernation: the host a browser greeted. */
  attachment(ws: S): unknown;
  attach(ws: S, value: unknown): void;
  isOpen(ws: S): boolean;
}

type DataMessage = { t: 'd'; seq: number; payload: unknown };
type HostIn = { t: 'pair.respond'; code: string; decision: 'approve' | 'deny'; signature: string } | { t: 'd' | 'hs'; to: string; seq: number; payload: unknown };
type ClientIn = { t: 'hello'; host: string } | { t: 'd' | 'hs'; seq: number; payload: unknown };

export const MAX_WS_FRAME_BYTES = 1024 * 1024;
const MAX_QUEUED_CIPHERTEXT_BYTES = 64 * 1024;
const MAX_QUEUE_BYTES = 512 * 1024;
const MAX_QUEUED = 64;
const MAX_ID_LENGTH = 128;
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

export const queueKey = (clientId: string) => `q:${clientId}`;

export class HubRouter<S extends HubSocket> {
  constructor(
    private readonly deps: {
      store: RelayStore;
      accountId: string;
      sockets: SocketRegistry<S>;
      now: () => number;
    }
  ) {}

  /** A browser socket was just accepted. Hibernation has no open callback, so the queue drains
   *  here, including after an eviction. No queued ciphertext may leave for a revoked device, so
   *  existence is re-checked around the async queue read: revocation can land in between. */
  async clientOpened(ws: S, clientId: string): Promise<void> {
    if (!(await this.clientExists(clientId))) {
      ws.close(1008, 'device revoked');
      return;
    }
    const key = queueKey(clientId);
    const queued = await this.deps.store.get<DataMessage[]>(key);
    if (!(await this.clientExists(clientId))) {
      ws.close(1008, 'device revoked');
      return;
    }
    for (const m of queued ?? []) this.trySend(ws, JSON.stringify(m));
    await this.deps.store.delete(key);
    for (const host of this.deps.sockets.byTag(BROADCAST_TAG.host)) this.sendIfOpen(host, { t: 'client.here', client: clientId });
  }

  async message(ws: S, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_WS_FRAME_BYTES || utf8Bytes(message) > MAX_WS_FRAME_BYTES) return;
    let msg: HostIn | ClientIn;
    try {
      msg = JSON.parse(message) as HostIn | ClientIn;
    } catch {
      return;
    }
    // Parsed JSON is untrusted; `null` and arrays must not escape into a handler.
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return;
    const role = this.role(ws);
    if (role?.kind === 'host') await this.fromHost(ws, role.id, msg as HostIn);
    else if (role?.kind === 'client') this.fromClient(ws, role.id, msg as ClientIn);
  }

  /** Presence: tell the other side a peer left. */
  closed(ws: S): void {
    const role = this.role(ws);
    if (role?.kind === 'client') {
      for (const host of this.deps.sockets.byTag(BROADCAST_TAG.host)) this.sendIfOpen(host, { t: 'client.gone', client: role.id });
    } else if (role?.kind === 'host') {
      for (const client of this.deps.sockets.byTag(BROADCAST_TAG.client)) this.sendIfOpen(client, { t: 'host.gone', host: role.id });
    }
  }

  // --- internals ---

  private role(ws: S): { kind: 'host' | 'client'; id: string } | null {
    for (const tag of this.deps.sockets.tags(ws)) {
      if (tag.startsWith('host:')) return { kind: 'host', id: tag.slice(5) };
      if (tag.startsWith('client:')) return { kind: 'client', id: tag.slice(7) };
    }
    return null;
  }

  /** Fan-out and reply sends. The runtime throws for a socket that is closing, and one departing
   *  peer must not abort routing for the rest. */
  private sendIfOpen(ws: S, value: unknown): void {
    if (this.deps.sockets.isOpen(ws)) this.trySend(ws, JSON.stringify(value));
  }

  private trySend(ws: S, data: string): void {
    try {
      ws.send(data);
    } catch {
      // Closing; its close handler reports the departure.
    }
  }

  private async clientExists(clientId: string): Promise<boolean> {
    const device = await this.deps.store.get<DeviceRecord>(`device:${this.deps.accountId}:${clientId}`);
    return device?.kind === 'web';
  }

  private async fromHost(ws: S, hostId: string, msg: HostIn): Promise<void> {
    if (msg.t === 'pair.respond') {
      try {
        const result = await resolvePairing(this.deps.store, { code: msg.code, decision: msg.decision, signature: msg.signature }, this.deps.now());
        if ('denied' in result) {
          this.trySend(ws, JSON.stringify({ t: 'pair.result', code: msg.code, decision: msg.decision }));
          return;
        }
        // A desktop that was already enrolled keeps its device: no new host token is minted, so
        // browsers paired earlier keep routing to the same host id.
        this.trySend(ws, JSON.stringify({ t: 'pair.result', code: msg.code, decision: msg.decision, hostDeviceId: result.hostDeviceId, ...(result.hostToken ? { hostToken: result.hostToken } : {}), webDeviceId: result.webDeviceId, webPub: result.webPub }));
      } catch (error) {
        if (!(error instanceof PairError)) throw error;
        this.trySend(ws, JSON.stringify({ t: 'pair.error', code: typeof msg.code === 'string' ? msg.code : undefined, error: error.code === 'limit' ? 'device-limit' : 'forbidden' }));
      }
      return;
    }
    if ((msg.t !== 'd' && msg.t !== 'hs') || typeof msg.to !== 'string' || !msg.to || msg.to.length > MAX_ID_LENGTH ||
        !Number.isSafeInteger(msg.seq) || msg.seq < 0) return;
    const targets = this.deps.sockets.byTag(`client:${msg.to}`);
    if (targets.length) {
      const frame = JSON.stringify({ t: msg.t, from: hostId, seq: msg.seq, payload: msg.payload });
      for (const c of targets) this.trySend(c, frame);
      return;
    }
    if (msg.t === 'd') await this.enqueue(msg.to, msg.seq, msg.payload);
    this.trySend(ws, JSON.stringify({ t: 'client.gone', client: msg.to }));
  }

  /** Only sealed data for a registered browser of this account is persisted. An enrolling or
   *  paired host must not be able to manufacture unbounded q:<arbitrary-id> storage keys. */
  private async enqueue(to: string, seq: number, payload: unknown): Promise<void> {
    const sealed = payload as { salt?: unknown; seq?: unknown; ct?: unknown } | null;
    if (!sealed || typeof sealed.salt !== 'string' || sealed.salt.length > 64 ||
        typeof sealed.seq !== 'number' || !Number.isSafeInteger(sealed.seq) ||
        typeof sealed.ct !== 'string' || sealed.ct.length > MAX_QUEUED_CIPHERTEXT_BYTES) return;
    await this.deps.store.transaction(async (tx) => {
      const device = await tx.get<DeviceRecord>(`device:${this.deps.accountId}:${to}`);
      if (device?.kind !== 'web' || device.deviceId !== to) return;
      const key = queueKey(to);
      const q = (await tx.get<DataMessage[]>(key)) ?? [];
      q.push({ t: 'd', seq, payload: { salt: sealed.salt, seq: sealed.seq, ct: sealed.ct } });
      while (q.length > MAX_QUEUED || utf8Bytes(JSON.stringify(q)) > MAX_QUEUE_BYTES) q.shift();
      if (q.length) await tx.put(key, q);
    });
  }

  private fromClient(ws: S, clientId: string, msg: ClientIn): void {
    if (msg.t === 'hello') {
      if (typeof msg.host !== 'string' || !msg.host || msg.host.length > MAX_ID_LENGTH) return;
      this.deps.sockets.attach(ws, { host: msg.host });
      return;
    }
    if ((msg.t !== 'd' && msg.t !== 'hs') || !Number.isSafeInteger(msg.seq) || msg.seq < 0) return;
    const host = (this.deps.sockets.attachment(ws) as { host?: string } | null)?.host;
    if (!host || host.length > MAX_ID_LENGTH) return;
    const targets = this.deps.sockets.byTag(`host:${host}`);
    if (targets.length) {
      const frame = JSON.stringify({ t: msg.t, from: clientId, seq: msg.seq, payload: msg.payload });
      for (const h of targets) this.trySend(h, frame);
      return;
    }
    this.trySend(ws, JSON.stringify({ t: 'host.gone', host }));
  }
}
