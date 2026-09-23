/** HTTP routing for the relay hub (docs/REMOTE-ACCESS.md). Deliberately a declarative,
 *  deny-by-default table: every route names the authentication it needs — `public`, `enroll`,
 *  `device` or `host` — and the dispatcher authorizes before the handler runs, so a new route
 *  cannot ship unauthenticated by forgetting a check. Cloudflare-free (no DurableObjectState, no
 *  WebSocketPair), so the whole surface is exercised in plain Node (tests/relay-routes.test.ts). */
import type { PublicIdentity } from '../../src/shared/crypto';
import {
  claimPairing,
  clearMirror,
  deleteMirrorSession,
  deviceInfos,
  getMirrorIndex,
  getMirrorSession,
  MirrorError,
  PairError,
  pollPairing,
  putMirrorIndex,
  putMirrorSession,
  resolvePairing,
  revokeDevice,
  startPairing,
  verifyDeviceToken,
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
  now: number;
  /** Caller address for rate limiting; null when the edge sends none. */
  ip: string | null;
  rate: RateLimiter;
  /** Sockets currently connected for a tag, for pairing fan-out and revocation. */
  sockets: (tag: string) => SocketLike[];
}

/** What a route requires before its handler runs. */
export type RouteAuth = 'public' | 'enroll' | 'device' | 'host';

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
  { method: 'POST', path: '/pair/start', auth: 'enroll', rate: { bucket: 'pair-start', limit: 10, windowMs: 60_000 }, run: pairStart },
  { method: 'POST', path: '/pair/claim', auth: 'public', rate: { bucket: 'pair-claim', limit: 10, windowMs: 60_000 }, run: pairClaim },
  // Polling runs ~50 times a minute for five minutes, so the budget only catches abuse.
  { method: 'GET', path: '/pair/poll', auth: 'public', rate: { bucket: 'pair-poll', limit: 120, windowMs: 60_000 }, run: pairPoll },
  { method: 'GET', path: '/devices', auth: 'device', run: deviceList },
  { method: 'DELETE', path: '/devices', auth: 'device', run: deviceRevoke },
  { method: 'GET', path: '/mirror', auth: 'device', run: mirrorGetIndex },
  { method: 'PUT', path: '/mirror', auth: 'host', run: mirrorPutIndex },
  { method: 'DELETE', path: '/mirror', auth: 'host', run: mirrorClear },
  { method: 'GET', path: '/mirror/', prefix: true, auth: 'device', run: mirrorGetSession },
  { method: 'PUT', path: '/mirror/', prefix: true, auth: 'host', run: mirrorPutSession },
  { method: 'DELETE', path: '/mirror/', prefix: true, auth: 'host', run: mirrorDeleteSession }
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
  // A freshly enabled desktop has no device token yet: it authenticates with the enrollment
  // secret and stays in pairing-only mode until pair.result mints one.
  if (kind === 'host' && url.searchParams.get('device') === 'enrolling') {
    if (bearer(request) !== ctx.enrollToken) return { ok: false, status: 401, error: 'invalid' };
    return { ok: true, deviceId: 'enrolling' };
  }
  try {
    return { ok: true, deviceId: (await authDevice(request, url, ctx)).deviceId };
  } catch (e) {
    return { ok: false, status: 401, error: e instanceof PairError ? e.code : 'invalid' };
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
  if (auth === 'enroll') {
    if (bearer(request) !== ctx.enrollToken) throw new HttpError('forbidden', 403);
    return null;
  }
  const device = await authDevice(request, url, ctx);
  // Writes to the mirror come from the desktop only; browsers read it.
  if (auth === 'host' && device.kind !== 'host') throw new HttpError('forbidden', 403);
  return device;
}

async function authDevice(request: Request, url: URL, ctx: RouteContext): Promise<DeviceRecord> {
  // Browsers cannot set custom WS headers, so the device token may ride in the query.
  const token = bearer(request) || url.searchParams.get('token') || '';
  const deviceId = url.searchParams.get('device') ?? '';
  return verifyDeviceToken(ctx.store, { accountId: ctx.accountId, deviceId, token }, ctx.now);
}

/** The authenticated device, asserted for routes whose auth guarantees one. */
function actor(device: DeviceRecord | null): DeviceRecord {
  if (!device) throw new HttpError('unauthorized', 401);
  return device;
}

// --- handlers ---

async function pairStart({ ctx, request }: Call): Promise<Response> {
  const body = (await request.json()) as { name?: string; platform?: string; hostPub?: PublicIdentity };
  if (!body.hostPub) throw new HttpError('invalid', 400);
  const r = await startPairing(ctx.store, { accountId: ctx.accountId, hostName: body.name ?? 'desktop', hostPlatform: body.platform ?? '', hostPub: body.hostPub }, ctx.now);
  return json(r);
}

async function pairClaim({ ctx, request }: Call): Promise<Response> {
  const body = (await request.json()) as { code?: string; name?: string; platform?: string; webPub?: PublicIdentity };
  if (!body.code || !body.webPub) throw new HttpError('invalid', 400);
  await claimPairing(ctx.store, { code: body.code, webName: body.name ?? 'browser', webPlatform: body.platform ?? '', webPub: body.webPub }, ctx.now);
  // Ask every online desktop of the account to confirm; first responder wins.
  for (const ws of ctx.sockets(BROADCAST_TAG.host)) {
    ws.send(JSON.stringify({ t: 'pair.request', code: body.code, name: body.name ?? 'browser', platform: body.platform ?? '' }));
  }
  return json({ ok: true });
}

async function pairPoll({ ctx, url }: Call): Promise<Response> {
  return json(await pollPairing(ctx.store, url.searchParams.get('code') ?? '', ctx.now));
}

async function deviceList({ ctx }: Call): Promise<Response> {
  // Authenticated, and only public metadata leaves the DO: token hashes and key material stay put.
  return json(await deviceInfos(ctx.store, ctx.accountId));
}

async function deviceRevoke({ ctx, url }: Call): Promise<Response> {
  // `device`/`token` authenticate the caller (either a paired desktop or browser); `target`
  // names the device to drop, so one side can revoke the other (lost-laptop / lost-desktop).
  const target = url.searchParams.get('target');
  if (!target) throw new HttpError('invalid', 400);
  await revokeDevice(ctx.store, ctx.accountId, target);
  for (const tag of [`client:${target}`, `host:${target}`]) {
    for (const ws of ctx.sockets(tag)) ws.close(1008, 'device revoked');
  }
  return json({ ok: true });
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
  // An unverifiable device token is an auth failure, not a server error — and the code in the
  // body is the only detail a caller gets.
  if (e instanceof PairError) return json({ error: e.code }, 401);
  return json({ error: e instanceof Error ? e.message : String(e) }, 500);
}

function bearer(request: Request): string {
  const h = request.headers.get('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
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
