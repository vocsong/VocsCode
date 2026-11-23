import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { describe, expect, it, vi } from 'vitest';
import { encodeLocalControlTarget, LOCAL_CONTROL_REPLY_BYTES } from '../src/shared/local-control';
// @ts-expect-error The Node source-checkout entry point is plain JS with no declaration file.
import { createMcpServer, exchange, formatResult } from '../scripts/vocs-code.mjs';

const cliPath = fileURLToPath(new URL('../scripts/vocs-code.mjs', import.meta.url));
const target = {
  v: 1 as const, profileId: 'a'.repeat(64), instanceId: '11111111-1111-4111-8111-111111111111',
  pipeName: `vocs-code-local-${'b'.repeat(32)}`, pid: 1234, started: '134000000000000000',
};
const encoded = encodeLocalControlTarget(target);
const cli = (args: string[], options: string[] = []) => spawnSync(process.execPath, [...options, cliPath, ...args], {
  env: { ...process.env, VOCS_CODE_LOCAL_TARGET: encoded }, encoding: 'utf8', timeout: 15_000, windowsHide: true,
});

describe('local control CLI', () => {
  it.each(['--help', 'help'])('prints usage with %s without a target', (help) => {
    const run = cli([help]);
    expect(run).toMatchObject({ status: 0, stderr: '' });
    expect(run.stdout).toContain('mcp serve --stdio');
  });

  it.each([
    ['status', '--json'],
    ['status', '--target', encoded, '--json'],
    ['--target', 'invalid-fixture-target', 'status', '--json'],
    ['--target', encoded, 'status', '--json', '--json'],
    ['--target', encoded, 'projects', 'list', '--offset', '1e2', '--json'],
    ['--target', encoded, 'projects', 'list', '--limit', '101', '--json'],
    ['--target', encoded, 'sessions', 'list', '--project', '--json'],
    ['--target', encoded, 'sessions', 'list', '--project', 'C:\\fixture', '--json'],
    ['--target', encoded, 'sessions', 'transcript', '--json'],
    ['mcp', 'serve', '--stdio'],
  ].map((args) => ({ args })))('refuses invalid input without stdout: $args', ({ args }) => {
    expect(cli(args)).toMatchObject({ status: 2, stdout: '', stderr: '{"error":"invalid_request"}\n' });
  });

  it('reports an unsupported platform without starting stdio or emitting a banner', () => {
    const unsupported = `data:text/javascript,${encodeURIComponent("Object.defineProperty(process,'platform',{value:'unsupported-fixture'})")}`;
    const run = cli(['--target', encoded, 'mcp', 'serve', '--stdio'], ['--import', unsupported]);
    expect(run).toMatchObject({ status: 4, stdout: '', stderr: '{"error":"unavailable"}\n' });
  });

  it('keeps JSON exact and escapes terminal metacharacters in human metadata', () => {
    const value = { items: [{ id: 's_fixture', title: 'First\n\x1b\x9b\u202eSecond', status: 'idle', harness: 'codex-exec' }], nextOffset: 2 };
    expect(formatResult('sessions.list', value, true)).toBe(`${JSON.stringify(value)}\n`);
    expect(formatResult('sessions.list', value, false)).toBe(
      's_fixture\tidle\tcodex-exec\t"First\\n\\u001b\\u009b\\u202eSecond"\nNext page: --offset 2\n',
    );
  });
});

const fixture = (source: string) => spawn(process.execPath, ['-e', source], { stdio: 'pipe', windowsHide: true });
const request = 'request Zml4dHVyZQ==\n';
const frameBytes = (bytes: Buffer) => `reply ${bytes.toString('base64')}\n`;
const frame = (value: unknown) => frameBytes(Buffer.from(JSON.stringify(value)));
const valid = { ok: true, result: { items: [], nextOffset: null } };
const print = (line: string) => fixture(`process.stdout.write(${JSON.stringify(line)})`);

