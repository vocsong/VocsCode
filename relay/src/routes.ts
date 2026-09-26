/** HTTP routing for the relay hub (docs/REMOTE-ACCESS.md). Deliberately a declarative,
 *  deny-by-default table: every route names the authentication it needs and the dispatcher
 *  authorizes before the handler runs, so a new route cannot ship unauthenticated by forgetting a
 *  check. `device`/`web`/`host` require a short-lived access token; only the two token endpoints
 *  accept the long-lived refresh credential, and only together with a signed challenge.
 *  Cloudflare-free (no DurableObjectState, no WebSocketPair), so the whole surface is exercised in
 *  plain Node (tests/relay-routes.test.ts). */
import type { PublicIdentity } from '../../src/shared/crypto';
import {
  claimPairing,
  clearMirror,
  consumeSocketTicket,
  deleteMirrorSession,
  deviceInfos,
  ENROLL_GRANT_TTL_MS,
  enrollmentStatus,
  getMirrorIndex,
  grantEnrollment,
  getMirrorSession,
  issueAccessToken,
  issueChallenge,
  issueSocketTicket,
  listMirrorSessions,
  MirrorError,
  PairError,
  pollPairing,
  putMirrorIndex,
  putMirrorSession,
  redeemEnrollment,
  requestPairing,
  resolvePairing,
  revokeAllExcept,
  revokeDevice,
  startPairing,
  verifyAccessToken,
  verifyRefreshToken,
  type DeviceRecord,
  type MirrorBlob,
  type RelayStore
} from './core';
import type { RateLimiter } from './rate';

/** The slice of a websocket the router needs (the platform's `WebSocket` satisfies it). */
export interface SocketLike {
  send(data: string): void;
  close(code: number, reason: string): void;
}

/** Broadcast tags carried by every connected socket, for fan-out that is not device-specific.
 *  Durable Object tag matching is exact, so a `host:` prefix does NOT match `host:<id>` — a socket
 *  must carry the bare tag as well as its own targeted one. */
export const BROADCAST_TAG = { host: 'hosts', client: 'clients' } as const;

export interface RouteContext {
  store: RelayStore;
  accountId: string;
  enrollToken: string;
  /** True only when the Worker verified the landing's short-lived GitHub account assertion. */
  accountAuthenticated?: boolean;
  /** Relay-only key for MACed device routing hints; independent from the landing assertion key. */
  deviceRouteSecret?: string;
  /** Directory pointer used to route a desktop's nonce-only enrollment redemption. */
  bindEnrollment?: (input: { nonceHash: string; accountId: string; expiresAt: number }) => Promise<void>;
  now: number;
  /** Caller address for rate limiting; null when the edge sends none. */
  ip: string | null;
  rate: RateLimiter;
  /** Sockets currently connected for a tag, for pairing fan-out and revocation. */
  sockets: (tag: string) => SocketLike[];
}

/** What a route requires before its handler runs. `refresh` is a device's refresh credential
 *  (token endpoints only). `account` and `owner` require a verified landing assertion; `owner` also
 *  requires the landing service credential. `enroll-or-host` retains the legacy enrollment secret
 *  path for `vocs-v1` or an enrolled desktop's access token. */
export type RouteAuth = 'public' | 'account' | 'owner' | 'enroll' | 'enroll-or-host' | 'refresh' | 'device' | 'web' | 'host';

interface RateRule {
  bucket: string;
  limit: number;
  windowMs: number;
}

interface Call {
  ctx: RouteContext;
  request: Request;
  url: URL;
  /** Trailing path for prefix routes — the session id for `/mirror/<id>`. */
  rest: string;
  /** The authenticated device for `device`/`host` routes, null otherwise. */
  device: DeviceRecord | null;
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Exact path, or a prefix when `prefix` is set. */
  path: string;
  prefix?: boolean;
  auth: RouteAuth;
  rate?: RateRule;
  run: (call: Call) => Promise<Response>;
}

