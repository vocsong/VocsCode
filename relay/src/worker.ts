/** Vocs relay (docs/REMOTE-ACCESS.md): opaque e2e frames and tenant state live in one Hub Durable
 *  Object per account. The landing signs GitHub account assertions; device ids carry a MACed
 *  routing hint, but every selected Hub still verifies the device's proof-of-possession token. */
import type { RelayStorage, RelayStore } from './core';
import { ENROLL_GRANT_TTL_MS, hashToken, PairError } from './core';
import { accountIdFromDeviceId, ACCOUNT_ASSERTION_HEADER, INTERNAL_ACCOUNT_AUTH_HEADER, INTERNAL_ACCOUNT_ID_HEADER, isAccountId, LEGACY_ACCOUNT_ID, verifyAccountAssertion } from './account';
import { forwardToHub } from './edge';
import { HubRouter } from './hub';
import { FixedWindowLimiter } from './rate';
import { authorizeSocket, BROADCAST_TAG, handleHttp, json, type RouteContext } from './routes';

const ACCOUNT_STORAGE_KEY = '__vocs_account_id__';
const DIRECTORY_NAME = 'connect-enrollment-v1';
const DIRECTORY_KEY_PREFIX = 'nonce:';
const NONCE_HASH = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();

function hasDeviceRouteSecret(secret: string | undefined): secret is string {
  return !!secret && encoder.encode(secret).byteLength >= 32;
}

export interface Env {
  HUB: DurableObjectNamespace;
  ENROLLMENTS: DurableObjectNamespace;
  /** The incumbent account id; untagged, already-issued device ids remain here. */
  RELAY_ACCOUNT: string;
  /** Legacy/manual enrollment secret. New computers use the signed-in owner grant. */
  ENROLL_TOKEN: string;
  /** Shared only by the landing and relay Workers; verifies the landing's signed account assertions. */
  ACCOUNT_ASSERTION_SECRET?: string;
  /** Relay-only HMAC key for device-id route hints. Keep stable until a device-id migration. */
  DEVICE_ROUTE_SECRET?: string;
  /** Edge rate limits (wrangler.jsonc `ratelimits`); absent from configs that predate them. */
  PAIR_LIMIT?: RateLimit;
  POLL_LIMIT?: RateLimit;
  TOKEN_LIMIT?: RateLimit;
}

function storageAdapter(storage: DurableObjectStorage | DurableObjectTransaction): RelayStorage {
  return {
    get: (key) => storage.get(key),
    put: (key, value) => storage.put(key, value),
    delete: async (key) => { await storage.delete(key); },
    list: async <T,>(prefix: string) => {
      const out: Array<[string, T]> = [];
      let cursor = await storage.list({ prefix, limit: 100 });
      while (true) {
        for (const [key, value] of cursor) out.push([key, value as T]);
        if (cursor.size < 100) break;
        cursor = await storage.list({ prefix, startAfter: [...cursor.keys()].at(-1), limit: 100 });
      }
      return out;
    }
  };
}

function relayStore(state: DurableObjectState): RelayStore {
  return {
    ...storageAdapter(state.storage),
    transaction: (work) => state.storage.transaction((tx) => work(storageAdapter(tx)))
  };
}

/** One account's sockets, registry, pairing codes, rate counters, queues and mirror. The account
 *  id is pinned in storage on first access so a Worker routing bug cannot reuse one Hub for tenants. */
