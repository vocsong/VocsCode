/** Edge budgets at the relay Worker's front door (relay/src/edge.ts): every `/v1` route passes an
 *  edge rate limit, a route-sized body budget with a read deadline, and a credential-shape check
 *  before a request can wake the Hub or touch storage. Runs the real entry logic in Node with
 *  counting stand-ins for the Workers Rate Limiting bindings; the workerd suite checks the bindings
 *  exist in the real runtime config. */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashToken, randomToken } from '../relay/src/core';
import {
  BULK_BODY_DEADLINE_MS,
  edgeLimited,
  edgeRouteFor,
  forwardToHub,
  MAX_BODY_BYTES,
  SMALL_BODY_BYTES,
  type EdgeLimiters
} from '../relay/src/edge';
import { ROUTES } from '../relay/src/routes';

function limiter(allow: number) {
  const counts = new Map<string, number>();
  let calls = 0;
  return {
    keys: () => [...counts.keys()],
    calls: () => calls,
    limit: async ({ key }: { key: string }) => {
      calls++;
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= allow };
    }
  };
}

/** A request body that counts the bytes actually pulled from it, and produces none until read. */
function metered(total: number, chunk = 64 * 1024) {
  const meter = { pulled: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (meter.pulled >= total) {
        controller.close();
        return;
      }
      const n = Math.min(chunk, total - meter.pulled);
      meter.pulled += n;
      controller.enqueue(new Uint8Array(n).fill(0x41));
    }
  }, { highWaterMark: 0 });
  return { stream, meter };
}

function entry(limiters: EdgeLimiters = {}) {
  const seen: string[] = [];
  const hub = () => ({
    fetch: async (request: Request) => {
      seen.push(new URL(request.url).pathname);
      return new Response('from the hub');
    }
  });
  const call = (path: string, ip = '198.51.100.7', init: RequestInit = {}) =>
    forwardToHub(new Request(`https://relay.test${path}`, { method: 'POST', ...init, headers: { 'cf-connecting-ip': ip, ...(init.headers as Record<string, string> | undefined) } }), limiters, hub);
  return { call, seen };
}

/** Fake limiters with the limits `relay/wrangler.jsonc` deploys, all inside one window. */
function configured() {
  const text = readFileSync(new URL('../relay/wrangler.jsonc', import.meta.url), 'utf8');
  const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as { ratelimits: Array<{ name: string; simple: { limit: number } }> };
  const limits = Object.fromEntries(config.ratelimits.map((r) => [r.name, r.simple.limit])) as Record<string, number>;
  const limiters = Object.fromEntries(config.ratelimits.map((r) => [r.name, limiter(r.simple.limit)])) as EdgeLimiters;
  return { limits, limiters };
}

/** A device id in the historical opaque format: anyone can make one up. */
const legacyId = (kind: 'h' | 'w') => `${kind}_${randomToken(8)}`;

const deviceToken = randomToken();
const asDevice = { authorization: `Bearer ${deviceToken}` };

