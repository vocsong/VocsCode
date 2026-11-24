import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { applyCodexMcpSuppression, readCodexMcpServers } from '../src/main/harness/codex-mcp-config';
import type { CodexMcpConfig } from '../src/main/mcp/effective';
import { bundledCodexPath, runCapture } from '../src/main/runtime';
import { MCP_BUILTIN_IDS } from '../src/shared/types';

async function codexFixture(mcpToml = '') {
  const bin = bundledCodexPath(path.resolve(import.meta.dirname, '..'));
  if (!bin) throw new Error('Expected the bundled native Codex CLI');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-codex-mcp-'));
  // Windows can briefly retain Codex's cwd handle after process shutdown.
  onTestFinished(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10 }));
  const home = path.join(root, 'codex-home');
  const cwd = path.join(root, 'workspace');
  await fs.mkdir(home);
  await fs.mkdir(cwd);
  const configPath = path.join(home, 'config.toml');
  const contents = Buffer.from(`check_for_update_on_startup = false\n[analytics]\nenabled = false\n${mcpToml}`);
  await fs.writeFile(configPath, contents);

  // Do not pass through provider credentials or Codex settings from the test runner.
  const env: NodeJS.ProcessEnv = {
    CODEX_HOME: home,
    HOME: root,
    USERPROFILE: root,
    SystemRoot: process.env.SystemRoot,
    TMPDIR: root,
    TEMP: root,
    TMP: root,
    OTEL_SDK_DISABLED: 'true'
  };

  return {
    read: () => readCodexMcpServers(bin, cwd, env),
    async list(config: CodexMcpConfig['config'] = {}) {
      // Mirror the exec SDK's dotted --config overrides for these scalar/array values.
      const args = Object.entries(config).flatMap(([id, entry]) =>
        Object.entries(entry).flatMap(([key, value]) => ['--config', `mcp_servers.${id}.${key}=${JSON.stringify(value)}`])
      );
      // Listing parses the native config without starting an MCP server or a model turn.
      const result = await runCapture(bin, [...args, 'mcp', 'list', '--json'], { cwd, env });
      expect(result.code, result.stderr).toBe(0);
      const servers = JSON.parse(result.stdout) as Array<{ name: string; enabled: boolean; transport: unknown }>;
      return Object.fromEntries(servers.map(({ name, enabled, transport }) => [name, { enabled, transport }]));
    },
    async expectUnchanged() {
      expect(await fs.readFile(configPath)).toEqual(contents);
    }
  };
}

it('parses disabled placeholders for absent built-ins on a clean Codex config', async () => {
  const fixture = await codexFixture();
  expect(await fixture.list()).toEqual({});

  const config: CodexMcpConfig['config'] = {};
  await applyCodexMcpSuppression(config, MCP_BUILTIN_IDS, fixture.read);

  const servers = await fixture.list(config);
  expect(Object.keys(servers).sort()).toEqual([...MCP_BUILTIN_IDS].sort());
  for (const id of MCP_BUILTIN_IDS) {
    expect(servers[id]).toMatchObject({ enabled: false, transport: { type: 'stdio', command: '' } });
  }
  await fixture.expectUnchanged();
});

it('disables inherited HTTP and stdio built-ins without changing their transports or other servers', async () => {
  const url = 'http://127.0.0.1:1/mcp';
  const fixture = await codexFixture(`
[mcp_servers.gitnexus]
url = "${url}"
bearer_token_env_var = "FIXTURE_UNSET_MCP_TOKEN"
enabled = true

[mcp_servers.cua-driver]
command = "fixture-cua"
args = ["mcp"]
enabled = true

[mcp_servers.personal]
command = "fixture-personal"
enabled = true
`);
  const inherited = await fixture.list();
  expect(inherited).toMatchObject({
    gitnexus: { enabled: true, transport: { type: 'streamable_http', url } },
    'cua-driver': { enabled: true, transport: { type: 'stdio', command: 'fixture-cua', args: ['mcp'] } },
    personal: { enabled: true }
  });

  const injected = { command: 'fixture-memory', args: ['mcp'] };
  const config: CodexMcpConfig['config'] = { 'vocs-memory': structuredClone(injected) };
  await applyCodexMcpSuppression(config, MCP_BUILTIN_IDS, fixture.read);

  const servers = await fixture.list(config);
  expect(Object.keys(servers).sort()).toEqual([...MCP_BUILTIN_IDS, 'personal'].sort());
  expect(servers.gitnexus).toEqual({ ...inherited.gitnexus, enabled: false });
  expect(servers['cua-driver']).toEqual({ ...inherited['cua-driver'], enabled: false });
  expect(servers.personal).toEqual(inherited.personal);
  expect(servers['vocs-memory']).toMatchObject({ enabled: true, transport: { type: 'stdio', ...injected } });
  expect(servers['vocs-mission']).toMatchObject({ enabled: false, transport: { type: 'stdio', command: '' } });
  // A Vocs MCP Hub connection is app-owned too: off unless this session is handed the proxy.
  expect(servers['vocs-openrouter']).toMatchObject({ enabled: false, transport: { type: 'stdio', command: '' } });
  expect(config).toEqual({
    'vocs-memory': injected,
    gitnexus: { enabled: false },
    'cua-driver': { enabled: false },
    'vocs-mission': { enabled: false, command: '' },
    'vocs-openrouter': { enabled: false, command: '' }
  });
  await fixture.expectUnchanged();
});
