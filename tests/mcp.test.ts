// The MCP layer: reading and writing the stores, merging the two scopes under the per-repo
// switches, resolving ${VAR} without ever persisting a value, the Windows shim rewrite, and the
// four per-harness dialects.
import { mkdtemp, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isValidServerId,
  parseCodexMcpToml,
  parseMcpJson,
  parseServerEntry,
  readProjectMcp,
  readStore,
  toMcpJsonTable,
  writeProjectMcp
} from '../src/main/mcp/file';
import { codexHeaderVar, effectiveEntries, effectiveServers, normalizeStdio, referencedVars, resolveVars, toAcp, toClaude, toCodex } from '../src/main/mcp/effective';
import { normalizeMcpProjectState, normalizeMcpServers } from '../src/main/settings';
import { HARNESSES } from '../src/shared/harness-meta';
import type { McpServerDef } from '../src/shared/types';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vocs-mcp-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const stdio = (over: Partial<McpServerDef> = {}): McpServerDef => ({ id: 'files', transport: 'stdio', command: 'npx', args: ['-y', 'srv'], ...over });
const http = (over: Partial<McpServerDef> = {}): McpServerDef => ({ id: 'remote', transport: 'http', url: 'https://mcp.example.com/mcp', ...over });

describe('server ids', () => {
  it('accepts what can appear in mcp__<id>__<tool>', () => {
    expect(isValidServerId('github')).toBe(true);
    expect(isValidServerId('my.server-2_x')).toBe(true);
  });
  it('rejects empty, leading punctuation and separators', () => {
    expect(isValidServerId('')).toBe(false);
    expect(isValidServerId('-bad')).toBe(false);
    expect(isValidServerId('a/b')).toBe(false);
    expect(isValidServerId('a b')).toBe(false);
  });
});

describe('parseServerEntry', () => {
  it('reads a stdio entry', () => {
    expect(parseServerEntry('x', { command: 'npx', args: ['-y', 'srv'], env: { A: '1' } })).toEqual({ id: 'x', transport: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { A: '1' } });
  });
  it('infers http from a bare url and honours an explicit type', () => {
    expect(parseServerEntry('x', { url: 'https://e/mcp' })?.transport).toBe('http');
    expect(parseServerEntry('x', { type: 'sse', url: 'https://e/sse' })?.transport).toBe('sse');
  });
  it("reads Gemini's httpUrl and VS Code's explicit stdio type", () => {
    expect(parseServerEntry('x', { httpUrl: 'https://e/mcp' })).toMatchObject({ transport: 'http', url: 'https://e/mcp' });
    expect(parseServerEntry('x', { type: 'stdio', command: 'srv' })).toMatchObject({ transport: 'stdio', command: 'srv' });
  });
  it('drops an entry with neither a command nor a url', () => {
    expect(parseServerEntry('x', { args: ['a'] })).toBeNull();
    expect(parseServerEntry('x', 'nope')).toBeNull();
  });
  it('carries a disabled flag from either spelling', () => {
    expect(parseServerEntry('x', { command: 'srv', disabled: true })?.disabled).toBe(true);
    expect(parseServerEntry('x', { command: 'srv', enabled: false })?.disabled).toBe(true);
  });
});

describe('parseMcpJson', () => {
  it('accepts both the mcpServers and the VS Code servers key', () => {
    expect(parseMcpJson('{"mcpServers":{"a":{"command":"x"}}}').servers.map((s) => s.id)).toEqual(['a']);
    expect(parseMcpJson('{"servers":{"b":{"command":"x"}}}').servers.map((s) => s.id)).toEqual(['b']);
  });
  it('reports a parse error instead of throwing', () => {
    const r = parseMcpJson('{ not json');
    expect(r.servers).toEqual([]);
    expect(r.error).toMatch(/Invalid JSON/);
  });
  it('skips ids that could not be a tool-name segment', () => {
    expect(parseMcpJson('{"mcpServers":{"a/b":{"command":"x"},"ok":{"command":"x"}}}').servers.map((s) => s.id)).toEqual(['ok']);
  });
});

