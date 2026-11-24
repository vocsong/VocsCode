/** Desktop setup: no account secrets or arbitrary command input cross the renderer boundary. */
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { spawn, SpawnOptions } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../src/main/settings';
import { loginArgs, openAntigravityUsage, openHarnessLogin, readHarnessSetup } from '../src/main/harness-setup';
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
    queueMicrotask(() => {
      child.emit('spawn');
      child.emit('exit', 0, null);
    });
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
  it('preserves relative sign-in pins and reports spawn without checking the helper exit', async () => {
    const relative = path.join('missing-sign-in-fixture', 'agy');
    vi.mocked(runtime.resolve).mockReturnValue({ path: relative, source: 'settings' });
    launch.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => {
        child.emit('spawn');
        child.emit('exit', 1, null);
      });
      return child;
    });
    await expect(openHarnessLogin(runtime, 'antigravity', false, { platform: 'linux', which, spawn: launch as typeof spawn })).resolves.toEqual({ ok: true });
    expect(launch.mock.calls[0]![1]).toEqual(['--', relative, 'acp', '--login']);
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

describe('user-driven Antigravity usage launch', () => {
  const accountOverrides = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AGY_ADC_AUTH', 'GOOGLE_APPLICATION_CREDENTIALS'];
  const fixtureCredential = 'secret-fixture-never-forwarded';
  let binary: string;
  let cwd: string;
  const openUsage = (platform: NodeJS.Platform) => openAntigravityUsage(runtime, { platform, which, spawn: launch as typeof spawn });

  beforeEach(async () => {
    binary = path.join(dir, "Google's Antigravity & $(literal)", 'agy.exe');
    cwd = path.join(runtime.runtimePaths.appRuntimeDir, 'antigravity-usage');
    await fs.mkdir(path.dirname(binary));
    await fs.writeFile(binary, 'inert pinned file fixture');
    vi.mocked(runtime.resolve).mockReturnValue({ path: binary, source: 'settings' });
    vi.stubEnv('HOME', dir);
    for (const key of accountOverrides) vi.stubEnv(key === 'GOOGLE_API_KEY' ? 'google_api_key' : key, fixtureCredential);
  });

  function recordedLaunch() {
    expect(runtime.resolve).toHaveBeenCalledExactlyOnceWith('agy');
    expect(runtime.availability).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledOnce();
    const [exe, args, { env, ...options }] = launch.mock.calls[0]! as [string, string[], SpawnOptions];
    expect(options).toMatchObject({ cwd, detached: true, stdio: 'ignore' });
    expect(options).not.toHaveProperty('shell');
    expect(env?.HOME).toBe(dir);
    const envKeys = Object.keys(env ?? {}).map((key) => key.toUpperCase());
    for (const key of accountOverrides) expect(envKeys).not.toContain(key);
    return [exe, args, options] as const;
  }

  it.each(['gnome-terminal', 'konsole'])('runs agy interactively on Linux via %s with paths kept as literal arguments', async (terminal) => {
    which.mockImplementation((tool: string) => tool === terminal ? path.join(dir, tool) : null);
    await expect(openUsage('linux')).resolves.toEqual({ ok: true });
    const [exe, args] = recordedLaunch();
    expect(exe).toBe(path.join(dir, terminal));
    expect(args).toEqual([
      terminal === 'gnome-terminal' ? '--' : '-e', '/bin/sh', '-c',
      `cd "$1" || exit 1\nunset ${accountOverrides.join(' ')}\nshift\nexec "$@"`, 'agy-usage', cwd, binary
    ]);
    if (process.platform !== 'win32') expect((await fs.stat(cwd)).mode & 0o077).toBe(0);
  });

  it.each([true, false])('runs agy in an interactive Windows console (Windows Terminal: %s)', async (hasWt) => {
    const powershell = path.join(dir, 'powershell.exe');
    const wt = path.join(dir, 'wt.exe');
    which.mockImplementation((tool: string) => tool === 'powershell' ? powershell : tool === 'wt' && hasWt ? wt : null);
    await expect(openUsage('win32')).resolves.toEqual({ ok: true });
    const [exe, args, options] = recordedLaunch();
    expect(exe).toBe(hasWt ? wt : powershell);
    expect(options.windowsHide).toBe(!hasWt);
    let encoded = args.at(-1)!;
    if (hasWt) {
      expect(args.slice(0, -1)).toEqual(['new-tab', '--title', 'Vocs Code — antigravity usage', powershell, '-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand']);
    } else {
      expect(args.slice(0, -1)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
      const broker = Buffer.from(encoded, 'base64').toString('utf16le');
      expect(broker).toContain('Start-Process -FilePath');
      expect(broker).not.toMatch(/-NoNewWindow|-RedirectStandard/);
      encoded = /-ArgumentList '-NoLogo -NoProfile -NoExit -EncodedCommand ([A-Za-z0-9+/=]+)'/.exec(broker)?.[1] ?? '';
    }
    expect(Buffer.from(encoded, 'base64').toString('utf16le').split('\n')).toEqual([
      `Set-Location -LiteralPath '${cwd.replaceAll("'", "''")}' -ErrorAction Stop`,
      ...accountOverrides.map((key) => `Remove-Item -LiteralPath 'Env:${key}' -ErrorAction SilentlyContinue`),
      `& '${binary.replaceAll("'", "''")}'`
    ]);
  });

  it('opens a one-use macOS Terminal script that runs agy in the private cwd without embedding credentials', async () => {
    await expect(openUsage('darwin')).resolves.toEqual({ ok: true });
    const [exe, args] = recordedLaunch();
    expect(exe).toBe('open');
    expect(args.slice(0, 2)).toEqual(['-a', 'Terminal']);
    expect(args).toHaveLength(3);
    const file = args[2];
    expect(path.dirname(path.dirname(file))).toBe(cwd);
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o700);
    const script = await fs.readFile(file, 'utf8');
    expect(script).toContain('rm -f -- "$0"');
    expect(script).not.toContain(fixtureCredential);
    const quoted = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
    expect(script.split('\n').slice(-4)).toEqual([
      `cd ${quoted(cwd)} || exit 1`, `unset ${accountOverrides.join(' ')}`, `exec ${quoted(binary)}`, ''
    ]);
  });

  it('resolves a relative settings pin from the host cwd, not the private terminal cwd', async () => {
    const relative = path.relative(dir, binary);
    vi.mocked(runtime.resolve).mockReturnValue({ path: relative, source: 'settings' });
    const hostCwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      await expect(openUsage('linux')).resolves.toEqual({ ok: true });
      const [, args] = recordedLaunch();
      expect(args.slice(-2)).toEqual([cwd, binary]);
    } finally {
      hostCwd.mockRestore();
    }
  });

  it.each(['missing', 'directory'])('rejects a %s settings pin without a probe or launch', async (kind) => {
    vi.mocked(runtime.resolve).mockReturnValue({ path: kind === 'missing' ? path.join(dir, 'missing-agy.exe') : path.dirname(binary), source: 'settings' });
    await expect(openUsage('linux')).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/pinned Antigravity CLI path/i) });
    expect(runtime.availability).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  describe.each([
    ['darwin', 'open'], ['linux', 'gnome-terminal'], ['win32', 'wt'], ['win32', 'powershell']
  ] as const)('%s %s usage helper', (platform, helper) => {
    function startUsage() {
      if (helper === 'powershell') which.mockImplementation((tool: string) => tool === 'powershell' ? path.join(dir, 'powershell.exe') : null);
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      const spawned = new Promise<void>((resolve) => {
        launch.mockImplementationOnce(() => {
          queueMicrotask(() => {
            child.emit('spawn');
            resolve();
          });
          return child;
        });
      });
      return { child, spawned, result: openUsage(platform) };
    }

    it('reports a fast nonzero exit even though the helper spawned', async () => {
      const { child, spawned, result } = startUsage();
      await spawned;
      expect(launch.mock.calls[0]![0]).toBe(helper === 'open' ? helper : path.join(dir, `${helper}.exe`));
      child.emit('exit', 1, null);
      await expect(result).resolves.toEqual({ ok: false, error: 'Could not open the Antigravity usage terminal. Check your terminal installation and retry.' });
    });

    it('accepts a still-running helper without waiting for the visible terminal to close', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const { child, spawned, result } = startUsage();
        const reported = vi.fn();
        void result.then(reported);
        await spawned;
        expect(child.unref).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(reported).toHaveBeenCalledExactlyOnceWith({ ok: true });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('reports a missing agy or terminal without spawning anything', async () => {
    vi.mocked(runtime.resolve).mockReturnValueOnce(null);
    await expect(openUsage('linux')).resolves.toEqual({ ok: false, error: expect.stringMatching(/install or repair/i) });
    expect(which).not.toHaveBeenCalled();
    which.mockReturnValue(null);
    await expect(openUsage('linux')).resolves.toEqual({ ok: false, error: expect.stringMatching(/no terminal application/i) });
    expect(launch).not.toHaveBeenCalled();
  });

  it('returns a bounded error when the private working directory cannot be created', async () => {
    await fs.writeFile(runtime.runtimePaths.appRuntimeDir, 'not a directory');
    const result = await openUsage('linux');
    expect(result).toEqual({ ok: false, error: 'Could not prepare the Antigravity usage terminal. Check setup and retry.' });
    expect(launch).not.toHaveBeenCalled();
  });
});