afterEach(() => {
  vi.useRealTimers();
});

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
    expect((await call('/v1/pair/start', '198.51.100.7', { headers: { authorization: 'Bearer enroll-secret' } })).status).toBe(200);
    expect(pair.keys().sort()).toEqual(['POST /v1/pair/claim|198.51.100.7', 'POST /v1/pair/claim|203.0.113.9', 'POST /v1/pair/start|198.51.100.7']);
  });

  it('keys token endpoints by address, so no one drains another device\'s refresh from elsewhere', async () => {
    const token = limiter(1);
    const { call } = entry({ TOKEN_LIMIT: token });
    expect((await call('/v1/token/challenge?device=w_victim', '198.51.100.7', { headers: asDevice })).status).toBe(200);
    expect((await call('/v1/token/challenge?device=w_victim', '198.51.100.7', { headers: asDevice })).status).toBe(429);
    // The noisy address is limited; the device still refreshes from its own.
    expect((await call('/v1/token/challenge?device=w_victim', '192.0.2.44', { headers: asDevice })).status).toBe(200);
    expect((await call('/v1/token?device=w_other', '198.51.100.7', { headers: asDevice })).status).toBe(200);
  });

  it('limits authenticated routes and sockets too, per address and per device, before the Hub is asked', async () => {
    const address = limiter(6);
    const device = limiter(1);
    const { call, seen } = entry({ ADDRESS_LIMIT: address, DEVICE_LIMIT: device });
    expect((await call('/v1/devices?device=w_1', undefined, { method: 'GET', headers: asDevice })).status).toBe(200);
    expect((await call('/v1/devices?device=w_1', undefined, { method: 'GET', headers: asDevice })).status).toBe(429);
    // Another device behind the same address has its own budget, and so does another route.
    expect((await call('/v1/devices?device=w_2', undefined, { method: 'GET', headers: asDevice })).status).toBe(200);
    expect((await call('/v1/ws/ticket?device=w_1', undefined, { headers: asDevice })).status).toBe(200);
    expect((await call('/v1/mirror/s_1?device=h_1', undefined, { method: 'GET', headers: asDevice })).status).toBe(200);
    // Every session id shares the device's budget: a fresh path does not buy a fresh counter.
    expect((await call('/v1/mirror/s_2?device=h_1', undefined, { method: 'GET', headers: asDevice })).status).toBe(429);
    // The address total is one counter across every device route: the seventh request is refused.
    expect((await call('/v1/ws/host?device=h_1', undefined, { method: 'GET', headers: asDevice })).status).toBe(429);
    expect(address.keys()).toEqual(['198.51.100.7']);
    expect(device.keys()).toContain('GET /v1/mirror/|h_1|198.51.100.7');
    expect(seen).toEqual(['/devices', '/devices', '/ws/ticket', '/mirror/s_1']);
  });

  it('answers unknown routes and methods at the edge, and passes through without bindings', async () => {
    const { call, seen } = entry();
    expect((await call('/v1/nothing-here')).status).toBe(404);
    const wrongMethod = await call('/v1/pair/poll?code=X');
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET');
    expect((await call('/elsewhere')).status).toBe(404);
    expect(seen).toEqual([]);
    expect(await edgeLimited(new Request('https://relay.test/v1/pair/claim', { method: 'POST' }), {})).toBeNull();
    expect((await call('/v1/pair/poll?code=X', undefined, { method: 'GET' })).status).toBe(200);
    expect(seen).toEqual(['/pair/poll']);
  });

  it('classifies every Hub route at the edge, so none ships without a budget', () => {
    for (const route of ROUTES) {
      const path = `/v1${route.path}${route.prefix ? 's_1' : ''}`;
      expect(edgeRouteFor(route.method, path), `${route.method} ${path}`).not.toBeNull();
    }
    expect(edgeRouteFor('GET', '/v1/ws/host')).not.toBeNull();
    expect(edgeRouteFor('GET', '/v1/ws/client')).not.toBeNull();
  });
});

