/** Vocs MCP Hub connections: Connect (real SDK OAuth + loopback callback), keychain-only refresh
 *  token, the loopback MCP proxy, renewal, revocation and the account lifecycle, against a fake
 *  Hub served by a local HTTP server that follows the mcp.vocs.io contract. A fetch shim maps the
 *  pinned staging Hub origin onto that server; nothing here contacts mcp.vocs.io. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVocsHub, vocsHubVaultId, VOCS_HUB_MESSAGES, VOCS_HUB_VAULT_IDS, type VocsHubOptions } from '../src/main/vocs-hub';
import { VOCS_REALMS, type VocsAccountVault } from '../src/main/vocs-account';
import { inspectServer } from '../src/main/mcp/client';
import { resolveForSession, toCodex, toClaude, type SessionScope } from '../src/main/mcp';
import { defaultSettings } from '../src/main/settings';
import { isReservedSecretId } from '../src/main/secret-ids';
import type { VocsAccountConnection } from '../src/shared/vocs-account';
import type { ResolvedServer } from '../src/main/mcp/effective';

const T = VOCS_REALMS.staging;
const RESOURCE = `${T.hub}/openrouter`;
const ACCOUNT = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const ALL_SCOPES = ['models:read', 'speech:write', 'audio:read'];
const connection = (patch: Partial<VocsAccountConnection> = {}): VocsAccountConnection => ({
  id: 'openrouter', name: 'OpenRouter', transport: 'streamable-http', resource: RESOURCE, authorizationServer: T.hub,
  accountScopes: [...ALL_SCOPES], authorization: 'oauth_required', executionReadiness: 'not_checked', ...patch
});
const refreshToken = (n: number | string) => `rt${String(n).padStart(30, '0')}`;

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

/** In-memory stand-in for SecretStore (keychain-only ids), with the shared ordered event log. */
function memoryVault(events: string[]) {
  const data = new Map<string, string>();
  const vault = {
    data, memoryOnly: false, failSet: false,
    get: vi.fn(async (id: string) => data.get(id)),
    set: vi.fn(async (id: string, value: string) => {
      if (vault.failSet) { events.push(`vault:set-failed:${id}`); throw new Error('disk full'); }
      events.push(`vault:set:${id}:${(JSON.parse(value) as { refreshToken: string }).refreshToken}`);
      data.set(id, value);
    }),
    clear: vi.fn(async (id: string) => { events.push(`vault:clear:${id}`); data.delete(id); }),
    isMemoryOnly: () => vault.memoryOnly
  };
  return vault;
}

/** The fake Hub: RFC 8414/9728 metadata, DCR, S256 code exchange, rotating refresh tokens (the
 *  previous one stays valid until the new one is used), RFC 7009 revocation on /oauth/token without
 *  grant_type, and a stateless JSON-only Streamable HTTP MCP endpoint (GET answers 405). */
