import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_ASSERTION_HEADER, createAccountAssertion, INTERNAL_ACCOUNT_AUTH_HEADER, INTERNAL_ACCOUNT_ID_HEADER } from '../relay/src/account';
import { CONTROLLER_ASSERTION_HEADER, CONTROL_INTERNAL_PATH, CONTROL_NONCE_LIMIT, CONTROL_PATH } from '../relay/src/control-auth';
import { CONTROL_TOOL_NAMES, CONTROL_MAX_CONTROLLER_HTTP, CONTROL_MAX_HTTP } from '../relay/src/control-mcp';
import { CONTROL_MAX_CONTROLLER_PENDING, CONTROL_MAX_PENDING } from '../relay/src/control-host';
import { CONTROL_MAX_BYTES, CONTROL_SCOPES, type ControllerPrincipal, type ControlRequest } from '../src/shared/control';

const SECRET = 'control-relay-test-only-assertion-secret-32-bytes';
const CONTROLLER = randomUUID();
const INSTANCE = randomUUID();
const HOST = 'h_abcdefghijk';
const ACCOUNT = 'github:100';
const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const tool = (name: string, args: unknown = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
type HostFrame = { t: string; id: string; hostId: string; principal: ControllerPrincipal; request: ControlRequest; expiresAt: number };

/** Independent producer for the landing's byte-exact assertion contract. */
function assertion(body: string, overrides: Record<string, unknown> = {}, audience = 'vocs.controller.assertion.v1\nPOST\n/v1/control/mcp', secret = SECRET): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, accountId: ACCOUNT, controllerId: CONTROLLER,
    scopes: [...CONTROL_SCOPES].sort(), expiresAt: Date.now() + 30_000, nonce: randomUUID(),
    bodyHash: createHash('sha256').update(body).digest('hex'), ...overrides })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(`${audience}\n${payload}`).digest('base64url')}`;
}
function signed(value: unknown = LIST, options: { headers?: Record<string, string>; claims?: Record<string, unknown>; signal?: AbortSignal; raw?: string } = {}): Request {
  const body = options.raw ?? JSON.stringify(value);
  return new Request(`https://relay.test${CONTROL_PATH}`, { method: 'POST', body, signal: options.signal,
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      [CONTROLLER_ASSERTION_HEADER]: assertion(body, options.claims), ...options.headers } });
}
class TestSocket {
  readonly frames: HostFrame[] = [];
  readyState = 1;
  attachment: unknown = { controlCurrent: true };
  onSend?: (frame: HostFrame) => void;
  constructor(readonly tags: string[]) {}
  send(raw: string): void {
    if (this.readyState !== 1) throw new Error('closed');
    const frame = JSON.parse(raw) as HostFrame;
    this.frames.push(frame);
    this.onSend?.(frame);
  }
  close(): void { this.readyState = 3; }
  serializeAttachment(value: unknown): void { this.attachment = value; }
  deserializeAttachment(): unknown { return this.attachment; }
}

/** Load the actual platform module without leaking workerd's global declarations into the
 *  Node/DOM test compilation. Production signatures are checked by typecheck:relay. */