export class Hub {
  private readonly store: RelayStore;
  private readonly rate = new FixedWindowLimiter();
  private accountId: string | null = null;
  private accountInit: Promise<boolean> | null = null;

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    this.store = relayStore(state);
  }

  private async pinAccount(accountId: string): Promise<boolean> {
    if (!isAccountId(accountId)) return false;
    if (this.accountId !== null) return this.accountId === accountId;
    this.accountInit ??= (async () => {
      const existing = await this.state.storage.get<string>(ACCOUNT_STORAGE_KEY);
      if (existing !== undefined && existing !== accountId) return false;
      if (existing === undefined) await this.state.storage.put(ACCOUNT_STORAGE_KEY, accountId);
      this.accountId = accountId;
      return true;
    })();
    return (await this.accountInit) && this.accountId === accountId;
  }

  private async storedAccount(): Promise<string | null> {
    if (this.accountId) return this.accountId;
    const value = await this.state.storage.get<string>(ACCOUNT_STORAGE_KEY);
    if (!isAccountId(value)) return null;
    this.accountId = value;
    return value;
  }

  private router(accountId: string): HubRouter<WebSocket> {
    return new HubRouter({
      store: this.store,
      accountId,
      deviceRouteSecret: this.env.DEVICE_ROUTE_SECRET,
      now: Date.now,
      sockets: {
        byTag: (tag) => this.state.getWebSockets(tag),
        tags: (ws) => this.state.getTags(ws),
        attachment: (ws) => ws.deserializeAttachment(),
        attach: (ws, value) => ws.serializeAttachment(value),
        isOpen: (ws) => ws.readyState === WebSocket.OPEN
      }
    });
  }

  private context(request: Request, accountId: string): RouteContext {
    return {
      store: this.store,
      accountId,
      enrollToken: this.env.ENROLL_TOKEN,
      accountAuthenticated: request.headers.get(INTERNAL_ACCOUNT_AUTH_HEADER) === '1',
      deviceRouteSecret: this.env.DEVICE_ROUTE_SECRET,
      bindEnrollment: async (input) => {
        const directory = this.env.ENROLLMENTS.get(this.env.ENROLLMENTS.idFromName(DIRECTORY_NAME));
        const response = await directory.fetch(new Request('https://enrollments/bind', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input)
        }));
        if (response.ok) return;
        const body = await response.json().catch(() => ({})) as { error?: unknown };
        if (body.error === 'used') throw new PairError('used');
        throw new Error('enrollment directory unavailable');
      },
      now: Date.now(),
      ip: request.headers.get('cf-connecting-ip'),
      rate: this.rate,
      sockets: (tag) => this.state.getWebSockets(tag)
    };
  }

  async fetch(request: Request): Promise<Response> {
    const accountId = request.headers.get(INTERNAL_ACCOUNT_ID_HEADER) ?? '';
    if (!(await this.pinAccount(accountId))) return json({ error: 'invalid account' }, 403);
    const url = new URL(request.url);
    // Only the bound EnrollmentDirectory may reach this private subroute. The public Worker refuses
    // /v1/__internal/* before it can select a Hub and strips all internal headers on normal routes.
    if (url.pathname.startsWith('/__internal/')) {
      if (url.pathname !== '/__internal/enroll/redeem' || request.method !== 'POST') return json({ error: 'not found' }, 404);
      url.pathname = '/enroll/redeem';
      const headers = new Headers(request.headers);
      const body = await request.arrayBuffer();
      return handleHttp(new Request(url.toString(), { method: 'POST', headers, body }), this.context(request, accountId));
    }
    if (url.pathname === '/ws/host' || url.pathname === '/ws/client') {
      // Do not burn a single-use ticket for a plain GET or malformed upgrade.
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      if (request.headers.get('upgrade')?.toLowerCase().trim() !== 'websocket') {
        return json({ error: 'upgrade required' }, 426, { upgrade: 'websocket' });
      }
      const kind = url.pathname === '/ws/host' ? 'host' : 'client';
      const auth = await authorizeSocket(kind, request, this.context(request, accountId));
      if (!auth.ok) return json({ error: auth.error }, auth.status);
      const pair = new WebSocketPair();
      // Tags are Hub-local: distinct account Durable Objects cannot fan out across tenants.
      this.state.acceptWebSocket(pair[1], [`${kind}:${auth.deviceId}`, BROADCAST_TAG[kind]]);
      // Revocation may commit after ticket consumption but before acceptance; re-check before drain.
      if (kind === 'client') await this.router(accountId).clientOpened(pair[1], auth.deviceId);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return handleHttp(request, this.context(request, accountId));
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const accountId = await this.storedAccount();
    if (accountId) await this.router(accountId).message(ws, message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const accountId = await this.storedAccount();
    if (accountId) this.router(accountId).closed(ws);
    // This Worker's compatibility date predates automatic close-frame replies. 1005/1006 are
    // reported for a peer that vanished without a close frame and may never be sent back.
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }
}

interface EnrollmentBinding {
  accountId: string;
  expiresAt: number;
}

/** Short-lived global nonce-hash → account pointer for the desktop's nonce-only redemption poll.
 *  It contains no device credentials or session data; the tenant Hub retains the grant itself. */
export class EnrollmentDirectory {
  private readonly store: RelayStore;

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    this.store = relayStore(state);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/bind' && request.method === 'POST') return this.bind(request);
    if (url.pathname === '/enroll/redeem' && request.method === 'POST') return this.redeem(request);
    return json({ error: 'not found' }, 404);
  }

  private async bind(request: Request): Promise<Response> {
    try {
      const input = await request.json() as Partial<EnrollmentBinding> & { nonceHash?: unknown };
      const now = Date.now();
      const accountId = input.accountId;
      const expiresAt = input.expiresAt;
      const nonceHash = input.nonceHash;
      if (typeof nonceHash !== 'string' || !NONCE_HASH.test(nonceHash) || !isAccountId(accountId) ||
          typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= now ||
          expiresAt > now + ENROLL_GRANT_TTL_MS + 60_000) return json({ error: 'invalid' }, 400);
      const key = `${DIRECTORY_KEY_PREFIX}${nonceHash}`;
      await this.store.transaction(async (tx) => {
        const current = await tx.get<EnrollmentBinding>(key);
        if (current && current.expiresAt > now && current.accountId !== accountId) throw new PairError('used');
        await tx.put(key, { accountId, expiresAt } satisfies EnrollmentBinding);
        for (const [stale, record] of await tx.list<EnrollmentBinding>(DIRECTORY_KEY_PREFIX)) {
          if (now >= record.expiresAt) await tx.delete(stale);
        }
      });
      return json({ ok: true }, 200, { 'cache-control': 'no-store' });
    } catch (error) {
      if (error instanceof PairError && error.code === 'used') return json({ error: 'used' }, 409);
      if (error instanceof SyntaxError) return json({ error: 'invalid' }, 400);
      return json({ error: 'directory unavailable' }, 500);
    }
  }

  private async redeem(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      const value = await request.json() as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return json({ error: 'invalid' }, 400);
      body = value as Record<string, unknown>;
    } catch {
      return json({ error: 'invalid' }, 400);
    }
    if (typeof body.nonce !== 'string' || !NONCE.test(body.nonce)) return json({ error: 'invalid' }, 400);
    const nonceHash = await hashToken(body.nonce);
    const binding = await this.store.get<EnrollmentBinding>(`${DIRECTORY_KEY_PREFIX}${nonceHash}`);
    if (!binding || Date.now() >= binding.expiresAt) return json({ status: 'pending' }, 200, { 'cache-control': 'no-store' });
    const hub = this.env.HUB.get(this.env.HUB.idFromName(binding.accountId));
    const internal = new Request('https://hub/__internal/enroll/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [INTERNAL_ACCOUNT_ID_HEADER]: binding.accountId },
      body: JSON.stringify(body)
    });
    return hub.fetch(internal);
  }
}

