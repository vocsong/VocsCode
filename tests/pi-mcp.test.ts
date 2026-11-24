/**
 * Offline tests for the pi MCP bridge. The stdio path runs a real MCP server — the fixture in
 * tests/fixtures — with this process's own node binary, so nothing here needs the network.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { PiMcpConnection } from '../resources/pi/mcp-client';
import vocsCodeMcp, { closeMcpBridge, mcpReadOnlyToolNames, mcpToolNames, parseMcpConfig, promptSnippetFor, registerMcpTools, sanitizeToolName, toolNameFor } from '../resources/pi/vocs-code-mcp';
import { gitnexusBaseDef } from '../src/main/mcp/gitnexus';
import { MEMORY_GATEWAY_TOKEN_ENV, MEMORY_GATEWAY_URL_ENV, vocsMemoryBaseDef } from '../src/main/mcp/memory';
import { PiOfflineRunner } from './pi-offline-runner';

const FIXTURE = path.resolve('tests/fixtures/mcp-echo-server.mjs');
const MEMORY_SERVER = path.resolve('resources/mcp/vocs-memory.mjs');
const GATEWAY_PROBE = path.resolve('tests/fixtures/mcp-memory-gateway-probe.mjs');
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
      // The host's own definition: the code-graph nudge follows its provenance, not the name.
      JSON.stringify({ servers: [{ ...gitnexusBaseDef(), command: process.execPath, args: [FIXTURE] }] }),
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

describe('Pi ephemeral memory gateway', () => {
  const url = 'http://127.0.0.1:9/tools';
  const token = 'pi-memory-test-token';
  const probe = { transport: 'stdio', command: process.execPath, args: [GATEWAY_PROBE] } as const;
  const memory = { ...vocsMemoryBaseDef(), ...probe, env: { [MEMORY_GATEWAY_URL_ENV]: url, [MEMORY_GATEWAY_TOKEN_ENV]: token } };

  it('scrubs the launch envelope before spawning either server and shares the authenticated connection with children', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vocs-pi-mcp-gateway-'));
    const file = path.join(dir, 'mcp.json');
    const legacy = { ...memory, env: { ...memory.env, [MEMORY_GATEWAY_TOKEN_ENV]: 'stale-file-token' } };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await writeFile(file, JSON.stringify({ servers: [legacy, { ...probe, id: 'other' }] }));
      vi.stubEnv('VOCS_CODE_MCP_CONFIG', file);
      vi.stubEnv('VOCS_CODE_MCP_EPHEMERAL', JSON.stringify({ servers: [memory] }));
      vi.stubEnv(MEMORY_GATEWAY_TOKEN_ENV, 'stale-ambient-token');
      vi.stubEnv(MEMORY_GATEWAY_URL_ENV, 'stale-ambient-url');
      const parent = makePi();
      const child = makePi();
      await vocsCodeMcp(parent.pi);
      expect(process.env.VOCS_CODE_MCP_EPHEMERAL).toBeUndefined();
      expect(process.env[MEMORY_GATEWAY_TOKEN_ENV]).toBeUndefined();
      expect(process.env[MEMORY_GATEWAY_URL_ENV]).toBeUndefined();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('skipping file-configured memory gateway'));
      expect(JSON.stringify(log.mock.calls)).not.toContain('stale-file-token');
      await registerMcpTools(child.pi);
      expect(parent.tools.map((tool) => tool.name).sort()).toEqual(['mcp__other__probe', 'mcp__vocs_memory__probe']);
      expect(child.tools[0]).toBe(parent.tools[0]);
      // The probe marks itself read-only, but trust comes only from the built-in read-only allowlist.
      expect(await mcpReadOnlyToolNames()).toEqual(new Set());
      const input = { terms: ['test'], scope: 'branch' };
      for (const [name, expected] of [
        ['mcp__vocs_memory__probe', { gateway: url, digest: createHash('sha256').update(token).digest('hex') }],
        ['mcp__other__probe', { gateway: null, digest: null }]
      ] as const) {
        const result = await child.tools.find((tool) => tool.name === name)!.execute('call', input);
        expect(JSON.parse(result.content[0].text!)).toEqual({ ...expected, inheritedEnvelope: false, input });
      }
    } finally {
      closeMcpBridge();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: 'missing provenance', servers: [{ ...memory, builtin: undefined }] },
    { label: 'alias', servers: [{ ...memory, id: 'vocs_memory' }] },
    { label: 'non-stdio transport', servers: [{ ...memory, transport: 'http', url }] },
    { label: 'incomplete auth', servers: [{ ...memory, env: { [MEMORY_GATEWAY_TOKEN_ENV]: token } }] },
    { label: 'extra server', servers: [memory, { ...probe, id: 'other' }] },
    { label: 'authenticated non-memory injection', servers: [{ id: 'injected', transport: 'http', url, headers: { Authorization: `Bearer ${token}` } }] }
  ])('consumes and refuses an invalid ordinary envelope ($label)', async ({ servers }) => {
    vi.stubEnv('VOCS_CODE_MCP_EPHEMERAL', JSON.stringify({ servers }));
    const connect = vi.spyOn(PiMcpConnection, 'connect');
    await expect(mcpToolNames()).rejects.toThrow('Invalid ephemeral memory MCP configuration.');
    expect(connect).not.toHaveBeenCalled();
    expect(process.env.VOCS_CODE_MCP_EPHEMERAL).toBeUndefined();
  });

  it.runIf(process.env.VOCS_CODE_PI_INTEGRATION === '1')('keeps the real Pi shell scrubbed and reconnects after an extension reload', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'vocs-pi-gateway-reload-'));
    const mcpConfig = path.join(cwd, 'mcp.json');
    const reload = path.join(cwd, 'reload.ts');
    let runner: PiOfflineRunner | undefined;
    try {
      await writeFile(mcpConfig, JSON.stringify({ servers: [{ ...probe, id: 'other' }] }));
      await writeFile(reload, 'export default (pi) => pi.registerCommand("offline-reload-mcp", { handler: (_args, ctx) => ctx.reload() });');
      vi.stubEnv('VOCS_CODE_MCP_EPHEMERAL', JSON.stringify({ servers: [memory] }));
      runner = new PiOfflineRunner({ cwd, agentDir: path.join(cwd, 'agent'), mcpConfig, extraArgs: ['--no-session', '-e', reload] });
      await runner.ready();
      const input = { terms: ['test'] };
      const probeCalls = [
        { id: 'memory', name: 'mcp__vocs_memory__probe', arguments: input },
        { id: 'other', name: 'mcp__other__probe', arguments: input },
        { id: 'shell', name: 'bash', arguments: { command: 'if [ -z "$VOCS_CODE_MCP_EPHEMERAL$VOCS_MEMORY_GATEWAY_URL$VOCS_MEMORY_GATEWAY_TOKEN" ]; then printf scrubbed; else printf inherited; fi' } }
      ];
      for (const phase of ['start', 'reload']) {
        if (phase === 'reload') await runner.request('prompt', { message: '/offline-reload-mcp' });
        const events = await runner.prompt(probeCalls);
        const results = events.filter((e) => e.type === 'tool_execution_end');
        expect(results).toHaveLength(3);
        expect(results.every((e) => e.isError === false)).toBe(true);
        const text = (id: string) => results.find((e) => e.toolCallId === id)?.result.content[0].text;
        expect(JSON.parse(text('memory'))).toEqual({ gateway: url, digest: createHash('sha256').update(token).digest('hex'), inheritedEnvelope: false, input });
        expect(JSON.parse(text('other'))).toEqual({ gateway: null, digest: null, inheritedEnvelope: false, input });
        expect(text('shell')).toBe('scrubbed');
      }
      expect(JSON.stringify(runner.events) + runner.stderr).not.toContain(token);
    } finally {
      await runner?.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('MCP image content at extension execute', () => {
  const image = {
    type: 'image' as const,
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=',
    mimeType: 'image/png'
  };

  async function contentTool(result: { content: unknown[]; isError?: boolean }) {
    const calls: CallToolRequest['params'][] = [];
    // Raw JSON-RPC also permits malformed server replies to reach the client decoder.
    const http = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (request.id === undefined) { res.writeHead(204).end(); return; }
      let reply: unknown;
      if (request.method === 'initialize') reply = { protocolVersion: '2024-11-05', serverInfo: { name: 'content-fixture', version: '1' }, capabilities: { tools: {} } };
      else if (request.method === 'tools/list') reply = { tools: [{ name: 'capture', inputSchema: { type: 'object', properties: {} } }] };
      else if (request.method === 'tools/call') { calls.push(request.params); reply = result; }
      else { res.writeHead(400).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: reply }));
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const dir = await mkdtemp(path.join(tmpdir(), 'vocs-pi-mcp-content-'));
    const def = { id: 'content', transport: 'http' as const, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp` };
    const configPath = path.join(dir, 'mcp.json');
    const close = async () => {
      closeMcpBridge();
      await new Promise<void>((resolve) => { http.closeAllConnections(); http.close(() => resolve()); });
      await rm(dir, { recursive: true, force: true });
    };
    try {
      await writeFile(configPath, JSON.stringify({ servers: [def] }));
      process.env.VOCS_CODE_MCP_CONFIG = configPath;
      const { pi, tools } = makePi();
      await vocsCodeMcp(pi);
      return { def, tool: tools.find((tool) => tool.name === 'mcp__content__capture')!, calls, close };
    } catch (error) {
      await close();
      throw error;
    }
  }

  it.each([
    { label: 'image-only', content: [image] },
    { label: 'mixed text and images', content: [{ type: 'text' as const, text: 'before\nimage' }, image, { type: 'text' as const, text: '' }, { ...image, mimeType: 'image/jpeg', data: '/9j/2Q==' }, { type: 'text' as const, text: 'after' }] }
  ])('preserves every $label block in order with complete image data and MIME type', async ({ content }) => {
    const fixture = await contentTool({ content });
    try {
      await expect(fixture.tool.execute('image', {})).resolves.toEqual({ content, details: { server: 'content', tool: 'capture' } });
      expect(fixture.calls).toEqual([{ name: 'capture', arguments: {} }]);
    } finally { await fixture.close(); }
  });

  it.each([
    { content: [image], message: 'MCP tool capture failed' },
    { content: [image, { type: 'text' as const, text: 'capture failed' }], message: 'capture failed' }
  ])('keeps image-bearing tool errors failed: $message', async ({ content, message }) => {
    const fixture = await contentTool({ content, isError: true });
    const connection = await PiMcpConnection.connect(fixture.def);
    try {
      await expect(connection.callTool('capture', {})).resolves.toEqual({ content, isError: true });
      await expect(fixture.tool.execute('image-error', {})).rejects.toThrow(message);
      expect(fixture.calls).toEqual([{ name: 'capture', arguments: {} }, { name: 'capture', arguments: {} }]);
    } finally { connection.close(); await fixture.close(); }
  });

  it.each([
    { type: 'audio' as const, data: 'YXVkaW8=', mimeType: 'audio/wav' },
    { type: 'resource' as const, resource: { uri: 'file:///fixture.txt', text: 'resource text' } },
    { type: 'resource_link' as const, uri: 'file:///fixture.txt', name: 'fixture.txt' }
  ])('explicitly rejects unsupported $type blocks instead of losing their content', async (block) => {
    const fixture = await contentTool({ content: [{ type: 'text', text: 'partial result' }, block] });
    try {
      await expect(fixture.tool.execute('unsupported', {})).rejects.toThrow(`unsupported content type "${block.type}"`);
      expect(fixture.calls).toHaveLength(1);
    } finally { await fixture.close(); }
  });

  it.each([
    { label: 'missing image data', block: { type: 'image', mimeType: 'image/png' }, message: 'malformed image content block' },
    { label: 'missing MIME type', block: { type: 'image', data: image.data }, message: 'malformed image content block' },
    { label: 'non-string image data', block: { type: 'image', data: 123, mimeType: 'image/png' }, message: 'malformed image content block' },
    { label: 'missing text', block: { type: 'text' }, message: 'malformed text content block' },
    { label: 'null block', block: null, message: 'invalid content block' }
  ])('explicitly rejects $label instead of returning partial success', async ({ block, message }) => {
    const fixture = await contentTool({ content: [{ type: 'text', text: 'partial result' }, block] });
    try {
      await expect(fixture.tool.execute('malformed', {})).rejects.toThrow(message);
      expect(fixture.calls).toHaveLength(1);
    } finally { await fixture.close(); }
  });
});

describe('shared MCP bridge (a child session reuses the parent connections)', () => {
  it('registers the same tools into a second session and exposes names plus the read-only set', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vocs-pi-bridge-'));
    const configPath = path.join(root, 'mcp.json');
    await writeFile(
      configPath,
      JSON.stringify({ servers: [{ ...vocsMemoryBaseDef(), command: process.execPath, args: [MEMORY_SERVER], env: { VOCS_MEMORY_ROOT: path.join(root, 'wiki') } }] }),
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
