/** Desktop-side token and trust lifecycle (docs/REMOTE-ACCESS.md §6.2, §6.5): the real RemoteHost
 *  and RelayClient against the test relay, which serves the production route table and router.
 *  Covers what happens after pairing — expired access tokens, revocation from another device,
 *  mirror-key rotation and a desktop that was itself revoked. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { RelayClient, type WebCredentials } from '../relay/src/web-client';
import { RemoteAudit } from '../src/main/remote/audit';
import { RemoteHost } from '../src/main/remote/host';
import type { HandlerRegistry } from '../src/main/handlers';
import type { DeviceRecord } from '../relay/src/core';
import { ACCOUNT, ENROLL, FakeRelay } from './fake-relay';

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
  browser: () => { client: RelayClient; storage: Map<string, string> };
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
      const storage = new Map<string, string>();
      const client = new RelayClient({ storage: { get: (k) => storage.get(k) ?? null, set: (k, v) => void storage.set(k, v), remove: (k) => void storage.delete(k) }, wsFactory });
      clients.push(client);
      return { client, storage };
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
      for (const client of clients) client.logout();
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
});
