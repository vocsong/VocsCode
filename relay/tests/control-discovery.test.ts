import { env, exports as loopback } from 'cloudflare:workers';
import { abortAllDurableObjects, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { INTERNAL_ACCOUNT_ID_HEADER } from '../src/account';
import { CONTROL_DISCOVERY_INTERNAL_PATH, CONTROL_INTERNAL_PATH, CONTROL_PATH, CONTROLLER_ASSERTION_HEADER, createDiscoveryAssertion, verifyControllerAssertion } from '../src/control-auth';
import { hashToken, randomToken } from '../src/core';
import { CONTROL_MAX_BYTES, type ControllerPrincipal, type ControlRequest } from '../../src/shared/control';

// `loopback.ControlDiscovery` uses the actual named entrypoint transport, not a class stub.
declare global {
  namespace Cloudflare {
    interface GlobalProps { mainModule: typeof import('../src/entry') }
  }
}

const sockets: WebSocket[] = [];
const accountHub = (accountId = env.RELAY_ACCOUNT) => env.HUB.get(env.HUB.idFromName(accountId));
const encoder = new TextEncoder();
const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
const principal = (accountId = env.RELAY_ACCOUNT) => ({
  accountId, controllerId: crypto.randomUUID(), scopes: ['control:discover'] as ['control:discover'], validUntil: Date.now() + 25_000
});
const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const call = (name: string, args: unknown = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const discovery = (value: unknown, who: unknown, extraHeaders?: Record<string, string>) => loopback.ControlDiscovery.discover(
  new Request('https://hub.test/vocs-code', { method: 'POST', body: JSON.stringify(value), headers: { ...headers, ...extraHeaders } }), who
);

async function result(response: Response): Promise<unknown> {
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json<{ result: { content: Array<{ text: string }> } }>();
  return JSON.parse(body.result.content[0].text);
}

async function host(hostId: string, name: string, canSee: boolean) {
  const token = randomToken();
  const instanceId = crypto.randomUUID();
  await runInDurableObject(accountHub(), async (_instance, state) => {
    await state.storage.put(`device:${env.RELAY_ACCOUNT}:${hostId}`, {
      deviceId: hostId, kind: 'host', name, platform: 'test', pub: {}, tokenHash: await hashToken(randomToken()),
      access: [{ hash: await hashToken(token), expiresAt: Date.now() + 60_000 }], createdAt: Date.now(), lastSeen: Date.now()
    });
  });
  const upgrade = await SELF.fetch(`https://relay.test/v1/ws/host?device=${hostId}`, {
    headers: { upgrade: 'websocket', authorization: `Bearer ${token}` }
  });
  expect(upgrade.status).toBe(101);
  const socket = upgrade.webSocket!;
  socket.accept();
  sockets.push(socket);
  const seen: { id: string; principal: ControllerPrincipal; request: ControlRequest }[] = [];
  const metadata = { id: 's_docs', title: 'Docs', status: 'idle', harness: 'pi', transcript: 'not discovery metadata' };
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data)) as typeof seen[number];
    seen.push(frame);
    const results: Partial<Record<ControlRequest['method'], unknown>> = {
      capabilities: { version: 1, instanceId, methods: ['capabilities', 'sessions.get', 'windows.create'], logId: 'private' },
      'projects.list': { items: [{ id: 'p_repo', name, root: 'internal' }], nextOffset: null },
      'sessions.list': { items: [metadata], nextOffset: null },
      'sessions.get': metadata
    };
    socket.send(JSON.stringify({ t: 'control.response', id: frame.id,
      ...(canSee ? { ok: true, result: results[frame.request.method] } : { ok: false, error: 'denied' }) }));
  });
  return { hostId, instanceId, name, seen };
}

afterEach(async () => {
  await Promise.all(sockets.splice(0).map((socket) => {
    if (socket.readyState === WebSocket.CLOSED) return;
    const done = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve(), { once: true }));
    socket.close(1000, 'test complete');
    return done;
  }));
  for (const account of [env.RELAY_ACCOUNT, 'github:45678']) {
    await runInDurableObject(accountHub(account), (_instance, state) => state.storage.deleteAll());
  }
  await abortAllDurableObjects();
});

it('lists only the discovery tools over the named binding and keeps every controller path closed over public HTTP', async () => {
  const who = principal();
  const response = await discovery(list, who);
  expect(response.status).toBe(200);
  const body = await response.json<{ result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } }>();
  expect(body.result.tools.map((tool) => tool.name).sort()).toEqual(['capabilities', 'computers_list', 'projects_list', 'sessions_get', 'sessions_list']);
  expect(body.result.tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
  for (const path of ['/vocs-code', CONTROL_PATH, CONTROL_DISCOVERY_INTERNAL_PATH, '/v1/__internal/control/discovery']) {
    expect((await SELF.fetch(`https://relay.test${path}`, { method: 'POST', headers, body: JSON.stringify(list) })).status).toBe(404);
  }
  expect((await discovery(list, { ...who, scopes: ['control:discover', 'control:send'] })).status).toBe(401);
  expect((await discovery(list, { ...who, validUntil: Date.now() - 1 })).status).toBe(401);
  expect((await discovery(list, { ...who, validUntil: Date.now() + 60_000 })).status).toBe(401);
  expect((await discovery('x'.repeat(CONTROL_MAX_BYTES + 1), who)).status).toBe(413);
});

