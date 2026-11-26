/** Desktop relay connection: an outbound, opt-in socket to the relay that registers this computer
 *  with the owner's Vocs account. External MCP controllers reach the desktop over it
 *  (docs/CONTROL-MCP.md) and the code.vocs.io dashboard receives analytics through it
 *  (docs/WEB-DASHBOARD.md). Off by default; the device credential and identity keys live in the
 *  secret store, never in settings or logs. */
import os from 'node:os';
import { WebSocket } from 'ws';
import { generateIdentity } from '../../shared/crypto';
import { assertEndpointUrl, endpointSocketUrl } from '../../shared/endpoint-policy';
import type { RemoteDeviceInfo, RemoteState } from '../../shared/types';
import { HostControlRunner, type ControlHandler } from './host-control';
import { HostSignIn } from './host-sign-in';
import { relayBaseUrl, RelayClient, type HostCredentials } from './relay-client';
import type { RemoteHostPort } from './types';

const RECONNECT_MS = 3000;

/** Fields older builds kept with the host credential for paired browsers. Read once, on load, so an
 *  upgraded computer can delete the transcript mirror it left at the relay; never written again. */
interface LegacyCredentialFields {
  enrollToken?: unknown;
  clients?: unknown;
  mirrorKey?: unknown;
}

export class RemoteHost implements RemoteHostPort {
  private creds: HostCredentials | null = null;
  private ws: WebSocket | null = null;
  private status: RemoteState['status'] = 'off';
  private detail: string | undefined;
  /** Bumped on enable/disable so a pending reconnect timer or sign-in poll can be invalidated. */
  private generation = 0;
  /** A connect is between its start and opening its socket (it may be buying an access token). */
  private connectInFlight = false;
  private connectAttempt = 0;
  private readonly relayClient: RelayClient;
  private readonly signInFlow: HostSignIn;
  private readonly controlRunner: HostControlRunner;

  constructor(
    private readonly deps: {
      secrets: { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> };
      pushState: () => void;
      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
      /** The relay socket opened as this registered computer (each connect and reconnect). */
      onOnline?: () => void;
      /** Separate delegated controller boundary (docs/CONTROL-MCP.md). */
      control?: ControlHandler;
    }
  ) {
    this.relayClient = new RelayClient({
      getCreds: () => this.creds,
      onCredentialRejected: (creds, detail, rejected) => this.forgetRegistration(creds, detail, rejected)
    });
    this.signInFlow = new HostSignIn({
      getCreds: () => this.creds,
      generation: () => this.generation,
      saveCreds: () => this.saveCreds(),
      connect: () => this.connect(),
      setStatus: (status, detail) => {
        this.status = status;
        this.detail = detail;
      },
      setDetail: (detail) => { this.detail = detail; },
      push: () => this.push(),
      log: (level, message) => this.deps.log(level, message)
    });
    this.controlRunner = new HostControlRunner(this.deps.control);
  }

  state(): RemoteState {
    const signIn = this.signInFlow.pending();
    return {
      status: this.status,
      detail: this.detail,
      registered: this.enrolled(),
      ...(signIn ? { signIn } : {})
    };
  }

  /** Whether this computer is already registered with the relay. Reads the stored credentials when
   *  the connection has not been turned on yet. */
  async isRegistered(): Promise<boolean> {
    const creds = this.creds ?? (await this.loadCreds());
    return !!(creds?.deviceId && creds.deviceToken);
  }

  /** Connects as an already registered computer (start-up resume). */
  async enable(relayUrl: string): Promise<void> {
    await this.prepare(relayUrl);
    await this.connect();
  }

  /** Connect with Vocs: register this computer through a signed-in browser. A one-time secret stays
   *  here; only its SHA-256 goes into the page `open` shows, where the owner signs in and adds this
   *  computer. Meanwhile this desktop polls the relay with the secret, and receives its credential
   *  sealed to its own key. An already registered computer just connects. */
  async signIn(relayUrl: string, open: (url: string) => Promise<void>, hostName = os.hostname() || 'desktop'): Promise<void> {
    await this.prepare(relayUrl);
    if (this.enrolled()) {
      await this.connect();
      return;
    }
    await this.signInFlow.begin(relayUrl, open, hostName, this.generation);
  }

