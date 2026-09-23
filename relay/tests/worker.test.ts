import { env } from 'cloudflare:workers';
import { abortAllDurableObjects, evictDurableObject, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../src/core';
import { generateIdentity, openSealedToKey, pairingDecisionPayload, pairingTokenContext, publicOf, sign, tokenProofPayload, type Identity, type SealedToKey } from '../../src/shared/crypto';
import type { Env as RelayEnv } from '../src/worker';

// This file runs in workerd, with the production Wrangler DO binding and a test-only token.
declare global {
  namespace Cloudflare {
    interface Env extends RelayEnv {}
  }
}

const sockets = new Set<WebSocket>();
const hub = () => env.HUB.get(env.HUB.idFromName(env.RELAY_ACCOUNT));

/** Each test is its own caller: edge rate-limit counters, unlike the Hub's in-memory ones, outlive
 *  the Durable Object between tests. */
let callerIp = '203.0.113.1';
let callers = 0;
beforeEach(() => {
  callerIp = `203.0.113.${(++callers % 250) + 1}`;
});

async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', callerIp);
  return SELF.fetch(new Request(`https://relay.test${path}`, { ...init, headers }));
}

function message(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error('no WebSocket message received'));
    }, 2500);
    function onMessage(event: MessageEvent): void {
      clearTimeout(timeout);
      ws.removeEventListener('message', onMessage);
      resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
    }
    ws.addEventListener('message', onMessage);
  });
}

