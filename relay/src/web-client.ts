/** The web client core (code.vocs.io, docs/REMOTE-ACCESS.md §6): the pairing flow and the
 *  e2e Transport a browser uses to drive a paired desktop through the relay. Framework-
 *  free and DOM-free — the page (relay/public) mounts it; tests run it in Node. */
import { clientFinish, createHello, generateIdentity, importAesKey, openBlob, openFrame, publicOf, sealFrame, sign, type Identity, type PublicIdentity } from '../../src/shared/crypto';
import type { MirrorIndex, MirrorSnapshot } from '../../src/shared/mirror';
import type { RemoteDeviceInfo } from '../../src/shared/types';

/** A paired browser's stored identity: relay URL, tokens, host trust anchor, own keys. */
export interface WebCredentials {
  relayBase: string;
  webToken: string;
  webDeviceId: string;
  hostDeviceId: string;
  hostPub: PublicIdentity;
  identity: Identity;
  /** P4: the desktop's mirror key, delivered sealed over the e2e session. */
  mirrorKey?: string;
}

/** Minimal storage contract (localStorage in the browser, a Map in tests). */
export interface KvStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** The socket surface RelayClient needs (real WebSocket in the browser, stub in tests). */
export interface SimpleSocket {
  send(raw: string): void;
  close(): void;
}

const CREDS_KEY = 'vocs-web-credentials';

/** The relay base a page should talk to. The web app and the relay share one origin (the landing
 *  Worker forwards `/app`, `/v1` and `/ws` to the relay), so the default is the page's own origin;
 *  `override` is the `?relay=` escape hatch for pointing a build at another deployment. */
export function relayBaseFor(origin: string, override?: string | null): string {
  return (override?.trim() || origin).replace(/\/$/, '');
}

interface InnerFrame {
  type: 'result' | 'push' | 'mirror.key';
  id?: number;
  ok?: boolean;
  value?: unknown;
  error?: string;
  channel?: string;
  payload?: unknown;
  /** P4: the desktop's mirror key, sent once per connection inside the e2e session. */
  key?: string;
}

interface WebSession {
  key: CryptoKey;
  salt: Uint8Array;
  inSeq: number;
  inSalt?: string;
  incoming: Promise<void>;
  outgoing: Promise<void>;
}

type PollResult =
  | { status: 'pending' | 'claimed' | 'denied' }
  | { status: 'approved'; webToken: string; webDeviceId: string; hostPub: PublicIdentity; hostDeviceId: string }
  | { status: 'expired' };

export class RelayClient {
  private creds: WebCredentials | null = null;
  private socket: SimpleSocket | null = null;
  private session: WebSession | null = null;
  private nextId = 0;
  private outCounter = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly pushListeners = new Set<(channel: string, payload: unknown) => void>();
  private hsWaiter: { resolve: (reply: never) => void; reject: (e: Error) => void } | null = null;
  private mirrorCache: { secret: string; value: CryptoKey } | null = null;
  /** Sealed frames that arrive while the handshake reply is still being finished. */
  private earlyFrames: Array<{ salt: string; seq: number; ct: string }> = [];

  constructor(
    private readonly deps: {
      storage: KvStorage;
      fetchImpl?: typeof fetch;
      /** Defaults to the browser WebSocket; tests inject a stub. */
      wsFactory?: (url: string, onMessage: (raw: string) => void, onClose: () => void) => SimpleSocket;
      now?: () => number;
    }
  ) {}

  hasCredentials(): boolean {
    return !!this.deps.storage.get(CREDS_KEY);
  }

  restore(): boolean {
    const raw = this.deps.storage.get(CREDS_KEY);
    if (!raw) return false;
    try {
      this.creds = JSON.parse(raw) as WebCredentials;
      return true;
    } catch {
      this.deps.storage.remove(CREDS_KEY);
      return false;
    }
  }

  logout(): void {
    this.socket?.close();
    this.socket = null;
    this.session = null;
    this.creds = null;
    this.deps.storage.remove(CREDS_KEY);
  }