describe('relay edge budgets for shared and rotating addresses', () => {
  it('holds one address to its token budget however many device ids it names', async () => {
    const token = limiter(1);
    const { call, seen } = entry({ TOKEN_LIMIT: token });
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) statuses.push((await call(`/v1/token/challenge?device=${legacyId('w')}`, '198.51.100.7', { headers: asDevice })).status);
    expect(statuses[0]).toBe(200);
    expect(statuses.slice(1).every((status) => status === 429)).toBe(true);
    expect(seen).toHaveLength(1);
    // Another address keeps its own budget.
    expect((await call(`/v1/token/challenge?device=${legacyId('w')}`, '192.0.2.44', { headers: asDevice })).status).toBe(200);
  });

  it('counts every address in one IPv6 /64 as one caller', async () => {
    const pair = limiter(1);
    const { call } = entry({ PAIR_LIMIT: pair });
    const statuses: number[] = [];
    for (let i = 1; i <= 20; i++) statuses.push((await call('/v1/pair/claim', `2001:db8:1:2::${i.toString(16)}`)).status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    // Another spelling of the same /64; a neighbouring /64 is another caller.
    expect((await call('/v1/pair/claim', '2001:DB8:1:2:ffff:0:0:1')).status).toBe(429);
    expect((await call('/v1/pair/claim', '2001:db8:1:3::1')).status).toBe(200);
    // An IPv4-mapped address is that IPv4 address; IPv4 neighbours stay separate.
    expect((await call('/v1/pair/claim', '198.51.100.7')).status).toBe(200);
    expect((await call('/v1/pair/claim', '::ffff:198.51.100.7')).status).toBe(429);
    expect((await call('/v1/pair/claim', '198.51.100.8')).status).toBe(200);
    expect(new Set(pair.keys()).size).toBe(4);
  });

  it('takes the first mirror sync of three desktops behind one address at the deployed limits', async () => {
    const { limiters } = configured();
    const { call } = entry(limiters);
    const refused: string[] = [];
    for (const desktop of [legacyId('h'), legacyId('h'), legacyId('h')]) {
      for (let s = 0; s < 50; s++) {
        const response = await call(`/v1/mirror/s_${s}?device=${desktop}`, '198.51.100.7', { method: 'PUT', headers: asDevice, body: '{}' });
        if (response.status !== 200) refused.push(`${desktop} s_${s}: ${response.status}`);
      }
      const index = await call(`/v1/mirror?device=${desktop}`, '198.51.100.7', { method: 'PUT', headers: asDevice, body: '{}' });
      if (index.status !== 200) refused.push(`${desktop} index: ${index.status}`);
    }
    expect(refused).toEqual([]);
  });

  it('takes a busy desktop\'s uploads at the deployed limits', async () => {
    // Ten sessions active for a minute, each re-uploaded every four seconds, plus the index.
    const { limiters } = configured();
    const { call } = entry(limiters);
    const desktop = legacyId('h');
    const refused: string[] = [];
    for (let round = 0; round < 15; round++) {
      for (let s = 0; s < 10; s++) {
        const response = await call(`/v1/mirror/s_${s}?device=${desktop}`, '198.51.100.7', { method: 'PUT', headers: asDevice, body: '{}' });
        if (response.status !== 200) refused.push(`round ${round} s_${s}: ${response.status}`);
      }
      const index = await call(`/v1/mirror?device=${desktop}`, '198.51.100.7', { method: 'PUT', headers: asDevice, body: '{}' });
      if (index.status !== 200) refused.push(`round ${round} index: ${index.status}`);
    }
    expect(refused).toEqual([]);
  });

  it('caps one address with a single total across every device route, however many device ids it names', async () => {
    const { limits, limiters } = configured();
    const total = limits.ADDRESS_LIMIT;
    expect(total).toBeGreaterThan(0);
    const { call, seen } = entry(limiters);
    const routes: Array<[string, (device: string) => string, string | undefined]> = [
      ['POST', (d) => `/v1/ws/ticket?device=${d}`, undefined],
      ['GET', (d) => `/v1/ws/host?device=${d}`, undefined],
      ['GET', (d) => `/v1/ws/client?device=${d}&ticket=${randomToken()}`, undefined],
      ['GET', (d) => `/v1/devices?device=${d}`, undefined],
      ['DELETE', (d) => `/v1/devices?device=${d}&target=x`, undefined],
      ['POST', (d) => `/v1/devices/revoke-all?device=${d}`, undefined],
      ['GET', (d) => `/v1/mirrors?device=${d}`, undefined],
      ['GET', (d) => `/v1/mirror?device=${d}`, undefined],
      ['PUT', (d) => `/v1/mirror?device=${d}`, '{}'],
      ['DELETE', (d) => `/v1/mirror?device=${d}`, undefined],
      ['GET', (d) => `/v1/mirror/s_1?device=${d}`, undefined],
      ['PUT', (d) => `/v1/mirror/s_1?device=${d}`, '{}'],
      ['DELETE', (d) => `/v1/mirror/s_1?device=${d}`, undefined]
    ];
    const statuses: number[] = [];
    for (let i = 0; i <= total; i++) {
      const [method, path, body] = routes[i % routes.length];
      const headers = method === 'GET' && path('x').includes('ticket=') ? {} : asDevice;
      statuses.push((await call(path(legacyId(i % 2 ? 'h' : 'w')), '198.51.100.7', { method, headers, body })).status);
    }
    expect(statuses.slice(0, total).every((status) => status === 200)).toBe(true);
    expect(statuses[total]).toBe(429);
    expect(seen).toHaveLength(total);
  });

  it('takes three syncing desktops, a busy one, their browsers, pairing and token refreshes behind one address', async () => {
    const { limiters } = configured();
    const { call } = entry(limiters);
    const ip = '198.51.100.7';
    const refused: string[] = [];
    const expectOk = async (label: string, response: Promise<Response>) => {
      const status = (await response).status;
      if (status !== 200) refused.push(`${label}: ${status}`);
    };
    // Three desktops' first sync: fifty sessions and the index each.
    for (const desktop of [legacyId('h'), legacyId('h'), legacyId('h')]) {
      for (let s = 0; s < 50; s++) await expectOk(`sync ${desktop} s_${s}`, call(`/v1/mirror/s_${s}?device=${desktop}`, ip, { method: 'PUT', headers: asDevice, body: '{}' }));
      await expectOk(`sync ${desktop} index`, call(`/v1/mirror?device=${desktop}`, ip, { method: 'PUT', headers: asDevice, body: '{}' }));
    }
    // A busy desktop: ten active sessions re-uploaded every four seconds for a minute, plus the index.
    const busy = legacyId('h');
    for (let round = 0; round < 15; round++) {
      for (let s = 0; s < 10; s++) await expectOk(`busy s_${s}`, call(`/v1/mirror/s_${s}?device=${busy}`, ip, { method: 'PUT', headers: asDevice, body: '{}' }));
      await expectOk(`busy index ${round}`, call(`/v1/mirror?device=${busy}`, ip, { method: 'PUT', headers: asDevice, body: '{}' }));
    }
    // Their browsers: socket tickets, device lists and a few offline transcripts.
    for (let b = 0; b < 4; b++) {
      const browser = legacyId('w');
      for (let i = 0; i < 3; i++) await expectOk(`browser ticket ${b}`, call(`/v1/ws/ticket?device=${browser}`, ip, { headers: asDevice }));
      await expectOk(`browser devices ${b}`, call(`/v1/devices?device=${browser}`, ip, { method: 'GET', headers: asDevice }));
      for (let s = 0; s < 5; s++) await expectOk(`browser mirror ${b}`, call(`/v1/mirror/s_${s}?device=${browser}&host=${busy}`, ip, { method: 'GET', headers: asDevice }));
    }
    // Pairing and token refreshes have their own budgets and still go through.
    await expectOk('pair start', call('/v1/pair/start', ip, { headers: { authorization: 'Bearer enroll-secret' }, body: '{}' }));
    for (let i = 0; i < 4; i++) {
      await expectOk('token challenge', call(`/v1/token/challenge?device=${legacyId('w')}`, ip, { headers: asDevice }));
      await expectOk('token', call(`/v1/token?device=${legacyId('w')}`, ip, { headers: asDevice, body: '{}' }));
    }
    expect(refused).toEqual([]);
  });

  it('caps one address at the deployed ceiling however many device ids it names', async () => {
    const { limits, limiters } = configured();
    const ceiling = limits.ADDRESS_LIMIT;
    expect(ceiling).toBeGreaterThan(0);
    const { call, seen } = entry(limiters);
    const statuses: number[] = [];
    for (let i = 0; i <= ceiling; i++) statuses.push((await call(`/v1/mirror/s_1?device=${legacyId('h')}`, '198.51.100.7', { method: 'PUT', headers: asDevice, body: '{}' })).status);
    expect(statuses.slice(0, ceiling).every((status) => status === 200)).toBe(true);
    expect(statuses[ceiling]).toBe(429);
    expect(seen).toHaveLength(ceiling);
  });
});

