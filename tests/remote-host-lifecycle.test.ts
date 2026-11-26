/** Desktop relay connection lifecycle (docs/CONTROL-MCP.md, docs/WEB-DASHBOARD.md): the real
 *  RemoteHost and RelayClient against the test relay, which serves the production route table.
 *  Covers Connect with Vocs registration, resume, expired access tokens, revocation, the analytics
 *  gate, and the one-time cleanup of what the retired paired-browser access left behind. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { memoryVault, RelayClient } from '../relay/src/web-client';
import type { DeviceRecord } from '../relay/src/core';
import { RemoteHost } from '../src/main/remote/host';
import { connectCheckCode } from '../src/shared/pairing';
import { ACCOUNT, ENROLL, FakeRelay } from './fake-relay';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

function wsFactory(url: string, onMessage: (raw: string) => void, onClose: () => void) {
  const ws = new WebSocket(url);
  ws.on('message', (d) => onMessage(String(d)));
  ws.on('close', () => onClose());
  ws.on('error', () => undefined);
  return { send: (raw: string) => ws.send(raw), close: () => ws.close() };
}

/** What the landing does for a signed-in owner: `/v1/owner/*` requests reach the relay with its
 *  owner credential in place of whatever Authorization the browser sent. */
const asOwner: typeof fetch = (input, init = {}) => {
  const url = String(input);
  if (!new URL(url).pathname.startsWith('/v1/owner/')) return fetch(input, init);
  return fetch(input, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${ENROLL}` } });
};
const owner = () => new RelayClient({ vault: memoryVault(), wsFactory, fetchImpl: asOwner });

interface Desktop {
  host: RemoteHost;
  secrets: Map<string, string>;
  logs: Array<{ level: string; message: string }>;
  opened: string[];
  online: () => number;
}

const relays: FakeRelay[] = [];
const desktops: RemoteHost[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of desktops.splice(0)) await host.disable();
  for (const relay of relays.splice(0)) await relay.stop();
});

async function relay(): Promise<{ relay: FakeRelay; base: string }> {
  const created = new FakeRelay();
  relays.push(created);
  return { relay: created, base: `http://127.0.0.1:${await created.start()}` };
}

function desktop(secrets = new Map<string, string>()): Desktop {
  const logs: Desktop['logs'] = [];
  const opened: string[] = [];
  let online = 0;
  const host = new RemoteHost({
    secrets: { get: async (key) => secrets.get(key), set: async (key, value) => void secrets.set(key, value) },
    pushState: () => undefined,
    log: (level, message) => void logs.push({ level, message }),
    onOnline: () => void online++
  });
  desktops.push(host);
  return { host, secrets, logs, opened, online: () => online };
}

/** Connect with Vocs end to end: the desktop opens the page, the signed-in owner adds it. */
async function register(d: Desktop, base: string): Promise<string> {
  await d.host.signIn(base, async (url) => void d.opened.push(url));
  const nonceHash = new URL(d.opened.at(-1)!).searchParams.get('connect')!;
  await owner().addComputer(base, nonceHash);
  await until(async () => d.host.state().status === 'online' && (await d.host.isRegistered()), 'the desktop to register and come online');
  return saved(d).deviceId!;
}

const saved = (d: Desktop) => JSON.parse(d.secrets.get('remote-host') ?? '{}') as Record<string, unknown> & { deviceId?: string; deviceToken?: string; identity?: unknown };

describe('Connect with Vocs registration', () => {
  it('registers this computer through the signed-in owner with no secret on the desktop', async () => {
    const { relay: r, base } = await relay();
    const d = desktop();
    await d.host.signIn(base, async (url) => void d.opened.push(url));
    // The page carries only a hash of the one-time secret, and both sides show the same check code.
    expect(d.opened).toHaveLength(1);
    const link = new URL(d.opened[0]);
    expect(link.origin + link.pathname).toBe(`${base}/dashboard`);
    const nonceHash = link.searchParams.get('connect')!;
    expect(nonceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.host.state()).toMatchObject({ status: 'connecting', registered: false, signIn: { link: d.opened[0], checkCode: connectCheckCode(nonceHash) } });

    await owner().addComputer(base, nonceHash);
    await until(async () => d.host.state().status === 'online' && (await d.host.isRegistered()), 'the desktop to register and come online');
    const hostId = saved(d).deviceId!;
    expect(d.host.state()).toEqual({ status: 'online', detail: undefined, registered: true });
    expect(r.connected()).toEqual([{ kind: 'host', id: hostId }]);
    expect(d.online()).toBe(1);
    // Only the identity and the device credential are kept: no enrollment secret, no browser state.
    expect(Object.keys(saved(d)).sort()).toEqual(['deviceId', 'deviceToken', 'identity', 'relayUrl']);
  });

  it('stops waiting when the connection is turned off before the owner adds the computer', async () => {
    const { base } = await relay();
    const d = desktop();
    await d.host.signIn(base, async (url) => void d.opened.push(url));
    await d.host.disable();
    expect(d.host.state()).toEqual({ status: 'off', detail: undefined, registered: false });
    // Granted after the cancel: this desktop no longer polls, so it never registers.
    await owner().addComputer(base, new URL(d.opened[0]).searchParams.get('connect')!);
    await sleep(2500);
    expect(await d.host.isRegistered()).toBe(false);
  });

  it('tells an unregistered computer to connect with Vocs instead of retrying', async () => {
    const { relay: r, base } = await relay();
    const d = desktop();
    await d.host.enable(base);
    expect(d.host.state()).toMatchObject({ status: 'error', detail: expect.stringContaining('connect with Vocs') });
    // Past one reconnect interval: still no socket at the relay, and still the same explanation.
    await sleep(3500);
    expect(r.connected()).toEqual([]);
    expect(d.host.state().status).toBe('error');
  });
});

describe('a registered computer', () => {
  it('reconnects on resume with only its own credential', async () => {
    const { relay: r, base } = await relay();
    const d = desktop();
    const hostId = await register(d, base);
    await d.host.disable();
    await until(() => r.connected().length === 0, 'the socket to close');
    // A restart: a new host over the same stored credential.
    const again = desktop(d.secrets);
    expect(await again.host.isRegistered()).toBe(true);
    await again.host.enable(base);
    await until(() => again.host.state().status === 'online', 'the desktop to come back online');
    expect(r.connected()).toEqual([{ kind: 'host', id: hostId }]);
  });

  it('re-proves possession when the relay drops its access token', async () => {
    const { relay: r, base } = await relay();
    const d = desktop();
    const hostId = await register(d, base);
    const key = `device:${ACCOUNT}:${hostId}`;
    const device = (await r.store.get<DeviceRecord>(key))!;
    await r.store.put(key, { ...device, access: [] });
    expect((await d.host.listDevices()).map((x) => x.deviceId)).toEqual([hostId]);
    expect(await d.host.isRegistered()).toBe(true);
  });

  it('makes analytics calls only while the connection is on', async () => {
    const { base } = await relay();
    const d = desktop();
    expect(await d.host.analyticsRequest('/v1/analytics')).toBeNull();
    await register(d, base);
    const res = await d.host.analyticsRequest('/v1/analytics');
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ manifest: null, receivedAt: null });
    await d.host.disable();
    expect(await d.host.analyticsRequest('/v1/analytics')).toBeNull();
  });

  it('removes another computer and keeps itself; the kill switch leaves only this one', async () => {
    const { relay: r, base } = await relay();
    const a = desktop();
    const b = desktop();
    const c = desktop();
    const aId = await register(a, base);
    const bId = await register(b, base);
    const cId = await register(c, base);
    expect((await a.host.listDevices()).map((x) => x.deviceId).sort()).toEqual([aId, bId, cId].sort());

    await a.host.revokeDevice(bId);
    await until(() => b.host.state().status === 'error', 'the removed computer to stop');
    expect(b.host.state().detail).toMatch(/connect with Vocs/);
    expect(await b.host.isRegistered()).toBe(false);

    await a.host.revokeAll();
    await until(() => c.host.state().status === 'error', 'the other computer to stop');
    expect((await a.host.listDevices()).map((x) => x.deviceId)).toEqual([aId]);
    expect(a.host.state().status).toBe('online');
    await sleep(3500);
    // Revoked computers stop reconnecting with a credential the relay refuses.
    expect(r.connected()).toEqual([{ kind: 'host', id: aId }]);
  });

  it('survives removing itself: keeps its identity and registers again with Connect with Vocs', async () => {
    const { base } = await relay();
    const d = desktop();
    const first = await register(d, base);
    const identity = saved(d).identity;
    await d.host.revokeDevice(first);
    expect(d.host.state()).toMatchObject({ status: 'error', registered: false, detail: expect.stringContaining('connect with Vocs') });
    expect(saved(d).identity).toEqual(identity);
    const second = await register(d, base);
    expect(second).not.toBe(first);
    expect(saved(d).identity).toEqual(identity);
  });

  it('answers nothing to frames meant for the retired paired-browser channel', async () => {
    const { relay: r, base } = await relay();
    const d = desktop();
    const hostId = await register(d, base);
    // Spied after the relay bound its own send, so only the desktop's replies are counted.
    const replies = vi.spyOn(WebSocket.prototype, 'send');
    const sockets = (r as unknown as { meta: Map<WebSocket, unknown> }).meta;
    for (const ws of sockets.keys()) {
      ws.send(JSON.stringify({ t: 'hs', from: 'w_old', payload: {} }));
      ws.send(JSON.stringify({ t: 'd', from: 'w_old', seq: 1, payload: 'x' }));
      ws.send(JSON.stringify({ t: 'pair.request', code: 'ABCDEFGH', requested: true }));
    }
    await sleep(200);
    expect(replies).not.toHaveBeenCalled();
    expect(d.host.state()).toEqual({ status: 'online', detail: undefined, registered: true });
    expect(r.connected()).toEqual([{ kind: 'host', id: hostId }]);
  });
});

