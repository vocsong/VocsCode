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
import { afterEach, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { AppSettings } from '../src/shared/types';
import { expectQuietWindow, isolatedEnv, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
let app: ElectronApplication | null = null;
let tmp: string | null = null;

afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = null;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  tmp = null;
});

type Box = { x: number; y: number; width: number; height: number };

async function box(win: Page, selector: string): Promise<Box> {
  const r = await win.locator(selector).boundingBox();
  return r ?? { x: 0, y: 0, width: 0, height: 0 };
}

describe.runIf(enabled)('shell layout', () => {
  it('gives the sidebar a column when there is room and floats it as a drawer when there is not', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-code-layout-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(shots, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));

    app = await electron.launch({ executablePath: require('electron') as string, args: [path.join(root, 'out', 'main', 'index.js')], env: isolatedEnv(userData), timeout: 60_000 });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });
    // Settings is the widest thing the app renders without a session, so a squeezed column shows.
    await win.click('.sidebar-bottom .sidebar-link:has-text("Settings")');
    await win.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click();
    await win.waitForSelector('.theme-picker', { timeout: 20_000 });

    await win.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(async () => (await box(win, '.main')).width, { timeout: 10_000 }).toBeGreaterThan(900);
    const wide = { sidebar: await box(win, '.sidebar'), main: await box(win, '.main') };
    await win.screenshot({ path: path.join(shots, 'layout-01-wide.png') });
    expect(wide.sidebar.height, 'the sidebar fills the window height').toBeGreaterThan(600);
    expect(wide.sidebar.x, 'the sidebar is the left column').toBe(0);
    expect(wide.main.x, 'content starts where the sidebar ends').toBe(wide.sidebar.width);
    expect(wide.main.width, 'content gets everything the sidebar does not').toBe(1280 - wide.sidebar.width);
    // The picker is only visible if the column it lives in has real width.
    expect((await box(win, '.theme-picker')).width).toBeGreaterThan(400);

    await win.setViewportSize({ width: 820, height: 800 });
    await expect.poll(async () => (await box(win, '.main')).width, { timeout: 10_000 }).toBe(820);
    const narrow = { sidebar: await box(win, '.sidebar'), main: await box(win, '.main'), backdrop: await box(win, '.sidebar-backdrop') };
    await win.screenshot({ path: path.join(shots, 'layout-02-drawer.png') });
    expect(narrow.main.x, 'content spans the window under the drawer').toBe(0);
    expect(narrow.main.width).toBe(820);
    expect(narrow.sidebar.x, 'the drawer is pinned to the left edge').toBe(0);
    expect(narrow.sidebar.width, 'the drawer keeps its own width above the content').toBeGreaterThan(200);
    expect(narrow.backdrop.width, 'the dismiss layer covers the window').toBe(820);

    // Dismissing the drawer hands the whole window to the content.
    await win.locator('.sidebar-backdrop').click();
    await expect.poll(async () => win.locator('.sidebar').count(), { timeout: 10_000 }).toBe(0);
    expect(await win.locator('.sidebar').count()).toBe(0);
    expect((await box(win, '.main')).width).toBe(820);
  }, 180_000);

  it('finds settings by task, saves moved defaults across a restart and keeps navigation usable at compact widths', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-settings-redesign-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData); await fs.mkdir(project); await fs.mkdir(shots, { recursive: true });
    const runtimeHomes = {
      PI_CODING_AGENT_DIR: path.join(tmp, 'pi'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CODEX_HOME: path.join(tmp, 'codex')
    };
    await Promise.all(Object.values(runtimeHomes).map((directory) => fs.mkdir(directory)));
    const settingsPath = path.join(userData, 'settings.json');
    await fs.writeFile(settingsPath, seedSettings(project, {
      theme: 'dark', defaultHarness: 'claude', defaultPermissionMode: 'ask', defaultEffort: 'low',
      autoCompactionThreshold: '50%', customBranchPrefixes: ['ops'],
      goalDefaults: { autoContinue: true, maxIterations: 25, preferHarness: true },
      agent: { enabled: false }, binaries: { editor: 'code' },
      providers: [
        { id: 'fixture-orchard', kind: 'ollama', name: 'Fixture Orchard', enabled: true, hasApiKey: false, models: [] },
        { id: 'fixture-harbor', kind: 'lmstudio', name: 'Fixture Harbor', enabled: false, hasApiKey: false, models: [] }
      ]
    }));
    const readSettings = async (): Promise<AppSettings> => JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    const launch = async (): Promise<Page> => {
      app = await electron.launch({
        executablePath: require('electron') as string, args: [path.join(root, 'out', 'main', 'index.js')],
        env: isolatedEnv(userData, runtimeHomes), timeout: 60_000
      });
      const page = await app.firstWindow();
      await page.waitForSelector('.brand', { timeout: 60_000 });
      await expectQuietWindow(app);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.locator('.sidebar-bottom').getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('heading', { name: 'General', level: 1, exact: true }).waitFor();
      return page;
    };
    let win = await launch();
    const navigate = async (name: string): Promise<void> => {
      await win.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name, exact: true }).click();
      await win.getByRole('heading', { name, level: 1, exact: true }).waitFor();
    };
    // Crop to Settings: only seeded preferences and static copy appear, never account or host paths.
    const capture = async (name: string): Promise<void> => {
      await win.locator('.settings').screenshot({ path: path.join(shots, `settings-redesign-${name}.png`), animations: 'disabled' });
    };
    const groups = ['Workspace', 'Agent behavior', 'Connections', 'System'];
    const sections = [
      'General', 'Appearance', 'Shortcuts', 'Terminal', 'Voice', 'Session defaults', 'Instructions', 'Mission',
      'Vesta & utility', 'Providers & keys', 'Harnesses', 'Pi', 'ACP agents', 'Import chats', 'Remote access', 'About & doctor'
    ];
    expect(await win.locator('.settings-nav-label').allTextContents()).toEqual(groups);
    expect(await win.getByRole('navigation', { name: 'Settings sections' }).getByRole('button').allTextContents()).toEqual(sections);
    expect(await win.locator('.settings-mobile-nav').isVisible()).toBe(false);
    expect(await win.getByLabel(/Editor command/).inputValue()).toBe('code');
    expect(await win.getByLabel(/Default harness/).count()).toBe(0);
    expect(await win.locator('.theme-picker').count()).toBe(0);
    expect(await win.getByRole('region', { name: 'Utility model', exact: true }).count()).toBe(0);
    await capture('general');

    await navigate('Appearance');
    await win.locator('.theme-picker').waitFor();
    expect(await win.locator('.theme-card.active').innerText()).toContain('Dark');
    await capture('appearance');

    // Search is keyboard reachable, announces its results and leads to the setting group, not just a page.
    await win.getByRole('button', { name: 'Back to workspace', exact: true }).focus();
    await win.keyboard.press('Tab');
    const search = win.getByRole('searchbox', { name: 'Search settings', exact: true });
    expect(await win.locator('.settings-search input:focus').count()).toBe(1);
    await search.fill('compaction');
    await win.getByRole('heading', { name: 'Find a setting', level: 1 }).waitFor();
    const contextResult = win.getByRole('button', { name: /Session defaults.*Context management/ });
    await contextResult.waitFor();
    expect(await win.locator('.settings-result-count').textContent()).toMatch(/^\d+ results? for “compaction”$/);
    expect(await win.locator('.settings-link[aria-current="page"]').count()).toBe(0);
    await capture('search');
    await search.press('ArrowDown');
    expect(await win.locator('.settings-search-result:focus').innerText()).toContain('Context management');
    await contextResult.press('Enter');
    await win.getByRole('heading', { name: 'Session defaults', level: 1 }).waitFor();
    await expect.poll(() => win.locator('#sessions-context:focus').count()).toBe(1);
    expect(await search.inputValue()).toBe('');
    const contextBox = await box(win, '#sessions-context');
    const bodyBox = await box(win, '.settings-body');
    expect(contextBox.y).toBeGreaterThanOrEqual(bodyBox.y);
    expect(contextBox.y + contextBox.height).toBeLessThanOrEqual(bodyBox.y + bodyBox.height);

    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    expect(await win.locator('.settings-search input:focus').count()).toBe(1);
    await search.fill('branch prefixes');
    await search.press('Enter');
    await expect.poll(() => win.locator('#sessions-branches:focus').count()).toBe(1);
    await search.fill('zz-no-such-setting');
    await win.getByRole('heading', { name: 'No settings found' }).waitFor();
    expect(await win.locator('.settings-result-count').textContent()).toBe('0 results for “zz-no-such-setting”');
    await win.getByRole('button', { name: 'Browse all settings', exact: true }).click();
    expect(await search.inputValue()).toBe('');
    expect(await win.locator('.settings-search input:focus').count()).toBe(1);
    await search.fill('compaction');
    await search.press('Escape');
    expect(await search.inputValue()).toBe('');
    await win.getByRole('heading', { name: 'Session defaults', level: 1 }).waitFor();
    await search.fill('theme');
    await win.getByRole('button', { name: 'Clear search', exact: true }).click();
    expect(await search.inputValue()).toBe('');
    expect(await win.locator('.settings-search input:focus').count()).toBe(1);

    // Settings' local Find shortcut must not consume the app-wide deep session search shortcut.
    await win.getByRole('heading', { name: 'Session defaults', level: 1 }).focus();
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+f' : 'Control+Shift+f');
    const sessionSearch = win.getByPlaceholder('Search titles, goals and full transcripts…', { exact: true });
    await sessionSearch.waitFor();
    expect(await win.locator('.search-palette input:focus').count()).toBe(1);
    expect(await search.inputValue()).toBe('');
    await sessionSearch.press('Escape');
    await sessionSearch.waitFor({ state: 'hidden' });
    await win.getByRole('heading', { name: 'Session defaults', level: 1 }).waitFor();

    // Every moved control still crosses the real preload/settings boundary; no renderer state injection.
    await win.getByLabel(/^Default harness/).selectOption('native');
    await expect.poll(async () => (await readSettings()).defaultHarness).toBe('native');
    await win.getByLabel(/^Default permission mode/).selectOption('plan');
    await win.getByLabel(/^Default reasoning effort/).selectOption('high');
    await win.getByLabel(/^Automatically compact context at/).selectOption('75%');
    // Toggle's visible label is the hit target; its decorative track overlays the native input.
    await win.getByText('Auto-continue goals after each turn', { exact: true }).click();
    await expect.poll(async () => (await readSettings()).goalDefaults.autoContinue).toBe(false);
    await win.getByLabel('Iteration guard', { exact: true }).fill('37');
    await expect.poll(async () => (await readSettings()).goalDefaults.maxIterations).toBe(37);
    await win.getByText(/^Prefer a harness's own \/goal/).click();
    await win.getByLabel('New branch prefix', { exact: true }).fill('review');
    await win.getByRole('region', { name: 'Worktree branches', exact: true }).getByRole('button', { name: 'Add', exact: true }).click();
    await expect.poll(async () => (await readSettings()).customBranchPrefixes).toEqual(['review', 'ops']);
    await navigate('General');
    await navigate('Session defaults');
    await capture('sessions');
    const expectedDefaults = {
      defaultHarness: 'native', defaultPermissionMode: 'plan', defaultEffort: 'high', autoCompactionThreshold: '75%',
      goalDefaults: { autoContinue: false, maxIterations: 37, preferHarness: false }, customBranchPrefixes: ['review', 'ops']
    };
    await expect.poll(readSettings).toMatchObject(expectedDefaults);

    // Filtering is a reversible view operation; it neither tests an endpoint nor edits a provider.
    await navigate('Providers & keys');
    const providerCards = win.locator('.settings-section > .provider-card:visible');
    const providerNames = await providerCards.locator('.provider-name').allTextContents();
    expect(providerNames).toContain('Fixture Orchard');
    expect(providerNames).toContain('Fixture Harbor');
    const providersBefore = (await readSettings()).providers;
    const orchard = providerCards.filter({ has: win.locator('.provider-name', { hasText: /^Fixture Orchard$/ }) });
    const modelDraft = orchard.getByPlaceholder('Add a model id', { exact: true });
    await modelDraft.fill('unsaved-orchard-model');
    const filter = win.getByRole('searchbox', { name: 'Filter providers', exact: true });
    await filter.fill('Fixture Orchard');
    expect(await providerCards.locator('.provider-name').allTextContents()).toEqual(['Fixture Orchard']);
    expect(await win.locator('#providers-catalog').getByRole('status').textContent()).toBe(`1 of ${providerNames.length} providers`);
    await filter.fill('zz-no-such-provider');
    await win.getByText(/No providers match “zz-no-such-provider”/).waitFor();
    expect(await providerCards.count()).toBe(0);
    await win.getByRole('button', { name: 'Show all providers', exact: true }).click();
    expect(await filter.inputValue()).toBe('');
    expect(await providerCards.locator('.provider-name').allTextContents()).toEqual(providerNames);
    expect(await modelDraft.inputValue()).toBe('unsaved-orchard-model');
    expect((await readSettings()).providers).toEqual(providersBefore);

    // All destinations remain reachable; observing runtimes/remote does not install, log in or connect.
    for (const name of sections) {
      await navigate(name);
      const overflow = await win.locator('.settings-content').evaluate(async (element) => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return element.scrollWidth - element.clientWidth;
      });
      expect(overflow, `${name} content fits its column without horizontal overflow`).toBeLessThanOrEqual(1);
      if (name === 'Shortcuts') await capture('shortcuts');
    }

    // A Mission budget result skips the tier cards and focuses the actual limits heading.
    await search.fill('mission budget');
    await win.getByRole('button', { name: /Mission limits & projects/ }).waitFor();
    await search.press('Enter');
    await win.getByRole('heading', { name: 'Mission', level: 1, exact: true }).waitFor();
    await expect.poll(() => win.locator('h3#mission-limits:focus').textContent()).toBe('Concurrency and progress limits');
    const limitsBox = await box(win, '#mission-limits');
    const missionBody = await box(win, '.settings-body');
    expect(limitsBox.y).toBeGreaterThanOrEqual(missionBody.y);
    expect(limitsBox.y + limitsBox.height).toBeLessThanOrEqual(missionBody.y + missionBody.height);

    // Reproducible light/dark review frames for each major surface, using the real theme controls.
    for (const [theme, label] of [['light', 'Light'], ['dark', 'Dark']] as const) {
      await navigate('Appearance');
      await win.locator('.theme-picker').getByRole('button', { name: label, exact: true }).click();
      await win.locator(`html[data-theme="${theme}"]`).waitFor();
      await capture(`appearance-${theme}`);
      await navigate('General'); await capture(`general-${theme}`);
      await navigate('Session defaults'); await capture(`sessions-${theme}`);
      await search.fill('compaction');
      await contextResult.waitFor(); await capture(`search-${theme}`);
      await search.press('Escape');
    }

    await win.setViewportSize({ width: 600, height: 900 });
    await win.locator('.sidebar-backdrop').click();
    const compact = win.getByRole('combobox', { name: 'Settings section', exact: true });
    await compact.waitFor();
    expect(await win.getByRole('navigation', { name: 'Settings sections' }).isVisible()).toBe(false);
    expect(await compact.locator('optgroup').evaluateAll((items) => items.map((item) => item.getAttribute('label')))).toEqual(groups);
    await compact.selectOption('appearance');
    await win.getByRole('heading', { name: 'Appearance', level: 1 }).waitFor();
    expect(await win.locator('.theme-card.active').innerText()).toContain('Dark');
    await compact.selectOption('sessions');
    await win.getByRole('heading', { name: 'Session defaults', level: 1 }).waitFor();
    expect(await win.getByLabel(/^Default harness/).inputValue()).toBe('native');
    const compactNav = await box(win, '.settings-nav');
    const compactMain = await box(win, '.settings-main');
    expect(compactMain.y).toBeGreaterThanOrEqual(compactNav.y + compactNav.height - 1);
    expect(compactMain.x).toBeGreaterThanOrEqual(0);
    expect(compactMain.x + compactMain.width).toBeLessThanOrEqual(600);
    expect(compactMain.width).toBeGreaterThan(560);
    await capture('compact');
    await search.fill('compaction');
    await search.press('Enter');
    await expect.poll(() => win.locator('#sessions-context:focus').count()).toBe(1);
    expect(await compact.inputValue()).toBe('sessions');

    // The View menu remains a direct route to Appearance, including from outside Settings.
    await win.setViewportSize({ width: 1440, height: 1000 });
    await win.getByRole('button', { name: 'Back to workspace', exact: true }).click();
    await expect.poll(() => win.locator('.settings').count()).toBe(0);
    await win.locator('.menubar').getByRole('button', { name: 'View', exact: true }).click();
    await win.locator('.menubar-panel').getByRole('button', { name: 'Theme', exact: true }).click();
    await win.getByRole('heading', { name: 'Appearance', level: 1 }).waitFor();
    expect(await win.locator('.settings-mobile-nav').isVisible()).toBe(false);

    await app!.close(); app = null;
    win = await launch();
    await win.locator('html[data-theme="dark"]').waitFor();
    await navigate('Session defaults');
    expect(await win.getByLabel(/^Default harness/).inputValue()).toBe('native');
    expect(await win.getByLabel(/^Default permission mode/).inputValue()).toBe('plan');
    expect(await win.getByLabel(/^Default reasoning effort/).inputValue()).toBe('high');
    expect(await win.getByLabel(/^Automatically compact context at/).inputValue()).toBe('75%');
    expect(await win.getByRole('checkbox', { name: 'Auto-continue goals after each turn', exact: true }).isChecked()).toBe(false);
    expect(await win.getByLabel('Iteration guard', { exact: true }).inputValue()).toBe('37');
    expect(await win.getByRole('checkbox', { name: /^Prefer a harness's own \/goal/ }).isChecked()).toBe(false);
    expect(await win.getByRole('region', { name: 'Worktree branches', exact: true }).locator('.shortcut-row-main').allTextContents()).toEqual(['review/', 'ops/']);
    expect(await readSettings()).toMatchObject({ ...expectedDefaults, theme: 'dark' });
  }, 240_000);
});
