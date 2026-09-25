/**
 * End-to-end test for the P4 remote-access settings panel: connect to a local relay test double
 * (VOCS_CODE_RELAY_URL; the relay is not a setting) with only the enrollment secret, watch the audit
 * feed record the enable, then flip view-only mode and prove the policy is written through to
 * settings.json (not merely held in React). It also checks the copyable pairing link, and that a
 * restart reconnects as the same enrolled computer without any stored relay URL.
 * Requires `npm run build` first; gated by
 * VOCS_CODE_E2E_UI=1 (the e2e guard sets it).
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { isolatedEnv, seedSettings } from './e2e-ui';
import { ENROLL, FakeRelay } from './fake-relay';
import { generateIdentity, publicOf } from '../src/shared/crypto';
import { decodeQrPath } from './support/qr-decode';
import { startTestLanding, TEST_SESSION_COOKIE } from './support/test-landing';
import { memoryVault, RelayClient } from '../relay/src/web-client';
import { connectCheckCode } from '../src/shared/pairing';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
let app: ElectronApplication | null = null;
let relay: FakeRelay | null = null;
let signInApp: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await relay?.stop();
});

describe.runIf(enabled)('remote access settings', () => {
  it('connects to a relay, persists policy, and approves a claimed browser from the desktop', async () => {
    relay = new FakeRelay();
    const port = await relay.start();
    const tmp = path.join(os.tmpdir(), `vocs-code-remote-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# remote e2e\n');
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    const settingsPath = path.join(userData, 'settings.json');

    // The relay is not a setting (production is always code.vocs.io); the override points this
    // build at the local test relay the way a developer points it at `wrangler dev`.
    const launch = async (): Promise<Page> => {
      app = await electron.launch({
        executablePath: require('electron') as string,
        args: [path.join(root, 'out', 'main', 'index.js')],
        env: isolatedEnv(userData, { VOCS_CODE_RELAY_URL: `http://127.0.0.1:${port}` }),
        timeout: 60_000
      });
      const page = await app.firstWindow();
      await page.waitForSelector('.brand', { timeout: 60_000 });
      await page.click('.sidebar-bottom .sidebar-link:has-text("Settings")');
      await page.locator('.settings-link:has-text("Remote access")').click({ timeout: 20_000 });
      return page;
    };
    const win = await launch();

    // Nothing to type but the enrollment secret: the panel names the relay it will use.
    await expect.poll(async () => win.getByTestId('remote-relay').innerText(), { timeout: 20_000 }).toBe(`127.0.0.1:${port}`);
    expect(await win.getByTestId('remote-relay-url').count()).toBe(0);
    await win.getByTestId('remote-enroll').fill(ENROLL);
    await win.getByTestId('remote-connect').click();

    // Enabling is audited, and the audit feed is what surfaces the view-only policy control.
    const audit = win.getByTestId('remote-audit');
    await audit.waitFor({ timeout: 20_000 });
    await expect.poll(async () => audit.innerText(), { timeout: 20_000 }).toContain('enable');

    // Flip view-only; the change must reach settings.json, not just React state. The control is a
    // styled toggle whose checkbox input is visually hidden, so click the label track.
    const toggle = win.locator('.field:has-text("View-only mode") .toggle');
    await toggle.waitFor({ timeout: 10_000 });
    // Thumb position alone is not readable, so the switch states itself in a word. Assert the word,
    // not just the persisted value: that is the part a user actually goes by.
    expect(await toggle.locator('.toggle-state').innerText()).toBe('Off');
    await toggle.click();
    await expect.poll(async () => toggle.locator('.toggle-state').innerText(), { timeout: 10_000 }).toBe('On');
    await expect.poll(async () => (JSON.parse(await fs.readFile(settingsPath, 'utf8')) as { remote?: { viewOnly?: boolean } }).remote?.viewOnly).toBe(true);

    // Turning on the offline mirror is also persisted; the desktop would then sync snapshots.
    const mirrorToggle = win.locator('.field:has-text("Offline mirror") .toggle');
    await mirrorToggle.waitFor({ timeout: 10_000 });
    await mirrorToggle.click();
    await expect.poll(async () => (JSON.parse(await fs.readFile(settingsPath, 'utf8')) as { remote?: { mirror?: boolean } }).remote?.mirror).toBe(true);

    // A new host stays "connecting" until its first browser approves enrollment. With no browser
    // paired yet, Connect puts the code (and its link and QR code) on screen without another click.
    await expect.poll(async () => win.getByTestId('remote-status').innerText(), { timeout: 20_000 }).toMatch(/connecting|online/);
    const code = win.getByTestId('remote-pair-code');
    await code.waitFor({ timeout: 20_000 });
    const pairingCode = (await code.innerText()).trim();
    expect(pairingCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    // The link opens the relay this desktop is connected to: the page claims against its own origin.
    const pairingLink = `http://127.0.0.1:${port}/app?code=${pairingCode}`;
    expect(await win.getByTestId('remote-pair-link').inputValue()).toBe(pairingLink);
    // The QR code a phone scans decodes to the same link.
    const qr = win.getByTestId('remote-pair-qr');
    const extent = Number((await qr.getAttribute('viewBox'))!.split(' ')[2]);
    expect(decodeQrPath((await qr.locator('path').getAttribute('d'))!, extent)).toBe(pairingLink);
    await win.getByRole('button', { name: 'Copy link' }).click();
    await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 10_000 }).toBe(pairingLink);

    const browser = await generateIdentity();
    const claimed = await fetch(`http://127.0.0.1:${port}/v1/pair/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pairingCode, name: 'E2E browser', webPub: publicOf(browser) })
    });
    expect(claimed.status).toBe(200);
    const { pollToken } = (await claimed.json()) as { pollToken: string };
    expect((await fetch(`http://127.0.0.1:${port}/v1/pair/poll?code=${pairingCode}`)).status).toBe(401);
    await expect.poll(async () => win.getByText('“E2E browser”', { exact: false }).count(), { timeout: 20_000 }).toBe(1);
    await win.getByRole('button', { name: 'Allow' }).click();
    const poll = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/pair/poll?code=${pairingCode}`, { headers: { authorization: `Bearer ${pollToken}` } });
      expect(response.status).toBe(200);
      return (await response.json()) as { status: string; webDeviceId?: string };
    };
    await expect.poll(async () => (await poll()).status, { timeout: 20_000 }).toBe('approved');
    expect((await poll()).webDeviceId).toMatch(/^w_/);
    expect((await fetch(`http://127.0.0.1:${port}/v1/pair/poll?code=${pairingCode}`)).status).toBe(401);

    // No relay URL is stored anywhere, yet a restart comes back to the same relay as the same
    // enrolled computer: remote access resumes from the enabled flag and the keychain alone.
    const hostId = async () => relay!.connected().find((c) => c.kind === 'host' && c.id.startsWith('h_'))?.id;
    await expect.poll(hostId, { timeout: 20_000 }).toMatch(/^h_/);
    const enrolledAs = await hostId();
    expect(JSON.parse(await fs.readFile(settingsPath, 'utf8')).remote).not.toHaveProperty('relayUrl');
    await app!.close();
    await expect.poll(hostId, { timeout: 20_000 }).toBeUndefined();
    const again = await launch();
    await expect.poll(hostId, { timeout: 30_000 }).toBe(enrolledAs);
    await expect.poll(async () => again.getByTestId('remote-status').innerText(), { timeout: 20_000 }).toMatch(/online/);
    // Registered now: the enrollment secret is not asked for again.
    expect(await again.getByTestId('remote-enroll').count()).toBe(0);
  });

  it('connects with GitHub from Settings: the browser adds this computer, then pairs on Allow, with no secret typed', async () => {
    const fake = new FakeRelay();
    const port = await fake.start();
    const gate = await startTestLanding(`http://127.0.0.1:${port}`, ENROLL);
    try {
      const tmp = path.join(os.tmpdir(), `vocs-code-remote-signin-${Date.now()}`);
      const userData = path.join(tmp, 'userData');
      const project = path.join(tmp, 'project');
      await fs.mkdir(userData, { recursive: true });
      await fs.mkdir(project, { recursive: true });
      await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
      signInApp = await electron.launch({
        executablePath: require('electron') as string,
        args: [path.join(root, 'out', 'main', 'index.js')],
        // The desktop reaches the relay through the landing, as it does at code.vocs.io.
        env: isolatedEnv(userData, { VOCS_CODE_RELAY_URL: gate.origin }),
        timeout: 60_000
      });
      // Record the page the app opens instead of launching a real browser.
      await signInApp.evaluate(({ shell }) => {
        const opened: string[] = [];
        (globalThis as unknown as { __opened: string[] }).__opened = opened;
        shell.openExternal = async (url: string) => void opened.push(url);
      });
      const win = await signInApp.firstWindow();
      await win.waitForSelector('.brand', { timeout: 60_000 });
      await win.click('.sidebar-bottom .sidebar-link:has-text("Settings")');
      await win.locator('.settings-link:has-text("Remote access")').click({ timeout: 20_000 });

      // The landing's gate answers this signed-out desktop with 401: sign-in is the way in.
      const signIn = win.getByTestId('remote-sign-in');
      await signIn.waitFor({ timeout: 30_000 });
      expect(await win.getByTestId('remote-enroll').count()).toBe(0);
      await signIn.click();
      const opened = () => signInApp!.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
      await expect.poll(async () => (await opened()).length, { timeout: 20_000 }).toBe(1);
      const link = (await opened())[0];
      const nonceHash = new URL(link).searchParams.get('connect')!;
      expect(link).toBe(`${gate.origin}/app?connect=${nonceHash}`);
      await expect.poll(() => win.getByTestId('remote-sign-in-code').textContent(), { timeout: 20_000 }).toBe(connectCheckCode(nonceHash));

      // The signed-in browser adds this computer: it comes online, registered, with nothing typed.
      const signedIn: typeof fetch = (input, init = {}) => fetch(input, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), cookie: TEST_SESSION_COOKIE } });
      const browser = new RelayClient({ vault: memoryVault(), fetchImpl: signedIn });
      await browser.addComputer(gate.origin, nonceHash);
      await expect.poll(async () => win.getByTestId('remote-status').innerText(), { timeout: 30_000 }).toMatch(/online/);
      expect(await win.getByTestId('remote-sign-in').count()).toBe(0);
      expect(await win.getByTestId('remote-enroll').count()).toBe(0);

      // It asks to pair; the request shows here and waits for Allow.
      const added = await browser.addedComputer(gate.origin, nonceHash);
      const pairing = browser.pairWithHost({ relayBase: gate.origin, hostDeviceId: added.hostDeviceId!, deviceName: 'Signed-in phone' });
      await expect.poll(async () => win.getByText('“Signed-in phone”', { exact: false }).count(), { timeout: 20_000 }).toBe(1);
      await win.getByRole('button', { name: 'Allow' }).click();
      expect((await pairing).hostDeviceId).toBe(added.hostDeviceId);
      await expect.poll(async () => win.getByText(/Browser: Signed-in phone/).count(), { timeout: 20_000 }).toBe(1);
    } finally {
      await signInApp?.close().catch(() => undefined);
      await gate.stop();
      await fake.stop();
    }
  }, 180_000);
});
