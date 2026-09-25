/** Desktop remote host (docs/REMOTE-ACCESS.md P2): an outbound, opt-in connection to the
 *  relay that lets paired web clients drive a filtered subset of the local handler
 *  registry over an e2e-encrypted session. Off by default; device credentials and the
 *  identity keys live in the secret store, never in settings or logs. */
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import { WebSocket } from 'ws';
import { enrollTokenContext, generateIdentity, hostAccept, openFrame, openSealedToKey, pairingDecisionPayload, publicOf, randomKeyB64, sealFrame, sign, stable, tokenProofPayload, verify, type Identity, type PublicIdentity, type SealedBlob, type SealedToKey } from '../../shared/crypto';
import { connectCheckCode, connectLink } from '../../shared/pairing';
import type { RemoteAuditEntry, RemoteDeviceInfo, RemoteState } from '../../shared/types';
import type { HandlerRegistry } from '../handlers';
import type { SecretStore } from '../secrets';
import type { Logger } from '../log';
import type { RemoteAudit } from './audit';

/** Channels a paired web client may invoke (docs/REMOTE-ACCESS.md §5). Interactive P3:
 *  chat send/interrupt/stop, session lifecycle and per-session model controls are in; the
 *  terminal is read-only (P3.5 step one) and destructive git stays desktop-only. */
