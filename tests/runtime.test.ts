import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings } from '../src/shared/types';
import { MAX_CAPTURE_BYTES, RuntimeResolver, clearWhichCache, runCapture } from '../src/main/runtime';

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
