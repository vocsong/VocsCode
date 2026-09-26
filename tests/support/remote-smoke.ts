/** The remote-access smoke flow against a real relay (docs/REMOTE-ACCESS.md §6): a real
 *  RemoteHost and RelayClient mint, claim, approve, handshake, invoke, share the mirror key, prove
 *  that refresh credentials alone authorize nothing, and revoke — cleaning up every device they
 *  created. Used against a deployed origin (tests/smoke.remote-live.test.ts, opt-in) and against the
 *  real Worker running locally in workerd (tests/remote-workerd.test.ts, every run). */
import { expect } from 'vitest';
import { WebSocket } from 'ws';
import { memoryVault, RelayClient, type SimpleSocket, type WebCredentials } from '../../relay/src/web-client';
import { ACCOUNT_ASSERTION_HEADER, createAccountAssertion, LEGACY_ACCOUNT_ID } from '../../relay/src/account';
import { RemoteHost } from '../../src/main/remote/host';
import { generateIdentity, importAesKey, sealBlob, sign, tokenProofPayload, type AnyIdentity, type Identity } from '../../src/shared/crypto';
import type { HandlerRegistry } from '../../src/main/handlers';
import { recoverApprovedClaim } from './remote-live-recovery';

/** A created device as cleanup sees it: its refresh credential plus the key that proves it. */
type Auth = { deviceId: string; refresh: string; identity: AnyIdentity };
type SavedHost = { deviceId?: string; deviceToken?: string; identity?: Identity; clients?: Record<string, unknown> };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('remote response timed out');
    await sleep(100);
  }
}

async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('remote response timed out')), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Node's ws does not buffer sends during CONNECTING like a browser WebSocket does. */
function wsFactory(url: string, onMessage: (raw: string) => void, onClose: () => void, headers?: Record<string, string>): SimpleSocket {
  const ws = new WebSocket(url, { headers });
  const queued: string[] = [];
  ws.on('open', () => {
    for (const raw of queued.splice(0)) ws.send(raw);
  });
  ws.on('message', (data) => onMessage(String(data)));
  ws.on('close', onClose);
  // The Node socket's error can contain its URL (including the one-use ticket).
  // The handshake's bounded timeout reports failure without exposing that URL.
  ws.on('error', () => undefined);
  return {
    send: (raw) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
      else queued.push(raw);
    },
    close: () => {
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else if (ws.readyState === WebSocket.OPEN) ws.close();
    }
  };
}

/** Proof of possession, as the clients do it: a refresh credential and a signed challenge buy a
 *  short-lived access token. Returns the failing status instead of throwing. */
async function accessFor(origin: string, auth: Auth): Promise<{ status: number; token?: string }> {
  const query = `?device=${encodeURIComponent(auth.deviceId)}`;
  const challengeRes = await fetch(`${origin}/v1/token/challenge${query}`, { method: 'POST', headers: { authorization: `Bearer ${auth.refresh}` } });
  if (!challengeRes.ok) return { status: challengeRes.status };
  const { challenge } = (await challengeRes.json()) as { challenge: string };
  const tokenRes = await fetch(`${origin}/v1/token${query}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${auth.refresh}`, 'content-type': 'application/json' },
    body: JSON.stringify({ challenge, signature: await sign(auth.identity, tokenProofPayload(auth.deviceId, challenge)) })
  });
  if (!tokenRes.ok) return { status: tokenRes.status };
  return { status: 200, token: ((await tokenRes.json()) as { accessToken: string }).accessToken };
}

/** 401 once the relay no longer knows the device; otherwise the status of an authenticated read. */
async function deviceStatus(origin: string, auth: Auth): Promise<number> {
  const access = await accessFor(origin, auth);
  if (!access.token) return access.status;
  return (await fetch(`${origin}/v1/devices?device=${encodeURIComponent(auth.deviceId)}`, { headers: { authorization: `Bearer ${access.token}` } })).status;
}

async function revokeRemaining(origin: string, target: string, targetAuth: Auth | null, actors: Auth[]): Promise<void> {
  if (targetAuth && (await deviceStatus(origin, targetAuth)) === 401) return;
  for (const actor of actors) {
    const access = await accessFor(origin, actor);
    if (!access.token) continue;
    const res = await fetch(`${origin}/v1/devices?device=${encodeURIComponent(actor.deviceId)}&target=${encodeURIComponent(target)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${access.token}` }
    });
    if (!res.ok) throw new Error('device cleanup was refused');
    // The relay reports every device it removed (revoking a desktop cascades to its browsers).
    if (!((await res.json()) as { revoked?: string[] }).revoked?.includes(target)) throw new Error('device remains in the registry');
    if (targetAuth && (await deviceStatus(origin, targetAuth)) !== 401) throw new Error('revoked device is still authorized');
    return;
  }
  throw new Error('no live device can revoke a created device');
}

