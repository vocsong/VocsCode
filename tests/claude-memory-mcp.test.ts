import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../src/main/harness/claude';
import type { HarnessContext } from '../src/main/harness/types';
import { MEMORY_GATEWAY_TOKEN_ENV, MEMORY_GATEWAY_URL_ENV, VOCS_MEMORY_SERVER_ID, vocsMemoryBaseDef } from '../src/main/mcp/memory';
import { LineSplitter } from '../src/main/util/async';
import type { McpServerDef } from '../src/shared/types';

// Keep the real SDK, including its CLI argv builder and SDK MCP routing. Only the launched
// Claude Code process is simulated, so this test never uses a provider or native Claude config.
const spawn = vi.hoisted(() => vi.fn<(options: SpawnOptions) => SpawnedProcess>());
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return { ...sdk, query: (({ prompt, options }) => sdk.query({ prompt, options: { ...options, spawnClaudeCodeProcess: spawn } })) satisfies typeof sdk.query };
});

function scriptedCli() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const cli = Object.assign(new EventEmitter(), { stdin, stdout, killed: false, exitCode: null as number | null, kill: () => { exit(); return true; } });
  function exit() {
    if (cli.exitCode !== null) return;
    cli.exitCode = 0;
    stdout.end();
    cli.emit('exit', 0, null);
  }
  stdin.on('end', exit);
  const messages: Record<string, any>[] = [];
  const write = (message: object) => stdout.write(JSON.stringify(message) + '\n');
  const splitter = new LineSplitter((line) => {
    const message = JSON.parse(line);
    messages.push(message);
    if (message.type === 'control_request' && message.request.subtype === 'initialize') {
      write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [], models: [], account: {}, hooks_applied: true } } });
    }
  });
  stdin.on('data', (chunk) => splitter.push(chunk));
  spawn.mockReturnValue(cli);
  let id = 0;
  return {
    messages,
    async request(method: string, params?: object) {
      const requestId = `rpc-${++id}`;
      write({ type: 'control_request', request_id: requestId, request: { subtype: 'mcp_message', server_name: VOCS_MEMORY_SERVER_ID, message: { jsonrpc: '2.0', id, method, params } } });
      const message = await vi.waitFor(() => {
        const found = messages.find((entry) => entry.response?.request_id === requestId);
        expect(found).toBeDefined();
        return found!;
      });
      expect(message.response.subtype).toBe('success');
      return message.response.response.mcp_response;
    }
  };
}

const token = 'claude-memory-test-capability';
const url = 'http://127.0.0.1:9/tools';
const standalone = { ...vocsMemoryBaseDef(), command: process.execPath, args: [path.resolve('tests/fixtures/mcp-memory-gateway-probe.mjs')], env: { VOCS_MEMORY_ROOT: 'test-wiki' } };
const memory = { ...standalone, env: { ...standalone.env, [MEMORY_GATEWAY_URL_ENV]: url, [MEMORY_GATEWAY_TOKEN_ENV]: token } };
const other = { id: 'other', transport: 'http' as const, url: 'https://mcp.example.test' };
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  spawn.mockReset();
});

async function setup(defs: McpServerDef[], resume?: string) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'vocs-claude-memory-'));
  const cli = scriptedCli();
  const log = vi.fn();
  const emit = vi.fn();
  const ref = { claudeSessionId: resume };
  const adapter = new ClaudeAdapter({
    session: () => ({ cwd, usage: {}, harnessRef: ref, config: { harness: 'claude', projectRoot: cwd } }),
    settings: () => ({ claude: { settingSources: ['project'] }, providers: [] }),
    mcpServers: async () => defs.map((def) => ({ def, missing: [], secretEnvKeys: [], secretHeaderKeys: [] })),
    runtime: { resolve: () => ({ path: process.execPath }) },
    sessionDir: cwd, permissionMode: () => 'ask', effort: () => undefined, getApiKey: async () => undefined,
    emit, log, updateMeta: () => {}
  } as unknown as HarnessContext);
  cleanups.push(async () => { await adapter.dispose(); await rm(cwd, { recursive: true, force: true }); });
  return { adapter, cli, cwd, emit, log };
}

