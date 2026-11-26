/** Desktop pairing state machine and Connect-with-Vocs browser sign-in flow for RemoteHost. */
import { createHash, randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { enrollTokenContext, openSealedToKey, pairingDecisionPayload, publicOf, sign, stable, type PublicIdentity, type SealedToKey } from '../../shared/crypto';
import { connectCheckCode, connectLink } from '../../shared/pairing';
import type { RemoteState } from '../../shared/types';
import type { RemoteAudit } from './audit';
import { relayBaseUrl, relayRequest, type HostCredentials } from './relay-client';

/** Owner-requested pairings have the same five-minute local decision window as minted codes. */
const PAIRING_REQUEST_TIMEOUT_MS = 5 * 60_000;
/** Connect with Vocs: how often to ask whether the owner added this computer, and for how long
 *  (the relay keeps an owner's grant ten minutes). */
const SIGN_IN_POLL_MS = 2000;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

export interface PendingPairingRequest {
  code: string;
  name: string;
  platform: string;
  webPub: PublicIdentity;
  expiresAt: number;
}

export interface PairingWireMessage {
  code?: string;
  error?: string;
  name?: string;
  platform?: string;
  decision?: 'approve' | 'deny';
  hostToken?: string;
  hostDeviceId?: string;
  webDeviceId?: string;
  webPub?: PublicIdentity;
  /** A signed-in browser asked this computer by id, rather than claiming a code it minted. */
  requested?: boolean;
  hostPub?: PublicIdentity;
}

export interface HostPairingDeps {
  getCreds: () => HostCredentials | null;
  getSocket: () => WebSocket | null;
  enrolled: () => boolean;
  generation: () => number;
  relayFetch: (path: string, init?: RequestInit) => Promise<Response>;
  saveCreds: () => Promise<void>;
  connect: () => Promise<void>;
  setStatus: (status: RemoteState['status'], detail?: string) => void;
  setDetail: (detail: string | undefined) => void;
  push: () => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  audit?: RemoteAudit;
}

export class HostPairingController {
  private pairing: { code: string; expiresAt: number } | undefined;
  private pendingRequest: PendingPairingRequest | undefined;
  /** Relay correlation alone grants no trust: only this local, request-bound decision can. */
  private pairingResponse: {
    request: PendingPairingRequest;
    webPub: PublicIdentity;
    decision: 'approve' | 'deny';
    socket: WebSocket;
    creds: HostCredentials;
    sent: boolean;
  } | undefined;
  private pairingAttempt = 0;
  /** Connect with Vocs, while the owner has not added this computer yet. */
  private signingIn: { link: string; checkCode: string } | undefined;

  constructor(private readonly deps: HostPairingDeps) {}

  stateSnapshot(): Pick<RemoteState, 'pairing' | 'pendingRequest'> & { signIn?: { link: string; checkCode: string } } {
    return {
      pairing: this.pairing,
      pendingRequest: this.pendingRequest,
      ...(this.signingIn ? { signIn: this.signingIn } : {})
    };
  }

  clearPairing(): void {
    this.pendingRequest = undefined;
    this.pairingResponse = undefined;
    this.pairing = undefined;
  }

  /** Decisions belong to one socket; a minted code remains claimable after reconnect. */
  clearDecision(): void {
    this.pendingRequest = undefined;
    this.pairingResponse = undefined;
  }

  cancelAll(): void {
    this.pairingAttempt++;
    this.clearPairing();
    this.signingIn = undefined;
  }

  abortPairing(): void {
    this.pairingAttempt++;
    this.clearPairing();
  }

  /** Begins the Connect with Vocs browser flow for an unenrolled desktop. */
  async beginSignIn(relayUrl: string, open: (url: string) => Promise<void>, hostName: string, gen: number): Promise<void> {
    const nonce = randomBytes(32).toString('base64url');
    const nonceHash = createHash('sha256').update(nonce).digest('hex');
    this.signingIn = { link: connectLink(relayUrl, nonceHash), checkCode: connectCheckCode(nonceHash) };
    this.deps.setStatus('connecting', 'finish in your browser: sign in with your Vocs account and add this computer');
    this.deps.log('info', 'remote: waiting for this computer to be added in the browser (Connect with Vocs)');
    this.deps.audit?.record('sign-in-start');
    this.deps.push();
    await open(this.signingIn.link);
    void this.awaitSignIn(nonce, nonceHash, gen, hostName);
  }

  /** Polls the relay until the owner adds this computer, the page's grant expires, or remote
   *  access is disabled (which bumps the generation). */
  private async awaitSignIn(nonce: string, nonceHash: string, gen: number, hostName: string): Promise<void> {
    const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
    while (gen === this.deps.generation() && Date.now() < deadline) {
      const creds = this.deps.getCreds();
      if (!creds) return;
      try {
        const res = await relayRequest(`${relayBaseUrl(creds.relayUrl)}/v1/enroll/redeem`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nonce, hostPub: publicOf(creds.identity), name: hostName, platform: `${process.platform} ${process.arch}` })
        });
        const body = res.ok ? ((await res.json()) as { status?: string; hostDeviceId?: unknown; sealedToken?: SealedToKey }) : null;
        if (gen !== this.deps.generation() || this.deps.getCreds() !== creds) return;
        if (body?.status === 'registered' && typeof body.hostDeviceId === 'string' && body.sealedToken) {
          const token = await openSealedToKey(creds.identity.enc, body.sealedToken, enrollTokenContext(nonceHash, body.hostDeviceId));
          if (gen !== this.deps.generation() || this.deps.getCreds() !== creds) return;
          creds.deviceId = body.hostDeviceId;
          creds.deviceToken = token;
          await this.deps.saveCreds();
          this.signingIn = undefined;
          this.deps.setDetail(undefined);
          this.deps.log('info', `remote: this computer was added in the browser (device ${body.hostDeviceId})`);
          this.deps.audit?.record('sign-in-registered', { device: body.hostDeviceId });
          await this.deps.connect();
          return;
        }
      } catch (e) {
        // A network blip or a relay restart: keep waiting for the owner.
        this.deps.log('debug', `remote: sign-in poll failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, SIGN_IN_POLL_MS));
    }
    if (gen !== this.deps.generation()) return;
    this.signingIn = undefined;
    this.deps.setStatus('error', 'the sign-in page expired before this computer was added; connect again');
    this.deps.push();
  }

  /** Requests a pairing code. An enrolled desktop authenticates as itself; the shared enrollment
   *  secret remains only for legacy `vocs-v1` manual enrollment. New accounts use Connect with Vocs. */
  async startPairing(hostName: string): Promise<{ code: string; expiresAt: number }> {
    const creds = this.deps.getCreds();
    if (!creds) throw new Error('remote access is not enabled');
    this.clearPairing();
    const attempt = ++this.pairingAttempt;
    this.deps.push();
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: hostName, platform: `${process.platform} ${process.arch}`, hostPub: publicOf(creds.identity) })
    };
    // An enrolled desktop pairs as itself. If the relay rejects its credential on the way, the
    // desktop is no longer enrolled and falls back to the enrollment secret.
    let res = this.deps.enrolled() ? await this.deps.relayFetch('/v1/pair/start', init).catch((e: unknown) => (this.deps.enrolled() ? Promise.reject(e) : null)) : null;
    res ??= await relayRequest(`${relayBaseUrl(creds.relayUrl)}/v1/pair/start`, { ...init, headers: { ...init.headers, authorization: `Bearer ${creds.enrollToken ?? ''}` } });
    if (!res.ok) throw new Error(`pair/start failed: ${res.status}`);
    const body = (await res.json()) as { code: string; expiresAt: number };
    if (this.deps.getCreds() !== creds || this.pairingAttempt !== attempt) throw new Error('pairing request cancelled');
    this.pairing = { code: body.code, expiresAt: body.expiresAt };
    this.deps.audit?.record('pair-start');
    this.deps.push();
    return body;
  }

  /** The human decision on a pending pairing request. */
  async respondPairing(decision: 'approve' | 'deny'): Promise<void> {
    if (decision !== 'approve' && decision !== 'deny') return;
    const pending = this.pendingRequest;
    const socket = this.deps.getSocket();
    const creds = this.deps.getCreds();
    if (!pending || !socket || !creds || socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() >= pending.expiresAt) {
      this.clearPairing();
      this.deps.push();
      return;
    }
    // First decision wins, except that Deny may cancel an Allow still being signed/sent.
    // Record it before signing so a slower Allow cannot overtake that cancellation.
    if (this.pairingResponse && (decision === 'approve' || this.pairingResponse.decision === 'deny')) return;
    const response = { request: pending, webPub: structuredClone(pending.webPub), decision, socket, creds, sent: false };
    this.pairingResponse = response;
    try {
      const signature = await sign(creds.identity, pairingDecisionPayload(pending.code, decision, response.webPub));
      if (this.pairingResponse !== response || this.deps.getSocket() !== socket || this.deps.getCreds() !== creds ||
          this.pendingRequest !== pending || socket.readyState !== WebSocket.OPEN || Date.now() >= pending.expiresAt) return;
      // Arm BEFORE send: an honest relay can answer before this async method completes.
      response.sent = true;
      socket.send(JSON.stringify({ t: 'pair.respond', code: pending.code, decision, signature }));
    } catch (error) {
      if (this.pairingResponse === response) this.clearPairing();
      this.deps.push();
      throw error;
    }
  }

  handlePairRequest(msg: PairingWireMessage): void {
    // Either a code this desktop minted was claimed, or a signed-in owner's browser asked this
    // registered computer by id. Both need the user's Allow here, signed with this key.
    const creds = this.deps.getCreds();
    const minted = !!this.pairing && msg.code === this.pairing.code && Date.now() < this.pairing.expiresAt;
    const requested = msg.requested === true && this.deps.enrolled();
    if (!creds || typeof msg.code !== 'string' || !(minted || requested) ||
        !msg.hostPub || !msg.webPub || stable(msg.hostPub) !== stable(publicOf(creds.identity))) return;
    this.pairingResponse = undefined;
    this.pendingRequest = {
      code: msg.code, name: String(msg.name ?? ''), platform: String(msg.platform ?? ''), webPub: msg.webPub,
      expiresAt: Math.min(minted ? this.pairing!.expiresAt : Infinity, Date.now() + PAIRING_REQUEST_TIMEOUT_MS)
    };
    this.deps.log('info', `remote: pairing request from "${this.pendingRequest.name}" (${this.pendingRequest.platform}); awaiting the user's decision`);
    this.deps.audit?.record('pair-request', { detail: `${this.pendingRequest.name} (${this.pendingRequest.platform})` });
    this.deps.push();
  }

  async handlePairResult(msg: PairingWireMessage, socket: WebSocket): Promise<void> {
    const response = this.pairingResponse;
    const creds = this.deps.getCreds();
    if (!response?.sent || response.request !== this.pendingRequest || response.socket !== socket ||
        response.creds !== creds || msg.code !== response.request.code || msg.decision !== response.decision ||
        Date.now() >= response.request.expiresAt) return;
    if (msg.decision === 'approve') {
      if (!creds || typeof msg.hostDeviceId !== 'string' || !msg.hostDeviceId ||
          typeof msg.webDeviceId !== 'string' || !msg.webDeviceId || !msg.webPub ||
          stable(msg.webPub) !== stable(response.webPub)) return;
      // A registered host cannot be moved to another device/account or have its credential
      // replaced by a pairing result. Re-enrollment alone may supply a new host credential.
      if (this.deps.enrolled()
        ? msg.hostDeviceId !== creds.deviceId || (msg.hostToken !== undefined && msg.hostToken !== creds.deviceToken)
        : typeof msg.hostToken !== 'string' || !msg.hostToken) return;
      const existing = creds.clients[msg.webDeviceId];
      if (existing && stable(existing) !== stable(response.webPub)) return;
    }
    // Consume before awaiting persistence: duplicate results cannot reuse one human decision.
    this.clearPairing();
    this.deps.setDetail(undefined);
    this.deps.log('info', `remote: pairing ${msg.decision === 'approve' ? 'approved' : 'denied'}${msg.webDeviceId ? ` for device ${msg.webDeviceId}` : ''}`);
    this.deps.audit?.record(msg.decision === 'approve' ? 'pair-approve' : 'pair-deny', { device: msg.webDeviceId ? String(msg.webDeviceId) : undefined });
    if (msg.decision === 'approve' && msg.hostDeviceId && msg.webDeviceId && creds) {
      creds.clients[msg.webDeviceId] = response.webPub;
      // The relay mints a host device only when this approval enrolled the desktop; an
      // enrolled desktop keeps its id and token, so browsers paired before stay routable.
      const enrolledNow = !!msg.hostToken && (creds.deviceId !== msg.hostDeviceId || creds.deviceToken !== msg.hostToken);
      if (msg.hostToken) {
        creds.deviceId = msg.hostDeviceId;
        creds.deviceToken = msg.hostToken;
      }
      await this.deps.saveCreds();
      if (this.deps.getCreds() !== creds || this.deps.getSocket() !== socket) return;
      if (enrolledNow) {
        // Reconnect under the real device token.
        this.deps.getSocket()?.close();
        await this.deps.connect();
      }
    }
    this.deps.push();
  }

  handlePairError(msg: PairingWireMessage): void {
    // The relay refused the decision: the request is spent, so do not leave it on screen.
    if (!this.pendingRequest || (msg.code !== undefined && msg.code !== this.pendingRequest.code)) return;
    this.clearPairing();
    const detail = msg.error === 'device-limit'
      ? 'pairing refused: this account already has the maximum number of paired devices; revoke one first'
      : 'pairing refused by the relay';
    this.deps.setDetail(detail);
    this.deps.log('warn', `remote: ${detail}`);
    this.deps.audit?.record('pair-deny', { detail });
    this.deps.push();
  }
}
