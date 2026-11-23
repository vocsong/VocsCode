import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createVocsAccount, VOCS_REALMS, VOCS_STAGING, vocsAccountRealm } from '../src/main/vocs-account';
import type { VocsAccountRealm } from '../src/shared/vocs-account';

const account = (id = 'a'.repeat(64), T: { identityIssuer: string; hub: string } = VOCS_STAGING) => ({
  version: 1, account: { id, identityIssuer: T.identityIssuer },
  connections: [{ id: 'openrouter', name: 'OpenRouter', transport: 'streamable-http', resource: T.hub + '/openrouter', authorizationServer: T.hub, accountScopes: ['models:read'], authorization: 'oauth_required', executionReadiness: 'not_checked' }],
  policy: { authorizationRequiredPerResource: true, localServersSynced: false, offlineCloudAccess: false }
});
const brokers: ReturnType<typeof createVocsAccount>[] = [];
afterEach(() => { for (const broker of brokers.splice(0)) broker.dispose(); vi.useRealTimers(); });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
function fixture(tokenOptions: Record<string, unknown> = {}, realm: VocsAccountRealm | null = 'staging') {
  const T = VOCS_REALMS[realm ?? 'production'];
  let browserUrl: URL | undefined;
  const calls: string[] = [];
  const catalog = vi.fn(async () => Response.json(account(undefined, T)));
  const revoke = vi.fn(async () => new Response(null, { status: 200 }));
  const exchange = vi.fn(async () => Response.json({ access_token: 'private-native-token', token_type: 'Bearer', expires_in: 300, scope: 'catalog:read', ...tokenOptions }));
  const network = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push(url);
    expect(init?.redirect).toBe('manual');
    if (url === T.resource) {
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-native-token');
      return catalog();
    }
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(new Headers(init?.headers).has('cookie')).toBe(false);
    expect(new Headers(init?.headers).has('origin')).toBe(false);
    if (url.includes('.well-known/oauth-protected-resource')) return Response.json({ resource: T.resource, authorization_servers: [T.issuer], scopes_supported: ['catalog:read'] });
    if (url.includes('.well-known/')) return Response.json({
      issuer: T.issuer, authorization_endpoint: T.issuer + '/oauth2/authorize', token_endpoint: T.issuer + '/oauth2/token',
      response_types_supported: ['code'], grant_types_supported: ['authorization_code'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256']
    });
    const params = new URLSearchParams(String(init?.body));
    expect(params.get('client_id')).toBe('vocs-code');
    expect(params.has('client_secret')).toBe(false);
    if (url === T.issuer + '/oauth2/revoke') { expect(params.get('token')).toBe('private-native-token'); return revoke(); }
    if (url === T.issuer + '/oauth2/token') {
      expect(params.get('resource')).toBe(T.resource);
      expect(new URL(params.get('redirect_uri')!).pathname).toBe('/oauth/vocs');
      expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(browserUrl!.searchParams.get('code_challenge'));
      return exchange();
    }
    throw new Error('Unexpected endpoint');
  });
  const openExternal = vi.fn(async (url: string) => {
    browserUrl = new URL(url);
    expect(browserUrl.searchParams.get('client_id')).toBe('vocs-code');
    expect(browserUrl.searchParams.get('resource')).toBe(T.resource);
    expect(browserUrl.searchParams.get('scope')).toBe('catalog:read');
    const callback = new URL(browserUrl.searchParams.get('redirect_uri')!);
    expect(callback.hostname).toBe('127.0.0.1'); expect(callback.pathname).toBe('/oauth/vocs');
    callback.searchParams.set('code', 'synthetic-code'); callback.searchParams.set('state', browserUrl.searchParams.get('state')!);
    expect((await fetch(callback)).status).toBe(200);
  });
  const broker = createVocsAccount({ ...(realm ? { realm } : {}), fetch: network as typeof fetch, openExternal, timeoutMs: 2000 }); brokers.push(broker);
  return { broker, network, calls, catalog, revoke, exchange, openExternal };
}
describe('staging account broker: actual SDK and loopback boundary', () => {
  it('uses static public-client PKCE with exact callback, no registration, and returns only descriptive catalog', async () => {
    const f = fixture(); const state = await f.broker.signIn();
    expect(state.status).toBe('signed_in'); expect(state.accountId).toBe('a'.repeat(64));
    expect(state.connections[0].authorization).toBe('oauth_required');
    expect(f.calls.some(url => url.includes('register'))).toBe(false);
    expect(JSON.stringify(state)).not.toMatch(/private-native-token|refresh_token|client_secret/);
    state.connections[0].accountScopes.push('speech:write'); expect(f.broker.get().connections[0].accountScopes).toEqual(['models:read']);
    await f.broker.signOut(); expect(f.revoke).toHaveBeenCalledTimes(1); expect(f.broker.get().connections).toEqual([]);
  });
  it.each([{ expires_in: 301 }, { scope: 'speech:write' }, { scope: undefined }])('rejects token policy mismatch %j without catalog access', async token => {
    const f = fixture(token); expect((await f.broker.signIn()).status).toBe('signed_out'); expect(f.catalog).not.toHaveBeenCalled();
  });
  it('keeps static client identity on SDK invalid-client retry, with no dynamic registration fallback', async () => {
    const f = fixture(); f.exchange.mockImplementation(async () => new Response(JSON.stringify({ error: 'invalid_client', error_description: 'PRIVATE_DETAIL' }), { status: 400 }));
    const result = await f.broker.signIn(); expect(result.status).toBe('signed_out'); expect(f.calls.some(url => url.includes('register'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_DETAIL');
  });
  it('single-flights repeated sign-in and cancel wins against late uncooperative browser completion', async () => {
    const f = fixture(); const held = deferred<void>(); f.openExternal.mockImplementation(() => held.promise);
    const first = f.broker.signIn(); await vi.waitFor(() => expect(f.openExternal).toHaveBeenCalledTimes(1));
    expect((await f.broker.signIn()).status).toBe('signing_in'); f.broker.cancel(); held.resolve();
    expect((await first).status).toBe('signed_out'); expect(f.exchange).not.toHaveBeenCalled();
  });
  it.each([401, 403, 503])('clears account and stale permissions when catalog returns %s', async status => {
    const f = fixture(); await f.broker.signIn(); f.catalog.mockResolvedValue(new Response('PRIVATE_DETAIL', { status }));
    const state = await f.broker.refresh(); expect(state.status).toBe('signed_out'); expect(state.connections).toEqual([]); expect(state.accountId).toBeUndefined(); expect(state.error).not.toContain('PRIVATE_DETAIL');
    if (status === 403) expect(state.error).toMatch(/staging administrator/);
  });
  it.each([
    { ...account(), account: { id: 'a'.repeat(64), identityIssuer: 'https://auth.vocs.io' } },
    { ...account(), connections: [{ ...account().connections[0], resource: 'https://evil.invalid/mcp' }] },
    { ...account(), connections: [{ ...account().connections[0], accountScopes: ['speech:write'] }] },
    { ...account(), token: 'unexpected-secret-field' }
  ])('rejects untrusted catalog shape or endpoint', async body => {
    const f = fixture(); f.catalog.mockResolvedValue(Response.json(body)); expect((await f.broker.signIn()).status).toBe('signed_out');
  });
  it('rejects unexpected account changes on refresh', async () => {
    const f = fixture(); await f.broker.signIn(); f.catalog.mockResolvedValue(Response.json(account('b'.repeat(64))));
    expect((await f.broker.refresh()).status).toBe('signed_out'); expect(f.broker.get().accountId).toBeUndefined();
  });
  it('cancel clears pending catalog fetch and ignores late success after a new sign-in', async () => {
    const f = fixture(); await f.broker.signIn(); const held = deferred<Response>(); f.catalog.mockImplementationOnce(() => held.promise);
    const old = f.broker.refresh(); await vi.waitFor(() => expect(f.broker.get().refreshing).toBe(true));
    f.broker.cancel(); await f.broker.signIn(); const revision = f.broker.get().revision;
    held.resolve(Response.json(account('b'.repeat(64)))); await old;
    expect(f.broker.get().accountId).toBe('a'.repeat(64)); expect(f.broker.get().revision).toBe(revision);
  });
  it('signout clears immediately and failed old revocation cannot overwrite new sign-in', async () => {
    const f = fixture(); await f.broker.signIn(); const held = deferred<Response>(); f.revoke.mockImplementationOnce(() => held.promise);
    const old = f.broker.signOut(); expect(f.broker.get().status).toBe('signed_out'); await f.broker.signIn(); const revision = f.broker.get().revision;
    held.resolve(new Response(null, { status: 500 })); await old;
    expect(f.broker.get().status).toBe('signed_in'); expect(f.broker.get().error).toBeUndefined(); expect(f.broker.get().revision).toBe(revision);
  });
  it('reports local-only signout if server revocation fails without retaining credentials', async () => {
    const f = fixture(); await f.broker.signIn(); f.revoke.mockResolvedValue(new Response(null, { status: 500 }));
    const state = await f.broker.signOut(); expect(state.status).toBe('signed_out'); expect(state.error).toMatch(/Remote revocation was not confirmed/);
    expect(state.connections).toEqual([]); await f.broker.refresh(); expect(f.catalog).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized bodies and clears a delayed body on cancellation', async () => {
    const f = fixture(); f.catalog.mockResolvedValue(new Response(' '.repeat(65537))); expect((await f.broker.signIn()).status).toBe('signed_out');
    f.catalog.mockImplementation(async () => new Response(new ReadableStream({ start() { /* never emits */ } })));
    const pending = f.broker.signIn(); await vi.waitFor(() => expect(f.catalog).toHaveBeenCalledTimes(2)); f.broker.cancel();
    expect((await pending).status).toBe('signed_out');
  });
  it('expires automatically during a pending refresh and cannot resurrect catalog', async () => {
    const f = fixture({ expires_in: 1 }); await f.broker.signIn(); const held = deferred<Response>(); f.catalog.mockImplementationOnce(() => held.promise);
    const pending = f.broker.refresh(); await new Promise(r => setTimeout(r, 1050)); held.resolve(Response.json(account())); await pending;
    expect(f.broker.get().status).toBe('signed_out'); expect(f.broker.get().connections).toEqual([]);
  });
  it('does not extend original expiry while first catalog response is delayed', async () => {
    const f = fixture({ expires_in: 1 }); f.catalog.mockImplementation(async () => { await new Promise(r => setTimeout(r, 1050)); return Response.json(account()); });
    expect((await f.broker.signIn()).status).toBe('signed_out');
  });
  it('does not leak synchronous controller construction errors', async () => {
    const broker = createVocsAccount({ openExternal: async () => {}, createOAuth: () => { throw new Error('PRIVATE_DETAIL'); } }); brokers.push(broker);
    const state = await broker.signIn(); expect(state.status).toBe('signed_out'); expect(state.error).not.toContain('PRIVATE_DETAIL');
  });
});

describe('account realm', () => {
  it('is production unless main is launched with VOCS_CODE_ACCOUNT_REALM=staging', () => {
    expect(vocsAccountRealm({})).toBe('production');
    expect(vocsAccountRealm({ VOCS_CODE_ACCOUNT_REALM: 'staging' })).toBe('staging');
    expect(vocsAccountRealm({ VOCS_CODE_ACCOUNT_REALM: 'https://evil.test' })).toBe('production');
  });
  it('signs in against auth.vocs.io and reads the mcp.vocs.io catalog by default', async () => {
    const f = fixture({}, null); // no realm option at all
    const state = await f.broker.signIn();
    expect(state).toMatchObject({ realm: 'production', status: 'signed_in', connections: [{ resource: 'https://mcp.vocs.io/openrouter' }] });
    expect(f.calls).toContain('https://mcp.vocs.io/api/connections');
    expect(f.calls).toContain('https://auth.vocs.io/api/auth/oauth2/token');
    expect(f.calls.some((url) => url.includes('staging'))).toBe(false);
  });
  it('rejects a catalog from the other realm', async () => {
    const f = fixture({}, 'production');
    f.catalog.mockImplementation(async () => Response.json(account(undefined, VOCS_STAGING)));
    const state = await f.broker.signIn();
    expect(state).toMatchObject({ realm: 'production', status: 'signed_out', connections: [] });
    expect(state.accountId).toBeUndefined();
  });
});
