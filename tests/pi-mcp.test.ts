/**
 * Offline tests for the pi MCP bridge. The stdio path runs a real MCP server — the fixture in
 * tests/fixtures — with this process's own node binary, so nothing here needs the network.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolRequest, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PiMcpConnection } from '../resources/pi/mcp-client';
import vocsCodeMcp, { closeMcpBridge, mcpReadOnlyToolNames, mcpToolNames, parseMcpConfig, promptSnippetFor, registerMcpTools, sanitizeToolName, toolNameFor } from '../resources/pi/vocs-code-mcp';
import { MissionToolBroker } from '../src/main/mission/tools';
import { reduceMission, type MissionMutation } from '../src/main/mission/state';
import { missionFixture } from './support/mission-fixture';
import { PiOfflineRunner, piIntegrationPaths, type PiEvent } from './pi-offline-runner';

const FIXTURE = path.resolve('tests/fixtures/mcp-echo-server.mjs');
const MEMORY_SERVER = path.resolve('resources/mcp/vocs-memory.mjs');
const STAMP = 'VOCSMCP9137';

type Pi = Parameters<typeof vocsCodeMcp>[0];
type ToolDef = Parameters<Pi['registerTool']>[0];

function makePi(): { pi: Pi; tools: ToolDef[]; handlers: Map<string, (event: unknown, ctx: unknown) => unknown> } {
  const tools: ToolDef[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi: Pi = {
    registerTool: (def) => {
      tools.push(def);
    },
    on: (event, handler) => {
      handlers.set(event, handler);
    }
  };
  return { pi, tools, handlers };
}

afterEach(() => {
  delete process.env.VOCS_CODE_MCP_CONFIG;
  // The bridge is process-wide by design; each test starts from a clean one.
  closeMcpBridge();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The SDK produces the real JSON-RPC InvalidParams envelope, not a mocked client rejection. */
async function missionServer(invoke: (params: CallToolRequest['params']) => Promise<CallToolResult> | CallToolResult) {
  const authorization = 'Bearer pi-mission-test-secret_0123456789abcdefghijkl';
  const headers = { Authorization: authorization, 'X-Mission-Fixture': 'private-header-value' };
  const calls: CallToolRequest['params'][] = [];
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== authorization) { res.writeHead(401).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    const server = new Server({ name: 'mission-fixture', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ['mission_read', 'mission_report', 'mission_plan_update'].map((name) => ({
      name, inputSchema: { type: 'object' as const, properties: { payload: { type: 'object' }, expectedRevision: { type: 'integer' }, idempotencyKey: { type: 'string' } } },
    })) }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls.push(request.params);
      return invoke(request.params);
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const def = { id: 'vocs-mission', transport: 'http', url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, headers };
  return { def, calls, authorization, token: authorization.slice('Bearer '.length), close: () => new Promise<void>((resolve) => { http.closeAllConnections(); http.close(() => resolve()); }) };
}

function managedMission(def: object): void {
  vi.stubEnv('VOCS_CODE_MCP_CONFIG', '');
  vi.stubEnv('VOCS_CODE_MISSION_POLICY', JSON.stringify({ role: 'lead', sourceAccess: 'read_only', requestedTools: [] }));
  vi.stubEnv('VOCS_CODE_MCP_EPHEMERAL', JSON.stringify({ servers: [def] }));
}

describe('toolNameFor', () => {
  it('lowercases camelCase and namespaces the server', () => {
    expect(toolNameFor('GitNexus', 'readFile')).toBe('mcp__gitnexus__readfile');
  });

  it('replaces dots and other punctuation with underscores', () => {
    expect(toolNameFor('my.server', 'get-user.profile')).toBe('mcp__my_server__get_user_profile');
  });

  it('never starts a segment with a digit', () => {
    expect(sanitizeToolName('1st tool')).toBe('_1st_tool');
    expect(sanitizeToolName('2server')).toBe('_2server');
    expect(toolNameFor('2server', '9lives')).toBe('mcp___2server___9lives');
  });

  it('collapses repeated separators and keeps long names intact', () => {
    expect(sanitizeToolName('a...b')).toBe('a_b');
    const long = 'a'.repeat(120) + '.Tool';
    const name = toolNameFor('server', long);
    expect(name).toBe('mcp__server__' + 'a'.repeat(120) + '_tool');
    expect(name.length).toBeGreaterThan(120);
    expect(name).toMatch(/^[a-z0-9_]+$/);
  });
});

describe('promptSnippetFor', () => {
  it('collapses a multi-line description to one line', () => {
    expect(promptSnippetFor('Says it back.\n\n  Stamped  ', 'echo')).toBe('Says it back. Stamped');
  });

  it('clips a long description at a word boundary', () => {
    const snippet = promptSnippetFor('word '.repeat(60), 'echo');
    expect(snippet.length).toBeLessThanOrEqual(121);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).not.toContain('  ');
  });

  it('falls back to the tool name when the server sends no description', () => {
    expect(promptSnippetFor(undefined, 'echo')).toBe('MCP tool echo');
    expect(promptSnippetFor('   ', 'echo')).toBe('MCP tool echo');
  });
});