describe('relay edge body budgets', () => {
  it('refuses a body on a route that takes none, without reading it', async () => {
    const { call, seen } = entry();
    expect((await call('/v1/devices?device=w_1', undefined, { method: 'GET', headers: { ...asDevice, 'transfer-encoding': 'chunked' } })).status).toBe(400);
    expect((await call('/v1/devices?device=w_1', undefined, { method: 'GET', headers: { ...asDevice, 'content-length': '5' } })).status).toBe(400);
    // A runtime that hands a GET a body stream: refused unread, not forwarded.
    const body = metered(1024);
    const hub = () => ({ fetch: async (request: Request) => { seen.push(new URL(request.url).pathname); return new Response('from the hub'); } });
    const withBody = { url: 'https://relay.test/v1/mirror/s_1?device=h_1', method: 'GET', headers: new Headers({ ...asDevice, 'cf-connecting-ip': '198.51.100.7' }), body: body.stream } as unknown as Request;
    const refused = await forwardToHub(withBody, {}, hub).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(400);
    expect(body.meter.pulled).toBe(0);
    expect(seen).toEqual([]);
    // Without a body, the same requests go through.
    expect((await call('/v1/devices?device=w_1', undefined, { method: 'GET', headers: asDevice })).status).toBe(200);
  });

  it('buffers a mirror upload within its budget for the Hub', async () => {
    const bodies: string[] = [];
    const hub = () => ({ fetch: async (request: Request) => { bodies.push(await request.text()); return new Response('ok'); } });
    const put = (body: BodyInit) =>
      forwardToHub(new Request('https://relay.test/v1/mirror/s_1?device=h_1', { method: 'PUT', body, headers: asDevice, duplex: 'half' } as RequestInit), {}, hub);
    expect((await put(JSON.stringify({ iv: 'AAAA', ct: 'B'.repeat(1_900_000) }))).status).toBe(200);
    expect(bodies[0].length).toBe(1_900_000 + '{"iv":"AAAA","ct":""}'.length);
  });

  it('refuses a declared length over the route budget without reading the body', async () => {
    const { call, seen } = entry();
    const small = metered(SMALL_BODY_BYTES + 1);
    const tooBig = await call('/v1/token?device=w_1', undefined, { headers: { ...asDevice, 'content-length': String(SMALL_BODY_BYTES + 1) }, body: small.stream, duplex: 'half' } as RequestInit);
    expect(tooBig.status).toBe(413);
    expect(small.meter.pulled).toBe(0);
    const bulk = metered(MAX_BODY_BYTES + 1);
    const tooBigBulk = await call('/v1/mirror/s_1?device=h_1', undefined, { method: 'PUT', headers: { ...asDevice, 'content-length': String(MAX_BODY_BYTES + 1) }, body: bulk.stream, duplex: 'half' } as RequestInit);
    expect(tooBigBulk.status).toBe(413);
    expect(bulk.meter.pulled).toBe(0);
    expect(seen).toEqual([]);
  });

  it('cuts a body with no declared length off at the route budget', async () => {
    const { call, seen } = entry();
    // A control route takes kilobytes, not the mirror's megabytes.
    const small = metered(1_000_000, 4096);
    const pairing = await call('/v1/pair/start', undefined, { headers: { authorization: 'Bearer enroll-secret' }, body: small.stream, duplex: 'half' } as RequestInit);
    expect(pairing.status).toBe(413);
    expect(small.meter.pulled).toBeLessThanOrEqual(SMALL_BODY_BYTES + 4096);
    const bulk = metered(3_000_000);
    const mirror = await call('/v1/mirror/s_1?device=h_1', undefined, { method: 'PUT', headers: asDevice, body: bulk.stream, duplex: 'half' } as RequestInit);
    expect(mirror.status).toBe(413);
    expect(bulk.meter.pulled).toBeLessThanOrEqual(MAX_BODY_BYTES + 64 * 1024);
    expect(seen).toEqual([]);
  });

  it('gives up on a body that stalls past the read deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { call, seen } = entry();
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) }, { highWaterMark: 0 });
    let settled: Response | undefined;
    void call('/v1/mirror/s_1?device=h_1', undefined, { method: 'PUT', headers: asDevice, body: stalled, duplex: 'half' } as RequestInit).then((response) => { settled = response; });
    await vi.advanceTimersByTimeAsync(BULK_BODY_DEADLINE_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    expect(settled?.status).toBe(408);
    expect(seen).toEqual([]);
  });

  it('refuses a request with no credential of the route\'s shape before reading its body', async () => {
    const { call, seen } = entry();
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: deviceToken }]) {
      const body = metered(128 * 1024);
      const refused = await call('/v1/mirror/s_1?device=h_abcdefghijk', undefined, { method: 'PUT', headers, body: body.stream, duplex: 'half' } as RequestInit);
      expect(refused.status).toBe(401);
      expect(body.meter.pulled).toBe(0);
    }
    // A device route needs the device it speaks for.
    expect((await call('/v1/mirror/s_1', undefined, { method: 'PUT', headers: asDevice, body: '{}' })).status).toBe(401);
    // Enrollment needs a bearer secret; sockets need theirs.
    expect((await call('/v1/pair/start', undefined, { body: '{}' })).status).toBe(403);
    expect((await call('/v1/ws/host?device=h_1', undefined, { method: 'GET' })).status).toBe(401);
    expect((await call('/v1/ws/client?device=w_1&ticket=short', undefined, { method: 'GET' })).status).toBe(401);
    expect(seen).toEqual([]);
    // The right shapes reach the Hub, which alone decides whether they are valid.
    expect((await call('/v1/ws/host?device=enrolling', undefined, { method: 'GET', headers: { authorization: 'Bearer enroll-secret' } })).status).toBe(200);
    expect((await call(`/v1/ws/client?device=w_1&ticket=${randomToken()}`, undefined, { method: 'GET' })).status).toBe(200);
    expect(seen).toEqual(['/ws/host', '/ws/client']);
  });
});

