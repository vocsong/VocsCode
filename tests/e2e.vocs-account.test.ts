/** Actual desktop signed-out boundary/layout. Does not simulate successful OAuth or use an account. */
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
/** Launches the built app on a fresh profile and opens Settings → Vocs account. */
async function openAccount(extraEnv: Record<string, string> = {}, secrets?: Record<string, string>): Promise<{ app: ElectronApplication; win: Page; userData: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-account-ui-')); dirs.push(tmp);
  const userData = path.join(tmp, 'data'), project = path.join(tmp, 'project');
  await fs.mkdir(userData); await fs.mkdir(project);
  await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
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
describe.runIf(enabled)('Vocs account desktop settings', () => {
  it('defaults to production, survives navigation, and fits narrow light/dark settings', async () => {
    const { app, win } = await openAccount();
    const nav = win.getByRole('navigation', { name: 'Settings sections' });
    expect(await win.getByRole('button', { name: 'Sign in with Vocs' }).isEnabled()).toBe(true);
    expect(await win.getByText('Staging only', { exact: true }).count()).toBe(0);
    expect(await win.getByText(/Sign-in opens your system browser at auth.vocs.io/).count()).toBe(1);
    // Production has device grants off: no "Keep me signed in", only the temporary sign-in.
    expect(await win.getByRole('checkbox', { name: 'Keep me signed in on this computer' }).count()).toBe(0);
    expect(await win.getByText(/lasts up to five minutes and is kept only in memory/).count()).toBe(1);
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