describe('parseMcpConfig', () => {
  it('tolerates garbage', () => {
    expect(parseMcpConfig(null)).toEqual([]);
    expect(parseMcpConfig('nope')).toEqual([]);
    expect(parseMcpConfig({})).toEqual([]);
    expect(parseMcpConfig({ servers: 'nope' })).toEqual([]);
    expect(parseMcpConfig({ servers: [null, 1, 'x', {}] })).toEqual([]);
  });

  it('drops entries missing the required fields for their transport', () => {
    expect(
      parseMcpConfig({
        servers: [
          { id: 'no-transport', command: 'npx' },
          { id: 'stdio-no-command', transport: 'stdio' },
          { id: 'stdio-blank', transport: 'stdio', command: '   ' },
          { id: 'http-no-url', transport: 'http' },
          { id: 'sse-no-url', transport: 'sse' },
          { transport: 'stdio', command: 'npx' }
        ]
      })
    ).toEqual([]);
  });

  it('normalizes the fields it keeps', () => {
    expect(
      parseMcpConfig({
        servers: [
          { id: ' local ', transport: 'stdio', command: 'npx', args: ['-y', 3, 'pkg'], env: { A: 'b', B: 2 }, timeoutMs: 1500 },
          { id: 'remote', transport: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer x', N: 1 } }
        ]
      })
    ).toEqual([
      { id: 'local', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { A: 'b' }, timeoutMs: 1500 },
      { id: 'remote', transport: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer x' } }
    ]);
  });
});

describe('sse transport', () => {
  it('throws instead of silently doing nothing', async () => {
    await expect(PiMcpConnection.connect({ id: 'legacy', transport: 'sse', url: 'https://example.invalid/mcp' })).rejects.toThrow(/sse/);
  });
});

describe('PiMcpConnection against a real stdio server', () => {
  it('initializes, lists the fixture tools and calls one', async () => {
    const connection = await PiMcpConnection.connect({ id: 'fixture', transport: 'stdio', command: process.execPath, args: [FIXTURE] });
    try {
      const tools = await connection.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(['echo', 'probe']);
      const echo = tools.find((tool) => tool.name === 'echo');
      expect(echo?.description).toBe('Says it back, stamped');
      expect(echo?.readOnly).toBe(false);
      expect((echo?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties).toHaveProperty('text');

      const result = await connection.callTool('echo', { text: 'ping' });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: 'text', text: `ping:${STAMP}` }]);
    } finally {
      connection.close();
    }
  }, 60_000);

  it('passes the configured env through to the server process', async () => {
    const connection = await PiMcpConnection.connect({
      id: 'fixture',
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE],
      env: { VOCS_TEST_VALUE: 'bridge-env' }
    });
    try {
      const result = await connection.callTool('probe', {});
      expect(result.content[0]?.text).toBe('bridge-env');
    } finally {
      connection.close();
    }
  }, 60_000);
});