interface TestHub {
  fetch(request: Request): Promise<Response>;
  webSocketMessage(ws: TestSocket, raw: string): Promise<void>;
  webSocketClose(ws: TestSocket, code: number, reason: string): Promise<void>;
}
interface TestEnv {
  CONTROL_MCP_ENABLED?: string;
  ACCOUNT_ASSERTION_SECRET: string;
  RELAY_ACCOUNT: string;
  ENROLL_TOKEN: string;
  HUB: { idFromName(name: string): string; get(name: string): { fetch(request: Request): Promise<Response> } };
}
const { default: worker, Hub } = await vi.importActual<{
  default: { fetch(request: Request, env: TestEnv): Promise<Response> };
  Hub: new (state: unknown, env: TestEnv) => TestHub;
}>('../relay/src/worker');
interface AccountFixture {
  hub: TestHub;
  sockets: TestSocket[];
  values: Map<string, unknown>;
  add(id?: string, kind?: string, register?: boolean): TestSocket;
  reply(ws: TestSocket, id: string, reply: Record<string, unknown>): Promise<void>;
  auto(ws: TestSocket, fn: (frame: HostFrame) => Record<string, unknown>): void;
  restart(): void;
}
function harness() {
  const accounts = new Map<string, AccountFixture>();
  const forwarded: Request[] = [];
  const errors: unknown[] = [];
  const env: TestEnv = { CONTROL_MCP_ENABLED: '1', ACCOUNT_ASSERTION_SECRET: SECRET, RELAY_ACCOUNT: 'vocs-v1', ENROLL_TOKEN: 'unused',
    HUB: { idFromName: (name: string) => name, get: (name: string) => ({ fetch: (request: Request) => { forwarded.push(request.clone()); return account(name).hub.fetch(request); } }) }
  };
  function account(name = ACCOUNT): AccountFixture {
    const found = accounts.get(name);
    if (found) return found;
    const values = new Map<string, unknown>();
    const sockets: TestSocket[] = [];
    let tail = Promise.resolve();
    const memory = {
      get: async <T,>(key: string) => structuredClone(values.get(key)) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
      delete: async (key: string) => values.delete(key),
      list: async (options: { prefix: string; limit: number; startAfter?: string }) => new Map([...values].filter(([key]) => key.startsWith(options.prefix) && (!options.startAfter || key > options.startAfter)).sort(([a], [b]) => a.localeCompare(b)).slice(0, options.limit))
    };
    const storage = { ...memory,
      transaction: <T,>(fn: (tx: typeof memory) => Promise<T>) => {
        const run = tail.then(() => fn(memory));
        tail = run.then(() => undefined, () => undefined);
        return run;
      }
    };
    const state = { storage, getWebSockets: (tag: string) => sockets.filter((s) => s.tags.includes(tag)), getTags: (ws: TestSocket) => ws.tags };
    const hub = new Hub(state as never, env);
    const result: AccountFixture = { hub, sockets, values,
      add: (id = HOST, kind = 'host', register = true) => {
        if (register) values.set(`device:${name}:${id}`, { deviceId: id, kind, name: `name-${id}`, platform: 'test' });
        const ws = new TestSocket([`${kind === 'web' ? 'client' : 'host'}:${id}`, kind === 'web' ? 'clients' : 'hosts']);
        sockets.push(ws);
        return ws;
      },
      reply: async (ws: TestSocket, id: string, reply: Record<string, unknown>) => hub.webSocketMessage(ws as never, JSON.stringify({ t: 'control.response', id, ...reply })),
      auto: (ws: TestSocket, fn: (frame: HostFrame) => Record<string, unknown>) => {
        ws.onSend = (frame) => { void hub.webSocketMessage(ws as never, JSON.stringify({ t: 'control.response', id: frame.id, ...fn(frame) })).catch((error) => errors.push(error)); };
      },
      restart: () => { result.hub = new Hub(state as never, env); }
    };
    accounts.set(name, result);
    return result;
  }
  const dispatch = (request: Request) => worker.fetch(request, env);
  return { env, account, dispatch, forwarded, errors, call: (value = LIST as unknown, options: Parameters<typeof signed>[1] = {}) => dispatch(signed(value, options)) };
}
async function content(response: Response): Promise<unknown> {
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json() as { result: { content: Array<{ text: string }> } };
  return JSON.parse(body.result.content[0].text);
}
const sent = async (ws: TestSocket, count = 1) => vi.waitFor(() => expect(ws.frames).toHaveLength(count));
afterEach(() => vi.useRealTimers());