describe('bounded native child exchange', () => {
  it.each(['\n', '\r\n'])('sends one frame then EOF and accepts reply terminator %j', async (terminator) => {
    const child = fixture(`
      if (require('node:fs').readFileSync(0, 'utf8') !== ${JSON.stringify(request)}) process.exit(12);
      process.stderr.write('discard this fixture diagnostic');
      process.stdout.write(${JSON.stringify(frame(valid).slice(0, -1) + terminator)});
    `);
    await expect(exchange(child, request)).resolves.toEqual(valid);
  });

  it.each([
    ['banner', 'banner\n' + frame(valid)],
    ['missing newline', frame(valid).trimEnd()],
    ['two replies', frame(valid) + frame(valid)],
    ['extra newline', frame(valid) + '\n'],
    ['noncanonical base64', frame(valid).slice(0, -1) + '=\n'],
    ['extra envelope field', frame({ ...valid, diagnostic: 'fixture' })],
    ['unknown error code', frame({ ok: false, error: 'fixture' })],
    ['malformed UTF-8', frameBytes(Buffer.concat([
      Buffer.from('{"ok":true,"result":{"name":"'), Buffer.from([0xc0]), Buffer.from('"}}'),
    ]))],
  ])('refuses a %s frame', async (_label, line) => {
    await expect(exchange(print(line), request)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('bounds both decoded payload size and encoded output', async () => {
    const body = '{"ok":true,"result":{"name":""}}';
    const max = LOCAL_CONTROL_REPLY_BYTES;
    const replyWithSize = (size: number) => fixture(`process.stdout.write('reply ' + Buffer.from(
      ${JSON.stringify(body.slice(0, -3))} + 'x'.repeat(${size - body.length}) + ${JSON.stringify(body.slice(-3))}
    ).toString('base64') + '\\r\\n')`);
    await expect(exchange(replyWithSize(max), request)).resolves.toMatchObject({ ok: true });
    // max + 1 still fits in the same number of encoded base64 characters.
    await expect(exchange(replyWithSize(max + 1), request)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(exchange(replyWithSize(max + 3), request)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it.each([[3, 'denied'], [7, 'unavailable']])('does not accept a success reply when the helper exits %i', async (status, code) => {
    const child = fixture(`process.stdout.write(${JSON.stringify(frame(valid))}, () => process.exit(${status}))`);
    await expect(exchange(child, request)).rejects.toMatchObject({ code });
  });

  it('terminates an owned helper that never closes', async () => {
    const child = fixture('setInterval(() => {}, 60_000)');
    const closed = once(child, 'close', { signal: AbortSignal.timeout(5_000) });
    await expect(exchange(child, request, undefined, 100)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(closed).resolves.toEqual([null, 'SIGTERM']);
  });
});

it('exposes only the three read-only stdio tools and refuses authority overrides before any read', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const projects = { items: [{ id: 'p_fixture', name: 'Fixture project' }], nextOffset: null };
  const read = vi.fn(async (_target, method) => {
    if (method === 'capabilities') throw new Error('fixture diagnostic, do not show');
    return projects;
  });
  const server = createMcpServer(target, read);
  await server.connect(new StdioServerTransport(input, output));
  let id = 0;
  async function rpc(method: string, params = {}) {
    const response = once(output, 'data', { signal: AbortSignal.timeout(5_000) });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })}\n`);
    const [line] = await response;
    const value = JSON.parse(String(line));
    expect(value).toMatchObject({ jsonrpc: '2.0', id });
    return value.result;
  }
  try {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const listed = await rpc('tools/list');
    expect(listed.tools.map((tool: { name: string }) => tool.name)).toEqual(['capabilities', 'projects_list', 'sessions_list']);
    for (const [name, args] of [
      ['sessions_create', { projectId: 'p_fixture' }],
      ['projects_list', { instanceId: target.instanceId }],
      ['projects_list', { limit: '5' }],
      ['sessions_list', {}],
      ['sessions_list', { projectId: 'p_fixture', principal: {} }],
      ['sessions_list', { projectId: 'C:\\fixture' }],
    ]) {
      expect(await rpc('tools/call', { name, arguments: args })).toMatchObject({ isError: true });
    }
    expect(read).not.toHaveBeenCalled();
    expect(await rpc('tools/call', { name: 'projects_list' })).toMatchObject({ structuredContent: projects });
    expect(read).toHaveBeenCalledExactlyOnceWith(target, 'projects.list', { offset: 0, limit: 50 }, expect.any(AbortSignal));
    expect(await rpc('tools/call', { name: 'capabilities' })).toMatchObject({
      structuredContent: { error: 'unknown' }, content: [{ type: 'text', text: '{"error":"unknown"}' }], isError: true,
    });
  } finally {
    await server.close();
  }
});