async function ticketFor(device: string, token: string): Promise<string> {
  const response = await request(`/v1/ws/ticket?device=${encodeURIComponent(device)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json<{ ticket: string; expiresAt: number }>();
  expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(body.expiresAt - Date.now()).toBeLessThanOrEqual(30_000);
  return body.ticket;
}

async function open(kind: 'host' | 'client', device: string, token: string): Promise<WebSocket> {
  const path = kind === 'client' ? `/v1/ws/client?device=${encodeURIComponent(device)}&ticket=${encodeURIComponent(await ticketFor(device, token))}` : `/v1/ws/host?device=${encodeURIComponent(device)}`;
  const response = await request(path, {
    headers: { Upgrade: 'websocket', ...(kind === 'host' ? { Authorization: `Bearer ${token}` } : {}) }
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).toBeDefined();
  socket!.accept();
  sockets.add(socket!);
  return socket!;
}

function send(ws: WebSocket, value: unknown): void {
  ws.send(JSON.stringify(value));
}

/** Proof of possession through the Worker, as the clients do it. */
async function accessToken(device: string, refresh: string, identity: Identity): Promise<string> {
  const query = `?device=${encodeURIComponent(device)}`;
  const challenge = await request(`/v1/token/challenge${query}`, { method: 'POST', headers: { Authorization: `Bearer ${refresh}` } });
  expect(challenge.status).toBe(200);
  const { challenge: value } = await challenge.json<{ challenge: string }>();
  const issued = await request(`/v1/token${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${refresh}`, 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: value, signature: await sign(identity, tokenProofPayload(device, value)) })
  });
  expect(issued.status).toBe(200);
  return (await issued.json<{ accessToken: string }>()).accessToken;
}

/** A web device written straight into storage, with `token` already granted as an access token:
 *  for the socket-glue tests that are not about how tokens are obtained. */
async function seedBrowser(webId: string, token: string): Promise<void> {
  await runInDurableObject(hub(), async (_instance, state) => {
    await state.storage.put(`device:${env.RELAY_ACCOUNT}:${webId}`, {
      deviceId: webId, kind: 'web', name: 'browser', platform: 'test',
      pub: { sig: {}, enc: {} }, tokenHash: await hashToken(`refresh-${token}`), access: [{ hash: await hashToken(token), expiresAt: Date.now() + 3_600_000 }],
      createdAt: Date.now(), lastSeen: Date.now()
    });
  });
}

/** Pairs one browser. By default a fresh desktop enrolls over an `enrolling` socket with the
 *  enrollment secret; pass an enrolled desktop's socket and access token to pair it again.
 *  Returns ACCESS tokens (`hostToken` only when the approval issued the desktop a credential). */
async function pair(options: { identity?: Identity; enrolled?: { socket: WebSocket; device: string; token: string } } = {}): Promise<{ hostId: string; hostToken: string; webId: string; webToken: string }> {
  const { enrolled } = options;
  const enrolling = enrolled?.socket ?? await open('host', 'enrolling', env.ENROLL_TOKEN);
  const host = options.identity ?? await generateIdentity();
  const webIdentity = await generateIdentity();
  const webPub = publicOf(webIdentity);
  const started = await request(enrolled ? `/v1/pair/start?device=${encodeURIComponent(enrolled.device)}` : '/v1/pair/start', {
    method: 'POST',
    headers: { Authorization: `Bearer ${enrolled?.token ?? env.ENROLL_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'desktop', hostPub: publicOf(host) })
  });
  expect(started.status).toBe(200);
  const { code } = await started.json<{ code: string }>();
  const incoming = message(enrolling);
  const claim = await request('/v1/pair/claim', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: 'browser', webPub })
  });
  expect(claim.status).toBe(200);
  const { pollToken } = await claim.json<{ pollToken: string }>();
  expect(await incoming).toMatchObject({ t: 'pair.request', code, name: 'browser', hostPub: JSON.parse(JSON.stringify(publicOf(host))), webPub: JSON.parse(JSON.stringify(webPub)) });
  expect((await request(`/v1/pair/poll?code=${code}`)).status).toBe(401);
  const result = message(enrolling);
  send(enrolling, { t: 'pair.respond', code, decision: 'approve', signature: await sign(host, pairingDecisionPayload(code, 'approve', webPub)) });
  const approved = await result;
  expect(approved).toMatchObject({ t: 'pair.result', code, decision: 'approve' });
  expect((await request(`/v1/pair/poll?code=${code}`)).status).toBe(401);
  const poll = await request(`/v1/pair/poll?code=${code}`, { headers: { Authorization: `Bearer ${pollToken}` } });
  expect(poll.status).toBe(200);
  const web = await poll.json<{ status: string; sealedToken: SealedToKey; webDeviceId: string; hostDeviceId: string }>();
  expect(web.status).toBe('approved');
  expect(web.hostDeviceId).toBe(approved.hostDeviceId);
  if (!enrolled) enrolling.close(1000, 'paired');
  const webRefresh = await openSealedToKey(webIdentity.enc, web.sealedToken, pairingTokenContext(code, web.webDeviceId));
  const hostRefresh = approved.hostToken as string | undefined;
  return {
    hostId: approved.hostDeviceId as string,
    hostToken: hostRefresh ? await accessToken(approved.hostDeviceId as string, hostRefresh, host) : (undefined as unknown as string),
    webId: web.webDeviceId,
    webToken: await accessToken(web.webDeviceId, webRefresh, webIdentity)
  };
}

async function queued(id: string): Promise<Array<{ t: string; seq: number; payload: unknown }> | undefined> {
  return runInDurableObject(hub(), async (_instance, state) => state.storage.get(`q:${id}`));
}

async function tags(tag: string): Promise<string[][]> {
  return runInDurableObject(hub(), async (_instance, state) => state.getWebSockets(tag).map((s) => state.getTags(s)));
}

afterEach(async () => {
  const closed = [...sockets].map((socket) => {
    if (socket.readyState !== WebSocket.OPEN) return Promise.resolve();
    const done = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve(), { once: true }));
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'test complete');
    return done;
  });
  await Promise.all(closed);
  sockets.clear();
  // Storage outlives an aborted instance; each test starts from an empty account (the device
  // cap would otherwise see every earlier test's devices).
  await runInDurableObject(hub(), async (_instance, state) => state.storage.deleteAll());
  await abortAllDurableObjects();
});

