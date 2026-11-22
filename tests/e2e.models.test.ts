/**
 * Regression test for an empty model dropdown on a brand-new session. A harness process is only
 * spawned by the first message, so its `models` event does not exist before that; the composer's model
 * control has to fall back to the pre-session catalog instead of showing "no model list yet". Additional cases cover
 * the new-session dialog listing configured providers and both Codex harnesses' live runtime catalog.
 *
 * Requires `npm run build` first. Gated by VOCS_CODE_E2E_UI=1. Each session is seeded straight into a
 * fresh userData — the New Session dialog picks its folder through a native chooser Playwright cannot
 * drive, and a seeded session is the exact state under test: persisted, idle, never sent to. Every
 * provider key is stripped as well, so nothing leaves the machine and no turn can start.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { ANTIGRAVITY_INSTALL_URL, type HarnessSetupStatus } from '../src/shared/harness-setup';
import type { ModelInfo, ProviderConfig, SessionMeta } from '../src/shared/types';
import { PUSH_CHANNELS } from '../src/shared/ipc';
import { FAST_MODE_COST_WARNING } from '../src/shared/fast-mode';
import { openNewSession, pickModel, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
const apps: ElectronApplication[] = [];

afterAll(async () => {
  for (const a of apps) await a.close().catch(() => undefined);
});

function session(id: string, harness: SessionMeta['config']['harness'], project: string): SessionMeta {
  return {
    id,
    title: `${harness} session`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    config: { harness, projectRoot: project, permissionMode: 'ask', useWorktree: false },
    cwd: project,
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    queued: 0
  };
}

/** Opens a harness card in the new-session dialog by its exact name. */
async function pickHarness(win: Page, name: RegExp): Promise<void> {
  await win.locator('.harness-card', { has: win.locator('.harness-card-name', { hasText: name }) }).click();
}

interface ModelRefreshFixture {
  models: ModelInfo[];
  discoveries: string[];
  forbidden: string[];
}
type FixtureGlobal = typeof globalThis & { __vocsModelRefreshFixture: ModelRefreshFixture };

interface AntigravitySetupFixture {
  state: 'missing' | 'signed-out' | 'signed-in';
  openedUrls: string[];
  signIns: unknown[];
  quotaChecks: number;
  modelLists: number;
  sends: number;
}
type AntigravityFixtureGlobal = typeof globalThis & { __vocsAntigravitySetupFixture: AntigravitySetupFixture };

/** Launches the built app against a fresh userData with every provider key stripped. */
async function launch(userData: string, catalog?: ModelInfo[]): Promise<Page> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === 'ELECTRON_RUN_AS_NODE' || k === 'ELECTRON_RENDERER_URL' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue;
    if (/^(ANTHROPIC|OPENAI|DEEPSEEK|OPENROUTER|OPENCODE|GEMINI|GROQ|XAI|MISTRAL)_API_KEY$/.test(k)) continue;
    env[k] = v;
  }
  env.VOCS_CODE_USER_DATA = userData;
  // Keep the short-lived Claude model probe off the developer's real login. Claude Code may still
  // report its runtime catalog, but this suite never borrows account credentials or starts a turn.
  env.CLAUDE_CONFIG_DIR = path.join(userData, 'claude');
  env.CODEX_HOME = path.join(userData, 'codex');
  env.PI_CODING_AGENT_DIR = path.join(userData, 'pi');
  env.HOME = env.USERPROFILE = path.join(userData, 'home');
  env.APPDATA = path.join(env.USERPROFILE, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(env.USERPROFILE, 'AppData', 'Local');
  // Windows resolves appData before our userData override. A synthetic profile must exist.
  for (const dir of [env.APPDATA, env.LOCALAPPDATA, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, env.PI_CODING_AGENT_DIR]) await fs.mkdir(dir, { recursive: true });
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CODEX_API_KEY', 'CURSOR_API_KEY', 'GOOGLE_API_KEY']) env[key] = '';
  env.VOCS_CODE_UPDATER_DISABLE = '1';
  // requestSingleInstanceLock() runs before VOCS_CODE_USER_DATA is applied, so a run started while
  // the app is open would exit silently; --user-data-dir is a Chromium switch and lands earlier.
  const packaged = process.env.HARNESS_E2E_EXE;
  // These isolated model fixtures must not prompt for access to the macOS login Keychain.
  const args = [...(packaged ? [] : [path.join(root, 'out', 'main', 'index.js')]), `--user-data-dir=${userData}`, ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : [])];
  const app = await electron.launch({ executablePath: packaged || (require('electron') as string), args, env, timeout: 60_000 });
  apps.push(app);
  const win: Page = await app.firstWindow();
  await win.waitForSelector('.brand', { timeout: 60_000 });
  if (catalog) {
    // Isolate catalog changes from whichever Pi runtime is installed. Only the main discovery
    // response is scripted: the preload, store, Settings, dialog and composer are production UI.
    await app.evaluate(({ ipcMain }, models) => {
      const fixture: ModelRefreshFixture = { models, discoveries: [], forbidden: [] };
      (globalThis as FixtureGlobal).__vocsModelRefreshFixture = fixture;
      ipcMain.removeHandler('harness:models');
      ipcMain.handle('harness:models', (_event, request: { harness: string }) => {
        fixture.discoveries.push(request.harness);
        return request.harness === 'pi' ? { models: fixture.models } : { models: [], error: 'Only Pi is configured in this fixture' };
      });
      // Fail closed if a catalog-only UI action accidentally becomes an install, login or turn.
      for (const channel of ['harness:install', 'harness:login', 'sessions:create', 'sessions:send']) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => {
          fixture.forbidden.push(channel);
          throw new Error(`${channel} is forbidden in the model-refresh fixture`);
        });
      }
    }, catalog);
  }
  // A renderer may already have booted before Electron's main evaluation; discard that state so
  // these two fixture cases always begin with the controlled catalog, not an installed runtime.
  if (catalog) await win.reload();
  await win.waitForSelector('.brand', { timeout: 60_000 });
  return win;
}