/** The whole HTTP surface. Anything not listed here is a 404 — that is the point. */
export const ROUTES: Route[] = [
  { method: 'POST', path: '/pair/start', auth: 'enroll-or-host', rate: { bucket: 'pair-start', limit: 10, windowMs: 60_000 }, run: pairStart },
  // The landing binds these browser claims and polls to the signed-in GitHub account.
  { method: 'POST', path: '/pair/claim', auth: 'account', rate: { bucket: 'pair-claim', limit: 10, windowMs: 60_000 }, run: pairClaim },
  // Polling runs ~50 times a minute for five minutes, so the budget only catches abuse.
  { method: 'GET', path: '/pair/poll', auth: 'account', rate: { bucket: 'pair-poll', limit: 120, windowMs: 60_000 }, run: pairPoll },
  // Access tokens: a refresh credential buys a challenge; signing it with the device key buys an
  // hour-long access token. Rate limited per caller so neither can be hammered.
  { method: 'POST', path: '/token/challenge', auth: 'refresh', rate: { bucket: 'token', limit: 30, windowMs: 60_000 }, run: tokenChallenge },
  { method: 'POST', path: '/token', auth: 'refresh', rate: { bucket: 'token', limit: 30, windowMs: 60_000 }, run: tokenIssue },
  { method: 'POST', path: '/ws/ticket', auth: 'web', run: socketTicket },
  { method: 'GET', path: '/devices', auth: 'device', run: deviceList },
  { method: 'DELETE', path: '/devices', auth: 'device', run: deviceRevoke },
  // The kill switch: a desktop revokes every other device of the account at once.
  { method: 'POST', path: '/devices/revoke-all', auth: 'host', run: deviceRevokeAll },
  // A desktop's own mirrored-session catalogue (ids, sizes, times), to delete what it no longer lists.
  { method: 'GET', path: '/mirrors', auth: 'host', run: mirrorList },
  { method: 'GET', path: '/mirror', auth: 'device', run: mirrorGetIndex },
  { method: 'PUT', path: '/mirror', auth: 'host', run: mirrorPutIndex },
  { method: 'DELETE', path: '/mirror', auth: 'host', run: mirrorClear },
  { method: 'GET', path: '/mirror/', prefix: true, auth: 'device', run: mirrorGetSession },
  { method: 'PUT', path: '/mirror/', prefix: true, auth: 'host', run: mirrorPutSession },
  { method: 'DELETE', path: '/mirror/', prefix: true, auth: 'host', run: mirrorDeleteSession },
  // Owner actions: add a computer that clicked Connect with GitHub, list this account's computers,
  // and ask one to pair a browser. Both the verified account assertion and landing service credential
  // are required. The desktop still approves each pairing.
  { method: 'POST', path: '/owner/enroll-grant', auth: 'owner', rate: { bucket: 'enroll-grant', limit: 10, windowMs: 60_000 }, run: ownerEnrollGrant },
  { method: 'GET', path: '/owner/enroll-grant', auth: 'owner', run: ownerEnrollStatus },
  { method: 'GET', path: '/owner/hosts', auth: 'owner', run: ownerHosts },
  { method: 'POST', path: '/owner/pair-request', auth: 'owner', rate: { bucket: 'pair-request', limit: 10, windowMs: 60_000 }, run: ownerPairRequest },
  // A desktop redeems the owner's grant with its one-time secret, polling while the owner signs in.
  { method: 'POST', path: '/enroll/redeem', auth: 'public', rate: { bucket: 'enroll-redeem', limit: 120, windowMs: 60_000 }, run: enrollRedeem }
];

export async function handleHttp(request: Request, ctx: RouteContext): Promise<Response> {
  const url = new URL(request.url);
  const matched = matchRoute(request.method, url.pathname);
  if (matched.kind === 'none') return json({ error: 'not found' }, 404);
  if (matched.kind === 'method') return json({ error: 'method not allowed' }, 405, { allow: matched.methods.join(', ') });
  const { route, rest } = matched;
  try {
    if (route.rate && !ctx.rate.hit(`${route.rate.bucket}:${ctx.ip ?? 'unknown'}`, route.rate.limit, route.rate.windowMs)) {
      return json({ error: 'rate limited' }, 429);
    }
    const device = await authorize(route.auth, request, url, ctx);
    return await route.run({ ctx, request, url, rest, device });
  } catch (e) {
    return errorResponse(e);
  }
}

export type SocketAuth = { ok: true; deviceId: string } | { ok: false; status: number; error: string };

