/** Desktop-side token and trust lifecycle (docs/REMOTE-ACCESS.md §6.2, §6.5): the real RemoteHost
 *  and RelayClient against the test relay, which serves the production route table and router.
 *  Covers what happens after pairing — expired access tokens, revocation from another device,
 *  mirror-key rotation (and the order of mirror writes around it), mirror clears that fail and
 *  are retried, and a desktop that was itself revoked. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { memoryVault, RelayClient, type WebCredentials } from '../relay/src/web-client';
import { RemoteAudit } from '../src/main/remote/audit';
import { RemoteHost } from '../src/main/remote/host';
import { RemoteMirror } from '../src/main/remote/mirror';
import type { HandlerRegistry } from '../src/main/handlers';
import type { DeviceRecord } from '../relay/src/core';
import { generateIdentity, importAesKey, openBlob, publicOf, sealBlob, type SealedBlob } from '../src/shared/crypto';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';
import { ACCOUNT, ENROLL, FakeRelay } from './fake-relay';
import { connectCheckCode } from '../src/shared/pairing';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

function wsFactory(url: string, onMessage: (raw: string) => void, onClose: () => void) {
  const ws = new WebSocket(url);
  const queue: string[] = [];
  ws.on('open', () => {
    for (const raw of queue.splice(0)) ws.send(raw);
  });
  ws.on('message', (d) => onMessage(String(d)));
  ws.on('close', () => onClose());
  ws.on('error', () => undefined);
  return {
    send: (raw: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
      else queue.push(raw);
    },
    close: () => ws.close()
  };
}

interface Rig {
  relay: FakeRelay;
  base: string;
  host: RemoteHost;
  secrets: Map<string, string>;
  audit: RemoteAudit;
  logs: Array<{ level: string; message: string }>;
  rotations: () => number;
  browser: () => { client: RelayClient };
  pair: (client: RelayClient, name: string) => Promise<WebCredentials>;
  cleanup: () => Promise<void>;
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.cleanup();
});

async function rig(opts: { onMirrorRotated?: () => void; onOnline?: () => void; mirrorRetryMs?: number; mirrorLateWriteMs?: number } = {}): Promise<Rig> {
  const relay = new FakeRelay();
  const port = await relay.start();
  const base = `http://127.0.0.1:${port}`;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vocs-remote-lifecycle-'));
  const audit = new RemoteAudit({ dir, log: () => undefined });
  await audit.load();
  const secrets = new Map<string, string>();
  let rotated = 0;
  const logs: Array<{ level: string; message: string }> = [];
  const host = new RemoteHost({
    registry: () => ({ channels: () => ['sessions:list'], invoke: async () => [{ id: 's1', title: 'Lifecycle host' }] } as unknown as HandlerRegistry),
    secrets: { get: async (key) => secrets.get(key), set: async (key, value) => void secrets.set(key, value) },
    pushState: () => undefined,
    log: (level, message) => void logs.push({ level, message }),
    broadcast: () => undefined,
    audit,
    onMirrorRotated: () => {
      rotated++;
      opts.onMirrorRotated?.();
    },
    onOnline: opts.onOnline,
    mirrorRetryMs: opts.mirrorRetryMs,
    mirrorLateWriteMs: opts.mirrorLateWriteMs
  });
  const clients: RelayClient[] = [];
  const created: Rig = {
    relay,
    base,
    host,
    secrets,
    audit,
    logs,
    rotations: () => rotated,
    browser: () => {
      const client = new RelayClient({ vault: memoryVault(), wsFactory });
      clients.push(client);
      return { client };
    },
    pair: async (client, name) => {
      const { code } = await host.startPairing('Lifecycle PC');
      const pairing = client.pair({ relayBase: base, code, deviceName: name });
      await until(() => host.state().pendingRequest?.code === code, 'the pairing request');
      await host.respondPairing('approve');
      const creds = await pairing;
      await until(() => host.state().status === 'online', 'the desktop to come online');
      return creds;
    },
    cleanup: async () => {
      for (const client of clients) await client.logout();
      await host.disable();
      await relay.stop();
      await audit.flush();
      await rm(dir, { recursive: true, force: true });
    }
  };
  rigs.push(created);
  await host.enable(base, ENROLL);
  return created;
}

const saved = (r: Rig) => JSON.parse(r.secrets.get('remote-host') ?? '{}') as { deviceId?: string; deviceToken?: string; identity?: unknown; clients: Record<string, unknown>; mirrorKey?: string };

describe('remote host token and trust lifecycle', () => {
  it('re-proves possession when the relay drops its access token, without re-pairing', async () => {
    const r = await rig();
    const { client } = r.browser();
    const creds = await r.pair(client, 'Browser');
    const hostId = saved(r).deviceId!;
    expect((await r.host.listDevices()).map((d) => d.deviceId).sort()).toEqual([hostId, creds.webDeviceId].sort());
    // Expire every outstanding grant, as an hour passing would.
    for (const id of [hostId, creds.webDeviceId]) {
      const key = `device:${ACCOUNT}:${id}`;
      const device = (await r.relay.store.get<DeviceRecord>(key))!;
      await r.relay.store.put(key, { ...device, access: [] });
    }
    expect((await r.host.listDevices()).map((d) => d.deviceId).sort()).toEqual([hostId, creds.webDeviceId].sort());
    expect((await client.listDevices()).map((d) => d.deviceId).sort()).toEqual([hostId, creds.webDeviceId].sort());
    await client.connect();
    expect(await client.invoke('sessions:list', null)).toEqual([{ id: 's1', title: 'Lifecycle host' }]);
  });

  it('forgets a browser revoked from another browser and re-keys the mirror for the rest', async () => {
    const r = await rig();
    const a = r.browser();
    const b = r.browser();
    const aCreds = await r.pair(a.client, 'Browser A');
    await r.pair(b.client, 'Browser B');
    await b.client.connect();
    await until(() => b.client.hasMirror(), 'the first mirror key');
    const before = r.host.mirrorSecret();
    expect(b.client.credentials()?.mirrorKey).toBe(before);

    // B revokes A through the relay; the desktop hears a device.revoked hint and re-reads the registry.
    await b.client.revokeDevice(aCreds.webDeviceId);
    await until(() => !saved(r).clients[aCreds.webDeviceId], 'the desktop to forget browser A');
    const after = r.host.mirrorSecret();
    expect(after).not.toBe(before);
    expect(saved(r).mirrorKey).toBe(after);
    // The browser still paired receives the new key over its e2e session.
    await until(() => b.client.credentials()?.mirrorKey === after, 'browser B to receive the rotated key');
    expect(r.rotations()).toBe(1);
    expect(r.audit.list().some((e) => e.action === 'mirror-rotate')).toBe(true);
    // A's handshake is refused now even if the relay were to route it.
    await expect(a.client.connect()).rejects.toThrow();
  });

  it('rotates the mirror key when the desktop itself revokes a browser', async () => {
    const r = await rig();
    const { client } = r.browser();
    const creds = await r.pair(client, 'Browser');
    const before = r.host.mirrorSecret();
    await r.host.revokeDevice(creds.webDeviceId);
    expect(saved(r).clients).toEqual({});
    expect(r.host.mirrorSecret()).not.toBe(before);
    expect(r.rotations()).toBe(1);
  });

  it('pulls the kill switch: every other device revoked, pending codes dead, mirror re-keyed, still online', async () => {
    const r = await rig();
    const a = r.browser();
    const b = r.browser();
    await r.pair(a.client, 'Browser A');
    await r.pair(b.client, 'Browser B');
    const pending = await r.host.startPairing('Lifecycle PC'); // shown on screen, not yet claimed
    const before = r.host.mirrorSecret();
    await r.host.revokeAll();
    const hostId = saved(r).deviceId!;
    expect((await r.host.listDevices()).map((d) => d.deviceId)).toEqual([hostId]);
    expect(saved(r).clients).toEqual({});
    expect(r.host.mirrorSecret()).not.toBe(before);
    await sleep(100); // the relay's device.revoked notice must not rotate a second time
    expect(r.rotations()).toBe(1);
    expect(r.audit.list().some((e) => e.action === 'revoke-all')).toBe(true);
    expect(r.host.state().status).toBe('online');
    await expect(a.client.connect()).rejects.toThrow('no longer paired');
    await expect(b.client.listDevices()).rejects.toThrow('no longer paired');
    const claim = await fetch(`${r.base}/v1/pair/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pending.code, webPub: publicOf(await generateIdentity()) }) });
    expect(claim.status).toBe(401);
  });

  it('survives its own revocation: keeps its identity, re-enrolls on the next pairing, and drops stale browsers', async () => {
    const r = await rig();
    const a = r.browser();
    const aCreds = await r.pair(a.client, 'Browser A');
    const first = saved(r);
    // The lost-desktop case: a browser revokes the desktop. The relay cascades to A as well.
    await a.client.revokeDevice(aCreds.hostDeviceId);
    await until(() => !saved(r).deviceToken, 'the desktop to drop its rejected credential');
    await until(() => r.host.state().status === 'connecting' && /no longer registered/.test(r.host.state().detail ?? ''), 'enrolling mode');
    expect(saved(r).identity).toEqual(first.identity);
    expect(r.audit.list().some((e) => e.action === 'host-revoked')).toBe(true);

    // Pairing again enrolls the same key as a new device (the old one is gone) and reconciles.
    const b = r.browser();
    const bCreds = await r.pair(b.client, 'Browser B');
    expect(bCreds.hostDeviceId).not.toBe(aCreds.hostDeviceId);
    await until(() => !saved(r).clients[aCreds.webDeviceId], 'the stale browser to be forgotten');
    expect(Object.keys(saved(r).clients)).toEqual([bCreds.webDeviceId]);
    await b.client.connect();
    expect(await b.client.invoke('sessions:list', null)).toEqual([{ id: 's1', title: 'Lifecycle host' }]);
  });

  it("reconnects a registered computer with no enrollment secret anywhere", async () => {
    const r = await rig();
    const a = r.browser();
    await r.pair(a.client, "Phone");
    // Drop every copy of the secret: this computer now holds only its own credential.
    const stored = saved(r) as ReturnType<typeof saved> & { enrollToken?: string };
    delete stored.enrollToken;
    r.secrets.set("remote-host", JSON.stringify(stored));
    await r.host.disable();
    expect(await r.host.isRegistered()).toBe(true);
    await r.host.enable(r.base, "");
    await until(() => r.host.state().status === "online", "the desktop to come back online");
    expect(r.relay.connected()).toContainEqual({ kind: "host", id: stored.deviceId });
  });

  it("tells an unregistered computer without a secret what is missing instead of retrying", async () => {
    const r = await rig();
    const secrets = new Map<string, string>();
    const fresh = new RemoteHost({
      registry: () => ({ channels: () => [], invoke: async () => null } as unknown as HandlerRegistry),
      secrets: { get: async (key) => secrets.get(key), set: async (key, value) => void secrets.set(key, value) },
      pushState: () => undefined,
      log: () => undefined,
      broadcast: () => undefined
    });
    expect(await fresh.isRegistered()).toBe(false);
    await until(() => r.relay.connected().length === 1, "the rig desktop socket");
    const before = r.relay.connected().length;
    await fresh.enable(r.base, "");
    expect(fresh.state()).toMatchObject({ status: "error", detail: expect.stringContaining("enrollment secret") });
    // Past one reconnect interval: still no socket at the relay, and still the same explanation.
    await sleep(3500);
    expect(r.relay.connected()).toHaveLength(before);
    expect(fresh.state().status).toBe("error");
    await fresh.disable();
  });

});

describe('Connect with Vocs: adding and pairing through a signed-in owner', () => {
  /** What the landing does for a signed-in, allowlisted session: owner requests reach the relay
   *  with its enrollment secret in place of whatever Authorization the browser sent. */
  const asOwner: typeof fetch = (input, init = {}) => {
    const url = String(input);
    if (!new URL(url).pathname.startsWith('/v1/owner/')) return fetch(input, init);
    return fetch(input, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${ENROLL}` } });
  };

  it('registers this computer from the browser with no secret on the desktop, then pairs that browser on Allow', async () => {
    const r = await rig();
    const secrets = new Map<string, string>();
    const desktop = new RemoteHost({
      registry: () => ({ channels: () => ['sessions:list'], invoke: async () => [{ id: 's9', title: 'Signed-in host' }] } as unknown as HandlerRegistry),
      secrets: { get: async (key) => secrets.get(key), set: async (key, value) => void secrets.set(key, value) },
      pushState: () => undefined,
      log: () => undefined,
      broadcast: () => undefined
    });
    const opened: string[] = [];
    await desktop.signIn(r.base, async (url) => void opened.push(url));
    try {
      // The desktop opened the page with only a hash of its one-time secret, and shows the same
      // check code the page will show.
      expect(opened).toHaveLength(1);
      const link = new URL(opened[0]);
      expect(link.origin + link.pathname).toBe(`${r.base}/app`);
      const nonceHash = link.searchParams.get('connect')!;
      expect(nonceHash).toMatch(/^[0-9a-f]{64}$/);
      expect(desktop.state()).toMatchObject({ status: 'connecting', signIn: { link: opened[0], checkCode: connectCheckCode(nonceHash) } });
      expect(await desktop.isRegistered()).toBe(false);
      expect(JSON.stringify([...secrets.values()])).not.toContain(ENROLL);

      // The signed-in owner clicks "Add this computer".
      const browser = new RelayClient({ vault: memoryVault(), wsFactory, fetchImpl: asOwner });
      await browser.addComputer(r.base, nonceHash);
      await until(async () => desktop.state().status === 'online' && (await desktop.isRegistered()), 'the desktop to register and come online', 10_000);
      expect(desktop.state().signIn).toBeUndefined();
      const added = await browser.addedComputer(r.base, nonceHash);
      expect(added.status).toBe('redeemed');
      expect(await browser.ownerHosts(r.base)).toContainEqual(expect.objectContaining({ deviceId: added.hostDeviceId, online: true }));

      // The same browser asks that computer to pair; nothing happens until Allow on the desktop.
      const pairing = browser.pairWithHost({ relayBase: r.base, hostDeviceId: added.hostDeviceId!, deviceName: 'Signed-in phone' });
      await until(() => desktop.state().pendingRequest?.name === 'Signed-in phone', 'the pairing request on the desktop');
      await desktop.respondPairing('approve');
      const creds = await pairing;
      expect(creds.hostDeviceId).toBe(added.hostDeviceId);
      await browser.connect();
      expect(await browser.invoke('sessions:list', null)).toEqual([{ id: 's9', title: 'Signed-in host' }]);
      await browser.logout();
    } finally {
      await desktop.disable();
    }
  });

  it('refuses owner actions without the landing credential and never asks an unregistered desktop', async () => {
    const r = await rig();
    const stranger = new RelayClient({ vault: memoryVault(), wsFactory });
    await expect(stranger.addComputer(r.base, 'ab'.repeat(32))).rejects.toThrow();
    await expect(stranger.ownerHosts(r.base)).rejects.toThrow();
    // The rig desktop is still enrolling (no browser approved it yet), so it is no computer of the
    // account an owner could ask.
    const owner = new RelayClient({ vault: memoryVault(), wsFactory, fetchImpl: asOwner });
    expect(await owner.ownerHosts(r.base)).toEqual([]);
    expect(r.host.state().pendingRequest).toBeUndefined();
  });

  it('stops waiting when remote access is turned off before the browser adds the computer', async () => {
    const r = await rig();
    const secrets = new Map<string, string>();
    const desktop = new RemoteHost({
      registry: () => ({ channels: () => [], invoke: async () => null } as unknown as HandlerRegistry),
      secrets: { get: async (key) => secrets.get(key), set: async (key, value) => void secrets.set(key, value) },
      pushState: () => undefined,
      log: () => undefined,
      broadcast: () => undefined
    });
    let nonceHash = '';
    await desktop.signIn(r.base, async (url) => void (nonceHash = new URL(url).searchParams.get('connect')!));
    await desktop.disable();
    expect(desktop.state()).toMatchObject({ status: 'off' });
    expect(desktop.state().signIn).toBeUndefined();
    // Granted after the cancel: this desktop no longer polls, so it never registers.
    await new RelayClient({ vault: memoryVault(), wsFactory, fetchImpl: asOwner }).addComputer(r.base, nonceHash);
    await sleep(2500);
    expect(await desktop.isRegistered()).toBe(false);
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

interface MirrorWrite {
  method: string;
  path: string;
  status: number | 'network error' | 'late';
  blob?: SealedBlob;
}

/** Records every mirror write the desktop sends, in the order the relay answered them. `hold`
 *  pauses a request before it reaches the relay; `fail` answers it without reaching the relay;
 *  `late` fails it on the desktop with a transport error while the request itself still reaches
 *  the relay that many milliseconds later (recorded with status 'late'). */
function watchMirrorWrites(opts: {
  hold?: (method: string, path: string) => Promise<void> | undefined;
  fail?: (method: string, path: string) => Response | Error | undefined;
  late?: (method: string, path: string) => number | undefined;
} = {}) {
  const writes: MirrorWrite[] = [];
  const deliveries: Array<Promise<void>> = [];
  const original = globalThis.fetch;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' || !url.pathname.startsWith('/v1/mirror')) return original(input, init);
    await opts.hold?.(method, url.pathname);
    const blob = method === 'PUT' && typeof init?.body === 'string' ? (JSON.parse(init.body) as SealedBlob) : undefined;
    const lateMs = opts.late?.(method, url.pathname);
    if (lateMs !== undefined) {
      writes.push({ method, path: url.pathname, status: 'network error' });
      deliveries.push(
        sleep(lateMs)
          .then(() => original(input, init))
          .then((res) => void writes.push({ method, path: url.pathname, status: res.status === 200 ? 'late' : res.status }))
      );
      throw new TypeError('fetch failed');
    }
    const failure = opts.fail?.(method, url.pathname);
    if (failure instanceof Error) {
      writes.push({ method, path: url.pathname, status: 'network error' });
      throw failure;
    }
    const res = failure ?? (await original(input, init));
    writes.push({ method, path: url.pathname, status: res.status, blob });
    return res;
  });
  return { writes, deliveries, restore: () => spy.mockRestore() };
}

async function opens(secret: string, blob: SealedBlob): Promise<boolean> {
  try {
    await openBlob(await importAesKey(secret), blob);
    return true;
  } catch {
    return false;
  }
}

const mirroredSession = { id: 's1', title: 'Mirrored', status: 'idle', updatedAt: 1, config: { harness: 'native', projectRoot: '/repo' } } as unknown as SessionMeta;
const mirroredItems = [{ id: 'm1', kind: 'user', ts: 1, text: 'mirrored text' }] as TranscriptItem[];

describe('offline mirror writes around key rotation and clearing', () => {
  it('clears a re-keyed mirror only after an upload already sent under the old key has landed', async () => {
    let mirror: RemoteMirror | null = null;
    const r = await rig({ onMirrorRotated: () => mirror?.sync() });
    const { client } = r.browser();
    const creds = await r.pair(client, 'Browser');
    const oldSecret = r.host.mirrorSecret()!;
    const arrived = deferred();
    const release = deferred();
    let held = false;
    const relay = watchMirrorWrites({
      hold: (method, path) => {
        if (held || method !== 'PUT' || path !== '/v1/mirror/s1') return undefined;
        held = true;
        arrived.resolve();
        return release.promise;
      }
    });
    try {
      mirror = new RemoteMirror({
        host: () => r.host,
        sessions: () => [mirroredSession],
        transcript: async () => mirroredItems,
        enabled: () => true,
        debounceMs: 5,
        log: () => undefined
      });
      mirror.notify('s1');
      await arrived.promise;
      // The snapshot sealed under the current key is on its way to the relay; now re-key.
      const revoking = r.host.revokeDevice(creds.webDeviceId);
      await until(() => r.host.mirrorSecret() !== oldSecret, 'the key rotation');
      await sleep(150);
      release.resolve();
      await revoking;
      const newSecret = r.host.mirrorSecret()!;
      await until(() => relay.writes.filter((w) => w.method === 'PUT').length >= 4, 'the re-sealed mirror');
      await sleep(50);

      const tag = async (w: MirrorWrite) => {
        if (!w.blob) return `${w.method} ${w.path}`;
        const key = (await opens(oldSecret, w.blob)) ? 'old-key' : (await opens(newSecret, w.blob)) ? 'new-key' : 'unreadable';
        return `${w.method} ${w.path} ${key}`;
      };
      const tagged = await Promise.all(relay.writes.map(tag));
      expect(tagged.slice(0, 3)).toEqual(['PUT /v1/mirror old-key', 'PUT /v1/mirror/s1 old-key', 'DELETE /v1/mirror']);
      expect(tagged.slice(3).sort()).toEqual(['PUT /v1/mirror new-key', 'PUT /v1/mirror/s1 new-key']);
      // What the relay holds now opens only with the new key.
      const stored = (await r.relay.store.list<{ blob?: SealedBlob }>('mirror:')).flatMap(([, v]) => (v.blob ? [v.blob] : []));
      expect(stored).toHaveLength(2);
      for (const blob of stored) {
        expect(await opens(oldSecret, blob)).toBe(false);
        expect(await opens(newSecret, blob)).toBe(true);
      }
    } finally {
      mirror?.stop();
      relay.restore();
    }
  });

  it('makes analytics calls as the registered computer only while remote access is on', async () => {
    let online = 0;
    const r = await rig({ onOnline: () => void online++ });
    // Enrolling, not yet registered: nothing to send as.
    expect(await r.host.analyticsRequest('/v1/analytics')).toBeNull();
    await r.pair(r.browser().client, 'Browser');
    await until(() => online > 0, 'the online hook');
    const res = await r.host.analyticsRequest('/v1/analytics');
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ manifest: null, receivedAt: null });
    await r.host.disable();
    expect(await r.host.analyticsRequest('/v1/analytics')).toBeNull();
  });

  it('does not send a mirror upload whose publication was superseded', async () => {
    const r = await rig();
    await r.pair(r.browser().client, 'Browser');
    const relay = watchMirrorWrites();
    try {
      const blob = await sealBlob(await importAesKey(r.host.mirrorSecret()!), { hostName: 'Test PC', updatedAt: 1, sessions: [] });
      expect(await r.host.putMirror('index', undefined, blob, () => false)).toBe(false);
      expect(relay.writes).toEqual([]);
      expect(await r.host.putMirror('index', undefined, blob, () => true)).toBe(true);
      expect(relay.writes.map((w) => `${w.method} ${w.path} ${w.status}`)).toEqual(['PUT /v1/mirror 200']);
    } finally {
      relay.restore();
    }
  });

  it('reports a failed mirror clear and repeats it before the next upload', async () => {
    const r = await rig();
    await r.pair(r.browser().client, 'Browser');
    let failures = 1;
    const relay = watchMirrorWrites({
      fail: (method, path) => (method === 'DELETE' && path === '/v1/mirror' && failures-- > 0 ? new Response('unavailable', { status: 503 }) : undefined)
    });
    try {
      expect(await r.host.clearMirror()).toBe(false);
      expect(r.logs.filter((l) => l.level === 'warn' && l.message.includes('mirror clear failed'))).toHaveLength(1);
      expect(r.audit.list().filter((e) => e.action === 'mirror-clear-failed')).toHaveLength(1);

      const blob = await sealBlob(await importAesKey(r.host.mirrorSecret()!), { hostName: 'Test PC', updatedAt: 1, sessions: [] });
      expect(await r.host.putMirror('index', undefined, blob)).toBe(true);
      expect(relay.writes.map((w) => `${w.method} ${w.path} ${w.status}`)).toEqual(['DELETE /v1/mirror 503', 'DELETE /v1/mirror 200', 'PUT /v1/mirror 200']);
      expect(r.audit.list().filter((e) => e.action === 'mirror-clear-recovered')).toHaveLength(1);
    } finally {
      relay.restore();
    }
  });

  it('retries a failed mirror clear on its own when nothing else is published', async () => {
    const r = await rig({ mirrorRetryMs: 20 });
    await r.pair(r.browser().client, 'Browser');
    let failures = 1;
    const relay = watchMirrorWrites({
      fail: (method, path) => (method === 'DELETE' && path === '/v1/mirror' && failures-- > 0 ? new TypeError('fetch failed') : undefined)
    });
    try {
      expect(await r.host.clearMirror()).toBe(false);
      await until(() => relay.writes.some((w) => w.method === 'DELETE' && w.status === 200), 'the retried clear');
      await sleep(100);
      expect(relay.writes.map((w) => `${w.method} ${w.path} ${w.status}`)).toEqual(['DELETE /v1/mirror network error', 'DELETE /v1/mirror 200']);
      expect(r.audit.list().filter((e) => e.action === 'mirror-clear-failed')).toHaveLength(1);
      expect(r.audit.list().filter((e) => e.action === 'mirror-clear-recovered')).toHaveLength(1);
    } finally {
      relay.restore();
    }
  });
});

describe('offline mirror clear retries', () => {
  const sealedIndex = async (r: Rig) => sealBlob(await importAesKey(r.host.mirrorSecret()!), { hostName: 'Test PC', updatedAt: 1, sessions: [] });
  const storedSessions = async (r: Rig) =>
    (await r.relay.store.list<{ blob?: SealedBlob }>('mirror:'))
      .map(([key]) => key)
      .filter((key) => key.includes(':s:'))
      .map((key) => key.slice(key.lastIndexOf(':s:') + 3))
      .sort();

  it('repeats the one owed clear for a burst of uploads and keeps every upload it accepted', async () => {
    const r = await rig();
    await r.pair(r.browser().client, 'Browser');
    let failures = 2;
    const relay = watchMirrorWrites({
      fail: (method, path) => (method === 'DELETE' && path === '/v1/mirror' && failures-- > 0 ? new Response('unavailable', { status: 503 }) : undefined)
    });
    try {
      const blob = await sealedIndex(r);
      const ids = Array.from({ length: 8 }, (_, i) => `s${i + 1}`);
      expect(await r.host.clearMirror()).toBe(false);
      // A burst behind a clear that fails again: one retry for all of them, and none publishes.
      const first = await Promise.all(ids.map((id) => r.host.putMirror('session', id, blob)));
      expect(first).toEqual(ids.map(() => false));
      // The next burst: one more retry, which succeeds, then every upload lands and stays.
      const second = await Promise.all(ids.map((id) => r.host.putMirror('session', id, blob)));
      expect(second).toEqual(ids.map(() => true));
      await sleep(100);
      const deletes = relay.writes.filter((w) => w.method === 'DELETE').map((w) => w.status);
      expect(deletes).toEqual([503, 503, 200]);
      const lastDelete = relay.writes.findLastIndex((w) => w.method === 'DELETE');
      expect(relay.writes.slice(lastDelete + 1).every((w) => w.method === 'PUT' && w.status === 200)).toBe(true);
      expect(await storedSessions(r)).toEqual([...ids].sort());
    } finally {
      relay.restore();
    }
  });

  it('clears once more after an upload that failed in transit may still reach the relay', async () => {
    let enabled = true;
    const r = await rig({ mirrorLateWriteMs: 400 });
    await r.pair(r.browser().client, 'Browser');
    const relay = watchMirrorWrites({ late: (method, path) => (method === 'PUT' && path === '/v1/mirror/s1' ? 150 : undefined) });
    const mirror = new RemoteMirror({
      host: () => r.host,
      sessions: () => [mirroredSession],
      transcript: async () => mirroredItems,
      enabled: () => enabled,
      debounceMs: 5,
      log: () => undefined
    });
    try {
      mirror.notify('s1');
      await until(() => relay.writes.some((w) => w.path === '/v1/mirror/s1') && relay.writes.some((w) => w.path === '/v1/mirror'), 'the index upload, and the snapshot upload failing in transit');
      enabled = false;
      await mirror.disable();
      await Promise.all(relay.deliveries);
      await sleep(50);
      const order = relay.writes.map((w) => `${w.method} ${w.path} ${w.status}`);
      // The index and the failed snapshot upload finish in either order; everything after is exact.
      expect(order.slice(0, 2).sort()).toEqual(['PUT /v1/mirror 200', 'PUT /v1/mirror/s1 network error']);
      expect(order.slice(2)).toEqual(['DELETE /v1/mirror 200', 'PUT /v1/mirror/s1 late', 'DELETE /v1/mirror 200']);
      expect(await storedSessions(r)).toEqual([]);
    } finally {
      mirror.stop();
      relay.restore();
    }
  });

  it('does not retry a failed clear on a timer while remote access is paused, and retries on reconnect', async () => {
    const r = await rig({ mirrorRetryMs: 20 });
    await r.pair(r.browser().client, 'Browser');
    await r.host.disable();
    let failures = 1;
    const relay = watchMirrorWrites({
      fail: (method, path) => (method === 'DELETE' && path === '/v1/mirror' && failures-- > 0 ? new Response('unavailable', { status: 503 }) : undefined)
    });
    try {
      expect(await r.host.clearMirror()).toBe(false);
      await sleep(200);
      expect(relay.writes.map((w) => `${w.method} ${w.status}`)).toEqual(['DELETE 503']);
      await r.host.enable(r.base, ENROLL);
      await until(() => relay.writes.some((w) => w.method === 'DELETE' && w.status === 200), 'the clear retried on reconnect');
      await sleep(100);
      expect(relay.writes.map((w) => `${w.method} ${w.status}`)).toEqual(['DELETE 503', 'DELETE 200']);
    } finally {
      relay.restore();
    }
  });

  it('backs off only between timer retries, not on retries an upload starts', async () => {
    const r = await rig({ mirrorRetryMs: 100 });
    await r.pair(r.browser().client, 'Browser');
    let failures = 4;
    const relay = watchMirrorWrites({
      fail: (method, path) => (method === 'DELETE' && path === '/v1/mirror' && failures-- > 0 ? new Response('unavailable', { status: 503 }) : undefined)
    });
    try {
      const blob = await sealedIndex(r);
      expect(await r.host.clearMirror()).toBe(false);
      for (let i = 0; i < 3; i++) expect(await r.host.putMirror('index', undefined, blob)).toBe(false);
      const afterUploads = Date.now();
      expect(relay.writes.filter((w) => w.method === 'DELETE')).toHaveLength(4);
      // The timer still runs at its first delay: the upload-started attempts did not stretch it.
      await until(() => relay.writes.some((w) => w.method === 'DELETE' && w.status === 200), 'the timer retry', 2000);
      expect(Date.now() - afterUploads).toBeLessThan(400);
    } finally {
      relay.restore();
    }
  });
});
