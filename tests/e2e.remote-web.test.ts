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
import { startTestLanding, TEST_SESSION_COOKIE, type TestLanding } from './support/test-landing';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const require = createRequire(import.meta.url);
let app: ElectronApplication | null = null;
let relay: LocalRelay | null = null;
let ownerApp: ElectronApplication | null = null;
let landing: TestLanding | null = null;
const hosts: RemoteHost[] = [];

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await ownerApp?.close().catch(() => undefined);
  for (const host of hosts) await host.disable();
  await landing?.stop();
  await relay?.stop();
});

/** A plain browser window on the page: no preload, no Node, sandboxed. Parked off every display and
 *  shown inactive like the other suites, unless VOCS_CODE_E2E_VISIBLE=1. */
const BROWSER_MAIN = `
const { app, BrowserWindow, screen, session } = require('electron');
if (process.env.VOCS_CODE_E2E_VISIBLE !== '1') app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.whenReady().then(async () => {
  // Signed in with GitHub, as far as the (test) landing is concerned.
  if (process.env.REMOTE_WEB_COOKIE) {
    const [name, value] = process.env.REMOTE_WEB_COOKIE.split('=');
    await session.defaultSession.cookies.set({ url: process.env.REMOTE_WEB_URL, name, value });
  }
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

async function desk(name: string, origin: string, enrollToken: string, enable = true): Promise<Desk> {
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
        case 'terminal:list':
          return [{ id: `${name}-t1`, sessionId: `${name}-s1`, title: 'build', shell: 'bash', shellName: 'bash', cwd: '/repo', createdAt: 1 }];
        case 'terminal:screen':
          return { info: { id: `${name}-t1` }, lines: [`$ npm test`, `${name} terminal says hi`], seq: 1 };
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
  if (enable) await host.enable(origin, enrollToken);
  return { host, sent };
}

/** A desktop like desk(), but with no enrollment secret: Connect with GitHub registers it. */
async function signInDesk(name: string): Promise<Desk> {
  const created = await desk(name, '', '', false);
  return created;
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

    // The desktop's terminal, read-only: a snapshot polled while the panel is open.
    await page.getByRole('button', { name: 'Terminal' }).click();
    await page.locator('#terminal-screen').getByText('Work terminal says hi').waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Terminal' }).click();
    await expect.poll(() => page.locator('#terminal-panel').isHidden()).toBe(true);

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

  it('adds a computer with Connect with GitHub, then pairs another from the signed-in list, with no code or secret', async () => {
    relay ??= await startLocalRelay();
    landing = await startTestLanding(relay.origin, relay.enrollToken);
    // Desktops with no enrollment secret: they go through the landing, as they would at code.vocs.io.
    const office = await signInDesk('Office');
    let link = '';
    await office.host.signIn(landing.origin, async (url) => void (link = url), 'Office PC');
    const checkCode = office.host.state().signIn?.checkCode;
    expect(checkCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-remote-web-owner-'));
    const main = path.join(tmp, 'main.cjs');
    await fs.writeFile(main, BROWSER_MAIN);
    ownerApp = await electron.launch({
      executablePath: require('electron') as string,
      args: [main, `--user-data-dir=${path.join(tmp, 'profile')}`],
      env: isolatedEnv(path.join(tmp, 'userData'), { REMOTE_WEB_URL: link, REMOTE_WEB_COOKIE: TEST_SESSION_COOKIE }),
      timeout: 60_000
    });
    const page: Page = await ownerApp.firstWindow();
    const cspViolations: string[] = [];
    page.on('console', (message) => {
      if (/Content Security Policy|Refused to/i.test(message.text())) cspViolations.push(message.text());
    });

    // The page the desktop opened asks before adding anything, and shows the desktop's own code.
    await page.locator('#screen-connect').waitFor({ state: 'visible', timeout: 30_000 });
    expect(await page.locator('#connect-code').textContent()).toBe(checkCode);
    expect(new URL(page.url()).searchParams.has('connect')).toBe(false);
    expect(await office.host.isRegistered()).toBe(false);
    await page.locator('#connect-device-name').fill('Signed-in Chromium');
    await page.getByRole('button', { name: 'Add this computer' }).click();
    // Added, then this browser asks to pair; the desktop still decides.
    await approve(office.host, 'Signed-in Chromium');
    await expect.poll(() => page.locator('#conn').textContent(), { timeout: 30_000 }).toBe('connected');
    await page.locator('#transcript').getByText('answer from Office').waitFor({ timeout: 30_000 });
    expect(await office.host.isRegistered()).toBe(true);

    // A second computer, added from its own Connect with GitHub, is picked from the list: no code.
    const lab = await signInDesk('Lab');
    let labLink = '';
    await lab.host.signIn(landing.origin, async (url) => void (labLink = url), 'Lab PC');
    const grant = await fetch(`${landing.origin}/v1/owner/enroll-grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: TEST_SESSION_COOKIE },
      body: JSON.stringify({ nonceHash: new URL(labLink).searchParams.get('connect') })
    });
    expect(grant.status).toBe(200);
    await expect.poll(() => lab.host.state().status, { timeout: 30_000 }).toBe('online');
    await page.getByRole('button', { name: 'Add a computer' }).click();
    const row = page.locator('#owner-host-list li', { hasText: 'Lab PC' });
    await expect.poll(() => row.textContent(), { timeout: 20_000 }).toContain('online');
    await expect.poll(() => page.locator('#owner-host-list li', { hasText: 'Office PC' }).textContent()).toContain('paired');
    await page.locator('#device-name').fill('Signed-in Chromium 2');
    await row.getByRole('button', { name: 'Pair' }).click();
    await approve(lab.host, 'Signed-in Chromium 2');
    await page.locator('#transcript').getByText('answer from Lab').waitFor({ timeout: 30_000 });
    await expect.poll(async () => (await page.locator('#host-select option').allTextContents()).map((t) => t.split(' · ')[0]).sort()).toEqual(['Lab PC', 'Office PC']);

    // Every owner action went through the landing, which is what holds the relay credential.
    expect(landing.ownerCalls).toEqual(expect.arrayContaining(['POST /v1/owner/enroll-grant', 'GET /v1/owner/enroll-grant', 'POST /v1/owner/pair-request', 'GET /v1/owner/hosts']));
    expect(cspViolations).toEqual([]);
  }, 180_000);
});