describe('controller Worker and Hub dispatch', () => {
  it('is disabled by default, refuses public internals, and never selects a Hub', async () => {
    const h = harness();
    delete h.env.CONTROL_MCP_ENABLED;
    expect((await h.call()).status).toBe(404);
    for (const path of ['/v1/__internal', '/v1/__internal/control/mcp', '/v1/__internal-anything']) expect((await h.dispatch(new Request(`https://relay.test${path}`))).status).toBe(404);
    expect(h.forwarded).toHaveLength(0);
  });

  it('rejects cookies, browser account assertions, device bearer tokens, and forged internal identity', async () => {
    const h = harness();
    const browser = await createAccountAssertion(ACCOUNT, 'POST', CONTROL_PATH, SECRET);
    const alternatives: Record<string, string>[] = [{ cookie: 'session=owner' }, { [ACCOUNT_ASSERTION_HEADER]: browser }, { authorization: 'Bearer host-access-token' },
      { [INTERNAL_ACCOUNT_ID_HEADER]: ACCOUNT, [INTERNAL_ACCOUNT_AUTH_HEADER]: '1', 'x-vocs-internal-controller': CONTROLLER }];
    for (const headers of alternatives) {
      const response = await h.dispatch(new Request(`https://relay.test${CONTROL_PATH}`, { method: 'POST', body: JSON.stringify(LIST), headers }));
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(h.forwarded).toHaveLength(0);
  });

  it('binds assertions to audience, path, method, lifetime, strict claims, sorted scopes and exact bytes', async () => {
    const h = harness();
    const body = JSON.stringify(LIST);
    const badClaims = [{ v: 2 }, { accountId: 'github:0' }, { controllerId: 'not-a-uuid' }, { nonce: 'no' },
      { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 60_000 }, { scopes: [] }, { scopes: ['control:root'] },
      { scopes: ['control:discover', 'control:discover'] }, { scopes: ['control:read', 'control:discover'] },
      { validUntil: Date.now() + 90_000 }, { extra: true }, { bodyHash: 'A'.repeat(64) }];
    for (const claims of badClaims) expect((await h.call(LIST, { claims })).status).toBe(401);
    for (const audience of ['vocs.account.assertion.v1\nPOST\n/v1/control/mcp', 'vocs.controller.assertion.v1\nGET\n/v1/control/mcp', 'vocs.controller.assertion.v1\nPOST\n/mcp']) {
      expect((await h.call(LIST, { headers: { [CONTROLLER_ASSERTION_HEADER]: assertion(body, {}, audience) } })).status).toBe(401);
    }
    expect((await h.call(LIST, { headers: { [CONTROLLER_ASSERTION_HEADER]: assertion(body, {}, undefined, `${SECRET}!`) } })).status).toBe(401);
    expect((await h.call(LIST, { raw: `${body} `, headers: { [CONTROLLER_ASSERTION_HEADER]: assertion(body) } })).status).toBe(401);
    expect((await h.call(LIST, { headers: { [CONTROLLER_ASSERTION_HEADER]: `${assertion(body)}=` } })).status).toBe(401);
    expect((await h.call(LIST, { headers: { 'content-encoding': 'gzip' } })).status).toBe(401);
    expect(h.forwarded).toHaveLength(0);
  });

  it('strips all browser/internal authority, derives validUntil and rejects replay after Hub reconstruction', async () => {
    const h = harness();
    const a = h.account();
    const ws = a.add();
    a.auto(ws, () => ({ ok: true, result: { version: 1, instanceId: INSTANCE } }));
    const value = tool('capabilities', { hostId: HOST });
    const expiresAt = Date.now() + 29_000;
    const req = signed(value, { claims: { expiresAt }, headers: {
      cookie: 'secret-cookie', authorization: 'Bearer secret-token', [ACCOUNT_ASSERTION_HEADER]: 'forged',
      [INTERNAL_ACCOUNT_AUTH_HEADER]: '1', [INTERNAL_ACCOUNT_ID_HEADER]: 'github:999', 'x-vocs-internal-unknown': 'evil' } });
    const replay = req.clone();
    expect(await content(await h.dispatch(req))).toEqual({ version: 1, instanceId: INSTANCE });
    expect(ws.frames[0].principal).toEqual({ accountId: ACCOUNT, controllerId: CONTROLLER, scopes: [...CONTROL_SCOPES].sort(), validUntil: expiresAt });
    expect([...h.forwarded[0].headers.keys()].sort()).toEqual(['accept', 'content-type', CONTROLLER_ASSERTION_HEADER, INTERNAL_ACCOUNT_ID_HEADER].sort());
    expect(h.forwarded[0].headers.get(INTERNAL_ACCOUNT_ID_HEADER)).toBe(ACCOUNT);
    a.restart();
    expect((await h.dispatch(replay)).status).toBe(401);
    expect(ws.frames).toHaveLength(1);
    expect([...a.values.keys()].sort()).toEqual(['__control_nonces__', '__vocs_account_id__', `device:${ACCOUNT}:${HOST}`].sort());
    expect(a.values.get('__control_nonces__')).toEqual([{ nonce: expect.any(String), expiresAt }]);
  });

  it('rechecks assertions and account isolation inside the Hub, before any host frame', async () => {
    const h = harness();
    const a = h.account();
    const ws = a.add();
    await h.call(); // pin account
    const req = signed(tool('capabilities', { hostId: HOST }));
    const headers = new Headers(req.headers);
    headers.set(INTERNAL_ACCOUNT_ID_HEADER, ACCOUNT);
    expect((await a.hub.fetch(new Request(`https://hub${CONTROL_INTERNAL_PATH}`, { method: 'POST', headers, body: '{}' }))).status).toBe(401);
    headers.set(INTERNAL_ACCOUNT_ID_HEADER, 'github:999');
    expect((await a.hub.fetch(new Request(`https://hub${CONTROL_INTERNAL_PATH}`, { method: 'POST', headers, body: '{}' }))).status).toBe(403);
    expect(ws.frames).toHaveLength(0);
  });

  it('uses the real SDK Client to initialize, list a strict allowlist and call typed tools', async () => {
    const h = harness();
    const a = h.account();
    const ws = a.add();
    a.auto(ws, (frame) => ({ ok: true, result: { method: frame.request.method, params: frame.request.params } }));
    const client = new Client({ name: 'relay-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(`https://relay.test${CONTROL_PATH}`), { fetch: async (input, init) => {
      const req = new Request(input, init);
      if (req.method !== 'POST') return h.dispatch(req);
      const body = await req.text();
      return h.call(undefined, { raw: body, headers: Object.fromEntries(req.headers) });
    } });
    await client.connect(transport);
    try {
      expect(transport.sessionId).toBeUndefined();
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name).sort()).toEqual([...CONTROL_TOOL_NAMES].sort());
      const schema = list.tools.find((t) => t.name === 'sessions_send')!.inputSchema;
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toContain('hostId');
      const called = await client.callTool({ name: 'projects_list', arguments: { hostId: HOST, instanceId: INSTANCE } });
      expect(called.isError).not.toBe(true);
      expect(ws.frames[0].request).toEqual({ method: 'projects.list', params: { instanceId: INSTANCE, offset: 0, limit: 50 } });
    } finally { await client.close(); }
    expect(h.errors).toEqual([]);
  });

  it('rejects unknown tools, caller principals, arbitrary IPC, untyped params and notification mutations', async () => {
    const h = harness();
    const ws = h.account().add();
    const values = [tool('ipc_invoke', { channel: 'settings:set' }), tool('projects_list', { instanceId: INSTANCE }),
      tool('projects_list', { hostId: HOST, instanceId: INSTANCE, principal: { controllerId: CONTROLLER } }),
      tool('projects_list', { hostId: HOST, instanceId: INSTANCE, limit: 101 }),
      tool('sessions_send', { hostId: HOST, instanceId: INSTANCE, path: 'C:/secret' }),
      { jsonrpc: '2.0', method: 'tools/call', params: { name: 'capabilities', arguments: { hostId: HOST } } }, [LIST, LIST]];
    for (const value of values) expect((await h.call(value)).status).toBe(400);
    expect(ws.frames).toHaveLength(0);
  });

  it('filters computers by live local authorization/version without leaking offline, denied or foreign metadata', async () => {
    const h = harness();
    const a = h.account();
    const good = a.add(); a.auto(good, () => ({ ok: true, result: { version: 1, instanceId: INSTANCE, privateExtra: 'never-forward' } }));
    const denied = a.add('h_denied'); a.auto(denied, () => ({ ok: false, error: 'denied' }));
    const old = a.add('h_old'); a.auto(old, () => ({ ok: true, result: { version: 0, instanceId: INSTANCE } }));
    const offline = a.add('h_offline'); offline.close();
    const ghost = a.add('h_ghost', 'host', false);
    h.account('github:200').add('h_foreign');
    expect(await content(await h.call(tool('computers_list')))).toEqual({ computers: [{ hostId: HOST, name: `name-${HOST}`, platform: 'test', online: true, version: 1, instanceId: INSTANCE }] });
    expect(good.frames[0].request).toEqual({ method: 'capabilities', params: {} });
    expect(offline.frames).toHaveLength(0);
    expect(ghost.frames).toHaveLength(0);
    expect(await content(await h.call(tool('capabilities', { hostId: 'h_foreign' })))).toEqual({ error: 'unavailable' });
    expect([...a.values.keys()].some((key) => key.startsWith('q:'))).toBe(false);
  });

  it('requires the asserted method scope before forwarding', async () => {
    const h = harness(); const ws = h.account().add();
    const value = tool('sessions_send', { hostId: HOST, instanceId: INSTANCE, projectId: 'p', sessionId: 's', admissionWindowId: randomUUID(), idempotencyKey: 'send', text: 'private prompt' });
    expect(await content(await h.call(value, { claims: { scopes: ['control:discover'] } }))).toEqual({ error: 'denied' });
    expect(ws.frames).toHaveLength(0);
  });

  it('accepts responses only from the targeted current registered host, never browsers or another host', async () => {
    const h = harness(); const a = h.account(); const target = a.add(); const wrong = a.add('h_wrong'); const browser = a.add('w_browser', 'web');
    const request = h.call(tool('capabilities', { hostId: HOST }));
    await sent(target);
    const id = target.frames[0].id;
    await a.reply(wrong, id, { ok: true, result: 'wrong' });
    await a.reply(browser, id, { ok: true, result: 'browser' });
    await a.reply(target, id, { ok: false, error: 'private exception containing token' });
    await a.reply(target, id, { ok: true, result: 'correct' });
    expect(await content(await request)).toBe('correct');
    expect([...a.values.keys()].some((key) => key.startsWith('q:'))).toBe(false);
  });

  it('drops revoked hosts, superseded sockets, late replies and disconnected fetches without replay', async () => {
    const h = harness(); const a = h.account(); const target = a.add();
    const revoked = h.call(tool('capabilities', { hostId: HOST })); await sent(target);
    a.values.delete(`device:${ACCOUNT}:${HOST}`);
    await a.reply(target, target.frames[0].id, { ok: true, result: 'revoked' });
    expect(await content(await revoked)).toEqual({ error: 'unavailable' });
    const next = a.add(); target.attachment = { controlCurrent: false };
    const abort = new AbortController();
    const request = h.call(tool('capabilities', { hostId: HOST }), { signal: abort.signal }); await sent(next);
    await a.reply(target, next.frames[0].id, { ok: true, result: 'stale' });
    abort.abort();
    expect(await content(await request)).toEqual({ error: 'unavailable' });
    await a.reply(next, next.frames[0].id, { ok: true, result: 'late' });
    a.auto(next, () => ({ ok: true, result: 'fresh' }));
    expect(await content(await h.call(tool('capabilities', { hostId: HOST })))).toBe('fresh');
    expect(next.frames).toHaveLength(2);
  });

  it('isolates concurrent controllers with identical JSON-RPC ids and routes explicit targets', async () => {
    const h = harness(); const a = h.account(); const one = a.add(); const two = a.add('h_other');
    const c2 = randomUUID();
    const r1 = h.call(tool('capabilities', { hostId: HOST }));
    const r2 = h.call(tool('capabilities', { hostId: 'h_other' }), { claims: { controllerId: c2 } });
    await sent(one); await sent(two);
    expect(one.frames[0].id).not.toBe(two.frames[0].id);
    expect(one.frames[0].principal.controllerId).toBe(CONTROLLER); expect(two.frames[0].principal.controllerId).toBe(c2);
    await a.reply(one, two.frames[0].id, { ok: true, result: 'spoof' });
    await a.reply(two, two.frames[0].id, { ok: true, result: 'two' });
    await a.reply(one, one.frames[0].id, { ok: true, result: 'one' });
    expect(await content(await r1)).toBe('one'); expect(await content(await r2)).toBe('two');
  });

  it('times out old/nonresponding hosts, then frees pending capacity without persisting or replaying', async () => {
    const h = harness(); const a = h.account(); const ws = a.add();
    const pending = h.call(tool('capabilities', { hostId: HOST })); await sent(ws);
    expect(await content(await pending)).toEqual({ error: 'unavailable' });
    await a.reply(ws, ws.frames[0].id, { ok: true, result: 'late' });
    a.auto(ws, () => ({ ok: true, result: 'next' }));
    expect(await content(await h.call(tool('capabilities', { hostId: HOST })))).toBe('next');
    expect(ws.frames).toHaveLength(2);
    expect([...a.values.keys()].filter((k) => !k.startsWith('device:')).sort()).toEqual(['__control_nonces__', '__vocs_account_id__']);
  });

  it('enforces controller and global in-flight caps and releases them on socket close', async () => {
    const h = harness(); const a = h.account(); const ws = a.add();
    const pending: Array<Promise<Response>> = [];
    for (let i = 0; i < CONTROL_MAX_HTTP; i++) {
      pending.push(h.call(tool('capabilities', { hostId: HOST }), { claims: { controllerId: i < CONTROL_MAX_CONTROLLER_HTTP ? CONTROLLER : randomUUID() } }));
      await sent(ws, i + 1);
      if (i === CONTROL_MAX_CONTROLLER_HTTP - 1) expect((await h.call(tool('capabilities', { hostId: HOST }))).status).toBe(429);
    }
    expect((await h.call(tool('capabilities', { hostId: HOST }), { claims: { controllerId: randomUUID() } })).status).toBe(429);
    ws.close(); await a.hub.webSocketClose(ws as never, 1000, 'gone');
    for (const request of pending) expect(await content(await request)).toEqual({ error: 'unavailable' });
    expect(ws.frames).toHaveLength(CONTROL_MAX_HTTP);
  });

  it('caps fan-out RPCs per controller and account even when HTTP requests are below their limits', async () => {
    for (const [controllerCount, limit] of [[2, CONTROL_MAX_CONTROLLER_PENDING], [8, CONTROL_MAX_PENDING]]) {
      const h = harness(); const a = h.account();
      const hosts = Array.from({ length: 5 }, (_, i) => a.add(`h_host${i}`));
      const pending: Array<Promise<Response>> = [];
      for (let i = 0; i < controllerCount; i++) pending.push(h.call(tool('computers_list'), { claims: { controllerId: controllerCount === 2 ? CONTROLLER : randomUUID() } }));
      await vi.waitFor(() => expect(hosts.reduce((n, host) => n + host.frames.length, 0)).toBe(limit));
      for (const host of hosts) { host.close(); await a.hub.webSocketClose(host as never, 1000, 'gone'); }
      for (const request of pending) expect(await content(await request)).toEqual({ computers: [] });
      expect(hosts.reduce((n, host) => n + host.frames.length, 0)).toBe(limit);
    }
  });

  it('admits exactly one concurrent replay and never dispatches the duplicate', async () => {
    const h = harness(); const a = h.account(); const ws = a.add();
    a.auto(ws, () => ({ ok: true, result: 'once' }));
    const request = signed(tool('capabilities', { hostId: HOST }));
    const replies = await Promise.all([h.dispatch(request.clone()), h.dispatch(request)]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 401]);
    expect(ws.frames).toHaveLength(1);
    expect(await content(replies.find((reply) => reply.status === 200)!)).toBe('once');
  });

  it('bounds enumeration and request rates plus persistent replay metadata', async () => {
    const h = harness();
    for (let i = 0; i < 6; i++) expect((await h.call(tool('computers_list'))).status).toBe(200);
    expect((await h.call(tool('computers_list'))).status).toBe(429);
    const h2 = harness();
    for (let i = 0; i < 60; i++) expect((await h2.call()).status).toBe(200);
    expect((await h2.call()).status).toBe(429);
    const h3 = harness();
    h3.account().values.set('__control_nonces__', Array.from({ length: CONTROL_NONCE_LIMIT }, () => ({ nonce: randomUUID(), expiresAt: Date.now() + 30_000 })));
    expect((await h3.call()).status).toBe(429);
    h3.account().values.set('__control_nonces__', [{ nonce: randomUUID(), expiresAt: Date.now() - 1 }]);
    expect((await h3.call()).status).toBe(200);
    expect(h3.account().values.get('__control_nonces__')).toHaveLength(1);
  });

  it('bounds request bytes (including chunked) and response bytes before returning content', async () => {
    const h = harness();
    expect((await h.call(undefined, { raw: 'a'.repeat(CONTROL_MAX_BYTES + 1) })).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(CONTROL_MAX_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
    expect((await h.dispatch(new Request(`https://relay.test${CONTROL_PATH}`, { method: 'POST', body: stream, duplex: 'half' } as RequestInit))).status).toBe(413);
    const a = h.account(); const ws = a.add();
    a.auto(ws, () => ({ ok: true, result: 'x'.repeat(CONTROL_MAX_BYTES) }));
    expect(await content(await h.call(tool('capabilities', { hostId: HOST })))).toEqual({ error: 'unavailable' });
    // A frame under the cap can grow when wrapped in MCP JSON. Enforce the final boundary too.
    a.auto(ws, () => ({ ok: true, result: '"'.repeat(70_000) }));
    expect((await h.call(tool('capabilities', { hostId: HOST }))).status).toBe(413);
    expect(h.errors).toEqual([]);
  });
});
