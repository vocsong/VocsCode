/** Readiness is runtime + reported authentication, never a successful --version alone. */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promises as fs } from 'node:fs';
import type { spawn, SpawnOptions } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openHarnessLogin } from '../src/main/harness-setup';
import { parseAntigravityQuota } from '../src/main/harness/antigravity';
import { RuntimeResolver, clearRuntimeProbeCache, clearWhichCache } from '../src/main/runtime';
import { defaultSettings } from '../src/main/settings';

const { spawnTool, killTree } = vi.hoisted(() => ({ spawnTool: vi.fn(), killTree: vi.fn() }));
vi.mock('../src/main/harness/spawn', () => ({
  spawnTool, killTree,
  shutdownChild: async (child: ReturnType<typeof pipedChild>) => {
    child.stdin.end(); child.stdout.end(); child.stderr.end();
  }
}));
const dirs: string[] = [];
let sequence = 0;

function pipedChild() {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
}

function answer(stdout: string, code = 0, stderr = '') {
  const child = pipedChild();
  queueMicrotask(() => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.emit('close', code);
  });
  return child;
}

function antigravityAccountProbe(methods: string[], errorCode?: number) {
  const child = pipedChild();
  createInterface({ input: child.stdin }).on('line', (line) => {
    const { id, method, params } = JSON.parse(line) as { id: number; method: string; params: { protocolVersion?: number } };
    methods.push(method);
    let reply;
    if (method === 'initialize') {
      reply = { result: { protocolVersion: params.protocolVersion, agentCapabilities: { sessionCapabilities: { list: {} } } } };
    } else if (method === 'session/list' && errorCode === undefined) {
      reply = { result: { sessions: [] } };
    } else {
      reply = { error: { code: method === 'session/list' ? errorCode : -32601, message: 'Fixture account response' } };
    }
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...reply }) + '\n');
  });
  return child;
}

const antigravityQuotaReply = {
  status: 'SUCCESS', num_turns: 0,
  command: { name: 'usage', data: { groups: [{ name: 'Gemini', buckets: [
    { name: 'Gemini Pro', remaining_fraction: 0.726, reset_time: '2026-11-21T17:00:00Z', extra: 'fixture-private-account-data' }
  ] }] } }
};

async function resolver() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-setup-'));
  dirs.push(dir);
  const settings = defaultSettings();
  const runtime = new RuntimeResolver({ appRoot: dir, appRuntimeDir: path.join(dir, 'runtime'), resourcesDir: dir }, () => settings);
  vi.spyOn(runtime, 'resolve').mockImplementation((tool) => ({ path: path.join(dir, `${tool}-${++sequence}`), source: 'system' }));
  return { runtime, settings, dir };
}