// --- the whole Worker entry, with the real Hub over in-memory storage ---

interface TestEnv {
  RELAY_ACCOUNT: string;
  ENROLL_TOKEN: string;
  ACCOUNT_ASSERTION_SECRET: string;
  DEVICE_ROUTE_SECRET: string;
  PAIR_LIMIT: ReturnType<typeof limiter>;
  POLL_LIMIT: ReturnType<typeof limiter>;
  TOKEN_LIMIT: ReturnType<typeof limiter>;
  DEVICE_LIMIT: ReturnType<typeof limiter>;
  ADDRESS_LIMIT: ReturnType<typeof limiter>;
  HUB: { idFromName(name: string): string; get(id: string): { fetch(request: Request): Promise<Response> } };
  ENROLLMENTS: { idFromName(name: string): string; get(id: string): { fetch(request: Request): Promise<Response> } };
}
const { default: worker, Hub } = await vi.importActual<{
  default: { fetch(request: Request, env: TestEnv): Promise<Response> };
  Hub: new (state: unknown, env: TestEnv) => { fetch(request: Request): Promise<Response> };
}>('../relay/src/worker');

const LEGACY_HOST = 'h_abcdefghijk';

function relay(allow = 1000) {
  const values = new Map<string, unknown>();
  const counts = { deviceReads: 0, hubCalls: 0 };
  const storage = {
    get: async (key: string) => {
      if (key.startsWith('device:')) counts.deviceReads++;
      return structuredClone(values.get(key));
    },
    put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    delete: async (key: string) => values.delete(key),
    list: async ({ prefix, limit, startAfter }: { prefix: string; limit: number; startAfter?: string }) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)),
    transaction: async (work: (tx: unknown) => Promise<unknown>) => work(storage)
  };
  const env = {
    RELAY_ACCOUNT: 'vocs-v1',
    ENROLL_TOKEN: 'edge-test-enroll-secret',
    ACCOUNT_ASSERTION_SECRET: 'edge-test-account-assertion-secret-32-bytes-min',
    DEVICE_ROUTE_SECRET: 'edge-test-device-route-secret-32-bytes-minimum',
    PAIR_LIMIT: limiter(allow),
    POLL_LIMIT: limiter(allow),
    TOKEN_LIMIT: limiter(allow),
    DEVICE_LIMIT: limiter(allow),
    ADDRESS_LIMIT: limiter(allow)
  } as TestEnv;
  const hub = new Hub({ storage, getWebSockets: () => [], getTags: () => [] }, env);
  env.HUB = { idFromName: (name) => name, get: () => ({ fetch: (request) => { counts.hubCalls++; return hub.fetch(request); } }) };
  env.ENROLLMENTS = { idFromName: (name) => name, get: () => ({ fetch: async () => { counts.hubCalls++; return new Response('{}'); } }) };
  const limiterCalls = () => env.PAIR_LIMIT.calls() + env.POLL_LIMIT.calls() + env.TOKEN_LIMIT.calls() + env.DEVICE_LIMIT.calls() + env.ADDRESS_LIMIT.calls();
  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cf-connecting-ip', '203.0.113.77');
    const response = await worker.fetch(new Request(`https://relay.test${path}`, { ...init, headers }), env);
    await response.arrayBuffer();
    return response;
  };
  return { env, values, counts, limiterCalls, send };
}

