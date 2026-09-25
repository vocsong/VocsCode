/** Desktop-side token and trust lifecycle (docs/REMOTE-ACCESS.md §6.2, §6.5): the real RemoteHost
 *  and RelayClient against the test relay, which serves the production route table and router.
 *  Covers what happens after pairing — expired access tokens, revocation from another device,
 *  mirror-key rotation and a desktop that was itself revoked. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { memoryVault, RelayClient, type WebCredentials } from '../relay/src/web-client';
import { RemoteAudit } from '../src/main/remote/audit';
import { RemoteHost } from '../src/main/remote/host';
import type { HandlerRegistry } from '../src/main/handlers';
import type { DeviceRecord } from '../relay/src/core';
import { generateIdentity, publicOf } from '../src/shared/crypto';
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
  rotations: () => number;
  browser: () => { client: RelayClient };
  pair: (client: RelayClient, name: string) => Promise<WebCredentials>;
  cleanup: () => Promise<void>;
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.cleanup();
});

async function rig(): Promise<Rig> {
  const relay = new FakeRelay();
  const port = await relay.start();
  const base = `http://127.0.0.1:${port}`;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vocs-remote-lifecycle-'));
  const audit = new RemoteAudit({ dir, log: () => undefined });
  await audit.load();
  const secrets = new Map<string, string>();
  let rotated = 0;
  const host = new RemoteHost({
    registry: () => ({ channels: () => ['sessions:list'], invoke: async () => [{ id: 's1', title: 'Lifecycle host' }] } as unknown as HandlerRegistry),
    secrets: { get: async (key) => secrets.get(key), set: async (key, value) => void secrets.set(key, value) },
    pushState: () => undefined,
    log: () => undefined,
    broadcast: () => undefined,
    audit,
    onMirrorRotated: () => void rotated++
  });
  const clients: RelayClient[] = [];
  const created: Rig = {
    relay,
    base,
    host,
    secrets,
    audit,
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

describe('Connect with GitHub: adding and pairing through a signed-in owner', () => {
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
