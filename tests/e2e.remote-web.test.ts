/**
 * The code.vocs.io web shell in a real browser (Electron's Chromium) against the real relay Worker
 * running locally in workerd, with real desktop hosts in this process approving the pairings. It is
 * the only suite that runs the shell itself: the native WebSocket, IndexedDB holding non-extractable
 * keys across a reload, the static CSP, the pairing link, streaming deltas with their sequence
 * floor, a signed approval, the computer switcher, unpair, and the phone layout.
 * Gated by VOCS_CODE_E2E_UI=1 (the e2e guard sets it); needs no app build and no account, but does
 * build the web bundle (src/web) in beforeAll.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { RemoteHost } from '../src/main/remote/host';
import type { HandlerRegistry } from '../src/main/handlers';
import { isolatedEnv } from './e2e-ui';
import { startLocalRelay, type LocalRelay } from './support/local-relay';
import { startTestLanding, TEST_SESSION_COOKIE, type TestLanding } from './support/test-landing';
import type { SessionEvent, SessionMeta, TranscriptItem } from '../src/shared/types';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
let app: ElectronApplication | null = null;
let relay: LocalRelay | null = null;
let ownerApp: ElectronApplication | null = null;
let landing: TestLanding | null = null;
const hosts: RemoteHost[] = [];

beforeAll(() => {
  if (!enabled) return;
  // The relay serves whatever is in relay/public/app; build the shell from source first.
  const build = spawnSync(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.config.web.ts'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production' }
  });
  if (build.status !== 0) throw new Error(`vite build failed:\n${build.stderr || build.stdout}`);
});

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

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };
const meta = (id: string, title: string): SessionMeta => ({
  id, title, createdAt: 1, updatedAt: 1,
  config: { harness: 'claude', permissionMode: 'ask', projectRoot: '/repo' },
  cwd: '/repo', status: 'idle', harnessRef: {}, usage: { ...ZERO_USAGE }
});

interface Desk {
  host: RemoteHost;
  sent: unknown[];
  approvals: unknown[];
  items: TranscriptItem[];
  focus: string;
}

async function desk(name: string, origin: string, enrollToken: string, opts: { enable?: boolean; items?: TranscriptItem[]; focus?: string } = {}): Promise<Desk> {
  const sent: unknown[] = [];
  const approvals: unknown[] = [];
  const secrets = new Map<string, string>();
  const second = `${name}-s2`;
  const items = opts.items ?? [
    { id: 'm1', kind: 'user', ts: 1, text: `hello ${name}` },
    { id: 'm2', kind: 'assistant', ts: 2, text: `answer from ${name}` }
  ];
  const registry = {
    channels: () => [],
    invoke: async (channel: string, request: unknown) => {
      switch (channel) {
        case 'settings:get':
          return { remote: { viewOnly: false }, folders: [] };
        case 'sessions:list':
          return [meta(`${name}-s1`, `${name} session`), meta(second, `${name} second`)];
        case 'sessions:transcriptPage':
          return { items, start: 0, total: items.length, seq: 5 };
        case 'sessions:send':
          sent.push(request);
          return undefined;
        case 'desktop:focus':
          return { sessionId: opts.focus ?? `${name}-s1`, at: 1, windowFocused: true };
        case 'approvals:respond':
          approvals.push(request);
          return undefined;
        case 'terminal:list':
          return [{ id: `${name}-t1`, sessionId: `${name}-s1`, title: 'build', shell: 'bash', shellName: 'bash', cwd: '/repo', createdAt: 1 }];
        case 'terminal:screen':
          return { info: { id: `${name}-t1` }, lines: ['$ npm test', `${name} terminal says hi`], seq: 1 };
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
  if (opts.enable !== false) await host.enable(origin, enrollToken);
  return { host, sent, approvals, items, focus: opts.focus ?? `${name}-s1` };
}

/** Pushes a session event the way SessionManager does, with a sequence the client can order. */
function pushEvent(host: RemoteHost, sessionId: string, seq: number, event: SessionEvent): Promise<void> {
  return host.broadcastPush('push:sessionEvent', { sessionId, event, ts: Date.now(), seq });
}

