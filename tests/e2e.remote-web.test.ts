/**
 * The code.vocs.io web client in a real browser (Electron's Chromium) against the real relay Worker
 * running locally in workerd, with real desktop hosts in this process approving the pairings. It is
 * the only suite that runs the page itself: the native WebSocket, IndexedDB holding non-extractable
 * keys across a reload, the static CSP, the pairing link, the computer switcher and unpair.
 * Gated by VOCS_CODE_E2E_UI=1 (the e2e guard sets it); needs no app build and no account.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { RemoteHost } from '../src/main/remote/host';
import type { HandlerRegistry } from '../src/main/handlers';
import { isolatedEnv } from './e2e-ui';
import { startLocalRelay, type LocalRelay } from './support/local-relay';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const require = createRequire(import.meta.url);
let app: ElectronApplication | null = null;
let relay: LocalRelay | null = null;
const hosts: RemoteHost[] = [];

afterAll(async () => {
  await app?.close().catch(() => undefined);
  for (const host of hosts) await host.disable();
  await relay?.stop();
});

/** A plain browser window on the page: no preload, no Node, sandboxed. Parked off every display and
 *  shown inactive like the other suites, unless VOCS_CODE_E2E_VISIBLE=1. */
const BROWSER_MAIN = `
const { app, BrowserWindow, screen } = require('electron');
if (process.env.VOCS_CODE_E2E_VISIBLE !== '1') app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  win.once('ready-to-show', () => {
    if (process.env.VOCS_CODE_E2E_VISIBLE === '1') return win.show();
    const displays = screen.getAllDisplays();
    win.setPosition(Math.min(...displays.map((d) => d.bounds.x)) - 1300, Math.min(...displays.map((d) => d.bounds.y)) + 50);
    win.setSkipTaskbar(true);
    win.showInactive();
  });
  win.loadURL(process.env.REMOTE_WEB_URL);
});
app.on('window-all-closed', () => app.quit());
`;

interface Desk {
  host: RemoteHost;
  sent: unknown[];
}

async function desk(name: string, origin: string, enrollToken: string): Promise<Desk> {
  const sent: unknown[] = [];
  const secrets = new Map<string, string>();
  const registry = {
    channels: () => [],
    invoke: async (channel: string, request: unknown) => {
      switch (channel) {
        case 'settings:get':
          return { remote: { viewOnly: false }, folders: [] };
        case 'sessions:list':
          return [{ id: `${name}-s1`, title: `${name} session`, status: 'idle' }];
        case 'sessions:transcriptPage':
          return { items: [{ id: 'm1', kind: 'user', ts: 1, text: `hello ${name}` }, { id: 'm2', kind: 'assistant', ts: 2, text: `answer from ${name}` }], start: 0, total: 2 };
        case 'sessions:send':
          sent.push(request);
          return undefined;
        default:
          throw new Error(`unexpected channel ${channel}`);
      }
    }
  } as unknown as HandlerRegistry;
  const host = new RemoteHost({
    registry: () => registry,
    secrets: { get: async (k) => secrets.get(k), set: async (k, v) => void secrets.set(k, v) },
    pushState: () => undefined,
    log: () => undefined,
    broadcast: () => undefined
  });
  hosts.push(host);
  await host.enable(origin, enrollToken);
  return { host, sent };
}

async function approve(host: RemoteHost, browserName: string): Promise<void> {
  await expect.poll(() => host.state().pendingRequest?.name, { timeout: 30_000 }).toBe(browserName);
  await host.respondPairing('approve');
}

describe.runIf(enabled)('remote web client in a real browser', () => {
  it('pairs from the link, survives a reload, switches computers, sends, and unpairs', async () => {
    relay = await startLocalRelay();
    const work = await desk('Work', relay.origin, relay.enrollToken);
    const { code } = await work.host.startPairing('Work PC');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-remote-web-'));
    const main = path.join(tmp, 'main.cjs');
    await fs.writeFile(main, BROWSER_MAIN);
    app = await electron.launch({
      executablePath: require('electron') as string,
      args: [main, `--user-data-dir=${path.join(tmp, 'profile')}`],
      env: isolatedEnv(path.join(tmp, 'userData'), { REMOTE_WEB_URL: `${relay.origin}/app/?code=${code}` }),
      timeout: 60_000
    });
    const page: Page = await app.firstWindow();
    const cspViolations: string[] = [];
    page.on('console', (message) => {
      if (/Content Security Policy|Refused to/i.test(message.text())) cspViolations.push(message.text());
    });

    // The link fills the code; pairing still needs a human on each side.
    await expect.poll(() => page.locator('#code').inputValue(), { timeout: 30_000 }).toBe(code);
    expect(new URL(page.url()).searchParams.has('code')).toBe(false);
    await page.locator('#device-name').fill('E2E Chromium');
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await page.locator('#screen-pairing').waitFor({ state: 'visible' });
    await approve(work.host, 'E2E Chromium');

    // Connected over the native WebSocket: sessions and the transcript render.
    await expect.poll(() => page.locator('#conn').textContent(), { timeout: 30_000 }).toBe('connected');
    await page.locator('#session-list').getByText('Work session').waitFor();
    await page.locator('#transcript').getByText('answer from Work').waitFor();
    await expect.poll(async () => (await page.locator('#host-select option').allTextContents()).join('|'), { timeout: 20_000 }).toBe('Work PC · online');

    // A reload restores the pairing from IndexedDB: the non-extractable keys still sign.
    await page.reload();
    await expect.poll(() => page.locator('#conn').textContent(), { timeout: 30_000 }).toBe('connected');
    await page.locator('#transcript').getByText('answer from Work').waitFor();

    // A prompt reaches the desktop sealed.
    await page.locator('#composer').fill('ship it');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => work.sent.length, { timeout: 20_000 }).toBe(1);
    expect(work.sent[0]).toEqual({ id: 'Work-s1', input: { text: 'ship it' } });

    // A second computer: pair it, then switch between the two.
    const home = await desk('Home', relay.origin, relay.enrollToken);
    const second = await home.host.startPairing('Home PC');
    await page.getByRole('button', { name: 'Add a computer' }).click();
    await expect.poll(() => page.locator('#pair-title').textContent()).toBe('Add a computer');
    await page.locator('#code').fill(second.code);
    await page.locator('#device-name').fill('E2E Chromium 2');
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await approve(home.host, 'E2E Chromium 2');
    await page.locator('#transcript').getByText('answer from Home').waitFor({ timeout: 30_000 });
    await expect.poll(async () => (await page.locator('#host-select option').allTextContents()).length).toBe(2);
    const workHostId = (await work.host.listDevices()).find((d) => d.kind === 'host' && d.name === 'Work PC')!.deviceId;
    await page.locator('#host-select').selectOption(workHostId);
    await page.locator('#transcript').getByText('answer from Work').waitFor({ timeout: 30_000 });

    // Unpair the active computer: the relay forgets this browser's device for it, and only it.
    const before = (await home.host.listDevices()).filter((d) => d.kind === 'web');
    expect(before).toHaveLength(2);
    await page.getByRole('button', { name: 'Unpair browser' }).click();
    await expect.poll(async () => (await page.locator('#host-select option').allTextContents()).map((t) => t.split(' · ')[0])).toEqual(['Home PC']);
    await expect.poll(async () => (await home.host.listDevices()).filter((d) => d.kind === 'web').length, { timeout: 20_000 }).toBe(1);
    await page.locator('#transcript').getByText('answer from Home').waitFor({ timeout: 30_000 });

    expect(cspViolations).toEqual([]);
  }, 180_000);
});
