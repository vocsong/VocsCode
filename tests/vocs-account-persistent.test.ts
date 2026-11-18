/** "Keep me signed in": device enrollment, vault, restore, rotation and sign-out against a fake
 *  issuer that follows the identity-service contract. Uses the real MCP SDK and loopback callback. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createVocsAccount, VOCS_REALMS, vocsAccountVaultId, vocsDeviceName, type VocsAccountVault } from '../src/main/vocs-account';
import { createNativeMcpOAuth } from '../src/main/mcp/oauth';
import type { VocsAccountRealm, VocsAccountState } from '../src/shared/vocs-account';

const YEAR = 365 * 24 * 60 * 60 * 1000;
const ENDED = 'Your sign-in ended. Sign in again.';
const brokers: ReturnType<typeof createVocsAccount>[] = [];
afterEach(() => { for (const broker of brokers.splice(0)) broker.dispose(); vi.useRealTimers(); });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
const token = (n: number | string) => `rt${String(n).padStart(41, '0')}`; // 43 base64url chars, like the issuer's
const catalogBody = (realm: VocsAccountRealm, id = 'a'.repeat(64)) => {
  const T = VOCS_REALMS[realm];
  return {
    version: 1, account: { id, identityIssuer: T.identityIssuer },
    connections: [{ id: 'openrouter', name: 'OpenRouter', transport: 'streamable-http', resource: T.hub + '/openrouter', authorizationServer: T.hub, accountScopes: ['models:read'], authorization: 'oauth_required', executionReadiness: 'not_checked' }],
    policy: { authorizationRequiredPerResource: true, localServersSynced: false, offlineCloudAccess: false }
  };
};
function netError(code: string) { return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) }); }

/** In-memory stand-in for SecretStore with an ordered event log. */
function memoryVault(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const events: string[] = [];
  const vault = {
    data, events, memoryOnly: false, failSet: false,
    get: vi.fn(async (id: string) => data.get(id)),
    set: vi.fn(async (id: string, value: string) => {
      if (vault.failSet) { events.push(`vault:set-failed:${id}`); throw new Error('disk full'); }
      events.push(`vault:set:${id}:${(JSON.parse(value) as { refreshToken: string }).refreshToken}`);
      data.set(id, value);
    }),
    clear: vi.fn(async (id: string) => { events.push(`vault:clear:${id}`); data.delete(id); }),
    isMemoryOnly: (id: string) => { void id; return vault.memoryOnly; }
  };
  return vault;
}
type Vault = ReturnType<typeof memoryVault>;

