/** The remote-access flow end to end against the REAL relay Worker running locally in workerd —
 *  Worker entry and edge limits, Hub Durable Object with hibernatable sockets, real TCP
 *  WebSockets — driven by a real RemoteHost and RelayClient. Runs on every `npm test`; no account
 *  or network needed. The in-memory test relay shares the relay's route and routing code, but only
 *  this suite exercises the runtime itself: it is what found a refused request's unread body
 *  ending a `wrangler dev` session and a revocation answering 500 in production code. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { memoryVault, RelayClient } from '../relay/src/web-client';
import { RemoteHost } from '../src/main/remote/host';
import type { HandlerRegistry } from '../src/main/handlers';
import { startLocalRelay, type LocalRelay } from './support/local-relay';
import { remoteSmoke } from './support/remote-smoke';

let relay: LocalRelay;

beforeAll(async () => {
  relay = await startLocalRelay();
}, 60_000);

afterAll(async () => {
  await relay?.stop();
});

it('pairs, handshakes, invokes, shares the mirror key and revokes through the real Worker in workerd', async () => {
  await remoteSmoke({ origin: relay.origin, enrollToken: relay.enrollToken, revealErrors: true });
}, 120_000);

it('adds a desktop through a signed-in owner and pairs that browser on Allow, through the real Worker', async () => {
  const origin = relay.origin;
  // The landing's part for a signed-in, allowlisted session: owner requests carry the relay's
  // enrollment secret; every other request goes through untouched.
  const asOwner: typeof fetch = (input, init = {}) =>
    new URL(String(input)).pathname.startsWith('/v1/owner/')
      ? fetch(input, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${relay.enrollToken}` } })
      : fetch(input, init);
  const until = async (check: () => boolean, what: string) => {
    const deadline = Date.now() + 20_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const wsFactory = (url: string, onMessage: (raw: string) => void, onClose: () => void) => {
    const ws = new WebSocket(url);
    const queue: string[] = [];
    ws.on('open', () => {
      for (const raw of queue.splice(0)) ws.send(raw);
    });
    ws.on('message', (data) => onMessage(String(data)));
    ws.on('close', () => onClose());
    ws.on('error', () => undefined);
    return { send: (raw: string) => (ws.readyState === WebSocket.OPEN ? ws.send(raw) : void queue.push(raw)), close: () => ws.close() };
  };
  const secrets = new Map<string, string>();
  const desktop = new RemoteHost({
    registry: () => ({ channels: () => ['sessions:list'], invoke: async () => [{ id: 'w1', title: 'workerd host' }] } as unknown as HandlerRegistry),
    secrets: { get: async (key) => secrets.get(key), set: async (key, value) => void secrets.set(key, value) },
    pushState: () => undefined,
    log: () => undefined,
    broadcast: () => undefined
  });
  const browser = new RelayClient({ vault: memoryVault(), wsFactory, fetchImpl: asOwner });
  try {
    let link = '';
    await desktop.signIn(origin, async (url) => void (link = url));
    const connect = new URL(link).searchParams.get('connect')!;
    expect(connect).toMatch(/^[0-9a-f]{64}$/);
    await browser.addComputer(origin, connect);
    await until(() => desktop.state().status === 'online', 'the desktop to register and come online');
    const added = await browser.addedComputer(origin, connect);
    expect(added).toMatchObject({ status: 'redeemed', hostDeviceId: expect.stringMatching(/^h_/) });
    expect(await browser.ownerHosts(origin)).toContainEqual(expect.objectContaining({ deviceId: added.hostDeviceId, online: true }));

    const pairing = browser.pairWithHost({ relayBase: origin, hostDeviceId: added.hostDeviceId!, deviceName: 'workerd phone' });
    await until(() => desktop.state().pendingRequest?.name === 'workerd phone', 'the request on the desktop');
    await desktop.respondPairing('approve');
    await pairing;
    await browser.connect();
    expect(await browser.invoke('sessions:list', null)).toEqual([{ id: 'w1', title: 'workerd host' }]);
    // Without the landing's credential the owner routes stay shut, on the real Worker too.
    expect((await fetch(`${origin}/v1/owner/hosts`)).status).toBe(403);
  } finally {
    await browser.logout().catch(() => undefined);
    await desktop.disable();
  }
}, 60_000);
