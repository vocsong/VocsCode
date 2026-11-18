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
  /** Main-selected registered public client; omitted preserves generic dynamic registration. */
  clientId?: string;
  /** Main-selected registered loopback path, never renderer input. */
  callbackPath?: string;
  maxTokenAgeSeconds?: number;
  timeoutMs?: number;
  fetch?: FetchLike;
  /** Device enrollment (Vocs `vocs-code-device`): sent as `device_name` with the code exchange,
   *  whose `refresh_token`/`device_id`/`device_expires_at` are then held for `takeDeviceGrant()`.
   *  Main-selected, never renderer input. */
  deviceName?: string;
  /** A device grant that arrived but will not be handed over (cancelled or failed sign-in):
   *  the caller revokes it, so it is never left live on the account. */
  onAbandonedDeviceGrant?: (grant: NativeDeviceGrant) => void;
}

/** A device grant from the code exchange. Main-process only; the SDK never sees the refresh token. */
export interface NativeDeviceGrant {
  refreshToken: string;
  deviceId: string;
  deviceExpiresAt: number;
}

/** The token or authorization endpoint answered with an OAuth error. Codes only, never logged. */
export class NativeOAuthError extends Error {
  constructor(readonly code: string, readonly description?: string) { super('OAuth sign-in was refused'); }
}

/** Shapes shared with the account broker's own refresh grant. */
export const DEVICE_REFRESH_TOKEN = /^[A-Za-z0-9_-]{32,512}$/;
export const DEVICE_ID = /^[\x21-\x7e]{1,200}$/;
/** The issuer caps a device at one year; allow a day of clock skew and nothing more. */
export const DEVICE_MAX_LIFETIME_MS = 367 * 24 * 60 * 60 * 1000;
export function parseDeviceGrant(value: Record<string, unknown>, now = Date.now()): NativeDeviceGrant | undefined {
  const { refresh_token: refreshToken, device_id: deviceId, device_expires_at: deviceExpiresAt } = value;
  if (typeof refreshToken !== 'string' || !DEVICE_REFRESH_TOKEN.test(refreshToken)) return undefined;
  if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) return undefined;
  if (typeof deviceExpiresAt !== 'number' || !Number.isSafeInteger(deviceExpiresAt) || deviceExpiresAt <= now || deviceExpiresAt > now + DEVICE_MAX_LIFETIME_MS) return undefined;
  return { refreshToken, deviceId, deviceExpiresAt };
}

/** Tokens stay memory-only in this first slice; no fallback to plaintext/obfuscated disk storage. */
export interface NativeMcpOAuth {
  readonly resource: string;
  /** Controller inspection/testing only. Transports must use transport(), never this mutable provider. */
  readonly provider: OAuthClientProvider;
  readonly fetch: FetchLike;
  /** One noninteractive, account-generation-bound SDK transport context. */
  transport(): { authProvider: OAuthClientProvider; fetch: FetchLike };
  /** Main-process snapshot with the original expiry deadline, never exposed over IPC. */
  credentialSnapshot(): { token: OAuthTokens; expiresAt: number } | undefined;
  authorize(signal?: AbortSignal): Promise<void>;
  /** The device grant of the last completed `authorize()`, handed over once (then forgotten here). */
  takeDeviceGrant(): NativeDeviceGrant | undefined;
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
  if (options.clientId && !/^[A-Za-z0-9._-]{1,128}$/.test(options.clientId)) throw new Error('Invalid public client ID');
  if (options.callbackPath && !/^\/[A-Za-z0-9/_-]{1,128}$/.test(options.callbackPath)) throw new Error('Invalid loopback callback path');
  if (options.deviceName !== undefined && !/^[\x20-\x7e]{1,60}$/.test(options.deviceName)) throw new Error('Invalid device name');
  if (options.maxTokenAgeSeconds !== undefined && (!Number.isSafeInteger(options.maxTokenAgeSeconds) || options.maxTokenAgeSeconds <= 0)) throw new Error('Invalid token lifetime limit');
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
  let device: NativeDeviceGrant | undefined;
  let endpointError: NativeOAuthError | undefined;