async function approve(host: RemoteHost, browserName: string): Promise<void> {
  await expect.poll(() => host.state().pendingRequest?.name, { timeout: 30_000 }).toBe(browserName);
  await host.respondPairing('approve');
}

function launchBrowser(url: string, cookie?: string): Promise<Page> {
  return (async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-remote-web-'));
    const main = path.join(tmp, 'main.cjs');
    await fs.writeFile(main, BROWSER_MAIN);
    app = await electron.launch({
      executablePath: require('electron') as string,
      args: [main, `--user-data-dir=${path.join(tmp, 'profile')}`],
      env: isolatedEnv(path.join(tmp, 'userData'), { REMOTE_WEB_URL: url, ...(cookie ? { REMOTE_WEB_COOKIE: cookie } : {}) }),
      timeout: 60_000
    });
    return app.firstWindow();
  })();
}

function watchCsp(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });
  return violations;
}

describe.runIf(enabled)('remote web shell in a real browser', () => {
  it('pairs, streams, answers an approval, sends, switches computers, reconnects and unpairs', async () => {
    relay = await startLocalRelay();
    const work = await desk('Work', relay.origin, relay.enrollToken);
    const { code } = await work.host.startPairing('Work PC');
    const page = await launchBrowser(`${relay.origin}/app/?code=${code}`);
    const cspViolations = watchCsp(page);

    // The link fills the code; pairing still needs a human on each side.
    await expect.poll(() => page.locator('[data-testid="pair-code"]').inputValue(), { timeout: 30_000 }).toBe(code);
    expect(new URL(page.url()).searchParams.has('code')).toBe(false);
    await page.locator('[data-testid="pair-name"]').fill('E2E Chromium');
    await page.locator('[data-testid="pair-submit"]').click();
    await page.locator('[data-testid="pairing-wait"]').waitFor({ state: 'visible' });
    await approve(work.host, 'E2E Chromium');

    // Connected: the default route opens the desktop-focused session and its transcript renders.
    await expect.poll(() => page.locator('.w-app').getAttribute('data-connection'), { timeout: 30_000 }).toBe('online');
    await page.locator('.w-session-name').getByText('Work session').waitFor({ timeout: 30_000 });
    await page.getByText('answer from Work').waitFor();

    // Streaming deltas past the snapshot's floor apply incrementally; a stale one never shows.
    await pushEvent(work.host, 'Work-s1', 6, { type: 'item.delta', id: 'm2', textDelta: ' live' });
    await page.evaluate(() => { (window as unknown as { __pushes: unknown[] }).__pushes = []; (window as unknown as { harness: { on: (c: string, l: (p: unknown) => void) => void } }).harness.on('push:sessionEvent', (p: unknown) => (window as unknown as { __pushes: unknown[] }).__pushes.push(p)); });
    await page.getByText('answer from Work live').waitFor({ timeout: 20_000 });
    await pushEvent(work.host, 'Work-s1', 4, { type: 'item.delta', id: 'm2', textDelta: ' STALE' });
    expect(await page.getByText('STALE').count()).toBe(0);
    expect(await page.getByText('answer from Work live').count()).toBe(1);

    // An approval with a harness-specific option id goes back over the signed e2e channel.
    const approval: TranscriptItem = {
      id: 'ap1',
      kind: 'approval',
      ts: 3,
      request: {
        id: 'ap1', sessionId: 'Work-s1', harness: 'acp', kind: 'permission', title: 'Run a command',
        command: 'rm -rf build', cwd: '/repo',
        options: [
          { id: 'acp-allow-once', label: 'Allow once', kind: 'allow' },
          { id: 'acp-deny', label: 'Deny', kind: 'deny' }
        ],
        createdAt: 1
      }
    };
    await pushEvent(work.host, 'Work-s1', 8, { type: 'item.upsert', item: approval });
    await page.getByRole('button', { name: 'Allow once' }).waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Allow once' }).click();
    await expect.poll(() => work.approvals.length, { timeout: 20_000 }).toBe(1);
    expect(work.approvals[0]).toMatchObject({ sessionId: 'Work-s1', requestId: 'ap1', decision: { optionId: 'acp-allow-once' } });

    // The read-only terminal sheet follows the session.
    await page.getByRole('button', { name: 'Session actions' }).click();
    await page.getByRole('button', { name: 'Terminal' }).click();
    await page.getByText('Work terminal says hi').waitFor({ timeout: 20_000 });
    await page.locator('.w-sheet-backdrop').click({ position: { x: 8, y: 8 } });
    await expect.poll(() => page.locator('.w-sheet-backdrop').count()).toBe(0);

    // A prompt reaches the desktop sealed.
    await page.locator('textarea[aria-label="Message"]').fill('ship it');
    await page.locator('[aria-label="Send"]').click();
    await expect.poll(() => work.sent.length, { timeout: 20_000 }).toBe(1);
    expect(work.sent[0]).toEqual({ id: 'Work-s1', input: { text: 'ship it' } });

    // A reload restores the pairing from IndexedDB and keeps the deep-linked session.
    await page.reload();
    await expect.poll(() => page.locator('.w-app').getAttribute('data-connection'), { timeout: 30_000 }).toBe('online');
    await page.locator('.w-session-name').getByText('Work session').waitFor({ timeout: 30_000 });

    // A second computer: pair it, then switch back and forth.
    const home = await desk('Home', relay.origin, relay.enrollToken, { focus: 'Home-s1' });
    const second = await home.host.startPairing('Home PC');
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('button', { name: 'Add a computer' }).click();
    await page.locator('[data-testid="pair-code"]').fill(second.code);
    await page.locator('[data-testid="pair-name"]').fill('E2E Chromium 2');
    await page.locator('[data-testid="pair-submit"]').click();
    await approve(home.host, 'E2E Chromium 2');
    await page.locator('.w-session-name').getByText('Home session').waitFor({ timeout: 30_000 });

    const workHostId = (await work.host.listDevices()).find((d) => d.kind === 'host' && d.name === 'Work PC')!.deviceId;
    await page.locator('[data-testid="computers"]').click();
    await page.locator('.w-list-row', { hasText: 'Work PC' }).getByRole('button').click();
    await page.locator('.w-session-name').getByText('Work session').waitFor({ timeout: 30_000 });

    // The session route survives a full reload after switching back: the deep link (and the host
    // it names) is what a reconnect restores.
    await page.reload();
    await expect.poll(() => page.locator('.w-app').getAttribute('data-connection'), { timeout: 30_000 }).toBe('online');
    await page.locator('.w-session-name').getByText('Work session').waitFor({ timeout: 30_000 });

    // Unpair the active computer: only it goes.
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('button', { name: 'Unpair this browser' }).click();
    await expect.poll(async () => (await home.host.listDevices()).filter((d) => d.kind === 'web').length, { timeout: 20_000 }).toBe(1);
    await page.locator('.w-session-name').getByText('Home session').waitFor({ timeout: 30_000 });

    // The strict CSP held throughout, and the shell injects no style elements.
    expect(cspViolations).toEqual([]);
    expect(await page.locator('style').count()).toBe(0);
  }, 240_000);

  it('adds a computer with Connect with GitHub, then pairs another from the signed-in list, with no code or secret', async () => {
    relay ??= await startLocalRelay();
    landing = await startTestLanding(relay.origin, relay.enrollToken);
    // Desktops with no enrollment secret: they go through the landing, as they would at code.vocs.io.
    const office = await desk('Office', '', '', { enable: false });
    let link = '';
    await office.host.signIn(landing.origin, async (url) => void (link = url), 'Office PC');
    const checkCode = office.host.state().signIn?.checkCode;
    expect(checkCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const page = await launchBrowser(link, TEST_SESSION_COOKIE);
    ownerApp = app;
    const cspViolations = watchCsp(page);

    // The page the desktop opened asks before adding anything, and shows the desktop's own code.
    await page.locator('[data-testid="connect-screen"]').waitFor({ state: 'visible', timeout: 30_000 });
    expect(await page.locator('[data-testid="connect-code"]').textContent()).toBe(checkCode);
    expect(new URL(page.url()).searchParams.has('connect')).toBe(false);
    expect(await office.host.isRegistered()).toBe(false);
    await page.locator('[data-testid="connect-name"]').fill('Signed-in Chromium');
    await page.locator('[data-testid="connect-add"]').click();
    // Added, then this browser asks to pair; the desktop still decides.
    await approve(office.host, 'Signed-in Chromium');
    await expect.poll(() => page.locator('.w-app').getAttribute('data-connection'), { timeout: 30_000 }).toBe('online');
    await page.locator('.w-session-name').getByText('Office session').waitFor({ timeout: 30_000 });
    expect(await office.host.isRegistered()).toBe(true);

    // A second computer, added from its own Connect with GitHub, is picked from the list: no code.
    const lab = await desk('Lab', '', '', { enable: false, focus: 'Lab-s1' });
    let labLink = '';
    await lab.host.signIn(landing.origin, async (url) => void (labLink = url), 'Lab PC');
    const grant = await fetch(`${landing.origin}/v1/owner/enroll-grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: TEST_SESSION_COOKIE },
      body: JSON.stringify({ nonceHash: new URL(labLink).searchParams.get('connect') })
    });
    expect(grant.status).toBe(200);
    await expect.poll(() => lab.host.state().status, { timeout: 30_000 }).toBe('online');
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('button', { name: 'Add a computer' }).click();
    const row = page.locator('.w-list-row', { hasText: 'Lab PC' });
    await expect.poll(() => row.textContent(), { timeout: 20_000 }).toContain('online');
    await page.locator('[data-testid="pair-name"]').fill('Signed-in Chromium 2');
    await row.locator('[data-testid="owner-pair"]').click();
    await approve(lab.host, 'Signed-in Chromium 2');
    await page.locator('.w-session-name').getByText('Lab session').waitFor({ timeout: 30_000 });

    // Every owner action went through the landing, which is what holds the relay credential.
    expect(landing.ownerCalls).toEqual(expect.arrayContaining(['POST /v1/owner/enroll-grant', 'GET /v1/owner/enroll-grant', 'POST /v1/owner/pair-request', 'GET /v1/owner/hosts']));
    expect(cspViolations).toEqual([]);
  }, 240_000);

  it('fits a 390x844 phone: no horizontal overflow, a visible composer, and 16px inputs', async () => {
    relay ??= await startLocalRelay();
    const long = 'x'.repeat(600);
    const items: TranscriptItem[] = [
      { id: 'm0', kind: 'user', ts: 1, text: 'read this' },
      { id: 'm1', kind: 'assistant', ts: 2, text: `Here is a long line:\n\n\`\`\`js\nconst value = "${long}";\n\`\`\`\n\nand the answer.` },
      ...Array.from({ length: 58 }, (_, i): TranscriptItem => ({ id: `m${i + 2}`, kind: 'info', ts: 3 + i, level: 'info', text: `row ${i}` }))
    ];
    const phone = await desk('Phone', relay.origin, relay.enrollToken, { items, focus: 'Phone-s1' });
    const { code } = await phone.host.startPairing('Phone PC');
    const page = await launchBrowser(`${relay.origin}/app/?code=${code}`);
    await expect.poll(() => page.locator('[data-testid="pair-code"]').inputValue(), { timeout: 30_000 }).toBe(code);
    await page.locator('[data-testid="pair-submit"]').click();
    await approve(phone.host, 'Browser');
    await expect.poll(() => page.locator('.w-app').getAttribute('data-connection'), { timeout: 30_000 }).toBe('online');

    // A phone viewport: 390x844, as a real device reports it.
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ x: 0, y: 0, width: 390, height: 844 }));
    await page.locator('.w-session-name').getByText('Phone session').waitFor({ timeout: 30_000 });
    await page.getByText('and the answer.').waitFor({ timeout: 20_000 });

    const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1);

    // The composer is on screen even after a long transcript, and fields do not trigger iOS zoom.
    await page.locator('textarea[aria-label="Message"]').fill('a phone message');
    const composer = await page.locator('.w-composer').boundingBox();
    const viewport = page.viewportSize() ?? { width: 390, height: 844 };
    expect(composer).toBeTruthy();
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(viewport.height + 1);
    const fontSizes = await page.evaluate(() => [...document.querySelectorAll('input, textarea, select')].map((el) => Number.parseFloat(getComputedStyle(el).fontSize)));
    expect(Math.min(...fontSizes)).toBeGreaterThanOrEqual(16);
  }, 240_000);
});