async function fakeHub() {
  const events: string[] = [];
  let serial = 0;
  const registrations: Record<string, unknown>[] = [];
  const codes = new Map<string, { clientId: string; challenge: string; scope: string; resource: string; redirect: string }>();
  const live = new Map<string, { clientId: string; scope: string; previous?: string }>();
  const access = new Map<string, number>();
  const revocations: URLSearchParams[] = [];
  const refreshes: URLSearchParams[] = [];
  const mcpHeaders: Record<string, string | string[] | undefined>[] = [];
  const hub = { accessTtl: 900, grantedScope: undefined as string | undefined, revocationStatus: 200, refreshDelayMs: 0, rejectAll: false, omitRefresh: false };
  const issue = (clientId: string, scope: string, previous?: string) => {
    const at = `at-${++serial}`, rt = refreshToken(serial);
    access.set(at, Date.now() + hub.accessTtl * 1000);
    if (!hub.omitRefresh) live.set(rt, { clientId, scope, previous });
    return { access_token: at, token_type: 'Bearer', expires_in: hub.accessTtl, ...(hub.omitRefresh ? {} : { refresh_token: rt }), scope };
  };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://hub.invalid');
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/openrouter') return json(200, { resource: RESOURCE, authorization_servers: [T.hub], scopes_supported: ALL_SCOPES });
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') return json(200, {
      issuer: T.hub, authorization_endpoint: `${T.hub}/oauth/authorize`, token_endpoint: `${T.hub}/oauth/token`, registration_endpoint: `${T.hub}/oauth/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: ALL_SCOPES
    });
    if (req.method === 'POST' && url.pathname === '/oauth/register') {
      const body = JSON.parse(raw) as Record<string, unknown>;
      registrations.push(body);
      events.push('register');
      return json(201, { ...body, client_id: `hub-client-${registrations.length}` });
    }
    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      expect(req.headers['content-type']).toMatch(/^application\/x-www-form-urlencoded/);
      const params = new URLSearchParams(raw);
      expect(params.has('client_secret')).toBe(false);
      const grantType = params.get('grant_type');
      if (grantType === null) {
        revocations.push(params);
        events.push(`revoke:${params.get('token')}`);
        live.delete(params.get('token')!);
        res.writeHead(hub.revocationStatus); res.end(); return;
      }
      if (grantType === 'authorization_code') {
        const code = codes.get(params.get('code') ?? '');
        codes.delete(params.get('code') ?? '');
        if (!code || code.clientId !== params.get('client_id') || code.redirect !== params.get('redirect_uri') || params.get('resource') !== RESOURCE
          || createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url') !== code.challenge) return json(400, { error: 'invalid_grant' });
        events.push('exchange');
        return json(200, issue(code.clientId, hub.grantedScope ?? code.scope));
      }
      if (grantType === 'refresh_token') {
        refreshes.push(params);
        events.push(`refresh:${params.get('refresh_token')}`);
        if (hub.refreshDelayMs) await new Promise((resolve) => setTimeout(resolve, hub.refreshDelayMs));
        const presented = params.get('refresh_token')!;
        const grant = live.get(presented);
        if (!grant || grant.clientId !== params.get('client_id')) return json(400, { error: 'invalid_grant' });
        // Using the new token retires the one it replaced.
        if (grant.previous) live.delete(grant.previous);
        return json(200, issue(grant.clientId, hub.grantedScope ?? grant.scope, presented));
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/openrouter') {
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
      mcpHeaders.push({ ...req.headers });
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      const message = JSON.parse(raw) as { id?: number; method: string };
      events.push(`mcp:${bearer}:${message.method}`);
      const expires = access.get(bearer);
      if (hub.rejectAll || !expires || expires <= Date.now()) return json(401, { error: 'invalid_token' }, { 'WWW-Authenticate': `Bearer resource_metadata="${T.hub}/.well-known/oauth-protected-resource/openrouter"` });
      if (message.id === undefined) { res.writeHead(202); res.end(); return; }
      const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'vocs-openrouter', version: '1' } }
        : message.method === 'tools/list' ? { tools: [{ name: 'openrouter_models', inputSchema: { type: 'object' } }, { name: 'openrouter_speech', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'ok' }] };
      return json(200, { jsonrpc: '2.0', id: message.id, result });
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const origins: string[] = [];
  const shim = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    origins.push(new URL(url).origin);
    expect(init?.redirect).toBe('manual');
    if (!url.startsWith(T.hub)) throw new Error(`Unexpected destination ${url}`);
    return fetch(base + url.slice(T.hub.length), init);
  });
  let browserUrl: URL | undefined;
  let browserHold: Promise<void> | undefined;
  /** The system browser: the user approves on the Hub's consent page, which redirects back. */
  const browser = vi.fn(async (target: string) => {
    browserUrl = new URL(target);
    await browserHold;
    const code = `code-${++serial}`;
    codes.set(code, { clientId: browserUrl.searchParams.get('client_id')!, challenge: browserUrl.searchParams.get('code_challenge')!, scope: browserUrl.searchParams.get('scope')!, resource: browserUrl.searchParams.get('resource')!, redirect: browserUrl.searchParams.get('redirect_uri')! });
    const callback = new URL(browserUrl.searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', code); callback.searchParams.set('state', browserUrl.searchParams.get('state')!);
    await fetch(callback).catch(() => undefined);
  });
  return {
    events, registrations, live, access, revocations, refreshes, mcpHeaders, hub, shim, browser, origins,
    lastBrowserUrl: () => browserUrl, holdBrowser(hold: Promise<void>) { browserHold = hold; },
    expireAccess() { for (const key of access.keys()) access.set(key, 0); },
    revokeOnDashboard() { live.clear(); access.clear(); }
  };
}
type Hub = Awaited<ReturnType<typeof fakeHub>>;

function broker(hub: Hub, vault: ReturnType<typeof memoryVault> | undefined, extra: Partial<VocsHubOptions> = {}) {
  const b = createVocsHub({ realm: 'staging', fetch: hub.shim as typeof fetch, openExternal: hub.browser, timeoutMs: 3000, vault: vault as VocsAccountVault | undefined, ...extra });
  cleanup.push(() => b.dispose(50));
  return b;
}
async function setup(extra: Partial<VocsHubOptions> = {}) {
  const hub = await fakeHub();
  const vault = memoryVault(hub.events);
  return { hub, vault, b: broker(hub, vault, extra) };
}
const VAULT_ID = vocsHubVaultId('staging', 'openrouter');
const stored = (vault: ReturnType<typeof memoryVault>) => { const raw = vault.data.get(VAULT_ID); return raw === undefined ? undefined : JSON.parse(raw) as Record<string, unknown>; };
const state = (b: ReturnType<typeof createVocsHub>) => b.states().find((s) => s.id === 'openrouter')!;

/** A raw JSON-RPC POST through the proxy, as a harness's MCP client would send it. */
async function rpc(server: ResolvedServer, method = 'tools/list', init: { headers?: Record<string, string>; body?: string; method?: string } = {}) {
  const response = await fetch(server.def.url!, {
    method: init.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...server.def.headers, ...init.headers },
    ...(init.method === 'GET' ? {} : { body: init.body ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method }) })
  });
  return { status: response.status, text: await response.text() };
}
/** A request with a forged Host header, which fetch cannot send. */
function rawRequest(url: string, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject); req.end(body);
  });
}
function expectNoHubSecrets(values: unknown[], hub: Hub) {
  const text = JSON.stringify(values);
  expect(text).not.toMatch(/\bat-\d+|rt0{4,}|refresh_token|access_token|refreshToken/);
  for (const secret of [...hub.live.keys(), ...hub.access.keys()]) expect(text).not.toContain(secret);
}

describe('Connect', () => {
  it('registers a public "Vocs Code" client, authorizes the catalog scopes with S256 and keeps only the refresh token, in the keychain', async () => {
    const { hub, vault, b } = await setup();
    await b.connect(connection(), ACCOUNT);
    expect(hub.registrations).toEqual([expect.objectContaining({ client_name: 'Vocs Code', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] })]);
    expect(new URL((hub.registrations[0].redirect_uris as string[])[0]).hostname).toBe('127.0.0.1');
    const authorize = hub.lastBrowserUrl()!;
    expect(authorize.origin + authorize.pathname).toBe(`${T.hub}/oauth/authorize`);
    expect(authorize.searchParams.get('resource')).toBe(RESOURCE);
    expect(authorize.searchParams.get('scope')).toBe('models:read speech:write audio:read');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(state(b)).toEqual({ id: 'openrouter', serverId: 'vocs-openrouter', status: 'connected', scopes: ALL_SCOPES, saved: true });
    const record = stored(vault)!;
    expect(Object.keys(record).sort()).toEqual(['accountId', 'clientId', 'issuer', 'refreshToken', 'resource', 'scopes', 'v']);
    expect(record).toEqual({ v: 1, issuer: T.hub, resource: RESOURCE, clientId: 'hub-client-1', scopes: ALL_SCOPES, refreshToken: refreshToken(2), accountId: ACCOUNT });
    expect(VOCS_HUB_VAULT_IDS).toContain(VAULT_ID);
    expect(isReservedSecretId(VAULT_ID)).toBe(true);
    expectNoHubSecrets([b.states()], hub);
    // Only the pinned Hub origin was ever addressed.
    expect(new Set(hub.origins)).toEqual(new Set([T.hub]));
  });

  it('records the scopes the Hub actually granted', async () => {
    const { hub, vault, b } = await setup();
    hub.hub.grantedScope = 'models:read';
    await b.connect(connection(), ACCOUNT);
    expect(state(b)).toMatchObject({ status: 'connected', scopes: ['models:read'] });
    expect(stored(vault)!.scopes).toEqual(['models:read']);
  });

  it.each([
    ['without a refresh token', (hub: Hub) => { hub.hub.omitRefresh = true; }],
    ['with a longer access token', (hub: Hub) => { hub.hub.accessTtl = 901; }]
  ])('refuses a grant %s and keeps nothing', async (_label, arrange) => {
    const { hub, vault, b } = await setup();
    arrange(hub);
    await b.connect(connection(), ACCOUNT);
    expect(state(b)).toMatchObject({ status: 'disconnected', error: expect.stringMatching(/did not complete/) });
    expect(vault.set).not.toHaveBeenCalled();
    expect(await b.servers()).toEqual([]);
  });

  it('never connects a connection the verified catalog does not offer on this realm', async () => {
    const { hub, b } = await setup();
    for (const patch of [{ authorization: 'unavailable' as const, authorizationServer: null }, { resource: 'https://evil.invalid/openrouter' }, { authorizationServer: 'https://mcp.vocs.io' }, { accountScopes: ['speech:write'] }]) {
      await b.connect(connection(patch), ACCOUNT);
      expect(state(b)).toMatchObject({ status: 'disconnected', error: VOCS_HUB_MESSAGES.NOT_IN_CATALOG });
    }
    expect(hub.shim).not.toHaveBeenCalled();
    expect(hub.browser).not.toHaveBeenCalled();
  });

  it('cancel while waiting in the browser connects nothing and leaves no grant behind', async () => {
    const { hub, vault, b } = await setup();
    let release!: () => void;
    hub.holdBrowser(new Promise<void>((resolve) => { release = resolve; }));
    const pending = b.connect(connection(), ACCOUNT);
    await vi.waitFor(() => expect(hub.browser).toHaveBeenCalledTimes(1));
    expect(state(b).status).toBe('connecting');
    b.cancel('openrouter');
    expect(state(b)).toEqual({ id: 'openrouter', serverId: 'vocs-openrouter', status: 'disconnected' });
    release();
    await pending;
    expect(hub.events).not.toContain('exchange');
    expect(vault.set).not.toHaveBeenCalled();
    expect(await b.servers()).toEqual([]);
    // A fresh attempt afterwards is clean.
    hub.holdBrowser(Promise.resolve());
    await b.connect(connection(), ACCOUNT);
    expect(state(b).status).toBe('connected');
  });

  it('a failed keychain write keeps the connection for this run only, and revokes it at quit', async () => {
    const { hub, vault, b } = await setup();
    vault.failSet = true;
    await b.connect(connection(), ACCOUNT);
    expect(state(b)).toMatchObject({ status: 'connected', saved: false });
    expect(await b.servers()).toHaveLength(1);
    await b.dispose(2000);
    expect(hub.revocations.map((p) => p.get('token'))).toEqual([refreshToken(2)]);
    expect(await b.servers()).toEqual([]);
  });
});

describe('loopback MCP proxy', () => {
  it('serves sessions a loopback URL and app-minted bearer, and forwards to the exact resource with the Hub token after it was saved', async () => {
    const { hub, b } = await setup();
    await b.connect(connection(), ACCOUNT);
    const [server] = await b.servers();
    expect(server.def).toMatchObject({ id: 'vocs-openrouter', transport: 'http', builtin: 'vocs-openrouter' });
    expect(server.def.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hub\/openrouter$/);
    expect(server.def.headers!.Authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
    expect(server.secretHeaderKeys).toEqual(['Authorization']);
    expectNoHubSecrets([server], hub);
    // The app's own MCP client, as a harness would connect.
    const result = await inspectServer(server.def, { timeoutMs: 5000 });
    expect(result.ok, result.error).toBe(true);
    expect(result.tools.map((t) => t.name)).toEqual(['openrouter_models', 'openrouter_speech']);
    // The vault held the refresh token before the access token's first use.
    const write = hub.events.findIndex((e) => e.startsWith('vault:set:'));
    const use = hub.events.findIndex((e) => e.startsWith('mcp:'));
    expect(write).toBeGreaterThan(-1); expect(use).toBeGreaterThan(write);
    expect(hub.events.filter((e) => e.startsWith('mcp:')).every((e) => e.startsWith('mcp:at-2:'))).toBe(true);
    // The Hub never sees the proxy bearer; the harness never sees the Hub token.
    const proxyBearer = server.def.headers!.Authorization;
    for (const headers of hub.mcpHeaders) { expect(headers.authorization).toBe('Bearer at-2'); expect(JSON.stringify(headers)).not.toContain(proxyBearer.slice(7)); }
    // Codex exec hands the bearer over through its environment, never its --config argv.
    const codex = toCodex([server], 'env-ref');
    expect(JSON.stringify(codex.config)).not.toContain(proxyBearer);
    expect(Object.values(codex.env)).toContain(proxyBearer);
    // A second session gets the same proxy and bearer while this connection lasts.
    expect((await b.servers())[0].def).toEqual(server.def);
  });

  it('refuses anything but an authorized JSON POST from a local, non-browser client, before the Hub', async () => {
    const { hub, b } = await setup();
    await b.connect(connection(), ACCOUNT);
    const [server] = await b.servers();
    const url = new URL(server.def.url!);
    expect((await rpc(server, 'tools/list', { headers: { Authorization: 'Bearer ' + 'x'.repeat(43) } })).status).toBe(401);
    expect((await rpc(server, 'tools/list', { headers: { Authorization: '' } })).status).toBe(401);
    expect((await rpc(server, 'tools/list', { method: 'GET' })).status).toBe(405);
    expect((await rpc(server, 'tools/list', { headers: { Origin: 'https://evil.invalid' } })).status).toBe(403);
    expect((await rpc(server, 'tools/list', { headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect((await rpc(server, 'tools/list', { body: 'x'.repeat(1_048_577) })).status).toBe(413);
    expect((await rpc({ ...server, def: { ...server.def, url: `${url.origin}/hub/openrouter?x=1` } })).status).toBe(404);
    expect((await rpc({ ...server, def: { ...server.def, url: `${url.origin}/hub/other` } })).status).toBe(404);
    expect(await rawRequest(server.def.url!, { Host: `localhost:${url.port}`, 'Content-Type': 'application/json', Authorization: server.def.headers!.Authorization }, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')).toBe(403);
    expect(hub.events.some((e) => e.startsWith('mcp:'))).toBe(false);
    // The real thing still works.
    expect(await rpc(server)).toMatchObject({ status: 200 });
  });

  it('renews within a minute of expiry, writing the rotated token to the vault before the new access token is used', async () => {
    const { hub, vault, b } = await setup();
    hub.hub.accessTtl = 30;
    await b.connect(connection(), ACCOUNT);
    hub.hub.accessTtl = 900;
    const [server] = await b.servers();
    const before = hub.events.length;
    expect(await rpc(server)).toMatchObject({ status: 200 });
    expect(hub.events.slice(before)).toEqual([`refresh:${refreshToken(2)}`, `vault:set:${VAULT_ID}:${refreshToken(3)}`, 'mcp:at-3:tools/list']);
    expect(hub.refreshes[0].get('client_id')).toBe('hub-client-1');
    expect(stored(vault)!.refreshToken).toBe(refreshToken(3));
    // A fresh token is reused, not renewed again.
    expect(await rpc(server)).toMatchObject({ status: 200 });
    expect(hub.refreshes).toHaveLength(1);
  });

  it('renews once on a Hub 401 and retries once; a second 401 is a 502, never a 401 the harness would act on', async () => {
    const { hub, b } = await setup();
    await b.connect(connection(), ACCOUNT);
    const [server] = await b.servers();
    hub.expireAccess();
    let before = hub.events.length;
    expect(await rpc(server)).toMatchObject({ status: 200 });
    expect(hub.events.slice(before)).toEqual(['mcp:at-2:tools/list', `refresh:${refreshToken(2)}`, `vault:set:${VAULT_ID}:${refreshToken(3)}`, 'mcp:at-3:tools/list']);
    hub.hub.rejectAll = true;
    before = hub.events.length;
    const refused = await rpc(server);
    expect(refused.status).toBe(502);
    expect(hub.events.slice(before).filter((e) => e.startsWith('refresh:'))).toHaveLength(1);
    expect(hub.events.slice(before).filter((e) => e.startsWith('mcp:'))).toHaveLength(2);
    expect(state(b).status).toBe('connected');
  });

  it('concurrent calls on an expired token share one refresh', async () => {
    const { hub, b } = await setup();
    hub.hub.accessTtl = 10;
    await b.connect(connection(), ACCOUNT);
    hub.hub.accessTtl = 900; hub.hub.refreshDelayMs = 100;
    const [server] = await b.servers();
    const results = await Promise.all([rpc(server), rpc(server), rpc(server)]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(hub.refreshes).toHaveLength(1);
  });

  it('a refresh answered invalid_grant (revoked on the dashboard) disconnects locally and says so', async () => {
    const { hub, vault, b } = await setup();
    await b.connect(connection(), ACCOUNT);
    const [server] = await b.servers();
    hub.revokeOnDashboard();
    const answer = await rpc(server);
    expect(answer.status).toBe(503);
    expect(answer.text).toContain(VOCS_HUB_MESSAGES.REVOKED);
    expect(state(b)).toEqual({ id: 'openrouter', serverId: 'vocs-openrouter', status: 'disconnected', error: 'Disconnected on mcp.vocs.io — connect again' });
    await vi.waitFor(() => expect(stored(vault)).toBeUndefined());
    expect(await b.servers()).toEqual([]);
    expect((await rpc(server)).status).toBe(401);
    expect(hub.revocations).toHaveLength(0);
  });

  it('keeps the connection when the Hub cannot be reached, and tells the harness why', async () => {
    const { hub, b } = await setup({ isOnline: () => false });
    hub.hub.accessTtl = 5;
    await b.connect(connection(), ACCOUNT);
    const [server] = await b.servers();
    // Five seconds of life left: still used rather than failing the call.
    expect(await rpc(server)).toMatchObject({ status: 200 });
    hub.expireAccess();
    const answer = await rpc(server);
    expect(answer.status).toBe(503);
    expect(state(b).status).toBe('connected');
    expect(hub.refreshes).toHaveLength(0);
  });
});

describe('startup restore', () => {
  function seed(hub: Hub, vault: ReturnType<typeof memoryVault>, patch: Record<string, unknown> = {}) {
    const rt = refreshToken('seed');
    hub.live.set(rt, { clientId: 'hub-client-seed', scope: 'models:read speech:write' });
    vault.data.set(VAULT_ID, JSON.stringify({ v: 1, issuer: T.hub, resource: RESOURCE, clientId: 'hub-client-seed', scopes: ['models:read', 'speech:write'], refreshToken: rt, accountId: ACCOUNT, ...patch }));
    return rt;
  }

  it('reads the keychain only, then renews once, lazily, on the first proxied call', async () => {
    const hub = await fakeHub();
    const vault = memoryVault(hub.events);
    const rt = seed(hub, vault);
    const b = broker(hub, vault);
    await b.restore();
    expect(state(b)).toMatchObject({ status: 'connected', scopes: ['models:read', 'speech:write'], saved: true });
    const [server] = await b.servers();
    expect(hub.shim).not.toHaveBeenCalled();
    const result = await inspectServer(server.def, { timeoutMs: 5000 });
    expect(result.ok, result.error).toBe(true);
    expect(hub.refreshes.map((p) => p.get('refresh_token'))).toEqual([rt]);
    expect(stored(vault)!.refreshToken).not.toBe(rt);
  });

  it.each([
    ['a foreign issuer', { issuer: 'https://evil.invalid' }],
    ['a foreign resource', { resource: 'https://evil.invalid/openrouter' }],
    ['an unknown scope', { scopes: ['models:read', 'admin'] }],
    ['an extra field', { accessToken: 'at-planted' }],
    ['the production Hub in the staging slot', { issuer: VOCS_REALMS.production.hub, resource: `${VOCS_REALMS.production.hub}/openrouter` }]
  ])('removes a record with %s without using it', async (_label, patch) => {
    const hub = await fakeHub();
    const vault = memoryVault(hub.events);
    seed(hub, vault, patch);
    const b = broker(hub, vault);
    await b.restore();
    expect(state(b).status).toBe('disconnected');
    await vi.waitFor(() => expect(stored(vault)).toBeUndefined());
    expect(await b.servers()).toEqual([]);
    expect(hub.shim).not.toHaveBeenCalled();
  });
});

describe('disconnect and the account lifecycle', () => {
  it('Disconnect stops injection at once, revokes at the Hub (RFC 7009, no grant_type) and deletes the keychain entry', async () => {
    const { hub, vault, b } = await setup();
    await b.connect(connection(), ACCOUNT);
    const [server] = await b.servers();
    await b.disconnect('openrouter');
    expect(hub.revocations).toHaveLength(1);
    expect(Object.fromEntries(hub.revocations[0])).toEqual({ token: refreshToken(2), client_id: 'hub-client-1' });
    expect(stored(vault)).toBeUndefined();
    const revoke = hub.events.indexOf(`revoke:${refreshToken(2)}`), erase = hub.events.indexOf(`vault:clear:${VAULT_ID}`);
    expect(revoke).toBeGreaterThan(-1); expect(erase).toBeGreaterThan(revoke);
    expect(state(b)).toEqual({ id: 'openrouter', serverId: 'vocs-openrouter', status: 'disconnected' });
    expect(await b.servers()).toEqual([]);
    expect((await rpc(server)).status).toBe(401);
  });

  it('an unconfirmed revocation still disconnects locally and says so', async () => {
    const { hub, vault, b } = await setup();
    await b.connect(connection(), ACCOUNT);
    hub.hub.revocationStatus = 503;
    await b.disconnect('openrouter');
    expect(stored(vault)).toBeUndefined();
    expect(state(b)).toMatchObject({ status: 'disconnected', error: expect.stringMatching(/did not confirm/) });
  });

  it('an account switch, a connection leaving the catalog and sign-out each disconnect and revoke', async () => {
    const { hub, vault, b } = await setup();
    await b.connect(connection(), ACCOUNT);
    await b.accountSeen(ACCOUNT, [connection()]);
    expect(state(b).status).toBe('connected');
    await b.accountSeen(OTHER, [connection()]);
    expect(state(b)).toMatchObject({ status: 'disconnected', error: VOCS_HUB_MESSAGES.ACCOUNT_SWITCHED });
    expect(stored(vault)).toBeUndefined();
    expect(hub.revocations).toHaveLength(1);

    await b.connect(connection(), ACCOUNT);
    await b.accountSeen(ACCOUNT, [connection({ authorization: 'unavailable', authorizationServer: null })]);
    expect(state(b)).toMatchObject({ status: 'disconnected', error: VOCS_HUB_MESSAGES.REMOVED });
    await b.connect(connection(), ACCOUNT);
    await b.accountSeen(ACCOUNT, []);
    expect(state(b)).toMatchObject({ status: 'disconnected', error: VOCS_HUB_MESSAGES.REMOVED });
    expect(hub.revocations).toHaveLength(3);

    await b.connect(connection(), ACCOUNT);
    const [server] = await b.servers();
    await b.accountSignedOut();
    expect(state(b)).toEqual({ id: 'openrouter', serverId: 'vocs-openrouter', status: 'disconnected' });
    expect(stored(vault)).toBeUndefined();
    expect(hub.revocations).toHaveLength(4);
    expect((await rpc(server)).status).toBe(401);
  });

  it('sign-out also ends a connection restored from the keychain that was never used', async () => {
    const hub = await fakeHub();
    const vault = memoryVault(hub.events);
    hub.live.set(refreshToken('seed'), { clientId: 'hub-client-seed', scope: 'models:read' });
    vault.data.set(VAULT_ID, JSON.stringify({ v: 1, issuer: T.hub, resource: RESOURCE, clientId: 'hub-client-seed', scopes: ['models:read'], refreshToken: refreshToken('seed'), accountId: ACCOUNT }));
    const b = broker(hub, vault);
    await b.accountSignedOut();
    expect(hub.revocations.map((p) => p.get('token'))).toEqual([refreshToken('seed')]);
    expect(stored(vault)).toBeUndefined();
    expect(state(b).status).toBe('disconnected');
  });
});

describe('session injection', () => {
  async function scope(harness: SessionScope['harness'], patch: Partial<SessionScope> = {}): Promise<SessionScope> {
    const settings = defaultSettings();
    settings.mcpDisabledBuiltins = ['gitnexus', 'cua-driver', 'vocs-memory'];
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vocs-hub-scope-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    return { settings, cwd: dir, projectRoot: dir, harness, sessionId: 's_hub', ...patch };
  }
  const proxied: ResolvedServer = { def: { id: 'vocs-openrouter', transport: 'http', url: 'http://127.0.0.1:1/hub/openrouter', headers: { Authorization: 'Bearer proxy-capability' }, builtin: 'vocs-openrouter' }, missing: [], secretEnvKeys: [], secretHeaderKeys: ['Authorization'] };

  it('is offered to every injecting or client harness while connected', async () => {
    const hubServers = vi.fn(async () => [proxied]);
    for (const harness of ['claude', 'codex', 'codex-exec', 'pi', 'antigravity', 'acp', 'native'] as const) {
      const out = await resolveForSession(await scope(harness), { getSecret: async () => undefined, hubServers });
      expect(out.map((s) => s.def.id), harness).toEqual(['vocs-openrouter']);
      expect(out[0].secretHeaderKeys).toEqual(['Authorization']);
    }
    expect(await resolveForSession(await scope('cursor'), { getSecret: async () => undefined, hubServers })).toEqual([]);
    const off = await scope('claude');
    off.settings.mcpDisabledBuiltins = [...off.settings.mcpDisabledBuiltins!, 'vocs-openrouter'];
    expect(await resolveForSession(off, { getSecret: async () => undefined, hubServers })).toEqual([]);
    // A broker failure leaves the session without it instead of failing the start.
    expect(await resolveForSession(await scope('claude'), { getSecret: async () => undefined, hubServers: async () => { throw new Error('closed'); } })).toEqual([]);
    expect(toClaude([proxied.def])['vocs-openrouter']).toEqual({ type: 'http', url: proxied.def.url, headers: proxied.def.headers });
  });

  it('a user server cannot take the vocs-openrouter name', async () => {
    const s = await scope('claude');
    s.settings.mcpServers = [{ id: 'vocs-openrouter', transport: 'http', url: 'https://evil.invalid/mcp' }];
    expect(await resolveForSession(s, { getSecret: async () => undefined })).toEqual([]);
  });
});
