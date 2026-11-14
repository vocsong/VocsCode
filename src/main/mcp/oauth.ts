/** Explicit, main-process-only OAuth. Nothing here is serialized to renderer/harness config. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

export interface NativeMcpOAuthOptions {
  /** Exact trusted resource and issuer, selected by the main-process account/catalog broker. */
  resource: string;
  issuer: string;
  scopes: string[];
  /** System browser, not an embedded renderer. Called only by an explicit authorize(). */
  openExternal: (url: string) => Promise<void>;
  timeoutMs?: number;
  fetch?: FetchLike;
}

/** Tokens stay memory-only in this first slice; no fallback to plaintext/obfuscated disk storage. */
export interface NativeMcpOAuth {
  readonly resource: string;
  readonly provider: OAuthClientProvider;
  readonly fetch: FetchLike;
  authorize(signal?: AbortSignal): Promise<void>;
  /** Local logout/cancel. Remote revocation is a separate issuer operation. */
  clear(): void;
}

function secureUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('MCP OAuth requires an HTTPS URL without credentials or fragment');
  return url;
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('MCP sign-in cancelled or timed out'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createNativeMcpOAuth(options: NativeMcpOAuthOptions): NativeMcpOAuth {
  const resource = secureUrl(options.resource).href;
  const issuer = secureUrl(options.issuer).href;
  const origins = new Set([new URL(resource).origin, new URL(issuer).origin]);
  if (!options.scopes.length || options.scopes.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope))) throw new Error('Explicit OAuth scopes are required');
  const scopes = [...new Set(options.scopes)];
  let tokens: OAuthTokens | undefined;
  let client: OAuthClientInformationMixed | undefined;
  let discovery: OAuthDiscoveryState | undefined;
  let verifier: string | undefined;
  let state: string | undefined;
  let redirect = '';
  let active: AbortController | undefined;
  let generation = 0;
  let expiresAt = 0;
  let lifetime = new AbortController();

  const guardedFetch: FetchLike = async (input, init) => {
    const url = secureUrl(input);
    if (!origins.has(url.origin)) throw new Error('MCP OAuth endpoint is outside the approved resource and issuer');
    if (new Headers(init?.headers).get('authorization')?.toLowerCase().startsWith('bearer ') && url.href !== resource) throw new Error('MCP bearer token cannot leave its exact resource');
    const signal = AbortSignal.any([lifetime.signal, ...(active ? [active.signal] : []), ...(init?.signal ? [init.signal] : [])]);
    signal.throwIfAborted();
    const response = await (options.fetch ?? fetch)(input, { ...init, signal, redirect: 'manual' });
    if (signal.aborted) { await response.body?.cancel(); signal.throwIfAborted(); }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('MCP OAuth redirects are not allowed');
    }
    return response;
  };

  const provider: OAuthClientProvider = {
    get redirectUrl() { return redirect; },
    get clientMetadata() {
      return { client_name: 'Vocs Code', redirect_uris: redirect ? [redirect] : [], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: scopes.join(' ') };
    },
    state() { if (!state) throw new Error('Start an explicit MCP sign-in first'); return state; },
    clientInformation() { return client; },
    saveClientInformation(value) {
      if (!active || active.signal.aborted || value.client_secret || ('token_endpoint_auth_method' in value && value.token_endpoint_auth_method !== 'none')) throw new Error('Desktop OAuth requires a public client');
      client = value;
    },
    tokens() { return tokens && Date.now() < expiresAt ? { ...tokens } : undefined; },
    saveTokens(value) {
      if (!active || active.signal.aborted) throw new Error('MCP sign-in is no longer active');
      if (!value.access_token || value.token_type.toLowerCase() !== 'bearer' || !value.expires_in || value.expires_in <= 0) throw new Error('MCP OAuth requires a bounded bearer token');
      if (value.scope?.split(' ').some((scope) => !scopes.includes(scope))) throw new Error('MCP OAuth returned an unapproved scope');
      // Renewal needs account/device revocation first. Do not retain refresh tokens yet.
      tokens = { access_token: value.access_token, token_type: value.token_type, expires_in: value.expires_in, ...(value.scope ? { scope: value.scope } : {}) };
      expiresAt = Date.now() + value.expires_in * 1000;
    },
    saveCodeVerifier(value) { if (!active || active.signal.aborted) throw new Error('Start an explicit MCP sign-in first'); verifier = value; },
    codeVerifier() { if (!verifier) throw new Error('MCP sign-in verifier is unavailable'); return verifier; },
    async redirectToAuthorization(url) {
      if (!active || active.signal.aborted) throw new Error('MCP sign-in required; authorize explicitly');
      const target = secureUrl(url);
      if (target.href.split('?')[0] !== discovery?.authorizationServerMetadata?.authorization_endpoint || target.searchParams.get('state') !== state || target.searchParams.get('code_challenge_method') !== 'S256' || target.searchParams.get('resource') !== resource || target.searchParams.get('scope') !== scopes.join(' ')) throw new Error('Unexpected MCP authorization request');
      await abortable(options.openExternal(target.href), active.signal);
    },
    async validateResourceURL(serverUrl, metadataResource) {
      if (new URL(serverUrl).href !== resource || (metadataResource && new URL(metadataResource).href !== resource)) throw new Error('MCP OAuth resource mismatch');
      return new URL(resource);
    },
    discoveryState() { return discovery; },
    saveDiscoveryState(value) {
      if (!active || active.signal.aborted) throw new Error('MCP sign-in is no longer active');
      const metadata = value.authorizationServerMetadata;
      if (new URL(value.authorizationServerUrl).href !== issuer || !metadata || new URL(metadata.issuer).href !== issuer) throw new Error('MCP OAuth issuer mismatch');
      if (!metadata.code_challenge_methods_supported?.includes('S256')) throw new Error('MCP issuer must advertise S256 PKCE');
      for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint].filter(Boolean)) {
        if (secureUrl(endpoint!).origin !== new URL(issuer).origin) throw new Error('MCP OAuth endpoint issuer mismatch');
      }
      discovery = value;
    },
    invalidateCredentials(scope) {
      if (scope === 'all' || scope === 'tokens') { tokens = undefined; expiresAt = 0; }
      if (scope === 'all' || scope === 'client') client = undefined;
      if (scope === 'all' || scope === 'discovery') discovery = undefined;
      if (scope === 'all' || scope === 'verifier') verifier = undefined;
    }
  };

  function clear() {
    generation++;
    lifetime.abort();
    active?.abort();
    tokens = undefined;
    client = undefined;
    discovery = undefined;
    verifier = undefined;
    state = undefined;
    expiresAt = 0;
  }

  return {
    resource, provider, fetch: guardedFetch, clear,
    async authorize(signal) {
      if (active) throw new Error('MCP sign-in is already in progress');
      clear();
      lifetime = new AbortController();
      const current = generation;
      const controller = new AbortController();
      active = controller;
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) controller.abort();
      const timer = setTimeout(abort, options.timeoutMs ?? 120_000);
      const callbackPath = `/oauth/${randomBytes(24).toString('hex')}`;
      state = randomBytes(32).toString('base64url');
      let finish!: (code: string) => void;
      let fail!: (error: Error) => void;
      const codePromise = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
      // A cancel may arrive during discovery/browser launch, before awaiting the callback.
      void codePromise.catch(() => undefined);
      let accepted = false;
      const server = createServer((req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Security-Policy', "default-src 'none'");
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        let url: URL;
        try { url = new URL(req.url ?? '/', redirect); }
        catch { res.writeHead(400).end('Invalid sign-in callback.'); return; }
        if (req.method !== 'GET' || req.headers.host !== new URL(redirect).host || url.pathname !== callbackPath || accepted || !equalSecret(url.searchParams.get('state') ?? '', state ?? '') || url.searchParams.getAll('state').length !== 1) {
          res.writeHead(400).end('Invalid sign-in callback.'); return;
        }
        const responseIssuer = url.searchParams.get('iss');
        const requireIssuer = (discovery?.authorizationServerMetadata as { authorization_response_iss_parameter_supported?: boolean } | undefined)?.authorization_response_iss_parameter_supported === true;
        if ((requireIssuer && !responseIssuer) || (responseIssuer && responseIssuer !== discovery?.authorizationServerMetadata?.issuer) || url.searchParams.getAll('iss').length > 1) {
          res.writeHead(400).end('Invalid sign-in issuer.'); return;
        }
        accepted = true;
        const code = url.searchParams.get('code');
        if (url.searchParams.has('error') || !code || code.length > 4096 || url.searchParams.getAll('code').length !== 1) {
          res.writeHead(400).end('Sign-in was not completed.'); fail(new Error('MCP authorization denied or invalid callback')); return;
        }
        res.writeHead(200).end('Sign-in received. Return to Vocs Code.');
        finish(code);
      });
      const onAbort = () => { fail(new Error('MCP sign-in cancelled or timed out')); server.close(); server.closeAllConnections(); };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      try {
        if (controller.signal.aborted) throw new Error('MCP sign-in cancelled');
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        if (controller.signal.aborted) throw new Error('MCP sign-in cancelled');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('MCP callback unavailable');
        redirect = `http://127.0.0.1:${address.port}${callbackPath}`;
        const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js');
        const result = await auth(provider, { serverUrl: resource, scope: scopes.join(' '), fetchFn: guardedFetch });
        if (result !== 'REDIRECT') throw new Error('Expected an interactive MCP sign-in');
        const code = await codePromise;
        const exchanged = await auth(provider, { serverUrl: resource, authorizationCode: code, scope: scopes.join(' '), fetchFn: guardedFetch });
        if (exchanged !== 'AUTHORIZED' || generation !== current || controller.signal.aborted || !tokens) throw new Error('MCP sign-in was not completed');
      } catch (error) {
        tokens = undefined;
        expiresAt = 0;
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', onAbort);
        server.close();
        server.closeAllConnections();
        active = undefined;
        verifier = undefined;
        state = undefined;
      }
    }
  };
}