describe('upgrading from a build with paired-browser access', () => {
  it('deletes the old transcript mirror once and drops browser trust anchors and the enrollment secret', async () => {
    const { base } = await relay();
    const d = desktop();
    await register(d, base);
    await d.host.disable();
    // What an older build stored alongside the same credential.
    d.secrets.set('remote-host', JSON.stringify({
      ...saved(d),
      enrollToken: 'old-secret',
      clients: { w_1: { sig: {}, enc: {} } },
      mirrorKey: 'bWlycm9yLWtleQ'
    }));
    const original = globalThis.fetch;
    const deletes: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') deletes.push(url.pathname);
      return original(input, init);
    });

    const upgraded = desktop(d.secrets);
    await upgraded.host.enable(base);
    await until(() => !('legacyMirror' in saved(upgraded)) && upgraded.host.state().status === 'online', 'the mirror purge');
    expect(deletes).toEqual(['/v1/mirror']);
    expect(Object.keys(saved(upgraded)).sort()).toEqual(['deviceId', 'deviceToken', 'identity', 'relayUrl']);
    expect(JSON.stringify(saved(upgraded))).not.toContain('old-secret');

    // Reconnecting does not delete again.
    await upgraded.host.disable();
    await upgraded.host.enable(base);
    await until(() => upgraded.host.state().status === 'online', 'the reconnect');
    await sleep(200);
    expect(deletes).toEqual(['/v1/mirror']);
  });

  it('keeps the purge owed when the relay cannot delete yet, and retries on the next connect', async () => {
    const { base } = await relay();
    const d = desktop();
    await register(d, base);
    await d.host.disable();
    d.secrets.set('remote-host', JSON.stringify({ ...saved(d), mirrorKey: 'bWlycm9yLWtleQ' }));
    const original = globalThis.fetch;
    let failing = true;
    let attempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/v1/mirror' && (init?.method ?? '').toUpperCase() === 'DELETE') {
        attempts++;
        if (failing) return new Response('{}', { status: 503 });
      }
      return original(input, init);
    });

    const upgraded = desktop(d.secrets);
    await upgraded.host.enable(base);
    await until(() => attempts === 1, 'the first purge attempt');
    await sleep(100);
    expect(saved(upgraded).legacyMirror).toBe(true);
    expect(upgraded.logs.some((l) => l.level === 'warn' && /old transcript mirror/.test(l.message))).toBe(true);

    failing = false;
    await upgraded.host.disable();
    await upgraded.host.enable(base);
    await until(() => !('legacyMirror' in saved(upgraded)), 'the retried purge');
    expect(attempts).toBe(2);
  });
});
