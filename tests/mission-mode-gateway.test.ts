/**
 * The Mission gateway is the one door the Mission tools go through. A session's token lists and
 * accepts only its own role's tools, is refused the moment the session leaves its mission (or
 * changes role or mission), never reaches a log or a reply, and the listener refuses browser and
 * DNS-rebinding traffic like the memory gateway. MCP resolution hands the server only to a session
 * the gateway attaches, on a harness that can take a Mission role.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionGateway } from '../src/main/mission-mode/gateway';
import type { MissionSessionIdentity, MissionToolCall, MissionToolResult } from '../src/main/mission-mode/contracts';
import { missionToolSchemas, validateMissionToolArgs } from '../src/main/mission-mode/tools';
import { MISSION_GATEWAY_TOKEN_ENV, MISSION_GATEWAY_URL_ENV, resolveForSession } from '../src/main/mcp';
import { defaultSettings } from '../src/main/settings';
import { BUILDER_TOOLS, LEAD_TOOLS, type MissionTool } from '../src/shared/mission-mode';
import type { HarnessId } from '../src/shared/types';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

type Attachment = { url: string; token: string };

async function fixture(handle: (call: MissionToolCall) => Promise<MissionToolResult> = async (call) => ({ text: `${call.role}:${call.tool}` })) {
  const identities = new Map<string, MissionSessionIdentity | null>([
    ['lead', { missionId: 'm1', role: 'lead' }],
    ['builder', { missionId: 'm1', role: 'builder' }]
  ]);
  const call = vi.fn(handle);
  const log = vi.fn();
  const gateway = new MissionGateway({ identity: (id) => identities.get(id) ?? null, handler: { call }, log });
  cleanup.push(() => gateway.close());
  const attach = async (id: string): Promise<Attachment> => {
    const attachment = await gateway.ensureAttachment(id);
    if (!attachment) throw new Error(`no attachment for ${id}`);
    return attachment;
  };
  return { gateway, identities, call, log, attach };
}

function post(config: Attachment, route: '/list' | '/call', body: string, opts: { method?: string; headers?: OutgoingHttpHeaders; path?: string } = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; text: string; json: any }>((resolve, reject) => {
    const req = request(`${config.url}${opts.path ?? route}`, {
      method: opts.method ?? 'POST', agent: false, signal: AbortSignal.timeout(5_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}`, ...opts.headers }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, headers: res.headers, text, json: JSON.parse(text) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const list = (config: Attachment) => post(config, '/list', '{}');
const callTool = (config: Attachment, tool: string, args: Record<string, unknown> = {}) => post(config, '/call', JSON.stringify({ tool, arguments: args }));

const validArgs: Record<MissionTool, Record<string, unknown>> = {
  start_builder: { title: 'Parser', task: 'Write the parser and its tests.' },
  message_builder: { builderId: 'b1', text: 'Use the existing tokenizer.' },
  answer_request: { requestId: 'r1', decision: 'deny', note: 'Not inside the mission.' },
  list_builders: {},
  wait_for_builders: {},
  builder_diff: { builderId: 'b1', stat: true },
  builder_log: { builderId: 'b1' },
  record_check: { builderId: 'b1', passed: false, note: 'Two tests fail.' },
  accept_builder: { builderId: 'b1' },
  stop_builder: { builderId: 'b1' },
  finish_mission: { task: 'Add a parser', done: ['Parser'], decisions: [], files: ['src/parser.ts'], verification: ['npm test: pass'] },
  ask_lead: { question: 'Keep the old API?' },
  report_done: { summary: 'Parser done.', verification: ['npm test: pass'] },
  report_blocked: { reason: 'The fixture is missing.' },
  land_on_lead: {}
};

describe('Mission tool schemas', () => {
  it('lists each role exactly its own tools, with bounded strict schemas and read-only hints', () => {
    const lead = missionToolSchemas('lead');
    const builder = missionToolSchemas('builder');
    expect(lead.map((t) => t.name)).toEqual([...LEAD_TOOLS]);
    expect(builder.map((t) => t.name)).toEqual([...BUILDER_TOOLS]);
    for (const tool of [...lead, ...builder]) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.inputSchema).not.toHaveProperty('$schema');
      expect(tool.annotations).toEqual({ title: tool.name, readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    }
    expect(lead.find((t) => t.name === 'start_builder')!.inputSchema).toMatchObject({ required: ['title', 'task'], properties: { title: { maxLength: 120 }, own_worktree: { type: 'boolean' } } });
  });

  it.each(Object.keys(validArgs) as MissionTool[])('accepts valid %s arguments and refuses extra or oversized fields', (tool) => {
    expect(validateMissionToolArgs(tool, validArgs[tool])).toEqual({ ok: true, args: validArgs[tool] });
    const extra = validateMissionToolArgs(tool, { ...validArgs[tool], sessionId: 'someone-else' });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.error).toContain('sessionId');
  });

  it('refuses blank, missing and unbounded values without echoing them', () => {
    expect(validateMissionToolArgs('start_builder', { title: '   ', task: 'x' }).ok).toBe(false);
    expect(validateMissionToolArgs('start_builder', { title: 'ok' }).ok).toBe(false);
    const huge = validateMissionToolArgs('message_builder', { builderId: 'b1', text: 'secret '.repeat(5_000) });
    expect(huge).toEqual({ ok: false, error: expect.not.stringContaining('secret') });
    expect(validateMissionToolArgs('finish_mission', { ...validArgs.finish_mission, done: Array(101).fill('x') }).ok).toBe(false);
  });
});

describe('Mission gateway', () => {
  it('binds the loopback address and only starts for a session in a live mission', async () => {
    const f = await fixture();
    expect(await f.gateway.ensureAttachment('stranger')).toBeNull();
    expect(f.gateway.state().listening).toBe(false);
    const lead = await f.attach('lead');
    expect(lead.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(lead.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(f.gateway.attach('stranger')).toBeNull();
    // An unchanged identity re-attaches to the same capability (a restarted runtime agrees with its predecessor).
    expect(f.gateway.attach('lead')).toEqual(lead);
    expect(f.gateway.state()).toEqual({ listening: true, sessions: 1 });
  });

  it('lists and dispatches by the token’s role: a Builder token cannot reach a Lead tool', async () => {
    const f = await fixture();
    const lead = await f.attach('lead');
    const builder = await f.attach('builder');
    expect((await list(lead)).json.tools.map((t: { name: string }) => t.name)).toEqual([...LEAD_TOOLS]);
    expect((await list(builder)).json.tools.map((t: { name: string }) => t.name)).toEqual([...BUILDER_TOOLS]);

    const refused = await callTool(builder, 'start_builder', validArgs.start_builder);
    expect(refused.status).toBe(200);
    expect(refused.json.result).toEqual({ content: [{ type: 'text', text: 'Unknown Mission tool for a Builder.' }], isError: true });
    expect((await callTool(lead, 'ask_lead', validArgs.ask_lead)).json.result.isError).toBe(true);
    expect(f.call).not.toHaveBeenCalled();

    const started = await callTool(lead, 'start_builder', { ...validArgs.start_builder, own_worktree: true });
    expect(started.json).toEqual({ result: { content: [{ type: 'text', text: 'lead:start_builder' }] } });
    const asked = await callTool(builder, 'ask_lead', validArgs.ask_lead);
    expect(asked.json.result.content[0].text).toBe('builder:ask_lead');
    expect(f.call.mock.calls.map(([c]) => c)).toEqual([
      { sessionId: 'lead', missionId: 'm1', role: 'lead', tool: 'start_builder', args: { ...validArgs.start_builder, own_worktree: true } },
      { sessionId: 'builder', missionId: 'm1', role: 'builder', tool: 'ask_lead', args: validArgs.ask_lead }
    ]);
  });

  it('validates arguments before the service sees them', async () => {
    const f = await fixture();
    const lead = await f.attach('lead');
    const bad = await callTool(lead, 'start_builder', { title: 'x', task: 'y', sessionId: 'builder' });
    expect(bad.json.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('sessionId') }] });
    expect((await callTool(lead, 'record_check', { builderId: 'b1', passed: 'yes' })).json.result.isError).toBe(true);
    expect(f.call).not.toHaveBeenCalled();
  });

  it('refuses a token after revoke, and drops it for good when the session leaves or changes its mission or role', async () => {
    const f = await fixture();
    const lead = await f.attach('lead');
    f.gateway.revoke('lead');
    expect((await list(lead)).status).toBe(401);

    for (const change of [null, { missionId: 'm2', role: 'lead' as const }, { missionId: 'm1', role: 'builder' as const }]) {
      f.identities.set('lead', { missionId: 'm1', role: 'lead' });
      const token = await f.attach('lead');
      expect((await list(token)).status).toBe(200);
      f.identities.set('lead', change);
      const denied = await callTool(token, 'list_builders');
      expect(denied.status).toBe(403);
      expect(denied.json).toEqual({ error: 'This session may no longer use the Mission tools' });
      // Restoring the identity does not revive the dropped capability.
      f.identities.set('lead', { missionId: 'm1', role: 'lead' });
      expect((await list(token)).status).toBe(401);
    }
    expect(f.call).not.toHaveBeenCalled();
  });

  it('withholds a result when the session leaves its mission while the call runs', async () => {
    let release!: () => void;
    const f = await fixture(() => new Promise((resolve) => { release = () => resolve({ text: 'started b1' }); }));
    const lead = await f.attach('lead');
    const pending = callTool(lead, 'start_builder', validArgs.start_builder);
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(1));
    f.identities.set('lead', null);
    release();
    const reply = await pending;
    expect(reply.status).toBe(403);
    expect(reply.text).not.toContain('started b1');
  });

  it('rejects browser, rebinding and malformed traffic before dispatch, and never echoes the token', async () => {
    const f = await fixture();
    const lead = await f.attach('lead');
    const host = new URL(lead.url).host;
    const cases: [number, Parameters<typeof post>[3], string?][] = [
      [401, { headers: { Authorization: '' } }],
      [401, { headers: { Authorization: `Bearer ${'A'.repeat(43)}` } }],
      [401, { headers: { Authorization: [`Bearer ${lead.token}`, `Bearer ${lead.token}`] } }],
      [403, { headers: { Host: 'localhost' } }],
      [403, { headers: { Host: host.replace('127.0.0.1', 'evil.test') } }],
      [403, { headers: { Origin: '' } }],
      [403, { headers: { Origin: 'https://evil.test' } }],
      [403, { headers: { 'Sec-Fetch-Site': 'cross-site' } }],
      [403, { path: '/call?x=1' }],
      [403, { path: '/tools' }],
      [405, { method: 'GET' }, ''],
      [415, { headers: { 'Content-Type': 'text/plain' } }],
      [400, {}, '{'],
      [400, {}, '[]'],
      [400, {}, JSON.stringify({ tool: 'list_builders', arguments: {}, sessionId: 'builder' })],
      [400, {}, JSON.stringify({ tool: 'message_builder', arguments: { builderId: 'b1', text: `leak ${lead.token}` } })],
      [413, { headers: { 'Content-Length': 1_000_001 } }, '']
    ];
    for (const [status, opts, body] of cases) {
      const reply = await post(lead, '/call', body ?? JSON.stringify({ tool: 'list_builders', arguments: {} }), opts);
      expect(reply.status, JSON.stringify(opts)).toBe(status);
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
      expect(reply.text).not.toContain(lead.token);
    }
    expect((await post(lead, '/list', JSON.stringify({ role: 'lead' }))).status).toBe(400);
    expect(f.call).not.toHaveBeenCalled();
    expect(f.log).not.toHaveBeenCalled();
  });

  it('redacts the token from a result and keeps tool failures out of the reply', async () => {
    let token = '';
    const f = await fixture(async (call) => {
      if (call.tool === 'stop_builder') throw new Error(`exploded near ${token}`);
      return { text: `echo ${token}`, isError: true };
    });
    const lead = await f.attach('lead');
    token = lead.token;
    expect((await callTool(lead, 'list_builders')).json.result).toEqual({ content: [{ type: 'text', text: 'echo <redacted>' }], isError: true });
    const failed = await callTool(lead, 'stop_builder', { builderId: 'b1' });
    expect(failed.json.result).toEqual({ content: [{ type: 'text', text: 'The Mission tool could not complete the call.' }], isError: true });
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(token);
  });

  it('closes cleanly and refuses every capability afterwards', async () => {
    const f = await fixture();
    const lead = await f.attach('lead');
    await f.gateway.close();
    expect(f.gateway.state()).toEqual({ listening: false, sessions: 0 });
    await expect(list(lead)).rejects.toThrow();
    expect(f.gateway.attach('lead')).toBeNull();
  });
});

describe('the vocs-mission stdio client', () => {
  interface Reply { id: number; result?: any; error?: { code: number; message: string } }

  function spawnClient(env: NodeJS.ProcessEnv) {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^VOCS_MISSION_/i.test(key)));
    const child = spawn(process.execPath, [path.resolve('resources', 'mcp', 'vocs-mission.mjs')], { env: { ...inherited, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const exit = once(child, 'close');
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    const replies: Reply[] = [];
    createInterface({ input: child.stdout }).on('line', (line) => replies.push(JSON.parse(line) as Reply));
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exit;
    });
    let id = 0;
    const rpc = async (method: string, params?: unknown) => {
      const mine = ++id;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mine, method, params })}\n`);
      return vi.waitFor(() => {
        const reply = replies.find((r) => r.id === mine);
        if (!reply) throw new Error(`no reply to ${method}`);
        return reply;
      }, { timeout: 10_000 });
    };
    return { rpc, output: () => output };
  }

  it('relays list and call through the real gateway and never prints the token', async () => {
    const f = await fixture();
    const lead = await f.attach('lead');
    const client = spawnClient({ [MISSION_GATEWAY_URL_ENV]: lead.url, [MISSION_GATEWAY_TOKEN_ENV]: lead.token });
    const init = await client.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.result.serverInfo).toEqual({ name: 'vocs-mission', version: '1.0.0' });
    const tools = (await client.rpc('tools/list')).result.tools as { name: string; annotations: unknown }[];
    expect(tools.map((t) => t.name)).toEqual([...LEAD_TOOLS]);
    expect(tools[0].annotations).toEqual({ title: 'start_builder', readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect((await client.rpc('tools/call', { name: 'start_builder', arguments: validArgs.start_builder })).result).toEqual({ content: [{ type: 'text', text: 'lead:start_builder' }] });
    expect((await client.rpc('tools/call', { name: 'report_done', arguments: validArgs.report_done })).result.isError).toBe(true);
    f.gateway.revoke('lead');
    expect((await client.rpc('tools/call', { name: 'list_builders', arguments: {} })).result).toEqual({
      content: [{ type: 'text', text: 'The Mission gateway denied this call: this session is no longer part of a live mission.' }], isError: true
    });
    expect((await client.rpc('tools/list')).result.tools).toEqual([]);
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(client.output()).not.toContain(lead.token);
  });

  it.each([
    { label: 'no gateway', env: {} },
    { label: 'a non-loopback endpoint', env: { [MISSION_GATEWAY_URL_ENV]: 'http://example.test:80', [MISSION_GATEWAY_TOKEN_ENV]: 'A'.repeat(43) } },
    { label: 'a malformed token', env: { [MISSION_GATEWAY_URL_ENV]: 'http://127.0.0.1:9', [MISSION_GATEWAY_TOKEN_ENV]: 'short' } }
  ])('fails closed with $label', async ({ env }) => {
    const client = spawnClient(env);
    expect((await client.rpc('tools/list')).result.tools).toEqual([]);
    expect((await client.rpc('tools/call', { name: 'list_builders', arguments: {} })).result.isError).toBe(true);
    expect(client.output()).not.toContain('short');
  });
});

describe('MCP resolution of the Mission server', () => {
  const dirs: string[] = [];
  const savedHome = process.env.GITNEXUS_HOME;
  beforeEach(async () => {
    // An empty code-graph registry, so no shared GitNexus server is in play.
    process.env.GITNEXUS_HOME = await mkdtemp(path.join(tmpdir(), 'vocs-mission-gn-'));
    dirs.push(process.env.GITNEXUS_HOME);
  });
  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function resolve(harness: HarnessId, sessionId: string, gateway?: { attach: (id: string) => Attachment | null; revoke: (id: string) => void }) {
    const project = await mkdtemp(path.join(tmpdir(), 'vocs-mission-proj-'));
    dirs.push(project);
    const servers = await resolveForSession(
      { settings: defaultSettings(), cwd: project, projectRoot: project, harness, sessionId },
      { getSecret: async () => undefined, ...(gateway ? { missionGateway: gateway, missionServerPath: path.resolve('resources', 'mcp', 'vocs-mission.mjs') } : {}) }
    );
    return servers.filter((s) => s.def.id === 'vocs-mission');
  }

  const attachment = { url: 'http://127.0.0.1:4567', token: 'T'.repeat(43) };

  it('adds the server, token marked secret and app provenance set, for an attached session on a Mission harness', async () => {
    for (const harness of ['claude', 'codex', 'pi', 'native', 'acp'] as const) {
      const attach = vi.fn(() => attachment);
      const [server, ...rest] = await resolve(harness, 's1', { attach, revoke: vi.fn() });
      expect(rest).toEqual([]);
      expect(attach).toHaveBeenCalledWith('s1');
      expect(server.def).toMatchObject({ id: 'vocs-mission', builtin: 'vocs-mission', transport: 'stdio', args: [path.resolve('resources', 'mcp', 'vocs-mission.mjs')] });
      expect(path.isAbsolute(server.def.command!)).toBe(true);
      expect(server.def.env).toMatchObject({ [MISSION_GATEWAY_URL_ENV]: attachment.url, [MISSION_GATEWAY_TOKEN_ENV]: attachment.token });
      expect(server.secretEnvKeys).toEqual([MISSION_GATEWAY_TOKEN_ENV]);
    }
  });

  it('adds nothing for an ordinary session, an unattached one, or a harness without a Mission role', async () => {
    expect(await resolve('claude', 's1')).toEqual([]);
    expect(await resolve('claude', 's1', { attach: () => null, revoke: vi.fn() })).toEqual([]);
    for (const harness of ['codex-exec', 'antigravity'] as const) {
      const attach = vi.fn(() => attachment);
      expect(await resolve(harness, 's1', { attach, revoke: vi.fn() })).toEqual([]);
      expect(attach).not.toHaveBeenCalled();
    }
  });
});
