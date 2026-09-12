// The app's own MCP client, against a real stdio server. Offline: the server is the fixture in
// tests/fixtures, run with this process's own node binary.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectServer } from '../src/main/mcp/client';
import { normalizeStdio } from '../src/main/mcp/effective';

const FIXTURE = path.resolve('tests/fixtures/mcp-echo-server.mjs');

describe('inspectServer', () => {
  it('connects to a stdio server and lists its tools', async () => {
    const r = await inspectServer({ id: 'fixture', transport: 'stdio', command: process.execPath, args: [FIXTURE] }, { timeoutMs: 30_000 });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.serverInfo).toEqual({ name: 'fixture', version: '9.9.9' });
    expect(r.tools.map((t) => t.name).sort()).toEqual(['echo', 'probe']);
    expect(r.tools.find((t) => t.name === 'echo')?.description).toBe('Says it back');
  }, 60_000);

  it("passes the definition's env through to the server process", async () => {
    const r = await inspectServer({ id: 'fixture', transport: 'stdio', command: process.execPath, args: [FIXTURE], env: { VOCS_TEST_VALUE: 'v' } }, { timeoutMs: 30_000 });
    expect(r.ok).toBe(true);
  }, 60_000);

  it('reports a command that does not exist instead of throwing', async () => {
    const r = await inspectServer({ id: 'nope', transport: 'stdio', command: path.resolve('tests/fixtures/not-a-program'), args: [] }, { timeoutMs: 5_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.tools).toEqual([]);
  }, 20_000);

  it('reports an unreachable http server', async () => {
    // Port 1 is never listening, so the transport fails fast rather than hanging.
    const r = await inspectServer({ id: 'remote', transport: 'http', url: 'http://127.0.0.1:1/mcp' }, { timeoutMs: 5_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  }, 20_000);

  // A .cmd shim is how npm installs npx and every globally installed MCP server on Windows.
  // This client survives one either way (the SDK's stdio transport goes through cross-spawn),
  // but the harnesses we hand definitions to spawn directly, so the rewritten form has to run.
  it.runIf(process.platform === 'win32')('runs a .cmd shim rewritten by normalizeStdio', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vocs-mcp-shim-'));
    try {
      const shim = path.join(dir, 'fixture-server.cmd');
      await writeFile(shim, `@echo off\r\n"${process.execPath}" "${FIXTURE}" %*\r\n`, 'utf8');
      const wrapped = normalizeStdio({ id: 'fixture', transport: 'stdio', command: shim, args: [] }, { platform: 'win32' });
      expect(wrapped.command).toMatch(/cmd(\.exe)?$/i);
      expect(wrapped.args).toEqual(['/c', shim]);
      const r = await inspectServer(wrapped, { timeoutMs: 30_000 });
      expect(r.error).toBeUndefined();
      expect(r.tools.map((t) => t.name).sort()).toEqual(['echo', 'probe']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