describe('relay Worker budgets before authentication', () => {
  it('meters unauthenticated mirror uploads and refuses them before any body or storage work', async () => {
    const { counts, limiterCalls, send } = relay();
    let pulled = 0;
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) {
      const body = metered(128 * 1024);
      const response = await send(`/v1/mirror/s1?device=${LEGACY_HOST}`, {
        method: 'PUT', headers: i % 2 ? { authorization: 'Bearer wrong' } : {}, body: body.stream, duplex: 'half'
      } as RequestInit);
      statuses.push(response.status);
      pulled += body.meter.pulled;
    }
    expect(statuses.every((status) => status === 401)).toBe(true);
    expect(limiterCalls()).toBe(32);
    expect(pulled).toBe(0);
    expect(counts.deviceReads).toBe(0);
    expect(counts.hubCalls).toBe(0);
  });

  it('stops well-formed but unknown credentials at the edge limit once the budget is spent', async () => {
    const { env, counts, send } = relay(5);
    const statuses: number[] = [];
    let pulled = 0;
    for (let i = 0; i < 8; i++) {
      const body = metered(1024);
      const response = await send(`/v1/mirror/s1?device=${LEGACY_HOST}`, {
        method: 'PUT', headers: { authorization: `Bearer ${randomToken()}` }, body: body.stream, duplex: 'half'
      } as RequestInit);
      statuses.push(response.status);
      pulled += body.meter.pulled;
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);
    expect(env.ADDRESS_LIMIT.calls()).toBe(8);
    // Only the admitted five were read and looked up; the limited three cost nothing.
    expect(pulled).toBe(5 * 1024);
    expect(counts.deviceReads).toBe(5);
  });

  it('meters pairing and owner requests that carry no account session before refusing them', async () => {
    const { env, counts, send } = relay();
    const body = metered(SMALL_BODY_BYTES);
    const response = await send('/v1/pair/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body.stream, duplex: 'half' } as RequestInit);
    expect(response.status).toBe(401);
    expect(body.meter.pulled).toBe(0);
    expect(env.PAIR_LIMIT.calls()).toBe(1);
    expect((await send('/v1/owner/hosts')).status).toBe(401);
    expect(env.POLL_LIMIT.calls()).toBe(1);
    expect(counts.hubCalls).toBe(0);
  });

  it('still stores an authenticated mirror upload within its budget', async () => {
    const { values, send } = relay();
    const token = randomToken();
    values.set(`device:vocs-v1:${LEGACY_HOST}`, {
      deviceId: LEGACY_HOST, kind: 'host', name: 'desktop', platform: 'test', pub: { sig: {}, enc: {} },
      tokenHash: await hashToken(randomToken()), access: [{ hash: await hashToken(token), expiresAt: Date.now() + 3_600_000 }],
      createdAt: Date.now(), lastSeen: Date.now()
    });
    const blob = { iv: 'AAAAAAAAAAAAAAAA', ct: 'B'.repeat(1_900_000) };
    const response = await send(`/v1/mirror/s1?device=${LEGACY_HOST}`, {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(blob)
    });
    expect(response.status).toBe(200);
    expect((values.get(`mirror:vocs-v1:${LEGACY_HOST}:s:s1`) as { blob: typeof blob }).blob).toEqual(blob);
  });
});