  /** Enters a pairing code, claims it with a fresh identity, polls until the desktop approves. */
  async pair(input: { relayBase: string; code: string; deviceName: string }): Promise<WebCredentials> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    const base = input.relayBase.replace(/\/$/, '');
    const code = input.code.trim().toUpperCase();
    const identity = await generateIdentity();
    const claim = await doFetch(`${base}/v1/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, webPub: publicOf(identity), name: input.deviceName })
    });
    if (!claim.ok) throw new Error(`claim failed: ${claim.status}`);
    const { pollToken } = (await claim.json()) as { pollToken?: string };
    if (typeof pollToken !== 'string' || !pollToken) throw new Error('claim did not return a poll capability');
    const now = this.deps.now ?? Date.now;
    const deadline = now() + 5 * 60_000;
    for (;;) {
      if (now() >= deadline) throw new Error('pairing timed out');
      await new Promise((r) => setTimeout(r, 1200));
      const response = await doFetch(`${base}/v1/pair/poll?code=${encodeURIComponent(code)}`, { headers: { authorization: `Bearer ${pollToken}` } });
      if (!response.ok) throw new Error(`poll failed: ${response.status}`);
      const poll = (await response.json()) as PollResult;
      if (poll.status === 'approved') {
        this.creds = { relayBase: base, webToken: poll.webToken, webDeviceId: poll.webDeviceId, hostPub: poll.hostPub, hostDeviceId: poll.hostDeviceId, identity };
        this.deps.storage.set(CREDS_KEY, JSON.stringify(this.creds));
        return this.creds;
      }
      if (poll.status === 'denied') throw new Error('pairing denied on the desktop');
      if (poll.status === 'expired') throw new Error('pairing code expired');
    }
  }

  /** Opens the relay socket and performs the e2e handshake with the paired host. */
  async connect(onClose?: () => void): Promise<void> {
    if (!this.creds) throw new Error('not paired');
    // A retry after a failed handshake opens a fresh socket; close the stale one so repeated
    // attempts cannot leak connections, and drop frames buffered for the abandoned session.
    this.socket?.close();
    this.socket = null;
    this.session = null;
    this.earlyFrames = [];
    const base = this.creds.relayBase.replace(/^http/, 'ws').replace(/\/$/, '');
    const url = `${base}/v1/ws/client?device=${encodeURIComponent(this.creds.webDeviceId)}&token=${encodeURIComponent(this.creds.webToken)}`;
    let socket: SimpleSocket;
    const handleDrop = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.session = null;
      onClose?.();
    };
    const onMessage = (raw: string) => {
      if (this.socket === socket) this.onMessage(raw);
    };
    socket = this.deps.wsFactory
      ? this.deps.wsFactory(url, onMessage, handleDrop)
      : browserSocket(url, onMessage, handleDrop);
    this.socket = socket;
    // Bind to the host, then handshake over the relay (public values only).
    this.socket.send(JSON.stringify({ t: 'hello', host: this.creds.hostDeviceId }));
    const { hello, ephPriv } = await createHello(this.creds.identity);
    this.socket.send(JSON.stringify({ t: 'hs', seq: 0, payload: hello }));
    const reply = await new Promise<never>((resolve, reject) => {
      this.hsWaiter = { resolve, reject };
      setTimeout(() => reject(new Error('handshake timed out')), 10_000);
    });
    const session = await clientFinish(hello, ephPriv, reply, this.creds.hostPub, this.creds.identity);
    if (this.socket !== socket) return;
    this.session = { key: session.key, salt: session.salt, inSeq: -1, incoming: Promise.resolve(), outgoing: Promise.resolve() };
    // The desktop hands over the mirror key right after the handshake reply, so a sealed frame can
    // arrive before the session key finished deriving; replay anything buffered.
    const early = this.earlyFrames;
    this.earlyFrames = [];
    for (const frame of early) this.queueSealed(this.session, frame);
  }

  private onMessage(raw: string): void {
    let msg: { t?: string; payload?: unknown };
    try {
      msg = JSON.parse(raw) as { t?: string; payload?: unknown };
    } catch {
      return;
    }
    if (msg.t === 'hs' && this.hsWaiter) {
      this.hsWaiter.resolve(msg.payload as never);
      this.hsWaiter = null;
      return;
    }
    if (msg.t === 'd') {
      if (!this.session) {
        // Bounded so a hostile relay cannot make the browser buffer without limit.
        if (this.earlyFrames.length < 32) this.earlyFrames.push(msg.payload as { salt: string; seq: number; ct: string });
        return;
      }
      this.queueSealed(this.session, msg.payload as { salt: string; seq: number; ct: string });
    }
  }

  private queueSealed(session: WebSession, sealed: { salt: string; seq: number; ct: string }): void {
    // A WebSocket preserves arrival order, but separate async decryptions do not.
    session.incoming = session.incoming.then(() => this.onSealed(session, sealed)).catch(() => undefined);
  }

  private async onSealed(session: WebSession, sealed: { salt: string; seq: number; ct: string }): Promise<void> {
    if (this.session !== session || !sealed || !Number.isSafeInteger(sealed.seq) || sealed.seq < 0 ||
        typeof sealed.salt !== 'string' || typeof sealed.ct !== 'string' || sealed.seq <= session.inSeq ||
        (session.inSalt !== undefined && sealed.salt !== session.inSalt)) return;
    let inner: InnerFrame;
    try {
      inner = await openFrame(session.key, sealed);
    } catch {
      return;
    }
    if (this.session !== session) return;
    session.inSeq = sealed.seq;
    session.inSalt = sealed.salt;
    if (inner.type === 'result' && typeof inner.id === 'number') {
      const entry = this.pending.get(inner.id);
      if (!entry) return;
      this.pending.delete(inner.id);
      if (inner.ok) entry.resolve(inner.value);
      else entry.reject(new Error(String(inner.error ?? 'invoke failed')));
      return;
    }
    if (inner.type === 'mirror.key' && typeof inner.key === 'string' && this.creds) {
      // The desktop hands the key over on every connect, so a browser that lost it recovers.
      this.creds.mirrorKey = inner.key;
      this.deps.storage.set(CREDS_KEY, JSON.stringify(this.creds));
      return;
    }
    if (inner.type === 'push' && inner.channel) {
      for (const l of [...this.pushListeners]) l(inner.channel!, inner.payload);
    }
  }

  onPush(listener: (channel: string, payload: unknown) => void): () => void {
    this.pushListeners.add(listener);
    return () => this.pushListeners.delete(listener);
  }

  /** E2E invoke. Approval decisions are signed inside the channel (§6.8). */
  async invoke(channel: string, request: unknown): Promise<unknown> {
    if (!this.session) throw new Error('not connected');
    const id = ++this.nextId;
    const inner: Record<string, unknown> = { type: 'invoke', id, channel, request };
    if (channel === 'approvals:respond' && this.creds) inner.sig = await sign(this.creds.identity, request);
    const session = this.session;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const send = session.outgoing.then(async () => {
        if (this.session !== session || !this.socket) throw new Error('not connected');
        const sealed = await sealFrame(session.key, session.salt, ++this.outCounter, inner);
        if (this.session !== session || !this.socket) throw new Error('not connected');
        this.socket.send(JSON.stringify({ t: 'd', seq: sealed.seq, payload: sealed }));
      });
      session.outgoing = send.catch(() => undefined);
      void send.catch((e: unknown) => {
        if (this.pending.delete(id)) reject(e);
      });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('invoke timed out'));
      }, 30_000);
    });
  }

  credentials(): WebCredentials | null {
    return this.creds;
  }

  /** Lists every device paired with the account (P4 device management), via the relay REST surface. */
  async listDevices(): Promise<RemoteDeviceInfo[]> {
    if (!this.creds) return [];
    const doFetch = this.deps.fetchImpl ?? fetch;
    const base = this.creds.relayBase.replace(/\/$/, '');
    const res = await doFetch(`${base}/v1/devices?device=${encodeURIComponent(this.creds.webDeviceId)}`, { headers: { authorization: `Bearer ${this.creds.webToken}` } });
    if (!res.ok) throw new Error(`devices failed: ${res.status}`);
    return (await res.json()) as RemoteDeviceInfo[];
  }

  /** Revokes any paired device — another browser, the desktop, or this browser itself. */
  async revokeDevice(deviceId: string): Promise<void> {
    if (!this.creds) return;
    const doFetch = this.deps.fetchImpl ?? fetch;
    const base = this.creds.relayBase.replace(/\/$/, '');
    const url = `${base}/v1/devices?device=${encodeURIComponent(this.creds.webDeviceId)}&target=${encodeURIComponent(deviceId)}`;
    const res = await doFetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${this.creds.webToken}` } });
    if (!res.ok) throw new Error(`revoke failed: ${res.status}`);
  }

  /** True once the desktop has handed over the mirror key (it does so on every connect). */
  hasMirror(): boolean {
    return !!this.creds?.mirrorKey;
  }

  /** The sealed offline session index, opened locally; null when no mirror has been uploaded. */
  async mirrorIndex(): Promise<MirrorIndex | null> {
    const key = await this.mirrorKey();
    if (!key) return null;
    const blob = await this.mirrorFetch('/v1/mirror');
    return blob ? openBlob<MirrorIndex>(key, blob) : null;
  }

  /** One session's sealed transcript snapshot, opened locally. */
  async mirrorSession(sessionId: string): Promise<MirrorSnapshot | null> {
    const key = await this.mirrorKey();
    if (!key) return null;
    const blob = await this.mirrorFetch(`/v1/mirror/${encodeURIComponent(sessionId)}`);
    return blob ? openBlob<MirrorSnapshot>(key, blob) : null;
  }

  private async mirrorKey(): Promise<CryptoKey | null> {
    if (!this.creds?.mirrorKey) return null;
    if (this.mirrorCache?.secret === this.creds.mirrorKey) return this.mirrorCache.value;
    const value = await importAesKey(this.creds.mirrorKey);
    this.mirrorCache = { secret: this.creds.mirrorKey, value };
    return value;
  }

  /** Reads an opaque mirror blob from the relay; the caller decrypts it. */
  private async mirrorFetch(path: string): Promise<{ iv: string; ct: string } | null> {
    if (!this.creds) return null;
    const doFetch = this.deps.fetchImpl ?? fetch;
    const base = this.creds.relayBase.replace(/\/$/, '');
    const query = new URLSearchParams({ host: this.creds.hostDeviceId, device: this.creds.webDeviceId });
    const res = await doFetch(`${base}${path}?${query.toString()}`, { headers: { authorization: `Bearer ${this.creds.webToken}` } });
    if (!res.ok) throw new Error(`mirror fetch failed: ${res.status}`);
    const body = (await res.json()) as { iv?: string; ct?: string } | null;
    return body && typeof body.iv === 'string' && typeof body.ct === 'string' ? { iv: body.iv, ct: body.ct } : null;
  }
}

export function browserSocket(url: string, onMessage: (raw: string) => void, onClose: () => void): SimpleSocket {
  const ws = new WebSocket(url);
  const queued: string[] = [];
  let closed = false;
  ws.addEventListener('open', () => {
    if (closed) return;
    for (const raw of queued.splice(0)) ws.send(raw);
  });
  ws.addEventListener('message', (ev) => onMessage(String((ev as MessageEvent).data)));
  ws.addEventListener('close', () => {
    closed = true;
    queued.length = 0;
    onClose();
  });
  return {
    // A browser WebSocket throws when send() is called before OPEN; connect() must be able
    // to enqueue its hello and handshake immediately, in order, without exposing a retry race.
    send: (raw) => {
      if (closed) throw new Error('socket closed');
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
      else if (ws.readyState === WebSocket.CONNECTING && queued.length < 32) queued.push(raw);
      else throw new Error('socket unavailable');
    },
    close: () => {
      closed = true;
      queued.length = 0;
      ws.close();
    }
  };
}