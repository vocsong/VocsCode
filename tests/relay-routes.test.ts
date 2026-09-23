/** Tests for the relay's HTTP surface (relay/src/routes.ts): the deny-by-default route table,
 *  each route's authentication, rate limiting, and the WebSocket upgrade auth. Runs in plain
 *  Node against an in-memory store — no Cloudflare runtime involved, which is the point of the
 *  extraction: the layer that makes auth decisions is the layer that gets tested. */
import { describe, expect, it } from 'vitest';
import { MAX_WEB_DEVICES, registerWebDevice, startPairing, verifyRefreshToken } from '../relay/src/core';
import { FixedWindowLimiter } from '../relay/src/rate';
import { authorizeSocket, BROADCAST_TAG, handleHttp, ROUTES, type RouteContext, type SocketLike } from '../relay/src/routes';
import { generateIdentity, publicOf, sign, tokenProofPayload, type PublicIdentity } from '../src/shared/crypto';
import { memStore } from './fake-relay';
import { testDevice } from './support/relay-auth';

const HOST_PUB = { sig: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }, enc: { kty: 'EC', crv: 'P-256', x: 'c', y: 'd' } } as PublicIdentity;
const WEB_PUB = { sig: { kty: 'EC', crv: 'P-256', x: 'e', y: 'f' }, enc: { kty: 'EC', crv: 'P-256', x: 'g', y: 'h' } } as PublicIdentity;

const T = 1_700_000_000_000;