describe('vocsCodeMcp extension', () => {
  it('registers the fixture tools and round-trips execute through the connection', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vocs-pi-mcp-'));
    const configPath = path.join(dir, 'mcp.json');
    await writeFile(
      configPath,
      JSON.stringify({ servers: [{ id: 'fixture', transport: 'stdio', command: process.execPath, args: [FIXTURE] }] }),
      'utf8'
    );
    process.env.VOCS_CODE_MCP_CONFIG = configPath;
    const { pi, tools, handlers } = makePi();
    try {
      await vocsCodeMcp(pi);
      expect(tools.map((tool) => tool.name).sort()).toEqual(['mcp__fixture__echo', 'mcp__fixture__probe']);
      expect(handlers.has('session_shutdown')).toBe(true);

      const echo = tools.find((tool) => tool.name === 'mcp__fixture__echo');
      expect(echo).toBeDefined();
      expect(echo?.label).toBe('fixture: echo');
      // Without a snippet pi leaves a custom tool out of its "Available tools" list entirely.
      expect(echo?.promptSnippet).toBe('Says it back, stamped');
      // Only the built-in code graph carries a guideline; a user server is listed, not nudged.
      expect(tools.every((tool) => tool.promptGuidelines === undefined)).toBe(true);
      expect(echo?.parameters).toMatchObject({ type: 'object', properties: { text: { type: 'string' } } });

      const result = await echo!.execute('call-1', { text: 'hello' });
      expect(result.content).toEqual([{ type: 'text', text: `hello:${STAMP}` }]);
      expect(result.details).toEqual({ server: 'fixture', tool: 'echo' });

      handlers.get('session_shutdown')!(undefined, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('gives the code-graph server a guideline naming its tools', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vocs-pi-mcp-'));
    const configPath = path.join(dir, 'mcp.json');
    await writeFile(
      configPath,
      JSON.stringify({ servers: [{ id: 'gitnexus', transport: 'stdio', command: process.execPath, args: [FIXTURE] }] }),
      'utf8'
    );
    process.env.VOCS_CODE_MCP_CONFIG = configPath;
    const { pi, tools } = makePi();
    try {
      await vocsCodeMcp(pi);
      expect(tools.map((tool) => tool.name).sort()).toEqual(['mcp__gitnexus__echo', 'mcp__gitnexus__probe']);
      for (const tool of tools) {
        expect(tool.promptSnippet).toBeTruthy();
        expect(tool.promptGuidelines).toHaveLength(1);
        expect(tool.promptGuidelines?.[0]).toContain('mcp__gitnexus__*');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('does nothing when the config path is unset', async () => {
    delete process.env.VOCS_CODE_MCP_CONFIG;
    const { pi, tools, handlers } = makePi();
    await vocsCodeMcp(pi);
    expect(tools).toEqual([]);
    expect(handlers.size).toBe(0);
  });

  it('skips an unreachable server and still loads the others', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vocs-pi-mcp-'));
    const configPath = path.join(dir, 'mcp.json');
    await writeFile(
      configPath,
      JSON.stringify({
        servers: [
          { id: 'gone', transport: 'stdio', command: path.join(dir, 'not-a-program'), args: [], timeoutMs: 2_000 },
          { id: 'fixture', transport: 'stdio', command: process.execPath, args: [FIXTURE] }
        ]
      }),
      'utf8'
    );
    process.env.VOCS_CODE_MCP_CONFIG = configPath;
    const { pi, tools } = makePi();
    try {
      await vocsCodeMcp(pi);
      expect(tools.map((tool) => tool.name).sort()).toEqual(['mcp__fixture__echo', 'mcp__fixture__probe']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('managed Mission MCP errors at extension execute', () => {
  it('surfaces the live required-criterion rejection from an SDK InvalidParams response and keeps reads usable', async () => {
    const record = missionFixture({ revision: 12 });
    record.plan.criteria = [{ id: 'behavior', description: 'Required project verification: behavior', required: true, evidenceKinds: ['test'] }];
    const before = structuredClone(record);
    const request = { expectedRevision: 12, idempotencyKey: 'plan1', payload: { expectedPlanRevision: 0, plan: {
      ...record.plan, criteria: [{ ...record.plan.criteria[0], description: 'The behavioral requirement passes' }],
    } } };
    const fixture = await missionServer(({ name, arguments: args }) => {
      if (name === 'mission_read') return { content: [{ type: 'text', text: JSON.stringify(record) }] };
      try { reduceMission(record, { kind: 'lead', sessionId: record.leadSessionId, generation: record.leadGeneration }, { kind: 'plan.update', ...args!.payload as object } as MissionMutation); }
      catch (error) { throw new McpError(ErrorCode.InvalidParams, (error as Error).message); }
      throw new Error('The invalid plan must not be accepted');
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    managedMission(fixture.def);
    const { pi, tools } = makePi();
    try {
      await vocsCodeMcp(pi);
      expect(process.env.VOCS_CODE_MCP_EPHEMERAL).toBeUndefined();
      await expect(tools.find((tool) => tool.name === 'mission_plan_update')!.execute('plan', request)).rejects.toThrow('A model cannot remove or weaken an explicit required criterion.');
      const read = await tools.find((tool) => tool.name === 'mission_read')!.execute('read-after-error', { payload: {} });
      expect(JSON.parse(read.content[0].text!)).toEqual(before);
      expect(record).toEqual(before);
      expect(fixture.calls).toEqual([{ name: 'mission_plan_update', arguments: request }, { name: 'mission_read', arguments: { payload: {} } }]);
      expect(log).not.toHaveBeenCalled();
    } finally { closeMcpBridge(); await fixture.close(); }
  });

  it.each([
    'Expected revision 12; current revision is 13',
    'This operation belongs to the principal engineer',
    'Stale lead generation.',
    'Model payload cannot select identity, generation or user authority',
    'Mission snapshot failed after journal commit; explicitly reload before retrying',
  ])('preserves broker state/validation errors without claiming a connection failure or no effects: %s', async (detail) => {
    const broker = new MissionToolBroker({ validate: () => {}, invoke: async (_binding, name) => {
      if (name === 'mission_read') return { revision: 13 };
      throw new Error(detail);
    } });
    await broker.start();
    const server = broker.attach({ missionId: 'm1', actor: { kind: 'lead', sessionId: 'lead', generation: 1 } });
    managedMission(server.def);
    const { pi, tools } = makePi();
    try {
      await vocsCodeMcp(pi);
      const failure: unknown = await tools.find((tool) => tool.name === 'mission_plan_update')!.execute('plan', { expectedRevision: 12, idempotencyKey: 'plan1', payload: {} }).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      const text = (failure as Error).message;
      expect(text).toContain(detail);
      expect(text).not.toMatch(/connection|no (?:effects|changes)|not (?:applied|committed)/i);
      expect(text).toContain('mission_read');
      expect(text).toContain('idempotencyKey');
      expect(text).toContain('identical request');
      expect(text).toContain('new key');
      expect(text).toContain('may have committed');
      const read = await tools.find((tool) => tool.name === 'mission_read')!.execute('read', { payload: {} });
      expect(JSON.parse(read.content[0].text!)).toEqual({ revision: 13 });
    } finally { closeMcpBridge(); await broker.close(); }
  });

  it.each(['rpc', 'tool-result'])('redacts full authorization, bare bearer tokens and other headers before bounding a %s error', async (mode) => {
    let detail = '';
    const fixture = await missionServer(() => {
      if (mode === 'rpc') throw new McpError(ErrorCode.InvalidParams, detail);
      return { isError: true, content: [{ type: 'text', text: detail }] };
    });
    detail = `Invalid expectedRevision: ${fixture.authorization}; bare=${fixture.token}; other=${fixture.def.headers['X-Mission-Fixture']}; ` +
      `${'x'.repeat(850)}${fixture.token}${'z'.repeat(2000)}\nheaders: ${JSON.stringify(fixture.def.headers)}\n    at fetchWithAuth (http://127.0.0.1:12345/private-network-stack:1:1)`;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    managedMission(fixture.def);
    const { pi, tools } = makePi();
    try {
      await vocsCodeMcp(pi);
      const failure: unknown = await tools.find((tool) => tool.name === 'mission_plan_update')!.execute('plan', { payload: {} }).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      const text = (failure as Error).message;
      expect(text).toContain('Invalid expectedRevision');
      expect(text).toContain('[redacted]');
      expect(text).toContain('…');
      expect(text.length).toBeLessThanOrEqual(1600);
      for (const secret of [fixture.authorization, fixture.token, fixture.token.slice(0, 12), fixture.def.headers['X-Mission-Fixture']]) expect(text).not.toContain(secret);
      expect(text).not.toMatch(/headers|Authorization|fetchWithAuth|private-network-stack/);
      expect(log).not.toHaveBeenCalled();
    } finally { closeMcpBridge(); await fixture.close(); }
  });

  it.each(['transport', 'internal-rpc'])('keeps unknown %s failures generic, secret-free and without a raw network stack', async (mode) => {
    let detail = '';
    const fixture = await missionServer(({ name }) => {
      if (name === 'mission_read') return { content: [{ type: 'text', text: 'still usable' }] };
      throw new McpError(ErrorCode.InternalError, detail);
    });
    detail = `fetch failed: ${fixture.authorization}; bare=${fixture.token}\n    at privateNetworkStack (node:internal/fetch:1:1)`;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    managedMission(fixture.def);
    const { pi, tools } = makePi();
    try {
      await vocsCodeMcp(pi);
      if (mode === 'transport') vi.spyOn(PiMcpConnection.prototype, 'callTool').mockRejectedValueOnce(new Error(detail));
      const failure: unknown = await tools.find((tool) => tool.name === 'mission_plan_update')!.execute('plan', { payload: {} }).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      const text = (failure as Error).message;
      expect(text).toContain('Mission coordination request failed; the connection may have been revoked.');
      expect(text).toContain('mission_read');
      expect(text).toContain('idempotencyKey');
      expect(text).not.toContain(fixture.token);
      expect(text).not.toMatch(/fetch failed|privateNetworkStack|node:internal/);
      expect((await tools.find((tool) => tool.name === 'mission_read')!.execute('read', { payload: {} })).content).toEqual([{ type: 'text', text: 'still usable' }]);
      expect(log).not.toHaveBeenCalled();
    } finally { closeMcpBridge(); await fixture.close(); }
  });
});

describe.skipIf(process.env.VOCS_CODE_PI_INTEGRATION !== '1')('Mission MCP errors in real Pi model context (offline)', () => {
  it('loads the shipped extension through Jiti, delivers sanitized InvalidParams to the next model turn and reads again', async () => {
    const { resources } = piIntegrationPaths(); // An explicitly selected but absent runtime fails.
    const root = await mkdtemp(path.join(tmpdir(), 'vocs-pi-mcp-model-'));
    const agentDir = path.join(root, 'agent');
    await mkdir(agentDir);
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
    const mcpConfig = path.join(root, 'mcp.json');
    await writeFile(mcpConfig, JSON.stringify({ servers: [] }));
    const observer = path.join(root, 'observe-context.mjs');
    // Observe Pi's actual next model input, not just the earlier tool_execution_end event.
    await writeFile(observer, `export default function(pi) { pi.on('context', (event, ctx) => {
      ctx.ui.notify('PI_MISSION_CONTEXT::' + JSON.stringify(event.messages.filter(message => message.role === 'toolResult')), 'info');
    }); }`);
    const reason = 'A model cannot remove or weaken an explicit required criterion.';
    const fixture = await missionServer(({ name }) => {
      if (name === 'mission_read') return { content: [{ type: 'text', text: 'mission revision 12 still readable' }] };
      throw new McpError(ErrorCode.InvalidParams, `${reason} ${fixture.authorization}; ${fixture.token}\n    at privateNetworkStack (node:internal/fetch:1:1)`);
    });
    managedMission(fixture.def);
    let runner: PiOfflineRunner | undefined;
    try {
      runner = new PiOfflineRunner({ cwd: root, agentDir, mcpConfig, extraArgs: ['--no-session', '-e', path.join(resources, 'vocs-code-mission.ts'), '-e', observer] });
      await runner.ready();
      const events = await runner.prompt([{ id: 'plan-error', name: 'mission_plan_update', arguments: { expectedRevision: 12, idempotencyKey: 'plan1', payload: {} } }]);
      const ends = events.filter((event) => event.type === 'tool_execution_end');
      expect(ends).toHaveLength(1);
      expect(ends[0]).toMatchObject({ toolCallId: 'plan-error', isError: true });
      expect(JSON.stringify(ends[0].result.content)).toContain(reason);
      const contexts: PiEvent[][] = events.filter((event) => event.message?.startsWith?.('PI_MISSION_CONTEXT::'))
        .map((event) => JSON.parse(event.message.slice('PI_MISSION_CONTEXT::'.length)));
      const results = contexts.at(-1)!;
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ toolCallId: 'plan-error', isError: true });
      expect(JSON.stringify(results[0].content)).toContain(reason);
      expect(JSON.stringify(results[0].content)).toContain('mission_read');
      const after = await runner.prompt([{ id: 'read-after-error', name: 'mission_read', arguments: { payload: {} } }]);
      expect(after.filter((event) => event.type === 'tool_execution_end')).toEqual([expect.objectContaining({ toolCallId: 'read-after-error', isError: false, result: expect.objectContaining({ content: [{ type: 'text', text: 'mission revision 12 still readable' }] }) })]);
      expect(fixture.calls.map((entry) => entry.name)).toEqual(['mission_plan_update', 'mission_read']);
      expect(runner.events.filter((event) => event.type === 'agent_settled')).toHaveLength(2);
      expect(runner.events.filter((event) => event.type === 'extension_error')).toHaveLength(0);
      expect((await runner.request('get_state')).isStreaming).toBe(false);
      expect((await runner.request('get_session_stats')).cost).toBe(0);
      const output = JSON.stringify(runner.events) + runner.stderr;
      expect(output).not.toContain(fixture.token);
      expect(output).not.toContain('privateNetworkStack');
      expect(output).not.toContain('connection may have been revoked');
    } finally {
      await runner?.close();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('shared MCP bridge (a child session reuses the parent connections)', () => {
  it('registers the same tools into a second session and exposes names plus the read-only set', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vocs-pi-bridge-'));
    const configPath = path.join(root, 'mcp.json');
    await writeFile(
      configPath,
      JSON.stringify({ servers: [{ id: 'vocs-memory', transport: 'stdio', command: process.execPath, args: [MEMORY_SERVER], env: { VOCS_MEMORY_ROOT: path.join(root, 'wiki') } }] }),
      'utf8'
    );
    process.env.VOCS_CODE_MCP_CONFIG = configPath;
    const parent = makePi();
    const child = makePi();
    try {
      await vocsCodeMcp(parent.pi);
      const registered = await registerMcpTools(child.pi);
      expect(registered).toBe(parent.tools.length);
      expect(child.tools.map((tool) => tool.name)).toEqual(parent.tools.map((tool) => tool.name));

      const names = await mcpToolNames();
      expect(names).toContain('mcp__vocs_memory__knowledge_search');
      const readOnly = await mcpReadOnlyToolNames();
      expect(readOnly.has('mcp__vocs_memory__knowledge_search')).toBe(true);
      expect(readOnly.has('mcp__vocs_memory__session_history_search')).toBe(true);
      expect(readOnly.has('mcp__vocs_memory__knowledge_propose')).toBe(false);

      // Executing from the second registration goes through the one connection.
      const search = child.tools.find((tool) => tool.name === 'mcp__vocs_memory__knowledge_search')!;
      const result = await search.execute('call-1', { query: 'anything' });
      expect(result.content[0]?.text).toContain('"results"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('resolves to nothing when no server is configured', async () => {
    expect(await mcpToolNames()).toEqual([]);
    expect((await mcpReadOnlyToolNames()).size).toBe(0);
  });
});