/** A fake identity service + Hub following persistent-login-spec.md. */
function issuer(realm: VocsAccountRealm = 'staging', vault: Vault = memoryVault()) {
  const T = VOCS_REALMS[realm];
  let browserUrl: URL | undefined;
  let serial = 0;
  let deviceSerial = 0;
  const events = vault.events;
  const live = new Map<string, { deviceId: string; expiresAt: number }>(); // refresh token -> grant
  const revoked: string[] = [];
  const access = new Set<string>();
  const catalogAccount = { id: 'a'.repeat(64) };
  const enrollment = vi.fn(async (params: URLSearchParams): Promise<Response> => {
    const deviceId = `dev-${++deviceSerial}`, refresh = token(`e${deviceSerial}`), at = `at-${++serial}`;
    live.set(refresh, { deviceId, expiresAt: Date.now() + YEAR }); access.add(at);
    void params;
    return Response.json({ access_token: at, token_type: 'Bearer', expires_in: 300, scope: 'catalog:read', refresh_token: refresh, device_id: deviceId, device_expires_at: Date.now() + YEAR });
  });
  const refresh = vi.fn(async (params: URLSearchParams): Promise<Response> => {
    const grant = live.get(params.get('refresh_token')!);
    if (!grant) return Response.json({ error: 'invalid_grant' }, { status: 400 });
    live.delete(params.get('refresh_token')!);
    const next = token(++serial), at = `at-${serial}`;
    live.set(next, grant); access.add(at);
    return Response.json({ access_token: at, token_type: 'Bearer', expires_in: 300, scope: 'catalog:read', refresh_token: next, device_id: grant.deviceId, device_expires_at: grant.expiresAt });
  });
  const revoke = vi.fn(async (params: URLSearchParams): Promise<Response> => {
    const value = params.get('token')!; revoked.push(value); live.delete(value);
    return new Response(null, { status: 200 });
  });
  const catalog = vi.fn(async (): Promise<Response> => Response.json(catalogBody(realm, catalogAccount.id)));
  const temporaryExchange = vi.fn(async (): Promise<Response> => { const at = `at-${++serial}`; access.add(at); return Response.json({ access_token: at, token_type: 'Bearer', expires_in: 300, scope: 'catalog:read' }); });
  const urls: string[] = [];
  const network = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); urls.push(url);
    expect(init?.redirect).toBe('manual');
    const headers = new Headers(init?.headers);
    if (url === T.resource) {
      const bearer = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      events.push(`catalog:${bearer}`);
      if (!access.has(bearer)) return new Response(null, { status: 401 });
      return catalog();
    }
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
    expect(headers.has('origin')).toBe(false);
    if (url.includes('.well-known/oauth-protected-resource')) return Response.json({ resource: T.resource, authorization_servers: [T.issuer], scopes_supported: ['catalog:read'] });
    if (url.includes('.well-known/')) return Response.json({
      issuer: T.issuer, authorization_endpoint: T.issuer + '/oauth2/authorize', token_endpoint: T.issuer + '/oauth2/token',
      response_types_supported: ['code'], grant_types_supported: ['authorization_code'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256']
    });
    const params = new URLSearchParams(String(init?.body));
    expect(params.has('client_secret')).toBe(false);
    if (url === T.issuer + '/oauth2/revoke') { events.push(`revoke:${params.get('token')}`); return revoke(params); }
    if (url === T.issuer + '/oauth2/token') {
      expect(params.get('resource')).toBe(T.resource);
      if (params.get('grant_type') === 'refresh_token') {
        expect(params.get('client_id')).toBe('vocs-code-device');
        events.push(`refresh:${params.get('refresh_token')}`);
        return refresh(params);
      }
      expect(params.get('grant_type')).toBe('authorization_code');
      expect(new URL(params.get('redirect_uri')!).pathname).toBe('/oauth/vocs');
      expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(browserUrl!.searchParams.get('code_challenge'));
      if (params.get('client_id') === 'vocs-code') { expect(params.has('device_name')).toBe(false); return temporaryExchange(); }
      expect(params.get('client_id')).toBe('vocs-code-device');
      return enrollment(params);
    }
    throw new Error(`Unexpected endpoint ${url}`);
  });
  const browser = vi.fn(async (url: string) => {
    browserUrl = new URL(url);
    expect(browserUrl.searchParams.get('resource')).toBe(T.resource);
    const callback = new URL(browserUrl.searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', 'synthetic-code'); callback.searchParams.set('state', browserUrl.searchParams.get('state')!);
    await fetch(callback);
  });
  const lastBrowserUrl = () => browserUrl;
  return { T, vault, events, network, browser, enrollment, refresh, revoke, catalog, temporaryExchange, live, revoked, urls, catalogAccount, lastBrowserUrl };
}
type Issuer = ReturnType<typeof issuer>;
function broker(f: Issuer, extra: Partial<Parameters<typeof createVocsAccount>[0]> = {}) {
  const b = createVocsAccount({ realm: f.T === VOCS_REALMS.production ? 'production' : 'staging', fetch: f.network as typeof fetch, openExternal: f.browser, timeoutMs: 2000, vault: f.vault as VocsAccountVault, platform: 'win32', ...extra });
  brokers.push(b);
  return b;
}
const stored = (f: Issuer, realm: VocsAccountRealm = 'staging') => {
  const raw = f.vault.data.get(vocsAccountVaultId(realm));
  return raw === undefined ? undefined : JSON.parse(raw) as Record<string, unknown>;
};
/** A valid vault record for an issuer-side grant that the fake issuer knows. */
function seed(f: Issuer, realm: VocsAccountRealm = 'staging', patch: Record<string, unknown> = {}) {
  const T = VOCS_REALMS[realm];
  const refresh = token('seed'), deviceId = 'dev-seed', deviceExpiresAt = Date.now() + YEAR - 1000;
  f.live.set(refresh, { deviceId, expiresAt: deviceExpiresAt });
  const record = { v: 1, issuer: T.issuer, clientId: 'vocs-code-device', resource: T.resource, deviceId, refreshToken: refresh, deviceExpiresAt, ...patch };
  f.vault.data.set(vocsAccountVaultId(realm), JSON.stringify(record));
  return record;
}
/** Every string a renderer or log could have seen must be free of token material. */
function expectNoSecrets(values: unknown[], f: Issuer) {
  const text = JSON.stringify(values);
  expect(text).not.toMatch(/rt0{2,}|at-\d|refresh_token|access_token|refreshToken/);
  for (const secret of [...f.live.keys(), ...f.revoked]) expect(text).not.toContain(secret);
}

