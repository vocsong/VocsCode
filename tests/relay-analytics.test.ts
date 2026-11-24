/** The relay's analytics snapshot routes (relay/src/analytics.ts, docs/WEB-DASHBOARD.md §4): desktops
 *  upload parts and commit a manifest; the signed-in owner reads every computer's snapshot. */
import { describe, expect, it } from 'vitest';
import { FixedWindowLimiter } from '../relay/src/rate';
import { handleHttp, type RouteContext, type SocketLike } from '../relay/src/routes';
import { ANALYTICS_PART_MAX_BASE64, type AnalyticsHost } from '../src/shared/analytics/snapshot-wire';
import { memStore } from './fake-relay';
import { testDevice } from './support/relay-auth';

const T = 1_700_000_000_000;
const OWNER = { authorization: 'Bearer enroll-secret' };
const hash = (c: string) => c.repeat(64);

function harness() {
  const store = memStore();
  const rate = new FixedWindowLimiter(() => T);
  const online = new Set<string>();
  const socket: SocketLike = { send: () => undefined, close: () => undefined };
  const ctx = (over: Partial<RouteContext> = {}): RouteContext => ({
    store,
    accountId: 'a',
    enrollToken: 'enroll-secret',
    now: T,
    ip: '203.0.113.7',
    rate,
    accountAuthenticated: true,
    sockets: (tag) => (online.has(tag) ? [socket] : []),
    ...over
  });
  return { store, ctx, online };
}

const req = (method: string, path: string, init: RequestInit = {}): Request => new Request(`https://relay.example${path}`, { method, ...init });
const as = (device: { deviceId: string; access: string }) => ({ authorization: `Bearer ${device.access}` });
const q = (device: { deviceId: string }, extra = '') => `?device=${device.deviceId}${extra}`;

function manifest(parts: Array<[string, string]>, extra: Record<string, unknown> = {}) {
  return { schemaVersion: 1, generatedAt: T, appVersion: '0.10.1', platform: 'win32', parts: parts.map(([id, h]) => ({ id, hash: h, bytes: 1 })), ...extra };
}

async function upload(ctx: () => RouteContext, host: { deviceId: string; access: string }, id: string, h: string, data = 'QUJDRA==') {
  return handleHttp(req('PUT', `/analytics/part${q(host, `&id=${id}`)}`, { headers: as(host), body: JSON.stringify({ hash: h, data }) }), ctx());
}

async function commit(ctx: () => RouteContext, host: { deviceId: string; access: string }, body: unknown) {
  return handleHttp(req('PUT', `/analytics/manifest${q(host)}`, { headers: as(host), body: JSON.stringify(body) }), ctx());
}

async function overview(ctx: () => RouteContext): Promise<AnalyticsHost[]> {
  const res = await handleHttp(req('GET', '/owner/analytics', { headers: OWNER }), ctx());
  expect(res.status).toBe(200);
  return ((await res.json()) as { hosts: AnalyticsHost[] }).hosts;
}

async function ownerPart(ctx: () => RouteContext, hostId: string, id: string) {
  return handleHttp(req('GET', `/owner/analytics/part?host=${hostId}&id=${id}`, { headers: OWNER }), ctx());
}

