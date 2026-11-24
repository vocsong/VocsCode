/**
 * The code.vocs.io dashboard in a real browser (Electron's Chromium) against the real relay Worker
 * running locally in workerd, behind a stand-in for the landing. Two real desktop hosts in this
 * process join through the dashboard's own Connect with Vocs page (one through the retired /app
 * link a released desktop opens), upload their analytics snapshots, and the page shows both under
 * its static CSP: combined totals, the computer switcher, per-computer reliability, session rows
 * naming their computer, and a computer that stops sharing.
 * Gated by VOCS_CODE_E2E_UI=1 (the e2e guard sets it); needs no app build and no account, but does
 * build the web bundle (src/web) in beforeAll unless a validated CI prebuild is opted in.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { RemoteHost } from '../src/main/remote/host';
import { AnalyticsSync } from '../src/main/remote/analytics-sync';
import { buildAnalyticsSnapshot, type AnalyticsSnapshot } from '../src/shared/analytics/snapshot';
import { emptyCodeOutputReport } from '../src/shared/analytics/code-output';
import { emptyReliabilityReport } from '../src/shared/analytics/reliability';
import { connectCheckCode } from '../src/shared/pairing';
import { emptyCounters, emptyDimensions, emptySlice } from '../src/shared/usage-rollup';
import type { HandlerRegistry } from '../src/main/handlers';
import type { UsageDay, UsageSessionRecord } from '../src/shared/types';
import { isolatedEnv } from './e2e-ui';
import { startLocalRelay, type LocalRelay } from './support/local-relay';
import { startTestLanding, TEST_SESSION_COOKIE, type TestLanding } from './support/test-landing';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
let relay: LocalRelay | null = null;
let landing: TestLanding | null = null;
const hosts: RemoteHost[] = [];
const browsers: ElectronApplication[] = [];
const browserDirs: string[] = [];

async function validateWebBundle(): Promise<void> {
  const appDir = path.join(root, 'relay', 'public', 'dashboard');
  const html = await fs.readFile(path.join(appDir, 'index.html'), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="(\/dashboard\/assets\/[^"?#]+)"/g)].map((match) => match[1]!);
  if (!assets.some((asset) => asset.endsWith('.js')) || !assets.some((asset) => asset.endsWith('.css'))) {
    throw new Error('prebuilt dashboard is missing its JavaScript or CSS references; run npm run build:web');
  }
  for (const asset of assets) {
    const file = path.resolve(root, 'relay', 'public', asset.slice(1));
    if (!file.startsWith(path.join(appDir, 'assets') + path.sep)) throw new Error(`invalid web asset: ${asset}`);
    if (!(await fs.stat(file)).isFile()) throw new Error(`web asset is not a file: ${asset}`);
  }
}

beforeAll(async () => {
  if (!enabled) return;
  // CI runs npm run build first. Opt in to that artifact only explicitly; a standalone run
  // still builds from source, so an old relay/public/dashboard cannot silently pass as this checkout.
  if (process.env.VOCS_CODE_E2E_WEB_PREBUILT !== '1') {
    const build = spawnSync(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.config.web.ts'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production' }
    });
    if (build.status !== 0) throw new Error(`vite build failed:\n${build.stderr || build.stdout}`);
  }
  try {
    await validateWebBundle();
  } catch (error) {
    throw new Error('dashboard bundle is incomplete; run npm run build:web before setting VOCS_CODE_E2E_WEB_PREBUILT=1', { cause: error });
  }
});

afterEach(async () => {
  const errors: unknown[] = [];
  const stop = async (label: string, action: () => Promise<unknown>) => {
    try { await action(); } catch (error) { errors.push(new Error(`failed to stop ${label}`, { cause: error })); }
  };
  for (const browser of browsers.splice(0).reverse()) {
    await stop('Electron browser', async () => {
      try {
        await browser.close();
      } catch (error) {
        const child = browser.process();
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 5_000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
          });
        }
        throw error;
      }
    });
  }
  for (const host of hosts.splice(0).reverse()) await stop('remote host', () => host.disable());
  const currentLanding = landing;
  landing = null;
  if (currentLanding) await stop('test landing', () => currentLanding.stop());
  const currentRelay = relay;
  relay = null;
  if (currentRelay) await stop('local relay', () => currentRelay.stop());
  for (const dir of browserDirs.splice(0).reverse()) await stop('browser profile', () => fs.rm(dir, { recursive: true, force: true }));
  if (errors.length) throw new AggregateError(errors, 'web dashboard e2e cleanup failed');
}, 60_000);

/** A plain browser window on the page: no preload, no Node, sandboxed, signed in at the landing.
 *  Parked off every display and shown inactive like the other suites, unless VOCS_CODE_E2E_VISIBLE=1. */