describe('device enrollment ("Keep me signed in")', () => {
  it('enrolls the device client with the platform label and keeps the exact vault record', async () => {
    const f = issuer(); const b = broker(f);
    const state = await b.signIn({ persist: true });
    expect(state).toMatchObject({ status: 'signed_in', persistent: true, accountId: 'a'.repeat(64), keychain: true });
    expect(state.deviceExpiresAt).toBeGreaterThan(Date.now() + YEAR - 60_000);
    expect(state.expiresAt).toBeUndefined();
    expect(f.lastBrowserUrl()!.searchParams.get('client_id')).toBe('vocs-code-device');
    expect(f.enrollment.mock.calls[0]![0].get('device_name')).toBe('Vocs Code on Windows');
    const record = stored(f)!;
    expect(Object.keys(record).sort()).toEqual(['clientId', 'deviceExpiresAt', 'deviceId', 'issuer', 'refreshToken', 'resource', 'v']);
    expect(record).toMatchObject({ v: 1, issuer: f.T.issuer, clientId: 'vocs-code-device', resource: f.T.resource, deviceId: 'dev-1', refreshToken: token('e1'), deviceExpiresAt: state.deviceExpiresAt });
    expectNoSecrets([state, b.get()], f);
  });

  it('labels the device by platform only', () => {
    expect(vocsDeviceName('win32')).toBe('Vocs Code on Windows');
    expect(vocsDeviceName('darwin')).toBe('Vocs Code on macOS');
    expect(vocsDeviceName('linux')).toBe('Vocs Code on Linux');
  });

  it('writes the refresh token to the vault before the access token is first used', async () => {
    const f = issuer(); const b = broker(f);
    await b.signIn({ persist: true });
    const write = f.events.findIndex(e => e.startsWith('vault:set:'));
    const use = f.events.findIndex(e => e.startsWith('catalog:'));
    expect(write).toBeGreaterThanOrEqual(0); expect(use).toBeGreaterThan(write);
  });

  it('persist=false keeps the existing vocs-code flow and never writes the vault', async () => {
    const f = issuer(); const b = broker(f);
    const state = await b.signIn({ persist: false });
    expect(state).toMatchObject({ status: 'signed_in' }); expect(state.persistent).toBeUndefined();
    expect(state.expiresAt).toBeGreaterThan(Date.now());
    expect(f.lastBrowserUrl()!.searchParams.get('client_id')).toBe('vocs-code');
    expect(f.enrollment).not.toHaveBeenCalled(); expect(f.temporaryExchange).toHaveBeenCalledTimes(1);
    expect(f.vault.set).not.toHaveBeenCalled();
    await b.signOut(); expect(f.vault.set).not.toHaveBeenCalled();
    expect(await broker(f).signIn()).toMatchObject({ status: 'signed_in' }); // no argument = temporary
    expect(f.vault.set).not.toHaveBeenCalled();
  });

  it('a temporary sign-in replaces a kept one: the record is cleared and its device revoked', async () => {
    const f = issuer(); const record = seed(f);
    const state = await broker(f).signIn({ persist: false });
    expect(state.status).toBe('signed_in');
    await vi.waitFor(() => expect(f.revoked).toContain(record.refreshToken));
    expect(stored(f)).toBeUndefined(); expect(f.vault.set).not.toHaveBeenCalled();
  });

  it('falls back to a clear message when the issuer does not offer the device client yet', async () => {
    const f = issuer('production'); f.enrollment.mockImplementation(async () => Response.json({ error: 'invalid_client', error_description: 'PRIVATE_DETAIL' }, { status: 401 }));
    const state = await broker(f).signIn({ persist: true });
    expect(state).toMatchObject({ status: 'signed_out', realm: 'production' });
    expect(state.error).toMatch(/not available for this Vocs account yet.*Keep me signed in on this computer/);
    expect(state.error).not.toContain('PRIVATE_DETAIL'); expect(f.vault.set).not.toHaveBeenCalled(); expect(f.catalog).not.toHaveBeenCalled();
  });

  it('says so when the authorization redirect refuses the device client', async () => {
    const f = issuer('production');
    f.browser.mockImplementation(async (url: string) => {
      const browserUrl = new URL(url); const callback = new URL(browserUrl.searchParams.get('redirect_uri')!);
      callback.searchParams.set('error', 'unauthorized_client'); callback.searchParams.set('state', browserUrl.searchParams.get('state')!);
      await fetch(callback);
    });
    const state = await broker(f).signIn({ persist: true });
    expect(state.status).toBe('signed_out'); expect(state.error).toMatch(/not available for this Vocs account yet/);
  });

  it('asks for a fresh browser sign-in when enrollment needs one', async () => {
    const f = issuer(); f.enrollment.mockImplementation(async () => Response.json({ error: 'invalid_grant', error_description: 'fresh_sign_in_required' }, { status: 400 }));
    const state = await broker(f).signIn({ persist: true });
    expect(state.status).toBe('signed_out'); expect(state.error).toMatch(/fresh sign-in/); expect(f.vault.set).not.toHaveBeenCalled();
  });

  it('a failed catalog after enrollment ends the new device instead of leaving it behind', async () => {
    const f = issuer(); f.catalog.mockResolvedValue(new Response(null, { status: 403 }));
    const state = await broker(f).signIn({ persist: true });
    expect(state.status).toBe('signed_out'); expect(state.error).toMatch(/staging administrator/);
    await vi.waitFor(() => expect(f.revoked).toContain(token('e1')));
    await vi.waitFor(() => expect(stored(f)).toBeUndefined());
  });

  it('cancel after enrollment revokes the device and forgets its record', async () => {
    const f = issuer(); const held = deferred<Response>(); f.catalog.mockImplementationOnce(() => held.promise);
    const b = broker(f); const pending = b.signIn({ persist: true });
    await vi.waitFor(() => expect(f.catalog).toHaveBeenCalledTimes(1));
    b.cancel(); held.resolve(Response.json(catalogBody('staging')));
    expect((await pending).status).toBe('signed_out');
    await vi.waitFor(() => expect(f.revoked).toContain(token('e1')));
    await vi.waitFor(() => expect(stored(f)).toBeUndefined());
  });

  it('vault write failure keeps the sign-in in memory for this run and tells the user', async () => {
    const f = issuer(); f.vault.failSet = true; const b = broker(f);
    const state = await b.signIn({ persist: true });
    expect(state).toMatchObject({ status: 'signed_in', persistent: true });
    expect(state.notice).toMatch(/could not save your sign-in on this computer/);
    expect(stored(f)).toBeUndefined();
    // The in-memory token rotates normally (the fake issuer rejects a stale one).
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 301_000);
    expect((await b.refresh()).status).toBe('signed_in');
    expect(f.refresh).toHaveBeenCalledTimes(1); expect(f.refresh.mock.calls[0]![0].get('refresh_token')).toBe(token('e1'));
    expect(b.get().notice).toMatch(/could not save/);
  });

  it('without an OS keychain the state says so and the sign-in lasts this run', async () => {
    const f = issuer(); f.vault.memoryOnly = true; const b = broker(f);
    expect(b.get().keychain).toBe(false);
    const state = await b.signIn({ persist: true });
    expect(state).toMatchObject({ status: 'signed_in', persistent: true, keychain: false });
  });
});

