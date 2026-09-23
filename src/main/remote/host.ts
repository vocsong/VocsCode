/** Desktop remote host (docs/REMOTE-ACCESS.md P2): an outbound, opt-in connection to the
 *  relay that lets paired web clients drive a filtered subset of the local handler
 *  registry over an e2e-encrypted session. Off by default; device credentials and the
 *  identity keys live in the secret store, never in settings or logs. */
import { WebSocket } from 'ws';
import { generateIdentity, hostAccept, openFrame, pairingDecisionPayload, publicOf, randomKeyB64, sealFrame, sign, stable, verify, type Identity, type PublicIdentity, type SealedBlob } from '../../shared/crypto';
import type { RemoteAuditEntry, RemoteDeviceInfo, RemoteState } from '../../shared/types';
import type { HandlerRegistry } from '../handlers';
import type { SecretStore } from '../secrets';
import type { Logger } from '../log';
import type { RemoteAudit } from './audit';

/** Channels a paired web client may invoke (docs/REMOTE-ACCESS.md §5). Interactive P3:
 *  chat send/interrupt/stop, session lifecycle and per-session model controls are in;
 *  the terminal joins in P3.5 and destructive git stays desktop-only. */
export const REMOTE_CHANNELS = new Set<string>([
  'app:info',
  'settings:get',
  'harness:availability',
  'harness:models',
  'sessions:list',
  'sessions:get',
  'sessions:transcript',
  'sessions:search',
  'sessions:send',
  'sessions:interrupt',
  'sessions:stop',
  'sessions:create',
  'sessions:rename',
  'sessions:setModel',
  'sessions:setEffort',
  'sessions:setPermissionMode',
  'approvals:respond',
  'analytics:summary',
  'analytics:executions',
  'skills:list',
  'skills:read',
  'git:folderBranch',
  'git:folderIsRepo',
  'git:summary',
  'git:diff',
  'git:branches',
  'git:branchesOverview',
  'git:worktrees',
  'git:pullRequests',
  'git:issues',
  'git:issueComments',
  'git:prComments',
  'fs:list',
  'fs:search',
  'fs:read'
]);

/** View-only mode (P4) admits the read half and refuses the write half. Every channel in
 *  REMOTE_CHANNELS must be classified here or in REMOTE_WRITE_CHANNELS; a test asserts the two
 *  partition the set, so a newly added channel cannot silently become writable when view-only. */
export const REMOTE_READ_CHANNELS = new Set<string>([
  'app:info',
  'settings:get',
  'harness:availability',
  'harness:models',
  'sessions:list',
  'sessions:get',
  'sessions:transcript',
  'sessions:search',
  'analytics:summary',
  'analytics:executions',
  'skills:list',
  'skills:read',
  'git:folderBranch',
  'git:folderIsRepo',
  'git:summary',
  'git:diff',
  'git:branches',
  'git:branchesOverview',
  'git:worktrees',
  'git:pullRequests',
  'git:issues',
  'git:issueComments',
  'git:prComments',
  'fs:list',
  'fs:search',
  'fs:read'
]);

export const REMOTE_WRITE_CHANNELS = new Set<string>([
  'sessions:send',
  'sessions:interrupt',
  'sessions:stop',
  'sessions:create',
  'sessions:rename',
  'sessions:setModel',
  'sessions:setEffort',
  'sessions:setPermissionMode',
  'approvals:respond'
]);

/** Push channels a paired browser receives: the ones the remote surface consumes. Everything else
 *  the desktop pushes stays on this machine — terminal output (not remote until P3.5), the
 *  assistant panel, update prompts, and push:remoteState, which carries the live pairing code
 *  and pending pairing requests. */
export const REMOTE_PUSH_CHANNELS = new Set<string>([
  'push:sessionEvent',
  'push:sessionsChanged',
  'push:settingsChanged',
  'push:remotePolicy'
]);

