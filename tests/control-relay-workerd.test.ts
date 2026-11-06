/** Enabled controller route in real workerd, with real SDK and authenticated TCP host sockets.
 *  Local-only: throwaway secrets/storage, no Cloudflare account, no deployment or provider. */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { unstable_startWorker } from 'wrangler';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ACCOUNT_ASSERTION_HEADER, createAccountAssertion } from '../relay/src/account';
import { CONTROLLER_ASSERTION_HEADER, CONTROL_PATH } from '../relay/src/control-auth';
import { CONTROL_TOOL_NAMES } from '../relay/src/control-mcp';
import { CONTROL_MAX_BYTES, CONTROL_SCOPES } from '../src/shared/control';
import { enrollTokenContext, generateIdentity, openSealedToKey, publicOf, sign, tokenProofPayload, type SealedToKey } from '../src/shared/crypto';

const root = path.resolve(import.meta.dirname, '..');
const accountId = 'github:98765';
const controllerId = randomUUID();
const instanceId = randomUUID();
const secret = randomBytes(32).toString('base64url');
const enroll = randomBytes(32).toString('base64url');
const deviceRoute = randomBytes(32).toString('base64url');
let server: Awaited<ReturnType<typeof unstable_startWorker>>;
let origin: string;
let persist: string;
const sockets: WebSocket[] = [];
const tool = (name: string, args: unknown = {}) => ({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name, arguments: args } });
type Frame = { t: string; id: string; hostId: string; principal: { accountId: string; controllerId: string; validUntil: number }; request: { method: string } };

async function start(): Promise<void> {
  server = await unstable_startWorker({
    config: path.join(root, 'relay/wrangler.jsonc'),
    bindings: { CONTROL_MCP_ENABLED: { type: 'plain_text', value: '1' }, ENROLL_TOKEN: { type: 'plain_text', value: enroll },
      ACCOUNT_ASSERTION_SECRET: { type: 'plain_text', value: secret }, DEVICE_ROUTE_SECRET: { type: 'plain_text', value: deviceRoute } },
    dev: { server: { hostname: '127.0.0.1', port: 0 }, persist, inspector: false, watch: false, logLevel: 'error' }
  });
  await server.ready;
  origin = (await server.url).origin;
}
beforeAll(async () => { persist = await mkdtemp(path.join(os.tmpdir(), 'vocs-control-relay-')); await start(); }, 60_000);
afterAll(async () => {
  for (const ws of sockets) ws.close();
  await server?.dispose();
  if (persist) await rm(persist, { recursive: true, force: true });
});
function headersFor(body: string, account = accountId, controller = controllerId): Record<string, string> {
  const payload = Buffer.from(JSON.stringify({ v: 1, accountId: account, controllerId: controller, scopes: [...CONTROL_SCOPES].sort(),
    expiresAt: Date.now() + 30_000, nonce: randomUUID(), bodyHash: createHash('sha256').update(body).digest('hex') })).toString('base64url');
  return { accept: 'application/json, text/event-stream', 'content-type': 'application/json',
    [CONTROLLER_ASSERTION_HEADER]: `${payload}.${createHmac('sha256', secret).update(`vocs.controller.assertion.v1\nPOST\n${CONTROL_PATH}\n${payload}`).digest('base64url')}` };
}
const rpc = (value: unknown, account = accountId) => {
  const body = JSON.stringify(value);
  return fetch(`${origin}${CONTROL_PATH}`, { method: 'POST', headers: headersFor(body, account), body });
};
async function result(response: Response): Promise<unknown> {
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const value = await response.json() as { result: { content: Array<{ text: string }> } };
  return JSON.parse(value.result.content[0].text);
}
async function enrollHost(name: string, account = accountId): Promise<{ hostId: string; access: string }> {
  const identity = await generateIdentity();
  const nonce = randomBytes(32).toString('base64url');
  const nonceHash = createHash('sha256').update(nonce).digest('hex');
  const grant = await fetch(`${origin}/v1/owner/enroll-grant`, { method: 'POST', headers: { authorization: `Bearer ${enroll}`, 'content-type': 'application/json',
    [ACCOUNT_ASSERTION_HEADER]: await createAccountAssertion(account, 'POST', '/v1/owner/enroll-grant', secret) }, body: JSON.stringify({ nonceHash }) });
  expect(grant.status).toBe(200); await grant.arrayBuffer();
  const redeemed = await fetch(`${origin}/v1/enroll/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce, name, platform: 'test', hostPub: publicOf(identity) }) });
  expect(redeemed.status).toBe(200);
  const registration = await redeemed.json() as { status: string; hostDeviceId: string; sealedToken: SealedToKey };
  expect(registration.status).toBe('registered');
  const hostId = registration.hostDeviceId;
  const refresh = await openSealedToKey(identity.enc, registration.sealedToken, enrollTokenContext(nonceHash, hostId));
  const challenge = await fetch(`${origin}/v1/token/challenge?device=${encodeURIComponent(hostId)}`, { method: 'POST', headers: { authorization: `Bearer ${refresh}` } });
  expect(challenge.status).toBe(200);
  const { challenge: value } = await challenge.json() as { challenge: string };
  const access = await fetch(`${origin}/v1/token?device=${encodeURIComponent(hostId)}`, { method: 'POST', headers: { authorization: `Bearer ${refresh}`, 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: value, signature: await sign(identity, tokenProofPayload(hostId, value)) }) });
  expect(access.status).toBe(200);
  return { hostId, access: (await access.json() as { accessToken: string }).accessToken };
}
async function connectHost(host: { hostId: string; access: string }) {
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/v1/ws/host?device=${encodeURIComponent(host.hostId)}`, { headers: { authorization: `Bearer ${host.access}` } });
  sockets.push(ws);
  const frames: Frame[] = [];
  const connection: { ws: WebSocket; frames: Frame[]; respond?: (frame: Frame) => Record<string, unknown> } = { ws, frames };
  ws.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as Frame;
    if (frame.t !== 'control.request') return;
    frames.push(frame);
    const reply = connection.respond?.(frame);
    if (reply) ws.send(JSON.stringify({ t: 'control.response', id: frame.id, ...reply }));
  });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return connection;
}