describe('restore and refresh', () => {
  it('restores in the background, rotating the token into the vault before using it', async () => {
    const f = issuer(); const record = seed(f); const b = broker(f);
    const pending = b.restore();
    expect(b.get().status).toBe('restoring');
    const state = await pending;
    expect(state).toMatchObject({ status: 'signed_in', persistent: true, accountId: 'a'.repeat(64), deviceExpiresAt: record.deviceExpiresAt });
    expect(state.connections).toHaveLength(1);
    const next = stored(f)!.refreshToken as string;
    expect(next).not.toBe(record.refreshToken);
    expect(f.events.filter(e => !e.startsWith('vault:clear'))).toEqual([`refresh:${record.refreshToken}`, `vault:set:${vocsAccountVaultId('staging')}:${next}`, `catalog:at-1`]);
    expectNoSecrets([state], f);
  });

  it('with nothing kept, restore stays signed out without any request', async () => {
    const f = issuer(); const state = await broker(f).restore();
    expect(state.status).toBe('signed_out'); expect(f.network).not.toHaveBeenCalled();
  });

  it('single-flights the refresh grant across concurrent callers', async () => {
    const f = issuer(); seed(f); const held = deferred<void>();
    const original = f.refresh.getMockImplementation()!;
    f.refresh.mockImplementation(async (params) => { await held.promise; return original(params); });
    const b = broker(f);
    const calls = [b.restore(), b.restore(), b.refresh(), b.refresh()];
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
    held.resolve();
    const states = await Promise.all(calls);
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(states.at(-1)!.status === 'signed_in' || b.get().status === 'signed_in').toBe(true);
    await vi.waitFor(() => expect(b.get().status).toBe('signed_in'));
    // An expired access token renews once even when Refresh is pressed twice.
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 301_000);
    f.refresh.mockImplementation(async (params) => { await held.promise; return original(params); });
    await Promise.all([b.refresh(), b.refresh()]);
    expect(f.refresh).toHaveBeenCalledTimes(2);
  });

  it('a refresh after expiry rotates first, then reads the catalog with the new access token', async () => {
    const f = issuer(); const b = broker(f); await b.signIn({ persist: true });
    f.events.length = 0;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 301_000);
    expect((await b.refresh()).status).toBe('signed_in');
    expect(f.events).toEqual([`refresh:${token('e1')}`, `vault:set:${vocsAccountVaultId('staging')}:${token(2)}`, 'catalog:at-2']);
  });

  it('invalid_grant clears the vault and says the sign-in ended', async () => {
    const f = issuer(); seed(f); f.live.clear(); // revoked on the account page
    const state = await broker(f).restore();
    expect(state).toMatchObject({ status: 'signed_out', error: ENDED });
    await vi.waitFor(() => expect(stored(f)).toBeUndefined());
    expect(f.catalog).not.toHaveBeenCalled();
  });

  it.each(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'])('a failure before the request is sent (%s) is offline with Retry, keeping the vault', async (code) => {
    const f = issuer(); const record = seed(f); const original = f.network.getMockImplementation()!;
    f.network.mockImplementation(async (input, init) => { if (String(input).endsWith('/oauth2/token')) throw netError(code); return original(input, init); });
    const b = broker(f);
    const state = await b.restore();
    expect(state).toMatchObject({ status: 'offline', connections: [] }); expect(state.error).toBeUndefined();
    expect(stored(f)!.refreshToken).toBe(record.refreshToken); expect(f.vault.clear).not.toHaveBeenCalled();
    f.network.mockImplementation(original);
    expect((await b.refresh()).status).toBe('signed_in'); // Retry
  });

  it('is offline without sending anything when the OS reports no network', async () => {
    const f = issuer(); seed(f); let online = false;
    const b = broker(f, { isOnline: () => online });
    expect((await b.restore()).status).toBe('offline'); expect(f.refresh).not.toHaveBeenCalled();
    online = true; expect((await b.refresh()).status).toBe('signed_in');
  });

  it('503 temporarily_unavailable keeps the vault and offers Retry', async () => {
    const f = issuer(); const record = seed(f); f.refresh.mockResolvedValueOnce(Response.json({ error: 'temporarily_unavailable' }, { status: 503 }));
    const state = await broker(f).restore();
    expect(state.status).toBe('offline'); expect(state.error).toMatch(/temporarily unavailable/);
    expect(stored(f)!.refreshToken).toBe(record.refreshToken);
  });

  it.each([
    ['a reset after sending', async () => { throw netError('ECONNRESET'); }],
    ['an unexplained 500', async () => new Response('oops', { status: 500 })],
    ['a malformed 200', async () => Response.json({ access_token: 'x' })]
  ])('an unknown outcome (%s) is treated as ended', async (_name, failure) => {
    const f = issuer(); const record = seed(f); const original = f.network.getMockImplementation()!;
    f.network.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/oauth2/token')) { f.events.push('refresh'); return failure(); }
      return original(input, init);
    });
    const state = await broker(f).restore();
    expect(state).toMatchObject({ status: 'signed_out', error: ENDED });
    await vi.waitFor(() => expect(stored(f)).toBeUndefined());
    await vi.waitFor(() => expect(f.revoked).toContain(record.refreshToken)); // best effort
  });

  it('a timeout after sending is an unknown outcome too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = issuer(); seed(f); const original = f.network.getMockImplementation()!;
    f.network.mockImplementation(async (input, init) => String(input).endsWith('/oauth2/token') ? new Promise<Response>(() => undefined) : original(input, init));
    const b = broker(f); const pending = b.restore();
    await vi.advanceTimersByTimeAsync(15_001);
    expect((await pending)).toMatchObject({ status: 'signed_out', error: ENDED });
  });

  it('a catalog failure after restore keeps the device and reports the connections error', async () => {
    const f = issuer(); seed(f); f.catalog.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const b = broker(f); const state = await b.restore();
    expect(state).toMatchObject({ status: 'signed_in', persistent: true, connections: [] }); expect(state.error).toMatch(/could not be loaded/);
    expect(stored(f)).toBeDefined();
    expect((await b.refresh()).connections).toHaveLength(1); // access token still valid: no new rotation
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });

  it('ends at the absolute device expiry', async () => {
    const f = issuer(); const b = broker(f); await b.signIn({ persist: true });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(b.get().deviceExpiresAt! + 1);
    expect(b.get()).toMatchObject({ status: 'signed_out', error: ENDED });
    await vi.waitFor(() => expect(stored(f)).toBeUndefined());
  });

  it('dispose (quit) keeps the vault so the next start restores', async () => {
    const f = issuer(); const b = broker(f); await b.signIn({ persist: true });
    b.dispose(); expect(stored(f)).toBeDefined(); expect(f.vault.clear).not.toHaveBeenCalled();
    expect((await broker(f).restore()).status).toBe('signed_in');
  });
});

