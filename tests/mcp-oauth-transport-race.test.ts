import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createNativeMcpOAuth } from '../src/main/mcp/oauth';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const resource = 'https://hub.example/openrouter';
const issuer = 'https://hub.example/';
const metadata = {
  issuer, authorization_endpoint: `${issuer}authorize`, token_endpoint: `${issuer}token`,
  registration_endpoint: `${issuer}register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'],
  token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true
};
function fixture(overrides: Partial<typeof metadata> = {}, timeoutMs = 5000) {
  let authorization: URL;
  let issued = 0;
  const requests: { url: string; init?: RequestInit }[] = [];
  const network = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes('.well-known/oauth-protected-resource')) return Response.json({ resource, authorization_servers: [issuer], scopes_supported: ['models:read', 'speech:write'] });
    if (url.includes('.well-known/')) return Response.json({ ...metadata, ...overrides });
    if (url === `${issuer}register`) {
      const body = JSON.parse(String(init?.body));
      expect(body.token_endpoint_auth_method).toBe('none');
      expect(body.grant_types).toEqual(['authorization_code']);
      return Response.json({ ...body, client_id: 'fixture-client' }, { status: 201 });
    }
    if (url === `${issuer}token`) {
      const params = new URLSearchParams(String(init?.body));
      expect(params.get('resource')).toBe(resource);
      expect(params.get('code')).toBe('fixture-code');
      expect(params.get('client_secret')).toBeNull();
      expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'));
      issued++;
      return Response.json({ access_token: 'secret-token', refresh_token: 'must-not-retain', token_type: 'Bearer', expires_in: 300, scope: 'models:read' });
    }
    if (url === resource) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-token');
      const request = JSON.parse(String(init?.body));
      if (request.id === undefined) return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: '2.0', id: request.id, result: request.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'oauth-fixture', version: '1' } } : { tools: [{ name: 'list_models', inputSchema: { type: 'object' } }] } });
    }
    throw new Error(`Unexpected fixture request ${url}`);
  });
  const browser = vi.fn(async (url: string) => {
    authorization = new URL(url);
    expect(authorization.searchParams.get('scope')).toBe('models:read');
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', 'fixture-code');
    callback.searchParams.set('state', authorization.searchParams.get('state')!);
    callback.searchParams.set('iss', issuer);
    const response = await fetch(callback);
    expect(response.status).toBe(200);
  });
  const oauth = createNativeMcpOAuth({ resource, issuer, scopes: ['models:read'], fetch: network, openExternal: browser, timeoutMs });
  return { oauth, browser, network, requests, get issued() { return issued; } };
}


describe('MCP OAuth transport lifecycle isolation', () => {
  it('never opens browser or changes verifier from a background 401 during explicit login', async () => {
    const f = fixture();
    const original = f.network.getMockImplementation()!;
    const originalBrowser = f.browser.getMockImplementation()!;
    f.network.mockImplementation(async (input, init) => String(input) === resource
      ? new Response('unauthorized', { status: 401, headers: {'WWW-Authenticate': 'Bearer scope="models:read"'} }) : original(input, init));
    let opened!: () => void;
    const started = new Promise<void>(resolve => { opened = resolve; });
    f.browser.mockImplementation(async () => { opened(); });
    const context = f.oauth.transport();
    const login = f.oauth.authorize().catch(() => undefined);
    const transport = new StreamableHTTPClientTransport(new URL(resource), context);
    await transport.start();
    try {
      await started;
      expect(() => f.oauth.transport()).toThrow('Wait for explicit MCP sign-in');
      const verifier = f.oauth.provider.codeVerifier();
      await transport.send({jsonrpc: '2.0', id: 1, method: 'tools/list'}).catch(() => undefined);
      expect(f.browser).toHaveBeenCalledTimes(1);
      expect(f.oauth.provider.codeVerifier()).toBe(verifier);
      await originalBrowser(f.browser.mock.calls[0][0]);
      await login;
      expect((await f.oauth.provider.tokens())?.access_token).toBe('secret-token');
    } finally { f.oauth.clear(); await transport.close(); await login; }
  });

  it('does not let a delayed old-connection 401 body enter a newer login after logout', async () => {
    const f = fixture();
    await f.oauth.authorize();
    const original = f.network.getMockImplementation()!;
    const originalBrowser = f.browser.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reading!: () => void;
    const bodyStarted = new Promise<void>(resolve => { reading = resolve; });
    f.network.mockImplementation(async (input, init) => {
      if (String(input) !== resource) return original(input, init);
      const response = new Response('unauthorized', {status: 401, headers: {'WWW-Authenticate': 'Bearer scope="models:read"'}});
      response.text = async () => { reading(); await gate; return 'unauthorized'; };
      return response;
    });
    const transport = new StreamableHTTPClientTransport(new URL(resource), f.oauth.transport());
    await transport.start();
    const stale = transport.send({jsonrpc: '2.0', id: 1, method: 'tools/list'}).catch(() => undefined);
    await bodyStarted;
    f.oauth.clear();
    await transport.close();
    f.browser.mockClear();
    let opened!: () => void;
    const started = new Promise<void>(resolve => { opened = resolve; });
    f.browser.mockImplementation(async () => { opened(); });
    const login = f.oauth.authorize().catch(() => undefined);
    try {
      await started;
      const verifier = f.oauth.provider.codeVerifier();
      release();
      await stale;
      expect(f.browser).toHaveBeenCalledTimes(1);
      expect(f.oauth.provider.codeVerifier()).toBe(verifier);
      await originalBrowser(f.browser.mock.calls[0][0]);
      await login;
      expect((await f.oauth.provider.tokens())?.access_token).toBe('secret-token');
    } finally { release(); f.oauth.clear(); await login; }
  });

  it('never starts interactive authorization for a same-generation resource 401', async () => {
    const f = fixture();
    await f.oauth.authorize();
    const original = f.network.getMockImplementation()!;
    f.network.mockImplementation(async (input, init) => String(input) === resource
      ? new Response('unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer scope="models:read"' } }) : original(input, init));
    const transport = new StreamableHTTPClientTransport(new URL(resource), f.oauth.transport());
    await transport.start();
    f.browser.mockClear();
    f.network.mockClear();
    try {
      await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).rejects.toThrow('authorize explicitly');
      expect(f.browser).not.toHaveBeenCalled();
      expect(f.network).toHaveBeenCalledTimes(1);
      expect(String(f.network.mock.calls[0][0])).toBe(resource);
    } finally { f.oauth.clear(); await transport.close(); }
  });

});
