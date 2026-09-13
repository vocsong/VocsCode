/** Desktop remote host (docs/REMOTE-ACCESS.md P2): an outbound, opt-in connection to the
 *  relay that lets paired web clients drive a filtered subset of the local handler
 *  registry over an e2e-encrypted session. Off by default; device credentials and the
 *  identity keys live in the secret store, never in settings or logs. */
import { WebSocket } from 'ws';
import { generateIdentity, hostAccept, openFrame, publicOf, sealFrame, verify, type Identity, type PublicIdentity } from '../../shared/crypto';
import type { RemoteDeviceInfo, RemoteState } from '../../shared/types';
import type { HandlerRegistry } from '../handlers';
import type { SecretStore } from '../secrets';
import type { Logger } from '../log';

/** Channels a paired web client may invoke (§5; terminal joins in P3.5, mutations stay local). */
export const REMOTE_CHANNELS = new Set<string>([
  'app:info',
  'settings:get',
  'harness:availability',
  'harness:models',
  'sessions:list',
  'sessions:get',
  'sessions:transcript',
  'sessions:search',
  'approvals:respond',
  'analytics:summary',
  'skills:list',
  'skills:read',
  'git:folderBranch',
  'git:summary',
  'git:diff',
  'git:branches',
  'git:branchesOverview',
  'git:worktrees',
  'git:pullRequests',
  'git:issues',
  'fs:list',
  'fs:search',
  'fs:read'
]);

interface HostCredentials {
  identity: Identity;
  relayUrl: string;
  deviceId?: string;
  deviceToken?: string;
  enrollToken?: string;
  /** Web devices paired with this host, by deviceId — the handshake trust anchors. */
  clients: Record<string, PublicIdentity>;
}

interface Session {
  key: CryptoKey;
  salt: Uint8Array;
  out: number;
  identity: PublicIdentity;
}

interface WsMessage {
  t: 'pair.request' | 'pair.result' | 'hs' | 'd' | 'client.gone';
  code?: string;
  name?: string;
  platform?: string;
  decision?: 'approve' | 'deny';
  hostToken?: string;
  hostDeviceId?: string;
  webToken?: string;
  webDeviceId?: string;
  webPub?: PublicIdentity;
  from?: string;
  to?: string;
  client?: string;
  seq?: number;
  payload?: unknown;
}