async function launch(defs: McpServerDef[], resume?: string) {
  const fixture = await setup(defs, resume);
  await fixture.adapter.start();
  const spawned = spawn.mock.calls[0][0];
  const index = spawned.args.indexOf('--mcp-config');
  return { ...fixture, spawned, processMcp: index < 0 ? undefined : JSON.parse(spawned.args[index + 1]).mcpServers };
}

it('keeps the gateway out of real SDK argv and env, while forwarding its schemas and calls', async () => {
  vi.stubEnv(MEMORY_GATEWAY_TOKEN_ENV, 'stale-ambient-token');
  vi.stubEnv(MEMORY_GATEWAY_URL_ENV, 'stale-ambient-url');
  vi.stubEnv('VOCS_CODE_MCP_EPHEMERAL', 'stale-ambient-envelope');
  const close = vi.spyOn(StdioClientTransport.prototype, 'close');
  const { adapter, cli, spawned, processMcp, cwd, emit, log } = await launch([memory, other], 'resumed-session');
  expect(spawned.args).toContain('--resume=resumed-session');
  expect(spawned.args).not.toContain('--strict-mcp-config');
  expect(processMcp).toEqual({ other: { type: 'http', url: other.url } });
  expect(JSON.stringify([spawned.args, spawned.env])).not.toContain(token);
  expect(spawned.env[MEMORY_GATEWAY_TOKEN_ENV]).toBeUndefined();
  expect(spawned.env[MEMORY_GATEWAY_URL_ENV]).toBeUndefined();
  expect(spawned.env.VOCS_CODE_MCP_EPHEMERAL).toBeUndefined();
  expect(await readdir(cwd)).toEqual([]);
  const initialized = await cli.request('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'fake-cli', version: '1' }, capabilities: {} });
  expect(initialized.result.instructions).toBe('Memory probe instructions');
  const listed = await cli.request('tools/list');
  expect(listed.result.tools).toEqual([{
    name: 'probe', description: 'Proves the gateway handoff without echoing the credential',
    inputSchema: { type: 'object', properties: { terms: { type: 'array', items: { type: 'string', minLength: 1 } }, scope: { enum: ['project', 'branch'] } }, required: ['terms'], additionalProperties: false },
    annotations: { readOnlyHint: true }
  }]);
  const input = { terms: ['tests'], scope: 'branch' };
  const observed = { gateway: url, digest: createHash('sha256').update(token).digest('hex'), inheritedEnvelope: false, input };
  expect((await cli.request('tools/call', { name: 'probe', arguments: input })).result).toEqual({
    content: [{ type: 'text', text: JSON.stringify(observed) }], structuredContent: observed
  });
  expect(JSON.stringify([cli.messages, emit.mock.calls, log.mock.calls])).not.toContain(token);
  await adapter.dispose();
  expect(close).toHaveBeenCalledTimes(1);
  expect(close.mock.contexts[0]).toMatchObject({ pid: null });
});

it('does not spawn Claude after disposal during the memory handshake', async () => {
  const start = vi.spyOn(StdioClientTransport.prototype, 'start');
  const { adapter } = await setup([{ ...memory, args: ['-e', 'process.stdin.resume()'] }]);
  const stopped = expect(adapter.start()).rejects.toThrow();
  await vi.waitFor(() => expect(start.mock.contexts[0]).toMatchObject({ pid: expect.any(Number) }));
  await adapter.dispose();
  await stopped;
  expect(spawn).not.toHaveBeenCalled();
  expect(start.mock.contexts[0]).toMatchObject({ pid: null });
});

it('never falls back to inline credentials when the memory handshake fails', async () => {
  const { processMcp, spawned, log } = await launch([{ ...memory, command: path.resolve('tests/fixtures/nonexistent-memory.exe') }, other]);
  expect(processMcp).toEqual({ other: { type: 'http', url: other.url } });
  expect(JSON.stringify([spawned.args, spawned.env, log.mock.calls])).not.toContain(token);
  expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('memory gateway MCP unavailable'));
});

it('keeps standalone memory and an unrelated server on their existing stdio and HTTP paths', async () => {
  const { processMcp } = await launch([standalone, other]);
  expect(processMcp).toEqual({
    [VOCS_MEMORY_SERVER_ID]: { type: 'stdio', command: standalone.command, args: standalone.args, env: standalone.env },
    other: { type: 'http', url: other.url }
  });
});

it('does not send MCP config when there are no injected servers', async () => {
  expect((await launch([])).processMcp).toBeUndefined();
});