describe('analytics snapshot routes', () => {
  it('commits uploaded parts and serves them to the signed-in owner with each computer', async () => {
    const { ctx, store, online } = harness();
    const pc = await testDevice(store, 'host', { name: 'Vocs PC', now: T });
    const mac = await testDevice(store, 'host', { name: 'Vocs Macmini', now: T });
    online.add(`host:${pc.deviceId}`);

    expect((await upload(ctx, pc, 'days.2026-11', hash('a'))).status).toBe(200);
    expect((await upload(ctx, pc, 'tools', hash('b'), 'dG9vbHM=')).status).toBe(200);
    expect((await commit(ctx, pc, manifest([['days.2026-11', hash('a')], ['tools', hash('b')]]))).status).toBe(200);

    const hosts = await overview(ctx);
    const byName = Object.fromEntries(hosts.map((h) => [h.name, h]));
    expect(Object.keys(byName).sort()).toEqual(['Vocs Macmini', 'Vocs PC']);
    expect(byName['Vocs PC']).toMatchObject({ hostId: pc.deviceId, online: true, receivedAt: T });
    expect(byName['Vocs PC'].manifest?.parts.map((p) => [p.id, p.hash, p.bytes])).toEqual([['days.2026-11', hash('a'), 4], ['tools', hash('b'), 5]]);
    expect(byName['Vocs Macmini']).toMatchObject({ hostId: mac.deviceId, online: false, manifest: null, receivedAt: null });

    const part = await ownerPart(ctx, pc.deviceId, 'tools');
    expect(part.status).toBe(200);
    expect(await part.json()).toEqual({ hash: hash('b'), data: 'dG9vbHM=' });
    expect((await ownerPart(ctx, pc.deviceId, 'reports')).status).toBe(404);
    expect((await ownerPart(ctx, mac.deviceId, 'tools')).status).toBe(404);

    // The desktop reads its own manifest back, to skip parts the relay already holds.
    const own = await handleHttp(req('GET', `/analytics${q(pc)}`, { headers: as(pc) }), ctx());
    expect(((await own.json()) as { manifest: { parts: unknown[] } }).manifest.parts).toHaveLength(2);
  });

  it('refuses a manifest naming a part the relay does not hold, and commits nothing', async () => {
    const { ctx, store } = harness();
    const pc = await testDevice(store, 'host', { name: 'Vocs PC', now: T });
    await upload(ctx, pc, 'days.2026-11', hash('a'));
    const res = await commit(ctx, pc, manifest([['days.2026-11', hash('a')], ['days.2026-10', hash('c')], ['tools', hash('d')]]));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'missing-part', parts: ['days.2026-10', 'tools'] });
    expect((await overview(ctx))[0].manifest).toBeNull();
    // A part uploaded under another hash does not satisfy the manifest either.
    expect((await commit(ctx, pc, manifest([['days.2026-11', hash('e')]]))).status).toBe(409);
  });

  it('keeps serving the committed version while a new one is staged, then prunes the old one', async () => {
    const { ctx, store } = harness();
    const pc = await testDevice(store, 'host', { name: 'Vocs PC', now: T });
    await upload(ctx, pc, 'days.2026-11', hash('a'), 'b2xk');
    await upload(ctx, pc, 'days.2026-10', hash('b'));
    await commit(ctx, pc, manifest([['days.2026-11', hash('a')], ['days.2026-10', hash('b')]]));

    await upload(ctx, pc, 'days.2026-11', hash('c'), 'bmV3');
    expect(await (await ownerPart(ctx, pc.deviceId, 'days.2026-11')).json()).toEqual({ hash: hash('a'), data: 'b2xk' });

    await commit(ctx, pc, manifest([['days.2026-11', hash('c')]]));
    expect(await (await ownerPart(ctx, pc.deviceId, 'days.2026-11')).json()).toEqual({ hash: hash('c'), data: 'bmV3' });
    expect((await ownerPart(ctx, pc.deviceId, 'days.2026-10')).status).toBe(404);
    const keys = (await store.list(`analytics:a:${pc.deviceId}:part:`)).map(([k]) => k);
    expect(keys).toEqual([`analytics:a:${pc.deviceId}:part:days.2026-11@${hash('c')}`]);
  });

  it('writes only as the authenticated desktop, and serves owners only', async () => {
    const { ctx, store } = harness();
    const pc = await testDevice(store, 'host', { name: 'Vocs PC', now: T });
    const mac = await testDevice(store, 'host', { name: 'Vocs Macmini', now: T });
    const browser = await testDevice(store, 'web', { name: 'Chrome', now: T });
    await upload(ctx, pc, 'tools', hash('a'), 'cGM=');
    await commit(ctx, pc, manifest([['tools', hash('a')]]));

    // Another desktop's upload lands under its own id, never the PC's.
    await upload(ctx, mac, 'tools', hash('b'), 'bWFj');
    await commit(ctx, mac, manifest([['tools', hash('b')]]));
    expect(await (await ownerPart(ctx, pc.deviceId, 'tools')).json()).toEqual({ hash: hash('a'), data: 'cGM=' });

    expect((await upload(ctx, browser, 'tools', hash('c'))).status).toBe(403);
    expect((await handleHttp(req('PUT', '/analytics/part?id=tools', { body: JSON.stringify({ hash: hash('c'), data: 'QQ==' }) }), ctx())).status).toBe(401);
    for (const path of ['/owner/analytics', `/owner/analytics/part?host=${pc.deviceId}&id=tools`]) {
      expect((await handleHttp(req('GET', path, { headers: as(browser) }), ctx())).status).toBe(403);
      expect((await handleHttp(req('GET', path, { headers: OWNER }), ctx({ accountAuthenticated: false }))).status).toBe(403);
    }
    // Another account's Hub lists none of these computers.
    expect(await overview(() => ctx({ accountId: 'b' }))).toEqual([]);
  });

  it('validates part ids, hashes, sizes and manifests strictly', async () => {
    const { ctx, store } = harness();
    const pc = await testDevice(store, 'host', { name: 'Vocs PC', now: T });
    expect((await upload(ctx, pc, '../secrets', hash('a'))).status).toBe(400);
    expect((await upload(ctx, pc, 'days.2026-11', 'nothex'))).toHaveProperty('status', 400);
    expect((await upload(ctx, pc, 'days.2026-11', hash('a'), 'not base64!'))).toHaveProperty('status', 400);
    expect((await upload(ctx, pc, 'days.2026-11', hash('a'), 'A'.repeat(ANALYTICS_PART_MAX_BASE64 + 4))).status).toBe(413);
    await upload(ctx, pc, 'tools', hash('a'));
    expect((await commit(ctx, pc, manifest([['tools', hash('a')]], { secret: 'x' }))).status).toBe(400);
    expect((await commit(ctx, pc, manifest([['tools', hash('a')]], { schemaVersion: 2 }))).status).toBe(400);
    expect((await commit(ctx, pc, manifest([['tools', hash('a')], ['tools', hash('a')]]))).status).toBe(400);
    expect((await overview(ctx))[0].manifest).toBeNull();
  });

  it('deletes a computer\'s snapshot when it stops sharing or is revoked', async () => {
    const { ctx, store } = harness();
    const pc = await testDevice(store, 'host', { name: 'Vocs PC', now: T });
    const mac = await testDevice(store, 'host', { name: 'Vocs Macmini', now: T });
    for (const host of [pc, mac]) {
      await upload(ctx, host, 'tools', hash('a'));
      await commit(ctx, host, manifest([['tools', hash('a')]]));
    }

    expect((await handleHttp(req('DELETE', `/analytics${q(pc)}`, { headers: as(pc) }), ctx())).status).toBe(200);
    expect(await store.list(`analytics:a:${pc.deviceId}:`)).toEqual([]);

    expect((await handleHttp(req('DELETE', `/devices${q(pc, `&target=${mac.deviceId}`)}`, { headers: as(pc) }), ctx())).status).toBe(200);
    expect(await store.list(`analytics:a:${mac.deviceId}:`)).toEqual([]);
    expect((await overview(ctx)).map((h) => [h.name, h.manifest])).toEqual([['Vocs PC', null]]);
  });
});