/** Auth for the two WebSocket endpoints; the Worker owns the `WebSocketPair` itself. */
export async function authorizeSocket(kind: 'host' | 'client', request: Request, ctx: RouteContext): Promise<SocketAuth> {
  const url = new URL(request.url);
  const deviceId = url.searchParams.get('device') ?? '';
  // Never accept the long-lived bearer in a socket URL, even if a valid ticket is present.
  // Browsers cannot set upgrade headers; desktops can and must use Authorization only.
  if (url.searchParams.has('token') || (kind === 'client' && (request.headers.has('authorization') || !url.searchParams.has('ticket'))) ||
      (kind === 'host' && (url.searchParams.has('ticket') || !bearer(request)))) {
    return { ok: false, status: 401, error: 'invalid' };
  }
  try {
    if (kind === 'client') {
      return { ok: true, deviceId: await consumeSocketTicket(ctx.store, { accountId: ctx.accountId, deviceId, ticket: url.searchParams.get('ticket') ?? '' }, ctx.now) };
    }
    // A freshly enabled desktop has no device token yet: it authenticates with the
    // enrollment secret and stays in pairing-only mode until pair.result mints one.
    if (deviceId === 'enrolling') {
      if (!ctx.enrollToken || bearer(request) !== ctx.enrollToken) throw new PairError('invalid');
      return { ok: true, deviceId };
    }
    const device = await authDevice(request, url, ctx);
    if (device.kind !== 'host') throw new PairError('invalid');
    return { ok: true, deviceId: device.deviceId };
  } catch (e) {
    if (!(e instanceof PairError)) throw e;
    return { ok: false, status: 401, error: e.code };
  }
}

// --- dispatch internals ---

type Match = { kind: 'route'; route: Route; rest: string } | { kind: 'method'; methods: string[] } | { kind: 'none' };

/** Exact beats prefix, and the longest path wins, so matching never depends on table order. */
function matchRoute(method: string, pathname: string): Match {
  const byPath = ROUTES.filter((r) => (r.prefix ? pathname.startsWith(r.path) : pathname === r.path));
  if (byPath.length === 0) return { kind: 'none' };
  const candidates = byPath.filter((r) => r.method === method).sort((a, b) => b.path.length - a.path.length);
  if (candidates.length === 0) return { kind: 'method', methods: [...new Set(byPath.map((r) => r.method))] };
  const route = candidates[0];
  return { kind: 'route', route, rest: route.prefix ? decodeURIComponent(pathname.slice(route.path.length)) : '' };
}

async function authorize(auth: RouteAuth, request: Request, url: URL, ctx: RouteContext): Promise<DeviceRecord | null> {
  if (auth === 'public') return null;
  if (auth === 'account') {
    if (!ctx.accountAuthenticated) throw new HttpError('not authenticated', 401);
    return null;
  }
  if (auth === 'owner') {
    if (!ctx.accountAuthenticated || !ctx.enrollToken || bearer(request) !== ctx.enrollToken) throw new HttpError('forbidden', 403);
    return null;
  }
  if (auth === 'enroll' || (auth === 'enroll-or-host' && !url.searchParams.has('device'))) {
    if (!ctx.enrollToken || bearer(request) !== ctx.enrollToken) throw new HttpError('forbidden', 403);
    return null;
  }
  if (auth === 'refresh') {
    // Awaited, not returned: a rejection must be handled in this frame (workerd reports a
    // rejected promise handed up a frame as unhandled).
    return await verifyRefreshToken(ctx.store, { accountId: ctx.accountId, deviceId: url.searchParams.get('device') ?? '', token: bearer(request) });
  }
  const device = await authDevice(request, url, ctx);
  if (auth === 'enroll-or-host' && device.kind !== 'host') throw new HttpError('forbidden', 403);
  if (auth === 'host' && device.kind !== 'host') throw new HttpError('forbidden', 403);
  if (auth === 'web' && device.kind !== 'web') throw new HttpError('forbidden', 403);
  return device;
}

async function authDevice(request: Request, url: URL, ctx: RouteContext): Promise<DeviceRecord> {
  // REST always requires Authorization; a query bearer is never a fallback. The bearer must be
  // an access token: a refresh credential alone authorizes nothing here.
  const token = bearer(request);
  const deviceId = url.searchParams.get('device') ?? '';
  return await verifyAccessToken(ctx.store, { accountId: ctx.accountId, deviceId, token }, ctx.now);
}

/** The authenticated device, asserted for routes whose auth guarantees one. */
function actor(device: DeviceRecord | null): DeviceRecord {
  if (!device) throw new HttpError('unauthorized', 401);
  return device;
}

