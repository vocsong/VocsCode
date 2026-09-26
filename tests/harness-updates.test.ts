// Harness CLI updates (Settings → Providers → Harness logins): the installed-vs-published
// comparison, the npm registry lookup behind it, and the rule that keeps an update button off a
// runtime Vocs Code bundles — Claude Code's SDK binary wins over anything put in the runtime dir,
// so offering "Update to 2.1.283" there would be a button that does nothing.
import { beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RuntimeResolver,
  checkHarnessUpdates,
  clearLatestVersionCache,
  clearWhichCache,
  compareVersions,
  fetchLatestVersion,
  parseVersion
} from '../src/main/runtime';
import type { AppSettings, HarnessAvailability, HarnessId } from '../src/shared/types';

/** A registry stub: a version string answers 200, a number answers that status, a miss rejects. */
function registry(answers: Record<string, string | number>) {
  const calls: string[] = [];
  const fetchImpl = (url: string): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> => {
    const pkg = decodeURIComponent(url.replace('https://registry.npmjs.org/', '').replace('/latest', ''));
    calls.push(pkg);
    const answer = answers[pkg];
    if (answer === undefined) return Promise.reject(new Error('getaddrinfo ENOTFOUND registry.npmjs.org'));
    if (typeof answer === 'number') return Promise.resolve({ ok: false, status: answer, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ version: answer }) });
  };
  return { fetchImpl, calls };
}

const installed = (id: HarnessId, version: string, source: HarnessAvailability['source']): Partial<Record<HarnessId, HarnessAvailability>> => ({
  [id]: { available: true, version, binaryPath: `/bin/${id}`, source }
});

beforeEach(() => {
  clearLatestVersionCache();
});