describe('tampered or foreign records', () => {
  it.each<[string, (f: Issuer) => void]>([
    ['another issuer', f => { seed(f, 'staging', { issuer: 'https://evil.invalid/api/auth' }); }],
    ['another client', f => { seed(f, 'staging', { clientId: 'vocs-code' }); }],
    ['another resource', f => { seed(f, 'staging', { resource: 'https://evil.invalid/api/connections' }); }],
    ['an extra field', f => { seed(f, 'staging', { tokenEndpoint: 'https://evil.invalid/token' }); }],
    ['a newer version', f => { seed(f, 'staging', { v: 2 }); }],
    ['an expired device', f => { seed(f, 'staging', { deviceExpiresAt: Date.now() - 1 }); }],
    ['an expiry past a year', f => { seed(f, 'staging', { deviceExpiresAt: Date.now() + 2 * YEAR }); }],
    ['a malformed token', f => { seed(f, 'staging', { refreshToken: 'short' }); }],
    ['broken JSON', f => { f.vault.data.set(vocsAccountVaultId('staging'), '{"v":1,'); }],
    ['the production record in the staging slot', f => { f.vault.data.set(vocsAccountVaultId('staging'), JSON.stringify({ ...seed(f, 'production') })); }]
  ])('ignores and removes %s without any request', async (_name, plant) => {
    const f = issuer('staging'); plant(f);
    const state = await broker(f).restore();
    expect(state.status).toBe('signed_out'); expect(f.network).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(stored(f, 'staging')).toBeUndefined());
  });
});