async function routeAccount(request: Request, env: Env): Promise<{ accountId: string; authenticated: boolean } | Response> {
  const url = new URL(request.url);
  const legacyAccount = isAccountId(env.RELAY_ACCOUNT) ? env.RELAY_ACCOUNT : LEGACY_ACCOUNT_ID;
  const hasAssertion = request.headers.has(ACCOUNT_ASSERTION_HEADER);
  const assertedAccount = hasAssertion ? await verifyAccountAssertion(request, env.ACCOUNT_ASSERTION_SECRET) : null;
  if (hasAssertion && !assertedAccount) return json({ error: 'invalid account assertion' }, 401);

  const accountPairRoute = url.pathname === '/v1/pair/claim' || url.pathname === '/v1/pair/poll';
  const ownerRoute = url.pathname.startsWith('/v1/owner/');
  const sessionRoute = accountPairRoute || ownerRoute;
  // A direct local relay preview may omit the landing's shared secret; keep legacy code pairing
  // usable there only. Production has the secret and workers.dev is disabled, so this is never an
  // account-selection fallback on the public service.
  const localLegacyPairing = !env.ACCOUNT_ASSERTION_SECRET && accountPairRoute;
  if (sessionRoute && !assertedAccount && !localLegacyPairing) return json({ error: 'not authenticated' }, 401);

  const device = url.searchParams.get('device');
  if (device) {
    const deviceAccount = device === 'enrolling' ? legacyAccount : (await accountIdFromDeviceId(device, env.DEVICE_ROUTE_SECRET, legacyAccount)) ?? legacyAccount;
    if (assertedAccount && assertedAccount !== deviceAccount) return json({ error: 'account mismatch' }, 403);
    if (deviceAccount !== legacyAccount && !hasDeviceRouteSecret(env.DEVICE_ROUTE_SECRET)) return json({ error: 'account routing unavailable' }, 503);
    return { accountId: deviceAccount, authenticated: !!assertedAccount || localLegacyPairing };
  }
  const accountId = assertedAccount ?? legacyAccount;
  if (accountId !== legacyAccount && !hasDeviceRouteSecret(env.DEVICE_ROUTE_SECRET)) return json({ error: 'account routing unavailable' }, 503);
  return { accountId, authenticated: !!assertedAccount || localLegacyPairing };
}

export default {
  fetch: async (request: Request, env: Env): Promise<Response> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/v1/')) return json({ error: 'not found' }, 404);
    // This RPC is reachable only through the directory's DO binding, never through public /v1.
    if (url.pathname.startsWith('/v1/__internal/')) return json({ error: 'not found' }, 404);
    const stripInternal = (source: Request, accountId?: string, authenticated = false): Request => {
      const headers = new Headers(source.headers);
      headers.delete(ACCOUNT_ASSERTION_HEADER);
      headers.delete(INTERNAL_ACCOUNT_ID_HEADER);
      headers.delete(INTERNAL_ACCOUNT_AUTH_HEADER);
      if (accountId) headers.set(INTERNAL_ACCOUNT_ID_HEADER, accountId);
      if (authenticated) headers.set(INTERNAL_ACCOUNT_AUTH_HEADER, '1');
      return new Request(source, { headers });
    };
    if (url.pathname === '/v1/enroll/redeem') {
      const request_ = stripInternal(request);
      return forwardToHub(request_, env, () => env.ENROLLMENTS.get(env.ENROLLMENTS.idFromName(DIRECTORY_NAME)));
    }
    const selected = await routeAccount(request, env);
    if (selected instanceof Response) return selected;
    const routed = stripInternal(request, selected.accountId, selected.authenticated);
    const namespace = env.HUB.get(env.HUB.idFromName(selected.accountId));
    return forwardToHub(routed, env, () => namespace);
  }
} as ExportedHandler<Env>;