describe('.mcp.json round trip', () => {
  it('writes the portable shape and reads it back', async () => {
    const servers = [stdio({ env: { TOKEN: '${GH}' }, description: 'files' }), http({ headers: { Authorization: 'Bearer ${T}' } })];
    const w = await writeProjectMcp(dir, servers);
    expect(w.ok).toBe(true);
    const back = await readProjectMcp(dir);
    expect(back.exists).toBe(true);
    expect(back.servers).toEqual(servers);
  });

  it('never writes app-only fields into the shared file', async () => {
    await writeProjectMcp(dir, [stdio({ harnesses: ['claude'], timeoutMs: 5000 })]);
    const raw = JSON.parse(await readFile(path.join(dir, '.mcp.json'), 'utf8'));
    expect(Object.keys(raw.mcpServers.files)).toEqual(['command', 'args']);
  });

  it('preserves other top-level keys the repo already had', async () => {
    await writeFile(path.join(dir, '.mcp.json'), JSON.stringify({ $schema: 'https://x', mcpServers: {} }), 'utf8');
    await writeProjectMcp(dir, [stdio()]);
    const raw = JSON.parse(await readFile(path.join(dir, '.mcp.json'), 'utf8'));
    expect(raw.$schema).toBe('https://x');
    expect(Object.keys(raw.mcpServers)).toEqual(['files']);
  });

  it('keeps the file dialect it found', async () => {
    await writeFile(path.join(dir, '.mcp.json'), JSON.stringify({ servers: {} }), 'utf8');
    await writeProjectMcp(dir, [stdio()]);
    const raw = JSON.parse(await readFile(path.join(dir, '.mcp.json'), 'utf8'));
    expect(raw.servers.files.command).toBe('npx');
  });

  it('refuses to overwrite a file it could not parse', async () => {
    await writeFile(path.join(dir, '.mcp.json'), '{ half written', 'utf8');
    const w = await writeProjectMcp(dir, [stdio()]);
    expect(w.ok).toBe(false);
    expect(await readFile(path.join(dir, '.mcp.json'), 'utf8')).toBe('{ half written');
  });

  it('reports a missing file without an error', async () => {
    const r = await readProjectMcp(dir);
    expect(r).toMatchObject({ exists: false, servers: [] });
    expect(r.error).toBeUndefined();
  });

  it('serializes an http server with its type', () => {
    expect(toMcpJsonTable([http()])).toEqual({ remote: { type: 'http', url: 'https://mcp.example.com/mcp' } });
  });
});

describe('Codex config.toml reader', () => {
  const toml = `
model = "gpt-5"

[mcp_servers.files]
command = "cmd"
args = ["/c", "npx", "-y", "srv"]
env = { TOKEN = "abc" }

[mcp_servers.remote]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "EXAMPLE_TOKEN"
http_headers = { "X-Trace" = "on" }
env_http_headers = { "X-Key" = "EXAMPLE_KEY" }
tool_timeout_sec = 30

[mcp_servers."quoted.name"]
command = "srv"
enabled = false

[other]
command = "not-an-mcp-server"
`;

  it('reads stdio servers with args and an inline env table', () => {
    const files = parseCodexMcpToml(toml).find((s) => s.id === 'files');
    expect(files).toEqual({ id: 'files', transport: 'stdio', command: 'cmd', args: ['/c', 'npx', '-y', 'srv'], env: { TOKEN: 'abc' } });
  });

  it("turns Codex's env indirections back into this app's ${VAR} references", () => {
    const remote = parseCodexMcpToml(toml).find((s) => s.id === 'remote');
    expect(remote).toEqual({
      id: 'remote',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { 'X-Trace': 'on', 'X-Key': '${EXAMPLE_KEY}', Authorization: 'Bearer ${EXAMPLE_TOKEN}' },
      timeoutMs: 30000
    });
  });

  it('handles quoted table names, disabled entries, and ignores other sections', () => {
    const ids = parseCodexMcpToml(toml).map((s) => s.id);
    expect(ids).toEqual(['files', 'remote', 'quoted.name']);
    expect(parseCodexMcpToml(toml).find((s) => s.id === 'quoted.name')?.disabled).toBe(true);
  });

  it('reads a nested [mcp_servers.x.env] table', () => {
    const [s] = parseCodexMcpToml('[mcp_servers.x]\ncommand = "srv"\n\n[mcp_servers.x.env]\nA = "1"\nB = "2"\n');
    expect(s.env).toEqual({ A: '1', B: '2' });
  });

  it('ignores comments and blank input', () => {
    expect(parseCodexMcpToml('# nothing here\n')).toEqual([]);
    expect(parseCodexMcpToml('')).toEqual([]);
  });
});

