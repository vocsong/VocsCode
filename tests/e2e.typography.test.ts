/**
 * End-to-end check of Settings → Appearance → Text & fonts in the real app: interface size zooms the
 * window, the font, size and spacing choices restyle the transcript, the width choice moves the
 * reading column, everything survives a restart, and Reset puts it all back. Requires
 * `npm run build` first. Gated by VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { isolatedEnv, seedSettings } from './e2e-ui';
import { DEFAULT_TYPOGRAPHY, TRANSCRIPT_WIDTHS } from '../src/shared/typography';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
let app: ElectronApplication | null = null;
let failedPage: Page | null = null;

afterEach(async ({ task }) => {
  if (task.result?.state !== 'fail' || !failedPage) return;
  await fs.mkdir(shots, { recursive: true });
  await failedPage.screenshot({ path: path.join(shots, 'e2e-fail-typography.png') }).catch(() => undefined);
});

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

describe.runIf(enabled)('text & fonts (e2e)', () => {
  it('zooms, restyles the transcript, moves the reading column, persists, and resets', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-typography-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, { theme: 'dark' }));

    const launch = async (): Promise<Page> => {
      app = await electron.launch({ executablePath: require('electron') as string, args: [path.join(root, 'out', 'main', 'index.js')], env: isolatedEnv(userData), timeout: 60_000 });
      const win = await app.firstWindow();
      failedPage = win;
      await win.waitForSelector('.brand', { timeout: 60_000 });
      return win;
    };
    const zoom = (): Promise<number> => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor());
    const rootVar = (win: Page, name: string): Promise<string> => win.locator('html').evaluate((el, n) => getComputedStyle(el).getPropertyValue(n).trim(), name);
    const openTypography = async (win: Page): Promise<void> => {
      await win.click('.sidebar-bottom .sidebar-link:has-text("Settings")');
      await win.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click();
      await win.locator('#appearance-typography').scrollIntoViewIfNeeded();
      await win.locator('#appearance-typography .type-sample').waitFor({ timeout: 20_000 });
    };

    let win = await launch();
    expect(await zoom()).toBeCloseTo(1, 3);
    await openTypography(win);
    const group = win.locator('#appearance-typography');
    const sampleText = group.locator('.type-sample .md');
    const sampleCode = group.locator('.type-sample .codeblock pre');
    const style = (loc: ReturnType<Page['locator']>, prop: 'fontSize' | 'lineHeight' | 'fontFamily'): Promise<string> => loc.evaluate((el, p) => getComputedStyle(el)[p], prop);
    expect(await style(sampleText, 'fontSize')).toBe('14px');
    // Nothing to reset yet.
    expect(await group.getByRole('button', { name: 'Reset text & fonts' }).isDisabled()).toBe(true);

    // Interface size is the window zoom, applied by the main process.
    await group.getByRole('group', { name: 'Interface size' }).getByRole('button', { name: '110%' }).click();
    await expect.poll(zoom, { timeout: 10_000 }).toBeCloseTo(1.1, 3);

    // Transcript size and spacing restyle the sample, which is built from the transcript's own classes.
    await group.getByRole('combobox', { name: /^Transcript text size/ }).selectOption('18');
    await expect.poll(() => style(sampleText, 'fontSize')).toBe('18px');
    await group.getByRole('group', { name: 'Line spacing' }).getByRole('button', { name: 'Relaxed' }).click();
    await expect.poll(() => style(sampleText, 'lineHeight')).toBe(`${18 * 1.8}px`);
    await group.getByRole('combobox', { name: /^Code text size/ }).selectOption('14');
    await expect.poll(() => style(sampleCode, 'fontSize')).toBe('14px');

    // Fonts: a preset for the transcript, a typed family for code (which the terminal also reads).
    await group.getByRole('combobox', { name: /^Transcript font/ }).selectOption('serif');
    await expect.poll(() => style(sampleText, 'fontFamily')).toMatch(/^Charter/);
    await group.getByRole('combobox', { name: /^Code font/ }).selectOption('custom');
    await group.getByRole('textbox', { name: 'Code font: custom family' }).fill('Courier New');
    await expect.poll(() => style(sampleCode, 'fontFamily')).toMatch(/^"?Courier New"?, /);
    await expect.poll(() => rootVar(win, '--mono')).toMatch(/^'Courier New'/);

    // Width moves both the prose line length and the conversation column.
    const wide = TRANSCRIPT_WIDTHS.find((w) => w.id === 'wide')!;
    await win.getByRole('group', { name: 'Transcript width' }).getByRole('button', { name: /^Wide/ }).click();
    await win.waitForSelector("html[data-width='wide']", { timeout: 10_000 });
    expect(await rootVar(win, '--reading')).toBe(`${wide.reading}px`);

    if (process.env.VOCS_CODE_E2E_CAPTURE_THEMES === '1') {
      await fs.mkdir(shots, { recursive: true });
      await win.mouse.move(0, 0);
      await win.locator('#appearance-typography').screenshot({ path: path.join(shots, 'typography-custom.png') });
    }

    const stored = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')) as { typography: Record<string, unknown> };
    expect(stored.typography).toMatchObject({ uiScale: 1.1, contentSize: 18, lineSpacing: 'relaxed', codeSize: 14, contentFont: 'serif', codeFont: 'custom', codeFontCustom: 'Courier New', width: 'wide' });

    // Everything comes back after a restart, including the zoom the main process owns.
    await app!.close();
    app = null;
    win = await launch();
    await win.waitForSelector("html[data-width='wide']", { timeout: 10_000 });
    await expect.poll(zoom, { timeout: 10_000 }).toBeCloseTo(1.1, 3);
    expect(await rootVar(win, '--content-size')).toBe('18px');

    // Reset restores the defaults in one step.
    await openTypography(win);
    await win.locator('#appearance-typography').getByRole('button', { name: 'Reset text & fonts' }).click();
    await win.waitForSelector("html[data-width='normal']", { timeout: 10_000 });
    await expect.poll(zoom, { timeout: 10_000 }).toBeCloseTo(1, 3);
    await expect.poll(() => style(win.locator('#appearance-typography .type-sample .md'), 'fontSize')).toBe(`${DEFAULT_TYPOGRAPHY.contentSize}px`);
    if (process.env.VOCS_CODE_E2E_CAPTURE_THEMES === '1') {
      await fs.mkdir(shots, { recursive: true });
      await win.locator('#appearance-typography').screenshot({ path: path.join(shots, 'typography-settings.png') });
    }
  }, 180_000);
});
