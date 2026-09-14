/**
 * End-to-end test for the P4 remote-access settings panel: connect to a local relay test double,
 * watch the audit feed record the enable, then flip view-only mode and prove the policy is written
 * through to settings.json (not merely held in React). Requires `npm run build` first; gated by
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

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
let app: ElectronApplication | null = null;
let relay: FakeRelay | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await relay?.stop();
});

describe.runIf(enabled)('remote access settings', () => {
  it('connects to a relay, records the audit feed and persists view-only mode', async () => {
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

    app = await electron.launch({
      executablePath: require('electron') as string,
      args: [path.join(root, 'out', 'main', 'index.js')],
      env: isolatedEnv(userData),
      timeout: 60_000
    });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });

    await win.click('.sidebar-bottom .sidebar-link:has-text("Settings")');
    await win.locator('.settings-link:has-text("Remote access")').click({ timeout: 20_000 });
    await win.getByTestId('remote-relay-url').waitFor({ timeout: 20_000 });

    // Connect to the local relay with its enrollment secret.
    await win.getByTestId('remote-relay-url').fill(`http://127.0.0.1:${port}`);
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
    await toggle.click();
    await expect.poll(async () => (JSON.parse(await fs.readFile(settingsPath, 'utf8')) as { remote?: { viewOnly?: boolean } }).remote?.viewOnly).toBe(true);

    // The status line reflects the live relay connection rather than a stale "off".
    await expect.poll(async () => win.getByTestId('remote-status').innerText(), { timeout: 20_000 }).toMatch(/connecting|online/);
  });
});