it('projects only approved metadata from two exact hosts and refuses write/read-content tools before dispatch', async () => {
  const office = await host('h_office00001', 'Office PC', true);
  const laptop = await host('h_laptop00001', 'Laptop', true);
  const hidden = await host('h_hidden00001', 'Hidden', false);
  const who = principal();
  const listed = await result(await discovery(call('computers_list'), who));
  expect(listed).toEqual({ computers: expect.arrayContaining([office, laptop].map(({ hostId, instanceId, name }) => ({ hostId, instanceId, name, platform: 'test', online: true, version: 1 }))) });
  expect((listed as { computers: unknown[] }).computers).toHaveLength(2);
  expect(hidden.seen).toHaveLength(1); // The host's own refusal filters it from discovery.
  const target = { hostId: office.hostId, instanceId: office.instanceId };
  const project = { ...target, projectId: 'p_repo' };
  const session = { ...project, sessionId: 's_docs' };
  expect(await result(await discovery(call('capabilities', { hostId: office.hostId }), who))).toEqual({ version: 1, instanceId: office.instanceId, methods: ['capabilities', 'sessions.get'] });
  expect(await result(await discovery(call('projects_list', target), who))).toEqual({ items: [{ id: 'p_repo', name: 'Office PC' }], nextOffset: null });
  expect(await result(await discovery(call('sessions_list', project), who))).toEqual({ items: [{ id: 's_docs', title: 'Docs', status: 'idle', harness: 'pi' }], nextOffset: null });
  expect(await result(await discovery(call('sessions_get', session), who, { [INTERNAL_ACCOUNT_ID_HEADER]: 'github:45678', cookie: 'ignored=value' }))).toEqual({ id: 's_docs', title: 'Docs', status: 'idle', harness: 'pi' });
  expect(office.seen.map((frame) => frame.request.method)).toEqual(['capabilities', 'capabilities', 'projects.list', 'sessions.list', 'sessions.get']);
  expect(office.seen.every((frame) => frame.principal.accountId === who.accountId && frame.principal.controllerId === who.controllerId && frame.principal.validUntil === who.validUntil)).toBe(true);
  expect(laptop.seen.map((frame) => frame.request.method)).toEqual(['capabilities']);
  const intent = { admissionWindowId: crypto.randomUUID(), idempotencyKey: 'test-only' };
  for (const rpc of [call('windows_create', target), call('sessions_transcript', session), call('sessions_create', { ...project, ...intent }),
    call('sessions_send', { ...session, ...intent, text: 'unused test text' }), call('operations_get', { ...target, operationId: crypto.randomUUID() }),
    call('operations_interrupt', { ...target, operationId: crypto.randomUUID() })]) {
    const denied = await discovery(rpc, who);
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ error: { code: -32602 } });
  }
  const otherAccount = principal('github:45678');
  expect(await result(await discovery(call('computers_list'), otherAccount))).toEqual({ computers: [] });
  expect(await result(await discovery(call('sessions_get', session), otherAccount))).toEqual({ error: 'unavailable' });
  expect(office.seen).toHaveLength(5);
  expect(laptop.seen).toHaveLength(1);
});

it('rejects a replay of discovery bytes across a Durable Object restart and cannot be upgraded to the old channel', async () => {
  const who = principal();
  const body = JSON.stringify(list);
  const bytes = new Uint8Array(encoder.encode(body));
  const secret = env.ACCOUNT_ASSERTION_SECRET!;
  const signed = await createDiscoveryAssertion(who, bytes, secret);
  const boundRequest = (route: string, value: string) => new Request(`https://hub${route}`, {
    method: 'POST', body: value, headers: { ...headers, [CONTROLLER_ASSERTION_HEADER]: signed, [INTERNAL_ACCOUNT_ID_HEADER]: who.accountId }
  });
  const dispatch = (route: string, value: string) => accountHub().fetch(boundRequest(route, value));
  expect(await verifyControllerAssertion(boundRequest(CONTROL_INTERNAL_PATH, body), bytes, secret, 'internal')).toBeNull();
  expect((await dispatch(CONTROL_INTERNAL_PATH, body)).status).toBe(404);
  expect((await dispatch(CONTROL_DISCOVERY_INTERNAL_PATH, `${body} `)).status).toBe(401);
  const first = await dispatch(CONTROL_DISCOVERY_INTERNAL_PATH, body);
  expect(first.status).toBe(200);
  await first.arrayBuffer();
  await abortAllDurableObjects();
  expect(who.validUntil).toBeGreaterThan(Date.now());
  const replay = await dispatch(CONTROL_DISCOVERY_INTERNAL_PATH, body);
  expect(replay.status).toBe(401);
  expect(await replay.json()).toEqual({ error: 'invalid_controller_assertion' });
});