describe('sign-out', () => {
  it('clears the vault first, then revokes the refresh token with the device client', async () => {
    const f = issuer(); const b = broker(f); await b.signIn({ persist: true });
    f.events.length = 0;
    const state = await b.signOut();
    expect(state).toMatchObject({ status: 'signed_out', connections: [] }); expect(state.error).toBeUndefined();
    expect(f.events).toEqual([`vault:clear:${vocsAccountVaultId('staging')}`, `revoke:${token('e1')}`]);
    const params = f.revoke.mock.calls[0]![0];
    expect(Object.fromEntries(params)).toEqual({ client_id: 'vocs-code-device', token: token('e1'), token_type_hint: 'refresh_token' });
    expect((await broker(f).restore()).status).toBe('signed_out');
  });

  it('works offline: the vault is cleared and the user is told revocation was not confirmed', async () => {
    const f = issuer(); seed(f); const original = f.network.getMockImplementation()!;
    f.network.mockImplementation(async () => { throw netError('ENOTFOUND'); });
    const b = broker(f); expect((await b.restore()).status).toBe('offline');
    const state = await b.signOut();
    expect(state.status).toBe('signed_out'); expect(state.error).toMatch(/could not confirm.*revoked/);
    expect(stored(f)).toBeUndefined();
    f.network.mockImplementation(original);
  });

  it('signs out of a kept sign-in still restoring, and its late rotation is revoked, not stored', async () => {
    const f = issuer(); const record = seed(f); const held = deferred<void>();
    const original = f.refresh.getMockImplementation()!;
    // The issuer rotates on arrival; only its answer is late. Revoking the consumed token does nothing.
    f.refresh.mockImplementation(async (params) => { const answer = await original(params); await held.promise; return answer; });
    const b = broker(f); const restoring = b.restore();
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
    const out = await b.signOut();
    expect(out.status).toBe('signed_out'); expect(stored(f)).toBeUndefined();
    expect(f.revoked).toEqual([record.refreshToken]);
    held.resolve(); await restoring;
    await vi.waitFor(() => expect(f.revoked).toHaveLength(2));
    expect(f.live.size).toBe(0); // the rotated token was revoked too
    expect(stored(f)).toBeUndefined(); expect(f.vault.set).not.toHaveBeenCalled();
    expect(b.get().status).toBe('signed_out'); expect(f.catalog).not.toHaveBeenCalled();
  });

  it('switching accounts revokes the old device and keeps only the new record', async () => {
    const f = issuer(); const b = broker(f);
    await b.signIn({ persist: true }); await b.signOut();
    f.catalogAccount.id = 'b'.repeat(64);
    const state = await b.signIn({ persist: true });
    expect(state).toMatchObject({ status: 'signed_in', accountId: 'b'.repeat(64) });
    expect(stored(f)).toMatchObject({ deviceId: 'dev-2', refreshToken: token('e2') });
    expect(f.revoked).toEqual([token('e1')]);
  });

  it('signing in again from offline replaces the kept device after the new sign-in succeeds', async () => {
    const f = issuer(); const record = seed(f); let online = false;
    const b = broker(f, { isOnline: () => online, platform: 'linux' });
    expect((await b.restore()).status).toBe('offline');
    online = true;
    expect((await b.signIn({ persist: true })).status).toBe('signed_in');
    expect(f.enrollment.mock.calls[0]![0].get('device_name')).toBe('Vocs Code on Linux');
    expect(stored(f)).toMatchObject({ deviceId: 'dev-1' });
    await vi.waitFor(() => expect(f.revoked).toEqual([record.refreshToken]));
  });
});

