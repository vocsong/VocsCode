/** Integration test for the relay web client (relay/src/web-client.ts): pairing from the
 *  browser side, e2e handshake, filtered invokes and push reception — the same full loop
 *  as remote-e2e.test.ts but driven entirely through RelayClient's public API. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { LEGACY_CREDENTIALS_KEY, memoryVault, PairingRevokedError, RelayClient, relayBaseFor } from '../relay/src/web-client';
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
    const vault = memoryVault();
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
    const client = new RelayClient({ fetchImpl: trackingFetch, vault, wsFactory });
    const pairing = client.pair({ relayBase: `http://127.0.0.1:${port}`, code, deviceName: 'Test Browser' });

    // The desktop sees the request; the human approves while the browser polls.
    for (let i = 0; i < 40 && !host.state().pendingRequest; i++) await sleep(100);
    host.respondPairing('approve');
    const creds = await pairing;
    expect(creds.webToken).toBeTruthy();
    expect(client.hasCredentials()).toBe(true);
    expect(pollToken).toBeTruthy();
    expect(JSON.stringify(vault.peek())).not.toContain(pollToken);
    // The stored identity is a non-extractable key: page script can sign with it, never read it.
    const stored = vault.peek()!.pairings[0];
    expect(stored.identity.sig.priv).toBeInstanceOf(CryptoKey);
    expect((stored.identity.sig.priv as CryptoKey).extractable).toBe(false);
    expect((stored.identity.enc.priv as CryptoKey).extractable).toBe(false);
    expect(stored.hostName).toBe('Test PC');
    expect(rest.filter((entry) => entry.url.includes('/v1/pair/poll')).every((entry) => entry.authorization === `Bearer ${pollToken}`)).toBe(true);

    // A fresh client restores its pairing from the vault.
    const inbound: string[] = [];
    let deliver: ((raw: string) => void) | undefined;
    let socket: ReturnType<typeof wsFactory> | undefined;
    let holdNext = false;
    let held: string | undefined;
    let socketUrlSafe = false;
    const restored = new RelayClient({ vault, fetchImpl: trackingFetch, wsFactory: (url, onMessage, onClose) => {
      const parsed = new URL(url);
      socketUrlSafe = parsed.pathname === '/v1/ws/client' && parsed.searchParams.has('ticket') &&
        parsed.searchParams.get('ticket') !== creds.webToken && !parsed.searchParams.has('token') && !url.includes(creds.webToken);
      deliver = onMessage;
      socket = wsFactory(url, (raw) => {
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
      return socket;
    } });
    expect(await restored.restore()).toBe(true);
    await sleep(400); // host reconnects under its new device token

    const pushes: Array<[string, unknown]> = [];
    await restored.connect();
    expect(socketUrlSafe).toBe(true);
    expect(rest.filter((entry) => entry.url.includes('/v1/ws/ticket'))).toHaveLength(1);
    // The ticket is bought with a short-lived access token, never the stored refresh credential.
    const ticketAuth = rest.find((entry) => entry.url.includes('/v1/ws/ticket'))?.authorization;
    expect(ticketAuth).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
    expect(ticketAuth).not.toBe(`Bearer ${creds.webToken}`);
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

    // A dropped socket fails in-flight invokes immediately, instead of each waiting out 30 s.
    const pending = restored.invoke('sessions:list', null);
    socket!.close();
    await expect(pending).rejects.toThrow('connection lost');

    await restored.logout();
    expect(vault.peek()).toBeNull();
    // The refresh credential is presented to the token endpoints and nowhere else.
    expect(rest.filter((entry) => entry.authorization === `Bearer ${creds.webToken}`).every((entry) => /\/v1\/token(\/challenge)?\?/.test(entry.url))).toBe(true);
    expect(rest.every((entry) => !entry.url.includes('token='))).toBe(true);
    await host.disable();
  });

  it('keeps the first browser routable after the same desktop pairs a second one', async () => {
    // The Hub routes a browser's frames to the host id it greeted. Minting a new host device per
    // pairing re-keyed the desktop and silently stranded every browser paired before it.
    const relay = new FakeRelay();
    const port = await relay.start();
    const base = `http://127.0.0.1:${port}`;
    const host = new RemoteHost({
      registry: () => ({ channels: () => ['sessions:list'], invoke: async () => [{ id: 's1', title: 'Shared host' }] } as unknown as HandlerRegistry),
      secrets: { get: async () => undefined, set: async () => undefined },
      pushState: () => undefined,
      log: () => undefined,
      broadcast: () => undefined
    });
    const browser = () => new RelayClient({ vault: memoryVault(), wsFactory });
    const pairOne = async (client: RelayClient, name: string) => {
      const { code } = await host.startPairing('Shared PC');
      const pairing = client.pair({ relayBase: base, code, deviceName: name });
      for (let i = 0; i < 40 && host.state().pendingRequest?.code !== code; i++) await sleep(50);
      await host.respondPairing('approve');
      const creds = await pairing;
      for (let i = 0; i < 40 && host.state().status !== 'online'; i++) await sleep(50);
      return creds;
    };
    try {
      await host.enable(base, ENROLL);
      const first = browser();
      const second = browser();
      const firstCreds = await pairOne(first, 'First browser');
      const secondCreds = await pairOne(second, 'Second browser');
      expect(secondCreds.hostDeviceId).toBe(firstCreds.hostDeviceId);
      expect((await host.listDevices()).filter((d) => d.kind === 'host')).toHaveLength(1);

      await first.connect();
      expect(await first.invoke('sessions:list', null)).toEqual([{ id: 's1', title: 'Shared host' }]);
      await second.connect();
      expect(await second.invoke('sessions:list', null)).toEqual([{ id: 's1', title: 'Shared host' }]);
      expect(host.state().onlineClients.sort()).toEqual([firstCreds.webDeviceId, secondCreds.webDeviceId].sort());
      await first.logout();
      await second.logout();
    } finally {
      await host.disable();
      await relay.stop();
    }
  });

  describe('several computers from one browser', () => {
    const hosts: RemoteHost[] = [];
    const relays: FakeRelay[] = [];
    afterEach(async () => {
      for (const h of hosts.splice(0)) await h.disable();
      for (const r of relays.splice(0)) await r.stop();
    });

    async function setup() {
      const relay = new FakeRelay();
      relays.push(relay);
      const base = `http://127.0.0.1:${await relay.start()}`;
      const makeHost = async (sessionTitle: string) => {
        const secrets = new Map<string, string>();
        const host = new RemoteHost({
          registry: () => ({ channels: () => ['sessions:list'], invoke: async () => [{ id: 's', title: sessionTitle }] } as unknown as HandlerRegistry),
          secrets: { get: async (k) => secrets.get(k), set: async (k, v) => void secrets.set(k, v) },
          pushState: () => undefined,
          log: () => undefined,
          broadcast: () => undefined
        });
        hosts.push(host);
        await host.enable(base, ENROLL);
        return host;
      };
      const pairWith = async (client: RelayClient, host: RemoteHost, hostName: string) => {
        const { code } = await host.startPairing(hostName);
        const pairing = client.pair({ relayBase: base, code, deviceName: 'Phone' });
        for (let i = 0; i < 80 && host.state().pendingRequest?.code !== code; i++) await sleep(25);
        await host.respondPairing('approve');
        const creds = await pairing;
        for (let i = 0; i < 80 && host.state().status !== 'online'; i++) await sleep(25);
        return creds;
      };
      return { relay, base, makeHost, pairWith };
    }

    it('keeps a pairing per computer, switches between them, and unpairs one without the other', async () => {
      const { makeHost, pairWith } = await setup();
      const work = await makeHost('Work sessions');
      const home = await makeHost('Home sessions');
      const vault = memoryVault();
      const client = new RelayClient({ vault, wsFactory });
      const workCreds = await pairWith(client, work, 'Work PC');
      const homeCreds = await pairWith(client, home, 'Home PC');
      expect(client.pairings().map((p) => p.hostName)).toEqual(['Work PC', 'Home PC']);
      expect(workCreds.webDeviceId).not.toBe(homeCreds.webDeviceId);
      // The newest pairing is active; each computer is reached through its own pairing.
      expect(client.credentials()?.hostDeviceId).toBe(homeCreds.hostDeviceId);
      await client.connect();
      expect(await client.invoke('sessions:list', null)).toEqual([{ id: 's', title: 'Home sessions' }]);
      await client.select(workCreds.hostDeviceId);
      await client.connect();
      expect(await client.invoke('sessions:list', null)).toEqual([{ id: 's', title: 'Work sessions' }]);
      // The switcher's online state comes from the relay's live sockets.
      const presence = Object.fromEntries((await client.listDevices()).filter((d) => d.kind === 'host').map((d) => [d.deviceId, d.online]));
      expect(presence).toEqual({ [workCreds.hostDeviceId]: true, [homeCreds.hostDeviceId]: true });

      // A reloaded page gets both pairings back and the one it last used.
      const reopened = new RelayClient({ vault, wsFactory });
      expect(await reopened.restore()).toBe(true);
      expect(reopened.pairings()).toHaveLength(2);
      expect(reopened.credentials()?.hostDeviceId).toBe(workCreds.hostDeviceId);

      // Unpair revokes this browser's device for the active computer at the relay, and only it.
      await client.unpair();
      expect(client.pairings().map((p) => p.hostName)).toEqual(['Home PC']);
      const registry = (await home.listDevices()).map((d) => d.deviceId);
      expect(registry).not.toContain(workCreds.webDeviceId);
      expect(registry).toContain(homeCreds.webDeviceId);
      await client.connect();
      expect(await client.invoke('sessions:list', null)).toEqual([{ id: 's', title: 'Home sessions' }]);
      await client.logout();
    });

    it('forgets a pairing the relay revoked and names the computer it was for', async () => {
      const { makeHost, pairWith } = await setup();
      const host = await makeHost('Sessions');
      const vault = memoryVault();
      const client = new RelayClient({ vault, wsFactory });
      const creds = await pairWith(client, host, 'Studio PC');
      await host.revokeDevice(creds.webDeviceId);
      const failure = await client.connect().then(() => null, (e: unknown) => e);
      expect(failure).toBeInstanceOf(PairingRevokedError);
      expect((failure as PairingRevokedError).hostName).toBe('Studio PC');
      expect(client.pairings()).toEqual([]);
      expect(vault.peek()?.pairings).toEqual([]);
    });

    it('re-pairing the same computer replaces the old pairing and revokes its device', async () => {
      const { makeHost, pairWith } = await setup();
      const host = await makeHost('Sessions');
      const client = new RelayClient({ vault: memoryVault(), wsFactory });
      const first = await pairWith(client, host, 'Desk PC');
      const second = await pairWith(client, host, 'Desk PC');
      expect(client.pairings()).toHaveLength(1);
      expect(client.credentials()?.webDeviceId).toBe(second.webDeviceId);
      const registry = (await host.listDevices()).map((d) => d.deviceId);
      expect(registry).not.toContain(first.webDeviceId);
      expect(registry).toContain(second.webDeviceId);
      await client.logout();
    });
  });

  it('mints a fresh ticket for each attempt and never puts the device bearer in the socket URL', async () => {
    const relay = new FakeRelay();
    const port = await relay.start();
    try {
      const identity = await generateIdentity();
      const web = await registerWebDevice(relay.store, { accountId: 'a', name: 'browser', platform: 'test', pub: publicOf(identity) }, Date.now());
      const base = `http://127.0.0.1:${port}`;
      // Stored by the pre-vault page: exportable JWKs in localStorage, migrated on restore.
      const storage = new Map<string, string>([[LEGACY_CREDENTIALS_KEY, JSON.stringify({
        relayBase: base, webToken: web.webToken, webDeviceId: web.deviceId,
        hostDeviceId: 'h_test', hostPub: publicOf(identity), identity
      })]]);
      const vault = memoryVault();
      const urls: string[] = [];
      const requests: Array<{ url: string; header: string | null }> = [];
      const client = new RelayClient({
        vault,
        legacy: { get: (key) => storage.get(key) ?? null, set: (key, value) => void storage.set(key, value), remove: (key) => void storage.delete(key) },
        fetchImpl: async (input, init) => {
          requests.push({ url: String(input), header: new Headers(init?.headers).get('authorization') });
          return fetch(input, init);
        },
        wsFactory: (url) => { urls.push(url); throw new Error('socket withheld'); }
      });
      expect(await client.restore()).toBe(true);
      // Migrated once: the exportable copy is gone and the keys are non-extractable now.
      expect(storage.has(LEGACY_CREDENTIALS_KEY)).toBe(false);
      expect((vault.peek()!.pairings[0].identity.sig.priv as CryptoKey).extractable).toBe(false);
      await expect(client.connect()).rejects.toThrow('socket withheld');
      await expect(client.connect()).rejects.toThrow('socket withheld');
      expect(urls).toHaveLength(2);
      expect(new URL(urls[0]).searchParams.get('ticket') !== new URL(urls[1]).searchParams.get('ticket')).toBe(true);
      expect(urls.every((url) => new URL(url).pathname === '/v1/ws/client' && new URL(url).searchParams.has('ticket') && !url.includes(web.webToken) && !new URL(url).searchParams.has('token'))).toBe(true);
      const tickets = requests.filter((entry) => entry.url.includes('/v1/ws/ticket'));
      expect(tickets).toHaveLength(2);
      // One proof of possession serves both attempts: the access token is cached until expiry.
      expect(requests.filter((entry) => entry.url.includes('/v1/token?'))).toHaveLength(1);
      expect(tickets.every((entry) => entry.url.endsWith(`/v1/ws/ticket?device=${web.deviceId}`) && entry.header !== `Bearer ${web.webToken}` && entry.header === tickets[0].header)).toBe(true);
      expect(JSON.stringify(await relay.store.list('ws-ticket:'))).not.toContain(web.webToken);
    } finally {
      await relay.stop();
    }
  });

  it('does not import or delete the incumbent browser pairing in another account vault', async () => {
    const identity = await generateIdentity();
    const storage = new Map<string, string>([[LEGACY_CREDENTIALS_KEY, JSON.stringify({
      relayBase: 'https://relay.test', webToken: 'incumbent-only', webDeviceId: 'w_owner',
      hostDeviceId: 'h_owner', hostPub: publicOf(identity), identity
    })]]);
    const client = new RelayClient({
      vault: memoryVault(),
      allowLegacyMigration: false,
      legacy: { get: (key) => storage.get(key) ?? null, set: (key, value) => void storage.set(key, value), remove: (key) => void storage.delete(key) }
    });
    expect(await client.restore()).toBe(false);
    expect(client.pairings()).toEqual([]);
    await client.logout();
    expect(storage.get(LEGACY_CREDENTIALS_KEY)).toContain('incumbent-only');
  });

  it('never sends a handshake on a socket closed while the hello is being prepared', async () => {
    const identity = await generateIdentity();
    const storage = new Map<string, string>([[LEGACY_CREDENTIALS_KEY, JSON.stringify({
      relayBase: 'https://relay.test', webToken: 'paired-bearer', webDeviceId: 'w_browser',
      hostDeviceId: 'h_host', hostPub: publicOf(identity), identity
    })]]);
    const sent: string[] = [];
    const client = new RelayClient({
      vault: memoryVault(),
      legacy: { get: (key) => storage.get(key) ?? null, set: (key, value) => void storage.set(key, value), remove: (key) => void storage.delete(key) },
      fetchImpl: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/token/challenge') return new Response(JSON.stringify({ challenge: 'c'.repeat(43), expiresAt: Date.now() + 60_000 }));
        if (path === '/v1/token') return new Response(JSON.stringify({ accessToken: 'b'.repeat(43), expiresAt: Date.now() + 3_600_000 }));
        return new Response(JSON.stringify({ ticket: 'a'.repeat(43) }));
      },
      wsFactory: (_url, _onMessage, onClose) => ({
        send: (raw) => { sent.push((JSON.parse(raw) as { t: string }).t); onClose(); },
        close: () => undefined
      })
    });
    expect(await client.restore()).toBe(true);
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
      const rest: Array<{ url: string; authorization: string | null }> = [];
      const client = new RelayClient({
        vault: memoryVault(),
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
      expect(protectedRest.every((entry) => /^Bearer [A-Za-z0-9_-]{43}$/.test(entry.authorization ?? '') && entry.authorization !== `Bearer ${creds.webToken}`)).toBe(true);
      expect(rest.every((entry) => !entry.url.includes('token='))).toBe(true);
    } finally {
      await host.disable();
      await relay.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});