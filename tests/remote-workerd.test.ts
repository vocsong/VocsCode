/** The remote-access flow end to end against the REAL relay Worker running locally in workerd —
 *  Worker entry and edge limits, Hub Durable Object with hibernatable sockets, real TCP
 *  WebSockets — driven by a real RemoteHost and RelayClient. Runs on every `npm test`; no account
 *  or network needed. The in-memory test relay shares the relay's route and routing code, but only
 *  this suite exercises the runtime itself: it is what found a refused request's unread body
 *  ending a `wrangler dev` session and a revocation answering 500 in production code. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { memoryVault, RelayClient } from '../relay/src/web-client';
import { ACCOUNT_ASSERTION_HEADER, createAccountAssertion, INTERNAL_ACCOUNT_AUTH_HEADER, INTERNAL_ACCOUNT_ID_HEADER } from '../relay/src/account';
import { RemoteHost } from '../src/main/remote/host';
import type { HandlerRegistry } from '../src/main/handlers';
import { sign, tokenProofPayload } from '../src/shared/crypto';
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
  await remoteSmoke({ origin: relay.origin, enrollToken: relay.enrollToken, accountId: 'vocs-v1', accountAssertionSecret: relay.accountAssertionSecret, revealErrors: true });
}, 120_000);

it('adds a desktop through a signed-in owner and pairs that browser on Allow, through the real Worker', async () => {
  const origin = relay.origin;
  const ownerAccount = 'github:424242';
  // The landing signs every signed-in /v1 request and replaces Authorization only for owner routes.
  const asOwner: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    if (url.pathname.startsWith('/v1/')) {
      headers.set(ACCOUNT_ASSERTION_HEADER, await createAccountAssertion(ownerAccount, init.method ?? 'GET', url.pathname, relay.accountAssertionSecret));
    }
    if (url.pathname.startsWith('/v1/owner/')) headers.set('authorization', `Bearer ${relay.enrollToken}`);
    return fetch(input, { ...init, headers });
  };
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
    expect((await fetch(`${origin}/v1/owner/hosts`)).status).toBe(401);
  } finally {
    await browser.logout().catch(() => undefined);
    await desktop.disable();
  }
}, 60_000);

it('isolates two GitHub accounts across enrollment, owner lists, pairing claims and device registries', async () => {
  const origin = relay.origin;
  const makeOwnerFetch = (accountId: string): typeof fetch => async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    if (url.pathname.startsWith('/v1/')) {
      headers.set(ACCOUNT_ASSERTION_HEADER, await createAccountAssertion(accountId, init.method ?? 'GET', url.pathname, relay.accountAssertionSecret));
    }
    if (url.pathname.startsWith('/v1/owner/')) headers.set('authorization', `Bearer ${relay.enrollToken}`);
    return fetch(input, { ...init, headers });
  };
  const wsFactory = (url: string, onMessage: (raw: string) => void, onClose: () => void) => {
    const ws = new WebSocket(url);
    const queue: string[] = [];
    ws.on('open', () => { for (const raw of queue.splice(0)) ws.send(raw); });
    ws.on('message', (data) => onMessage(String(data)));
    ws.on('close', () => onClose());
    ws.on('error', () => undefined);
    return { send: (raw: string) => (ws.readyState === WebSocket.OPEN ? ws.send(raw) : void queue.push(raw)), close: () => ws.close() };
  };
  const until = async (check: () => boolean, what: string) => {
    const deadline = Date.now() + 20_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const createAccount = async (accountId: string, name: string) => {
    const secrets = new Map<string, string>();
    const host = new RemoteHost({
      registry: () => ({ channels: () => ['sessions:list'], invoke: async () => [{ id: name, title: `${name} session` }] } as unknown as HandlerRegistry),
      secrets: { get: async (key) => secrets.get(key), set: async (key, value) => void secrets.set(key, value) },
      pushState: () => undefined,
      log: () => undefined,
      broadcast: () => undefined
    });
    const browser = new RelayClient({ vault: memoryVault(), wsFactory, fetchImpl: makeOwnerFetch(accountId) });
    let link = '';
    await host.signIn(origin, async (url) => void (link = url), `${name} PC`);
    const nonceHash = new URL(link).searchParams.get('connect');
    expect(nonceHash).toMatch(/^[0-9a-f]{64}$/);
    await browser.addComputer(origin, nonceHash!);
    await until(() => host.state().status === 'online', `${name} to enroll and connect`);
    const added = await browser.addedComputer(origin, nonceHash!);
    expect(added.status).toBe('redeemed');
    return { host, browser, hostId: added.hostDeviceId! };
  };
  const a = await createAccount('github:710001', 'Account A');
  const b = await createAccount('github:710002', 'Account B');
  try {
    expect((await a.browser.ownerHosts(origin)).map((entry) => entry.deviceId)).toEqual([a.hostId]);
    expect((await b.browser.ownerHosts(origin)).map((entry) => entry.deviceId)).toEqual([b.hostId]);

    const pairA = a.browser.pairWithHost({ relayBase: origin, hostDeviceId: a.hostId, deviceName: 'A browser' });
    await until(() => a.host.state().pendingRequest?.name === 'A browser', 'Account A desktop pairing request');
    await a.host.respondPairing('approve');
    await pairA;
    await a.browser.connect();

    const pairB = b.browser.pairWithHost({ relayBase: origin, hostDeviceId: b.hostId, deviceName: 'B browser' });
    await until(() => b.host.state().pendingRequest?.name === 'B browser', 'Account B desktop pairing request');
    await b.host.respondPairing('approve');
    await pairB;
    await b.browser.connect();

    expect((await a.browser.ownerHosts(origin)).map((entry) => entry.deviceId)).toEqual([a.hostId]);
    expect((await b.browser.ownerHosts(origin)).map((entry) => entry.deviceId)).toEqual([b.hostId]);
    expect((await a.browser.listDevices()).map((device) => device.deviceId).sort()).toEqual([a.hostId, a.browser.credentials()!.webDeviceId].sort());
    expect((await b.browser.listDevices()).map((device) => device.deviceId).sort()).toEqual([b.hostId, b.browser.credentials()!.webDeviceId].sort());

    const accessFor = async (credentials: NonNullable<ReturnType<RelayClient['credentials']>>) => {
      const query = `?device=${encodeURIComponent(credentials.webDeviceId)}`;
      const challengeResponse = await fetch(`${origin}/v1/token/challenge${query}`, { method: 'POST', headers: { authorization: `Bearer ${credentials.webToken}` } });
      expect(challengeResponse.status).toBe(200);
      const { challenge } = await challengeResponse.json() as { challenge: string };
      const tokenResponse = await fetch(`${origin}/v1/token${query}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credentials.webToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ challenge, signature: await sign(credentials.identity, tokenProofPayload(credentials.webDeviceId, challenge)) })
      });
      expect(tokenResponse.status).toBe(200);
      return (await tokenResponse.json() as { accessToken: string }).accessToken;
    };
    const aCredentials = a.browser.credentials()!;
    const bCredentials = b.browser.credentials()!;
    const aAccess = await accessFor(aCredentials);
    const bAccess = await accessFor(bCredentials);
    const matchingAccount = await fetch(`${origin}/v1/devices?device=${encodeURIComponent(aCredentials.webDeviceId)}`, {
      headers: {
        authorization: `Bearer ${aAccess}`,
        [ACCOUNT_ASSERTION_HEADER]: await createAccountAssertion('github:710001', 'GET', '/v1/devices', relay.accountAssertionSecret),
        [INTERNAL_ACCOUNT_ID_HEADER]: 'github:710002',
        [INTERNAL_ACCOUNT_AUTH_HEADER]: '1'
      }
    });
    expect(matchingAccount.status).toBe(200); // caller-supplied internal routing headers are stripped
    const mismatchedAccount = await fetch(`${origin}/v1/devices?device=${encodeURIComponent(bCredentials.webDeviceId)}`, {
      headers: {
        authorization: `Bearer ${bAccess}`,
        [ACCOUNT_ASSERTION_HEADER]: await createAccountAssertion('github:710001', 'GET', '/v1/devices', relay.accountAssertionSecret)
      }
    });
    expect(mismatchedAccount.status).toBe(403);

    // A signed-in account cannot ask another account's desktop to pair its browser.
    await expect(b.browser.pairWithHost({ relayBase: origin, hostDeviceId: a.hostId, deviceName: 'Cross-account' })).rejects.toThrow();
    expect(a.host.state().pendingRequest).toBeUndefined();
    expect(b.host.state().pendingRequest).toBeUndefined();

    // A's pairing code is stored only in A's Hub and cannot be claimed from B's session.
    const aCode = await a.host.startPairing('Account A PC');
    await expect(b.browser.pair({ relayBase: origin, code: aCode.code, deviceName: 'Wrong account' })).rejects.toThrow('claim failed: 401');
    expect(a.host.state().pendingRequest).toBeUndefined();
  } finally {
    await a.browser.revokeDevice(a.hostId).catch(() => undefined);
    await b.browser.revokeDevice(b.hostId).catch(() => undefined);
    await a.browser.logout().catch(() => undefined);
    await b.browser.logout().catch(() => undefined);
    await a.host.disable();
    await b.host.disable();
  }
}, 120_000);
