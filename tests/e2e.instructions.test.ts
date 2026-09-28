/**
 * End-to-end test for Settings → Instructions, driven through the real UI. Requires
 * `npm run build` first. Gated by VOCS_CODE_E2E_UI=1 (the e2e guard sets it).
 *
 * The app's own instruction layer is one file per scope under `<userData>/instructions/`. The suite
 * runs against a throwaway userData, so it proves the page writes there — not into any harness's own
 * global file, and not into the real profile.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { isolatedEnv, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const launchOptions = { executablePath: require('electron') as string, args: [path.join(root, 'out', 'main', 'index.js')] };
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

describe.runIf(enabled)('instructions UI', () => {
  it('writes the shared and harness-specific files, and removes one when cleared', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-instructions-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# instructions e2e\n');
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));

    app = await electron.launch({ ...launchOptions, env: isolatedEnv(userData), timeout: 60_000 });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });

    await win.click('.sidebar-bottom .sidebar-link:has-text("Settings")');
    await win.locator('.settings-link:has-text("Instructions")').click({ timeout: 20_000 });
    await win.waitForSelector('.pi-prompt-editor', { timeout: 20_000 });

    // Every scope is offered, shared first, and none of them is set yet.
    const tabs = await win.locator('.pi-tab').allInnerTexts();
    expect(tabs.map((t) => t.replace(/not set/g, '').trim())).toEqual(['All harnesses', 'Pi', 'Claude Agent SDK', 'Codex', 'Cursor', 'ACP agents', 'Native']);
    await expect.poll(async () => win.locator('.pi-tab:has-text("not set")').count()).toBe(7);

    // The shared file lands under this run's userData, not under a harness's own config.
    const editor = win.locator('.pi-prompt-editor');
    await editor.fill('Always be proactive.\n');
    await win.locator('.pi-prompt-actions button:has-text("Save")').click();
    const globalFile = path.join(userData, 'instructions', 'global.md');
    await expect.poll(async () => fs.readFile(globalFile, 'utf8').catch(() => '')).toBe('Always be proactive.\n');
    await expect.poll(async () => win.locator('.pi-tab:has-text("not set")').count()).toBe(6);

    // A harness tab adds its own file rather than editing the shared one.
    await win.locator('.pi-tab:has-text("Pi")').click();
    await win.locator('.pi-prompt-editor').fill('Pi: keep it terse.\n');
    await win.locator('.pi-prompt-actions button:has-text("Save")').click();
    await expect.poll(async () => fs.readFile(path.join(userData, 'instructions', 'pi.md'), 'utf8').catch(() => '')).toBe('Pi: keep it terse.\n');
    expect(await fs.readFile(globalFile, 'utf8')).toBe('Always be proactive.\n');

    // Saving an empty file removes the layer again, so the editor can switch it off.
    await win.locator('.pi-prompt-editor').fill('   \n');
    await win.locator('.pi-prompt-actions button:has-text("Save")').click();
    await expect.poll(async () => fs.access(path.join(userData, 'instructions', 'pi.md')).then(() => true).catch(() => false)).toBe(false);
  }, 120_000);
});
