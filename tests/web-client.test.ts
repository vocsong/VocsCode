/** Integration test for the relay web client (relay/src/web-client.ts): pairing from the
 *  browser side, e2e handshake, filtered invokes and push reception — the same full loop
 *  as remote-e2e.test.ts but driven entirely through RelayClient's public API. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { RelayClient } from '../relay/src/web-client';
import { ENROLL, FakeRelay } from './fake-relay';
import { RemoteHost } from '../src/main/remote/host';
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
      channels: () => ['sessions:list'],
      invoke: async (channel: string) => {
        calls.push(channel);
        if (channel === 'sessions:list') return [{ id: 's1', title: 'From the host' }];
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
    expect(calls).toEqual(['sessions:list']);

    // Host pushes reach the browser, sealed.
    await host.broadcastPush('push:settingsChanged', { notifications: true });
    await sleep(200);
    expect(pushes).toContainEqual(['push:settingsChanged', { notifications: true }]);

    restored.logout();
    expect(storage.has('vocs-web-credentials')).toBe(false);
    await host.disable();
  });
});