describe.runIf(enabled)('model picker before the first message', () => {
  it.each([
    { size: 'short', height: 600 },
    { size: 'tall', height: 1000 }
  ])('aligns the model picker with the harness section in a $size New Session dialog', async ({ size, height }) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-new-session-layout-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    // Native reads these from settings without a provider request or a running harness.
    const models = Array.from({ length: 24 }, (_, i) => ({
      provider: 'openai', id: `layout-fixture-${i + 1}`, displayName: `Layout fixture ${i + 1}`
    }));
    const viewport = { width: 960, height };
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, {
      windowBounds: viewport,
      defaultHarness: 'native',
      defaultUseWorktree: false,
      providers: [{ id: 'openai', enabled: true, hasApiKey: false, models }]
    }), 'utf8');

    const win = await launch(userData);
    // Pin CSS pixels independently of the CI display size.
    await win.setViewportSize(viewport);
    await openNewSession(win);
    const dialog = win.getByRole('dialog', { name: /^New session/i });
    const picker = dialog.locator('.ns-grid .ns-col-model .model-picker');
    const list = picker.locator('.mp-list');
    const cards = dialog.locator('.harness-cards .harness-card');
    const search = picker.getByRole('textbox', { name: 'Search models', exact: true });
    const start = dialog.getByRole('button', { name: /^Start session/ });
    await search.waitFor({ state: 'visible' });
    await start.waitFor({ state: 'visible' });
    await expect.poll(() => list.locator('.mp-name[title^="openai/layout-fixture-"]').count(), { timeout: 30_000 }).toBe(models.length);
    // Measure the populated card layout, not the shorter loading spinners.
    await cards.first().waitFor({ state: 'visible' });
    await expect.poll(() => cards.locator('.badge').count(), { timeout: 75_000 }).toBe(await cards.count());
    await win.evaluate(() => document.fonts.ready.then(() => undefined));
    // Typing starts in the first prompt: it has focus on open, scrolled into view in a short dialog.
    const prompt = dialog.getByRole('textbox', { name: 'First prompt (optional)', exact: true });
    expect(await prompt.evaluate((el) => el === document.activeElement), 'first prompt is focused on open').toBe(true);
    expect(await prompt.evaluate((el) => {
      const body = el.closest('.modal-body')!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return r.top >= body.top - 1 && r.bottom <= body.bottom + 1;
    }), 'first prompt is visible on open').toBe(true);
    // The layout checks below measure from the top of the dialog body.
    await dialog.locator('.modal-body').evaluate((el) => { el.scrollTop = 0; });

    const geometry = () => dialog.evaluate((el) => {
      const body = el.querySelector<HTMLElement>('.modal-body')!;
      const column = el.querySelector('.ns-col-model')!;
      const picker = column.querySelector('.model-picker')!;
      const cards = el.querySelector('.harness-cards')!;
      const rect = (node: Element) => {
        const { x, width, height, top, bottom } = node.getBoundingClientRect();
        return { x, width, height, top, bottom };
      };
      const bodyRect = rect(body);
      const pickerRect = rect(picker);
      // A grouping wrapper with display: contents does not clip its children.
      const columnRect = column.getClientRects().length && getComputedStyle(column).overflowY !== 'visible' ? rect(column) : undefined;
      return {
        cards: rect(cards),
        harness: rect(cards.closest('section')!),
        picker: pickerRect,
        list: rect(picker.querySelector('.mp-list')!),
        search: rect(picker.querySelector('.mp-search input')!),
        footer: rect(el.querySelector('.modal-footer')!),
        body: { scrollTop: body.scrollTop, bottom: bodyRect.bottom },
        modelClipTop: Math.max(0, bodyRect.top, pickerRect.top, columnRect?.top ?? 0),
        modelClipBottom: Math.min(innerHeight, bodyRect.bottom, pickerRect.bottom, columnRect?.bottom ?? innerHeight)
      };
    });
    const before = await geometry();
    // Compare the actual border, not the height left after clipping by the dialog body.
    expect(Math.abs(before.harness.bottom - before.picker.bottom), 'harness section and model picker bottoms (CSS px)').toBeLessThanOrEqual(2);
    const exposedListTop = Math.max(before.list.top, before.modelClipTop);
    const exposedListHeight = Math.min(before.list.bottom, before.modelClipBottom) - exposedListTop;
    // Harness status labels may wrap and change the intrinsic height across machines.
    expect(exposedListHeight, 'model list height exposed on open (CSS px)').toBeGreaterThanOrEqual(125);
    expect(before.cards.height, 'combined harness card height (CSS px)').toBeLessThanOrEqual(240);
    expect(before.list.width, 'model list is wider than the harness grid').toBeGreaterThan(before.cards.width);
    expect(before.list.x).toBeGreaterThanOrEqual(before.cards.x + before.cards.width);
    expect(before.search.top, 'search is not clipped on open').toBeGreaterThanOrEqual(before.modelClipTop - 1);
    expect(before.search.bottom).toBeLessThanOrEqual(before.list.top + 1);
    expect(before.footer.top, 'footer is below the scrolling dialog body').toBeGreaterThanOrEqual(before.body.bottom - 1);
    expect(before.footer.bottom, 'footer fits inside the viewport').toBeLessThanOrEqual(viewport.height + 1);
    expect(await search.evaluate((el) => el === document.activeElement), 'the model search no longer takes focus on open').toBe(false);
    if (size === 'short') {
      await fs.mkdir(shots, { recursive: true });
      await win.screenshot({ path: path.join(shots, 'models-06-short-new-session.png') });
    }

    // Wheel inside the exposed list without Playwright auto-scrolling a row into view.
    const wheel = { x: before.list.x + before.list.width / 2, y: exposedListTop + exposedListHeight / 2 };
    expect(await list.evaluate((el, { x, y }) => el.contains(document.elementFromPoint(x, y)), wheel), 'wheel point hits the visible list').toBe(true);
    await win.mouse.move(wheel.x, wheel.y);
    await win.mouse.wheel(0, 160);
    await expect.poll(() => list.evaluate((el) => el.scrollTop), { timeout: 5_000 }).toBeGreaterThan(48);
    const after = await geometry();
    expect(after.body.scrollTop, 'wheel scroll stays in the model list').toBe(before.body.scrollTop);
    expect(Math.abs(after.search.top - before.search.top), 'search stays in place').toBeLessThanOrEqual(1);
    expect(Math.abs(after.footer.top - before.footer.top), 'footer stays in place').toBeLessThanOrEqual(1);

    const order = ['First prompt (optional)', 'Goal (optional)', 'Isolate in a git worktree', 'Advanced'] as const;
    const label = (text: (typeof order)[number]) => dialog.getByText(text, { exact: true });
    // The union yields the labels in DOM order; measure the full fields for visual order.
    const fields = await label(order[0]).or(label(order[1])).or(label(order[2])).or(label(order[3])).evaluateAll((els) => els.map((el) => {
      const { top, bottom } = (el.closest('.field, .toggle') ?? el).getBoundingClientRect();
      return { text: el.textContent?.trim(), top, bottom };
    }));
    expect(fields.map((field) => field.text), 'DOM order of the form fields').toEqual(order);
    for (let i = 1; i < fields.length; i++) {
      expect(fields[i].top, `${fields[i].text} is visually below ${fields[i - 1].text}`).toBeGreaterThanOrEqual(fields[i - 1].bottom - 1);
    }

    // A keyboard user can skip the catalog rows and start typing without scrolling manually.
    await dialog.getByRole('button', { name: 'Jump to first prompt', exact: true }).press('Enter');
    expect(await prompt.evaluate((el) => el === document.activeElement)).toBe(true);
    if (size === 'short') expect((await geometry()).body.scrollTop).toBeGreaterThan(0);
    await apps[apps.length - 1]!.close();
  }, 180_000);

  it.each(['Settings Providers refresh', 'cancelled New Session discovery'] as const)('updates an existing Pi composer after %s without losing its draft or starting a turn', async (entry) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-model-refresh-'));
    const userData = path.join(tmp, 'userData'), project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    const existing = session('s_refresh', 'pi', project);
    existing.config.model = { provider: 'openai', model: 'gpt-5.4' };
    existing.config.effort = 'high';
    existing.activeEffort = 'low';
    const baseline: ModelInfo = { provider: 'openai', id: 'gpt-5.4', displayName: 'Catalog baseline', contextWindow: 256_000, supportedEfforts: ['low', 'high'] };
    // Synthetic availability, not a claim that this runtime/account has access to GPT 6.2.
    const discovered: ModelInfo = { provider: 'openai', id: 'gpt-6.2', displayName: 'GPT 6.2 fixture', contextWindow: 512_000 };
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([existing]), 'utf8');
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, { defaultHarness: 'pi', agent: { enabled: false }, providers: [] }), 'utf8');
    const win = await launch(userData, [baseline]);
    const app = apps[apps.length - 1]!;
    const errors: string[] = [];
    win.on('pageerror', (error) => errors.push(error.message));
    await win.locator('.composer').waitFor({ timeout: 60_000 });
    const modelPill = win.locator('.composer').getByRole('button', { name: /^Model:/ });
    const menu = win.locator('.composer .run-controls').getByRole('menu');
    const more = menu.getByRole('menuitem', { name: 'More models', exact: true });
    await modelPill.click();
    // The checked tier follows the effective effort, not the differing saved preference.
    await menu.getByRole('group', { name: 'Reasoning Effort', exact: true })
      .getByRole('menuitemradio', { name: 'low', exact: true, checked: true }).waitFor({ timeout: 20_000 });
    await more.click();
    const picker = menu.locator('.model-picker');
    const refs = () => picker.locator('.mp-name').evaluateAll((els) => els.map((el) => el.getAttribute('title')).sort());
    await expect.poll(refs, { timeout: 20_000 }).toEqual(['openai/gpt-5.4']);

    // Reproduce a stale session-owned list without starting Pi or sending a paid prompt. The
    // reported duplicate has authoritative metadata; refreshing may append, never overwrite it.
    await app.evaluate(({ BrowserWindow }, { channel, sessionId, model }) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send(channel, {
        sessionId, event: { type: 'models', models: [model] }, ts: Date.now(), seq: 1
      });
    }, { channel: PUSH_CHANNELS.sessionEvent, sessionId: existing.id, model: { ...baseline, displayName: 'Session-reported baseline', contextWindow: 128_000 } });
    await expect.poll(() => picker.locator('.mp-row').innerText(), { timeout: 10_000 }).toContain('Session-reported baseline');
    const draft = 'Keep this unsent draft while refreshing models';
    await picker.locator('.mp-search input').press('Escape');
    await picker.waitFor({ state: 'hidden' });
    await win.locator('.composer textarea').fill(draft);

    if (entry === 'Settings Providers refresh') {
      await win.getByRole('button', { name: 'Settings', exact: true }).click();
      await win.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Providers & keys', exact: true }).click();
      for (const name of ['Refresh Claude Agent SDK models', 'Refresh Codex (app-server) models', 'Refresh Pi models']) {
        expect(await win.getByRole('button', { name, exact: true }).isVisible()).toBe(true);
      }
    }
    await app.evaluate((_electron, models) => {
      (globalThis as FixtureGlobal).__vocsModelRefreshFixture.models = models;
    }, [baseline, discovered]);
    const beforeDiscovery = await app.evaluate(() => (globalThis as FixtureGlobal).__vocsModelRefreshFixture.discoveries.length);
    if (entry === 'Settings Providers refresh') {
      await win.getByRole('button', { name: 'Refresh Pi models', exact: true }).click();
      await win.locator('#providers-logins').getByRole('status').filter({ hasText: 'Pi: 2 models' }).waitFor({ timeout: 20_000 });
      await win.getByRole('button', { name: 'Back to workspace', exact: true }).click();
    } else {
      await openNewSession(win);
      const dialogPicker = win.locator('.ns-col-model .model-picker');
      await expect.poll(() => dialogPicker.locator('.mp-name').evaluateAll((els) => els.map((el) => el.getAttribute('title')).sort()), { timeout: 20_000 }).toEqual(['openai/gpt-5.4', 'openai/gpt-6.2']);
      await win.getByRole('button', { name: 'Cancel', exact: true }).click();
      await win.locator('.modal').waitFor({ state: 'hidden' });
    }
    expect(await app.evaluate(() => (globalThis as FixtureGlobal).__vocsModelRefreshFixture.discoveries.length)).toBe(beforeDiscovery + 1);
    expect(await win.locator('.composer textarea').inputValue()).toBe(draft);
    await modelPill.click();
    await more.click();
    await expect.poll(refs, { timeout: 20_000 }).toEqual(['openai/gpt-5.4', 'openai/gpt-6.2']);
    const reported = picker.locator('.mp-row:has(.mp-name[title="openai/gpt-5.4"])');
    expect(await reported.innerText()).toContain('Session-reported baseline');
    expect(await reported.innerText()).toContain('Context 128k');
    expect(await picker.locator('.mp-name[title="openai/gpt-6.2"]').count()).toBe(1);
    await menu.getByRole('button', { name: 'Back', exact: true }).click();
    await menu.getByRole('group', { name: 'Favourite', exact: true })
      .getByRole('menuitem', { name: /^openai\/gpt-6\.2\b/ }).click();
    await expect.poll(() => modelPill.locator('.pill-text').getAttribute('title'), { timeout: 10_000 }).toBe('openai/gpt-6.2');
    expect(await win.locator('.composer textarea').inputValue()).toBe(draft);
    const persisted = JSON.parse(await fs.readFile(path.join(userData, 'sessions.json'), 'utf8')) as SessionMeta[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(existing.id);
    expect(persisted[0].status).toBe('idle');
    expect(persisted[0].usage.turns).toBe(0);
    expect(persisted[0].harnessRef).toEqual({});
    expect(persisted[0].config.model).toEqual({ provider: 'openai', model: 'gpt-6.2' });
    expect(await win.locator('.transcript .item').count()).toBe(0);
    expect(await app.evaluate(() => (globalThis as FixtureGlobal).__vocsModelRefreshFixture.forbidden)).toEqual([]);
    expect(errors).toEqual([]);
    await app.close();
  }, 180_000);

  it('creates a Fast request and changes it under the composer without claiming an effective fast tier', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-fast-mode-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    // Explicit catalog and no key: this covers controls and persistence, never a paid turn.
    const viewport = { width: 960, height: 720 };
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, {
      windowBounds: viewport,
      defaultHarness: 'native',
      defaultEffort: 'high',
      defaultModelByHarness: { native: { provider: 'openai', model: 'gpt-5.4' } },
      favoriteModels: [{ provider: 'openai', model: 'gpt-4.1' }],
      agent: { enabled: false },
      providers: [{ id: 'openai', enabled: true, hasApiKey: false, models: [
        { provider: 'openai', id: 'gpt-5.4', displayName: 'GPT 5.4', supportedEfforts: ['low', 'high'] },
        { provider: 'openai', id: 'gpt-4.1', displayName: 'GPT 4.1' },
        { provider: 'openai', id: 'gpt-5.4-mini', displayName: 'GPT 5.4 mini' }
      ] }]
    }), 'utf8');

    const win = await launch(userData);
    await win.setViewportSize(viewport);
    await win.emulateMedia({ reducedMotion: 'no-preference' });
    await openNewSession(win);
    await pickModel(win, 'openai/gpt-5.4');
    const creationToggle = win.getByRole('checkbox', { name: 'Fast mode', exact: true });
    expect(await creationToggle.isChecked()).toBe(false);
    expect(await win.getByText(FAST_MODE_COST_WARNING, { exact: true }).isVisible()).toBe(true);
    await creationToggle.locator('..').click();
    expect(await creationToggle.isChecked()).toBe(true);
    await pickModel(win, 'openai/gpt-4.1');
    expect(await creationToggle.isDisabled()).toBe(true);
    expect(await creationToggle.isChecked()).toBe(false);
    await pickModel(win, 'openai/gpt-5.4');
    expect(await creationToggle.isChecked()).toBe(false);
    await creationToggle.locator('..').click();
    expect(await creationToggle.isChecked()).toBe(true);
    await win.getByRole('button', { name: /Start session/ }).click();

    // All three groups are visible together; the shortlist includes the unstarred current model.
    const controls = win.locator('.composer .run-controls');
    const modelPill = controls.getByRole('button', { name: /^Model:/ });
    const menu = controls.getByRole('menu');
    const favourite = menu.getByRole('group', { name: 'Favourite', exact: true });
    const starred = favourite.getByRole('menuitem', { name: /^openai\/gpt-4\.1(?:\s|$)/ });
    const more = menu.getByRole('menuitem', { name: 'More models', exact: true });
    const effort = menu.getByRole('group', { name: 'Reasoning Effort', exact: true });
    const low = effort.getByRole('menuitemradio', { name: 'low', exact: true });
    const high = effort.getByRole('menuitemradio', { name: 'high', exact: true });
    const fast = menu.getByRole('group', { name: 'Fast Mode', exact: true });
    const on = fast.getByRole('menuitemradio', { name: 'On', exact: true });
    const off = fast.getByRole('menuitemradio', { name: 'Off', exact: true });
    const requested = fast.getByText('Requested', { exact: true });
    const confirm = win.getByRole('button', { name: 'Enable Fast mode', exact: true });
    const bolt = modelPill.locator('[data-icon="bolt"]');
    const chargeAnimation = () => modelPill.evaluate((el) => getComputedStyle(el, '::after').animationName);
    const saved = async () => JSON.parse(await fs.readFile(path.join(userData, 'sessions.json'), 'utf8')) as SessionMeta[];

    await modelPill.click({ timeout: 60_000 });
    await starred.waitFor({ timeout: 20_000 });
    expect(await favourite.getByRole('menuitem', { name: /^openai\/gpt-5\.4(?:\s|$)/ }).isVisible()).toBe(true);
    expect(await favourite.getByRole('menuitem', { name: /^[^/]+\// }).count()).toBe(2);
    expect(await effort.getByRole('menuitemradio').count()).toBe(2);
    expect(await low.getAttribute('aria-checked')).toBe('false');
    expect(await high.getAttribute('aria-checked')).toBe('true');
    expect(await fast.getByRole('menuitemradio').count()).toBe(2);
    expect(await on.getAttribute('aria-checked')).toBe('true');
    expect(await off.getAttribute('aria-checked')).toBe('false');
    expect(await requested.isVisible()).toBe(true);
    await expect.poll(async () => (await saved())[0]?.config.fastMode, { timeout: 10_000 }).toBe(true);
    expect((await saved())[0].config.effort).toBe('high');
    // The pill still exposes the qualified model and effort.
    expect(await modelPill.locator('.pill-text').innerText()).toBe('openai/GPT 5.4');
    expect(await modelPill.locator('.pill-effort').innerText()).toBe('high');
    expect(await modelPill.locator('.pill-text').getAttribute('title')).toBe('openai/gpt-5.4');
    expect(await modelPill.getAttribute('aria-label')).toContain('Model: openai/gpt-5.4');
    expect(await modelPill.getAttribute('aria-label')).toContain('high');
    expect(await bolt.isVisible()).toBe(true);
    expect(await chargeAnimation()).not.toBe('none');
    await win.emulateMedia({ reducedMotion: 'reduce' });
    expect(await chargeAnimation()).toBe('none');
    expect(await bolt.isVisible()).toBe(true);
    await win.emulateMedia({ reducedMotion: 'no-preference' });

    // More models follows the shortlist; the arrow keys reach both sets of inline radio items.
    await starred.press('ArrowDown');
    expect(await more.evaluate((el) => el === document.activeElement)).toBe(true);
    await win.keyboard.press('ArrowDown');
    expect(await low.evaluate((el) => el === document.activeElement)).toBe(true);
    await high.press('ArrowDown');
    expect(await on.evaluate((el) => el === document.activeElement)).toBe(true);
    await win.keyboard.press('ArrowDown');
    expect(await off.evaluate((el) => el === document.activeElement)).toBe(true);
    await win.keyboard.press('Enter');
    await expect.poll(() => off.getAttribute('aria-checked'), { timeout: 10_000 }).toBe('true');
    expect(await on.getAttribute('aria-checked')).toBe('false');
    expect(await requested.isVisible()).toBe(false);
    expect(await confirm.count()).toBe(0);
    expect(await chargeAnimation()).toBe('none');
    expect(await bolt.count()).toBe(0);
    await expect.poll(async () => (await saved())[0]?.config.fastMode, { timeout: 10_000 }).toBe(false);
    expect(await high.getAttribute('aria-checked')).toBe('true');
    expect(await menu.evaluate((el) => el.scrollHeight <= el.clientHeight + 1), 'all groups fit in the review screenshot').toBe(true);
    await fs.mkdir(shots, { recursive: true });
    await menu.screenshot({ path: path.join(shots, 'models-07-inline-model-menu.png'), animations: 'disabled' });

    await low.click();
    await menu.waitFor({ state: 'hidden' });
    await expect.poll(() => modelPill.locator('.pill-effort').innerText(), { timeout: 10_000 }).toBe('low');
    await modelPill.click();
    expect(await low.getAttribute('aria-checked')).toBe('true');
    expect(await high.getAttribute('aria-checked')).toBe('false');

    await on.click();
    await confirm.waitFor();
    expect(await win.getByText(FAST_MODE_COST_WARNING, { exact: true }).isVisible()).toBe(true);
    expect(await on.getAttribute('aria-checked')).toBe('false');
    expect((await saved())[0].config.fastMode).toBe(false);
    await confirm.click();
    await menu.waitFor({ state: 'hidden' });
    await modelPill.click();
    await expect.poll(() => on.getAttribute('aria-checked'), { timeout: 10_000 }).toBe('true');
    expect(await off.getAttribute('aria-checked')).toBe('false');
    expect(await chargeAnimation()).not.toBe('none');
    await requested.waitFor();
    expect(await low.getAttribute('aria-checked')).toBe('true');
    await expect.poll(async () => (await saved())[0]?.config.fastMode, { timeout: 10_000 }).toBe(true);
    const stored = await saved();
    expect(stored).toHaveLength(1);
    expect(stored[0].config.effort).toBe('low');
    expect(stored[0].status).toBe('idle');
    expect(stored[0].usage.turns).toBe(0);
    expect(await win.locator('.transcript .item').count()).toBe(0);
  }, 180_000);

  it('lists models on a session whose harness has not been started', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-models-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# models e2e\n');
    await fs.mkdir(shots, { recursive: true });

    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session('s_fresh', 'native', project)]), 'utf8');
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project), 'utf8');

    const win = await launch(userData);
    await win.waitForSelector('.header', { timeout: 60_000 });
    // Nothing was ever sent, so the harness never spawned: this is the state that used to be empty.
    expect(await win.locator('.transcript .item').count()).toBe(0);

    // The pill opens a short list first; the full catalog is one step in, under More models.
    const controls = win.locator('.composer .run-controls');
    const modelPill = controls.getByRole('button', { name: /^Model:/ });
    const menu = controls.getByRole('menu');
    const more = menu.getByRole('menuitem', { name: 'More models', exact: true });
    await modelPill.click();
    const shortlist = menu.getByRole('group', { name: 'Favourite', exact: true })
      .getByRole('menuitem', { name: /^[^/]+\// });
    await shortlist.first().waitFor({ timeout: 20_000 });
    expect(await menu.getByRole('group', { name: 'Reasoning Effort', exact: true }).isVisible()).toBe(true);
    await win.screenshot({ path: path.join(shots, 'models-00-model-menu.png') });
    await more.click();
    const picker = win.locator('.model-picker');
    await picker.waitFor({ timeout: 10_000 });
    await picker.locator('.mp-row').first().waitFor({ timeout: 20_000 });
    expect(await picker.locator('.mp-row').count()).toBeGreaterThan(1);
    const text = await picker.innerText();
    expect(text).not.toContain('No models available');
    expect(text).not.toContain('Loading models');
    expect(text).toContain('Context ');
    expect(await picker.locator('.mp-row .menu-item-hint').count()).toBe(await picker.locator('.mp-row').count());
    await win.screenshot({ path: path.join(shots, 'models-01-fresh-session.png') });

    // Picking one sticks even with no process to tell about it.
    const first = picker.locator('.mp-row .mp-select').first();
    // The row is named `provider/id`; the compact model pill preserves that qualified name in its tooltip.
    const picked = (await first.locator('.mp-name').getAttribute('title')) ?? '';
    expect(picked).toContain('/');
    await first.click();
    await expect.poll(() => modelPill.locator('.pill-text').getAttribute('title'), { timeout: 10_000 }).toBe(picked);

    // A gateway id that no catalog lists can still be typed and sticks: a bare id is adopted under
    // the provider already in use, and the pill's tooltip retains that qualified name.
    await modelPill.click();
    await more.click();
    const picker2 = win.locator('.model-picker');
    await picker2.waitFor({ timeout: 10_000 });
    await picker2.locator('.mp-search input').fill('acme-custom-1');
    await picker2.getByRole('button', { name: 'Use “acme-custom-1”' }).click();
    await expect.poll(() => modelPill.locator('.pill-text').getAttribute('title'), { timeout: 10_000 }).toBe(`${picked.split('/')[0]}/acme-custom-1`);
    expect(await modelPill.locator('.pill-text').innerText()).toBe(`${picked.split('/')[0]}/acme-custom-1`);
  }, 180_000);

  it.each([
    { harness: 'codex', name: /^Codex \(app-server\)$/ },
    { harness: 'codex-exec', name: /^Codex \(exec SDK\)$/ }
  ] as const)('offers and selects the live $harness catalog in New Session', async ({ harness, name }) => {
    const tmp = path.join(os.tmpdir(), `vocs-code-${harness}-live-models-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, { providers: [] }), 'utf8');

    const win = await launch(userData);
    // Query the real main-process boundary, not a fixture or a renderer mock. A fallback catalog
    // must fail this live-runtime check even if it happens to contain the model we select below.
    const result = await win.evaluate(({ harness, projectRoot }) => window.harness.invoke('harness:models', { harness, projectRoot }), { harness, projectRoot: project });
    expect(result.error).toBeUndefined();
    expect(result.models.length).toBeGreaterThan(0);
    const expected = result.models.map((m) => `${m.provider}/${m.id}`).sort();

    await openNewSession(win);
    await pickHarness(win, name);
    const picker = win.locator('.ns-col-model .model-picker');
    await expect.poll(async () => picker.locator('.mp-row .mp-name').evaluateAll((els) => els.map((el) => el.getAttribute('title')).sort()), { timeout: 60_000 }).toEqual(expected);
    // The dialog makes its own discovery request: it must not silently display a fallback either.
    expect(await picker.locator('.menu-empty').count()).toBe(0);

    const picked = expected[expected.length - 1]!;
    await pickModel(win, picked);
    await expect.poll(async () => picker.locator('.mp-row.active .mp-name').getAttribute('title'), { timeout: 10_000 }).toBe(picked);
    expect(await picker.locator('.mp-row.active').count()).toBe(1);
  }, 180_000);

  it('offers a configured provider model for the Codex harness', async () => {
    // A codex session cannot reach OpenRouter on its own; the dialog catalog has to merge the
    // provider the user configured in Settings, and the adapter registers it on start (covered
    // offline in codex-provider.test.ts). Here the user-visible outcome is the picker entry.
    const tmp = path.join(os.tmpdir(), `vocs-code-codex-models-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# codex models e2e\n');
    await fs.writeFile(
      path.join(userData, 'settings.json'),
      seedSettings(project, {
        providers: [{ id: 'openrouter', enabled: true, models: [{ id: 'z-ai/glm-4.6', provider: 'openrouter', displayName: 'GLM 4.6', supportsImages: false }] }]
      }),
      'utf8'
    );
    await fs.mkdir(shots, { recursive: true });

    const win = await launch(userData);
    await openNewSession(win);
    await pickHarness(win, /^Codex \(app-server\)$/);
    await pickModel(win, 'openrouter/z-ai/glm-4.6');

    const picker = win.locator('.ns-col-model .model-picker');
    await expect.poll(async () => picker.locator('.mp-row.active .mp-name[title="openrouter/z-ai/glm-4.6"]').count(), { timeout: 10_000 }).toBe(1);
    await win.screenshot({ path: path.join(shots, 'models-02-codex-openrouter.png') });
  }, 180_000);

  it('offers an Anthropic-compatible provider\u2019s models to the Claude harness', async () => {
    // Claude Code only speaks the Anthropic API: a mapped vendor (OpenRouter, DeepSeek) or an added
    // Anthropic-compatible gateway has to appear in the new-session dialog for the Claude harness.
    const tmp = path.join(os.tmpdir(), `vocs-code-claude-models-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# claude models e2e\n');
    await fs.mkdir(shots, { recursive: true });

    const gateway: ProviderConfig = {
      id: 'zai',
      kind: 'anthropic',
      name: 'Z.AI (GLM)',
      baseUrl: 'https://api.z.ai/api/anthropic',
      hasApiKey: false,
      models: [{ id: 'glm-4.6', provider: 'zai', displayName: 'GLM-4.6' }],
      enabled: true
    };
    const openrouter: ProviderConfig = {
      id: 'openrouter',
      kind: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      hasApiKey: false,
      models: [{ id: 'z-ai/glm-4.6', provider: 'openrouter', displayName: 'GLM 4.6' }],
      enabled: true
    };
    await fs.writeFile(
      path.join(userData, 'settings.json'),
      seedSettings(project, { providers: [gateway, openrouter], claude: { runtime: 'bundled', useProviderKey: false, settingSources: [] } }),
      'utf8'
    );

    const win = await launch(userData);
    await openNewSession(win);
    await pickHarness(win, /^Claude Agent SDK$/);
    const picker = win.locator('.ns-col-model .model-picker');
    await picker.locator('.mp-row').first().waitFor({ timeout: 60_000 });
    // The bundled runtime's own catalog (Agent SDK 0.3.285 reports Opus 5.5 as `claude-opus-5-5`;
    // 0.3.280 reported `claude-opus-5-5[1m]`).
    await expect.poll(async () => picker.locator('.mp-name[title="anthropic/claude-opus-5-5"]').count(), { timeout: 20_000 }).toBe(1);
    await expect.poll(async () => picker.locator('.mp-row:has(.mp-name[title="anthropic/claude-opus-5-5"])').innerText(), { timeout: 20_000 }).toContain('Opus 5.5');
    await expect.poll(async () => picker.locator('.mp-name[title="zai/glm-4.6"]').count(), { timeout: 20_000 }).toBe(1);
    await expect.poll(async () => picker.locator('.mp-name[title="openrouter/z-ai/glm-4.6"]').count(), { timeout: 20_000 }).toBe(1);

    // SDK aliases and the recommended default can resolve to the same explicit choice; every
    // selectable provider/id must appear once.
    const catalogIds = await picker.locator('.mp-row .mp-name').evaluateAll((els) => els.map((el) => el.getAttribute('title')));
    expect(catalogIds).not.toContain(null);
    expect(new Set(catalogIds).size).toBe(catalogIds.length);

    // Claude's recommendation opens selected under the concrete id it resolves to, so a session
    // started without touching the picker is pinned to a version, never the moving `default` alias.
    expect(catalogIds).not.toContain('anthropic/default');
    const activeIds = () => picker.locator('.mp-row.active .mp-name').evaluateAll((els) => els.map((el) => el.getAttribute('title')));
    await expect.poll(activeIds, { timeout: 10_000 }).toEqual([expect.stringMatching(/^anthropic\/claude-/)]);
    expect(await picker.locator('.mp-row.active').innerText()).toContain('(recommended)');

    // Any other advertised Claude model is selectable under its explicit id, not only today's
    // recommendation. Read from the catalog, so the step keeps testing a switch whatever ids the
    // next runtime reports.
    const [recommended] = await activeIds();
    const other = catalogIds.find((id) => id?.startsWith('anthropic/claude-') && id !== recommended);
    expect(other, 'the runtime lists a second Claude model').toBeTruthy();
    await pickModel(win, other!);
    await expect.poll(activeIds, { timeout: 10_000 }).toEqual([other]);

    // The dialog starts on a listed model only: the composer accepts a typed custom id after start,
    // but here the search must not offer one, so it can never leak into a new session's config.
    await picker.locator('.mp-search input').fill('acme-custom-1');
    await picker.locator('.mp-clear').waitFor({ timeout: 10_000 });
    expect(await picker.getByRole('button', { name: 'Use “acme-custom-1”' }).count()).toBe(0);
    await picker.locator('.mp-clear').click();

    await pickModel(win, 'openrouter/z-ai/glm-4.6');

    await expect.poll(async () => picker.locator('.mp-row.active .mp-name[title="openrouter/z-ai/glm-4.6"]').count(), { timeout: 10_000 }).toBe(1);
    await win.screenshot({ path: path.join(shots, 'models-03-claude-providers.png') });
  }, 180_000);

  it('disables reasoning effort for a Claude model the runtime lists without it', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-claude-effort-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# claude effort e2e\n');
    await fs.mkdir(shots, { recursive: true });
    await fs.writeFile(
      path.join(userData, 'settings.json'),
      seedSettings(project, { providers: [], defaultEffort: 'high', claude: { runtime: 'bundled', useProviderKey: false, settingSources: [] } }),
      'utf8'
    );

    const win = await launch(userData);
    // Which models take effort is the runtime's answer (Haiku 4.5 takes none today), so read it the
    // way the dialog does instead of hard-coding a model.
    const { models } = await win.evaluate(({ projectRoot }) => window.harness.invoke('harness:models', { harness: 'claude', projectRoot }), { projectRoot: project });
    const withEffort = models.find((m) => m.provider === 'anthropic' && m.supportedEfforts?.length);
    const without = models.find((m) => m.provider === 'anthropic' && m.supportedEfforts?.length === 0);
    expect(withEffort, 'the runtime lists a Claude model that takes effort').toBeDefined();
    expect(without, 'the runtime lists a Claude model that takes none').toBeDefined();

    await openNewSession(win);
    await pickHarness(win, /^Claude Agent SDK$/);
    const effort = win.locator('.ns-col-model .field', { has: win.locator('.field-label', { hasText: /^Reasoning effort$/ }) }).locator('select');
    await pickModel(win, `anthropic/${withEffort!.id}`);
    await expect.poll(() => effort.isEnabled(), { timeout: 10_000 }).toBe(true);
    expect(await effort.locator('option').evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value))).toEqual(['', ...withEffort!.supportedEfforts!]);

    await pickModel(win, `anthropic/${without!.id}`);
    await expect.poll(() => effort.isDisabled(), { timeout: 10_000 }).toBe(true);
    expect(await effort.locator('option').allInnerTexts()).toEqual(['Not supported']);

    // Started without a prompt, so no harness process exists; the composer's run controls read the same catalog.
    await win.getByRole('button', { name: /Start session/ }).click();
    const controls = win.locator('.composer .run-controls');
    const modelPill = controls.getByRole('button', { name: /^Model:/ });
    await modelPill.click();
    const effortGroup = controls.getByRole('menu').getByRole('group', { name: 'Reasoning Effort', exact: true });
    await effortGroup.getByText(/does not support reasoning effort/).waitFor({ timeout: 60_000 });
    expect(await effortGroup.getByRole('menuitemradio').count()).toBe(0);
    expect(await effortGroup.getByRole('menuitem').count()).toBe(0);
    expect(await modelPill.getAttribute('aria-label')).not.toContain('Effort:');
    const sessions = await win.evaluate(() => window.harness.invoke('sessions:list', undefined));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].config.effort).toBeNull();
    expect((await win.evaluate(() => window.harness.invoke('settings:get', undefined))).defaultEffort).toBe('high');
    const saved = JSON.parse(await fs.readFile(path.join(userData, 'sessions.json'), 'utf8')) as SessionMeta[];
    expect(saved).toHaveLength(1);
    expect(saved[0].config.effort).toBeNull();
    await win.screenshot({ path: path.join(shots, 'models-04-claude-no-effort.png') });
  }, 180_000);

  it('offers a DeepSeek model the three tiers its API serves, including max', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-deepseek-effort-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# deepseek effort e2e\n');
    await fs.mkdir(shots, { recursive: true });
    const deepseek: ProviderConfig = { id: 'deepseek', kind: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', hasApiKey: false, models: [], enabled: true };
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, { providers: [deepseek], defaultEffort: 'high' }), 'utf8');

    const win = await launch(userData);
    await openNewSession(win);
    await pickHarness(win, /^Native loop$/);
    const effort = win.locator('.ns-col-model .field', { has: win.locator('.field-label', { hasText: /^Reasoning effort$/ }) }).locator('select');
    await pickModel(win, 'deepseek/deepseek-flash');
    // low/high/max are DeepSeek's scalar efforts 50/75/100; minimal and medium/xhigh are only
    // aliases onto them, so listing the aliases both hid `max` and made one tier look like three.
    await expect.poll(() => effort.isEnabled(), { timeout: 10_000 }).toBe(true);
    expect(await effort.locator('option').evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value))).toEqual(['', 'low', 'high', 'max']);
    await win.screenshot({ path: path.join(shots, 'models-05-deepseek-effort.png') });
  }, 180_000);
});

describe.runIf(enabled)('first-run setup through real desktop boundaries', () => {
  it('offers clean-profile Claude/ChatGPT sign-in without demanding API keys, and resumes after dismissal or restart', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-onboarding-subscriptions-'));
    const userData = path.join(tmp, 'userData'), project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true }); await fs.mkdir(project, { recursive: true }); await fs.mkdir(shots, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, { onboardingDone: false, theme: 'light', claude: { runtime: 'bundled', useProviderKey: false, settingSources: [] }, codex: { runtime: 'bundled' }, agent: { enabled: false } }));
    let win = await launch(userData);
    const errors: string[] = []; win.on('pageerror', (error) => errors.push(error.message));
    let guide = win.getByRole('dialog', { name: 'Welcome to Vocs Code', exact: true });
    await guide.waitFor();
    expect(await guide.getByRole('button', { name: 'Next', exact: true }).isDisabled()).toBe(true);
    await win.setViewportSize({ width: 960, height: 800 });
    await win.screenshot({ path: path.join(shots, 'onboarding-01-agent-choice.png') });
    await win.setViewportSize({ width: 480, height: 800 });
    expect(await guide.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.querySelector('.modal-body')!.scrollWidth <= el.querySelector('.modal-body')!.clientWidth + 1)).toBe(true);
    await win.screenshot({ path: path.join(shots, 'onboarding-02-compact.png') });
    await win.setViewportSize({ width: 960, height: 800 });
    for (const item of [{ name: /^Claude Agent SDK/, signIn: 'Sign in with Claude' }, { name: /^Codex \(app-server\)/, signIn: 'Sign in with ChatGPT' }]) {
      await guide.getByRole('button', { name: item.name }).click();
      await guide.getByRole('button', { name: 'Next', exact: true }).click();
      await guide.getByRole('button', { name: item.signIn, exact: true }).waitFor({ timeout: 60_000 });
      expect(await guide.locator('input[type="password"]').count()).toBe(0);
      expect(await guide.getByText(/an API key is not required for that route/).isVisible()).toBe(true);
      expect(await guide.getByRole('button', { name: 'Next', exact: true }).isDisabled()).toBe(true);
      expect(await guide.locator('.setup-checks .badge').innerText()).toMatch(/Sign-in needed|Sign-in not verified/);
      expect(await guide.getByRole('button', { name: /^Install / }).count()).toBe(0);
      if (item.signIn === 'Sign in with ChatGPT') {
        expect(await guide.getByRole('button', { name: 'Use device sign-in' }).isVisible()).toBe(true);
        await win.screenshot({ path: path.join(shots, 'onboarding-03-subscription.png') });
      }
      await win.setViewportSize({ width: 480, height: 800 });
      expect(await guide.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.querySelector('.modal-body')!.scrollWidth <= el.querySelector('.modal-body')!.clientWidth + 1)).toBe(true);
      if (item.signIn === 'Sign in with ChatGPT') await win.screenshot({ path: path.join(shots, 'onboarding-06-compact-connection.png') });
      await win.setViewportSize({ width: 960, height: 800 });
      await guide.getByRole('button', { name: 'Back', exact: true }).click();
    }
    // Do not launch an external OAuth flow or borrow any real account in this offline suite.
    await guide.getByRole('button', { name: 'Close', exact: true }).click();
    expect((await win.evaluate(() => window.harness.invoke('settings:get', undefined))).onboardingDone).toBe(false);
    await win.locator('.main-empty').getByRole('button', { name: 'Setup guide', exact: true }).click();
    await guide.waitFor(); await guide.getByRole('button', { name: 'Skip setup', exact: true }).click();
    await guide.waitFor({ state: 'hidden' });
    expect((await win.evaluate(() => window.harness.invoke('settings:get', undefined))).onboardingDone).toBe(true);
    expect(await win.evaluate(() => window.harness.invoke('sessions:list', undefined))).toEqual([]);
    expect(errors).toEqual([]);
    await apps[apps.length - 1]!.close();
    win = await launch(userData);
    await win.locator('.main-empty').waitFor();
    guide = win.getByRole('dialog', { name: 'Welcome to Vocs Code', exact: true });
    expect(await guide.count()).toBe(0);
    await win.locator('.main-empty').getByRole('button', { name: 'Settings', exact: true }).click();
    await win.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Harnesses', exact: true }).click();
    await win.getByRole('button', { name: 'Set up Codex (app-server)', exact: true }).click();
    await guide.getByRole('heading', { name: 'Connect Codex (app-server)', exact: true }).waitFor();
    await guide.getByRole('button', { name: 'Close', exact: true }).click();
    await apps[apps.length - 1]!.close();
  }, 180_000);

  it('opens Google Antigravity sign-in and quota from Settings and saves an idle Antigravity session', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-onboarding-antigravity-'));
    const userData = path.join(tmp, 'userData'), project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, { defaultHarness: 'pi', agent: { enabled: false } }));
    const win = await launch(userData);
    const app = apps[apps.length - 1]!;
    try {
      // Keep the production preload, setup UI, model picker and session persistence. Script the
      // vendor boundaries so neither installation, OAuth nor quota traffic leaves the machine.
      await app.evaluate(({ ipcMain }, installUrl) => {
        const fixture: AntigravitySetupFixture = { state: 'missing', openedUrls: [], signIns: [], quotaChecks: 0, modelLists: 0, sends: 0 };
        (globalThis as AntigravityFixtureGlobal).__vocsAntigravitySetupFixture = fixture;
        for (const channel of ['harness:setup', 'harness:login', 'harness:antigravityQuota', 'harness:models', 'app:openExternal', 'sessions:send']) ipcMain.removeHandler(channel);
        // The account's catalog as the CLI's session config options report it (see harness-readiness.test.ts).
        ipcMain.handle('harness:models', (_event, request: { harness: string }) => {
          if (request.harness !== 'antigravity') return { models: [], error: 'Only Antigravity is configured in this fixture' };
          fixture.modelLists++;
          return { models: [
            { id: 'gemini-4-neon', provider: 'antigravity', displayName: 'Gemini 4 Neon', supportedEfforts: ['low', 'medium', 'high', 'xhigh'], isDefault: true },
            { id: 'gemini-4-argon', provider: 'antigravity', displayName: 'Gemini 4 Argon', supportedEfforts: ['low', 'medium', 'high', 'xhigh'], isDefault: false },
            { id: 'gemini-3.8-flash', provider: 'antigravity', displayName: 'Gemini 3.8 Flash', supportedEfforts: ['low', 'medium', 'high', 'xhigh'], isDefault: false }
          ] };
        });
        ipcMain.handle('harness:setup', (_event, request: { harness: string }): HarnessSetupStatus => {
          if (request.harness !== 'antigravity') throw new Error('Expected Antigravity setup');
          const available = fixture.state !== 'missing';
          const authenticated = fixture.state === 'signed-in';
          return {
            harness: 'antigravity',
            availability: {
              available, authenticated,
              detail: authenticated ? 'Google sign-in detected.' : available ? 'Antigravity CLI is installed.' : 'Antigravity CLI is missing.'
            },
            providers: [],
            requirements: [{ id: 'runtime', name: 'Antigravity CLI', available, detail: 'Install the official Antigravity CLI.', url: installUrl }],
            canInstall: false,
            loginId: 'antigravity'
          };
        });
        ipcMain.handle('app:openExternal', (_event, request: { url: string }) => { fixture.openedUrls.push(request.url); });
        ipcMain.handle('harness:login', (_event, request: unknown) => { fixture.signIns.push(request); return { ok: true }; });
        ipcMain.handle('harness:antigravityQuota', () => {
          fixture.quotaChecks++;
          if (fixture.state !== 'signed-in') throw new Error('Quota requires sign-in');
          return { groups: [{ name: 'Gemini models', buckets: [{ name: 'Gemini 3 Pro', remainingFraction: 0.726 }] }] };
        });
        ipcMain.handle('sessions:send', () => { fixture.sends++; throw new Error('No prompts may be sent in this fixture'); });
      }, ANTIGRAVITY_INSTALL_URL);
      const setVendorState = (state: AntigravitySetupFixture['state']) => app.evaluate((_electron, value) => {
        (globalThis as AntigravityFixtureGlobal).__vocsAntigravitySetupFixture.state = value;
      }, state);

      await win.locator('.main-empty').getByRole('button', { name: 'Settings', exact: true }).click();
      await win.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Providers & keys', exact: true }).click();
      await win.locator('#providers-logins').getByRole('button', { name: 'Sign in to Google Antigravity', exact: true }).click();
      const guide = win.getByRole('dialog', { name: 'Welcome to Vocs Code', exact: true });
      await guide.getByRole('heading', { name: 'Connect Google Antigravity', exact: true }).waitFor();
      await guide.getByRole('button', { name: 'Get Antigravity CLI', exact: true }).click();

      await setVendorState('signed-out');
      const recheck = guide.getByRole('button', { name: 'Recheck setup', exact: true });
      await recheck.click();
      const signIn = guide.getByRole('button', { name: 'Sign in with Google', exact: true });
      const checkQuota = guide.getByRole('button', { name: 'Check Antigravity quota', exact: true });
      await signIn.click();
      await guide.getByText('Recheck sign-in', { exact: true }).waitFor();
      expect(await checkQuota.isVisible() && await checkQuota.isEnabled()).toBe(false);

      await setVendorState('signed-in');
      await recheck.click();
      await guide.getByText('Google sign-in detected.', { exact: true }).waitFor();
      expect(await guide.locator('input[type="password"]').count()).toBe(0);
      await checkQuota.click();
      const quota = guide.locator('[aria-label="Antigravity account quota"]');
      await quota.getByText('Gemini models', { exact: true }).waitFor();
      await quota.getByRole('listitem').filter({ hasText: 'Gemini 3 Pro' }).getByText('73% remaining', { exact: true }).waitFor();
      const next = guide.getByRole('button', { name: 'Next', exact: true });
      await next.click();
      await guide.getByText(/default Gemini model/).waitFor();
      expect(await next.isEnabled()).toBe(true);
      await guide.getByRole('button', { name: 'Close', exact: true }).click();
      await guide.waitFor({ state: 'hidden' });

      await win.getByRole('button', { name: 'Back to workspace', exact: true }).click();
      await openNewSession(win);
      await pickHarness(win, /^Google Antigravity$/);
      // The Gemini models are offered before the session starts, not only after it connects.
      const picker = win.locator('.ns-col-model .model-picker');
      await expect.poll(async () => picker.locator('.mp-row .mp-name').evaluateAll((els) => els.map((el) => el.getAttribute('title')).sort()), { timeout: 30_000 })
        .toEqual(['antigravity/gemini-3.8-flash', 'antigravity/gemini-4-argon', 'antigravity/gemini-4-neon']);
      await pickModel(win, 'antigravity/gemini-4-argon');
      await win.getByRole('button', { name: /Start session/ }).click();
      await win.locator('.composer').waitFor();
      const sessions = JSON.parse(await fs.readFile(path.join(userData, 'sessions.json'), 'utf8')) as SessionMeta[];
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ config: { harness: 'antigravity' }, status: 'idle', usage: { turns: 0 } });
      expect(sessions[0].harnessRef).toEqual({});
      expect(sessions[0].config.model).toEqual({ provider: 'antigravity', model: 'gemini-4-argon' });
      const calls = await app.evaluate(() => (globalThis as AntigravityFixtureGlobal).__vocsAntigravitySetupFixture);
      expect(calls).toMatchObject({ state: 'signed-in', openedUrls: [ANTIGRAVITY_INSTALL_URL], signIns: [{ harness: 'antigravity' }], quotaChecks: 1, sends: 0 });
      expect(calls.modelLists).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  }, 120_000);

  it.each([{ id: 'lmstudio', name: 'LM Studio', api: false }, { id: 'openai', name: 'OpenAI', api: true }])('recovers the $name catalog, persists setup across restart and preserves a session draft', async ({ id, name, api }) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-onboarding-local-'));
    const userData = path.join(tmp, 'userData'), project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true }); await fs.mkdir(project, { recursive: true }); await fs.mkdir(shots, { recursive: true });
    let failCatalog = true;
    const requests: string[] = [], authorization: (string | undefined)[] = [];
    const fixtureKey = 'sk-onboarding-fixture-not-a-real-key';
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`); authorization.push(req.headers.authorization);
      res.writeHead(req.url !== '/v1/models' ? 404 : failCatalog ? 503 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(failCatalog ? { error: 'fixture server not ready' } : { data: [{ id: 'fixture-chat' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    try {
      await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, { onboardingDone: false, theme: 'dark', providers: [{ id, kind: id, name, baseUrl: endpoint, enabled: true, models: [] }], agent: { enabled: false } }));
      let win = await launch(userData);
      const errors: string[] = []; win.on('pageerror', (error) => errors.push(error.message));
      const guide = win.getByRole('dialog', { name: 'Welcome to Vocs Code', exact: true });
      await guide.getByRole('button', { name: /^Native loop/ }).click();
      await guide.getByRole('button', { name: 'Next', exact: true }).click();
      await guide.locator('.setup-provider select').selectOption(id);
      if (api) {
        const input = guide.locator('input[type="password"]');
        await input.fill(fixtureKey);
        const fallback = guide.getByRole('checkbox', { name: 'I understand and want to save a key on this machine', exact: true });
        if (await fallback.isVisible()) await fallback.check();
        await guide.getByRole('button', { name: 'Save key', exact: true }).click();
        await guide.getByText('Key saved', { exact: true }).waitFor();
        expect(await input.inputValue()).toBe('');
      }
      const next = guide.getByRole('button', { name: 'Next', exact: true });
      await expect.poll(() => next.isEnabled(), { timeout: 60_000 }).toBe(true);
      await next.click();
      await guide.getByRole('alert').filter({ hasText: 'Catalog check failed' }).waitFor();
      expect(await next.isDisabled()).toBe(true);
      await win.screenshot({ path: path.join(shots, 'onboarding-04-catalog-recovery.png') });
      failCatalog = false;
      await guide.getByRole('button', { name: 'Recheck models', exact: true }).click();
      const choice = guide.locator(`.mp-row:has(.mp-name[title="${id}/fixture-chat"]) .mp-select`);
      await choice.click();
      expect(await next.isEnabled()).toBe(true);
      await next.click(); await next.click();
      await guide.getByRole('heading', { name: 'Your choices are configured' }).waitFor();
      await win.screenshot({ path: path.join(shots, 'onboarding-05-summary.png') });
      await win.setViewportSize({ width: 480, height: 800 });
      expect(await guide.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.querySelector('.modal-body')!.scrollWidth <= el.querySelector('.modal-body')!.clientWidth + 1)).toBe(true);
      await win.screenshot({ path: path.join(shots, 'onboarding-07-compact-summary.png') });
      await win.setViewportSize({ width: 960, height: 800 });
      await guide.getByRole('button', { name: 'Finish setup', exact: true }).click();
      await guide.waitFor({ state: 'hidden' });
      const saved = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8'));
      expect(saved.defaultHarness).toBe('native');
      expect(saved.defaultModelByHarness.native).toEqual({ provider: id, model: 'fixture-chat' });
      expect(JSON.stringify(saved)).not.toContain(fixtureKey);
      expect(saved.onboardingDone).toBe(true);
      expect(errors).toEqual([]);
      await apps[apps.length - 1]!.close();
      win = await launch(userData);
      await openNewSession(win);
      expect(await win.locator('.harness-card.active').innerText()).toContain('Native loop');
      await expect.poll(() => win.locator('.mp-row.active .mp-name').getAttribute('title'), { timeout: 30_000 }).toBe(`${id}/fixture-chat`);
      // The longest status a card can show must stay inside its own column, not slide under the model picker.
      const cards = win.locator('.harness-card');
      await expect.poll(() => win.locator('.harness-card .badge').count(), { timeout: 30_000 }).toBe(await cards.count());
      expect(await win.locator('.ns-grid').evaluate((grid) => {
        for (const badge of grid.querySelectorAll('.harness-card .badge')) badge.textContent = 'Subscription sign-in detected';
        const col = grid.querySelector('.ns-col')!.getBoundingClientRect();
        // Every card is one name line over one status line, however long either text is.
        const oneLine = (el: Element | null) => !!el && el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).fontSize) * 1.6;
        const cards = [...grid.querySelectorAll<HTMLElement>('.harness-card')];
        const heights = new Set(cards.map((card) => Math.round(card.getBoundingClientRect().height)));
        return cards.filter((card) => {
          const r = card.getBoundingClientRect();
          return r.left < col.left - 1 || r.right > col.right + 1 || card.scrollWidth > card.clientWidth + 1
            || !oneLine(card.querySelector('.harness-card-name')) || !oneLine(card.querySelector('.harness-card .badge'));
        }).length + (heights.size === 1 ? 0 : 100);
      })).toBe(0);
      const setupButton = win.getByRole('button', { name: 'Set up / sign in', exact: true });
      // A ready harness with a catalog hides the setup entry point.
      expect(await setupButton.count()).toBe(0);
      const prompt = win.getByPlaceholder('What should the agent do?');
      await prompt.fill('Keep this unsent draft while I check setup');
      // Settings normalization restores omitted built-ins. Disable those too so the fixture
      // genuinely has no models, rather than retaining another provider's static catalog.
      await win.evaluate(async () => {
        const settings = await window.harness.invoke('settings:get', undefined);
        await window.harness.invoke('settings:update', { providers: settings.providers.map((p) => ({ ...p, enabled: false })) });
      });
      expect((await win.evaluate((projectRoot) => window.harness.invoke('harness:models', { harness: 'native', projectRoot }), project)).models).toEqual([]);
      await win.getByRole('button', { name: 'Recheck models and sign-in', exact: true }).click();
      await setupButton.click();
      const recovery = win.getByRole('dialog', { name: 'Welcome to Vocs Code', exact: true });
      await recovery.getByRole('heading', { name: 'Connect Native loop', exact: true }).waitFor();
      await expect.poll(() => recovery.locator('.setup-provider select').inputValue()).toBe(id);
      if (api) { await recovery.getByText('Key saved', { exact: true }).waitFor(); expect(await recovery.locator('input[type="password"]').inputValue()).toBe(''); }
      await win.keyboard.press('Escape');
      await recovery.waitFor({ state: 'hidden' });
      expect(await prompt.inputValue()).toBe('Keep this unsent draft while I check setup');
      expect(await win.getByRole('button', { name: /Start session/ }).isVisible()).toBe(true);
      expect(await win.evaluate(() => window.harness.invoke('sessions:list', undefined))).toEqual([]);
      // The OpenAI-wire client retries the first 503 once (maxRetries: 1), then the explicit
      // recheck succeeds. Reopening/closing setup and restarting must not add requests or turns.
      expect(requests).toEqual(['GET /v1/models', 'GET /v1/models', 'GET /v1/models']);
      if (api) expect(authorization).toEqual(Array(3).fill(`Bearer ${fixtureKey}`));
      await apps[apps.length - 1]!.close();
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, 180_000);
});