describe('readStore', () => {
  it('reads a JSON store and marks a missing one', async () => {
    const file = path.join(dir, '.cursor', 'mcp.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ mcpServers: { a: { command: 'srv' } } }), 'utf8');
    expect(await readStore({ id: 'cursor', label: 'Cursor', path: file, format: 'json' })).toMatchObject({ exists: true, servers: [{ id: 'a' }] });
    expect(await readStore({ id: 'cursor', label: 'Cursor', path: path.join(dir, 'nope.json'), format: 'json' })).toMatchObject({ exists: false, servers: [] });
  });
});

describe('effective set', () => {
  const base = { harness: 'claude' as const, support: 'inject' as const };

  it('leaves a repo server off until it is enabled for this repo', () => {
    const input = { ...base, global: [], repo: [stdio({ id: 'repo-srv' })], state: {} };
    expect(effectiveServers(input)).toEqual([]);
    expect(effectiveEntries(input)[0].reason).toBe('not-enabled');
    expect(effectiveServers({ ...input, state: { enabledRepo: ['repo-srv'] } }).map((s) => s.id)).toEqual(['repo-srv']);
  });

  it('keeps global servers on by default and honours the per-repo switch', () => {
    const input = { ...base, global: [stdio({ id: 'g' })], repo: [], state: {} };
    expect(effectiveServers(input).map((s) => s.id)).toEqual(['g']);
    expect(effectiveServers({ ...input, state: { disabledGlobal: ['g'] } })).toEqual([]);
  });

  it('honours the global master switch', () => {
    expect(effectiveServers({ ...base, global: [stdio({ id: 'g', disabled: true })], repo: [], state: {} })).toEqual([]);
  });

  it('lets an enabled repo server shadow the global one of the same name', () => {
    const entries = effectiveEntries({ ...base, global: [stdio({ id: 'same', command: 'global' })], repo: [stdio({ id: 'same', command: 'repo' })], state: { enabledRepo: ['same'] } });
    expect(entries.filter((e) => e.enabled).map((e) => e.def.command)).toEqual(['repo']);
    expect(entries.find((e) => e.scope === 'global')?.reason).toBe('shadowed');
  });

  it('applies a harness restriction', () => {
    const input = { ...base, global: [stdio({ id: 'g', harnesses: ['codex' as const] })], repo: [], state: {} };
    expect(effectiveServers(input)).toEqual([]);
    expect(effectiveEntries(input)[0].reason).toBe('harness-filtered');
    expect(effectiveServers({ ...input, harness: 'codex' }).map((s) => s.id)).toEqual(['g']);
  });

  it('injects nothing into a harness that reads its own store or has no seam', () => {
    for (const support of ['inherit', 'none'] as const) {
      const entries = effectiveEntries({ ...base, support, harness: 'cursor', global: [stdio({ id: 'g' })], repo: [], state: {} });
      expect(entries[0]).toMatchObject({ enabled: false, reason: 'not-injected' });
    }
  });
});

describe('${VAR} resolution', () => {
  it('prefers the process environment, then the secret store', async () => {
    const def = stdio({ env: { FROM_ENV: '${A}', FROM_STORE: '${B}' } });
    const r = await resolveVars(def, { env: { A: 'env-value' }, secret: async (n) => (n === 'B' ? 'store-value' : undefined) });
    expect(r.def.env).toEqual({ FROM_ENV: 'env-value', FROM_STORE: 'store-value' });
    expect(r.missing).toEqual([]);
  });

  it('reports a reference nothing could fill and empties the field', async () => {
    const r = await resolveVars(stdio({ env: { T: '${NOPE}' } }), { env: {} });
    expect(r.def.env).toEqual({ T: '' });
    expect(r.missing).toEqual(['NOPE']);
  });

  it('marks which fields came from a reference, so Codex can keep them out of argv', async () => {
    const r = await resolveVars(http({ headers: { Authorization: 'Bearer ${T}', 'X-Trace': 'on' } }), { env: { T: 's3cret' } });
    expect(r.secretHeaderKeys).toEqual(['Authorization']);
    expect(r.def.headers).toEqual({ Authorization: 'Bearer s3cret', 'X-Trace': 'on' });
  });

  it('leaves the original definition untouched', async () => {
    const def = stdio({ env: { T: '${A}' } });
    await resolveVars(def, { env: { A: 'v' } });
    expect(def.env).toEqual({ T: '${A}' });
  });

  it('expands inside a url and lists every reference', async () => {
    const def = http({ url: 'https://${HOST}/mcp', headers: { A: '${K}' } });
    expect(referencedVars(def).sort()).toEqual(['HOST', 'K']);
    const r = await resolveVars(def, { env: { HOST: 'example.com', K: 'v' } });
    expect(r.def.url).toBe('https://example.com/mcp');
  });
});

describe('Windows shim normalisation', () => {
  const which = (cmd: string) => (cmd === 'npx' ? 'C:\\Program Files\\nodejs\\npx.cmd' : null);

  it('wraps a .cmd shim in cmd /c on Windows', () => {
    const out = normalizeStdio(stdio(), { which, platform: 'win32', comspec: 'cmd.exe' });
    expect(out.command).toBe('cmd.exe');
    expect(out.args).toEqual(['/c', 'C:\\Program Files\\nodejs\\npx.cmd', '-y', 'srv']);
  });

  it('only resolves the path off Windows', () => {
    const out = normalizeStdio(stdio(), { which: () => '/usr/local/bin/npx', platform: 'linux' });
    expect(out).toMatchObject({ command: '/usr/local/bin/npx', args: ['-y', 'srv'] });
  });

  it('leaves an already-wrapped command and an unresolvable one alone', () => {
    const wrapped = stdio({ command: 'cmd', args: ['/c', 'npx', 'srv'] });
    expect(normalizeStdio(wrapped, { which, platform: 'win32' })).toBe(wrapped);
    const unknown = stdio({ command: 'my-server' });
    expect(normalizeStdio(unknown, { which, platform: 'win32' })).toBe(unknown);
  });

  it('does nothing to an http server', () => {
    const def = http();
    expect(normalizeStdio(def, { which, platform: 'win32' })).toBe(def);
  });
});

describe('dialects', () => {
  it('converts to the Claude SDK shape', () => {
    expect(toClaude([stdio({ env: { A: '1' }, timeoutMs: 5000 }), http({ headers: { A: 'b' } })])).toEqual({
      files: { type: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { A: '1' }, timeout: 5000 },
      remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { A: 'b' } }
    });
  });

  it('drops a timeout the Claude SDK would ignore', () => {
    expect(toClaude([stdio({ timeoutMs: 200 })]).files).not.toHaveProperty('timeout');
  });

  it('inlines resolved values for the Codex app-server, which takes config over JSON-RPC', () => {
    const { config, env } = toCodex([{ def: stdio({ env: { TOKEN: 's3cret' } }), missing: [], secretEnvKeys: ['TOKEN'], secretHeaderKeys: [] }], 'inline');
    expect(config.files.env).toEqual({ TOKEN: 's3cret' });
    expect(env).toEqual({});
  });

  it('keeps a resolved secret out of the exec SDK config, which becomes argv', () => {
    const { config, env } = toCodex([{ def: stdio({ env: { TOKEN: 's3cret', PLAIN: 'ok' } }), missing: [], secretEnvKeys: ['TOKEN'], secretHeaderKeys: [] }], 'env-ref');
    expect(JSON.stringify(config)).not.toContain('s3cret');
    expect(config.files.env).toEqual({ PLAIN: 'ok' });
    expect(config.files.env_vars).toEqual(['TOKEN']);
    expect(env).toEqual({ TOKEN: 's3cret' });
  });

  it('routes a secret http header through env_http_headers for the exec SDK', () => {
    const { config, env } = toCodex([{ def: http({ headers: { Authorization: 'Bearer s3cret', 'X-Trace': 'on' } }), missing: [], secretEnvKeys: [], secretHeaderKeys: ['Authorization'] }], 'env-ref');
    const varName = codexHeaderVar('remote', 'Authorization');
    expect(config.remote.env_http_headers).toEqual({ Authorization: varName });
    expect(config.remote.http_headers).toEqual({ 'X-Trace': 'on' });
    expect(env[varName]).toBe('Bearer s3cret');
    expect(JSON.stringify(config)).not.toContain('s3cret');
  });

  it('converts to ACP arrays and drops transports the agent did not advertise', () => {
    expect(toAcp([stdio({ env: { A: '1' } })])).toEqual([{ name: 'files', command: 'npx', args: ['-y', 'srv'], env: [{ name: 'A', value: '1' }] }]);
    expect(toAcp([http()])).toEqual([]);
    expect(toAcp([http()], { http: true })).toEqual([{ type: 'http', name: 'remote', url: 'https://mcp.example.com/mcp', headers: [] }]);
    expect(toAcp([http({ transport: 'sse' })], { http: true })).toEqual([]);
  });
});

