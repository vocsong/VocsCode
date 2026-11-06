/** Readiness is runtime + reported authentication, never a successful --version alone. */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeResolver, clearRuntimeProbeCache, clearWhichCache } from '../src/main/runtime';
import { defaultSettings } from '../src/main/settings';

const { spawnTool, killTree } = vi.hoisted(() => ({ spawnTool: vi.fn(), killTree: vi.fn() }));
vi.mock('../src/main/harness/spawn', () => ({ spawnTool, killTree }));
const dirs: string[] = [];
let sequence = 0;

function answer(stdout: string, code = 0, stderr = '') {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
  queueMicrotask(() => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.emit('close', code);
  });
  return child;
}

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