const BROWSER_MAIN = `
const { app, BrowserWindow, screen, session } = require('electron');
if (process.env.VOCS_CODE_E2E_VISIBLE !== '1') app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.whenReady().then(async () => {
  const [name, value] = process.env.DASHBOARD_COOKIE.split('=');
  await session.defaultSession.cookies.set({ url: new URL(process.env.DASHBOARD_URL).origin, name, value });
  const win = new BrowserWindow({ width: 1200, height: 900, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  win.once('ready-to-show', () => {
    if (process.env.VOCS_CODE_E2E_VISIBLE === '1') return win.show();
    const displays = screen.getAllDisplays();
    win.setPosition(Math.min(...displays.map((d) => d.bounds.x)) - 1300, Math.min(...displays.map((d) => d.bounds.y)) + 50);
    win.setSkipTaskbar(true);
    win.showInactive();
  });
  win.loadURL(process.env.DASHBOARD_URL);
});
app.on('window-all-closed', () => app.quit());
`;

async function launchBrowser(url: string): Promise<Page> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-web-dashboard-'));
  browserDirs.push(tmp);
  const main = path.join(tmp, 'main.cjs');
  await fs.writeFile(main, BROWSER_MAIN);
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: [main, `--user-data-dir=${path.join(tmp, 'profile')}`],
    env: isolatedEnv(path.join(tmp, 'userData'), { DASHBOARD_URL: url, DASHBOARD_COOKIE: TEST_SESSION_COOKIE }),
    timeout: 60_000
  });
  browsers.push(app);
  return app.firstWindow();
}

function watchCsp(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });
  return violations;
}

const NOW = Date.now();
const today = new Date(NOW).toISOString().slice(0, 10);

/** One computer's analytics: a session in `project` that spent `cost` today. */
function analyticsOf(prefix: string, project: string, cost: number, failures: number): () => AnalyticsSnapshot {
  const by = emptyDimensions();
  by.harness.claude = { ...emptySlice('claude'), costUsd: cost, turns: 2, sessions: [`${prefix}-s1`] };
  by.project[project] = { ...emptySlice(project), costUsd: cost, turns: 2, sessions: [`${prefix}-s1`] };
  const days: Record<string, UsageDay> = { [today]: { ...emptyCounters(), costUsd: cost, turns: 2, by } };
  const sessions: UsageSessionRecord[] = [
    { id: `${prefix}-s1`, title: `${prefix} feature work`, harness: 'claude', provider: 'anthropic', model: 'opus', projectRoot: project, createdAt: NOW, updatedAt: NOW, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: cost, turns: 2 }, toolCalls: 3 }
  ];
  const reports = Object.fromEntries([7, 30, 90, 0].map((range) => {
    const reliability = emptyReliabilityReport(NOW, range);
    reliability.overall.counts.executed = 10;
    reliability.overall.counts.failure = failures;
    return [String(range), { reliability, codeOutput: emptyCodeOutputReport(NOW, range) }];
  }));
  return () => buildAnalyticsSnapshot({ days, sessions, tools: {}, modelTools: {}, harnessTools: {}, harnessModelTools: {}, reports }, { generatedAt: Date.now(), appVersion: '0.11.0', platform: 'win32 x64' });
}

interface Computer {
  host: RemoteHost;
  sync: AnalyticsSync;
  setSharing: (on: boolean) => void;
}

/** A desktop that clicks Connect with Vocs; the returned link is the page it would open. */
async function connectingComputer(name: string, origin: string, snapshot: () => AnalyticsSnapshot): Promise<{ computer: Computer; link: string; checkCode: string }> {
  const secrets = new Map<string, string>();
  const host = new RemoteHost({
    registry: () => ({ channels: () => [], invoke: async () => undefined }) as unknown as HandlerRegistry,
    secrets: { get: async (k) => secrets.get(k), set: async (k, v) => void secrets.set(k, v) },
    pushState: () => undefined,
    log: () => undefined,
    broadcast: () => undefined
  });
  hosts.push(host);
  let link = '';
  await host.signIn(origin, async (url) => void (link = url), name);
  let sharing = true;
  const sync = new AnalyticsSync({ snapshot, request: (p, init) => host.analyticsRequest(p, init), sharing: () => sharing, log: () => undefined });
  const nonceHash = new URL(link).searchParams.get('connect')!;
  return { computer: { host, sync, setSharing: (on) => void (sharing = on) }, link, checkCode: connectCheckCode(nonceHash) };
}

