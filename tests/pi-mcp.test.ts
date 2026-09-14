/**
 * Offline tests for the pi MCP bridge. The stdio path runs a real MCP server — the fixture in
 * tests/fixtures — with this process's own node binary, so nothing here needs the network.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiMcpConnection } from '../resources/pi/mcp-client';
import vocsCodeMcp, { closeMcpBridge, mcpReadOnlyToolNames, mcpToolNames, parseMcpConfig, promptSnippetFor, registerMcpTools, sanitizeToolName, toolNameFor } from '../resources/pi/vocs-code-mcp';

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