// --- handlers ---

async function pairStart({ ctx, request, device }: Call): Promise<Response> {
  const body = await readJson(request);
  // An enrolled desktop pairs as itself: its registered key, not whatever the body claims.
  const hostPub = device ? device.pub : publicIdentity(body.hostPub);
  const r = await startPairing(ctx.store, {
    accountId: ctx.accountId,
    hostName: label(body.name, device?.name ?? 'desktop'),
    hostPlatform: label(body.platform, device?.platform ?? ''),
    hostPub,
    hostDeviceId: device?.deviceId
  }, ctx.now);
  return json(r);
}

async function pairClaim({ ctx, request }: Call): Promise<Response> {
  const body = await readJson(request);
  if (typeof body.code !== 'string' || !body.code) throw new HttpError('invalid', 400);
  const webPub = publicIdentity(body.webPub);
  const name = label(body.name, 'browser');
  const platform = label(body.platform, '');
  const { pollToken, hostPub } = await claimPairing(ctx.store, { code: body.code, webName: name, webPlatform: platform, webPub }, ctx.now);
  // Broadcast public identities; only the owning desktop may display or sign this request.
  const request_ = JSON.stringify({ t: 'pair.request', code: body.code, name, platform, hostPub, webPub });
  for (const ws of ctx.sockets(BROADCAST_TAG.host)) trySend(ws, request_);
  return json({ pollToken });
}

async function pairPoll({ ctx, url, request }: Call): Promise<Response> {
  return json(await pollPairing(ctx.store, url.searchParams.get('code') ?? '', bearer(request), ctx.now));
}

async function tokenChallenge({ ctx, request, device }: Call): Promise<Response> {
  const issued = await issueChallenge(ctx.store, { accountId: ctx.accountId, deviceId: actor(device).deviceId, token: bearer(request) }, ctx.now);
  return json(issued, 200, { 'cache-control': 'no-store' });
}

async function tokenIssue({ ctx, request, device }: Call): Promise<Response> {
  const body = await readJson(request);
  const issued = await issueAccessToken(ctx.store, {
    accountId: ctx.accountId, deviceId: actor(device).deviceId, token: bearer(request), challenge: body.challenge, signature: body.signature
  }, ctx.now);
  return json(issued, 200, { 'cache-control': 'no-store' });
}

async function socketTicket({ ctx, request, device }: Call): Promise<Response> {
  // Re-check inside the issue transaction: revocation may race the route's preliminary
  // authorization, and no ticket may survive a concurrent deletion of its device.
  const { ticket, expiresAt } = await issueSocketTicket(ctx.store, {
    accountId: ctx.accountId, deviceId: actor(device).deviceId, token: bearer(request)
  }, ctx.now);
  return json({ ticket, expiresAt }, 200, { 'cache-control': 'no-store' });
}

async function deviceList({ ctx }: Call): Promise<Response> {
  // Authenticated, and only public metadata leaves the DO: token hashes and key material stay put.
  // Presence is which devices have a socket open right now.
  return json(await deviceInfos(ctx.store, ctx.accountId, (d) => ctx.sockets(`${d.kind === 'host' ? 'host' : 'client'}:${d.deviceId}`).length > 0));
}

async function deviceRevoke({ ctx, url }: Call): Promise<Response> {
  // `device` plus the Authorization bearer authenticate the caller; `target`
  // names the device to drop, so one side can revoke the other (lost-laptop / lost-desktop).
  const target = url.searchParams.get('target');
  if (!target) throw new HttpError('invalid', 400);
  const revoked = await revokeDevice(ctx.store, ctx.accountId, target);
  closeAndNotify(ctx, revoked);
  return json({ ok: true, revoked });
}

async function deviceRevokeAll({ ctx, device }: Call): Promise<Response> {
  const revoked = await revokeAllExcept(ctx.store, ctx.accountId, actor(device).deviceId);
  closeAndNotify(ctx, revoked);
  return json({ ok: true, revoked });
}

/** Revoked devices lose their sockets at once. Desktops reconcile their paired-browser lists (and
 *  rotate mirror keys) on the notice: a hint, not authority, since a desktop re-reads the
 *  registry before dropping anything. */