  async disable(): Promise<void> {
    if (this.status !== 'off') this.deps.log('info', 'remote: disconnected from the relay');
    this.close();
    this.push();
  }

  /** App-quit teardown: closes the socket and cancels timers without pushing state. */
  close(): void {
    this.generation++;
    this.ws?.close();
    this.ws = null;
    this.status = 'off';
    this.detail = undefined;
    this.signInFlow.cancel();
  }

  /** Loads or creates this computer's identity for `relayUrl`, without connecting. */
  private async prepare(relayUrl: string): Promise<void> {
    const endpoint = assertEndpointUrl(relayUrl);
    await this.disable();
    const stored = await this.loadCreds();
    this.creds = stored ?? { identity: await generateIdentity(), relayUrl };
    this.creds.relayUrl = relayUrl;
    await this.saveCreds();
    // The relay URL is configuration; tokens and keys stay out of the log.
    this.deps.log('info', `remote: enabled for ${endpoint.origin} (${stored ? 'stored identity' : 'new identity'}${this.creds.deviceId ? ', registered' : ', not yet registered'})`);
  }

  /** The computers registered to this account, plus any browsers an older build paired. */
  async listDevices(): Promise<RemoteDeviceInfo[]> {
    if (!this.enrolled()) return [];
    return this.relayClient.listDevices();
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const creds = this.creds;
    if (!creds || !this.enrolled()) return;
    const revoked = await this.relayClient.revokeDevice(deviceId);
    // This desktop revoked itself: its credential is gone. Keep the identity so registering again
    // is one Connect with Vocs.
    if (revoked.includes(creds.deviceId ?? '')) {
      await this.forgetRegistration(creds, 'this computer was removed from your account; connect with Vocs to add it again');
      return;
    }
    this.push();
  }

  /** The kill switch: revokes every other device of the account. This computer stays connected. */
  async revokeAll(): Promise<void> {
    if (!this.creds || !this.enrolled()) throw new Error('this computer is not registered with the relay');
    await this.relayClient.revokeAll();
    this.push();
  }

  /** An analytics call as this computer (docs/WEB-DASHBOARD.md), or null while the connection is
   *  off or this computer is not registered with the relay. */
  async analyticsRequest(path: string, init: RequestInit = {}): Promise<Response | null> {
    if (this.status === 'off' || !this.enrolled()) return null;
    return this.relayClient.fetch(path, init);
  }

  // --- internals ---

  private push(): void {
    this.deps.pushState();
  }

  /** Registered with the relay: a device id and a refresh credential it still accepts. */
  private enrolled(): boolean {
    return !!(this.creds?.deviceId && this.creds.deviceToken);
  }

  /** The relay no longer accepts this desktop's credential: revoked, or issued by a different relay.
   *  Stop using it but keep the identity, so registering again reuses the same key. */
  private async forgetRegistration(creds: HostCredentials, detail: string, rejected?: string): Promise<void> {
    if (this.creds !== creds || (rejected !== undefined && creds.deviceToken !== rejected) || !creds.deviceToken) return;
    delete creds.deviceToken;
    this.relayClient.clearAccess();
    await this.saveCreds();
    // Stop reconnecting with a credential the relay refuses; Connect with Vocs registers it again.
    this.generation++;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.status = 'error';
    this.detail = detail;
    this.deps.log('warn', `remote: ${detail}`);
    this.push();
  }

