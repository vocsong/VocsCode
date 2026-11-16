/** The relay Worker's front door (docs/REMOTE-ACCESS.md §7). Every `/v1` request is classified
 *  here before it costs more than header parsing: a route the Hub does not serve is answered at
 *  once, and every route — authenticated ones included, since authentication has not happened yet
 *  — passes an edge rate limit keyed on route and caller address, a credential-shape check, a
 *  route-sized body budget and a body-read deadline; device routes then pass a per-device limit
 *  too. Only then is the body buffered and the Hub woken.
 *  Cloudflare-free — the bindings are structural — so tests/relay-edge.test.ts runs it in plain
 *  Node.
 *
 *  The edge counters (Workers Rate Limiting) live at each Cloudflare location, cost no Durable
 *  Object work, and survive the Hub hibernating, which resets the Hub's own in-memory limiter.
 *  They are per location and eventually consistent: an abuse brake, not accounting. */
import { CONTROL_PATH } from './control-auth';
import { callerKey } from './rate';
import { json } from './routes';

/** The Workers Rate Limiting binding's shape. */
export interface EdgeLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface EdgeLimiters {
  PAIR_LIMIT?: EdgeLimiter;
  POLL_LIMIT?: EdgeLimiter;
  TOKEN_LIMIT?: EdgeLimiter;
  /** Device routes, per device and address: one desktop's or browser's own traffic. */
  DEVICE_LIMIT?: EdgeLimiter;
  /** Device routes, per address: one total across all of them, shared by every device behind it. */
  ADDRESS_LIMIT?: EdgeLimiter;
}

/** Pairing, token, owner and device-control bodies are a few hundred bytes of JSON. */
export const SMALL_BODY_BYTES = 16 * 1024;
/** The mirror uploads only: a sealed blob is at most 1.9M characters plus its JSON wrapper. */
export const MAX_BODY_BYTES = 2_500_000;
/** How long a body may take to arrive in full. Slow senders are cut off, not waited on. */
export const SMALL_BODY_DEADLINE_MS = 10_000;
export const BULK_BODY_DEADLINE_MS = 60_000;

/** What a request must carry before the Worker reads its body or asks the Hub. Shape only: nothing
 *  is looked up, so a refusal here says nothing about whether a device or account exists.
 *  - `none`: public, or checked by the Worker itself before any body is read (the landing's
 *    account assertion on pairing and owner routes).
 *  - `device`: a `device` id and a relay-minted bearer (access or refresh token).
 *  - `device-or-secret`: as a device when `device` is named, else a bearer secret (the
 *    enrollment credential), as `/pair/start` takes them.
 *  - `host-socket`: a device bearer, or the secret for the `enrolling` desktop.
 *  - `ticket`: a `device` id and a single-use socket ticket in the query. */
type Credential = 'none' | 'device' | 'device-or-secret' | 'host-socket' | 'ticket';

export interface EdgeRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Exact path, or a prefix when `prefix` is set. Every id under a prefix shares one budget. */
  path: string;
  prefix?: boolean;
  /** Consulted for every request on the route, keyed on route and caller address — or on the
   *  caller alone when `callerWide`, so the budget is one total across every such route. */
  binding: keyof EdgeLimiters;
  callerWide?: boolean;
  /** Consulted once the credential has the route's shape, keyed on route, device and address, so
   *  devices sharing an address (NAT) each get their own budget under the address ceiling. */
  deviceBinding?: keyof EdgeLimiters;
  credential: Credential;
  /** Takes a mirror blob; every other route gets the small budget. */
  bulk?: boolean;
}

const DEVICE = { binding: 'ADDRESS_LIMIT', callerWide: true, deviceBinding: 'DEVICE_LIMIT' } as const;

/** The Worker's view of the Hub's route table (relay/src/routes.ts) plus the two sockets. A route
 *  missing here is a 404 at the edge; tests/relay-edge.test.ts checks every Hub route is listed. */