describe('relay Hub in the Cloudflare runtime', () => {
  it('refuses a different desktop signature and undefined decision before minting either device', async () => {
    const owner = await generateIdentity();
    const stranger = await generateIdentity();
    const web = await generateIdentity();
    const webPub = publicOf(web);
    const ownerSocket = await open('host', 'enrolling', env.ENROLL_TOKEN);
    const otherSocket = await open('host', 'enrolling', env.ENROLL_TOKEN);
    const started = await request('/v1/pair/start', { method: 'POST', headers: { Authorization: `Bearer ${env.ENROLL_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ hostPub: publicOf(owner) }) });
    const { code } = await started.json<{ code: string }>();
    const ownerRequest = message(ownerSocket);
    const otherRequest = message(otherSocket);
    const claim = await request('/v1/pair/claim', { method: 'POST', body: JSON.stringify({ code, webPub }), headers: { 'content-type': 'application/json' } });
    const { pollToken } = await claim.json<{ pollToken: string }>();
    expect(await ownerRequest).toMatchObject({ hostPub: JSON.parse(JSON.stringify(publicOf(owner))), webPub: JSON.parse(JSON.stringify(webPub)) });
    expect(await otherRequest).toMatchObject({ hostPub: JSON.parse(JSON.stringify(publicOf(owner))), webPub: JSON.parse(JSON.stringify(webPub)) });
    const bad = message(otherSocket);
    send(otherSocket, { t: 'pair.respond', code, decision: 'approve', signature: await sign(stranger, pairingDecisionPayload(code, 'approve', webPub)) });
    expect(await bad).toEqual({ t: 'pair.error', code, error: 'forbidden' });
    const malformed = message(ownerSocket);
    send(ownerSocket, { t: 'pair.respond', code, signature: await sign(owner, pairingDecisionPayload(code, 'approve', webPub)) });
    expect(await malformed).toEqual({ t: 'pair.error', code, error: 'forbidden' });
    expect((await request(`/v1/pair/poll?code=${code}`, { headers: { Authorization: `Bearer ${pollToken}` } })).status).toBe(200);
    const final = message(ownerSocket);
    send(ownerSocket, { t: 'pair.respond', code, decision: 'approve', signature: await sign(owner, pairingDecisionPayload(code, 'approve', webPub)) });
    expect(await final).toMatchObject({ t: 'pair.result', decision: 'approve' });
    expect((await request(`/v1/pair/poll?code=${code}`)).status).toBe(401);
  });
  it('fans pairing to enrolling hosts and routes by exact device tags and client attachment', async () => {
    const { hostId, hostToken, webId, webToken } = await pair();
    const host = await open('host', hostId, hostToken);
    expect((await tags('hosts')).some((found) => found.join(',') === `host:${hostId},hosts`)).toBe(true);
    expect(await tags(`host:${hostId}`)).toEqual([[`host:${hostId}`, 'hosts']]);
    const here = message(host);
    const client = await open('client', webId, webToken);
    expect(await here).toEqual({ t: 'client.here', client: webId });
    expect(await tags(`client:${webId}`)).toEqual([[`client:${webId}`, 'clients']]);
    expect(await tags('clients')).toEqual([[`client:${webId}`, 'clients']]);

    send(client, { t: 'hello', host: hostId });
    const handshake = message(host);
    send(client, { t: 'hs', seq: 1, payload: { hello: 'opaque' } });
    expect(await handshake).toEqual({ t: 'hs', from: webId, seq: 1, payload: { hello: 'opaque' } });
    const afterWake = message(host);
    send(client, { t: 'd', seq: 2, payload: { ct: 'sealed' } });
    expect(await afterWake).toEqual({ t: 'd', from: webId, seq: 2, payload: { ct: 'sealed' } });
    const reply = message(client);
    send(host, { t: 'hs', to: webId, seq: 3, payload: { reply: 'opaque' } });
    expect(await reply).toEqual({ t: 'hs', from: hostId, seq: 3, payload: { reply: 'opaque' } });
    const gone = message(host);
    client.close(1000, 'bye');
    expect(await gone).toEqual({ t: 'client.gone', client: webId });
  });

  it('keeps one host id when an enrolled desktop pairs a second browser, and routes each by its hello', async () => {
    const identity = await generateIdentity();
    const other = await pair(); // an unrelated desktop in the same account
    const original = await pair({ identity });
    const host = await open('host', original.hostId, original.hostToken);
    const second = await pair({ identity, enrolled: { socket: host, device: original.hostId, token: original.hostToken } });
    expect(second.hostId).toBe(original.hostId);
    expect(second.hostToken).toBeUndefined();
    for (const web of [original, second]) {
      const here = message(host);
      const client = await open('client', web.webId, web.webToken);
      expect(await here).toEqual({ t: 'client.here', client: web.webId });
      send(client, { t: 'hello', host: web.hostId });
      const delivered = message(host);
      send(client, { t: 'hs', seq: 1, payload: { from: web.webId } });
      expect(await delivered).toEqual({ t: 'hs', from: web.webId, seq: 1, payload: { from: web.webId } });
    }
    const listed = await request(`/v1/devices?device=${second.webId}`, { headers: { Authorization: `Bearer ${second.webToken}` } });
    const hosts = (await listed.json<Array<{ deviceId: string; kind: string }>>()).filter((d) => d.kind === 'host').map((d) => d.deviceId).sort();
    expect(hosts).toEqual([other.hostId, original.hostId].sort());
  });

  it('accepts only access tokens on sockets and tickets, and a refresh credential only at the token endpoints', async () => {
    const hostIdentity = await generateIdentity();
    const enrolling = await open('host', 'enrolling', env.ENROLL_TOKEN);
    const webIdentity = await generateIdentity();
    const webPub = publicOf(webIdentity);
    const started = await request('/v1/pair/start', { method: 'POST', headers: { Authorization: `Bearer ${env.ENROLL_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ hostPub: publicOf(hostIdentity) }) });
    const { code } = await started.json<{ code: string }>();
    const incoming = message(enrolling);
    const claim = await request('/v1/pair/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, webPub }) });
    const { pollToken } = await claim.json<{ pollToken: string }>();
    await incoming;
    const result = message(enrolling);
    send(enrolling, { t: 'pair.respond', code, decision: 'approve', signature: await sign(hostIdentity, pairingDecisionPayload(code, 'approve', webPub)) });
    const approved = await result;
    const hostRefresh = approved.hostToken as string;
    const hostId = approved.hostDeviceId as string;
    const poll = await (await request(`/v1/pair/poll?code=${code}`, { headers: { Authorization: `Bearer ${pollToken}` } })).json<{ sealedToken: SealedToKey; webDeviceId: string }>();
    // Nothing in storage holds either credential in the clear.
    const stored = await runInDurableObject(hub(), async (_instance, state) => JSON.stringify([...(await state.storage.list())]));
    const webRefresh = await openSealedToKey(webIdentity.enc, poll.sealedToken, pairingTokenContext(code, poll.webDeviceId));
    expect(stored).not.toContain(webRefresh);
    expect(stored).not.toContain(hostRefresh);

    const hostUpgrade = (token: string) => request(`/v1/ws/host?device=${hostId}`, { headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` } });
    expect((await hostUpgrade(hostRefresh)).status).toBe(401);
    expect((await request(`/v1/ws/ticket?device=${poll.webDeviceId}`, { method: 'POST', headers: { Authorization: `Bearer ${webRefresh}` } })).status).toBe(401);
    expect((await request(`/v1/devices?device=${poll.webDeviceId}`, { headers: { Authorization: `Bearer ${webRefresh}` } })).status).toBe(401);
    const hostAccess = await accessToken(hostId, hostRefresh, hostIdentity);
    const upgraded = await hostUpgrade(hostAccess);
    expect(upgraded.status).toBe(101);
    upgraded.webSocket!.accept();
    sockets.add(upgraded.webSocket!);
    const client = await open('client', poll.webDeviceId, await accessToken(poll.webDeviceId, webRefresh, webIdentity));
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it('reports live presence from the Hub sockets and the kill switch closes every other device', async () => {
    const { hostId, hostToken, webId, webToken } = await pair();
    const presence = async () => {
      const res = await request(`/v1/devices?device=${hostId}`, { headers: { Authorization: `Bearer ${hostToken}` } });
      return Object.fromEntries((await res.json<Array<{ deviceId: string; online: boolean }>>()).map((d) => [d.deviceId, d.online]));
    };
    expect(await presence()).toEqual({ [hostId]: false, [webId]: false });
    const host = await open('host', hostId, hostToken);
    const here = message(host);
    const client = await open('client', webId, webToken);
    await here;
    expect(await presence()).toEqual({ [hostId]: true, [webId]: true });

    const closed = new Promise<number>((resolve) => client.addEventListener('close', (event) => resolve(event.code), { once: true }));
    const notice = message(host);
    const res = await request(`/v1/devices/revoke-all?device=${hostId}`, { method: 'POST', headers: { Authorization: `Bearer ${hostToken}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: [webId] });
    expect(await closed).toBe(1008);
    expect(await notice).toEqual({ t: 'device.revoked', devices: [webId] });
    expect(await presence()).toEqual({ [hostId]: true });
  });

  it('revokes a connected desktop from its browser: closes both, tells the other desktops, answers 200', async () => {
    // Closing the revoked desktop's socket and then broadcasting to every desktop used to send on
    // the socket just closed, which throws in this runtime: the revocation committed but the
    // request answered 500 (the deployed smoke's last step).
    const { hostId, hostToken, webId, webToken } = await pair();
    const other = await pair();
    const host = await open('host', hostId, hostToken);
    const bystander = await open('host', other.hostId, other.hostToken);
    const hostClosed = new Promise<number>((resolve) => host.addEventListener('close', (event) => resolve(event.code), { once: true }));
    const notice = message(bystander);
    const res = await request(`/v1/devices?device=${webId}&target=${hostId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${webToken}` } });
    expect(res.status).toBe(200);
    expect(((await res.json<{ revoked: string[] }>()).revoked).sort()).toEqual([hostId, webId].sort());
    expect(await hostClosed).toBe(1008);
    expect(await notice).toMatchObject({ t: 'device.revoked' });
  });

  it('answers a refused request with a body cleanly, whether or not the Hub read the body', async () => {
    // The Hub refuses these before reading their bodies. Streamed through, the runtime would be
    // left reading a request whose response was already sent, an uncaught error that ended a
    // `wrangler dev` session and would log an exception on every refused request.
    const body = JSON.stringify({ hostPub: { sig: { kty: 'EC' }, enc: { kty: 'EC' } }, name: 'x'.repeat(4096) });
    for (let i = 0; i < 3; i++) {
      const refused = await request('/v1/pair/start', { method: 'POST', headers: { Authorization: 'Bearer wrong', 'content-type': 'application/json' }, body });
      expect(refused.status).toBe(403);
    }
    expect((await request('/v1/devices?target=x', { method: 'DELETE', body: 'ignored' })).status).toBe(401);
    expect((await request('/v1/token?device=w_x', { method: 'POST', headers: { Authorization: 'Bearer nope' }, body })).status).toBe(401);
    // A body over the largest route payload never reaches the Hub.
    const huge = await request('/v1/mirror/s_1?device=h_x', { method: 'PUT', headers: { Authorization: 'Bearer nope' }, body: 'x'.repeat(3_000_000) });
    expect(huge.status).toBe(413);
  });

  it('refuses pairing traffic at the edge once the budget is spent, before the Hub is asked', async () => {
    expect(typeof env.PAIR_LIMIT?.limit).toBe('function');
    expect(typeof env.POLL_LIMIT?.limit).toBe('function');
    expect(typeof env.TOKEN_LIMIT?.limit).toBe('function');
    const claim = () => request('/v1/pair/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'ABCD2345', webPub: {} }) });
    const statuses: Array<[number, string | null]> = [];
    for (let i = 0; i < 11; i++) {
      const res = await claim();
      statuses.push([res.status, res.headers.get('x-relay-limit')]);
    }
    // Ten reach the Hub (and fail validation there); the eleventh never gets that far.
    expect(statuses.slice(0, 10).every(([status, via]) => status === 400 && via === null)).toBe(true);
    expect(statuses[10]).toEqual([429, 'edge']);
    // Another address still gets through.
    expect((await request('/v1/pair/claim', { method: 'POST', headers: { 'cf-connecting-ip': '198.51.100.200', 'content-type': 'application/json' }, body: '{}' })).status).toBe(400);
  });

  it('drops malformed and unsupported host frames without delivering them to a paired browser', async () => {
    const { hostId, hostToken, webId, webToken } = await pair();
    const host = await open('host', hostId, hostToken);
    const client = await open('client', webId, webToken);
    const delivered = message(client);
    send(host, null);
    send(host, { t: 'unsupported', to: webId, seq: 1, payload: { forged: true } });
    send(host, { t: 'hs', to: webId, seq: 2, payload: { reply: 'valid' } });
    expect(await delivered).toEqual({ t: 'hs', from: hostId, seq: 2, payload: { reply: 'valid' } });
  });

  it('queues only for registered web devices in this account and drains only data on reconnect', async () => {
    const { hostId, hostToken, webId, webToken } = await pair();
    const host = await open('host', hostId, hostToken);
    const unknown = message(host);
    send(host, { t: 'd', to: 'w_not-registered', seq: 1, payload: { ct: 'AAAA' } });
    expect(await unknown).toEqual({ t: 'client.gone', client: 'w_not-registered' });
    expect(await queued('w_not-registered')).toBeUndefined();
    await runInDurableObject(hub(), async (_instance, state) => {
      await state.storage.put('device:other-account:w_other', { deviceId: 'w_other', kind: 'web' });
    });
    const cross = message(host);
    send(host, { t: 'd', to: 'w_other', seq: 2, payload: { ct: 'AAAA' } });
    expect(await cross).toEqual({ t: 'client.gone', client: 'w_other' });
    expect(await queued('w_other')).toBeUndefined();
    const offline = message(host);
    send(host, { t: 'hs', to: webId, seq: 3, payload: { hello: 'no queue' } });
    expect(await offline).toEqual({ t: 'client.gone', client: webId });
    expect(await queued(webId)).toBeUndefined();
    const absent = message(host);
    send(host, { t: 'd', to: webId, seq: 4, payload: { salt: 's', seq: 4, ct: 'AAAA' } });
    expect(await absent).toEqual({ t: 'client.gone', client: webId });
    expect(await queued(webId)).toEqual([{ t: 'd', seq: 4, payload: { salt: 's', seq: 4, ct: 'AAAA' } }]);
    const here = message(host);
    const client = await open('client', webId, webToken);
    expect(await message(client)).toEqual({ t: 'd', seq: 4, payload: { salt: 's', seq: 4, ct: 'AAAA' } });
    expect(await here).toEqual({ t: 'client.here', client: webId });
    expect(await queued(webId)).toBeUndefined();
  });

  it('requires a real upgrade before consuming a ticket and rejects replay, bearer URL, and revocation', async () => {
    const webId = 'w_ticket_test';
    const token = 'local-test-token';
    await seedBrowser(webId, token);
    const ticket = await ticketFor(webId, token);
    const path = `/v1/ws/client?device=${webId}&ticket=${ticket}`;
    expect((await request(path)).status).toBe(426);
    expect((await request(path, { headers: { Upgrade: 'not-websocket' } })).status).toBe(426);
    expect((await request(`/v1/ws/client?device=${webId}&token=${token}`, { headers: { Upgrade: 'websocket' } })).status).toBe(401);
    const attempts = await Promise.all([request(path, { headers: { Upgrade: 'websocket' } }), request(path, { headers: { Upgrade: 'websocket' } })]);
    expect(attempts.map((response) => response.status).sort()).toEqual([101, 401]);
    const accepted = attempts.find((response) => response.status === 101)!.webSocket!;
    accepted.accept();
    sockets.add(accepted);
    expect((await request(path, { headers: { Upgrade: 'websocket' } })).status).toBe(401);
    const pending = await ticketFor(webId, token);
    await runInDurableObject(hub(), async (_instance, state) => {
      await state.storage.put(`q:${webId}`, [{ t: 'd', seq: 9, payload: { salt: 's', seq: 9, ct: 'AAAA' } }]);
    });
    const revoke = await request(`/v1/devices?device=${webId}&target=${webId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    expect(revoke.status).toBe(200);
    expect(await queued(webId)).toBeUndefined();
    expect((await request(`/v1/ws/client?device=${webId}&ticket=${pending}`, { headers: { Upgrade: 'websocket' } })).status).toBe(401);
    expect((await request(`/v1/ws/ticket?device=${webId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it('consumes only once across DO eviction and fresh upgrade', async () => {
    const webId = 'w_evicted_ticket';
    const token = 'eviction-test-token';
    await seedBrowser(webId, token);
    const ticket = await ticketFor(webId, token);
    await evictDurableObject(hub());
    const path = `/v1/ws/client?device=${webId}&ticket=${ticket}`;
    const first = await request(path, { headers: { Upgrade: 'websocket' } });
    expect(first.status).toBe(101);
    first.webSocket!.accept();
    sockets.add(first.webSocket!);
    expect((await request(path, { headers: { Upgrade: 'websocket' } })).status).toBe(401);
  });

  it('restores persisted ciphertext after eviction and a fresh socket upgrade', async () => {
    const webId = 'w_reconnect';
    const token = 'local-test-token';
    await seedBrowser(webId, token);
    await runInDurableObject(hub(), async (_instance, state) => {
      await state.storage.put(`q:${webId}`, [{ t: 'd', seq: 8, payload: { salt: 's', seq: 8, ct: 'AAAA' } }]);
    });
    await evictDurableObject(hub());
    const client = await open('client', webId, token);
    expect(await message(client)).toEqual({ t: 'd', seq: 8, payload: { salt: 's', seq: 8, ct: 'AAAA' } });
    expect(await queued(webId)).toBeUndefined();
    expect(await tags(`client:${webId}`)).toEqual([[`client:${webId}`, 'clients']]);
  });

  it('rejects oversized raw frames before routing and bounds ciphertext and total offline bytes', async () => {
    const { hostId, hostToken, webId, webToken } = await pair();
    const host = await open('host', hostId, hostToken);
    const client = await open('client', webId, webToken);
    send(client, { t: 'hello', host: hostId });
    const toHost = message(host);
    send(client, { t: 'd', seq: 1, payload: { ct: 'A'.repeat(1024 * 1024) } });
    send(client, { t: 'd', seq: 2, payload: { ct: 'okay' } });
    expect(await toHost).toEqual({ t: 'd', from: webId, seq: 2, payload: { ct: 'okay' } });
    const gone = message(host);
    client.close(1000, 'offline');
    expect(await gone).toEqual({ t: 'client.gone', client: webId });
    const oversized = message(host);
    send(host, { t: 'd', to: webId, seq: 3, payload: { salt: 's', seq: 3, ct: 'A'.repeat(70 * 1024) } });
    expect(await oversized).toEqual({ t: 'client.gone', client: webId });
    expect(await queued(webId)).toBeUndefined();
    for (let seq = 4; seq < 24; seq++) {
      const notice = message(host);
      send(host, { t: 'd', to: webId, seq, payload: { salt: 's', seq, ct: 'A'.repeat(40 * 1024) } });
      expect(await notice).toEqual({ t: 'client.gone', client: webId });
    }
    const backlog = await queued(webId);
    expect(backlog?.length).toBeGreaterThan(0);
    expect(backlog?.length).toBeLessThan(20);
    expect(new TextEncoder().encode(JSON.stringify(backlog)).byteLength).toBeLessThanOrEqual(512 * 1024);
    expect(backlog?.at(-1)?.seq).toBe(23);
  });
});