describe('a new sign-in during a restore', () => {
  it('wins: the old device\'s late rotation is revoked and never overwrites the new record', async () => {
    const f = issuer(); seed(f); const held = deferred<void>();
    const original = f.refresh.getMockImplementation()!;
    f.refresh.mockImplementation(async (params) => { const answer = await original(params); await held.promise; return answer; });
    const b = broker(f); const restoring = b.restore();
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
    expect((await b.signIn({ persist: true })).status).toBe('signed_in');
    held.resolve(); await restoring;
    await vi.waitFor(() => expect(f.live.size).toBe(1)); // only the new device is still live
    expect(stored(f)).toMatchObject({ deviceId: 'dev-1', refreshToken: token('e1') });
    expect(b.get()).toMatchObject({ status: 'signed_in', persistent: true });
  });
});

describe('realm separation', () => {
  it('keeps staging and production records independent', async () => {
    const vault = memoryVault();
    const staging = issuer('staging', vault); const production = issuer('production', vault);
    const prodRecord = seed(production, 'production');
    await broker(staging).signIn({ persist: true });
    expect(stored(staging, 'staging')).toMatchObject({ issuer: VOCS_REALMS.staging.issuer });
    expect(stored(production, 'production')).toEqual(prodRecord);
    await brokers.at(-1)!.signOut();
    expect(stored(production, 'production')).toEqual(prodRecord);
    expect(production.network).not.toHaveBeenCalled();
    const restored = await broker(production).restore();
    expect(restored).toMatchObject({ realm: 'production', status: 'signed_in' });
    expect(production.urls.every(url => !url.includes('staging'))).toBe(true);
  });
});

