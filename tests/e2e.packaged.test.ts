/** Release-tier startup smoke for the actual Windows unpacked app. No harness prompt or provider.
 * Run after dist:dir: HARNESS_E2E_EXE="dist/win-unpacked/Vocs Code.exe"
 * node scripts/e2e-guard.mjs tests/e2e.packaged.test.ts
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { expectQuietWindow, isolatedEnv, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(import.meta.dirname, '..');
const artifacts = path.join(root, 'tests', 'artifacts', 'packaged-smoke');

async function bounded<T>(label: string, work: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe.runIf(enabled)('electron e2e: packaged startup', () => {
  it('loads the packaged renderer and core IPC in a fresh profile, then exits cleanly', async () => {
    const executable = process.env.HARNESS_E2E_EXE;
    const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { version: string };
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-packaged-smoke-'));
    const userData = path.join(tmp, 'userData');
    await fs.mkdir(userData);
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(tmp));
    let app: ElectronApplication | undefined;
    let win: Page | undefined;
    const mainLog: string[] = [];
    const rendererLog: string[] = [];
    const pageErrors: string[] = [];
    let failed = false;
    try {
      // Never fall back to development Electron: that would make a broken package green.
      expect(executable, 'HARNESS_E2E_EXE must name the Windows unpacked executable').toBeTruthy();
      expect(process.platform).toBe('win32');
      await fs.access(executable!);
      await bounded('packaged startup and IPC', (async () => {
        app = await electron.launch({
          executablePath: path.resolve(executable!),
          args: [`--user-data-dir=${userData}`],
          env: isolatedEnv(userData, { VOCS_CODE_DEBUG: '1' }),
          timeout: 60_000,
        });
        app.process().stdout?.on('data', (data: Buffer) => mainLog.push(data.toString()));
        app.process().stderr?.on('data', (data: Buffer) => mainLog.push(data.toString()));
        win = await app.firstWindow({ timeout: 30_000 });
        win.on('console', (message) => rendererLog.push(`[${message.type()}] ${message.text()}`));
        win.on('pageerror', (error) => pageErrors.push(error.message));
        await win.locator('.brand').waitFor({ timeout: 30_000 });
        expect(win.url()).toMatch(/^file:/);
        await expectQuietWindow(app);
        const appPath = await app.evaluate(({ app }) => app.getAppPath());
        expect(path.basename(appPath)).toBe('app.asar');
        // This crosses the real renderer -> preload -> registered main handler boundary.
        const info = await win.evaluate(() => window.harness.invoke('app:info', undefined));
        expect(info).toEqual({ version, platform: 'win32', userData, isPackaged: true });
        expect(await win.evaluate(() => window.harness.invoke('sessions:list', undefined))).toEqual([]);
        expect(pageErrors, 'the packaged renderer must not throw during startup').toEqual([]);
      })(), 90_000);
      const child = app!.process();
      await bounded('packaged shutdown', app!.close(), 15_000);
      expect(child.exitCode, 'shutdown must exit successfully, not be killed').toBe(0);
      expect(child.signalCode).toBeNull();
      app = undefined;
    } catch (error) {
      failed = true;
      await fs.mkdir(artifacts, { recursive: true });
      await fs.writeFile(path.join(artifacts, 'failure.txt'), error instanceof Error ? error.stack ?? error.message : String(error));
      await win?.screenshot({ path: path.join(artifacts, 'renderer.png'), timeout: 5_000 }).catch(() => undefined);
      throw error;
    } finally {
      if (app && app.process().exitCode === null && app.process().signalCode === null) {
        await bounded('failure cleanup', app.close(), 15_000).catch(() => app?.process().kill());
      }
      if (failed) {
        await fs.writeFile(path.join(artifacts, 'stdio.log'), mainLog.join(''));
        await fs.writeFile(path.join(artifacts, 'renderer.log'), [...rendererLog, ...pageErrors].join('\n'));
        await fs.copyFile(path.join(userData, 'logs', 'main.log'), path.join(artifacts, 'main.log')).catch(() => undefined);
      }
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 150_000);
});