const EDGE_ROUTES: EdgeRoute[] = [
  { method: 'POST', path: '/v1/pair/start', binding: 'PAIR_LIMIT', credential: 'device-or-secret' },
  // The account assertion on these is verified in the Worker before any Hub is selected.
  { method: 'POST', path: '/v1/pair/claim', binding: 'PAIR_LIMIT', credential: 'none' },
  { method: 'GET', path: '/v1/pair/poll', binding: 'POLL_LIMIT', credential: 'none' },
  // Keyed on the address alone: devices refresh about hourly, and naming more device ids must not
  // buy more attempts. Other addresses keep their own budgets.
  { method: 'POST', path: '/v1/token/challenge', binding: 'TOKEN_LIMIT', credential: 'device' },
  { method: 'POST', path: '/v1/token', binding: 'TOKEN_LIMIT', credential: 'device' },
  // Polled while the owner signs in, like /pair/poll; the one-time secret is in the body.
  { method: 'POST', path: '/v1/enroll/redeem', binding: 'POLL_LIMIT', credential: 'none' },
  // Owner routes also need the landing's service credential, which the Hub checks.
  { method: 'POST', path: '/v1/owner/enroll-grant', binding: 'POLL_LIMIT', credential: 'none' },
  { method: 'GET', path: '/v1/owner/enroll-grant', binding: 'POLL_LIMIT', credential: 'none' },
  { method: 'GET', path: '/v1/owner/hosts', binding: 'POLL_LIMIT', credential: 'none' },
  { method: 'POST', path: '/v1/owner/pair-request', binding: 'PAIR_LIMIT', credential: 'none' },
  // Device routes: one total per address across all of them (whatever route or device id a request
  // names), then each device's own budget per route. A desktop's first mirror sync uploads up to ~50
  // sessions at once, and a busy one re-uploads each active session every few seconds; every
  // session id under a prefix shares its route's per-device counter.
  { method: 'POST', path: '/v1/ws/ticket', ...DEVICE, credential: 'device' },
  { method: 'GET', path: '/v1/ws/host', ...DEVICE, credential: 'host-socket' },
  { method: 'GET', path: '/v1/ws/client', ...DEVICE, credential: 'ticket' },
  { method: 'GET', path: '/v1/devices', ...DEVICE, credential: 'device' },
  { method: 'DELETE', path: '/v1/devices', ...DEVICE, credential: 'device' },
  { method: 'POST', path: '/v1/devices/revoke-all', ...DEVICE, credential: 'device' },
  { method: 'GET', path: '/v1/mirrors', ...DEVICE, credential: 'device' },
  { method: 'GET', path: '/v1/mirror', ...DEVICE, credential: 'device' },
  { method: 'PUT', path: '/v1/mirror', ...DEVICE, credential: 'device', bulk: true },
  { method: 'DELETE', path: '/v1/mirror', ...DEVICE, credential: 'device' },
  { method: 'GET', path: '/v1/mirror/', prefix: true, ...DEVICE, credential: 'device' },
  { method: 'PUT', path: '/v1/mirror/', prefix: true, ...DEVICE, credential: 'device', bulk: true },
  { method: 'DELETE', path: '/v1/mirror/', prefix: true, ...DEVICE, credential: 'device' },
  // The controller endpoint reads and bounds its own body (control-auth.ts); limited here only.
  { method: 'POST', path: CONTROL_PATH, binding: 'POLL_LIMIT', credential: 'none' }
];

type EdgeMatch = { kind: 'route'; route: EdgeRoute } | { kind: 'method'; methods: string[] } | { kind: 'none' };

/** Exact beats prefix and the longest path wins, as in the Hub's own matcher. */
function matchEdge(method: string, pathname: string): EdgeMatch {
  const byPath = EDGE_ROUTES.filter((r) => (r.prefix ? pathname.startsWith(r.path) && pathname.length > r.path.length : pathname === r.path));
  if (byPath.length === 0) return { kind: 'none' };
  const route = byPath.filter((r) => r.method === method).sort((a, b) => b.path.length - a.path.length)[0];
  return route ? { kind: 'route', route } : { kind: 'method', methods: [...new Set(byPath.map((r) => r.method))] };
}

/** The edge classification for a `/v1` path, or null when the edge would refuse it. */
export function edgeRouteFor(method: string, pathname: string): EdgeRoute | null {
  const match = matchEdge(method, pathname);
  return match.kind === 'route' ? match.route : null;
}

function limitKey(route: EdgeRoute, request: Request, device?: string): string {
  const caller = callerKey(request.headers.get('cf-connecting-ip'));
  const bucket = `${route.method} ${route.path}`;
  if (device !== undefined) return `${bucket}|${device}|${caller}`;
  return route.callerWide ? caller : `${bucket}|${caller}`;
}

/** A 429 when the edge limit for this endpoint is spent; null to pass the request on. A
 *  deployment without the bindings (older config, tests) is not limited here. */
export async function edgeLimited(request: Request, limiters: EdgeLimiters): Promise<Response | null> {
  const url = new URL(request.url);
  const match = matchEdge(request.method, url.pathname);
  if (match.kind !== 'route') return null;
  return limit(limiters[match.route.binding], limitKey(match.route, request));
}

async function limit(limiter: EdgeLimiter | undefined, key: string): Promise<Response | null> {
  if (!limiter) return null;
  const { success } = await limiter.limit({ key });
  return success ? null : json({ error: 'rate limited' }, 429, { 'retry-after': '60', 'x-relay-limit': 'edge' });
}

/** Every relay-minted bearer (access, refresh, poll token, socket ticket) is 32 random bytes, base64url. */
const MINTED_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_ID = /^[A-Za-z0-9_.-]{1,256}$/;
/** Operator-chosen; any visible ASCII, bounded. */
const SECRET = /^[\x21-\x7e]{1,1024}$/;