export async function remoteSmoke(options: {
  origin: string;
  enrollToken: string;
  revealErrors?: boolean;
  /** Local Worker tests sign as the incumbent account; deployed smoke uses its signed-in cookie. */
  accountId?: string;
  accountAssertionSecret?: string;
  sessionCookie?: string;
}): Promise<void> {
  const { origin, enrollToken } = options;
  const originalFetch = globalThis.fetch;
  const fetchWithTimeout: typeof fetch = (input, init) => originalFetch(input, { ...init, signal: AbortSignal.timeout(8_000) });
  // RemoteHost uses global fetch; bound every REST call (including cleanup) so Vitest never
  // times out the test before finally has a chance to revoke both devices.
  globalThis.fetch = fetchWithTimeout;
  const accountId = options.accountId ?? LEGACY_ACCOUNT_ID;
  const browserWsHeaders: Record<string, string> | undefined = options.sessionCookie
    ? { cookie: options.sessionCookie }
    : options.accountAssertionSecret
      ? { [ACCOUNT_ASSERTION_HEADER]: await createAccountAssertion(accountId, 'GET', '/v1/ws/client', options.accountAssertionSecret) }
      : undefined;
  const browserFetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    if (url.pathname.startsWith('/v1/')) {
      if (options.sessionCookie) headers.set('cookie', options.sessionCookie);
      else if (options.accountAssertionSecret) {
        headers.set(ACCOUNT_ASSERTION_HEADER, await createAccountAssertion(accountId, init.method ?? 'GET', url.pathname, options.accountAssertionSecret));
      }
    }
    return fetchWithTimeout(input, { ...init, headers });
  };

  const hostSecrets = new Map<string, string>();
  const calls: string[] = [];
  const registry = {
    channels: () => ['sessions:list' as const],
    invoke: async (channel: string) => {
      calls.push(channel);
      if (channel !== 'sessions:list') throw new Error('unexpected remote channel');
      return [{ id: 'remote-smoke', title: 'Remote smoke' }];
    },
    shutdown: async () => undefined
  } satisfies HandlerRegistry;
  let enrollingOpen = false;
  const host = new RemoteHost({
    registry: () => registry,
    secrets: { get: async (key) => hostSecrets.get(key), set: async (key, value) => { hostSecrets.set(key, value); } },
    pushState: () => undefined,
    log: (_, message) => { if (message.includes('relay connection open (awaiting enrollment)')) enrollingOpen = true; },
    broadcast: () => undefined
  });
  let claimToken: string | undefined;
  let browserIdentity: Identity | undefined;
  let socketUrlSafe = false;
  let ticketRequestSafe = false;
  const client = new RelayClient({
    vault: memoryVault(),
    // Keep the claim identity: recovery after a lost approval poll must open the sealed credential.
    newIdentity: async () => (browserIdentity = await generateIdentity()),
    wsFactory: (url, onMessage, onClose) => {
      const parsed = new URL(url);
      socketUrlSafe = parsed.pathname === '/v1/ws/client' && /^[A-Za-z0-9_-]{43}$/.test(parsed.searchParams.get('ticket') ?? '') &&
        !parsed.searchParams.has('token') && !url.includes(client.credentials()?.webToken ?? 'never-a-token');
      return wsFactory(url, onMessage, onClose, browserWsHeaders);
    },
    fetchImpl: async (input, init) => {
      const response = await browserFetch(input, init);
      if (new URL(String(input)).pathname === '/v1/ws/ticket') {
        // Bought with a short-lived access token in the header, never the refresh credential.
        const authorization = new Headers(init?.headers).get('authorization') ?? '';
        ticketRequestSafe = response.ok && init?.method === 'POST' && /^Bearer [A-Za-z0-9_-]{43}$/.test(authorization) &&
          authorization !== `Bearer ${client.credentials()?.webToken}` && !new URL(String(input)).searchParams.has('token');
      }
      if (String(input).endsWith('/v1/pair/claim') && response.ok) {
        // Keep this run's claimant-only capability in memory for cleanup if the browser's
        // approval response is lost. Never log it or use an unauthenticated code-only poll.
        try {
          const body = (await response.clone().json()) as { pollToken?: unknown };
          if (typeof body.pollToken === 'string') claimToken = body.pollToken;
        } catch { /* RelayClient reports the malformed response itself. */ }
      }
      return response;
    },
    now: () => cancelPairing ? Number.MAX_SAFE_INTEGER : Date.now()
  });
  let code: string | undefined;
  let pairing: Promise<WebCredentials> | undefined;
  let cancelPairing = false;
  let approvalSent = false;
  let mirrorTouched = false;
  let phase = 'enable host';
  let failed: string | null = null;
  const cleanupFailures: string[] = [];

  try {
    await host.enable(origin, enrollToken);
    await waitFor(() => enrollingOpen, 15_000);
    phase = 'mint pairing code';
    ({ code } = await host.startPairing('Remote live smoke host'));
    expect(code).toMatch(/^[A-Z2-9]{8}$/);

    phase = 'claim and deliver pairing request';
    pairing = client.pair({ relayBase: origin, code, deviceName: 'Remote live smoke browser' });
    // A stale relay may return an old claim shape with no private poll capability. Fail at
    // that boundary instead of swallowing the browser rejection and blaming socket delivery.
    const request = await Promise.race([
      waitFor(() => host.state().pendingRequest?.code === code, 20_000).then(() => 'delivered' as const),
      pairing.then(() => 'paired-before-request' as const, () => 'browser-rejected' as const)
    ]);
    if (request !== 'delivered') {
      phase = request === 'browser-rejected' ? 'browser claim/poll failed before desktop request' : 'browser paired before desktop request';
      throw new Error('unexpected pairing outcome (details withheld)');
    }
    phase = 'reject code-only poll';
    expect((await fetch(`${origin}/v1/pair/poll?code=${encodeURIComponent(code)}`)).status).toBe(401);
    phase = 'approve and poll pairing';
    approvalSent = true;
    await host.respondPairing('approve');
    const credentials = await within(pairing, 30_000);
    expect(credentials.webDeviceId.startsWith('w_')).toBe(true);
    expect((await fetch(`${origin}/v1/pair/poll?code=${encodeURIComponent(code)}`)).status).toBe(401);
    await waitFor(() => host.state().status === 'online', 15_000);

    phase = 'e2e handshake';
    await within(client.connect(), 15_000);
    expect(ticketRequestSafe && socketUrlSafe).toBe(true);
    phase = 'sealed invoke';
    expect(await within(client.invoke('sessions:list', null), 35_000)).toEqual([{ id: 'remote-smoke', title: 'Remote smoke' }]);
    expect(calls).toEqual(['sessions:list']);

    phase = 'sealed mirror key and mirror read';
    await waitFor(() => client.hasMirror(), 5_000);
    const secret = host.mirrorSecret();
    expect(!!secret && client.credentials()?.mirrorKey === secret).toBe(true);
    const key = await importAesKey(secret!);
    mirrorTouched = true;
    expect(await host.putMirror('index', undefined, await sealBlob(key, { hostName: 'Remote live smoke', updatedAt: Date.now(), sessions: [] }))).toBe(true);
    expect((await client.mirrorIndex())?.hostName).toBe('Remote live smoke');

    phase = 'refresh credentials alone authorize nothing';
    const saved = JSON.parse(hostSecrets.get('remote-host') ?? '{}') as SavedHost;
    expect(!!saved.deviceId && !!saved.deviceToken && !!saved.identity).toBe(true);
    const hostAuth: Auth = { deviceId: saved.deviceId!, refresh: saved.deviceToken!, identity: saved.identity! };
    const webAuth: Auth = { deviceId: credentials.webDeviceId, refresh: credentials.webToken, identity: credentials.identity };
    expect((await fetch(`${origin}/v1/devices?device=${encodeURIComponent(hostAuth.deviceId)}`, { headers: { authorization: `Bearer ${hostAuth.refresh}` } })).status).toBe(401);

    phase = 'clear test mirror before revocation';
    const hostAccess = await accessFor(origin, hostAuth);
    expect(hostAccess.status).toBe(200);
    const cleared = await fetch(`${origin}/v1/mirror?device=${encodeURIComponent(hostAuth.deviceId)}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${hostAccess.token}` }
    });
    expect(cleared.status).toBe(200);
    mirrorTouched = false;
    expect(await client.mirrorIndex()).toBeNull();

    phase = 'revoke both created devices';
    // Revoking the desktop cascades to the browser paired through it.
    await client.revokeDevice(credentials.hostDeviceId);
    expect(await deviceStatus(origin, hostAuth)).toBe(401);
    expect(await deviceStatus(origin, webAuth)).toBe(401);
  } catch (error) {
    // Against a deployed relay, never print caught exceptions: WebSocket/fetch errors and failed
    // assertions can carry device tokens, private identity material or the mirror key. A local
    // throwaway relay has nothing worth hiding and everything worth diagnosing.
    failed = options.revealErrors ? `${phase}: ${error instanceof Error ? error.message : String(error)}` : phase;
  } finally {
    cancelPairing = true;
    if (pairing) {
      try { await within(pairing.then(() => undefined, () => undefined), 10_000); } catch { cleanupFailures.push('pairing poll did not settle'); }
    }
    try {
      const saved = JSON.parse(hostSecrets.get('remote-host') ?? '{}') as SavedHost;
      const credentials = client.credentials();
      // The relay may have minted both devices even if pair.result or the browser's own poll
      // never arrived. Use only this run's privately captured claim capability to recover the
      // browser credential; a code-only poll would expose a bearer to anyone seeing the code.
      let recovered: { webToken: string; webDeviceId: string; hostDeviceId: string } | null = null;
      if (approvalSent && code && claimToken && browserIdentity && !credentials) {
        try { recovered = await recoverApprovedClaim(origin, code, claimToken, browserIdentity, browserFetch); }
        catch { cleanupFailures.push('private claim recovery failed'); }
      }
      const hostId = saved.deviceId ?? credentials?.hostDeviceId ?? recovered?.hostDeviceId;
      const webId = credentials?.webDeviceId ?? recovered?.webDeviceId ?? Object.keys(saved.clients ?? {})[0];
      const hostAuth: Auth | null = saved.deviceId && saved.deviceToken && saved.identity ? { deviceId: saved.deviceId, refresh: saved.deviceToken, identity: saved.identity } : null;
      const webAuth: Auth | null = credentials?.webToken && credentials.webDeviceId
        ? { deviceId: credentials.webDeviceId, refresh: credentials.webToken, identity: credentials.identity }
        : recovered && browserIdentity ? { deviceId: recovered.webDeviceId, refresh: recovered.webToken, identity: browserIdentity } : null;
      if (approvalSent && (!hostId || !webId)) cleanupFailures.push('could not identify all minted devices');
      if (mirrorTouched) {
        try {
          if (!hostAuth) throw new Error('no host credential');
          const access = await accessFor(origin, hostAuth);
          if (!access.token) throw new Error('no host access');
          const res = await fetch(`${origin}/v1/mirror?device=${encodeURIComponent(hostAuth.deviceId)}`, {
            method: 'DELETE', headers: { authorization: `Bearer ${access.token}` }
          });
          if (!res.ok) throw new Error('mirror cleanup refused');
        } catch { cleanupFailures.push('mirror cleanup failed'); }
      }
      if (webId) {
        try { await revokeRemaining(origin, webId, webAuth, [hostAuth, webAuth].filter((a): a is Auth => a !== null)); }
        catch { cleanupFailures.push('browser device cleanup failed'); }
      }
      if (hostId) {
        try { await revokeRemaining(origin, hostId, hostAuth, [webAuth, hostAuth].filter((a): a is Auth => a !== null)); }
        catch { cleanupFailures.push('host device cleanup failed'); }
      }
      if (code && !approvalSent && host.state().pendingRequest?.code === code) await host.respondPairing('deny');
    } catch { cleanupFailures.push('device cleanup failed'); }
    try { await client.logout(); } catch { cleanupFailures.push('browser socket cleanup failed'); }
    try { await host.disable(); } catch { cleanupFailures.push('host socket cleanup failed'); }
    hostSecrets.clear();
    globalThis.fetch = originalFetch;
  }
  if (failed || cleanupFailures.length) throw new Error(`remote live smoke failed${failed ? ` during ${failed}` : ''}${cleanupFailures.length ? `; ${cleanupFailures.join('; ')}` : ''}${options.revealErrors ? '' : ' (sensitive details withheld)'}`);
}
