/** Connect with Vocs: registers this computer with the relay through the owner's signed-in browser. */
import { createHash, randomBytes } from 'node:crypto';
import { enrollTokenContext, openSealedToKey, publicOf, type SealedToKey } from '../../shared/crypto';
import { connectCheckCode, connectLink } from '../../shared/pairing';
import type { RemoteState } from '../../shared/types';
import { relayBaseUrl, relayRequest, type HostCredentials } from './relay-client';

/** How often to ask whether the owner added this computer, and for how long (the relay keeps an
 *  owner's grant ten minutes). */
const SIGN_IN_POLL_MS = 2000;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

export interface HostSignInDeps {
  getCreds: () => HostCredentials | null;
  generation: () => number;
  saveCreds: () => Promise<void>;
  connect: () => Promise<void>;
  setStatus: (status: RemoteState['status'], detail?: string) => void;
  setDetail: (detail: string | undefined) => void;
  push: () => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export class HostSignIn {
  /** Set while the owner has not added this computer yet. */
  private signingIn: { link: string; checkCode: string } | undefined;

  constructor(private readonly deps: HostSignInDeps) {}

  pending(): { link: string; checkCode: string } | undefined {
    return this.signingIn;
  }

  cancel(): void {
    this.signingIn = undefined;
  }

  /** Opens the Connect with Vocs page for an unregistered computer, then waits for the owner. */
  async begin(relayUrl: string, open: (url: string) => Promise<void>, hostName: string, gen: number): Promise<void> {
    const nonce = randomBytes(32).toString('base64url');
    const nonceHash = createHash('sha256').update(nonce).digest('hex');
    this.signingIn = { link: connectLink(relayUrl, nonceHash), checkCode: connectCheckCode(nonceHash) };
    this.deps.setStatus('connecting', 'finish in your browser: sign in with your Vocs account and add this computer');
    this.deps.log('info', 'remote: waiting for this computer to be added in the browser (Connect with Vocs)');
    this.deps.push();
    await open(this.signingIn.link);
    void this.await(nonce, nonceHash, gen, hostName);
  }

  /** Polls the relay until the owner adds this computer, the page's grant expires, or the
   *  connection is turned off (which bumps the generation). */
  private async await(nonce: string, nonceHash: string, gen: number, hostName: string): Promise<void> {
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
}