describe('no token reaches the renderer, the logs or the SDK', () => {
  it('every state across a full lifecycle is free of token material', async () => {
    const f = issuer(); seed(f); const b = broker(f); const seen: VocsAccountState[] = [];
    seen.push(b.get(), await b.restore(), b.get());
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 301_000);
    seen.push(await b.refresh(), await b.signOut(), await b.signIn({ persist: true }), await b.signOut());
    vi.useRealTimers();
    expectNoSecrets(seen, f);
  });

  it('the SDK provider never holds the refresh token; the device grant is handed over once', async () => {
    const f = issuer();
    const client = createNativeMcpOAuth({ resource: f.T.resource, issuer: f.T.issuer, scopes: ['catalog:read'], clientId: 'vocs-code-device', callbackPath: '/oauth/vocs', maxTokenAgeSeconds: 300, openExternal: f.browser, fetch: f.network as typeof fetch, timeoutMs: 2000, deviceName: 'Vocs Code on macOS' });
    await client.authorize();
    expect(f.enrollment.mock.calls[0]![0].get('device_name')).toBe('Vocs Code on macOS');
    const held = await client.provider.tokens();
    expect(held).toBeDefined(); expect(held!.refresh_token).toBeUndefined();
    expect(JSON.stringify(client.credentialSnapshot())).not.toContain(token('e1'));
    expect(client.takeDeviceGrant()).toMatchObject({ refreshToken: token('e1'), deviceId: 'dev-1' });
    expect(client.takeDeviceGrant()).toBeUndefined();
    client.clear();
  });

  it('rejects a device name outside the contract', () => {
    expect(() => createNativeMcpOAuth({ resource: VOCS_REALMS.staging.resource, issuer: VOCS_REALMS.staging.issuer, scopes: ['catalog:read'], openExternal: async () => undefined, deviceName: 'x'.repeat(61) })).toThrow(/device name/);
  });
});