  /** `detached`: a device code exchange. Once sent, it is allowed to finish (bounded) even if the
   *  sign-in is cancelled, so a grant it returns can be revoked instead of left live. */
  const guardedFetch = async (input: string | URL, init?: RequestInit, detached?: { signal: AbortSignal }): Promise<Response> => {
    const url = secureUrl(input);
    if (!origins.has(url.origin)) throw new Error('MCP OAuth endpoint is outside the approved resource and issuer');
    if (new Headers(init?.headers).get('authorization')?.toLowerCase().startsWith('bearer ') && url.href !== resource) throw new Error('MCP bearer token cannot leave its exact resource');
    const signal = AbortSignal.any([lifetime.signal, ...(active ? [active.signal] : []), ...(init?.signal ? [init.signal] : [])]);
    signal.throwIfAborted();
    const response = await (options.fetch ?? fetch)(input, { ...init, signal: detached ? detached.signal : signal, redirect: 'manual' });
    if (signal.aborted && !detached) { await response.body?.cancel(); signal.throwIfAborted(); }
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
    clientInformation() { return options.clientId ? { client_id: options.clientId, token_endpoint_auth_method: 'none' } : client; },
    saveClientInformation(value) {
      if (!active || active.signal.aborted || value.client_secret || ('token_endpoint_auth_method' in value && value.token_endpoint_auth_method !== 'none')) throw new Error('Desktop OAuth requires a public client');
      if (options.clientId && value.client_id !== options.clientId) throw new Error('Registered client cannot be replaced');
      client = value;
    },
    tokens() { return tokens && Date.now() < expiresAt ? { ...tokens } : undefined; },
    saveTokens(value) {
      if (!active || active.signal.aborted) throw new Error('MCP sign-in is no longer active');
      const deadline = Date.now() + (value.expires_in ?? 0) * 1000;
      if (!value.access_token || value.token_type.toLowerCase() !== 'bearer' || !value.expires_in || value.expires_in <= 0 || !Number.isSafeInteger(deadline)) throw new Error('MCP OAuth requires a bounded bearer token');
      if (options.maxTokenAgeSeconds && value.expires_in > options.maxTokenAgeSeconds) throw new Error('Token exceeds approved lifetime');
      if (value.scope?.split(' ').some((scope) => !scopes.includes(scope))) throw new Error('MCP OAuth returned an unapproved scope');
      // Renewal needs account/device revocation first. Do not retain refresh tokens yet.
      tokens = { access_token: value.access_token, token_type: value.token_type, expires_in: value.expires_in, ...(value.scope ? { scope: value.scope } : {}) };
      expiresAt = deadline;
    },
    saveCodeVerifier(value) { if (!active || active.signal.aborted) throw new Error('Start an explicit MCP sign-in first'); verifier = value; },
    codeVerifier() { if (!verifier) throw new Error('MCP sign-in verifier is unavailable'); return verifier; },
    async redirectToAuthorization(url) {
      if (!active || active.signal.aborted) throw new Error('MCP sign-in required; authorize explicitly');
      const target = secureUrl(url);
      const endpoint = discovery?.authorizationServerMetadata?.authorization_endpoint;
      if (!endpoint) throw new Error('Unexpected MCP authorization request');
      const expected = secureUrl(endpoint);
      // The SDK appends OAuth parameters to an endpoint that can already have a query.
      const fixedQueryChanged = [...expected.searchParams.keys()].some((key) => JSON.stringify(target.searchParams.getAll(key)) !== JSON.stringify(expected.searchParams.getAll(key)));
      if (target.origin !== expected.origin || target.pathname !== expected.pathname || fixedQueryChanged || target.searchParams.get('state') !== state || target.searchParams.get('code_challenge_method') !== 'S256' || target.searchParams.get('resource') !== resource || target.searchParams.get('scope') !== scopes.join(' ')) throw new Error('Unexpected MCP authorization request');
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
    device = undefined;
    endpointError = undefined;
  }

  /** The token response, minus everything the SDK must not hold: refresh and device fields are
   *  kept here (device client only) and stripped from what the SDK parses, so its own refresh
   *  logic can never see a refresh token. Error codes are noted for the caller's message. A read
   *  that finishes after its attempt was cancelled changes nothing. */
  async function inspectTokenResponse(response: Response, attempt: AbortSignal): Promise<Response> {
    const headers = new Headers(response.headers);
    headers.delete('content-length'); headers.delete('content-encoding');
    const init = { status: response.status, statusText: response.statusText, headers };
    let value: unknown;
    // Read to the end even after a cancel: a device grant in a late body must still be revoked.
    try { value = await response.json(); }
    catch { attempt.throwIfAborted(); return new Response(null, init); }
    if (attempt.aborted) {
      const late = response.ok && options.deviceName && value && typeof value === 'object' && !Array.isArray(value) ? parseDeviceGrant(value as Record<string, unknown>) : undefined;
      if (late) abandon(late);
      attempt.throwIfAborted();
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return new Response(JSON.stringify(value), init);
    const record = value as Record<string, unknown>;
    if (!response.ok) {
      // The first refusal is the meaningful one; anything after it is fallout.
      if (typeof record.error === 'string') endpointError ??= new NativeOAuthError(record.error.slice(0, 64), typeof record.error_description === 'string' ? record.error_description.slice(0, 128) : undefined);
      return new Response(JSON.stringify(record), init);
    }
    const { refresh_token: _refresh, device_id: _id, device_expires_at: _expires, ...rest } = record;
    if (options.deviceName) device = parseDeviceGrant(record);
    return new Response(JSON.stringify(rest), init);
  }

  function abandon(grant: NativeDeviceGrant) {
    try { options.onAbandonedDeviceGrant?.(grant); } catch { /* best effort */ }
  }

  function transport(): { authProvider: OAuthClientProvider; fetch: FetchLike } {
    if (active) throw new Error('Wait for explicit MCP sign-in to finish before connecting');
    const epoch = generation;
    const owner = lifetime;
    const assertCurrent = () => {
      if (epoch !== generation || owner.signal.aborted) throw new Error('MCP connection authorization is no longer current');
    };
    const operational = new Set<PropertyKey>(['tokens', 'invalidateCredentials']);
    const authProvider = new Proxy(provider, {
      get(target, key, receiver) {
        assertCurrent();
        if (!operational.has(key)) throw new Error('MCP sign-in required; authorize explicitly');
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? (...args: unknown[]) => {
          assertCurrent();
          return Reflect.apply(value, target, args);
        } : value;
      }
    });
    const fetch: FetchLike = async (input, init) => {
      assertCurrent();
      if (secureUrl(input).href !== resource) throw new Error('MCP connection cannot perform OAuth discovery or authorization');
      const response = await guardedFetch(input, { ...init, signal: AbortSignal.any([owner.signal, ...(init?.signal ? [init.signal] : [])]) });
      if (epoch !== generation || owner.signal.aborted) {
        await response.body?.cancel();
        assertCurrent();
      }
      return response;
    };
    return { authProvider, fetch };
  }

  return {
    resource, provider, fetch: guardedFetch, clear, transport,
    credentialSnapshot: () => tokens && Date.now() < expiresAt ? { token: { ...tokens }, expiresAt } : undefined,
    takeDeviceGrant() { const grant = device; device = undefined; return grant; },
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
      const callbackPath = options.callbackPath ?? `/oauth/${randomBytes(24).toString('hex')}`;
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
          const refused = url.searchParams.get('error');
          res.writeHead(400).end('Sign-in was not completed.'); fail(refused && /^[a-z_]{1,64}$/.test(refused) ? new NativeOAuthError(refused) : new Error('MCP authorization denied or invalid callback')); return;
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
        // Racing the SDK releases an abandoned sign-in even if a custom fetch/body ignores abort.
        // Bind every continuation to this attempt so a late response cannot touch a newer login.
        const attemptProvider = new Proxy(provider, {
          get(target, key, receiver) {
            controller.signal.throwIfAborted();
            const value = Reflect.get(target, key, receiver);
            return typeof value === 'function' ? (...args: unknown[]) => {
              controller.signal.throwIfAborted();
              return Reflect.apply(value, target, args);
            } : value;
          }
        });
        // An authorization code is single-use. The SDK retries the exchange after an
        // invalid_grant/invalid_client answer; that second POST could only replace the issuer's real
        // answer (e.g. fresh_sign_in_required) with a generic one, so it is never sent.
        let codeExchanged = false;
        const attemptFetch: FetchLike = async (input, init) => {
          controller.signal.throwIfAborted();
          const tokenEndpoint = discovery?.authorizationServerMetadata?.token_endpoint;
          const isToken = !!tokenEndpoint && init?.method === 'POST' && secureUrl(input).href === secureUrl(tokenEndpoint).href;
          let body = init?.body;
          const isCodeExchange = isToken && body instanceof URLSearchParams && body.get('grant_type') === 'authorization_code';
          if (isCodeExchange) {
            if (codeExchanged) throw new Error('Authorization code already exchanged');
            codeExchanged = true;
          }
          if (isCodeExchange && options.deviceName && body instanceof URLSearchParams) {
            body = new URLSearchParams(body);
            body.set('device_name', options.deviceName);
          }
          const attemptInit = { ...init, body, signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]) };
          const response = isCodeExchange && options.deviceName
            ? await guardedFetch(input, attemptInit, { signal: AbortSignal.timeout(30_000) })
            : await guardedFetch(input, attemptInit);
          return isToken ? inspectTokenResponse(response, controller.signal) : response;
        };
        const result = await abortable(auth(attemptProvider, { serverUrl: resource, scope: scopes.join(' '), fetchFn: attemptFetch }), controller.signal);
        if (result !== 'REDIRECT') throw new Error('Expected an interactive MCP sign-in');
        const code = await codePromise;
        const exchanged = await abortable(auth(attemptProvider, { serverUrl: resource, authorizationCode: code, scope: scopes.join(' '), fetchFn: attemptFetch }), controller.signal);
        if (exchanged !== 'AUTHORIZED' || generation !== current || controller.signal.aborted || !tokens) throw new Error('MCP sign-in was not completed');
      } catch (error) {
        tokens = undefined;
        expiresAt = 0;
        if (device) abandon(device);
        device = undefined;
        // The SDK retries an invalid_client/invalid_grant exchange and then fails on something
        // else; the endpoint's own answer is the one worth reporting.
        throw endpointError ?? error;
      } finally {
        endpointError = undefined;
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