function bearer(request: Request): string | null {
  const h = request.headers.get('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

/** The refusal the Hub itself gives a missing or wrong credential on this route, or null. */
function credentialRefusal(route: EdgeRoute, url: URL, request: Request): Response | null {
  const device = url.searchParams.get('device');
  const token = bearer(request) ?? '';
  const asDevice = device !== null && DEVICE_ID.test(device) && MINTED_TOKEN.test(token);
  const invalid = () => json({ error: 'invalid' }, 401);
  const forbidden = () => json({ error: 'forbidden' }, 403);
  switch (route.credential) {
    case 'none':
      return null;
    case 'device':
      return asDevice ? null : invalid();
    case 'device-or-secret':
      if (url.searchParams.has('device')) return asDevice ? null : invalid();
      return SECRET.test(token) ? null : forbidden();
    case 'host-socket':
      if (url.searchParams.has('token') || url.searchParams.has('ticket')) return invalid();
      return (device === 'enrolling' ? SECRET.test(token) : asDevice) ? null : invalid();
    case 'ticket':
      return device !== null && DEVICE_ID.test(device) && MINTED_TOKEN.test(url.searchParams.get('ticket') ?? '') ? null : invalid();
  }
}

/** A request the edge let through, with the body budget it was admitted under. */
export interface Admitted {
  maxBody: number;
  deadlineMs: number;
}

/** Everything the edge decides from the request line and headers alone, in cost order: route,
 *  address rate limit (consulted for every routed request, before any refusal), body size, credential
 *  shape, then the device's own limit. A Response is the refusal; nothing has been read or looked up. */
export async function admit(request: Request, limiters: EdgeLimiters): Promise<Admitted | Response> {
  const url = new URL(request.url);
  const refuse = async (response: Response): Promise<Response> => {
    await request.body?.cancel().catch(() => undefined);
    return response;
  };
  if (!url.pathname.startsWith('/v1/')) return refuse(json({ error: 'not found' }, 404));
  const match = matchEdge(request.method, url.pathname);
  if (match.kind === 'none') return refuse(json({ error: 'not found' }, 404));
  if (match.kind === 'method') return refuse(json({ error: 'method not allowed' }, 405, { allow: match.methods.join(', ') }));
  const { route } = match;
  const limited = await limit(limiters[route.binding], limitKey(route, request));
  if (limited) return refuse(limited);
  const declared = request.headers.get('content-length');
  // A route that takes no body (GET) is refused one rather than forwarded with it unread.
  if (route.method === 'GET' && (request.body !== null || request.headers.has('transfer-encoding') || (declared !== null && declared !== '0'))) {
    return refuse(json({ error: 'invalid' }, 400));
  }
  const maxBody = route.bulk ? MAX_BODY_BYTES : SMALL_BODY_BYTES;
  if (declared !== null && (!/^\d{1,15}$/.test(declared) || Number(declared) > maxBody)) return refuse(json({ error: 'too large' }, 413));
  const refused = credentialRefusal(route, url, request);
  if (refused) return refuse(refused);
  if (route.deviceBinding) {
    const device = await limit(limiters[route.deviceBinding], limitKey(route, request, url.searchParams.get('device') ?? ''));
    if (device) return refuse(device);
  }
  return { maxBody, deadlineMs: route.bulk ? BULK_BODY_DEADLINE_MS : SMALL_BODY_DEADLINE_MS };
}

type Hub = () => { fetch(request: Request): Promise<Response> };

/** Hands an admitted request to the Hub with `/v1` stripped. Bodies are read here, within the
 *  admitted budget and deadline, before the Hub sees the request: the Hub may answer before
 *  reading one (a refused credential), and a body still streaming through would then be read after
 *  the response was sent — an uncaught error the runtime raises on every such request. */
export async function forwardAdmitted(request: Request, admitted: Admitted, hub: Hub): Promise<Response> {
  const inner = new URL(request.url);
  inner.pathname = inner.pathname.slice(3); // strip /v1
  if (request.method === 'GET' || request.method === 'HEAD' || !request.body) return hub().fetch(new Request(inner, request));
  const body = await readBounded(request.body, admitted.maxBody, admitted.deadlineMs);
  if (body === 'too-large') return json({ error: 'too large' }, 413);
  if (body === 'timeout') return json({ error: 'timeout' }, 408);
  return hub().fetch(new Request(inner, { method: request.method, headers: request.headers, body }));
}

/** The whole edge path for one request: admit, then forward. */
export async function forwardToHub(request: Request, limiters: EdgeLimiters, hub: Hub): Promise<Response> {
  const admitted = await admit(request, limiters);
  return admitted instanceof Response ? admitted : forwardAdmitted(request, admitted, hub);
}

/** The whole body, or why not: more than `limit` bytes arrived (whatever was declared), or it did
 *  not finish within `deadlineMs`. Stops reading at the first byte over the budget. */
async function readBounded(stream: ReadableStream<Uint8Array>, limit: number, deadlineMs: number): Promise<Uint8Array<ArrayBuffer> | 'too-large' | 'timeout'> {
  const reader = stream.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), deadlineMs); });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), expired]);
      if (next === 'timeout') {
        void reader.cancel().catch(() => undefined);
        return 'timeout';
      }
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => undefined);
        return 'too-large';
      }
      chunks.push(next.value);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const out = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
