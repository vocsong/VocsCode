/** Actual desktop signed-out boundary/layout, and a Hub connection kept in the OS keychain across
 *  restarts. Does not simulate successful OAuth or use an account; main's fetch to the Hub origin is
 *  intercepted, so nothing reaches mcp.vocs.io. */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { isolatedEnv, seedSettings } from './e2e-ui';
const require = createRequire(import.meta.url);
const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const apps: ElectronApplication[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const app of apps) await app.close().catch(() => undefined);
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
});
/** Launches the built app on a fresh profile (or `reuse`'s, for a restart) and opens Settings → Vocs account. */
async function openAccount(extraEnv: Record<string, string> = {}, secrets?: Record<string, string>, reuse?: string): Promise<{ app: ElectronApplication; win: Page; userData: string }> {
  let userData = reuse;
  if (!userData) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-account-ui-')); dirs.push(tmp);
    userData = path.join(tmp, 'data'); const project = path.join(tmp, 'project');
    await fs.mkdir(userData); await fs.mkdir(project);
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
  }
  if (secrets) await fs.writeFile(path.join(userData, 'secrets.json'), JSON.stringify(secrets));
  const app = await electron.launch({ executablePath: require('electron') as string, args: [path.resolve('out/main/index.js')], env: isolatedEnv(userData, extraEnv), timeout: 60000 });
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForSelector('.brand', { timeout: 60000 });
  await win.locator('.sidebar-bottom .sidebar-link:has-text("Settings")').click();
  await win.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Vocs account', exact: true }).click();
  await win.getByText('Signed out', { exact: true }).waitFor();
  return { app, win, userData };
}
const HUB_VAULT_ID = 'vocs-hub:production:openrouter';
const readSecrets = async (userData: string) => JSON.parse(await fs.readFile(path.join(userData, 'secrets.json'), 'utf8')) as Record<string, string>;
describe.runIf(enabled)('Vocs account desktop settings', () => {
  it('defaults to production, survives navigation, and fits narrow light/dark settings', async () => {
    const { app, win } = await openAccount();
    const nav = win.getByRole('navigation', { name: 'Settings sections' });
    expect(await win.getByRole('button', { name: 'Sign in with Vocs' }).isEnabled()).toBe(true);
    expect(await win.getByText('Staging only', { exact: true }).count()).toBe(0);
    expect(await win.getByText(/Sign-in opens your system browser at auth.vocs.io/).count()).toBe(1);
    // Production offers the kept sign-in, on by default (this machine has an OS keychain).
    const keep = win.getByRole('checkbox', { name: 'Keep me signed in on this computer' });
    expect(await keep.isChecked()).toBe(true);
    expect(await win.getByText(/Stays signed in for up to a year/).count()).toBe(1);
    await keep.uncheck();
    expect(await win.getByText(/lasts up to five minutes and is kept only in memory/).count()).toBe(1);
    await keep.check();
    expect(await win.getByText(/Stays signed in for up to a year/).count()).toBe(1);
    expect(await win.locator('.vocs-account-settings').getByText(/staging/i).count()).toBe(0);
    await nav.getByRole('button', { name: 'General', exact: true }).click();
    await nav.getByRole('button', { name: 'Vocs account', exact: true }).click();
    await win.getByText('Signed out', { exact: true }).waitFor();
    for (const theme of ['light', 'dark'] as const) {
      await win.evaluate(async (theme) => { await window.harness.invoke('settings:update', { theme }); }, theme);
      for (const width of [1000, 700]) {
        const achievedWidth = await app.evaluate(({ BrowserWindow }, width) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(600, 600); window.setSize(width, 800); return window.getBounds().width; }, width);
        expect(achievedWidth).toBe(width);
        await win.waitForTimeout(100);
        // Below the breakpoint the sidebar floats over the page as a drawer; close it so the
        // screenshot shows the account page, then prove its main control is actually reachable
        // (a trial click fails while anything covers the button).
        const backdrop = win.locator('.sidebar-backdrop');
        if (await backdrop.isVisible()) await backdrop.click({ position: { x: width - 20, y: 400 } });
        await win.getByRole('button', { name: 'Sign in with Vocs' }).click({ trial: true, timeout: 5000 });
        const geometry = await win.locator('.vocs-account-settings').evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
        expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
        await fs.mkdir(path.resolve('tests/artifacts'), { recursive: true });
        await win.screenshot({ path: path.resolve(`tests/artifacts/vocs-account-${theme}-${width}.png`) });
      }
    }
    // No click opens the system browser, and no token or provider operation is requested.
    expect(await win.locator('[data-testid="vocs-account-id"]').count()).toBe(0);
  }, 120000);
  it('ignores and removes a tampered kept sign-in at startup without contacting any issuer', async () => {
    // A planted, non-keychain record naming a foreign issuer: dropped at load, before any request.
    const record = { v: 1, issuer: 'https://evil.invalid/api/auth', clientId: 'vocs-code-device', resource: 'https://mcp.vocs.io/api/connections', deviceId: 'dev-e2e', refreshToken: 'e2e'.padEnd(43, 'x'), deviceExpiresAt: Date.now() + 86_400_000 };
    const { win, userData } = await openAccount({}, { 'vocs-account:production': 'b64:' + Buffer.from(JSON.stringify(record)).toString('base64') });
    expect(await win.getByRole('button', { name: 'Sign in with Vocs' }).isEnabled()).toBe(true);
    await expect.poll(async () => Object.keys(JSON.parse(await fs.readFile(path.join(userData, 'secrets.json'), 'utf8')) as Record<string, string>), { timeout: 10000 }).not.toContain('vocs-account:production');
    expect(await win.locator('.vocs-account-settings').getByText(/dev-e2e|evil\.invalid/).count()).toBe(0);
  }, 120000);
  it('restores a Hub connection from the keychain without contacting the Hub, and Disconnect revokes it for good', async () => {
    // Seal a connection record with this computer's real OS keychain, as Connect would have.
    const first = await openAccount();
    const record = { v: 1, issuer: 'https://mcp.vocs.io', resource: 'https://mcp.vocs.io/openrouter', clientId: 'e2e-hub-client', scopes: ['models:read', 'speech:write'], refreshToken: 'e2e-hub-refresh-'.padEnd(40, 'x'), accountId: 'c'.repeat(64) };
    const sealed = await first.app.evaluate(({ safeStorage }, plain) => safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain).toString('base64') : null, JSON.stringify(record));
    expect(sealed, 'the e2e machine needs an OS keychain').not.toBeNull();
    // No Hub connection on a fresh profile.
    expect(await first.win.getByText('OpenRouter', { exact: true }).count()).toBe(0);
    await first.app.close();

    const { app, win, userData } = await openAccount({}, { ...(await readSecrets(first.userData).catch(() => ({}))), [HUB_VAULT_ID]: 'enc:' + sealed }, first.userData);
    // Every main-process request to the Hub origin is answered here; nothing reaches mcp.vocs.io.
    await app.evaluate(() => {
      const original = globalThis.fetch;
      const calls: { url: string; method?: string; body: string }[] = [];
      (globalThis as unknown as { __hubCalls: typeof calls }).__hubCalls = calls;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.startsWith('https://mcp.vocs.io')) return original(input, init);
        calls.push({ url, method: init?.method, body: String(init?.body ?? '') });
        return new Response(null, { status: 200 });
      }) as typeof fetch;
    });
    const settings = win.locator('.vocs-account-settings');
    await settings.getByText('Connected · models:read, speech:write', { exact: true }).waitFor({ timeout: 10000 });
    expect(await settings.getByText('OpenRouter', { exact: true }).count()).toBe(1);
    expect(await settings.getByText(/Speech requests wait for your approval on mcp.vocs.io/).count()).toBe(1);
    expect(await settings.getByText(/e2e-hub-refresh|e2e-hub-client/).count()).toBe(0);
    await fs.mkdir(path.resolve('tests/artifacts'), { recursive: true });
    await win.screenshot({ path: path.resolve('tests/artifacts/vocs-account-hub-connected.png') });
    // Restoring read the keychain only: no renewal at launch, and the account stays signed out.
    expect(await app.evaluate(() => (globalThis as unknown as { __hubCalls: unknown[] }).__hubCalls.length)).toBe(0);

    await settings.getByRole('button', { name: 'Disconnect OpenRouter' }).click();
    await expect.poll(async () => settings.getByRole('button', { name: 'Disconnect OpenRouter' }).count(), { timeout: 10000 }).toBe(0);
    const calls = await app.evaluate(() => (globalThis as unknown as { __hubCalls: { url: string; method?: string; body: string }[] }).__hubCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://mcp.vocs.io/oauth/token', method: 'POST' });
    expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({ token: record.refreshToken, client_id: record.clientId });
    await expect.poll(async () => Object.keys(await readSecrets(userData)), { timeout: 10000 }).not.toContain(HUB_VAULT_ID);
    await app.close();

    // Restart: it stays disconnected.
    const after = await openAccount({}, undefined, userData);
    await after.win.waitForTimeout(500);
    expect(await after.win.locator('.vocs-account-settings').getByText('OpenRouter', { exact: true }).count()).toBe(0);
    expect(Object.keys(await readSecrets(userData))).not.toContain(HUB_VAULT_ID);
  }, 180000);
  it('targets staging only when main is launched with VOCS_CODE_ACCOUNT_REALM=staging', async () => {
    const { win } = await openAccount({ VOCS_CODE_ACCOUNT_REALM: 'staging' });
    expect(await win.getByText('Staging only', { exact: true }).count()).toBe(1);
    expect(await win.getByRole('button', { name: 'Sign in to staging' }).isEnabled()).toBe(true);
    // Staging offers the kept sign-in, on by default (this machine has an OS keychain).
    const keep = win.getByRole('checkbox', { name: 'Keep me signed in on this computer' });
    expect(await keep.isChecked()).toBe(true);
    expect(await win.getByText(/Stays signed in for up to a year/).count()).toBe(1);
    await keep.uncheck();
    expect(await win.getByText(/lasts up to five minutes and is kept only in memory/).count()).toBe(1);
    await keep.check();
    expect(await win.getByRole('button', { name: 'Sign in with Vocs' }).count()).toBe(0);
  }, 120000);
});
