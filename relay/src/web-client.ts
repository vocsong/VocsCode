/** The web client core (code.vocs.io, docs/REMOTE-ACCESS.md §6): the pairing flow and the
 *  e2e Transport a browser uses to drive a paired desktop through the relay. Framework-
 *  free and DOM-free — the page (relay/public) mounts it; tests run it in Node. */
import { clientFinish, createHello, generateIdentity, openFrame, publicOf, sealFrame, sign, type Identity, type PublicIdentity } from '../../src/shared/crypto';

/** A paired browser's stored identity: relay URL, tokens, host trust anchor, own keys. */
export interface WebCredentials {
  relayBase: string;
  webToken: string;
  webDeviceId: string;
  hostDeviceId: string;
  hostPub: PublicIdentity;
  identity: Identity;
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

interface InnerFrame {
  type: 'result' | 'push';
  id?: number;
  ok?: boolean;
  value?: unknown;
  error?: string;
  channel?: string;
  payload?: unknown;
}

type PollResult =
  | { status: 'pending' | 'claimed' | 'denied' }
  | { status: 'approved'; webToken: string; webDeviceId: string; hostPub: PublicIdentity; hostDeviceId: string }
  | { status: 'expired' };

export class RelayClient {
  private creds: WebCredentials | null = null;
  private socket: SimpleSocket | null = null;
  private session: { key: CryptoKey; salt: Uint8Array } | null = null;
  private nextId = 0;
  private outCounter = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly pushListeners = new Set<(channel: string, payload: unknown) => void>();
  private hsWaiter: { resolve: (reply: never) => void; reject: (e: Error) => void } | null = null;

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
    const now = this.deps.now ?? Date.now;
    const deadline = now() + 5 * 60_000;
    for (;;) {
      if (now() >= deadline) throw new Error('pairing timed out');
      await new Promise((r) => setTimeout(r, 1200));
      const poll = (await (await doFetch(`${base}/v1/pair/poll?code=${encodeURIComponent(code)}`)).json()) as PollResult;
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
    const base = this.creds.relayBase.replace(/^http/, 'ws').replace(/\/$/, '');
    const url = `${base}/v1/ws/client?device=${encodeURIComponent(this.creds.webDeviceId)}&token=${encodeURIComponent(this.creds.webToken)}`;
    const handleDrop = () => {
      this.socket = null;
      this.session = null;
      onClose?.();
    };
    this.socket = this.deps.wsFactory
      ? this.deps.wsFactory(url, (raw) => this.onMessage(raw), handleDrop)
      : browserSocket(url, (raw) => this.onMessage(raw), handleDrop);
    // Bind to the host, then handshake over the relay (public values only).
    this.socket.send(JSON.stringify({ t: 'hello', host: this.creds.hostDeviceId }));
    const { hello, ephPriv } = await createHello(this.creds.identity);
    this.socket.send(JSON.stringify({ t: 'hs', seq: 0, payload: hello }));
    const reply = await new Promise<never>((resolve, reject) => {
      this.hsWaiter = { resolve, reject };
      setTimeout(() => reject(new Error('handshake timed out')), 10_000);
    });
    const session = await clientFinish(hello, ephPriv, reply, this.creds.hostPub, this.creds.identity);
    this.session = { key: session.key, salt: session.salt };
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
    if (msg.t === 'd' && this.session) {
      void this.onSealed(this.session, msg.payload as { salt: string; seq: number; ct: string });
    }
  }

  private async onSealed(session: { key: CryptoKey }, sealed: { salt: string; seq: number; ct: string }): Promise<void> {
    let inner: InnerFrame;
    try {
      inner = await openFrame(session.key, sealed);
    } catch {
      return;
    }
    if (inner.type === 'result' && typeof inner.id === 'number') {
      const entry = this.pending.get(inner.id);
      if (!entry) return;
      this.pending.delete(inner.id);
      if (inner.ok) entry.resolve(inner.value);
      else entry.reject(new Error(String(inner.error ?? 'invoke failed')));
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
    const sealed = await sealFrame(this.session.key, this.session.salt, ++this.outCounter, inner);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket?.send(JSON.stringify({ t: 'd', seq: sealed.seq, payload: sealed }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('invoke timed out'));
      }, 30_000);
    });
  }

  credentials(): WebCredentials | null {
    return this.creds;
  }
}

function browserSocket(url: string, onMessage: (raw: string) => void, onClose: () => void): SimpleSocket {
  const ws = new WebSocket(url);
  ws.addEventListener('message', (ev) => onMessage(String((ev as MessageEvent).data)));
  ws.addEventListener('close', () => onClose());
  return {
    send: (raw) => ws.send(raw),
    close: () => ws.close()
  };
}