  /** Older builds could upload sealed transcript snapshots for paired browsers. Delete that copy
   *  once after upgrading; a failure is retried on the next connect. */
  private async purgeLegacyMirror(creds: HostCredentials): Promise<void> {
    if (!creds.legacyMirror) return;
    try {
      const res = await this.relayClient.fetch('/v1/mirror', { method: 'DELETE' });
      // 404: a relay that no longer stores mirrors has nothing to delete.
      if (!res.ok && res.status !== 404) throw new Error(`relay answered ${res.status}`);
      if (this.creds !== creds) return;
      delete creds.legacyMirror;
      await this.saveCreds();
      this.deps.log('info', 'remote: deleted the transcript mirror an earlier version left at the relay');
    } catch (e) {
      this.deps.log('warn', `remote: could not delete the old transcript mirror yet; retrying on the next connect: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private scheduleReconnect(): void {
    const gen = this.generation;
    setTimeout(() => {
      // Something else may have reconnected meanwhile (registration reconnects at once while the old
      // socket's close still schedules this): a second connect would replace a healthy socket.
      if (gen !== this.generation || this.connectInFlight) return;
      if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
      void this.connect();
    }, RECONNECT_MS);
  }

  private async loadCreds(): Promise<HostCredentials | null> {
    const raw = await this.deps.secrets.get('remote-host');
    if (!raw) return null;
    try {
      // Paired-browser trust anchors, the mirror key and the enrollment secret are dropped on the
      // next save; the marker remembers that a sealed mirror may still sit at the relay.
      const { enrollToken: _enroll, clients: _clients, mirrorKey, ...creds } = JSON.parse(raw) as HostCredentials & LegacyCredentialFields;
      if (typeof mirrorKey === 'string' && mirrorKey) creds.legacyMirror = true;
      return creds;
    } catch {
      this.deps.log('warn', 'remote: stored host credentials are unreadable; a new identity will be generated and this computer must connect with Vocs again');
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
    const gen = this.generation;
    if (!this.enrolled()) {
      // Not registered: the relay would refuse every attempt, so say what is missing instead of
      // retrying forever.
      this.status = 'error';
      this.detail = 'this computer is not registered with the relay yet: connect with Vocs';
      this.push();
      return;
    }
    const socketBase = endpointSocketUrl(relayBaseUrl(creds.relayUrl)).replace(/\/$/, '');
    this.status = 'connecting';
    this.push();
    let auth: string;
    try {
      auth = await this.relayClient.accessToken();
    } catch {
      if (gen !== this.generation || this.creds !== creds) return;
      // Still registered means the relay was unreachable: retry. Otherwise the credential was just
      // rejected, and forgetRegistration already said so.
      if (this.enrolled()) {
        this.status = 'error';
        this.detail = 'relay unreachable';
        this.push();
        this.scheduleReconnect();
      }
      return;
    }
    if (gen !== this.generation || this.creds !== creds) return;
    const ws = new WebSocket(`${socketBase}/v1/ws/host?device=${encodeURIComponent(creds.deviceId!)}`, { headers: { authorization: `Bearer ${auth}` }, followRedirects: false });
    this.ws = ws;
    this.controlRunner.clear();
    let opened = false;
    ws.on('open', () => {
      opened = true;
      if (this.ws !== ws) return;
      this.status = 'online';
      this.detail = undefined;
      this.deps.log('info', 'remote: relay connection open');
      this.push();
      void this.purgeLegacyMirror(creds);
      this.deps.onOnline?.();
    });
    ws.on('message', (data) => void this.onMessage(String(data), ws));
    ws.on('close', (code: number) => {
      // A refused upgrade may mean this access token is no longer good (expired, or the device
      // was revoked): the next attempt proves possession again, which settles which it was.
      if (!opened) this.relayClient.invalidateIfMatching(auth);
      // Only the current socket's close counts: a stale socket (closed on reconnect) must not
      // clobber the new connection.
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.status !== 'off') {
        this.deps.log('info', `remote: relay connection closed (code ${code}); reconnecting in 3s`);
        this.status = 'connecting';
        this.push();
        this.scheduleReconnect();
      }
    });
    ws.on('error', () => {
      if (this.ws !== ws) return;
      // Never log the error itself: ws messages may include the socket URL.
      this.deps.log('warn', 'remote: relay connection failed');
      this.status = 'error';
      this.detail = 'relay connection failed';
      this.push();
    });
  }

  private async onMessage(raw: string, socket: WebSocket): Promise<void> {
    if (this.ws !== socket) return;
    let msg: { t?: unknown };
    try {
      msg = JSON.parse(raw) as { t?: unknown };
    } catch {
      this.deps.log('debug', 'remote: dropped a non-JSON relay message');
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    // Controller requests are the only traffic this computer serves; frames meant for the retired
    // paired-browser channel are ignored.
    if (msg.t === 'control.request') {
      await this.controlRunner.handleRequest(raw, socket, {
        isCurrentSocket: () => this.ws === socket,
        enrolledHostId: this.enrolled() ? this.creds?.deviceId : undefined
      });
    }
  }
}
