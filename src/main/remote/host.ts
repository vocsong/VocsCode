/** Desktop remote host (docs/REMOTE-ACCESS.md P2): an outbound, opt-in connection to the
 *  relay that lets paired web clients drive a filtered subset of the local handler
 *  registry over an e2e-encrypted session. Off by default; device credentials and the
 *  identity keys live in the secret store, never in settings or logs. */
import os from 'node:os';
import { WebSocket } from 'ws';
import { generateIdentity, randomKeyB64, type PublicIdentity, type SealedBlob } from '../../shared/crypto';
import { assertEndpointUrl, endpointSocketUrl } from '../../shared/endpoint-policy';
import type { RemoteAuditEntry, RemoteDeviceInfo, RemoteState } from '../../shared/types';
import type { HandlerRegistry } from '../handlers/context';
import type { RemoteAudit } from './audit';
import { HostControlRunner, type ControlHandler } from './host-control';
import { HostPairingController, type PairingWireMessage } from './host-pairing';
import { HostSessionBridge } from './host-session-bridge';
import { RemoteMirrorTransport } from './mirror-transport';
import { relayBaseUrl, RelayClient, type HostCredentials } from './relay-client';
import type { TerminalSource } from './terminal-streams';
import type { RemoteHostPort } from './types';

/** The remote channel manifest (docs/REMOTE-ACCESS.md §5) lives in src/shared/remote-channels.ts
 *  so the web shell imports the same allowlist it is held to. Re-exported because desktop callers
 *  and tests have always imported it from the host. */
export { REMOTE_CHANNELS, REMOTE_PUSH_CHANNELS, REMOTE_READ_CHANNELS, REMOTE_WRITE_CHANNELS } from '../../shared/remote-channels';

const RECONNECT_MS = 3000;

interface WsMessage extends PairingWireMessage {
  t: 'pair.request' | 'pair.result' | 'pair.error' | 'hs' | 'd' | 'client.gone' | 'device.revoked' | 'control.request';
  devices?: unknown;
  webToken?: string;
  from?: string;
  to?: string;
  client?: string;
  seq?: number;
  payload?: unknown;
}