function closeAndNotify(ctx: RouteContext, revoked: string[]): void {
  const closed = new Set<SocketLike>();
  for (const id of revoked) {
    for (const tag of [`client:${id}`, `host:${id}`]) {
      for (const ws of ctx.sockets(tag)) {
        closed.add(ws);
        try {
          ws.close(1008, 'device revoked');
        } catch {
          // Already closing.
        }
      }
    }
  }
  // A revoked desktop's own socket was just closed: sending to it would throw.
  const notice = JSON.stringify({ t: 'device.revoked', devices: revoked });
  for (const ws of ctx.sockets(BROADCAST_TAG.host)) if (!closed.has(ws)) trySend(ws, notice);
}

/** A fan-out send. The runtime throws for a socket that is closing; one departing peer must not
 *  fail the request that is broadcasting to the others. */
function trySend(ws: SocketLike, data: string): void {
  try {
    ws.send(data);
  } catch {
    // Closing; its close handler reports the departure.
  }
}

async function ownerEnrollGrant({ ctx, request }: Call): Promise<Response> {
  const body = await readJson(request);
  const nonceHash = body.nonceHash as string;
  const expiresAt = ctx.now + ENROLL_GRANT_TTL_MS;
  // Reserve the nonce globally before writing the tenant grant. If a later write fails, a retry
  // by this same account is idempotent; another account can never adopt the same connect link.
  await ctx.bindEnrollment?.({ nonceHash, accountId: ctx.accountId, expiresAt });
  const granted = await grantEnrollment(ctx.store, { accountId: ctx.accountId, nonceHash }, ctx.now);
  return json(granted, 200, { 'cache-control': 'no-store' });
}

async function ownerEnrollStatus({ ctx, url }: Call): Promise<Response> {
  const status = await enrollmentStatus(ctx.store, { accountId: ctx.accountId, nonceHash: url.searchParams.get('h') ?? '' }, ctx.now);
  return json(status, 200, { 'cache-control': 'no-store' });
}

async function ownerHosts({ ctx }: Call): Promise<Response> {
  // Public metadata only, as for /devices, with each computer's presence.
  const infos = await deviceInfos(ctx.store, ctx.accountId, (d) => d.kind === 'host' && ctx.sockets(`host:${d.deviceId}`).length > 0);
  return json(infos.filter((d) => d.kind === 'host'), 200, { 'cache-control': 'no-store' });
}

async function ownerPairRequest({ ctx, request }: Call): Promise<Response> {
  const body = await readJson(request);
  if (typeof body.hostDeviceId !== 'string' || !body.hostDeviceId) throw new HttpError('invalid', 400);
  const webPub = publicIdentity(body.webPub);
  const name = label(body.name, 'browser');
  const platform = label(body.platform, '');
  // The desktop must be there to decide; a request it never sees would only strand the browser.
  const sockets = ctx.sockets(`host:${body.hostDeviceId}`);
  if (!sockets.length) throw new HttpError('host-offline', 409);
  const r = await requestPairing(ctx.store, { accountId: ctx.accountId, hostDeviceId: body.hostDeviceId, webName: name, webPlatform: platform, webPub }, ctx.now);
  // Only that desktop is asked: this request names it, unlike a code any desktop might have minted.
  const frame = JSON.stringify({ t: 'pair.request', code: r.code, name, platform, hostPub: r.hostPub, webPub, requested: true });
  for (const ws of sockets) trySend(ws, frame);
  return json({ code: r.code, pollToken: r.pollToken, hostName: r.hostName }, 200, { 'cache-control': 'no-store' });
}

async function enrollRedeem({ ctx, request }: Call): Promise<Response> {
  const body = await readJson(request);
  const hostPub = publicIdentity(body.hostPub);
  const redemption = await redeemEnrollment(ctx.store, {
    accountId: ctx.accountId,
    nonce: body.nonce as string,
    hostPub,
    name: label(body.name, 'desktop'),
    platform: label(body.platform, ''),
    deviceRouteSecret: ctx.deviceRouteSecret
  }, ctx.now);
  return json(redemption, 200, { 'cache-control': 'no-store' });
}

async function mirrorList({ ctx, device }: Call): Promise<Response> {
  return json(await listMirrorSessions(ctx.store, ctx.accountId, actor(device).deviceId, ctx.now));
}

