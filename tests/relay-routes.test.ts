/** Tests for the relay's HTTP surface (relay/src/routes.ts): the deny-by-default route table,
 *  each route's authentication, rate limiting, and the WebSocket upgrade auth. Runs in plain
 *  Node against an in-memory store — no Cloudflare runtime involved, which is the point of the
 *  extraction: the layer that makes auth decisions is the layer that gets tested. */
import { describe, expect, it } from 'vitest';
import { registerHostDevice, registerWebDevice, startPairing, verifyDeviceToken } from '../relay/src/core';
import { FixedWindowLimiter } from '../relay/src/rate';
import { authorizeSocket, BROADCAST_TAG, handleHttp, ROUTES, type RouteContext, type SocketLike } from '../relay/src/routes';
import type { PublicIdentity } from '../src/shared/crypto';
import { memStore } from './fake-relay';

const HOST_PUB = { sig: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }, enc: { kty: 'EC', crv: 'P-256', x: 'c', y: 'd' } } as PublicIdentity;
const WEB_PUB = { sig: { kty: 'EC', crv: 'P-256', x: 'e', y: 'f' }, enc: { kty: 'EC', crv: 'P-256', x: 'g', y: 'h' } } as PublicIdentity;

function harness(startAt = 1_700_000_000_000) {
  const store = memStore();
  let now = startAt;
  // One limiter per harness: its counters must survive across the requests a test makes.
  const rate = new FixedWindowLimiter(() => now);
  const ctx = (over: Partial<RouteContext> = {}): RouteContext => ({
    store,
    accountId: 'a',
    enrollToken: 'enroll-secret',
    now,
    ip: '203.0.113.7',
    rate,
    sockets: () => [],
    ...over
  });
  return { store, ctx, tick: (ms: number) => (now += ms) };
}

const req = (method: string, path: string, init: RequestInit = {}): Request => new Request(`https://relay.example${path}`, { method, ...init });
const put = (path: string, blob: unknown = { iv: 'AAAA', ct: 'BBBB' }): Request => req('PUT', path, { body: JSON.stringify(blob) });

