/** Authenticated relay REST client and proof-of-possession access-token cache for RemoteHost. */
import { sign, tokenProofPayload, type Identity, type PublicIdentity } from '../../shared/crypto';
import { assertEndpointUrl, credentialFetch } from '../../shared/endpoint-policy';
import type { RemoteDeviceInfo } from '../../shared/types';
import { MirrorWriteSuperseded } from './mirror-transport';

export const relayRequest = credentialFetch();

export interface HostCredentials {
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

export function relayBaseUrl(relayUrl: string | undefined): string {
  const base = (relayUrl ?? '').replace(/\/$/, '');
  assertEndpointUrl(base);
  return base;
}

export interface RelayClientDeps {
  getCreds: () => HostCredentials | null;
  onCredentialRejected: (creds: HostCredentials, detail: string, rejected: string) => Promise<void>;
}

export class RelayClient {
  /** The short-lived relay access token (§6.2), in memory only. */
  private access: { token: string; expiresAt: number; deviceId: string } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(private readonly deps: RelayClientDeps) {}

  clearAccess(): void {
    this.access = null;
  }

  invalidateIfMatching(token: string): void {
    if (this.access?.token === token) this.access = null;
  }

  /** A short-lived access token, refreshed a minute before expiry (§6.2). Concurrent callers
   *  share one refresh. */
  async accessToken(): Promise<string> {
    const creds = this.deps.getCreds();
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
    const base = relayBaseUrl(creds.relayUrl);
    const query = `?device=${encodeURIComponent(deviceId)}`;
    const challengeRes = await relayRequest(`${base}/v1/token/challenge${query}`, { method: 'POST', headers: { authorization: `Bearer ${refresh}` } });
    if (challengeRes.status === 401) {
      await this.deps.onCredentialRejected(creds, 'this computer is no longer registered with the relay; pair a browser to register it again', refresh);
      throw new Error('relay credential rejected');
    }
    if (!challengeRes.ok) throw new Error(`token challenge failed: ${challengeRes.status}`);
    const { challenge } = (await challengeRes.json()) as { challenge?: unknown };
    if (typeof challenge !== 'string' || !challenge) throw new Error('relay returned no token challenge');
    const signature = await sign(creds.identity, tokenProofPayload(deviceId, challenge));
    const tokenRes = await relayRequest(`${base}/v1/token${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${refresh}`, 'content-type': 'application/json' },
      body: JSON.stringify({ challenge, signature })
    });
    if (!tokenRes.ok) throw new Error(`token request failed: ${tokenRes.status}`);
    const body = (await tokenRes.json()) as { accessToken?: unknown; expiresAt?: unknown };
    if (typeof body.accessToken !== 'string' || typeof body.expiresAt !== 'number') throw new Error('relay returned no access token');
    if (this.deps.getCreds() === creds && creds.deviceToken === refresh) this.access = { token: body.accessToken, expiresAt: body.expiresAt, deviceId };
    return body.accessToken;
  }

  /** An authenticated relay REST call as this device. A 401 means the access token expired or was
   *  dropped: prove possession once more and retry, then report whatever the relay says.
   *  `proceed` is asked right before each request leaves (after the token wait); when it says no,
   *  nothing is sent and the call rejects with MirrorWriteSuperseded. */
  async fetch(path: string, init: RequestInit = {}, proceed?: () => boolean): Promise<Response> {
    const creds = this.deps.getCreds();
    if (!creds?.deviceId) throw new Error('remote access is not enrolled');
    const url = `${relayBaseUrl(creds.relayUrl)}${path}${path.includes('?') ? '&' : '?'}device=${encodeURIComponent(creds.deviceId)}`;
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      if (proceed && !proceed()) throw new MirrorWriteSuperseded();
      const res = await relayRequest(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });
      if (res.status !== 401 || attempt > 0) return res;
      if (this.access?.token === token) this.access = null;
    }
  }

  async listDevices(): Promise<RemoteDeviceInfo[]> {
    // The device id is routing metadata; the access token travels only in Authorization.
    const res = await this.fetch('/v1/devices');
    if (!res.ok) throw new Error(`devices failed: ${res.status}`);
    return (await res.json()) as RemoteDeviceInfo[];
  }

  async revokeDevice(deviceId: string): Promise<string[]> {
    // The caller authenticates as itself; `target` names the device to drop.
    const res = await this.fetch(`/v1/devices?target=${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`revoke failed: ${res.status}`);
    return res.json().then((body: { revoked?: unknown }) => (Array.isArray(body.revoked) ? body.revoked.map(String) : [deviceId]), () => [deviceId]);
  }

  async revokeAll(): Promise<void> {
    const res = await this.fetch('/v1/devices/revoke-all', { method: 'POST' });
    if (!res.ok) throw new Error(`revoke all failed: ${res.status}`);
  }

  async mirroredSessions(): Promise<string[]> {
    const res = await this.fetch('/v1/mirrors');
    if (!res.ok) throw new Error(`mirror list failed: ${res.status}`);
    return ((await res.json()) as Array<{ sessionId: string }>).map((entry) => entry.sessionId);
  }

  async deleteMirrorSession(sessionId: string): Promise<void> {
    const res = await this.fetch(`/v1/mirror/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`mirror delete failed: ${res.status}`);
  }
}