function harness(startAt = T) {
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
      expect(['public', 'enroll', 'enroll-or-host', 'refresh', 'device', 'web', 'host']).toContain(route.auth);
      expect(route.path.startsWith('/')).toBe(true);
      // Nothing user-provided may be interpolated into a route path.
      expect(route.path).not.toContain(':');
    }
    const keys = ROUTES.map((r) => `${r.method} ${r.path}${r.prefix ? '*' : ''}`);
    expect(new Set(keys).size).toBe(keys.length);
    // The long-lived refresh credential is accepted by the token endpoints and nothing else.
    expect(ROUTES.filter((r) => r.auth === 'refresh').map((r) => `${r.method} ${r.path}`).sort()).toEqual(['POST /token', 'POST /token/challenge']);
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
    expect(JSON.parse(sent[0])).toMatchObject({ t: 'pair.request', code, name: 'Chrome', hostPub: HOST_PUB, webPub: WEB_PUB });
    const { pollToken } = (await res.json()) as { pollToken: string };
    expect(pollToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await handleHttp(req('GET', `/pair/poll?code=${code}`), ctx())).status).toBe(401);
    expect((await handleHttp(req('GET', `/pair/poll?code=${code}`, { headers: { authorization: `Bearer ${pollToken}` } }), ctx())).status).toBe(200);
  });

  it('requires the enrollment secret to start pairing', async () => {
    const { ctx } = harness();
    const body = JSON.stringify({ name: 'desk', platform: 'win32', hostPub: HOST_PUB });
    expect((await handleHttp(req('POST', '/pair/start', { body }), ctx())).status).toBe(403);
    const ok = await handleHttp(req('POST', '/pair/start', { body, headers: { authorization: 'Bearer enroll-secret' } }), ctx());
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { code: string }).code).toMatch(/^[A-Z2-9]{8}$/);
  });

  it('lets an enrolled desktop start pairing as itself, without the enrollment secret', async () => {
    const { ctx, store } = harness();
    const host = await testDevice(store, 'host', { name: 'Work PC', now: T });
    const web = await testDevice(store, 'web', { name: 'Chrome', now: T });
    // The body names another key; an authenticated desktop pairs with its registered one.
    const body = JSON.stringify({ name: 'Work PC', hostPub: WEB_PUB });
    const rotated = ctx({ enrollToken: 'rotated-secret' });
    const ok = await handleHttp(req('POST', `/pair/start?device=${host.deviceId}`, { body, headers: { authorization: `Bearer ${host.access}` } }), rotated);
    expect(ok.status).toBe(200);
    const { code } = (await ok.json()) as { code: string };
    expect(await store.get(`pair:${code}`)).toMatchObject({ hostDeviceId: host.deviceId, hostPub: JSON.parse(JSON.stringify(publicOf(host.identity))), hostName: 'Work PC' });
    // A browser credential is not a desktop, and the enrollment secret is not a device token.
    expect((await handleHttp(req('POST', `/pair/start?device=${web.deviceId}`, { body, headers: { authorization: `Bearer ${web.access}` } }), rotated)).status).toBe(403);
    expect((await handleHttp(req('POST', `/pair/start?device=${host.deviceId}`, { body, headers: { authorization: 'Bearer rotated-secret' } }), rotated)).status).toBe(401);
  });

  it('accepts only bounded labels and public P-256 identities in pairing bodies', async () => {
    const { ctx, store } = harness();
    const start = (body: unknown) => handleHttp(req('POST', '/pair/start', { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { authorization: 'Bearer enroll-secret' } }), ctx());
    expect((await start('not json')).status).toBe(400);
    expect((await start([HOST_PUB])).status).toBe(400);
    expect((await start({ hostPub: { sig: HOST_PUB.sig } })).status).toBe(400);
    expect((await start({ hostPub: { ...HOST_PUB, extra: HOST_PUB.sig } })).status).toBe(400);
    // A private JWK must never be stored or broadcast, even when a client sends one by mistake.
    expect((await start({ hostPub: { sig: { ...HOST_PUB.sig, d: 'private-scalar' }, enc: HOST_PUB.enc } })).status).toBe(400);
    expect((await start({ hostPub: { sig: { ...HOST_PUB.sig, x: 'x'.repeat(500) }, enc: HOST_PUB.enc } })).status).toBe(400);
    expect(await store.list('pair:')).toHaveLength(0);
    const ok = await start({ name: `  ${'N'.repeat(200)}\u0007 `, hostPub: HOST_PUB });
    expect(ok.status).toBe(200);
    const { code } = (await ok.json()) as { code: string };
    expect(await store.get(`pair:${code}`)).toMatchObject({ hostName: 'N'.repeat(64) });

    const claim = (body: unknown) => handleHttp(req('POST', '/pair/claim', { body: JSON.stringify(body) }), ctx());
    expect((await claim({ code, webPub: 'nope' })).status).toBe(400);
    expect((await claim({ code: 42, webPub: WEB_PUB })).status).toBe(400);
    expect((await claim({ code, name: 'Chrome\n<b>', webPub: WEB_PUB })).status).toBe(200);
    expect(await store.get(`pair:${code}`)).toMatchObject({ status: 'claimed', webName: 'Chrome <b>' });
  });

  it('answers a claim on a full account with 409 device-limit', async () => {
    const { ctx, store } = harness();
    for (let i = 0; i < MAX_WEB_DEVICES; i++) await registerWebDevice(store, { accountId: 'a', name: `w${i}`, platform: 'web', pub: WEB_PUB }, Date.now());
    const { code } = await startPairing(store, { accountId: 'a', hostName: 'PC', hostPlatform: 'win32', hostPub: HOST_PUB }, Date.now());
    const res = await handleHttp(req('POST', '/pair/claim', { body: JSON.stringify({ code, webPub: WEB_PUB }) }), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'device-limit' });
  });

  it('fails closed when the enrollment secret is not configured', async () => {
    const { ctx, store } = harness();
    const body = JSON.stringify({ name: 'desk', hostPub: HOST_PUB });
    const missing = ctx({ enrollToken: '' });
    expect((await handleHttp(req('POST', '/pair/start', { body }), missing)).status).toBe(403);
    expect((await handleHttp(req('POST', '/pair/start', { body, headers: { authorization: 'Bearer arbitrary' } }), missing)).status).toBe(403);
    expect(await store.list('pair:')).toHaveLength(0);
  });

  it('buys access tokens through a signed challenge, and never accepts the refresh credential for an API route', async () => {
    const { ctx, store } = harness();
    const identity = await generateIdentity();
    const { deviceId, webToken: refresh } = await registerWebDevice(store, { accountId: 'a', name: 'Chrome', platform: 'web', pub: publicOf(identity) }, T);
    const post = (path: string, token: string, body?: unknown) => handleHttp(req('POST', `${path}?device=${deviceId}`, { headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }), ctx());
    expect((await post('/token/challenge', 'wrong')).status).toBe(401);
    expect((await handleHttp(req('POST', `/token/challenge?device=${deviceId}&token=${refresh}`), ctx())).status).toBe(401);
    expect((await handleHttp(req('GET', `/devices?device=${deviceId}`, { headers: { authorization: `Bearer ${refresh}` } }), ctx())).status).toBe(401);

    const challengeRes = await post('/token/challenge', refresh);
    expect(challengeRes.status).toBe(200);
    expect(challengeRes.headers.get('cache-control')).toBe('no-store');
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    const forged = await sign(await generateIdentity(), tokenProofPayload(deviceId, challenge));
    expect((await post('/token', refresh, { challenge, signature: forged })).status).toBe(401);
    expect((await post('/token', refresh, 'not an object')).status).toBe(400);

    const again = (await (await post('/token/challenge', refresh)).json()) as { challenge: string };
    const tokenRes = await post('/token', refresh, { challenge: again.challenge, signature: await sign(identity, tokenProofPayload(deviceId, again.challenge)) });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get('cache-control')).toBe('no-store');
    const { accessToken, expiresAt } = (await tokenRes.json()) as { accessToken: string; expiresAt: number };
    expect(expiresAt).toBe(T + 60 * 60_000);
    expect((await handleHttp(req('GET', `/devices?device=${deviceId}`, { headers: { authorization: `Bearer ${accessToken}` } }), ctx())).status).toBe(200);
    // An access token is not a refresh credential either.
    expect((await post('/token/challenge', accessToken)).status).toBe(401);
  });

  it('revoking a desktop closes it and its browsers, and tells the desktops to reconcile', async () => {
    const { ctx, store } = harness();
    const host = await testDevice(store, 'host', { name: 'Lost PC', now: T });
    const mine = await testDevice(store, 'web', { hostDeviceId: host.deviceId, now: T });
    const survivor = await testDevice(store, 'web', { now: T });
    const closed: string[] = [];
    const notices: string[] = [];
    const socket = (tag: string): SocketLike => ({ send: (data) => void notices.push(`${tag} ${data}`), close: () => void closed.push(tag) });
    const withSockets = ctx({ sockets: (tag) => (tag === BROADCAST_TAG.host ? [socket('hosts')] : [socket(tag)]) });
    const res = await handleHttp(req('DELETE', `/devices?device=${survivor.deviceId}&target=${host.deviceId}`, { headers: { authorization: `Bearer ${survivor.access}` } }), withSockets);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: string[] };
    expect(body.revoked.sort()).toEqual([host.deviceId, mine.deviceId].sort());
    expect(closed.sort()).toEqual([`client:${host.deviceId}`, `client:${mine.deviceId}`, `host:${host.deviceId}`, `host:${mine.deviceId}`].sort());
    expect(notices.map((n) => JSON.parse(n.slice(n.indexOf(' ') + 1)))).toEqual([{ t: 'device.revoked', devices: body.revoked }]);
    expect((await handleHttp(req('GET', `/devices?device=${mine.deviceId}`, { headers: { authorization: `Bearer ${mine.access}` } }), ctx())).status).toBe(401);
  });

  it('rejects unauthenticated device routes and serves them to a paired device', async () => {
    const { ctx, store } = harness();
    const web = await testDevice(store, 'web', { name: 'Chrome', now: T });
    expect((await handleHttp(req('GET', '/devices'), ctx())).status).toBe(401);
    expect((await handleHttp(req('GET', '/devices?device=nope&token=nope'), ctx())).status).toBe(401);
    const ok = await handleHttp(req('GET', `/devices?device=${web.deviceId}`, { headers: { authorization: `Bearer ${web.access}` } }), ctx());
    expect(ok.status).toBe(200);
    const list = (await ok.json()) as Array<Record<string, unknown>>;
    expect(list[0]).toMatchObject({ deviceId: web.deviceId, kind: 'web' });
    expect(JSON.stringify(list)).not.toContain('tokenHash');
  });

  it('accepts a device token only in Authorization for REST, not in the query', async () => {
    const { ctx, store } = harness();
    const web = await testDevice(store, 'web', { name: 'Chrome', now: T });
    const res = await handleHttp(req('GET', `/devices?device=${web.deviceId}`, { headers: { authorization: `Bearer ${web.access}` } }), ctx());
    expect(res.status).toBe(200);
    expect((await handleHttp(req('GET', `/devices?device=${web.deviceId}&token=${web.access}`), ctx())).status).toBe(401);
  });

  it('refuses mirror writes from a browser and allows them from the desktop', async () => {
    const { ctx, store } = harness();
    const web = await testDevice(store, 'web', { name: 'Chrome', now: T });
    const host = await testDevice(store, 'host', { name: 'Work PC', now: T });
    expect((await handleHttp(put('/mirror'), ctx())).status).toBe(401);
    expect((await handleHttp(put(`/mirror?device=${web.deviceId}`, { iv: 'AAAA', ct: 'BBBB' }), ctx())).status).toBe(401);
    expect((await handleHttp(req('PUT', `/mirror?device=${web.deviceId}`, { body: JSON.stringify({ iv: 'AAAA', ct: 'BBBB' }), headers: { authorization: `Bearer ${web.access}` } }), ctx())).status).toBe(403);
    expect((await handleHttp(req('PUT', `/mirror?device=${host.deviceId}`, { body: JSON.stringify({ iv: 'AAAA', ct: 'BBBB' }), headers: { authorization: `Bearer ${host.access}` } }), ctx())).status).toBe(200);

    // Reads are open to any paired device, and default to the caller's own host.
    const read = await handleHttp(req('GET', `/mirror?device=${web.deviceId}&host=${host.deviceId}`, { headers: { authorization: `Bearer ${web.access}` } }), ctx());
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ iv: 'AAAA' });

    // A browser cannot clear the desktop's mirror either.
    expect((await handleHttp(req('DELETE', `/mirror?device=${web.deviceId}`, { headers: { authorization: `Bearer ${web.access}` } }), ctx())).status).toBe(403);
  });

  it('rejects a malformed mirror blob and an oversized one with the right status', async () => {
    const { ctx, store } = harness();
    const host = await testDevice(store, 'host', { name: 'PC', now: T });
    const url = `/mirror?device=${host.deviceId}`;
    const upload = (blob: unknown) => req('PUT', url, { body: JSON.stringify(blob), headers: { authorization: `Bearer ${host.access}` } });
    expect((await handleHttp(upload({ iv: 'AAAA' }), ctx())).status).toBe(400);
    const huge = { iv: 'AAAA', ct: 'a'.repeat(12 * 1024 * 1024) };
    expect((await handleHttp(upload(huge), ctx())).status).toBe(413);
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
    for (let i = 0; i < 100; i++) expect((await poll()).status).toBe(401);
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

  it('never lets a paired browser take the host socket role (or a host take the browser role)', async () => {
    const { ctx, store } = harness();
    const web = await testDevice(store, 'web', { name: 'Chrome', now: T });
    const host = await testDevice(store, 'host', { name: 'Work PC', now: T });
    // A host-role socket can answer pairing requests and publish host frames. Authentication
    // must check the device kind, not merely that the token belongs to some paired device.
    expect(await authorizeSocket('host', req('GET', `/ws/host?device=${web.deviceId}&token=${web.access}`), ctx()))
      .toMatchObject({ ok: false, status: 401 });
    expect(await authorizeSocket('client', req('GET', `/ws/client?device=${host.deviceId}&token=${host.access}`), ctx()))
      .toMatchObject({ ok: false, status: 401 });
    expect(await authorizeSocket('host', req('GET', `/ws/host?device=${host.deviceId}`, { headers: { authorization: `Bearer ${host.access}` } }), ctx()))
      .toEqual({ ok: true, deviceId: host.deviceId });
  });

  it('issues browser-only tickets from Authorization, with no URL bearer fallback', async () => {
    const { ctx, store } = harness();
    const web = await testDevice(store, 'web', { name: 'Chrome', now: T });
    const host = await testDevice(store, 'host', { name: 'PC', now: T });
    const path = `/ws/ticket?device=${web.deviceId}`;
    expect((await handleHttp(req('POST', `${path}&token=${web.access}`), ctx())).status).toBe(401);
    expect((await handleHttp(req('POST', path), ctx())).status).toBe(401);
    expect((await handleHttp(req('POST', `/ws/ticket?device=${host.deviceId}`, { headers: { authorization: `Bearer ${host.access}` } }), ctx())).status).toBe(403);
    const response = await handleHttp(req('POST', path, { headers: { authorization: `Bearer ${web.access}` } }), ctx());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { ticket, expiresAt } = (await response.json()) as { ticket: string; expiresAt: number };
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe(ctx().now + 30_000);

    const upgrade = (query: string, headers?: HeadersInit) => authorizeSocket('client', req('GET', `/ws/client?device=${web.deviceId}${query}`, { headers }), ctx());
    expect((await upgrade(`&token=${web.access}`)).ok).toBe(false);
    expect((await upgrade('', { authorization: `Bearer ${web.access}` })).ok).toBe(false);
    expect((await upgrade(`&ticket=${ticket}&token=${web.access}`)).ok).toBe(false);
    expect((await upgrade('&ticket=wrong')).ok).toBe(false);
    expect(await upgrade(`&ticket=${ticket}`)).toEqual({ ok: true, deviceId: web.deviceId });
    expect((await upgrade(`&ticket=${ticket}`)).ok).toBe(false);
  });

  it('uses Authorization only for host sockets and revocation invalidates unconsumed tickets', async () => {
    const { ctx, store } = harness();
    const web = await testDevice(store, 'web', { name: 'Chrome', now: T });
    const host = await testDevice(store, 'host', { name: 'PC', now: T });
    const hostPath = `/ws/host?device=${host.deviceId}`;
    expect((await authorizeSocket('host', req('GET', `${hostPath}&token=${host.access}`), ctx())).ok).toBe(false);
    expect(await authorizeSocket('host', req('GET', hostPath, { headers: { authorization: `Bearer ${host.access}` } }), ctx())).toEqual({ ok: true, deviceId: host.deviceId });
    const response = await handleHttp(req('POST', `/ws/ticket?device=${web.deviceId}`, { headers: { authorization: `Bearer ${web.access}` } }), ctx());
    const { ticket } = (await response.json()) as { ticket: string };
    await handleHttp(req('DELETE', `/devices?device=${host.deviceId}&target=${web.deviceId}`, { headers: { authorization: `Bearer ${host.access}` } }), ctx());
    expect((await authorizeSocket('client', req('GET', `/ws/client?device=${web.deviceId}&ticket=${ticket}`), ctx())).ok).toBe(false);
    expect((await handleHttp(req('POST', `/ws/ticket?device=${web.deviceId}`, { headers: { authorization: `Bearer ${web.access}` } }), ctx())).status).toBe(401);
    await expect(verifyRefreshToken(store, { accountId: 'a', deviceId: web.deviceId, token: web.refresh })).rejects.toThrow();
  });
});