describe('relay route table', () => {
  it('classifies every route with an explicit auth requirement and a unique method+path', () => {
    expect(ROUTES.length).toBeGreaterThan(0);
    for (const route of ROUTES) {
      expect(['public', 'enroll', 'device', 'host']).toContain(route.auth);
      expect(route.path.startsWith('/')).toBe(true);
      // Nothing user-provided may be interpolated into a route path.
      expect(route.path).not.toContain(':');
    }
    const keys = ROUTES.map((r) => `${r.method} ${r.path}${r.prefix ? '*' : ''}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('denies by default: unknown paths are 404 and wrong methods are 405', async () => {
    const { ctx } = harness();
    expect((await handleHttp(req('GET', '/nope'), ctx())).status).toBe(404);
    expect((await handleHttp(req('GET', '/pair/start'), ctx())).status).toBe(405);
    const wrong = await handleHttp(req('PATCH', '/devices'), ctx());
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toContain('GET');
    expect(wrong.headers.get('allow')).toContain('DELETE');
  });

  it('fans a pairing claim out to the desktops through the broadcast tag', async () => {
    // Durable Object tag matching is exact, so the fan-out must use the bare broadcast tag a
    // desktop socket carries — a `host:` prefix matches nothing, which is how a live pairing
    // request silently never reached the desktop.
    const sent: string[] = [];
    const socket: SocketLike = { send: (data) => void sent.push(data), close: () => undefined };
    const seen: string[] = [];
    const { ctx, store } = harness();
    const withSockets = () =>
      ctx({
        sockets: (tag: string) => {
          seen.push(tag);
          return tag === BROADCAST_TAG.host ? [socket] : [];
        }
      });
    const { code } = await startPairing(store, { accountId: 'a', hostName: 'PC', hostPlatform: 'win32', hostPub: HOST_PUB }, Date.now());
    const body = JSON.stringify({ code, name: 'Chrome', webPub: WEB_PUB });
    const res = await handleHttp(req('POST', '/pair/claim', { body }), withSockets());
    expect(res.status).toBe(200);
    expect(seen).toContain(BROADCAST_TAG.host);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toMatchObject({ t: 'pair.request', code, name: 'Chrome' });
  });

  it('requires the enrollment secret to start pairing', async () => {
    const { ctx } = harness();
    const body = JSON.stringify({ name: 'desk', platform: 'win32', hostPub: HOST_PUB });
    expect((await handleHttp(req('POST', '/pair/start', { body }), ctx())).status).toBe(403);
    const ok = await handleHttp(req('POST', '/pair/start', { body, headers: { authorization: 'Bearer enroll-secret' } }), ctx());
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { code: string }).code).toMatch(/^[A-Z2-9]{8}$/);
  });

  it('rejects unauthenticated device routes and serves them to a paired device', async () => {
    const { ctx, store } = harness();
    const web = await registerWebDevice(store, { accountId: 'a', name: 'Chrome', platform: 'web', pub: WEB_PUB }, Date.now());
    expect((await handleHttp(req('GET', '/devices'), ctx())).status).toBe(401);
    expect((await handleHttp(req('GET', '/devices?device=nope&token=nope'), ctx())).status).toBe(401);
    const ok = await handleHttp(req('GET', `/devices?device=${web.deviceId}&token=${web.webToken}`), ctx());
    expect(ok.status).toBe(200);
    const list = (await ok.json()) as Array<Record<string, unknown>>;
    expect(list[0]).toMatchObject({ deviceId: web.deviceId, kind: 'web' });
    expect(JSON.stringify(list)).not.toContain('tokenHash');
  });

  it('accepts a device token in the Authorization header as well as the query', async () => {
    const { ctx, store } = harness();
    const web = await registerWebDevice(store, { accountId: 'a', name: 'Chrome', platform: 'web', pub: WEB_PUB }, Date.now());
    const res = await handleHttp(req('GET', `/devices?device=${web.deviceId}`, { headers: { authorization: `Bearer ${web.webToken}` } }), ctx());
    expect(res.status).toBe(200);
  });

  it('refuses mirror writes from a browser and allows them from the desktop', async () => {
    const { ctx, store } = harness();
    const web = await registerWebDevice(store, { accountId: 'a', name: 'Chrome', platform: 'web', pub: WEB_PUB }, Date.now());
    const host = await registerHostDevice(store, { accountId: 'a', name: 'Work PC', platform: 'win32', pub: HOST_PUB }, Date.now());
    expect((await handleHttp(put('/mirror'), ctx())).status).toBe(401);
    expect((await handleHttp(put(`/mirror?device=${web.deviceId}&token=${web.webToken}`), ctx())).status).toBe(403);
    expect((await handleHttp(put(`/mirror?device=${host.deviceId}&token=${host.hostToken}`), ctx())).status).toBe(200);

    // Reads are open to any paired device, and default to the caller's own host.
    const read = await handleHttp(req('GET', `/mirror?device=${web.deviceId}&token=${web.webToken}&host=${host.deviceId}`), ctx());
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ iv: 'AAAA' });

    // A browser cannot clear the desktop's mirror either.
    expect((await handleHttp(req('DELETE', `/mirror?device=${web.deviceId}&token=${web.webToken}`), ctx())).status).toBe(403);
  });

  it('rejects a malformed mirror blob and an oversized one with the right status', async () => {
    const { ctx, store } = harness();
    const host = await registerHostDevice(store, { accountId: 'a', name: 'PC', platform: 'win32', pub: HOST_PUB }, Date.now());
    const url = `/mirror?device=${host.deviceId}&token=${host.hostToken}`;
    expect((await handleHttp(put(url, { iv: 'AAAA' }), ctx())).status).toBe(400);
    const huge = { iv: 'AAAA', ct: 'a'.repeat(12 * 1024 * 1024) };
    expect((await handleHttp(put(url, huge), ctx())).status).toBe(413);
  });

  it('rate limits pairing claims per caller and recovers after the window', async () => {
    const { ctx, tick } = harness();
    const body = JSON.stringify({ code: 'ABCD2345', webPub: WEB_PUB });
    const claim = () => handleHttp(req('POST', '/pair/claim', { body }), ctx());
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await claim()).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true); // unknown code, but authenticated as a caller
    expect(statuses[10]).toBe(429);
    tick(60_001);
    expect((await claim()).status).toBe(401);
  });

  it('rate limits pairing polls without starving the legitimate polling cadence', async () => {
    const { ctx } = harness();
    const poll = () => handleHttp(req('GET', '/pair/poll?code=ABCD2345'), ctx());
    // 100 polls inside one minute — the pairing page's own cadence — must all get through.
    for (let i = 0; i < 100; i++) expect((await poll()).status).toBe(200);
    for (let i = 0; i < 20; i++) await poll();
    expect((await poll()).status).toBe(429);
  });

  it('bounds the rate-limiter map so hostile traffic cannot grow it forever', () => {
    const limiter = new FixedWindowLimiter(() => 1_000, 8);
    for (let i = 0; i < 50; i++) limiter.hit(`key-${i}`, 1, 60_000);
    // Eviction keeps it working for new keys rather than refusing everything forever.
    expect(limiter.hit('fresh', 1, 60_000)).toBe(true);
    expect(limiter.hit('fresh', 1, 60_000)).toBe(false);
  });

  it('requires the enrollment secret for an enrolling desktop socket', async () => {
    const { ctx } = harness();
    const bad = await authorizeSocket('host', req('GET', '/ws/host?device=enrolling', { headers: { authorization: 'Bearer wrong' } }), ctx());
    expect(bad).toMatchObject({ ok: false, status: 401 });
    const ok = await authorizeSocket('host', req('GET', '/ws/host?device=enrolling', { headers: { authorization: 'Bearer enroll-secret' } }), ctx());
    expect(ok).toEqual({ ok: true, deviceId: 'enrolling' });
  });

  it('authenticates client sockets by device token and refuses unknown ones', async () => {
    const { ctx, store } = harness();
    const web = await registerWebDevice(store, { accountId: 'a', name: 'Chrome', platform: 'web', pub: WEB_PUB }, Date.now());
    expect(await authorizeSocket('client', req('GET', `/ws/client?device=${web.deviceId}&token=${web.webToken}`), ctx())).toEqual({ ok: true, deviceId: web.deviceId });
    expect((await authorizeSocket('client', req('GET', `/ws/client?device=${web.deviceId}&token=wrong`), ctx())).ok).toBe(false);
    // A revoked device cannot open a socket (or use any other route) again.
    await handleHttp(
      req('DELETE', `/devices?device=${web.deviceId}&token=${web.webToken}&target=${web.deviceId}`),
      ctx()
    );
    await expect(verifyDeviceToken(store, { accountId: 'a', deviceId: web.deviceId, token: web.webToken }, Date.now())).rejects.toThrow();
    expect((await authorizeSocket('client', req('GET', `/ws/client?device=${web.deviceId}&token=${web.webToken}`), ctx())).ok).toBe(false);
  });
});