describe('settings normalisation', () => {
  it('drops entries a harness could not run', () => {
    const out = normalizeMcpServers([
      stdio(),
      { id: 'no-command', transport: 'stdio' },
      { id: 'bad url', transport: 'http', url: 'ftp://x' },
      { id: 'a/b', transport: 'stdio', command: 'x' },
      stdio({ id: 'files' })
    ]);
    expect(out.map((s) => s.id)).toEqual(['files']);
  });

  it('keeps only harness ids this app knows', () => {
    const [s] = normalizeMcpServers([stdio({ harnesses: ['claude', 'nope' as never] })]);
    expect(s.harnesses).toEqual(['claude']);
  });

  it('survives a hand-edited settings file', () => {
    expect(normalizeMcpServers(undefined)).toEqual([]);
    expect(normalizeMcpServers('nonsense')).toEqual([]);
    expect(normalizeMcpProjectState({ 'G:/p': { enabledRepo: ['a', 'a'], disabledGlobal: 'x' } })).toEqual({ 'G:/p': { enabledRepo: ['a'] } });
    expect(normalizeMcpProjectState({ 'G:/p': {} })).toEqual({});
  });
});

describe('harness capabilities', () => {
  it('declares how every harness takes MCP servers', () => {
    expect(Object.fromEntries(HARNESSES.map((h) => [h.id, h.capabilities.mcp]))).toEqual({
      claude: 'inject',
      codex: 'inject',
      'codex-exec': 'inject',
      cursor: 'inherit',
      pi: 'none',
      acp: 'inject',
      native: 'client'
    });
  });
});
