import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createNativeMcpOAuth } from '../src/main/mcp/oauth';
import { inspectServer } from '../src/main/mcp/client';

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

describe('native MCP OAuth main-process boundary', () => {
  it('uses real SDK discovery, public registration, S256 and loopback callback then connects without Codex', async () => {
    const f = fixture();
    await f.oauth.authorize();
    expect(f.issued).toBe(1);
    expect(f.oauth.provider.tokens()).toEqual({ access_token: 'secret-token', token_type: 'Bearer', expires_in: 300, scope: 'models:read' });
    const result = await inspectServer({ id: 'hub', transport: 'http', url: resource }, { oauth: f.oauth });
    expect(result.ok, result.error).toBe(true);
    expect(result.tools.map(t => t.name)).toEqual(['list_models']);
    expect(f.browser).toHaveBeenCalledTimes(1);
    expect(f.requests.every(r => r.init?.redirect === 'manual')).toBe(true);
    f.oauth.clear();
    expect(f.oauth.provider.tokens()).toBeUndefined();
  });

  it('refuses a resource/issuer mix-up and PKCE downgrade before browser or token request', async () => {
    for (const override of [{ issuer: 'https://other.example/' }, { token_endpoint: 'https://other.example/token' }, { code_challenge_methods_supported: ['plain'] }]) {
      const f = fixture(override);
      await expect(f.oauth.authorize()).rejects.toThrow();
      expect(f.browser).not.toHaveBeenCalled();
      expect(f.issued).toBe(0);
    }
  });

  it('refuses plaintext resources, foreign destinations and HTTP redirects', async () => {
    expect(() => createNativeMcpOAuth({ resource: 'http://example.com/mcp', issuer, scopes: ['models:read'], openExternal: async () => {} })).toThrow(/HTTPS/);
    const f = fixture();
    await expect(f.oauth.fetch('https://evil.example/token')).rejects.toThrow(/outside/);
    expect(f.network).not.toHaveBeenCalled();
    const redirect = createNativeMcpOAuth({ resource, issuer, scopes: ['models:read'], fetch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }), openExternal: async () => {} });
    await expect(redirect.fetch(resource)).rejects.toThrow(/redirects/);
  });

  it('binds client use to exact resource and refuses configured headers', async () => {
    const f = fixture();
    const wrong = await inspectServer({ id: 'other', transport: 'http', url: `${issuer}other` }, { oauth: f.oauth });
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toContain('resource mismatch');
    const mixed = await inspectServer({ id: 'hub', transport: 'sse', url: resource, headers: { AUTHORIZATION: 'Basic old' } }, { oauth: f.oauth });
    expect(mixed.ok).toBe(false);
    expect(mixed.error).toContain('configured headers');
    const separateIssuer = createNativeMcpOAuth({ resource, issuer: 'https://login.example/', scopes: ['models:read'], fetch: f.network, openExternal: f.browser });
    for (const name of ['Cookie', 'X-API-Key']) {
      const secret = await inspectServer({ id: 'hub', transport: 'http', url: resource, headers: { [name]: 'private' } }, { oauth: separateIssuer });
      expect(secret.ok).toBe(false);
      expect(secret.error).toContain('configured headers');
    }
    expect(f.network).not.toHaveBeenCalled();
  });

  it('ignores forged callbacks and closes the listener on cancellation', async () => {
    const f = fixture();
    let callback: URL;
    const controller = new AbortController();
    f.browser.mockImplementation(async (url) => {
      const auth = new URL(url);
      callback = new URL(auth.searchParams.get('redirect_uri')!);
      callback.searchParams.set('code', 'fixture-code');
      callback.searchParams.set('state', 'wrong');
      expect((await fetch(callback)).status).toBe(400);
      callback.searchParams.set('state', auth.searchParams.get('state')!);
      callback.searchParams.set('iss', 'https://evil.example/');
      expect((await fetch(callback)).status).toBe(400);
      controller.abort();
    });
    await expect(f.oauth.authorize(controller.signal)).rejects.toThrow(/cancelled/);
    await expect(fetch(callback!)).rejects.toThrow();
    expect(f.issued).toBe(0);
    expect(f.oauth.provider.tokens()).toBeUndefined();
  });

  it('cancels pending sign-in on logout and never opens browser during background auth', async () => {
    const f = fixture();
    f.browser.mockImplementation(async () => f.oauth.clear());
    await expect(f.oauth.authorize()).rejects.toThrow(/cancelled/);
    expect(f.oauth.provider.tokens()).toBeUndefined();
    await expect(f.oauth.provider.redirectToAuthorization(new URL(`${issuer}authorize`))).rejects.toThrow(/explicitly/);
    expect(f.browser).toHaveBeenCalledTimes(1);
  });

  it('handles repeated clicks, cancellation and a subsequent clean sign-in', async () => {
    const f = fixture();
    const original = f.browser.getMockImplementation()!;
    let opened!: () => void;
    const started = new Promise<void>((resolve) => { opened = resolve; });
    f.browser.mockImplementation(async () => { opened(); await new Promise(() => {}); });
    const controller = new AbortController();
    const pending = f.oauth.authorize(controller.signal);
    const rejected = expect(pending).rejects.toThrow(/cancelled/);
    await started;
    await expect(f.oauth.authorize()).rejects.toThrow(/already in progress/);
    controller.abort();
    await rejected;
    f.browser.mockImplementation(original);
    await f.oauth.authorize();
    expect(f.oauth.provider.tokens()).toBeDefined();
    f.oauth.clear();
  });

  it('does not share tokens across connections or retain expired tokens', async () => {
    const f = fixture();
    await f.oauth.authorize();
    expect(fixture().oauth.provider.tokens()).toBeUndefined();
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 301_000);
    try { expect(f.oauth.provider.tokens()).toBeUndefined(); }
    finally { now.mockRestore(); f.oauth.clear(); }
  });

  it('never forwards resource bearer tokens to a different issuer origin', async () => {
    const network = vi.fn();
    const oauth = createNativeMcpOAuth({ resource, issuer: 'https://login.example/', scopes: ['models:read'], openExternal: async () => {}, fetch: network });
    await expect(oauth.fetch('https://login.example/token', { headers: { authorization: 'Bearer resource-token' } })).rejects.toThrow(/cannot leave/);
    expect(network).not.toHaveBeenCalled();
  });


  it('refuses bearer tokens on a different path, even on the approved origin', async () => {
    const f = fixture();
    await expect(f.oauth.fetch(`${issuer}other`, { headers: { authorization: 'Bearer resource-token' } })).rejects.toThrow(/exact resource/);
    expect(f.network).not.toHaveBeenCalled();
  });

  it('drops a late token response after local logout', async () => {
    const f = fixture();
    const original = f.network.getMockImplementation()!;
    let release!: () => void;
    let requested!: () => void;
    const started = new Promise<void>(resolve => { requested = resolve; });
    f.network.mockImplementation(async (input, init) => {
      if (String(input) === `${issuer}token`) {
        requested();
        await new Promise<void>(resolve => { release = resolve; });
      }
      return original(input, init);
    });
    const pending = f.oauth.authorize();
    const rejected = expect(pending).rejects.toThrow();
    await started;
    f.oauth.clear();
    release();
    await rejected;
    expect(f.oauth.provider.tokens()).toBeUndefined();
  });


  it('times out an abandoned browser flow and tears down its callback', async () => {
    const f = fixture({}, 50);
    let callback: string | undefined;
    f.browser.mockImplementation(async (url) => { callback = new URL(url).searchParams.get('redirect_uri')!; });
    await expect(f.oauth.authorize()).rejects.toThrow(/timed out/);
    expect(callback).toBeDefined();
    await expect(fetch(callback!)).rejects.toThrow();
    expect(f.oauth.provider.tokens()).toBeUndefined();
    expect(f.issued).toBe(0);
  });

});
