/** Packaged in-app auto-update (issue #198) against a staged mock update feed.
 *
 *  A packaged app reads `resources/app-update.yml`, checks at startup, and downloads a newer
 *  release after a manual check. The feed serves a dummy installer, so the test records the
 *  install-on-quit handoff in place of launching it.
 *
 *  Run after `npm run build` and `npm run dist:dir -- --publish never`:
 *  HARNESS_E2E_EXE="dist/win-unpacked/Vocs Code.exe" node scripts/e2e-guard.mjs tests/e2e.update.test.ts
 */
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { IpcChannel, IpcRequest, IpcResponse } from '../src/shared/ipc';
import type { UpdateState } from '../src/shared/types';
import { isolatedEnv, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const packaged = process.env.HARNESS_E2E_EXE;
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
/** Per-run updater cache dir name, so a previous run's downloaded installer can never satisfy a
 *  new run's download (electron-updater skips the request when the cached file's sha512 matches). */
const cacheDirName = `vocs-code-update-e2e-${crypto.randomBytes(4).toString('hex')}`;

function invoke<K extends IpcChannel>(win: Page, channel: K, request: IpcRequest<K>): Promise<IpcResponse<K>> {
  return win.evaluate(({ channel, request }) => window.harness.invoke(channel, request), { channel, request }) as Promise<IpcResponse<K>>;
}

/** Loopback feed with independently counted metadata and installer requests. */
interface Feed {
  url: string;
  manifestRequests: number;
  installerRequests: number;
  publish(version: string): void;
  stop(): Promise<void>;
}

async function startFeed(initialVersion: string): Promise<Feed> {
  const installer = Buffer.alloc(64 * 1024, 7);
  const sha512 = crypto.createHash('sha512').update(installer).digest('base64');
  let version = initialVersion;
  let manifestRequests = 0;
  let installerRequests = 0;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const name = `Vocs-Code-Setup-${version}.exe`;
    if (pathname === `/${name}`) {
      installerRequests++;
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(installer);
      return;
    }
    if (pathname !== '/latest.yml') {
      res.writeHead(404).end();
      return;
    }
    manifestRequests++;
    res.writeHead(200, { 'content-type': 'text/yaml' });
    res.end([
      `version: ${version}`,
      "releaseDate: '2026-01-01T00:00:00.000Z'",
      'files:',
      `  - url: ${name}`,
      `    sha512: ${sha512}`,
      `    size: ${installer.length}`
    ].join('\n'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    get manifestRequests() {
      return manifestRequests;
    },
    get installerRequests() {
      return installerRequests;
    },
    publish(nextVersion) {
      version = nextVersion;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}

async function launch(executablePath: string, args: string[], env: Record<string, string>): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({ executablePath, args, env, timeout: 90_000 });
  const win = await app.firstWindow();
  await expect.poll(() => win.evaluate(() => typeof window.harness?.invoke), { timeout: 30_000 }).toBe('function');
  return { app, win };
}

/** Waits for the update state to reach a status; polls invoke('update:state'). */
async function waitForState(win: Page, status: UpdateState['status'], timeout = 60_000): Promise<UpdateState> {
  let last: UpdateState | null = null;
  await expect
    .poll(
      async () => {
        last = await invoke(win, 'update:state', undefined);
        return last.status;
      },
      { timeout, interval: 1_000 }
    )
    .toBe(status);
  return last!;
}

describe.runIf(enabled)('electron e2e: in-app auto-update', () => {
  let feed: Feed;

  afterEach(async () => {
    if (feed) await feed.stop();
  });

  it('an unpackaged run never checks the feed', async () => {
    expect(process.env.VOCS_CODE_E2E_UI, 'Set VOCS_CODE_E2E_UI=1 to launch Electron').toBe('1');
    feed = await startFeed('999.0.0');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-update-dev-'));
    const userData = path.join(tmp, 'userData');
    await fs.mkdir(userData, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(userData));
    const { app, win } = await launch(require('electron') as string, [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`], isolatedEnv(userData, { VOCS_CODE_UPDATER_DISABLE: '' }));
    try {
      // Past the deferred-check moment (5s after startup), the feed must still be untouched.
      const state = await waitForState(win, 'idle');
      expect(state.status).toBe('idle');
      await new Promise((r) => setTimeout(r, 8_000));
      expect(await invoke(win, 'update:check', undefined)).toEqual({ status: 'idle' });
      expect(feed.manifestRequests).toBe(0);
      expect(feed.installerRequests).toBe(0);
    } finally {
      await app.close();
    }
  });

  it.runIf(packaged)('checks at startup, shows the update beside Settings and hands it off on quit', async () => {
    feed = await startFeed('0.0.0');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-update-app-'));
    const userData = path.join(tmp, 'userData');
    const installCalls = path.join(tmp, 'install-calls.jsonl');
    await fs.mkdir(userData, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(userData, { sidebarWidth: 200 }));
    // Stage the feed the way electron-builder would on a real install: resources/app-update.yml
    // in the unpacked app, pointed at the local mock (a real install points at GitHub Releases).
    const configPath = path.join(path.dirname(packaged!), 'resources', 'app-update.yml');
    const originalConfig = await fs.readFile(configPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    await fs.writeFile(configPath, `provider: generic\nurl: ${feed.url}\nupdaterCacheDirName: ${cacheDirName}\n`);
    let app: ElectronApplication | undefined;
    try {
      const launchResult = await launch(packaged!, [`--user-data-dir=${userData}`], isolatedEnv(userData, { VOCS_CODE_UPDATER_DISABLE: '' }));
      app = launchResult.app;
      const { win } = launchResult;
      // Exercise the real NSIS quit hook. Record its handoff instead of executing the dummy file.
      await app.evaluate(({ app: electronApp }, recordPath) => {
        const { createRequire } = process.getBuiltinModule('node:module')!;
        const { appendFileSync } = process.getBuiltinModule('node:fs')!;
        const requireFromApp = createRequire(`${electronApp.getAppPath()}/package.json`);
        const { autoUpdater, NsisUpdater } = requireFromApp('electron-updater') as typeof import('electron-updater');
        if (!(autoUpdater instanceof NsisUpdater)) throw new Error('Expected the packaged Windows NSIS updater');
        Object.defineProperty(autoUpdater, 'doInstall', {
          value: (options: unknown) => {
            appendFileSync(recordPath, `${JSON.stringify(options)}\n`);
            return true;
          }
        });
      }, installCalls);
      await waitForState(win, 'up-to-date');
      expect(feed.manifestRequests).toBe(1);
      expect(feed.installerRequests).toBe(0);

      const footer = win.locator('.sidebar-bottom');
      const settings = footer.getByRole('button', { name: 'Settings', exact: true });
      expect(await footer.locator('.update-pill').count()).toBe(0);
      await settings.click();
      await win.getByRole('button', { name: 'About & doctor' }).click();
      const panel = win.locator('.settings-updates');
      expect(await panel.textContent()).toContain('You are up to date.');
      feed.publish('999.0.0');
      await panel.getByRole('button', { name: 'Check for updates' }).click();

      expect(await waitForState(win, 'restart-pending')).toEqual({ status: 'restart-pending', version: '999.0.0' });
      expect(feed.manifestRequests).toBe(2);
      expect(feed.installerRequests).toBe(1);
      await panel.getByRole('button', { name: 'Restart to update' }).waitFor({ timeout: 10_000 });
      expect(await panel.textContent()).toContain('Update 999.0.0 is ready.');
      const install = footer.getByRole('button', { name: 'Install update' });
      await install.waitFor({ timeout: 10_000 });
      const [settingsBounds, installBounds] = await Promise.all([settings.boundingBox(), install.boundingBox()]);
      if (!settingsBounds || !installBounds) throw new Error('Expected visible Settings and update buttons');
      const settingsCenter = settingsBounds.y + settingsBounds.height / 2;
      const installCenter = installBounds.y + installBounds.height / 2;
      expect(installBounds.x).toBeGreaterThan(settingsBounds.x + settingsBounds.width);
      expect(Math.abs(installCenter - settingsCenter)).toBeLessThan(1);
      await expect(fs.stat(installCalls)).rejects.toMatchObject({ code: 'ENOENT' });

      await app.close();
      app = undefined;
      const calls = (await fs.readFile(installCalls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(calls).toEqual([expect.objectContaining({ isSilent: true, isForceRunAfter: false })]);
    } finally {
      try {
        await app?.close();
      } finally {
        if (originalConfig) await fs.writeFile(configPath, originalConfig);
        else await fs.rm(configPath, { force: true });
      }
    }
  });
});