export class RemoteHost {
  private creds: HostCredentials | null = null;
  private ws: WebSocket | null = null;
  private status: RemoteState['status'] = 'off';
  private detail: string | undefined;
  private pairing: { code: string; expiresAt: number } | undefined;
  private pendingRequest: { code: string; name: string; platform: string } | undefined;
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly deps: {
      /** Lazy: the registry exists after registerIpc, which itself consumes this host. */
      registry: () => HandlerRegistry;
      secrets: { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> };
      pushState: () => void;
      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
      broadcast: (channel: string, payload: unknown) => void;
    }
  ) {}

  state(): RemoteState {
    return {
      status: this.status,
      detail: this.detail,
      pairing: this.pairing,
      pendingRequest: this.pendingRequest,
      onlineClients: [...this.sessions.keys()]
    };
  }

  async enable(relayUrl: string, enrollToken: string): Promise<void> {
    await this.disable();
    this.creds = (await this.loadCreds()) ?? { identity: await generateIdentity(), relayUrl, enrollToken, clients: {} };
    this.creds.relayUrl = relayUrl;
    if (enrollToken) this.creds.enrollToken = enrollToken;
    await this.saveCreds();
    await this.connect();
  }

  async disable(): Promise<void> {
    this.ws?.close();
    this.ws = null;
    this.sessions.clear();
    this.status = 'off';
    this.detail = undefined;
    this.pendingRequest = undefined;
    this.pairing = undefined;
    this.push();
  }

  /** Requests a pairing code (needs the account's enrollment secret). */
  async startPairing(hostName: string): Promise<{ code: string; expiresAt: number }> {
    if (!this.creds) throw new Error('remote access is not enabled');
    const res = await fetch(`${this.creds.relayUrl.replace(/\/$/, '')}/v1/pair/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.creds.enrollToken ?? ''}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: hostName, platform: `${process.platform} ${process.arch}`, hostPub: publicOf(this.creds.identity) })
    });
    if (!res.ok) throw new Error(`pair/start failed: ${res.status}`);
    const body = (await res.json()) as { code: string; expiresAt: number };
    this.pairing = { code: body.code, expiresAt: body.expiresAt };
    this.push();
    return body;
  }

  /** The human decision on a pending pairing request. */
  respondPairing(decision: 'approve' | 'deny'): void {
    if (!this.pendingRequest || !this.ws) return;
    this.ws.send(JSON.stringify({ t: 'pair.respond', code: this.pendingRequest.code, decision }));
  }

  /** Fan a local push event out to every connected web client, sealed per client. */
  async broadcastPush(channel: string, payload: unknown): Promise<void> {
    for (const [clientId, session] of this.sessions) {
      await this.sendTo(clientId, { type: 'push', channel, payload });
    }
  }

  async listDevices(): Promise<RemoteDeviceInfo[]> {
    if (!this.creds?.deviceId || !this.creds.deviceToken) return [];
    const res = await fetch(`${this.creds.relayUrl.replace(/\/$/, '')}/v1/devices`, { headers: { authorization: `Bearer ${this.creds.deviceToken}` } });
    if (!res.ok) return [];
    return (await res.json()) as RemoteDeviceInfo[];
  }

  async revokeDevice(deviceId: string): Promise<void> {
    if (!this.creds?.deviceId || !this.creds.deviceToken) return;
    await fetch(`${this.creds.relayUrl.replace(/\/$/, '')}/v1/devices?device=${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.creds.deviceToken}` }
    });
    if (this.creds.clients[deviceId]) {
      delete this.creds.clients[deviceId];
      await this.saveCreds();
    }
    this.sessions.delete(deviceId);
    this.push();
  }

  // --- internals ---

  private push(): void {
    this.deps.pushState();
  }

  private async loadCreds(): Promise<HostCredentials | null> {
    const raw = await this.deps.secrets.get('remote-host');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as HostCredentials;
    } catch {
      return null;
    }
  }

  private async saveCreds(): Promise<void> {
    if (this.creds) await this.deps.secrets.set('remote-host', JSON.stringify(this.creds));
  }

  private async connect(): Promise<void> {
    if (!this.creds) return;
    this.status = 'connecting';
    this.push();
    const auth = this.creds.deviceToken ?? this.creds.enrollToken ?? '';
    const device = this.creds.deviceId ?? 'enrolling';
    const ws = new WebSocket(`${this.creds.relayUrl.replace(/\/$/, '')}/v1/ws/host?device=${encodeURIComponent(device)}`, { headers: { authorization: `Bearer ${auth}` } });
    this.ws = ws;
    ws.on('open', () => {
      this.status = this.creds?.deviceId ? 'online' : 'connecting';
      this.push();
    });
    ws.on('message', (data) => void this.onMessage(String(data)));
    ws.on('close', () => {
      // Only the current socket's close counts: a stale socket (closed on reconnect)
      // must not clobber the new connection or wipe live sessions.
      if (this.ws !== ws) return;
      this.ws = null;
      this.sessions.clear();
      if (this.status !== 'off') {
        this.status = 'connecting';
        this.push();
        setTimeout(() => void this.connect(), 3000);
      }
    });
    ws.on('error', (e: Error) => {
      this.status = 'error';
      this.detail = e.message;
      this.push();
    });
  }

  private async onMessage(raw: string): Promise<void> {
    let msg: WsMessage;
    try {
      msg = JSON.parse(raw) as WsMessage;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'pair.request': {
        this.pendingRequest = { code: String(msg.code), name: String(msg.name ?? ''), platform: String(msg.platform ?? '') };
        this.push();
        return;
      }
      case 'pair.result': {
        this.pendingRequest = undefined;
        this.pairing = undefined;
        if (msg.decision === 'approve' && msg.hostToken && msg.hostDeviceId && msg.webDeviceId && msg.webPub && this.creds) {
          this.creds.deviceId = msg.hostDeviceId;
          this.creds.deviceToken = msg.hostToken;
          this.creds.clients[msg.webDeviceId] = msg.webPub;
          await this.saveCreds();
          // Reconnect under the real device token.
          this.ws?.close();
          await this.connect();
        }
        this.push();
        return;
      }
      case 'hs': {
        if (msg.from) await this.onHandshake(String(msg.from), msg.payload);
        return;
      }
      case 'd': {
        if (msg.from) await this.onFrame(String(msg.from), msg.seq ?? 0, msg.payload);
        return;
      }
      case 'client.gone': {
        if (msg.client) this.sessions.delete(String(msg.client));
        this.push();
        return;
      }
      default:
        return;
    }
  }

  private async onHandshake(from: string, payload: unknown): Promise<void> {
    if (!this.creds) return;
    const expected = this.creds.clients[from];
    if (!expected) return;
    try {
      const session = await hostAccept(this.creds.identity, payload as never, expected);
      this.sessions.set(from, { key: session.key, salt: session.salt, out: 0, identity: expected });
      this.ws?.send(JSON.stringify({ t: 'hs', to: from, seq: 0, payload: session.reply }));
    } catch (e) {
      this.deps.log('warn', `remote handshake failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async onFrame(from: string, seq: number, payload: unknown): Promise<void> {
    const session = this.sessions.get(from);
    if (!session || typeof seq !== 'number') return;
    let inner: { type: string; id?: number; channel?: string; request?: unknown; sig?: string };
    try {
      inner = await openFrame(session.key, payload as { salt: string; seq: number; ct: string });
    } catch {
      this.deps.log('warn', `remote: undecryptable frame from ${from} (seq ${seq})`);
      return;
    }
    if (inner.type === 'invoke' && inner.channel) {
      const allowed = REMOTE_CHANNELS.has(inner.channel);
      // Approvals are signed inside the e2e channel (§6.8): only a paired device key resolves.
      const signedOk = inner.channel !== 'approvals:respond' || (!!inner.sig && (await verify(session.identity, inner.request, inner.sig)));
      if (!allowed || !signedOk) {
        await this.sendTo(from, { type: 'result', id: inner.id, ok: false, error: 'channel not available remotely' });
        return;
      }
      try {
        const value = await this.deps.registry().invoke(inner.channel, inner.request);
        await this.sendTo(from, { type: 'result', id: inner.id, ok: true, value });
      } catch (e) {
        await this.sendTo(from, { type: 'result', id: inner.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (inner.type === 'handshake.hello') {
      // Duplicate hello (client retry): re-run the handshake to refresh the session.
      await this.onHandshake(from, inner);
    }
  }

  private async sendTo(clientId: string, inner: unknown): Promise<void> {
    const session = this.sessions.get(clientId);
    if (!session || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const sealed = await sealFrame(session.key, session.salt, session.out++, inner);
    this.ws.send(JSON.stringify({ t: 'd', to: clientId, seq: sealed.seq, payload: sealed }));
  }
}