export const REMOTE_CHANNELS = new Set<string>([
  'app:info',
  'settings:get',
  'harness:availability',
  'harness:models',
  'sessions:list',
  'sessions:get',
  'sessions:transcript',
  'sessions:transcriptPage',
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
  'fs:read',
  // P3.5, read-only first: list terminals and read a plain-text screen. No input, resize or attach.
  'terminal:list',
  'terminal:screen'
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
  'sessions:transcriptPage',
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
  'fs:read',
  // P3.5, read-only first: list terminals and read a plain-text screen. No input, resize or attach.
  'terminal:list',
  'terminal:screen'
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
  /** The relay refresh credential. It buys short-lived access tokens only together with a
   *  signature by `identity`; it is dropped once the relay stops accepting it. */
  deviceToken?: string;
  enrollToken?: string;
  /** Web devices paired with this host, by deviceId — the handshake trust anchors. */
  clients: Record<string, PublicIdentity>;
  /** P4: the symmetric key that seals the offline transcript mirror. Shared with every paired
   *  browser over the e2e session; never written to the relay. */
  mirrorKey?: string;
}

/** Refresh the access token this long before it expires. */
const ACCESS_REFRESH_MARGIN_MS = 60_000;
const RECONNECT_MS = 3000;
/** Connect with GitHub: how often to ask whether the owner added this computer, and for how long
 *  (the relay keeps an owner's grant ten minutes). */
const SIGN_IN_POLL_MS = 2000;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

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
  t: 'pair.request' | 'pair.result' | 'pair.error' | 'hs' | 'd' | 'client.gone' | 'device.revoked';
  code?: string;
  error?: string;
  devices?: unknown;
  name?: string;
  platform?: string;
  decision?: 'approve' | 'deny';
  hostToken?: string;
  hostDeviceId?: string;
  webToken?: string;
  webDeviceId?: string;
  webPub?: PublicIdentity;
  /** A signed-in browser asked this computer by id, rather than claiming a code it minted. */
  requested?: boolean;
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
  /** Connect with GitHub, while the owner has not added this computer yet. */
  private signingIn: { link: string; checkCode: string } | undefined;
  private readonly sessions = new Map<string, Session>();
  /** Serialize handshake and ciphertext delivery per peer, not across unrelated clients. */
  private readonly incoming = new Map<string, Promise<void>>();
  /** Bumped on enable/disable so a pending reconnect timer can be invalidated. */
  private generation = 0;
  /** The short-lived relay access token (§6.2), in memory only. */
  private access: { token: string; expiresAt: number; deviceId: string } | null = null;
  private refreshing: Promise<string> | null = null;

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
    }
  ) {}

  state(): RemoteState {
    return {
      status: this.status,
      detail: this.detail,
      pairing: this.pairing,
      pendingRequest: this.pendingRequest,
      onlineClients: [...this.sessions.keys()],
      viewOnly: this.deps.viewOnly?.() ?? false,
      registered: this.enrolled(),
      ...(this.signingIn ? { signIn: this.signingIn } : {})
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

  /** Connect with GitHub: register this computer through a signed-in browser instead of the
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
    const gen = this.generation;
    const nonce = randomBytes(32).toString('base64url');
    const nonceHash = createHash('sha256').update(nonce).digest('hex');
    this.signingIn = { link: connectLink(relayUrl, nonceHash), checkCode: connectCheckCode(nonceHash) };
    this.status = 'connecting';
    this.detail = 'finish in your browser: sign in with GitHub and add this computer';
    this.deps.log('info', 'remote: waiting for this computer to be added in the browser (Connect with GitHub)');
    this.deps.audit?.record('sign-in-start');
    this.push();
    await open(this.signingIn.link);
    void this.awaitSignIn(nonce, nonceHash, gen, hostName);
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
    this.signingIn = undefined;
    this.push();
  }

  /** Loads or creates this computer's identity for `relayUrl`, without connecting. */
  private async prepare(relayUrl: string, enrollToken: string): Promise<void> {
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
  }

  /** Polls the relay until the owner adds this computer, the page's grant expires, or remote
   *  access is disabled (which bumps the generation). */
  private async awaitSignIn(nonce: string, nonceHash: string, gen: number, hostName: string): Promise<void> {
    const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
    while (gen === this.generation && Date.now() < deadline) {
      const creds = this.creds;
      if (!creds) return;
      try {
        const res = await fetch(`${this.base()}/v1/enroll/redeem`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nonce, hostPub: publicOf(creds.identity), name: hostName, platform: `${process.platform} ${process.arch}` })
        });
        const body = res.ok ? ((await res.json()) as { status?: string; hostDeviceId?: unknown; sealedToken?: SealedToKey }) : null;
        if (gen !== this.generation || this.creds !== creds) return;
        if (body?.status === 'registered' && typeof body.hostDeviceId === 'string' && body.sealedToken) {
          const token = await openSealedToKey(creds.identity.enc, body.sealedToken, enrollTokenContext(nonceHash, body.hostDeviceId));
          if (gen !== this.generation || this.creds !== creds) return;
          creds.deviceId = body.hostDeviceId;
          creds.deviceToken = token;
          await this.saveCreds();
          this.signingIn = undefined;
          this.detail = undefined;
          this.deps.log('info', `remote: this computer was added in the browser (device ${body.hostDeviceId})`);
          this.deps.audit?.record('sign-in-registered', { device: body.hostDeviceId });
          await this.connect();
          return;
        }
      } catch (e) {
        // A network blip or a relay restart: keep waiting for the owner.
        this.deps.log('debug', `remote: sign-in poll failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, SIGN_IN_POLL_MS));
    }
    if (gen !== this.generation) return;
    this.signingIn = undefined;
    this.status = 'error';
    this.detail = 'the sign-in page expired before this computer was added; connect again';
    this.push();
  }

  /** Requests a pairing code. An enrolled desktop authenticates as its own device; only the first
   *  enrollment needs the account's enrollment secret, so rotating it never strands this host. */
  async startPairing(hostName: string): Promise<{ code: string; expiresAt: number }> {
    const creds = this.creds;
    if (!creds) throw new Error('remote access is not enabled');
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: hostName, platform: `${process.platform} ${process.arch}`, hostPub: publicOf(creds.identity) })
    };
    // An enrolled desktop pairs as itself. If the relay rejects its credential on the way, the
    // desktop is no longer enrolled and falls back to the enrollment secret.
    let res = this.enrolled() ? await this.relayFetch('/v1/pair/start', init).catch((e: unknown) => (this.enrolled() ? Promise.reject(e) : null)) : null;
    res ??= await fetch(`${this.base()}/v1/pair/start`, { ...init, headers: { ...init.headers, authorization: `Bearer ${creds.enrollToken ?? ''}` } });
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
    if (!this.enrolled()) return [];
    // The device id is routing metadata; the access token travels only in Authorization.
    const res = await this.relayFetch('/v1/devices');
    if (!res.ok) throw new Error(`devices failed: ${res.status}`);
    return (await res.json()) as RemoteDeviceInfo[];
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const creds = this.creds;
    if (!creds || !this.enrolled()) return;
    // The caller authenticates as itself; `target` names the device to drop.
    const res = await this.relayFetch(`/v1/devices?target=${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`revoke failed: ${res.status}`);
    const revoked = await res.json().then((body: { revoked?: unknown }) => (Array.isArray(body.revoked) ? body.revoked.map(String) : [deviceId]), () => [deviceId]);
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
    const res = await this.relayFetch('/v1/devices/revoke-all', { method: 'POST' });
    if (!res.ok) throw new Error(`revoke all failed: ${res.status}`);
    this.deps.audit?.record('revoke-all');
    this.pendingRequest = undefined;
    this.pairing = undefined;
    await this.dropClients(creds, Object.keys(creds.clients), 'every other device revoked');
    this.push();
  }

  /** Session ids this desktop has mirrored at the relay (routing metadata only). */
  async mirroredSessions(): Promise<string[]> {
    if (!this.enrolled()) return [];
    const res = await this.relayFetch('/v1/mirrors');
    if (!res.ok) throw new Error(`mirror list failed: ${res.status}`);
    return ((await res.json()) as Array<{ sessionId: string }>).map((entry) => entry.sessionId);
  }

  async deleteMirrorSession(sessionId: string): Promise<void> {
    if (!this.enrolled()) return;
    const res = await this.relayFetch(`/v1/mirror/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`mirror delete failed: ${res.status}`);
  }

  /** The offline-mirror policy changed: part of the audit trail like any other trust decision. */
  auditMirror(enabled: boolean): void {
    this.deps.audit?.record(enabled ? 'mirror-enable' : 'mirror-disable');
  }

  /** The key that seals the offline mirror, or null before remote access was ever enabled. */
  mirrorSecret(): string | null {
    return this.creds?.mirrorKey ?? null;
  }

  /** Publishes a sealed mirror blob to the relay. False when not enrolled or the relay refused it. */
  async putMirror(kind: 'index' | 'session', sessionId: string | undefined, blob: SealedBlob): Promise<boolean> {
    if (!this.enrolled()) return false;
    const path = kind === 'index' ? '/v1/mirror' : `/v1/mirror/${encodeURIComponent(sessionId ?? '')}`;
    const res = await this.relayFetch(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(blob)
    }).catch(() => null);
    if (!res?.ok) this.deps.log('warn', `remote: mirror upload refused (${res?.status ?? 'network error'})`);
    return !!res?.ok;
  }

  /** Drops the whole mirror at the relay (used when the user turns mirroring off). */
  async clearMirror(): Promise<void> {
    if (!this.enrolled()) return;
    await this.relayFetch('/v1/mirror', { method: 'DELETE' }).catch(() => undefined);
  }

  // --- internals ---

  private push(): void {
    this.deps.pushState();
  }

  private base(): string {
    return (this.creds?.relayUrl ?? '').replace(/\/$/, '');
  }

  /** Registered with the relay: a device id and a refresh credential it still accepts. */
  private enrolled(): boolean {
    return !!(this.creds?.deviceId && this.creds.deviceToken);
  }

  /** A short-lived access token, refreshed a minute before expiry (§6.2). Concurrent callers
   *  share one refresh. */
  private async accessToken(): Promise<string> {
    const creds = this.creds;
    if (!creds?.deviceId || !creds.deviceToken) throw new Error('remote access is not enrolled');
    const cached = this.access;
    if (cached && cached.deviceId === creds.deviceId && cached.expiresAt - Date.now() > ACCESS_REFRESH_MARGIN_MS) return cached.token;
    this.refreshing ??= this.refreshAccess(creds).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Proof of possession: the refresh credential buys a one-time challenge, the device key signs
   *  it, and only that signature buys an access token. A stolen credential alone gets nothing. */
  private async refreshAccess(creds: HostCredentials): Promise<string> {
    const deviceId = creds.deviceId!;
    const refresh = creds.deviceToken!;
    const query = `?device=${encodeURIComponent(deviceId)}`;
    const challengeRes = await fetch(`${this.base()}/v1/token/challenge${query}`, { method: 'POST', headers: { authorization: `Bearer ${refresh}` } });
    if (challengeRes.status === 401) {
      await this.forgetRegistration(creds, 'this computer is no longer registered with the relay; pair a browser to register it again', refresh);
      throw new Error('relay credential rejected');
    }
    if (!challengeRes.ok) throw new Error(`token challenge failed: ${challengeRes.status}`);
    const { challenge } = (await challengeRes.json()) as { challenge?: unknown };
    if (typeof challenge !== 'string' || !challenge) throw new Error('relay returned no token challenge');
    const signature = await sign(creds.identity, tokenProofPayload(deviceId, challenge));
    const tokenRes = await fetch(`${this.base()}/v1/token${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${refresh}`, 'content-type': 'application/json' },
      body: JSON.stringify({ challenge, signature })
    });
    if (!tokenRes.ok) throw new Error(`token request failed: ${tokenRes.status}`);
    const body = (await tokenRes.json()) as { accessToken?: unknown; expiresAt?: unknown };
    if (typeof body.accessToken !== 'string' || typeof body.expiresAt !== 'number') throw new Error('relay returned no access token');
    if (this.creds === creds && creds.deviceToken === refresh) this.access = { token: body.accessToken, expiresAt: body.expiresAt, deviceId };
    return body.accessToken;
  }

  /** An authenticated relay REST call as this device. A 401 means the access token expired or was
   *  dropped: prove possession once more and retry, then report whatever the relay says. */
  private async relayFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const creds = this.creds;
    if (!creds?.deviceId) throw new Error('remote access is not enrolled');
    const url = `${this.base()}${path}${path.includes('?') ? '&' : '?'}device=${encodeURIComponent(creds.deviceId)}`;
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });
      if (res.status !== 401 || attempt > 0) return res;
      if (this.access?.token === token) this.access = null;
    }
  }

  /** The relay no longer accepts this desktop's credential: revoked (from any device, or with a
   *  revoke-all), or issued by a different relay. Stop using it, but keep the identity and the
   *  paired browsers: re-pairing re-registers the same key, and a relay that still knows this
   *  desktop keeps its host id; reconciliation then drops the browsers it no longer lists. */
  private async forgetRegistration(creds: HostCredentials, detail: string, rejected?: string): Promise<void> {
    if (this.creds !== creds || (rejected !== undefined && creds.deviceToken !== rejected) || !creds.deviceToken) return;
    delete creds.deviceToken;
    this.access = null;
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
    for (const id of ids) this.sessions.delete(id);
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
    await this.clearMirror();
    this.deps.onMirrorRotated?.();
    for (const clientId of [...this.sessions.keys()]) await this.sendTo(clientId, { type: 'mirror.key', key: creds.mirrorKey });
  }

  private scheduleReconnect(): void {
    const gen = this.generation;
    setTimeout(() => {
      if (gen === this.generation) void this.connect();
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
    const creds = this.creds;
    if (!creds) return;
    const gen = this.generation;
    this.status = 'connecting';
    this.push();
    let auth = creds.enrollToken ?? '';
    if (this.enrolled()) {
      try {
        auth = await this.accessToken();
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
    const ws = new WebSocket(`${this.base()}/v1/ws/host?device=${encodeURIComponent(device)}`, { headers: { authorization: `Bearer ${auth}` } });
    this.ws = ws;
    this.incoming.clear();
    let opened = false;
    ws.on('open', () => {
      opened = true;
      if (this.ws !== ws) return;
      this.status = enrolled ? 'online' : 'connecting';
      if (enrolled) this.detail = undefined;
      this.deps.log('info', `remote: relay connection open (${enrolled ? 'online' : 'awaiting enrollment'})`);
      this.push();
      if (enrolled) void this.reconcile();
    });
    ws.on('message', (data) => void this.onMessage(String(data), ws));
    ws.on('close', (code: number) => {
      // A refused upgrade may mean this access token is no longer good (expired, or the device
      // was revoked): the next attempt proves possession again, which settles which it was.
      if (!opened && this.access?.token === auth) this.access = null;
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
    switch (msg.t) {
      case 'pair.request': {
        // Either a code this desktop minted was claimed, or a signed-in owner's browser asked this
        // registered computer by id. Both need the user's Allow here, signed with this key.
        const minted = !!this.pairing && msg.code === this.pairing.code;
        const requested = msg.requested === true && this.enrolled();
        if (!this.creds || typeof msg.code !== 'string' || !(minted || requested) ||
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
      case 'device.revoked': {
        // A hint that some device was revoked: re-read the registry rather than trust the list.
        void this.reconcile();
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