interface HostCredentials {
  identity: Identity;
  relayUrl: string;
  deviceId?: string;
  deviceToken?: string;
  enrollToken?: string;
  /** Web devices paired with this host, by deviceId — the handshake trust anchors. */
  clients: Record<string, PublicIdentity>;
  /** P4: the symmetric key that seals the offline transcript mirror. Shared with every paired
   *  browser over the e2e session; never written to the relay. */
  mirrorKey?: string;
}

interface Session {
  key: CryptoKey;
  salt: Uint8Array;
  out: number;
  inSeq: number;
  inSalt?: string;
  outgoing: Promise<void>;
  identity: PublicIdentity;
}

interface WsMessage {
  t: 'pair.request' | 'pair.result' | 'pair.error' | 'hs' | 'd' | 'client.gone';
  code?: string;
  error?: string;
  name?: string;
  platform?: string;
  decision?: 'approve' | 'deny';
  hostToken?: string;
  hostDeviceId?: string;
  webToken?: string;
  webDeviceId?: string;
  webPub?: PublicIdentity;
  hostPub?: PublicIdentity;
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
  private pendingRequest: { code: string; name: string; platform: string; webPub: PublicIdentity } | undefined;
  private readonly sessions = new Map<string, Session>();
  /** Serialize handshake and ciphertext delivery per peer, not across unrelated clients. */
  private readonly incoming = new Map<string, Promise<void>>();
  /** Bumped on enable/disable so a pending reconnect timer can be invalidated. */
  private generation = 0;

  constructor(
    private readonly deps: {
      /** Lazy: the registry exists after registerIpc, which itself consumes this host. */
      registry: () => HandlerRegistry;
      secrets: { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> };
      pushState: () => void;
      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
      broadcast: (channel: string, payload: unknown) => void;
      /** P4 audit trail; absent in unit tests, in which case records are dropped. */
      audit?: RemoteAudit;
      /** P4 view-only policy, read live so a toggle applies without a reconnect. */
      viewOnly?: () => boolean;
    }
  ) {}

  state(): RemoteState {
    return {
      status: this.status,
      detail: this.detail,
      pairing: this.pairing,
      pendingRequest: this.pendingRequest,
      onlineClients: [...this.sessions.keys()],
      viewOnly: this.deps.viewOnly?.() ?? false
    };
  }

  /** The audit trail, newest first (P4); empty when no audit sink was supplied. */
  auditEntries(): RemoteAuditEntry[] {
    return this.deps.audit?.list() ?? [];
  }

  clearAudit(): void {
    this.deps.audit?.clear();
  }

  /** Tell paired browsers the view-only policy changed so they hide write controls. */
  async broadcastPolicy(): Promise<void> {
    await this.broadcastPush('push:remotePolicy', { viewOnly: this.state().viewOnly });
  }

  async enable(relayUrl: string, enrollToken: string): Promise<void> {
    this.generation++;
    await this.disable();
    const stored = await this.loadCreds();
    this.creds = stored ?? { identity: await generateIdentity(), relayUrl, enrollToken, clients: {} };
    this.creds.relayUrl = relayUrl;
    if (enrollToken) this.creds.enrollToken = enrollToken;
    // One mirror key per host, handed to each browser at connect; generated once and kept so an
    // existing mirror stays readable across restarts.
    if (!this.creds.mirrorKey) this.creds.mirrorKey = randomKeyB64();
    await this.saveCreds();
    // The relay URL is configuration; tokens and keys stay out of the log.
    this.deps.log('info', `remote: enabled for ${relayUrl} (${stored ? `${Object.keys(stored.clients).length} paired device(s)` : 'new identity'}${this.creds.deviceId ? ', enrolled' : ', not yet enrolled'})`);
    this.deps.audit?.record('enable', { detail: relayUrl });
    await this.connect();
  }

