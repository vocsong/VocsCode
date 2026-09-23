/** Integration test for the relay web client (relay/src/web-client.ts): pairing from the
 *  browser side, e2e handshake, filtered invokes and push reception — the same full loop
 *  as remote-e2e.test.ts but driven entirely through RelayClient's public API. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { RelayClient, relayBaseFor } from '../relay/src/web-client';
import { ENROLL, FakeRelay } from './fake-relay';
import { RemoteHost } from '../src/main/remote/host';
import { RemoteAudit } from '../src/main/remote/audit';
import { generateIdentity, importAesKey, publicOf, sealBlob } from '../src/shared/crypto';
import { registerWebDevice } from '../relay/src/core';
import type { HandlerRegistry } from '../src/main/handlers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The web app is served by the relay that routes it, so its base is its own origin; the
 *  landing page owns the hostname and forwards `/app`, `/v1` and `/ws` to the relay Worker. */
describe('relay base resolution', () => {
  it('defaults to the page origin and honours a trimmed override', () => {
    expect(relayBaseFor('https://code.vocs.io')).toBe('https://code.vocs.io');
    expect(relayBaseFor('https://code.vocs.io/')).toBe('https://code.vocs.io');
    expect(relayBaseFor('https://code.vocs.io', 'https://relay.example/')).toBe('https://relay.example');
    // An empty override (the `?relay=` param left blank) must not win over the origin.
    expect(relayBaseFor('http://localhost:8787', '')).toBe('http://localhost:8787');
    expect(relayBaseFor('http://localhost:8787', '   ')).toBe('http://localhost:8787');
  });
});

