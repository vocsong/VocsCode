/** Integration test for the relay web client (relay/src/web-client.ts): pairing from the
 *  browser side, e2e handshake, filtered invokes and push reception — the same full loop
 *  as remote-e2e.test.ts but driven entirely through RelayClient's public API. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { RelayClient } from '../relay/src/web-client';
import { ENROLL, FakeRelay } from './fake-relay';
import { RemoteHost } from '../src/main/remote/host';
import { RemoteAudit } from '../src/main/remote/audit';
import type { HandlerRegistry } from '../src/main/handlers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    // Browser semantics: sends issued while CONNECTING are queued by the spec.
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

  it('pairs via the browser flow, handshakes and serves read-only invokes', async () => {
    // Desktop side (as in remote-e2e.test.ts).
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
    const client = new RelayClient({
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

    // A fresh client restores its pairing from storage.
    const shared = { get: (k: string) => storage.get(k) ?? null, set: (k: string, v: string) => void storage.set(k, v), remove: (k: string) => void storage.delete(k) };
    const restored = new RelayClient({ storage: shared, wsFactory });
    expect(restored.restore()).toBe(true);
    await sleep(400); // host reconnects under its new device token

    const pushes: Array<[string, unknown]> = [];
    await restored.connect();
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

    // Host pushes reach the browser, sealed.
    await host.broadcastPush('push:settingsChanged', { notifications: true });
    await sleep(200);
    expect(pushes).toContainEqual(['push:settingsChanged', { notifications: true }]);

    restored.logout();
    expect(storage.has('vocs-web-credentials')).toBe(false);
    await host.disable();
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
      const client = new RelayClient({
        storage: { get: (k) => storage.get(k) ?? null, set: (k, v) => void storage.set(k, v), remove: (k) => void storage.delete(k) },
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

      // The audit trail names the approval, the connection and the refused write.
      expect(audit.list().some((e) => e.action === 'pair-approve' && e.device === creds.webDeviceId)).toBe(true);
      expect(audit.list().some((e) => e.action === 'client-connect' && e.device === creds.webDeviceId)).toBe(true);
      expect(audit.list().some((e) => e.action === 'view-only-blocked' && e.detail === 'sessions:send')).toBe(true);

      // Revoking the browser from the desktop drops its route and kills its token.
      await host.revokeDevice(creds.webDeviceId);
      await sleep(200);
      expect(host.state().onlineClients).not.toContain(creds.webDeviceId);
      await expect(client.listDevices()).rejects.toThrow();
      expect(audit.list().some((e) => e.action === 'device-revoke' && e.device === creds.webDeviceId)).toBe(true);
    } finally {
      await host.disable();
      await relay.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});