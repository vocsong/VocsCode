import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings } from '../src/shared/types';
import { MAX_CAPTURE_BYTES, RuntimeResolver, clearWhichCache, runCapture } from '../src/main/runtime';
import { defaultSettings } from '../src/main/settings';

const temporaryDirs: string[] = [];
afterEach(async () => {
  clearWhichCache();
  await Promise.all(temporaryDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// The SDK uses spawn without a shell for pathToClaudeCodeExecutable. An npm .cmd shim works for
// version probes but is not a launchable SDK runtime, even in system-only or pinned mode.
describe.skipIf(process.platform !== 'win32')('Claude SDK runtime selection on Windows', () => {
  let previousPath: string | undefined;
  beforeEach(() => {
    previousPath = process.env.PATH;
    process.env.PATH = '';
    clearWhichCache();
  });
  afterEach(() => {
    process.env.PATH = previousPath;
    clearWhichCache();
  });

  async function fixture(runtime: 'auto' | 'system', pinned?: string) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-claude-runtime-'));
    temporaryDirs.push(root);
    const appRuntimeDir = path.join(root, 'runtime');
    await fs.mkdir(appRuntimeDir);
    const shim = path.join(appRuntimeDir, 'claude.cmd');
    await fs.writeFile(shim, '@echo off\r\n');
    const settings = { binaries: pinned ? { claude: pinned } : {}, claude: { runtime }, codex: { runtime: 'auto' } } as AppSettings;
    const resolver = new RuntimeResolver({ appRuntimeDir, resourcesDir: root, appRoot: root }, () => settings);
    return { root, shim, resolver };
  }

  it('does not offer a batch shim as a working Claude harness when the SDK binary is missing', async () => {
    const { resolver } = await fixture('auto');
    expect(resolver.resolve('claude')).toBeNull();
    expect(await resolver.availability('claude')).toMatchObject({ available: false });
  });

  it('rejects a batch shim even when selected by system-only mode or an explicit binary path', async () => {
    const { resolver, shim } = await fixture('system');
    expect(resolver.resolve('claude')).toBeNull();
    const { resolver: pinned } = await fixture('auto', shim);
    expect(pinned.resolve('claude')).toBeNull();
  });

  it('finds a native executable later on PATH when the first match is a shim', async () => {
    const { root, resolver } = await fixture('system');
    const laterDir = path.join(root, 'later');
    await fs.mkdir(laterDir);
    const binary = path.join(laterDir, 'claude.exe');
    await fs.writeFile(binary, '');
    const previousPath = process.env.PATH;
    process.env.PATH = laterDir;
    clearWhichCache();
    try {
      expect(resolver.resolve('claude')).toEqual({ path: binary, source: 'system' });
    } finally {
      process.env.PATH = previousPath;
      clearWhichCache();
    }
  });

  it('prefers the SDK native executable over a batch shim in auto mode', async () => {
    const { root, resolver } = await fixture('auto');
    const binary = path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe');
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(binary, '');
    expect(resolver.resolve('claude')).toEqual({ path: binary, source: 'bundled' });
  });

  // `npm i -g @anthropic-ai/claude-code` (what `claude update` refreshes) writes this shim layout.
  async function npmShim(dir: string): Promise<string> {
    const binary = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(binary, '');
    await fs.writeFile(path.join(dir, 'claude.cmd'), '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n');
    return binary;
  }

  it.each(['auto', 'system'] as const)('runs the native binary behind a global npm shim over the bundled runtime (%s)', async (runtime) => {
    const { root } = await fixture(runtime);
    const resolver = new RuntimeResolver({ appRuntimeDir: path.join(root, 'empty-runtime'), resourcesDir: root, appRoot: root }, () => ({ binaries: {}, claude: { runtime }, codex: { runtime: 'auto' } }) as AppSettings);
    const bundled = path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe');
    await fs.mkdir(path.dirname(bundled), { recursive: true });
    await fs.writeFile(bundled, '');
    const globalDir = path.join(root, 'npm-global');
    await fs.mkdir(globalDir);
    const binary = await npmShim(globalDir);
    process.env.PATH = globalDir;
    clearWhichCache();
    expect(resolver.resolve('claude')).toEqual({ path: binary, source: 'system' });
  });

  it('runs the binary an app-runtime install put behind its shim, so the settings update takes effect', async () => {
    const { root, resolver } = await fixture('auto');
    const binary = await npmShim(path.join(root, 'runtime'));
    expect(resolver.resolve('claude')).toEqual({ path: binary, source: 'app-runtime' });
  });
});

describe('bundled runtime intent', () => {
  it('resolves Codex from ancestor dependencies in a worktree, like the Claude SDK', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-codex-runtime-'));
    temporaryDirs.push(root);
    const appRoot = path.join(root, 'worktrees', 'feature');
    const name = `@openai/codex-${process.platform}-${process.arch}`;
    const pkg = path.join(root, 'node_modules', name);
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    const triple = `${arch}-${process.platform === 'win32' ? 'pc-windows-msvc' : process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
    const binary = path.join(pkg, 'vendor', triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
    await fs.mkdir(path.dirname(binary), { recursive: true }); await fs.mkdir(appRoot, { recursive: true });
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name })); await fs.writeFile(binary, '');
    const settings = defaultSettings(); settings.codex.runtime = 'bundled';
    const resolver = new RuntimeResolver({ appRoot, appRuntimeDir: path.join(root, 'runtime'), resourcesDir: root }, () => settings);
    expect(resolver.resolve('codex')).toEqual({ path: binary, source: 'bundled' });
  });
  it.each(['claude', 'codex'] as const)('does not silently substitute another %s runtime when bundled-only is missing', async (tool) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-pinned-runtime-'));
    temporaryDirs.push(root);
    const appRoot = path.join(root, 'app'), appRuntimeDir = path.join(root, 'runtime');
    const binDir = process.platform === 'win32' ? appRuntimeDir : path.join(appRuntimeDir, 'bin');
    await fs.mkdir(appRoot); await fs.mkdir(binDir, { recursive: true });
    const binary = path.join(binDir, process.platform === 'win32' ? `${tool}.exe` : tool);
    await fs.writeFile(binary, '', { mode: 0o755 });
    const settings = defaultSettings(); settings[tool].runtime = 'bundled';
    const resolver = new RuntimeResolver({ appRoot, appRuntimeDir, resourcesDir: root }, () => settings);
    expect(resolver.resolve(tool)).toBeNull();
    settings.binaries[tool] = binary;
    expect(resolver.resolve(tool)).toEqual({ path: binary, source: 'settings' });
  });
});

describe('runCapture output limits', () => {
  it('caps large stdout without retaining an unbounded string', async () => {
    const result = await runCapture(process.execPath, ['-e', `process.stdout.write('x'.repeat(${MAX_CAPTURE_BYTES + 1024}))`], { timeoutMs: 30_000 });
    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBe(MAX_CAPTURE_BYTES);
    expect(result.truncated).toBe(true);
  });

  it('caps stdout and stderr independently', async () => {
    const result = await runCapture(
      process.execPath,
      ['-e', `process.stdout.write('o'.repeat(${MAX_CAPTURE_BYTES + 1})); process.stderr.write('e'.repeat(${MAX_CAPTURE_BYTES + 1}))`],
      { timeoutMs: 30_000 }
    );
    expect(Buffer.byteLength(result.stdout)).toBe(MAX_CAPTURE_BYTES);
    expect(Buffer.byteLength(result.stderr)).toBe(MAX_CAPTURE_BYTES);
    expect(result.truncated).toBe(true);
  });
});