beforeEach(async () => {
  spawnTool.mockReset();
  clearWhichCache();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-setup-home-'));
  dirs.push(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, '.claude'));
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearWhichCache();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('harness setup checks', () => {
  it('uses Claude auth status instead of treating a credentials file as a successful login', async () => {
    const { runtime, dir } = await resolver();
    vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
    await fs.writeFile(path.join(dir, '.credentials.json'), '{}');
    spawnTool.mockImplementation((_bin, args: string[]) => answer(args[0] === '--version' ? '2.1.285' : JSON.stringify({ loggedIn: false, authMethod: 'none' }), args[0] === '--version' ? 0 : 1));
    expect(await runtime.availability('claude')).toMatchObject({ available: true, authenticated: false });
    expect(spawnTool.mock.calls.some(([, args]) => args.join(' ') === 'auth status --json')).toBe(true);
  });

  it('distinguishes a Claude subscription from API billing without returning account identity', async () => {
    const { runtime } = await resolver();
    spawnTool.mockImplementation((_bin, args: string[]) => answer(args[0] === '--version' ? '2.1.285' : JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'private@example.invalid' })));
    const status = await runtime.availability('claude');
    expect(status).toMatchObject({ authenticated: true, authMethod: 'subscription' });
    expect(JSON.stringify(status)).not.toContain('private@example.invalid');
  });

  it('reports failed Codex auth checks as unknown, not signed out', async () => {
    const { runtime } = await resolver();
    spawnTool.mockImplementation((_bin, args: string[]) => args[0] === '--version' ? answer('codex-cli 0.153.4') : answer('', 2, 'could not read credential store'));
    expect(await runtime.availability('codex')).toMatchObject({ available: true, authenticated: 'unknown' });
  });

  it('never exposes the Codex API-key preview in readiness details', async () => {
    const { runtime } = await resolver();
    spawnTool.mockImplementation((_bin, args: string[]) => answer(args[0] === '--version' ? 'codex-cli 0.153.4' : 'Logged in using an API key - sk-fixture-private-preview'));
    const status = await runtime.availability('codex');
    expect(status).toMatchObject({ authenticated: true, authMethod: 'api-key' });
    expect(JSON.stringify(status)).not.toContain('sk-fixture');
  });

  it('does not mark a broken DeepSeek executable available', async () => {
    const { runtime } = await resolver();
    spawnTool.mockImplementation(() => answer('', 1, 'unsupported Node.js version'));
    expect(await runtime.availability('acp')).toMatchObject({ available: false });
  });

  it('requires a compatible Antigravity CLI before probing its account', async () => {
    const { runtime } = await resolver();
    spawnTool.mockImplementation(() => answer('agy 1.5.11'));
    expect(await runtime.availability('antigravity')).toMatchObject({ available: false, version: '1.5.11', detail: expect.stringContaining('1.5.12') });
    expect(runtime.resolve).toHaveBeenCalledExactlyOnceWith('agy');
    expect(spawnTool.mock.calls.map(([, args]) => args)).toEqual([['--version']]);
  });

  it.each([
    { state: 'signed in', errorCode: undefined, authenticated: true },
    { state: 'signed out', errorCode: -32000, authenticated: false },
    { state: 'unknown after a probe error', errorCode: -32603, authenticated: 'unknown' }
  ])('reports Antigravity sign-in as $state without starting an agent turn', async ({ errorCode, authenticated }) => {
    const { runtime } = await resolver();
    const methods: string[] = [];
    spawnTool.mockImplementation((_bin, args: string[]) => args[0] === '--version' ? answer('agy 1.5.12') : antigravityAccountProbe(methods, errorCode));
    expect(await runtime.availability('antigravity')).toMatchObject({ available: true, version: '1.5.12', authenticated });
    expect(methods).toEqual(['initialize', 'session/list']);
    expect(spawnTool.mock.calls.map(([, args]) => args)).toEqual([['--version'], ['--settings', expect.any(String), 'acp']]);
  });

  it('reads Antigravity quota using only the vendor account and zero-turn usage command', async () => {
    const { runtime } = await resolver();
    const credentialKeys = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AGY_ADC_AUTH', 'GOOGLE_APPLICATION_CREDENTIALS'];
    for (const key of credentialKeys) vi.stubEnv(key, 'fixture-credential');
    const methods: string[] = [];
    spawnTool.mockImplementationOnce(() => answer('agy 1.5.12'))
      .mockImplementationOnce(() => antigravityAccountProbe(methods))
      .mockImplementationOnce(() => answer(JSON.stringify(antigravityQuotaReply)));
    expect(await runtime.antigravityQuota()).toEqual({ groups: [{ name: 'Gemini', buckets: [
      { name: 'Gemini Pro', remainingFraction: 0.726, resetAt: '2026-11-21T17:00:00Z' }
    ] }] });
    expect(methods).toEqual(['initialize', 'session/list']);
    expect(spawnTool.mock.calls.map(([, args]) => args)).toEqual([
      ['--version'], ['--settings', expect.any(String), 'acp'], ['--settings', expect.any(String), '-p', '/usage', '--output-format', 'json']
    ]);
    for (const [, , options] of spawnTool.mock.calls.slice(1)) {
      expect(options.cwd).toBe(runtime.runtimePaths.appRuntimeDir);
      for (const key of credentialKeys) expect(options.env).not.toHaveProperty(key);
    }
  });

  it('rejects Antigravity usage output when the vendor reports a model turn', () => {
    expect(parseAntigravityQuota(JSON.stringify({ ...antigravityQuotaReply, num_turns: 1 }))).toBeUndefined();
  });

  it('keeps usable Gemini quota when other windows are disabled or report a credit amount', () => {
    const reply = structuredClone(antigravityQuotaReply);
    const { groups } = reply.command.data;
    const buckets = [
      ...groups[0].buckets,
      { name: 'Five hours', disabled: true },
      { name: 'AI credits', remaining_amount: 100 }
    ];
    const payload = { ...reply, command: { name: 'usage', data: { groups: [{ name: groups[0].name, buckets }] } } };
    expect(parseAntigravityQuota(JSON.stringify(payload))).toEqual({
      groups: [{ name: 'Gemini', buckets: [{ name: 'Gemini Pro', remainingFraction: 0.726, resetAt: '2026-11-21T17:00:00Z' }] }]
    });
  });

  it('reports sign-in needed before running Antigravity usage for a signed-out account', async () => {
    const { runtime } = await resolver();
    spawnTool.mockImplementationOnce(() => answer('agy 1.5.12')).mockImplementationOnce(() => antigravityAccountProbe([], -32000));
    await expect(runtime.antigravityQuota()).rejects.toThrow(/Sign in with Google/);
    expect(spawnTool).toHaveBeenCalledTimes(2);
  });

  it('opens the resolved Antigravity CLI with its fixed Google sign-in command', async () => {
    const { runtime, dir } = await resolver();
    const binary = path.join(dir, "Antigravity's CLI", 'agy.exe');
    vi.mocked(runtime.resolve).mockReturnValue({ path: binary, source: 'settings' });
    const launch = vi.fn((_file: string, _args: string[], _options: SpawnOptions) => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    await expect(openHarnessLogin(runtime, 'antigravity', false, {
      platform: 'win32', which: (tool) => path.join(dir, `${tool}.exe`), spawn: launch as unknown as typeof spawn
    })).resolves.toEqual({ ok: true });
    expect(runtime.resolve).toHaveBeenCalledExactlyOnceWith('agy');
    expect(launch).toHaveBeenCalledOnce();
    const [, args, options] = launch.mock.calls[0]!;
    expect(options.cwd).toBe(path.join(runtime.runtimePaths.appRuntimeDir, 'sign-in'));
    const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    expect(script).toContain(`& '${binary.replaceAll("'", "''")}' 'acp' '--login'`);
  });

  it('rechecks the same executable after explicit refresh instead of reusing the signed-out probe', async () => {
    const { runtime, dir } = await resolver();
    vi.mocked(runtime.resolve).mockReturnValue({ path: path.join(dir, 'stable-codex'), source: 'system' });
    let loggedIn = false;
    spawnTool.mockImplementation((_bin, args: string[]) => answer(args[0] === '--version' ? 'codex-cli 0.153.4' : loggedIn ? 'Logged in using ChatGPT' : 'Not logged in', args[0] === '--version' || loggedIn ? 0 : 1));
    expect((await runtime.availability('codex')).authenticated).toBe(false);
    loggedIn = true;
    expect((await runtime.availability('codex')).authenticated).toBe(false);
    expect(spawnTool).toHaveBeenCalledTimes(2);
    clearRuntimeProbeCache();
    expect(await runtime.availability('codex')).toMatchObject({ authenticated: true, authMethod: 'subscription' });
    expect(spawnTool).toHaveBeenCalledTimes(4);
  });

  it('does not let an old in-flight auth probe repopulate the cache after a refresh', async () => {
    const { runtime, dir } = await resolver();
    vi.mocked(runtime.resolve).mockReturnValue({ path: path.join(dir, 'stable-codex'), source: 'system' });
    const oldAuth = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
    let authCalls = 0;
    spawnTool.mockImplementation((_bin, args: string[]) => args[0] === '--version' ? answer('codex-cli 0.153.4') : ++authCalls === 1 ? oldAuth : answer('Logged in using ChatGPT'));
    const pending = runtime.availability('codex');
    await vi.waitFor(() => expect(authCalls).toBe(1));
    clearRuntimeProbeCache();
    expect((await runtime.availability('codex')).authenticated).toBe(true);
    oldAuth.stdout.end('Not logged in'); oldAuth.stderr.end(); oldAuth.emit('close', 1);
    expect((await pending).authenticated).toBe(false);
    expect((await runtime.availability('codex')).authenticated).toBe(true);
    expect(authCalls).toBe(2);
  });

  it('rejects unknown installer ids before starting any process', async () => {
    const { runtime } = await resolver();
    spawnTool.mockImplementation(() => answer(''));
    await expect(runtime.install('unknown-package' as never)).rejects.toThrow(/unsupported|unknown/i);
    expect(spawnTool).not.toHaveBeenCalled();
  });
});
