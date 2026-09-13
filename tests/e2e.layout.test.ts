/**
 * The shell's two layouts, driven through the real window. Requires `npm run build` first. Gated by
 * VOCS_CODE_E2E_UI=1; no harness is ever started, so no API key is involved.
 *
 * Above the breakpoint the sidebar owns a column and the content takes the rest. Below it the
 * sidebar floats over the content as a drawer. Both arrangements are pure CSS over one DOM, and the
 * drawer's dismiss layer sits in that DOM whenever the sidebar is open — so either width can be
 * broken by a rule that lets it take a grid cell, with nothing else to notice.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

type Box = { x: number; y: number; width: number; height: number };

async function box(win: Page, selector: string): Promise<Box> {
  const r = await win.locator(selector).boundingBox();
  return r ?? { x: 0, y: 0, width: 0, height: 0 };
}

describe.runIf(enabled)('shell layout', () => {
  it('gives the sidebar a column when there is room and floats it as a drawer when there is not', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-layout-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(shots, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_')) env[k] = v;
    env.VOCS_CODE_USER_DATA = userData;

    app = await electron.launch({ executablePath: require('electron') as string, args: [path.join(root, 'out', 'main', 'index.js')], env, timeout: 60_000 });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });
    // Settings is the widest thing the app renders without a session, so a squeezed column shows.
    await win.click('.sidebar-bottom .sidebar-link:has-text("Settings")');
    await win.waitForSelector('.theme-picker', { timeout: 20_000 });

    await win.setViewportSize({ width: 1280, height: 800 });
    await win.waitForTimeout(300);
    const wide = { sidebar: await box(win, '.sidebar'), main: await box(win, '.main') };
    await win.screenshot({ path: path.join(shots, 'layout-01-wide.png') });
    expect(wide.sidebar.height, 'the sidebar fills the window height').toBeGreaterThan(600);
    expect(wide.sidebar.x, 'the sidebar is the left column').toBe(0);
    expect(wide.main.x, 'content starts where the sidebar ends').toBe(wide.sidebar.width);
    expect(wide.main.width, 'content gets everything the sidebar does not').toBe(1280 - wide.sidebar.width);
    // The picker is only visible if the column it lives in has real width.
    expect((await box(win, '.theme-picker')).width).toBeGreaterThan(400);

    await win.setViewportSize({ width: 820, height: 800 });
    await win.waitForTimeout(300);
    const narrow = { sidebar: await box(win, '.sidebar'), main: await box(win, '.main'), backdrop: await box(win, '.sidebar-backdrop') };
    await win.screenshot({ path: path.join(shots, 'layout-02-drawer.png') });
    expect(narrow.main.x, 'content spans the window under the drawer').toBe(0);
    expect(narrow.main.width).toBe(820);
    expect(narrow.sidebar.x, 'the drawer is pinned to the left edge').toBe(0);
    expect(narrow.sidebar.width, 'the drawer keeps its own width above the content').toBeGreaterThan(200);
    expect(narrow.backdrop.width, 'the dismiss layer covers the window').toBe(820);

    // Dismissing the drawer hands the whole window to the content.
    await win.locator('.sidebar-backdrop').click();
    await win.waitForTimeout(300);
    expect(await win.locator('.sidebar').count()).toBe(0);
    expect((await box(win, '.main')).width).toBe(820);
  }, 180_000);
});
