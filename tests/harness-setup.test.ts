/** Desktop setup: no account secrets or arbitrary command input cross the renderer boundary. */
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../src/main/settings';
import { loginArgs, openHarnessLogin, readHarnessSetup } from '../src/main/harness-setup';
import type { RuntimeResolver } from '../src/main/runtime';

const { which, capture, clear } = vi.hoisted(() => ({ which: vi.fn(), capture: vi.fn(), clear: vi.fn() }));
vi.mock('../src/main/runtime', async (original) => ({ ...await original<typeof import('../src/main/runtime')>(), which, runCapture: capture, clearRuntimeProbeCache: clear }));
let dir: string;
let runtime: RuntimeResolver;
let settings: ReturnType<typeof defaultSettings>;
const launch = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-setup-unit-'));
  settings = defaultSettings();
  runtime = {
    runtimePaths: { appRoot: dir, appRuntimeDir: path.join(dir, "app runtime's $(literal) & space"), resourcesDir: dir },
    availability: vi.fn().mockResolvedValue({ available: true, authenticated: true, authMethod: 'subscription', source: 'bundled' }),
    resolve: vi.fn().mockReturnValue({ path: path.join(dir, "vendor's $(literal) & cli.exe"), source: 'bundled' })
  } as unknown as RuntimeResolver;
  which.mockImplementation((tool: string) => path.join(dir, `${tool}.exe`));
  capture.mockResolvedValue({ code: 0, stdout: 'v22.19.0', stderr: '' });
  launch.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CURSOR_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY']) vi.stubEnv(key, '');
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(dir, { recursive: true, force: true }); });

async function sdk(name: string) {
  const root = path.join(dir, 'node_modules', name);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
  await fs.writeFile(path.join(root, 'index.js'), '');
}

describe('setup requirements', () => {
  it('keeps a working bundled subscription runtime usable without Node or npm', async () => {
    await sdk('@anthropic-ai/claude-agent-sdk');
    which.mockReturnValue(null);
    const status = await readHarnessSetup(runtime, settings, 'claude');
    expect(status.availability).toMatchObject({ available: true, authenticated: true, authMethod: 'subscription' });
    expect(status.requirements.find((r) => r.id === 'sdk')?.available).toBe(true);
    expect(status.requirements.find((r) => r.id === 'node')?.available).toBe(false);
    expect(status.canInstall).toBe(false);
    expect(status.loginId).toBe('claude');
    expect(clear).toHaveBeenCalledOnce();
  });
  it('explains missing app SDK repair instead of offering another CLI as a fix', async () => {
    const status = await readHarnessSetup(runtime, settings, 'claude');
    expect(status.availability.available).toBe(false);
    expect(status.availability.detail).toMatch(/repair or reinstall/i);
    expect(status.canInstall).toBe(false);
  });
  it.each(['21.7.0', '22.18.0'])('refuses a new Pi install on Node %s', async (version) => {
    capture.mockResolvedValue({ code: 0, stdout: version, stderr: '' });
    expect(await readHarnessSetup(runtime, settings, 'pi')).toMatchObject({ canInstall: false, installReason: expect.stringContaining('22.19') });
  });
  it('offers the Pi installer when prerequisites are present but not when a runtime is pinned', async () => {
    expect(await readHarnessSetup(runtime, settings, 'pi')).toMatchObject({ canInstall: true, installId: 'pi' });
    settings.binaries.pi = 'a deliberately pinned runtime';
    expect(await readHarnessSetup(runtime, settings, 'pi')).toMatchObject({ canInstall: false, installReason: expect.stringContaining('pinned') });
  });
  it('reports only credential source flags and respects Claude’s opt-in API billing switch', async () => {
    await sdk('@anthropic-ai/claude-agent-sdk');
    vi.stubEnv('ANTHROPIC_API_KEY', 'private-environment-fixture');
    const cli = { available: true, authenticated: 'unknown' as const, source: 'bundled' as const };
    vi.mocked(runtime.availability).mockResolvedValue(cli);
    const before = await readHarnessSetup(runtime, settings, 'claude');
    expect(before.availability.authenticated).toBe('unknown');
    settings.claude.useProviderKey = true;
    const after = await readHarnessSetup(runtime, settings, 'claude');
    expect(after.availability).toMatchObject({ authenticated: true, authMethod: 'api-key' });
    expect(after.providers.find((p) => p.id === 'anthropic')).toEqual({ id: 'anthropic', source: 'environment' });
    expect(JSON.stringify(after)).not.toContain('private-environment-fixture');
    expect(cli.authenticated).toBe('unknown'); // the shared probe snapshot was not mutated
  });
  it('discloses configured Codex API credentials without overwriting a detected subscription or leaking their value', async () => {
    vi.stubEnv('CODEX_API_KEY', 'private-codex-fixture');
    const result = await readHarnessSetup(runtime, settings, 'codex');
    expect(result.availability.authMethod).toBe('subscription');
    expect(result.apiCredentialsMayOverrideLogin).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-codex-fixture');
    vi.mocked(runtime.availability).mockResolvedValue({ available: true, authenticated: false });
    expect((await readHarnessSetup(runtime, settings, 'codex')).availability).toMatchObject({ authenticated: true, authMethod: 'api-key', detail: expect.stringContaining('not been verified') });
  });
  it('rejects a forged harness before probing or resolving dependencies', async () => {
    await expect(readHarnessSetup(runtime, settings, '../../shell' as never)).rejects.toThrow('Unknown harness');
    expect(runtime.availability).not.toHaveBeenCalled();
    expect(which).not.toHaveBeenCalled();
  });
});