it('initializes and lists tools through the SDK, rejects browser auth/large bodies, and stays healthy', async () => {
  const client = new Client({ name: 'local-workerd', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}${CONTROL_PATH}`), { fetch: async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== 'POST') return fetch(request);
    const body = await request.text();
    return fetch(request.url, { method: 'POST', headers: { ...Object.fromEntries(request.headers), ...headersFor(body) }, body });
  } });
  await client.connect(transport);
  try { expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([...CONTROL_TOOL_NAMES].sort()); }
  finally { await client.close(); }
  const denied = await fetch(`${origin}${CONTROL_PATH}`, { method: 'POST', body: '{}', headers: { cookie: 'owner-session',
    [ACCOUNT_ASSERTION_HEADER]: await createAccountAssertion(accountId, 'POST', CONTROL_PATH, secret) } });
  expect(denied.status).toBe(401); await denied.arrayBuffer();
  const oversized = await fetch(`${origin}${CONTROL_PATH}`, { method: 'POST', body: 'x'.repeat(CONTROL_MAX_BYTES + 1) });
  expect(oversized.status).toBe(413); await oversized.arrayBuffer();
  expect(await result(await rpc(tool('computers_list')))).toEqual({ computers: [] });
});

it('keeps the nonce single-use through a real workerd process restart with the same storage', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const headers = headersFor(body);
  const first = await fetch(`${origin}${CONTROL_PATH}`, { method: 'POST', headers, body });
  expect(first.status).toBe(200); await first.arrayBuffer();
  await server.dispose();
  await start();
  const payload = JSON.parse(Buffer.from(headers[CONTROLLER_ASSERTION_HEADER].split('.')[0], 'base64url').toString()) as { expiresAt: number };
  expect(payload.expiresAt).toBeGreaterThan(Date.now()); // replay refusal, not merely expiry
  const replay = await fetch(`${origin}${CONTROL_PATH}`, { method: 'POST', headers, body });
  expect(replay.status).toBe(401); await replay.arrayBuffer();
}, 60_000);

it('binds real replies to current host sockets and accounts, discovers only approved online hosts, and never replays offline work', async () => {
  const host = await enrollHost('approved');
  const denied = await enrollHost('hidden-denied');
  const foreign = await enrollHost('hidden-foreign', 'github:12345');
  const approvedSocket = await connectHost(host);
  approvedSocket.respond = () => ({ ok: true, result: { version: 1, instanceId } });
  const deniedSocket = await connectHost(denied);
  deniedSocket.respond = () => ({ ok: false, error: 'denied' });
  const foreignSocket = await connectHost(foreign);
  foreignSocket.respond = () => ({ ok: true, result: { version: 1, instanceId } });
  expect(await result(await rpc(tool('computers_list')))).toEqual({ computers: [{ hostId: host.hostId, name: 'approved', platform: 'test', online: true, version: 1, instanceId }] });
  expect(foreignSocket.frames).toHaveLength(0);
  expect(approvedSocket.frames[0].principal).toMatchObject({ accountId, controllerId, validUntil: expect.any(Number) });
  expect(approvedSocket.frames[0].principal.validUntil).toBeLessThanOrEqual(Date.now() + 30_000);
  expect(await result(await rpc(tool('capabilities', { hostId: host.hostId }), 'github:12345'))).toEqual({ error: 'unavailable' });
  approvedSocket.respond = undefined;
  const pending = rpc(tool('capabilities', { hostId: host.hostId }));
  await vi.waitFor(() => expect(approvedSocket.frames).toHaveLength(2));
  // A new authenticated connection supersedes the old one without changing browser routing.
  const replacement = await connectHost(host);
  replacement.respond = () => ({ ok: true, result: 'replacement' });
  approvedSocket.ws.send(JSON.stringify({ t: 'control.response', id: approvedSocket.frames[1].id, ok: true, result: 'stale socket spoof' }));
  expect(await result(await pending)).toEqual({ error: 'unavailable' });
  expect(await result(await rpc(tool('capabilities', { hostId: host.hostId })))).toBe('replacement');
  await new Promise<void>((resolve) => { replacement.ws.once('close', resolve); replacement.ws.close(); });
  expect(await result(await rpc(tool('capabilities', { hostId: host.hostId })))).toEqual({ error: 'unavailable' });
  const reconnected = await connectHost(host);
  reconnected.respond = () => ({ ok: true, result: 'new request only' });
  expect(await result(await rpc(tool('capabilities', { hostId: host.hostId })))).toBe('new request only');
  expect(reconnected.frames).toHaveLength(1);
  expect(approvedSocket.frames).toHaveLength(2);
}, 60_000);