/** Adds the computer from the page, as the signed-in owner, and waits until it is online. */
async function addFromPage(page: Page, computer: Computer, checkCode: string): Promise<void> {
  await page.getByTestId('connect-screen').waitFor({ timeout: 30_000 });
  expect(await page.getByTestId('connect-code').textContent()).toBe(checkCode);
  // The one-time hash is scrubbed from the address bar once read.
  expect(new URL(page.url()).searchParams.has('connect')).toBe(false);
  await page.getByTestId('connect-add').click();
  await expect.poll(() => page.getByTestId('connect-status').textContent({ timeout: 2_000 }), { timeout: 60_000 }).toMatch(/Added/);
  await expect.poll(() => computer.host.state().status, { timeout: 30_000 }).toBe('online');
}

describe.runIf(enabled)('web dashboard in a real browser', () => {
  it('adds two computers through Connect with Vocs, then shows their analytics together and apart', async () => {
    relay = await startLocalRelay();
    landing = await startTestLanding(relay.origin, relay.enrollToken, 'e2e-owner', 'vocs-v1', relay.accountAssertionSecret);

    // A current desktop opens /dashboard?connect=…
    const pc = await connectingComputer('Vocs PC', landing.origin, analyticsOf('pc', 'funCentral', 3, 1));
    expect(new URL(pc.link).pathname).toBe('/dashboard');
    const page = await launchBrowser(pc.link);
    const csp = watchCsp(page);
    await addFromPage(page, pc.computer, pc.checkCode);
    expect(await pc.computer.sync.sync()).toBe('uploaded');

    // A released desktop opens the retired /app?connect=… link; the relay sends it to the dashboard.
    const mac = await connectingComputer('Vocs Macmini', landing.origin, analyticsOf('mac', 'Vocs-Code', 4, 5));
    const retired = new URL(mac.link);
    retired.pathname = '/app';
    await page.goto(retired.toString());
    await addFromPage(page, mac.computer, mac.checkCode);
    expect(new URL(page.url()).pathname).toBe('/dashboard/');
    expect(await mac.computer.sync.sync()).toBe('uploaded');

    // The dashboard: both computers, combined spend, and the switcher.
    await page.getByTestId('connect-done').click();
    await page.getByTestId('dashboard').waitFor({ timeout: 30_000 });
    await expect.poll(() => page.getByTestId('computer-card').count(), { timeout: 30_000 }).toBe(2);
    const cards = page.getByTestId('computer-card');
    // Ordered by name, whatever order the relay stores them in.
    expect(await cards.allInnerTexts()).toEqual([expect.stringContaining('Vocs Macmini'), expect.stringContaining('Vocs PC')]);
    expect((await page.getByTestId('computer-sync').allInnerTexts()).every((t) => t.startsWith('Synced'))).toBe(true);
    expect(await page.getByTestId('computer-spend').allInnerTexts()).toEqual(['$4.00', '$3.00']);
    await page.getByTestId('by-computer').waitFor();
    expect(await page.getByText('$7.00').count()).toBeGreaterThan(0);

    // Sessions name the computer they ran on; reliability is shown per computer.
    await page.getByRole('tab', { name: 'Sessions' }).click();
    await page.getByText('pc feature work').waitFor();
    expect(await page.locator('.slist-computer').allInnerTexts()).toEqual(expect.arrayContaining(['Vocs PC', 'Vocs Macmini']));
    await page.getByRole('tab', { name: 'Reliability' }).click();
    await expect.poll(() => page.getByTestId('per-computer-section').count()).toBe(2);

    // One computer on its own.
    await page.getByRole('radio', { name: 'Vocs Macmini' }).click();
    await expect.poll(() => page.getByTestId('per-computer-section').count()).toBe(0);
    await page.getByRole('tab', { name: 'Overview' }).click();
    expect(await page.getByTestId('by-computer').count()).toBe(0);
    expect(await page.getByText('$4.00').count()).toBeGreaterThan(0);

    // The Mac stops sharing: its copy goes, and the page says so after a refresh.
    mac.computer.setSharing(false);
    expect(await mac.computer.sync.sharingChanged()).toBe('cleared');
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(() => page.getByTestId('computer-sync').allInnerTexts(), { timeout: 30_000 }).toEqual(['Not sharing analytics yet', expect.stringMatching(/^Synced/)]);
    // The selection falls back to all computers, which is now just the PC.
    await expect.poll(() => page.getByTestId('computer-spend').allInnerTexts()).toEqual(['$3.00']);

    expect(csp).toEqual([]);
  });
});