async function mirrorGetIndex({ ctx, url, device }: Call): Promise<Response> {
  // A browser names the desktop it paired with; a desktop defaults to itself.
  const hostId = url.searchParams.get('host') || actor(device).deviceId;
  const record = await getMirrorIndex(ctx.store, ctx.accountId, hostId, ctx.now);
  return json(record?.blob ?? null);
}

async function mirrorPutIndex({ ctx, request, device }: Call): Promise<Response> {
  const host = actor(device);
  const blob = await readBlob(request);
  await putMirrorIndex(ctx.store, { accountId: ctx.accountId, hostId: host.deviceId, blob }, ctx.now);
  return json({ ok: true });
}

async function mirrorClear({ ctx, device }: Call): Promise<Response> {
  const host = actor(device);
  await clearMirror(ctx.store, ctx.accountId, host.deviceId);
  return json({ ok: true });
}

async function mirrorGetSession({ ctx, url, rest, device }: Call): Promise<Response> {
  const hostId = url.searchParams.get('host') || actor(device).deviceId;
  return json((await getMirrorSession(ctx.store, { accountId: ctx.accountId, hostId, sessionId: rest }, ctx.now)) ?? null);
}

async function mirrorPutSession({ ctx, request, rest, device }: Call): Promise<Response> {
  const host = actor(device);
  const blob = await readBlob(request);
  await putMirrorSession(ctx.store, { accountId: ctx.accountId, hostId: host.deviceId, sessionId: rest, blob }, ctx.now);
  return json({ ok: true });
}

async function mirrorDeleteSession({ ctx, rest, device }: Call): Promise<Response> {
  const host = actor(device);
  await deleteMirrorSession(ctx.store, ctx.accountId, host.deviceId, rest);
  return json({ ok: true });
}

// --- helpers ---

/** An HTTP failure a handler wants surfaced verbatim; everything else is auth being absent. */
export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message }, e.status);
  if (e instanceof MirrorError) return json({ error: e.code }, e.code === 'too-large' ? 413 : 400);
  // The account is full: a conflict the user resolves by revoking a device, not an auth failure.
  if (e instanceof PairError && e.code === 'limit') return json({ error: 'device-limit' }, 409);
  // An unverifiable device token is an auth failure, not a server error — and the code in the
  // body is the only detail a caller gets.
  if (e instanceof PairError) return json({ error: e.code }, 401);
  // A malformed body is the caller's error; never echo parser internals.
  if (e instanceof SyntaxError) return json({ error: 'invalid' }, 400);
  return json({ error: e instanceof Error ? e.message : String(e) }, 500);
}

function bearer(request: Request): string {
  const h = request.headers.get('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

const MAX_LABEL = 64;
const MAX_JWK_FIELD = 128;

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body = (await request.json()) as unknown;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError('invalid', 400);
  return body as Record<string, unknown>;
}

/** Device names and platforms are shown to the user and stored per device: bounded plain text. */
function label(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text ? text.slice(0, MAX_LABEL) : fallback;
}

/** A P-256 public identity as the clients export it. Checked for shape and size because it is
 *  stored per device and broadcast to desktops; the exact JWK is kept, since both ends compare
 *  identities by their canonical JSON. */
function publicIdentity(value: unknown): PublicIdentity {
  const jwk = (v: unknown): boolean => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const k = v as Record<string, unknown>;
    return k.kty === 'EC' && k.crv === 'P-256' && typeof k.x === 'string' && typeof k.y === 'string' &&
      k.d === undefined && Object.values(k).every((f) => (typeof f === 'string' ? f.length <= MAX_JWK_FIELD : typeof f === 'boolean' || (Array.isArray(f) && f.length <= 8 && f.every((op) => typeof op === 'string' && op.length <= 16))));
  };
  const id = value as { sig?: unknown; enc?: unknown } | null;
  if (!id || typeof id !== 'object' || !jwk(id.sig) || !jwk(id.enc) || Object.keys(id).length !== 2) throw new HttpError('invalid', 400);
  return value as PublicIdentity;
}

/** Reads and shape-checks a sealed mirror blob; the relay never looks inside `ct`. */
async function readBlob(request: Request): Promise<MirrorBlob> {
  const body = (await request.json()) as Partial<MirrorBlob>;
  if (!body || typeof body.iv !== 'string' || typeof body.ct !== 'string') throw new HttpError('invalid', 400);
  return { iv: body.iv, ct: body.ct };
}

export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}
