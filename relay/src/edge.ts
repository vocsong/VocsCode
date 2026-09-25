/** The relay Worker's front door (docs/REMOTE-ACCESS.md §7): only `/v1` reaches the Hub, and the
 *  unauthenticated and credential-exchange endpoints pass an edge rate limit first. Cloudflare-free
 *  — the bindings are structural — so tests/relay-edge.test.ts runs it in plain Node.
 *
 *  The edge counters (Workers Rate Limiting) live at each Cloudflare location, cost no Durable
 *  Object work, and survive the Hub hibernating, which resets the Hub's own in-memory limiter.
 *  They are eventually consistent: an abuse brake, not accounting. */
import { json } from './routes';

/** The Workers Rate Limiting binding's shape. */
export interface EdgeLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface EdgeLimiters {
  PAIR_LIMIT?: EdgeLimiter;
  POLL_LIMIT?: EdgeLimiter;
  TOKEN_LIMIT?: EdgeLimiter;
}

/** Token endpoints key on the device as well as the address, so no one can exhaust another
 *  device's refresh from elsewhere. Authenticated routes and sockets are left to the Hub. */
const EDGE_LIMITS: Record<string, { binding: keyof EdgeLimiters; perDevice?: boolean }> = {
  '/v1/pair/start': { binding: 'PAIR_LIMIT' },
  '/v1/pair/claim': { binding: 'PAIR_LIMIT' },
  '/v1/pair/poll': { binding: 'POLL_LIMIT' },
  '/v1/token/challenge': { binding: 'TOKEN_LIMIT', perDevice: true },
  '/v1/token': { binding: 'TOKEN_LIMIT', perDevice: true },
  // Polled while the owner signs in, like /pair/poll.
  '/v1/enroll/redeem': { binding: 'POLL_LIMIT' },
  '/v1/owner/enroll-grant': { binding: 'POLL_LIMIT' },
  '/v1/owner/hosts': { binding: 'POLL_LIMIT' },
  '/v1/owner/pair-request': { binding: 'PAIR_LIMIT' }
};

/** A 429 when the edge limit for this endpoint is spent; null to pass the request on. A
 *  deployment without the bindings (older config, tests) is not limited here. */
export async function edgeLimited(request: Request, limiters: EdgeLimiters): Promise<Response | null> {
  const url = new URL(request.url);
  const rule = EDGE_LIMITS[url.pathname];
  const limiter = rule ? limiters[rule.binding] : undefined;
  if (!rule || !limiter) return null;
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const key = rule.perDevice ? `${url.pathname}|${url.searchParams.get('device') ?? ''}|${ip}` : `${url.pathname}|${ip}`;
  const { success } = await limiter.limit({ key });
  return success ? null : json({ error: 'rate limited' }, 429, { 'retry-after': '60', 'x-relay-limit': 'edge' });
}

/** Larger than any route's body: the biggest is a sealed mirror blob (at most 1.9M characters). */
export const MAX_BODY_BYTES = 2_500_000;

/** The Worker entry: `/v1/*` only, edge-limited, then handed to the Hub with `/v1` stripped.
 *  Bodies are read here, bounded, before the Hub sees the request: the Hub may answer before
 *  reading one (a refused credential), and a body still streaming through would then be read after
 *  the response was sent — an uncaught error the runtime raises on every such request. */
export async function forwardToHub(request: Request, limiters: EdgeLimiters, hub: () => { fetch(request: Request): Promise<Response> }): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/v1/')) return new Response('not found', { status: 404 });
  const limited = await edgeLimited(request, limiters);
  if (limited) return limited;
  const inner = new URL(request.url);
  inner.pathname = url.pathname.slice(3); // strip /v1
  if (request.method === 'GET' || request.method === 'HEAD' || !request.body) return hub().fetch(new Request(inner, request));
  const body = await readBounded(request, MAX_BODY_BYTES);
  if (!body) return json({ error: 'too large' }, 413);
  return hub().fetch(new Request(inner, { method: request.method, headers: request.headers, body }));
}

/** The whole body, or null once it passes `limit` bytes (declared or actual). */
async function readBounded(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(request.headers.get('content-length') ?? 0) > limit) {
    await request.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = request.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