describe('parseVersion', () => {
  it('reads the version out of each CLI\'s own version line', () => {
    expect(parseVersion('2.1.280 (Claude Code)')).toBe('2.1.280');
    expect(parseVersion('codex-cli 0.154.0')).toBe('0.154.0');
    expect(parseVersion('0.85.1')).toBe('0.85.1');
    expect(parseVersion('0.1.5-rc.3')).toBe('0.1.5-rc.3');
  });

  it('reports no version for output without one', () => {
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('command not found')).toBeNull();
    expect(parseVersion('1.2')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders numeric segments, not text', () => {
    expect(compareVersions('0.87.1', '0.85.1')).toBeGreaterThan(0);
    expect(compareVersions('0.85.1', '0.85.1')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0', '2.0.1')).toBeLessThan(0);
  });

  it('sorts a prerelease below the release it precedes', () => {
    expect(compareVersions('0.1.5-rc.3', '0.1.5')).toBeLessThan(0);
    expect(compareVersions('0.1.5', '0.1.5-rc.3')).toBeGreaterThan(0);
    expect(compareVersions('0.1.5-rc.3', '0.1.5-rc.4')).toBeLessThan(0);
  });
});

describe('fetchLatestVersion', () => {
  it('reads the published version from the registry manifest', async () => {
    const { fetchImpl } = registry({ '@openai/codex': '0.157.1' });
    expect(await fetchLatestVersion('@openai/codex', { fetchImpl })).toEqual({ version: '0.157.1' });
  });

  it('scopes the package name and reports a registry error instead of throwing', async () => {
    const urls: string[] = [];
    const fetchImpl = (url: string) => {
      urls.push(url);
      return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
    };
    expect(await fetchLatestVersion('@earendil-works/pi-coding-agent', { fetchImpl })).toEqual({ error: 'the npm registry answered 503' });
    expect(urls).toEqual(['https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest']);
  });

  it('answers a second call from the cache rather than the network', async () => {
    const { fetchImpl, calls } = registry({ '@openai/codex': '0.157.1' });
    await fetchLatestVersion('@openai/codex', { fetchImpl });
    await fetchLatestVersion('@openai/codex', { fetchImpl });
    expect(calls).toHaveLength(1);
  });
});

describe('checkHarnessUpdates', () => {
  it('offers the update for a CLI the app can replace in its runtime dir', async () => {
    const { fetchImpl } = registry({ '@earendil-works/pi-coding-agent': '0.87.1' });
    const updates = await checkHarnessUpdates(installed('pi', '0.85.1', 'system'), { fetchImpl });
    expect(updates.pi).toEqual({
      package: '@earendil-works/pi-coding-agent',
      current: '0.85.1',
      latest: '0.87.1',
      newer: true,
      updatable: true,
      reason: undefined
    });
  });

  it('reports an up-to-date CLI without an update', async () => {
    const { fetchImpl } = registry({ '@openai/codex': '0.154.0' });
    const updates = await checkHarnessUpdates(installed('codex', 'codex-cli 0.154.0', 'app-runtime'), { fetchImpl });
    expect(updates.codex).toMatchObject({ current: '0.154.0', latest: '0.154.0', newer: false, updatable: true });
  });

  it('holds back a newer version the runtime dir cannot deliver, and says why', async () => {
    const { fetchImpl } = registry({ '@anthropic-ai/claude-code': '2.1.283' });
    const updates = await checkHarnessUpdates(installed('claude', '2.1.280 (Claude Code)', 'bundled'), { fetchImpl });
    expect(updates.claude).toMatchObject({ current: '2.1.280', latest: '2.1.283', newer: true, updatable: false });
    expect(updates.claude?.reason).toContain('bundles');
  });

  it('holds back a pinned binary path with its own reason', async () => {
    const { fetchImpl } = registry({ '@deepseek-ai/dsh': '0.1.6' });
    const updates = await checkHarnessUpdates({ acp: { available: true, version: '0.1.5', source: 'settings' } }, { fetchImpl });
    expect(updates.acp).toMatchObject({ newer: true, updatable: false });
    expect(updates.acp?.reason).toContain('pinned');
  });

  it('reports a registry failure as an error on the row, never as an available update', async () => {
    const { fetchImpl } = registry({});
    const updates = await checkHarnessUpdates(installed('pi', '0.85.1', 'system'), { fetchImpl });
    expect(updates.pi?.newer).toBe(false);
    expect(updates.pi?.error).toContain('ENOTFOUND');
  });

  it('skips a harness that is missing, versionless, or has no npm package', async () => {
    const { fetchImpl, calls } = registry({ '@openai/codex': '0.157.1' });
    const updates = await checkHarnessUpdates(
      {
        pi: { available: false, detail: 'pi not found on PATH.' },
        codex: { available: true, binaryPath: '/bin/codex' },
        native: { available: true, detail: 'Built in.' },
        cursor: { available: true, detail: 'Bundled @cursor/sdk (local runtime)' }
      },
      { fetchImpl }
    );
    expect(updates).toEqual({});
    expect(calls).toEqual([]);
  });

  it('looks the shared package up once for the two ids that run it', async () => {
    const { fetchImpl, calls } = registry({ '@openai/codex': '0.157.1' });
    const updates = await checkHarnessUpdates(
      { ...installed('codex', 'codex-cli 0.154.0', 'system'), ...installed('codex-exec', 'codex-cli 0.154.0', 'system') },
      { fetchImpl }
    );
    expect(calls).toEqual(['@openai/codex']);
    expect(updates.codex?.newer).toBe(true);
    expect(updates['codex-exec']?.newer).toBe(true);
  });
});

describe('an update reaches the version the card shows', () => {
  it('re-probes after an install instead of reporting the version it replaced', async () => {
    // The probe memo keys on the binary path, so a CLI already in the runtime dir would otherwise
    // keep answering with the version it replaced for a minute, and the card would show the update
    // as still pending right after it ran. Replaces npm so no real package is downloaded.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-code-runtime-'));
    const appRuntimeDir = path.join(root, 'runtime');
    const pathBin = path.join(root, 'bin');
    const win = process.platform === 'win32';
    const cliName = win ? 'pi.cmd' : 'pi';
    const cliBody = win ? '@echo off\ntype "%~dp0pi-version.txt"\n' : '#!/bin/sh\ncat "$(dirname "$0")/pi-version.txt"\n';
    const write = (file: string, body: string) => fs.writeFile(file, body.replace(/\n/g, os.EOL), { mode: 0o755 });
    // The app looks for its own installs in the runtime dir itself on Windows and in its bin/ on
    // POSIX; both hold a copy so the test never encodes that layout. `bin` on PATH carries only the
    // fake npm, so the CLI the resolver finds is always the one in the runtime dir.
    const runtimeDirs = [appRuntimeDir, path.join(appRuntimeDir, 'bin')];
    for (const dir of runtimeDirs) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'pi-version.txt'), '0.85.1\n');
      await write(path.join(dir, cliName), cliBody);
    }
    await fs.mkdir(pathBin, { recursive: true });
    await write(
      path.join(pathBin, 'fake-npm.mjs'),
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        'const prefix = process.env.FAKE_RUNTIME_DIR;',
        `const cli = ${JSON.stringify(cliBody)};`,
        'for (const dir of [prefix, path.join(prefix, "bin")]) {',
        '  mkdirSync(dir, { recursive: true });',
        "  writeFileSync(path.join(dir, 'pi-version.txt'), '0.87.1\\n');",
        `  writeFileSync(path.join(dir, ${JSON.stringify(cliName)}), cli, { mode: 0o755 });`,
        '}',
        ''
      ].join('\n')
    );
    await write(
      path.join(pathBin, win ? 'npm.cmd' : 'npm'),
      win ? '@echo off\nnode "%~dp0fake-npm.mjs" %*\n' : '#!/bin/sh\nexec node "$(dirname "$0")/fake-npm.mjs" "$@"\n'
    );

    const previousPath = process.env.PATH;
    const previousRuntime = process.env.FAKE_RUNTIME_DIR;
    process.env.PATH = `${pathBin}${path.delimiter}${previousPath ?? ''}`;
    process.env.FAKE_RUNTIME_DIR = appRuntimeDir;
    clearWhichCache();
    try {
      const runtime = new RuntimeResolver({ appRuntimeDir, resourcesDir: root, appRoot: root }, () => ({ binaries: {} } as AppSettings));
      expect((await runtime.availability('pi')).version).toBe('0.85.1');

      const install = await runtime.install('pi');
      expect(install.ok).toBe(true);

      expect((await runtime.availability('pi')).version).toBe('0.87.1');
    } finally {
      process.env.PATH = previousPath;
      if (previousRuntime === undefined) delete process.env.FAKE_RUNTIME_DIR;
      else process.env.FAKE_RUNTIME_DIR = previousRuntime;
      clearWhichCache();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