describe('relay web client (browser-side protocol)', () => {
  let relay: FakeRelay;
  let port = 0;

  beforeAll(async () => {
    relay = new FakeRelay();
    port = await relay.start();
  });

  afterAll(async () => {
    await relay.stop();
  });

  function wsFactory(url: string, onMessage: (raw: string) => void, onClose: () => void) {
    const ws = new WebSocket(url);
    // Emulates browserSocket's queue; native WebSocket.send throws while CONNECTING.
    const queue: string[] = [];
    ws.on('open', () => {
      for (const raw of queue.splice(0)) ws.send(raw);
    });
    ws.on('message', (d) => onMessage(String(d)));
    ws.on('close', () => onClose());
    return {
      send: (raw: string) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(raw);
        else queue.push(raw);
      },
      close: () => ws.close()
    };
  }

  it('pairs via the browser flow, handshakes and serves read-only invokes', async () => {    // Desktop side (as in remote-e2e.test.ts).
    const calls: string[] = [];
    const registry = {
      channels: () => ['sessions:list', 'sessions:send', 'sessions:create', 'settings:update'],
      invoke: async (channel: string, request?: unknown) => {
        calls.push(request && typeof request === 'object' && 'input' in request ? `${channel}:${JSON.stringify((request as { input: unknown }).input)}` : channel);
        if (channel === 'sessions:list') return [{ id: 's1', title: 'From the host' }];
        if (channel === 'sessions:send') return undefined;
        if (channel === 'sessions:create') return { id: 's2', title: 'New' };
        if (channel === 'settings:update') return { remote: { enabled: true } };
        throw new Error('unknown');
      }
    } as unknown as HandlerRegistry;
    const host = new RemoteHost({
      registry: () => registry,
      secrets: { get: async () => undefined, set: async () => undefined },
      pushState: () => undefined,
      log: () => undefined,
      broadcast: () => undefined
    });
    await host.enable(`http://127.0.0.1:${port}`, ENROLL);
    const { code } = await host.startPairing('Test PC');

    // Browser side: start the pairing (claim + poll loop).
    const storage = new Map<string, string>();
    const rest: Array<{ url: string; authorization: string | null }> = [];
    let pollToken: string | undefined;
    const trackingFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get('authorization');
      rest.push({ url, authorization });
      const response = await fetch(input, init);
      if (url.endsWith('/v1/pair/claim') && response.ok) pollToken = ((await response.clone().json()) as { pollToken: string }).pollToken;
      return response;
    };
    const client = new RelayClient({
      fetchImpl: trackingFetch,
      storage: {
        get: (k) => storage.get(k) ?? null,
        set: (k, v) => void storage.set(k, v),
        remove: (k) => void storage.delete(k)
      },
      wsFactory
    });
    const pairing = client.pair({ relayBase: `http://127.0.0.1:${port}`, code, deviceName: 'Test Browser' });

    // The desktop sees the request; the human approves while the browser polls.
    for (let i = 0; i < 40 && !host.state().pendingRequest; i++) await sleep(100);
    host.respondPairing('approve');
    const creds = await pairing;
    expect(creds.webToken).toBeTruthy();
    expect(client.hasCredentials()).toBe(true);
    expect(pollToken).toBeTruthy();
    expect(JSON.stringify([...storage])).not.toContain(pollToken);
    expect(rest.filter((entry) => entry.url.includes('/v1/pair/poll')).every((entry) => entry.authorization === `Bearer ${pollToken}`)).toBe(true);

    // A fresh client restores its pairing from storage.
    const shared = { get: (k: string) => storage.get(k) ?? null, set: (k: string, v: string) => void storage.set(k, v), remove: (k: string) => void storage.delete(k) };
    const inbound: string[] = [];
    let deliver: ((raw: string) => void) | undefined;
    let holdNext = false;
    let held: string | undefined;
    let socketUrlSafe = false;
    const restored = new RelayClient({ storage: shared, fetchImpl: trackingFetch, wsFactory: (url, onMessage, onClose) => {
      const parsed = new URL(url);
      socketUrlSafe = parsed.pathname === '/v1/ws/client' && parsed.searchParams.has('ticket') &&
        parsed.searchParams.get('ticket') !== creds.webToken && !parsed.searchParams.has('token') && !url.includes(creds.webToken);
      deliver = onMessage;
      return wsFactory(url, (raw) => {
      if ((JSON.parse(raw) as { t: string }).t === 'd') {
        inbound.push(raw);
        if (holdNext) {
          held = raw;
          holdNext = false;
          return;
        }
      }
      onMessage(raw);
      }, onClose);
    } });
    expect(restored.restore()).toBe(true);
    await sleep(400); // host reconnects under its new device token

    const pushes: Array<[string, unknown]> = [];
    await restored.connect();
    expect(socketUrlSafe).toBe(true);
    expect(rest.filter((entry) => entry.url.includes('/v1/ws/ticket'))).toHaveLength(1);
    expect(rest.find((entry) => entry.url.includes('/v1/ws/ticket'))?.authorization).toBe(`Bearer ${creds.webToken}`);
    restored.onPush((channel, payload) => void pushes.push([channel, payload]));

    // Read-only invoke through the e2e channel reaches the real registry.
    const list = (await restored.invoke('sessions:list', null)) as Array<{ id: string }>;
    expect(list[0].id).toBe('s1');
    expect(calls[0]).toBe('sessions:list');

    // Interactive P3: sending a prompt lands on the registry with the full input.
    await restored.invoke('sessions:send', { id: 's1', input: { text: 'hello agent' } });
    expect(calls).toContain('sessions:send:{"text":"hello agent"}');

    // Session creation: the folder comes from the host's known folders, no native dialog.
    const created = (await restored.invoke('sessions:create', { config: { harness: 'native', projectRoot: '/repo', permissionMode: 'ask' } })) as { id: string };
    expect(created.id).toBe('s2');

    // Disallowed channels are still refused without consulting the registry.
    await expect(restored.invoke('settings:update', { remote: { enabled: true } })).rejects.toThrow('channel not available remotely');
    expect(calls).not.toContain('settings:update');

    // Host pushes reach the browser, sealed, but captured ciphertext cannot be replayed.
    const beforePush = inbound.length;
    await host.broadcastPush('push:settingsChanged', { notifications: true });
    for (let i = 0; i < 40 && pushes.length < 1; i++) await sleep(25);
    expect(pushes).toEqual([['push:settingsChanged', { notifications: true }]]);
    const captured = inbound[beforePush];
    expect(captured).toBeDefined();
    deliver!(captured);
    deliver!(captured);

    // A later frame with a different salt (but unchanged GCM nonce and ciphertext)
    // must be refused, without consuming its counter or losing the real push.
    holdNext = true;
    await host.broadcastPush('push:settingsChanged', { notifications: false });
    for (let i = 0; i < 40 && !held; i++) await sleep(25);
    expect(held).toBeDefined();
    const altered = JSON.parse(held!) as { payload: { salt: string } };
    const salt = Buffer.from(altered.payload.salt, 'base64url');
    salt[15] ^= 1;
    altered.payload.salt = salt.toString('base64url');
    deliver!(JSON.stringify(altered));
    deliver!(held!);
    deliver!(captured); // stale after a newer accepted frame
    for (let i = 0; i < 40 && pushes.length < 2; i++) await sleep(25);
    await sleep(100); // let the independently scheduled pre-fix decryptions settle
    expect(pushes).toEqual([
      ['push:settingsChanged', { notifications: true }],
      ['push:settingsChanged', { notifications: false }]
    ]);

    restored.logout();
    expect(storage.has('vocs-web-credentials')).toBe(false);
    expect(rest.filter((entry) => entry.url.includes('/v1/devices') || entry.url.includes('/v1/mirror')).every((entry) => entry.authorization === `Bearer ${creds.webToken}`)).toBe(true);
    expect(rest.every((entry) => !entry.url.includes('token='))).toBe(true);
    await host.disable();
  });

  it('mints a fresh ticket for each attempt and never puts the device bearer in the socket URL', async () => {
    const relay = new FakeRelay();
    const port = await relay.start();
    try {
      const identity = await generateIdentity();
      const web = await registerWebDevice(relay.store, { accountId: 'a', name: 'browser', platform: 'test', pub: publicOf(identity) }, Date.now());
      const base = `http://127.0.0.1:${port}`;
      const storage = new Map<string, string>([['vocs-web-credentials', JSON.stringify({
        relayBase: base, webToken: web.webToken, webDeviceId: web.deviceId,
        hostDeviceId: 'h_test', hostPub: publicOf(identity), identity
      })]]);
      const urls: string[] = [];
      const requests: Array<{ url: string; header: string | null }> = [];
      const client = new RelayClient({
        storage: { get: (key) => storage.get(key) ?? null, set: (key, value) => void storage.set(key, value), remove: (key) => void storage.delete(key) },
        fetchImpl: async (input, init) => {
          requests.push({ url: String(input), header: new Headers(init?.headers).get('authorization') });
          return fetch(input, init);
        },
        wsFactory: (url) => { urls.push(url); throw new Error('socket withheld'); }
      });
      expect(client.restore()).toBe(true);
      await expect(client.connect()).rejects.toThrow('socket withheld');
      await expect(client.connect()).rejects.toThrow('socket withheld');
      expect(urls).toHaveLength(2);
      expect(new URL(urls[0]).searchParams.get('ticket') !== new URL(urls[1]).searchParams.get('ticket')).toBe(true);
      expect(urls.every((url) => new URL(url).pathname === '/v1/ws/client' && new URL(url).searchParams.has('ticket') && !url.includes(web.webToken) && !new URL(url).searchParams.has('token'))).toBe(true);
      expect(requests).toHaveLength(2);
      expect(requests.every((entry) => entry.url.endsWith(`/v1/ws/ticket?device=${web.deviceId}`) && entry.header === `Bearer ${web.webToken}`)).toBe(true);
      expect(JSON.stringify(await relay.store.list('ws-ticket:'))).not.toContain(web.webToken);
    } finally {
      await relay.stop();
    }
  });

  it('never sends a handshake on a socket closed while the hello is being prepared', async () => {
    const identity = await generateIdentity();
    const storage = new Map<string, string>([['vocs-web-credentials', JSON.stringify({
      relayBase: 'https://relay.test', webToken: 'paired-bearer', webDeviceId: 'w_browser',
      hostDeviceId: 'h_host', hostPub: publicOf(identity), identity
    })]]);
    const sent: string[] = [];
    const client = new RelayClient({
      storage: { get: (key) => storage.get(key) ?? null, set: (key, value) => void storage.set(key, value), remove: (key) => void storage.delete(key) },
      fetchImpl: async () => new Response(JSON.stringify({ ticket: 'a'.repeat(43) })),
      wsFactory: (_url, _onMessage, onClose) => ({
        send: (raw) => { sent.push((JSON.parse(raw) as { t: string }).t); onClose(); },
        close: () => undefined
      })
    });
    expect(client.restore()).toBe(true);
    await expect(client.connect()).rejects.toThrow('connection superseded');
    expect(sent).toEqual(['hello']);
  });

  it('enforces view-only mode, records the audit trail and revokes devices', async () => {
    // A dedicated relay so device ids from the first test do not leak into these assertions.
    const relay = new FakeRelay();
    const port = await relay.start();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vocs-remote-audit-'));
    const audit = new RemoteAudit({ dir, log: () => undefined });
    await audit.load();
    let viewOnly = false;
    const calls: string[] = [];
    const registry = {
      channels: () => ['sessions:list', 'sessions:send'],
      invoke: async (channel: string) => {
        calls.push(channel);
        if (channel === 'sessions:list') return [{ id: 's1', title: 'From the host' }];
        if (channel === 'sessions:send') return undefined;
        throw new Error('unknown');
      }
    } as unknown as HandlerRegistry;
    const host = new RemoteHost({
      registry: () => registry,
      secrets: { get: async () => undefined, set: async () => undefined },
      pushState: () => undefined,
      log: () => undefined,
      broadcast: () => undefined,
      audit,
      viewOnly: () => viewOnly
    });
    try {
      await host.enable(`http://127.0.0.1:${port}`, ENROLL);
      const { code } = await host.startPairing('Test PC');
      const storage = new Map<string, string>();
      const rest: Array<{ url: string; authorization: string | null }> = [];
      const client = new RelayClient({
        storage: { get: (k) => storage.get(k) ?? null, set: (k, v) => void storage.set(k, v), remove: (k) => void storage.delete(k) },
        fetchImpl: async (input, init) => {
          rest.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
          return fetch(input, init);
        },
        wsFactory
      });
      const pairing = client.pair({ relayBase: `http://127.0.0.1:${port}`, code, deviceName: 'Test Browser' });
      for (let i = 0; i < 40 && !host.state().pendingRequest; i++) await sleep(100);
      host.respondPairing('approve');
      const creds = await pairing;
      // Wait until the host has reconnected under the real device token it was just granted.
      for (let i = 0; i < 40 && host.state().status !== 'online'; i++) await sleep(100);

      viewOnly = true;
      await client.connect();

      // Reads pass; writes are refused at the host before the registry ever runs.
      expect(await client.invoke('sessions:list', null)).toEqual([{ id: 's1', title: 'From the host' }]);
      await expect(client.invoke('sessions:send', { id: 's1', input: { text: 'nope' } })).rejects.toThrow('view-only');
      expect(calls).not.toContain('sessions:send');

      // The policy is read live: flipping it off lets writes through without a reconnect.
      viewOnly = false;
      await client.invoke('sessions:send', { id: 's1', input: { text: 'hi' } });
      expect(calls).toContain('sessions:send');

      // Both sides may list the account's devices, and only public metadata crosses the wire.
      const hostDevices = await host.listDevices();
      expect(hostDevices.map((d) => d.kind).sort()).toEqual(['host', 'web']);
      expect(JSON.stringify(hostDevices)).not.toContain('tokenHash');
      const webDevices = await client.listDevices();
      expect(webDevices.map((d) => d.deviceId).sort()).toEqual(hostDevices.map((d) => d.deviceId).sort());
      // A relay refusal must not be reported as a successful revocation or an empty registry.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => String(input).includes('/v1/devices')
        ? Promise.resolve(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }))
        : originalFetch(input, init);
      try {
        await expect(host.revokeDevice(creds.webDeviceId)).rejects.toThrow('revoke failed: 403');
        await expect(host.listDevices()).rejects.toThrow('devices failed: 403');
        expect(audit.list().filter((entry) => entry.action === 'device-revoke')).toHaveLength(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect((await host.listDevices()).map((device) => device.deviceId).sort()).toEqual(hostDevices.map((device) => device.deviceId).sort());

      // The audit trail names the approval, the connection and the refused write.
      expect(audit.list().some((e) => e.action === 'pair-approve' && e.device === creds.webDeviceId)).toBe(true);
      expect(audit.list().some((e) => e.action === 'client-connect' && e.device === creds.webDeviceId)).toBe(true);
      expect(audit.list().some((e) => e.action === 'view-only-blocked' && e.detail === 'sessions:send')).toBe(true);

      // Offline mirror (P4): the host seals an index + snapshot, the relay stores ciphertext, and the
      // paired browser opens both with the key it received sealed at connect.
      for (let i = 0; i < 20 && !client.hasMirror(); i++) await sleep(50);
      expect(client.hasMirror()).toBe(true);
      const mirrorKey = host.mirrorSecret();
      expect(mirrorKey).toBeTruthy();
      const key = await importAesKey(mirrorKey!);
      await host.putMirror(
        'index',
        undefined,
        await sealBlob(key, { hostName: 'Test PC', updatedAt: 1, sessions: [{ id: 's1', title: 'Mirrored secret title', status: 'idle', harness: 'native', projectRoot: '/repo', updatedAt: 1 }] })
      );
      await host.putMirror('session', 's1', await sealBlob(key, { id: 's1', title: 'Mirrored secret title', status: 'idle', harness: 'native', updatedAt: 1, items: [{ kind: 'user', text: 'mirrored body' }] }));

      const index = await client.mirrorIndex();
      expect(index?.hostName).toBe('Test PC');
      expect(index?.sessions[0].title).toBe('Mirrored secret title');
      expect((await client.mirrorSession('s1'))?.items).toEqual([{ kind: 'user', text: 'mirrored body' }]);

      // The relay holds opaque bytes: neither the transcript nor the key is in its store.
      const storedMirror = JSON.stringify(await relay.store.list('mirror:a:'));
      expect(storedMirror).not.toContain('Mirrored secret title');
      expect(storedMirror).not.toContain('mirrored body');
      expect(storedMirror).not.toContain(mirrorKey);

      await host.clearMirror();
      expect(await client.mirrorIndex()).toBeNull();

      // Revoking the browser from the desktop drops its route and kills its token.
      await host.revokeDevice(creds.webDeviceId);
      await sleep(200);
      expect(host.state().onlineClients).not.toContain(creds.webDeviceId);
      await expect(client.listDevices()).rejects.toThrow();
      expect(audit.list().some((e) => e.action === 'device-revoke' && e.device === creds.webDeviceId)).toBe(true);
      const protectedRest = rest.filter((entry) => entry.url.includes('/v1/devices') || entry.url.includes('/v1/mirror'));
      expect(protectedRest.length).toBeGreaterThan(3);
      expect(protectedRest.every((entry) => entry.authorization === `Bearer ${creds.webToken}`)).toBe(true);
      expect(rest.every((entry) => !entry.url.includes('token='))).toBe(true);
    } finally {
      await host.disable();
      await relay.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});