export class RemoteHost implements RemoteHostPort {
  private creds: HostCredentials | null = null;
  private ws: WebSocket | null = null;
  private status: RemoteState['status'] = 'off';
  private detail: string | undefined;
  /** Bumped on enable/disable so a pending reconnect timer can be invalidated. */
  private generation = 0;
  /** A connect is between its start and opening its socket (it may be buying an access token). */
  private connectInFlight = false;
  private connectAttempt = 0;
  private readonly relayClient: RelayClient;
  private readonly pairing: HostPairingController;
  private readonly bridge: HostSessionBridge;
  private readonly controlRunner: HostControlRunner;
  /** Offline-mirror upload and clear-retry coordinator. */
  private readonly mirrorTransport: RemoteMirrorTransport;

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
      /** The mirror key changed (a browser holding it lost its pairing): re-seal and re-upload. */
      onMirrorRotated?: () => void;
      /** The relay socket opened as this registered computer (each connect and reconnect). */
      onOnline?: () => void;
      /** First retry delay for a mirror clear the relay did not confirm; tests shrink it. */
      mirrorRetryMs?: number;
      /** Delay before repeating a clear after an upload failed in transit; tests shrink it. */
      mirrorLateWriteMs?: number;
      /** P3.5: the terminals a browser may watch; absent when terminals are unavailable. */
      terminals?: () => TerminalSource | null;
      /** Separate delegated controller boundary; never a browser invoke or approval channel. */
      control?: ControlHandler;
    }
  ) {
    this.relayClient = new RelayClient({
      getCreds: () => this.creds,
      onCredentialRejected: (creds, detail, rejected) => this.forgetRegistration(creds, detail, rejected)
    });
    this.pairing = new HostPairingController({
      getCreds: () => this.creds,
      getSocket: () => this.ws,
      enrolled: () => this.enrolled(),
      generation: () => this.generation,
      relayFetch: (path, init) => this.relayClient.fetch(path, init),
      saveCreds: () => this.saveCreds(),
      connect: () => this.connect(),
      setStatus: (status, detail) => {
        this.status = status;
        this.detail = detail;
      },
      setDetail: (detail) => { this.detail = detail; },
      push: () => this.push(),
      log: (level, message) => this.deps.log(level, message),
      audit: this.deps.audit
    });
    this.bridge = new HostSessionBridge({
      getCreds: () => this.creds,
      getSocket: () => this.ws,
      registry: () => this.deps.registry(),
      terminals: this.deps.terminals,
      viewOnly: this.deps.viewOnly,
      push: () => this.push(),
      log: (level, message) => this.deps.log(level, message),
      audit: this.deps.audit
    });
    this.controlRunner = new HostControlRunner(this.deps.control);
    this.mirrorTransport = new RemoteMirrorTransport({
      enrolled: () => this.enrolled(),
      isOff: () => this.status === 'off',
      relayFetch: (path, init, proceed) => this.relayClient.fetch(path, init, proceed),
      log: (level, message) => this.deps.log(level, message),
      audit: this.deps.audit,
      retryMs: this.deps.mirrorRetryMs,
      lateWriteMs: this.deps.mirrorLateWriteMs
    });
  }

  state(): RemoteState {
    const pairingState = this.pairing.stateSnapshot();
    return {
      status: this.status,
      detail: this.detail,
      pairing: pairingState.pairing,
      pendingRequest: pairingState.pendingRequest,
      onlineClients: this.bridge.onlineClients(),
      viewOnly: this.deps.viewOnly?.() ?? false,
      registered: this.enrolled(),
      ...(pairingState.signIn ? { signIn: pairingState.signIn } : {})
    };
  }

  /** Whether this computer is already registered with the relay, so it can connect without the
   *  enrollment secret. Reads the stored credentials when remote access has not been enabled yet. */
  async isRegistered(): Promise<boolean> {
    const creds = this.creds ?? (await this.loadCreds());
    return !!(creds?.deviceId && creds.deviceToken);
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
    await this.prepare(relayUrl, enrollToken);
    await this.connect();
  }

  /** Connect with Vocs: register this computer through a signed-in browser instead of the
   *  enrollment secret. A one-time secret stays here; only its SHA-256 goes into the page `open`
   *  shows, where the owner signs in and adds this computer. Meanwhile this desktop polls the
   *  relay with the secret, and receives its credential sealed to its own key. An already
   *  registered computer just connects. */
  async signIn(relayUrl: string, open: (url: string) => Promise<void>, hostName = os.hostname() || 'desktop'): Promise<void> {
    await this.prepare(relayUrl, '');
    if (this.enrolled()) {
      await this.connect();
      return;
    }
    await this.pairing.beginSignIn(relayUrl, open, hostName, this.generation);
  }

  async disable(): Promise<void> {
    this.generation++; // cancels any pending reconnect timer
    if (this.status !== 'off') {
      this.deps.log('info', `remote: disabled (${this.bridge.sessionCount()} client session(s) dropped)`);
      this.deps.audit?.record('disable');
    }
    this.ws?.close();
    this.ws = null;
    this.bridge.clearAll();
    this.status = 'off';
    this.detail = undefined;
    this.pairing.cancelAll();
    // A mirror clear still owed is retried on the next connect or upload, not while paused.
    this.mirrorTransport.cancelRetry();
    this.push();
  }

  /** App-quit teardown: closes sockets and cancels timers without recording a user disable event or pushing state. */
  close(): void {
    this.generation++;
    this.ws?.close();
    this.ws = null;
    this.bridge.clearAll();
    this.status = 'off';
    this.detail = undefined;
    this.pairing.cancelAll();
    this.mirrorTransport.cancelRetry();
  }

  /** Loads or creates this computer's identity for `relayUrl`, without connecting. */
  private async prepare(relayUrl: string, enrollToken: string): Promise<void> {
    const endpoint = assertEndpointUrl(relayUrl);
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
    this.deps.log('info', `remote: enabled for ${endpoint.origin} (${stored ? `${Object.keys(stored.clients).length} paired device(s)` : 'new identity'}${this.creds.deviceId ? ', enrolled' : ', not yet enrolled'})`);
    this.deps.audit?.record('enable', { detail: endpoint.origin });
  }

  startPairing(hostName: string): Promise<{ code: string; expiresAt: number }> {
    return this.pairing.startPairing(hostName);
  }

  respondPairing(decision: 'approve' | 'deny'): Promise<void> {
    return this.pairing.respondPairing(decision);
  }

  broadcastPush(channel: string, payload: unknown): Promise<void> {
    return this.bridge.broadcastPush(channel, payload);
  }

  async listDevices(): Promise<RemoteDeviceInfo[]> {
    if (!this.enrolled()) return [];
    return this.relayClient.listDevices();
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const creds = this.creds;
    if (!creds || !this.enrolled()) return;
    const revoked = await this.relayClient.revokeDevice(deviceId);
    this.deps.audit?.record('device-revoke', { device: deviceId });
    if (revoked.includes(creds.deviceId ?? '')) {
      // This desktop revoked itself: its credential is gone, and with it every browser paired
      // through it (the relay cascades). Keep the identity so re-pairing is one step.
      await this.forgetRegistration(creds, 'this computer was revoked; pair a browser to register it again');
      return;
    }
    await this.dropClients(creds, revoked.filter((id) => creds.clients[id]), 'revoked from this computer');
  }

  /** The kill switch (docs/REMOTE-ACCESS.md §6.5): revokes every other device of the account —
   *  each browser and every other computer — and aborts pending pairings. This desktop keeps its
   *  identity and stays connected; the mirror its browsers could read is re-keyed. */
  async revokeAll(): Promise<void> {
    const creds = this.creds;
    if (!creds || !this.enrolled()) throw new Error('remote access is not enrolled with a relay');
    this.pairing.abortPairing();
    this.push();
    await this.relayClient.revokeAll();
    this.deps.audit?.record('revoke-all');
    this.pairing.abortPairing();
    await this.dropClients(creds, Object.keys(creds.clients), 'every other device revoked');
    this.push();
  }

  /** Session ids this desktop has mirrored at the relay (routing metadata only). */
  async mirroredSessions(): Promise<string[]> {
    if (!this.enrolled()) return [];
    return this.relayClient.mirroredSessions();
  }

  async deleteMirrorSession(sessionId: string): Promise<void> {
    if (!this.enrolled()) return;
    await this.relayClient.deleteMirrorSession(sessionId);
  }

  /** The offline-mirror policy changed: part of the audit trail like any other trust decision. */
  auditMirror(enabled: boolean): void {
    this.deps.audit?.record(enabled ? 'mirror-enable' : 'mirror-disable');
  }

  /** The key that seals the offline mirror, or null before remote access was ever enabled. */
  mirrorSecret(): string | null {
    return this.creds?.mirrorKey ?? null;
  }

  /** Publishes a sealed mirror blob to the relay. */
  putMirror(kind: 'index' | 'session', sessionId: string | undefined, blob: SealedBlob, current: () => boolean = () => true): Promise<boolean> {
    return this.mirrorTransport.put(kind, sessionId, blob, current);
  }

  /** An analytics call as this computer (docs/WEB-DASHBOARD.md), or null while remote access is
   *  off or this computer is not registered with the relay. */
  async analyticsRequest(path: string, init: RequestInit = {}): Promise<Response | null> {
    if (this.status === 'off' || !this.enrolled()) return null;
    return this.relayClient.fetch(path, init);
  }

  /** Drops the whole mirror at the relay (mirroring turned off, or the key rotated). */
  clearMirror(): Promise<boolean> {
    return this.mirrorTransport.clear();
  }

  // --- internals ---

  private push(): void {
    this.deps.pushState();
  }

  /** Registered with the relay: a device id and a refresh credential it still accepts. */
  private enrolled(): boolean {
    return !!(this.creds?.deviceId && this.creds.deviceToken);
  }

  /** The relay no longer accepts this desktop's credential: revoked (from any device, or with a
   *  revoke-all), or issued by a different relay. Stop using it, but keep the identity and the
   *  paired browsers: re-pairing re-registers the same key, and a relay that still knows this
   *  desktop keeps its host id; reconciliation then drops the browsers it no longer lists. */
  private async forgetRegistration(creds: HostCredentials, detail: string, rejected?: string): Promise<void> {
    if (this.creds !== creds || (rejected !== undefined && creds.deviceToken !== rejected) || !creds.deviceToken) return;
    delete creds.deviceToken;
    this.pairing.clearPairing();
    this.relayClient.clearAccess();
    await this.saveCreds();
    this.detail = detail;
    this.deps.log('warn', `remote: ${detail}`);
    this.deps.audit?.record('host-revoked');
    // Sessions keyed to the old registration are dead; reconnect in enrolling mode.
    this.ws?.close();
    this.push();
  }

  /** Forget paired browsers that lost their pairing, and re-key the mirror they could read. */
  private async dropClients(creds: HostCredentials, ids: string[], why: string): Promise<void> {
    const dropped = ids.filter((id) => creds.clients[id]);
    this.bridge.dropClients(ids);
    if (!dropped.length) {
      this.push();
      return;
    }
    for (const id of dropped) delete creds.clients[id];
    await this.saveCreds();
    this.deps.log('info', `remote: forgot ${dropped.length} browser pairing(s) (${why})`);
    await this.rotateMirrorKey(why);
    this.push();
  }

  /** The relay's registry is the record of who is still paired: drop local trust anchors for any
   *  browser it no longer lists (revoked from another device, or cascaded with this desktop). */
  private async reconcile(): Promise<void> {
    const creds = this.creds;
    if (!creds || !this.enrolled()) return;
    try {
      const live = new Set((await this.listDevices()).map((d) => d.deviceId));
      await this.dropClients(creds, Object.keys(creds.clients).filter((id) => !live.has(id)), 'revoked on another device');
    } catch (e) {
      this.deps.log('debug', `remote: could not reconcile paired devices: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** A browser that held the mirror key lost its pairing. Seal the mirror under a fresh key: drop
   *  the relay copy, re-upload, and hand the new key to the browsers still paired, over e2e. */
  private async rotateMirrorKey(why: string): Promise<void> {
    const creds = this.creds;
    if (!creds) return;
    creds.mirrorKey = randomKeyB64();
    await this.saveCreds();
    this.deps.audit?.record('mirror-rotate', { detail: why });
    // Uploads still sealed under the old key are dropped by their fence; any already on the wire
    // land first, then this clear removes them. A failed clear is retried before the re-upload.
    await this.clearMirror();
    this.deps.onMirrorRotated?.();
    await this.bridge.broadcastMirrorKey(creds.mirrorKey);
  }

  private scheduleReconnect(): void {
    const gen = this.generation;
    setTimeout(() => {
      // Something else may have reconnected meanwhile (enrollment reconnects at once, while the
      // old socket's close still schedules this): a second connect would replace a healthy
      // socket and strand every browser that just handshook over it.
      if (gen !== this.generation || this.connectInFlight) return;
      if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
      void this.connect();
    }, RECONNECT_MS);
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
    const attempt = ++this.connectAttempt;
    this.connectInFlight = true;
    try {
      await this.openSocket();
    } finally {
      // A superseded attempt finishing late must not clear a newer one's flag.
      if (attempt === this.connectAttempt) this.connectInFlight = false;
    }
  }

  private async openSocket(): Promise<void> {
    const creds = this.creds;
    if (!creds) return;
    const socketBase = endpointSocketUrl(relayBaseUrl(creds.relayUrl)).replace(/\/$/, '');
    const gen = this.generation;
    this.status = 'connecting';
    this.push();
    let auth = creds.enrollToken ?? '';
    if (this.enrolled()) {
      try {
        auth = await this.relayClient.accessToken();
      } catch {
        if (gen !== this.generation || this.creds !== creds) return;
        // Still enrolled means the relay was unreachable: retry. Otherwise the credential was just
        // rejected and this desktop reconnects in enrolling mode below.
        if (this.enrolled()) {
          this.status = 'error';
          this.detail = 'relay unreachable';
          this.push();
          this.scheduleReconnect();
          return;
        }
        auth = creds.enrollToken ?? '';
      }
    }
    if (gen !== this.generation || this.creds !== creds) return;
    const enrolled = this.enrolled();
    if (!enrolled && !auth) {
      // Not registered and nothing to register with: the relay would refuse every attempt, so say
      // what is missing instead of retrying forever.
      this.status = 'error';
      this.detail = 'this computer is not registered with the relay yet: enter the enrollment secret and connect';
      this.push();
      return;
    }
    const device = enrolled ? creds.deviceId! : 'enrolling';
    const ws = new WebSocket(`${socketBase}/v1/ws/host?device=${encodeURIComponent(device)}`, { headers: { authorization: `Bearer ${auth}` }, followRedirects: false });
    this.ws = ws;
    this.bridge.clearIncoming();
    this.controlRunner.clear();
    let opened = false;
    ws.on('open', () => {
      opened = true;
      if (this.ws !== ws) return;
      this.status = enrolled ? 'online' : 'connecting';
      if (enrolled) this.detail = undefined;
      this.deps.log('info', `remote: relay connection open (${enrolled ? 'online' : 'awaiting enrollment'})`);
      this.push();
      if (enrolled) void this.reconcile();
      if (enrolled) this.mirrorTransport.flushIfPending();
      if (enrolled) this.deps.onOnline?.();
    });
    ws.on('message', (data) => void this.onMessage(String(data), ws));
    ws.on('close', (code: number) => {
      // A refused upgrade may mean this access token is no longer good (expired, or the device
      // was revoked): the next attempt proves possession again, which settles which it was.
      if (!opened) this.relayClient.invalidateIfMatching(auth);
      // Only the current socket's close counts: a stale socket (closed on reconnect)
      // must not clobber the new connection or wipe live sessions.
      if (this.ws !== ws) return;
      this.ws = null;
      this.pairing.clearDecision();
      const dropped = this.bridge.onSocketClosed();
      if (this.status !== 'off') {
        this.deps.log('info', `remote: relay connection closed (code ${code}${dropped.length ? `, ${dropped.length} client session(s) dropped` : ''}); reconnecting in 3s`);
        this.status = 'connecting';
        this.push();
        this.scheduleReconnect();
      }
    });
    ws.on('error', () => {
      // Never log the error itself: ws messages may include the socket URL.
      this.deps.log('warn', 'remote: relay connection failed');
      this.status = 'error';
      if (this.enrolled() || !this.detail) this.detail = 'relay connection failed';
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
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (msg.t === 'control.request') {
      await this.controlRunner.handleRequest(raw, socket, {
        isCurrentSocket: () => this.ws === socket,
        enrolledHostId: this.enrolled() ? this.creds?.deviceId : undefined
      });
      return;
    }
    switch (msg.t) {
      case 'pair.request':
        this.pairing.handlePairRequest(msg);
        return;
      case 'pair.result':
        await this.pairing.handlePairResult(msg, socket);
        return;
      case 'pair.error':
        this.pairing.handlePairError(msg);
        return;
      case 'hs':
        if (msg.from) this.bridge.enqueue(String(msg.from), socket, () => this.bridge.onHandshake(String(msg.from), msg.payload));
        return;
      case 'd':
        if (msg.from) this.bridge.enqueue(String(msg.from), socket, () => this.bridge.onFrame(String(msg.from), msg.seq as number, msg.payload));
        return;
      case 'device.revoked':
        // A hint that some device was revoked: re-read the registry rather than trust the list.
        void this.reconcile();
        return;
      case 'client.gone':
        if (msg.client) this.bridge.handleClientGone(String(msg.client), socket);
        return;
      default:
        return;
    }
  }
}