  async disable(): Promise<void> {
    this.generation++; // cancels any pending reconnect timer
    if (this.status !== 'off') {
      this.deps.log('info', `remote: disabled (${this.sessions.size} client session(s) dropped)`);
      this.deps.audit?.record('disable');
    }
    this.ws?.close();
    this.ws = null;
    this.sessions.clear();
    this.incoming.clear();
    this.status = 'off';
    this.detail = undefined;
    this.pendingRequest = undefined;
    this.pairing = undefined;
    this.push();
  }

  /** Requests a pairing code. An enrolled desktop authenticates as its own device; only the first
   *  enrollment needs the account's enrollment secret, so rotating it never strands this host. */
  async startPairing(hostName: string): Promise<{ code: string; expiresAt: number }> {
    if (!this.creds) throw new Error('remote access is not enabled');
    const base = this.creds.relayUrl.replace(/\/$/, '');
    const enrolled = !!(this.creds.deviceId && this.creds.deviceToken);
    const url = enrolled ? `${base}/v1/pair/start?device=${encodeURIComponent(this.creds.deviceId!)}` : `${base}/v1/pair/start`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${enrolled ? this.creds.deviceToken : this.creds.enrollToken ?? ''}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: hostName, platform: `${process.platform} ${process.arch}`, hostPub: publicOf(this.creds.identity) })
    });
    if (!res.ok) throw new Error(`pair/start failed: ${res.status}`);
    const body = (await res.json()) as { code: string; expiresAt: number };
    this.pairing = { code: body.code, expiresAt: body.expiresAt };
    this.deps.audit?.record('pair-start');
    this.push();
    return body;
  }

  /** The human decision on a pending pairing request. */
  async respondPairing(decision: 'approve' | 'deny'): Promise<void> {
    if (decision !== 'approve' && decision !== 'deny') return;
    const pending = this.pendingRequest;
    const socket = this.ws;
    const creds = this.creds;
    if (!pending || !socket || !creds) return;
    const signature = await sign(creds.identity, pairingDecisionPayload(pending.code, decision, pending.webPub));
    if (this.ws === socket && this.creds === creds && this.pendingRequest === pending) {
      socket.send(JSON.stringify({ t: 'pair.respond', code: pending.code, decision, signature }));
    }
  }

  /** Fan a local push event out to every connected web client, sealed per client. Only the
   *  remote push surface leaves the machine; the rest is dropped here, before sealing. */
  async broadcastPush(channel: string, payload: unknown): Promise<void> {
    if (!REMOTE_PUSH_CHANNELS.has(channel)) return;
    for (const clientId of [...this.sessions.keys()]) {
      await this.sendTo(clientId, { type: 'push', channel, payload });
    }
  }

  async listDevices(): Promise<RemoteDeviceInfo[]> {
    if (!this.creds?.deviceId || !this.creds.deviceToken) return [];
    // The device id is routing metadata; the token travels only in Authorization.
    const url = `${this.creds.relayUrl.replace(/\/$/, '')}/v1/devices?device=${encodeURIComponent(this.creds.deviceId)}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.creds.deviceToken}` } });
    if (!res.ok) throw new Error(`devices failed: ${res.status}`);
    return (await res.json()) as RemoteDeviceInfo[];
  }

  async revokeDevice(deviceId: string): Promise<void> {
    if (!this.creds?.deviceId || !this.creds.deviceToken) return;
    // `device` and the bearer authenticate the caller; `target` names the device to drop.
    const url = `${this.creds.relayUrl.replace(/\/$/, '')}/v1/devices?device=${encodeURIComponent(this.creds.deviceId)}&target=${encodeURIComponent(deviceId)}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.creds.deviceToken}` }
    });
    if (!res.ok) throw new Error(`revoke failed: ${res.status}`);
    if (this.creds.clients[deviceId]) {
      delete this.creds.clients[deviceId];
      await this.saveCreds();
    }
    this.sessions.delete(deviceId);
    this.deps.audit?.record('device-revoke', { device: deviceId });
    this.push();
  }

  /** The key that seals the offline mirror, or null before remote access was ever enabled. */
  mirrorSecret(): string | null {
    return this.creds?.mirrorKey ?? null;
  }

  /** Publishes a sealed mirror blob to the relay. False when not enrolled or the relay refused it. */
  async putMirror(kind: 'index' | 'session', sessionId: string | undefined, blob: SealedBlob): Promise<boolean> {
    if (!this.creds?.deviceId || !this.creds.deviceToken) return false;
    const base = this.creds.relayUrl.replace(/\/$/, '');
    const url = kind === 'index' ? `${base}/v1/mirror` : `${base}/v1/mirror/${encodeURIComponent(sessionId ?? '')}`;
    const res = await fetch(`${url}?device=${encodeURIComponent(this.creds.deviceId)}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${this.creds.deviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(blob)
    }).catch(() => null);
    if (!res?.ok) this.deps.log('warn', `remote: mirror upload refused (${res?.status ?? 'network error'})`);
    return !!res?.ok;
  }

  /** Drops the whole mirror at the relay (used when the user turns mirroring off). */
  async clearMirror(): Promise<void> {
    if (!this.creds?.deviceId || !this.creds.deviceToken) return;
    const base = this.creds.relayUrl.replace(/\/$/, '');
    await fetch(`${base}/v1/mirror?device=${encodeURIComponent(this.creds.deviceId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.creds.deviceToken}` }
    }).catch(() => undefined);
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
      this.deps.log('warn', 'remote: stored host credentials are unreadable; a new identity will be generated and every device must pair again');
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
    this.incoming.clear();
    ws.on('open', () => {
      this.status = this.creds?.deviceId ? 'online' : 'connecting';
      this.deps.log('info', `remote: relay connection open (${this.creds?.deviceId ? 'online' : 'awaiting enrollment'})`);
      this.push();
    });
    ws.on('message', (data) => void this.onMessage(String(data), ws));
    ws.on('close', (code: number) => {
      // Only the current socket's close counts: a stale socket (closed on reconnect)
      // must not clobber the new connection or wipe live sessions.
      if (this.ws !== ws) return;
      this.ws = null;
      const dropped = [...this.sessions.keys()];
      this.sessions.clear();
      this.incoming.clear();
      for (const client of dropped) this.deps.audit?.record('client-disconnect', { device: client });
      if (this.status !== 'off') {
        this.deps.log('info', `remote: relay connection closed (code ${code}${dropped.length ? `, ${dropped.length} client session(s) dropped` : ''}); reconnecting in 3s`);
        this.status = 'connecting';
        this.push();
        const gen = this.generation;
        setTimeout(() => {
          if (gen === this.generation) void this.connect();
        }, 3000);
      }
    });
    ws.on('error', () => {
      // ws errors may include the full socket URL; never write it into logs or UI state.
      this.deps.log('warn', 'remote: relay connection failed');
      this.status = 'error';
      this.detail = 'relay connection failed';
      this.push();
    });
  }

  private async onMessage(raw: string, socket: WebSocket): Promise<void> {
    if (this.ws !== socket) return;
    let msg: WsMessage;
    try {
      msg = JSON.parse(raw) as WsMessage;
    } catch {
      this.deps.log('debug', 'remote: dropped a non-JSON relay message');
      return;
    }
    switch (msg.t) {
      case 'pair.request': {
        if (!this.creds || !this.pairing || msg.code !== this.pairing.code ||
            !msg.hostPub || !msg.webPub || stable(msg.hostPub) !== stable(publicOf(this.creds.identity))) return;
        this.pendingRequest = { code: msg.code, name: String(msg.name ?? ''), platform: String(msg.platform ?? ''), webPub: msg.webPub };
        this.deps.log('info', `remote: pairing request from "${this.pendingRequest.name}" (${this.pendingRequest.platform}); awaiting the user's decision`);
        this.deps.audit?.record('pair-request', { detail: `${this.pendingRequest.name} (${this.pendingRequest.platform})` });
        this.push();
        return;
      }
      case 'pair.result': {
        if (!this.pendingRequest || msg.code !== this.pendingRequest.code) return;
        this.pendingRequest = undefined;
        this.pairing = undefined;
        this.detail = undefined;
        this.deps.log('info', `remote: pairing ${msg.decision === 'approve' ? 'approved' : 'denied'}${msg.webDeviceId ? ` for device ${msg.webDeviceId}` : ''}`);
        this.deps.audit?.record(msg.decision === 'approve' ? 'pair-approve' : 'pair-deny', { device: msg.webDeviceId ? String(msg.webDeviceId) : undefined });
        const creds = this.creds;
        if (msg.decision === 'approve' && msg.hostDeviceId && msg.webDeviceId && msg.webPub && creds) {
          creds.clients[msg.webDeviceId] = msg.webPub;
          // The relay mints a host device only when this approval enrolled the desktop; an
          // enrolled desktop keeps its id and token, so browsers paired before stay routable.
          const enrolledNow = !!msg.hostToken && (creds.deviceId !== msg.hostDeviceId || creds.deviceToken !== msg.hostToken);
          if (msg.hostToken) {
            creds.deviceId = msg.hostDeviceId;
            creds.deviceToken = msg.hostToken;
          }
          await this.saveCreds();
          if (enrolledNow) {
            // Reconnect under the real device token.
            this.ws?.close();
            await this.connect();
          }
        }
        this.push();
        return;
      }
      case 'pair.error': {
        // The relay refused the decision: the request is spent, so do not leave it on screen.
        if (!this.pendingRequest || (msg.code !== undefined && msg.code !== this.pendingRequest.code)) return;
        this.pendingRequest = undefined;
        this.pairing = undefined;
        this.detail = msg.error === 'device-limit'
          ? 'pairing refused: this account already has the maximum number of paired devices; revoke one first'
          : 'pairing refused by the relay';
        this.deps.log('warn', `remote: ${this.detail}`);
        this.deps.audit?.record('pair-deny', { detail: this.detail });
        this.push();
        return;
      }
      case 'hs': {
        if (msg.from) this.enqueue(String(msg.from), socket, () => this.onHandshake(String(msg.from), msg.payload));
        return;
      }
      case 'd': {
        if (msg.from) this.enqueue(String(msg.from), socket, () => this.onFrame(String(msg.from), msg.seq as number, msg.payload));
        return;
      }
      case 'client.gone': {
        if (msg.client) this.enqueue(String(msg.client), socket, async () => {
          if (this.sessions.delete(String(msg.client))) {
            this.deps.log('info', `remote: client ${msg.client} disconnected (${this.sessions.size} online)`);
            this.deps.audit?.record('client-disconnect', { device: String(msg.client) });
          }
          this.push();
        });
        return;
      }
      default:
        return;
    }
  }

  private enqueue(from: string, socket: WebSocket, task: () => Promise<void>): void {
    const previous = this.incoming.get(from) ?? Promise.resolve();
    const next = previous.then(() => this.ws === socket ? task() : undefined).catch((e: unknown) => {
      this.deps.log('warn', `remote: message from ${from} failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    this.incoming.set(from, next);
    void next.then(() => {
      if (this.incoming.get(from) === next) this.incoming.delete(from);
    });
  }

  private async onHandshake(from: string, payload: unknown): Promise<void> {
    if (!this.creds) return;
    const expected = this.creds.clients[from];
    if (!expected) {
      // The relay routed a device this host never paired with (or one that was revoked).
      this.deps.log('warn', `remote: ignored a handshake from unpaired device ${from}`);
      this.deps.audit?.record('handshake-failed', { device: from, detail: 'unpaired device' });
      return;
    }
    const socket = this.ws;
    try {
      const session = await hostAccept(this.creds.identity, payload as never, expected);
      if (!socket || this.ws !== socket || this.creds?.clients[from] !== expected) return;
      this.sessions.set(from, { key: session.key, salt: session.salt, out: 0, inSeq: -1, outgoing: Promise.resolve(), identity: expected });
      this.ws?.send(JSON.stringify({ t: 'hs', to: from, seq: 0, payload: session.reply }));
      this.deps.log('info', `remote: client ${from} connected (${this.sessions.size} online)`);
      this.deps.audit?.record('client-connect', { device: from });
      // Hand the browser the mirror key sealed inside the just-established session; it needs the
      // key before the desktop can ever be offline, and re-receives it on every reconnect.
      if (this.creds.mirrorKey) await this.sendTo(from, { type: 'mirror.key', key: this.creds.mirrorKey });
    } catch (e) {
      this.deps.log('warn', `remote handshake failed for ${from}: ${e instanceof Error ? e.message : String(e)}`);
      this.deps.audit?.record('handshake-failed', { device: from });
    }
  }

  private async onFrame(from: string, seq: number, payload: unknown): Promise<void> {
    const session = this.sessions.get(from);
    const sealed = payload as { salt?: unknown; seq?: unknown; ct?: unknown } | null;
    if (!session || !sealed || !Number.isSafeInteger(seq) || seq < 0 || sealed.seq !== seq ||
        typeof sealed.salt !== 'string' || typeof sealed.ct !== 'string' || seq <= session.inSeq ||
        (session.inSalt !== undefined && sealed.salt !== session.inSalt)) return;
    let inner: { type: string; id?: number; channel?: string; request?: unknown; sig?: string };
    try {
      inner = await openFrame(session.key, sealed as { salt: string; seq: number; ct: string });
    } catch {
      this.deps.log('warn', `remote: undecryptable frame from ${from} (seq ${seq})`);
      return;
    }
    if (this.sessions.get(from) !== session) return;
    session.inSalt = sealed.salt;
    session.inSeq = seq;
    if (inner.type === 'invoke' && inner.channel) {
      const allowed = REMOTE_CHANNELS.has(inner.channel);
      // Approvals are signed inside the e2e channel (§6.8): only a paired device key resolves.
      const signedOk = inner.channel !== 'approvals:respond' || (!!inner.sig && (await verify(session.identity, inner.request, inner.sig)));
      if (!allowed || !signedOk) {
        // A paired client asking for a local-only channel is either an outdated web build or a probe.
        this.deps.log('warn', `remote: refused ${inner.channel} from ${from} (${allowed ? 'missing or invalid approval signature' : 'channel not available remotely'})`);
        this.deps.audit?.record('channel-refused', { device: from, detail: inner.channel });
        await this.sendTo(from, { type: 'result', id: inner.id, ok: false, error: 'channel not available remotely' });
        return;
      }
      // View-only mode (P4): the read half is served, the write half is refused before dispatch,
      // so no send, approval, session change or lifecycle action can reach the registry.
      if (this.deps.viewOnly?.() && !REMOTE_READ_CHANNELS.has(inner.channel)) {
        this.deps.log('info', `remote: refused ${inner.channel} from ${from} (view-only mode)`);
        this.deps.audit?.record('view-only-blocked', { device: from, detail: inner.channel });
        await this.sendTo(from, { type: 'result', id: inner.id, ok: false, error: 'remote access is in view-only mode' });
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
    if (!session) return;
    const send = session.outgoing.then(async () => {
      const socket = this.ws;
      if (this.sessions.get(clientId) !== session || !socket || socket.readyState !== WebSocket.OPEN) return;
      const sealed = await sealFrame(session.key, session.salt, session.out++, inner);
      if (this.sessions.get(clientId) === session && this.ws === socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: 'd', to: clientId, seq: sealed.seq, payload: sealed }));
      }
    });
    session.outgoing = send.catch(() => undefined);
    await send;
  }
}