describe('vendor-owned sign-in launch', () => {
  it.each([['claude', false, ['auth', 'login', '--claudeai']], ['codex', false, ['login']], ['codex', true, ['login', '--device-auth']]] as const)('uses fixed %s login arguments', (id, device, expected) => {
    expect(loginArgs(id, device)).toEqual(expected);
  });
  it('opens Pi without project extension, prompt, or session loading', () => {
    expect(loginArgs('pi')).toEqual(['--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes']);
  });
  it('launches the resolved Windows runtime with literal-quoted arguments, outside any project', async () => {
    const result = await openHarnessLogin(runtime, 'claude', false, { platform: 'win32', which, spawn: launch as typeof spawn });
    expect(result).toEqual({ ok: true });
    expect(launch).toHaveBeenCalledOnce();
    const [exe, args, options] = launch.mock.calls[0]!;
    expect(exe).toBe(path.join(dir, 'wt.exe'));
    const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    expect(script).toContain("vendor''s $(literal) & cli.exe' 'auth' 'login' '--claudeai'");
    expect(script).toContain('Set-Location -LiteralPath');
    expect(options.cwd).toBe(path.join(runtime.runtimePaths.appRuntimeDir, 'sign-in'));
    expect(options).not.toHaveProperty('shell');
    expect(result).not.toHaveProperty('authenticated');
  });
  it('gives the interactive Windows child its own console when Windows Terminal is absent', async () => {
    which.mockImplementation((tool: string) => tool === 'powershell' ? path.join(dir, 'powershell.exe') : null);
    await openHarnessLogin(runtime, 'codex', true, { platform: 'win32', which, spawn: launch as typeof spawn });
    const [, args, opts] = launch.mock.calls[0]!;
    expect(args).toContain('-NonInteractive');
    const broker = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    expect(broker).toContain('Start-Process -FilePath');
    expect(broker).not.toContain('-NoNewWindow');
    expect(broker).not.toContain('-RedirectStandard');
    expect(opts.windowsHide).toBe(true);
  });
  it('uses separate arguments for a Linux terminal instead of a shell interpolation', async () => {
    await expect(openHarnessLogin(runtime, 'codex', true, { platform: 'linux', which, spawn: launch as typeof spawn })).resolves.toEqual({ ok: true });
    const [, args] = launch.mock.calls[0]!;
    expect(args.slice(-3)).toEqual([runtime.resolve('codex')!.path, 'login', '--device-auth']);
  });
  it('creates an executable, literal-quoted macOS launcher without embedding credentials', async () => {
    await openHarnessLogin(runtime, 'claude', false, { platform: 'darwin', spawn: launch as typeof spawn });
    const [exe, args] = launch.mock.calls[0]!;
    expect(exe).toBe('open'); expect(args.slice(0, 2)).toEqual(['-a', 'Terminal']);
    const script = await fs.readFile(args[2], 'utf8');
    expect(script).toContain("'auth' 'login' '--claudeai'");
    expect(script).toContain("'\"'\"'");
    expect(script).toContain('rm -f -- "$0"');
  });
  it('refuses unsupported harnesses before any side effect', async () => {
    await expect(openHarnessLogin(runtime, 'cursor; echo bad' as never, false, { spawn: launch as typeof spawn })).rejects.toThrow('Unsupported sign-in');
    expect(runtime.resolve).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
  });
  it('explains a missing runtime or terminal and leaves launch uncalled', async () => {
    vi.mocked(runtime.resolve).mockReturnValue(null);
    expect(await openHarnessLogin(runtime, 'codex', false, { spawn: launch as typeof spawn })).toMatchObject({ ok: false, error: expect.stringMatching(/install or repair/i) });
    vi.mocked(runtime.resolve).mockReturnValue({ path: 'fixture', source: 'system' });
    expect(await openHarnessLogin(runtime, 'codex', false, { platform: 'linux', which: () => null, spawn: launch as typeof spawn })).toMatchObject({ ok: false, error: expect.stringMatching(/terminal/i) });
    expect(launch).not.toHaveBeenCalled();
  });
  it.each(['error', 'throw'])('reports a %s launch failure without asserting authentication', async (mode) => {
    launch.mockImplementation(() => {
      if (mode === 'throw') throw new Error('private launcher internals');
      const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('private launcher internals'))); return child;
    });
    const result = await openHarnessLogin(runtime, 'codex', false, { platform: 'win32', which, spawn: launch as typeof spawn });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/retry/i) });
    expect(JSON.stringify(result)).not.toContain('private launcher internals');
  });
});
