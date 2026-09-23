/** Edge rate limits at the relay Worker's front door (relay/src/edge.ts): the public and
 *  credential-exchange endpoints are limited before a request can wake the Hub. Runs the real
 *  entry logic in Node with counting stand-ins for the Workers Rate Limiting bindings; the
 *  workerd suite checks the bindings exist in the real runtime config. */
import { describe, expect, it } from 'vitest';
import { edgeLimited, forwardToHub, MAX_BODY_BYTES, type EdgeLimiters } from '../relay/src/edge';

function limiter(allow: number) {
  const counts = new Map<string, number>();
  return {
    keys: () => [...counts.keys()],
    limit: async ({ key }: { key: string }) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= allow };
    }
  };
}

function entry(limiters: EdgeLimiters = {}) {
  const seen: string[] = [];
  const hub = () => ({
    fetch: async (request: Request) => {
      seen.push(new URL(request.url).pathname);
      return new Response('from the hub');
    }
  });
  const call = (path: string, ip = '198.51.100.7') =>
    forwardToHub(new Request(`https://relay.test${path}`, { method: 'POST', headers: { 'cf-connecting-ip': ip } }), limiters, hub);
  return { call, seen };
}

describe('relay edge rate limits', () => {
  it('refuses a spent pairing budget at the edge, without waking the Hub', async () => {
    const pair = limiter(2);
    const { call, seen } = entry({ PAIR_LIMIT: pair });
    for (let i = 0; i < 2; i++) expect((await call('/v1/pair/claim')).status).toBe(200);
    const refused = await call('/v1/pair/claim');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('x-relay-limit')).toBe('edge');
    expect(refused.headers.get('retry-after')).toBe('60');
    // The Hub saw only the admitted requests, with /v1 stripped.
    expect(seen).toEqual(['/pair/claim', '/pair/claim']);
    // Another address and another endpoint have their own budgets.
    expect((await call('/v1/pair/claim', '203.0.113.9')).status).toBe(200);
    expect((await call('/v1/pair/start')).status).toBe(200);
    expect(pair.keys().sort()).toEqual(['/v1/pair/claim|198.51.100.7', '/v1/pair/claim|203.0.113.9', '/v1/pair/start|198.51.100.7']);
  });

  it('keys token endpoints by device and address, so no one drains another device from elsewhere', async () => {
    const token = limiter(1);
    const { call } = entry({ TOKEN_LIMIT: token });
    expect((await call('/v1/token/challenge?device=w_victim', '198.51.100.7')).status).toBe(200);
    expect((await call('/v1/token/challenge?device=w_victim', '198.51.100.7')).status).toBe(429);
    // The noisy address is limited; the device still refreshes from its own.
    expect((await call('/v1/token/challenge?device=w_victim', '192.0.2.44')).status).toBe(200);
    expect((await call('/v1/token?device=w_other', '198.51.100.7')).status).toBe(200);
  });

  it('reads each body fully before the Hub sees it, and refuses one larger than any route takes', async () => {
    const bodies: string[] = [];
    const hub = () => ({ fetch: async (request: Request) => { bodies.push(await request.text()); return new Response('ok'); } });
    const put = (body: BodyInit, headers: Record<string, string> = {}) =>
      forwardToHub(new Request('https://relay.test/v1/mirror/s_1?device=h_1', { method: 'PUT', body, headers, duplex: 'half' } as RequestInit), {}, hub);
    expect((await put(JSON.stringify({ iv: 'AAAA', ct: 'B'.repeat(1_900_000) }))).status).toBe(200);
    expect(bodies[0].length).toBe(1_900_000 + '{"iv":"AAAA","ct":""}'.length);
    // Over the cap by declared length, and by streamed length without one.
    expect((await put('x'.repeat(MAX_BODY_BYTES + 1))).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 30; i++) controller.enqueue(new Uint8Array(100_000));
        controller.close();
      }
    });
    expect((await put(stream)).status).toBe(413);
    expect(bodies).toHaveLength(1);
  });

  it('leaves authenticated routes and sockets to the Hub, and passes through without bindings', async () => {
    const none = limiter(0);
    const { call, seen } = entry({ PAIR_LIMIT: none, POLL_LIMIT: none, TOKEN_LIMIT: none });
    for (const path of ['/v1/devices?device=w_1', '/v1/ws/ticket?device=w_1', '/v1/mirror']) expect((await call(path)).status).toBe(200);
    expect(none.keys()).toEqual([]);
    expect(seen).toEqual(['/devices', '/ws/ticket', '/mirror']);
    expect(await edgeLimited(new Request('https://relay.test/v1/pair/claim', { method: 'POST' }), {})).toBeNull();
    const bare = entry();
    expect((await bare.call('/v1/pair/poll?code=X')).status).toBe(200);
    expect((await bare.call('/elsewhere')).status).toBe(404);
    expect(bare.seen).toEqual(['/pair/poll']);
  });
});
