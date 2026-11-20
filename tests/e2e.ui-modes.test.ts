/**
 * Electron end-to-end for the interface modes (Settings → Appearance → Interface): Standard and the
 * two minimalist layouts, Zen and Paper. It switches live through all three ways in (the Appearance
 * picker, the command palette and the minimalist title bar's one-button menu) and checks that
 * - each mode really re-lays the window out: Zen's sidebar is a 52px rail that opens over the
 *   conversation on hover and its side panel a floating drawer; Paper has no sidebar at all (the
 *   title drops a session switcher), sets the page in a serif and docks the side panel as a sheet
 *   along the bottom; Standard comes back exactly;
 * - nothing is lost on a switch: the open session, its unsent draft and the open side panel stay;
 * - each layout still works: a rail dot and a switcher row each open their session (a row never
 *   starts a rename), the switcher closes on a pick, Escape or a click outside, and Zen's composer
 *   controls wait for the pointer;
 * - the choice survives a restart.
 * Sessions, transcripts and a git checkout are seeded on disk, so no harness or provider key is
 * involved. Review screenshots land in tests/artifacts/ui-modes-*.png.
 * Requires `npm run build` first; gated by VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';
import { expectQuietWindow, isolatedEnv, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
let app: ElectronApplication | null = null;
let page: Page | null = null;

afterEach(async ({ task }) => {
  // On failure, keep the window as it was for diagnosis; a passing run leaves only the review shots.
  if (task.result?.state === 'fail' && page) {
    await fs.mkdir(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, 'e2e-fail-ui-modes.png') }).catch(() => undefined);
  }
  await app?.close().catch(() => undefined);
  app = null;
  page = null;
});

const FIRST = 's_modes_first';
const SECOND = 's_modes_second';
const T = Date.now() - 600_000;
const DRAFT = 'A draft that has to survive every switch';
const FIRST_TITLE = 'Add rate limiting to the public API';
const SECOND_TITLE = 'Fix flaky auth refresh test';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function seedProject(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'server.ts'), 'export const port = 3000;\n');
  git(dir, 'init', '-q', '-b', 'main');
  // A throwaway fixture: commit under a local identity, whatever the machine has configured.
  git(dir, 'config', 'user.name', 'e2e');
  git(dir, 'config', 'user.email', 'e2e@example.invalid');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  await fs.writeFile(path.join(dir, 'src', 'server.ts'), 'export const port = 3000;\nexport const limit = 100;\n');
}

function transcript(): TranscriptItem[] {
  return [
    { id: 'u1', kind: 'user', ts: T, text: 'Add rate limiting to the public API.' },
    { id: 't1', kind: 'tool', ts: T + 1, name: 'Edit', hint: 'edit', summary: 'src/server.ts', status: 'done', changes: [{ path: 'src/server.ts', kind: 'update', diff: '--- a/src/server.ts\n+++ b/src/server.ts\n@@ -1 +1,2 @@\n export const port = 3000;\n+export const limit = 100;' }] },
    { id: 't2', kind: 'tool', ts: T + 2, name: 'shell', hint: 'execute', summary: 'npm test', status: 'done', exitCode: 0, durationMs: 4200, output: '6 passed' },
    { id: 'f1', kind: 'assistant', ts: T + 3, text: 'Rate limiting is in place on every `/v1` route.', phase: 'final' },
    { id: 'turn1', kind: 'turn', ts: T + 4, status: 'completed', durationMs: 154_000, costUsd: 0.61, usage: { inputTokens: 48_200, outputTokens: 6_100 } }
  ];
}

const usage = (): SessionMeta['usage'] => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 });

async function seed(tmp: string, uiMode?: string): Promise<{ userData: string; project: string }> {
  const userData = path.join(tmp, 'userData');
  const project = path.join(tmp, 'project');
  await fs.mkdir(userData, { recursive: true });
  await seedProject(project);
  await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, { theme: 'dark', windowBounds: { width: 1280, height: 860 }, ...(uiMode ? { uiMode } : {}) }));
  const sessions: SessionMeta[] = [
    { id: FIRST, title: FIRST_TITLE, createdAt: T, updatedAt: T + 10, lastUserMessageAt: T, config: { harness: 'claude', projectRoot: project, permissionMode: 'accept-edits', model: { provider: 'anthropic', model: 'claude-opus-5-5' } }, cwd: project, status: 'idle', harnessRef: {}, usage: usage() },
    { id: SECOND, title: SECOND_TITLE, createdAt: T - 1000, updatedAt: T - 1000, lastUserMessageAt: T - 1000, config: { harness: 'native', projectRoot: project, permissionMode: 'ask' }, cwd: project, status: 'idle', harnessRef: {}, usage: usage() }
  ];
  await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify(sessions));
  for (const s of sessions) {
    await fs.mkdir(path.join(userData, 'sessions', s.id), { recursive: true });
    const items = s.id === FIRST ? transcript() : [{ id: 'u1', kind: 'user', ts: T - 1000, text: s.title } as TranscriptItem];
    await fs.writeFile(path.join(userData, 'sessions', s.id, 'transcript.jsonl'), items.map((i) => JSON.stringify(i)).join('\n') + '\n');
  }
  return { userData, project };
}

async function launch(userData: string): Promise<Page> {
  const home = path.join(userData, 'home');
  const env = isolatedEnv(userData, {
    HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: path.join(userData, 'claude'), CODEX_HOME: path.join(userData, 'codex'), PI_CODING_AGENT_DIR: path.join(userData, 'pi')
  });
  for (const key of ['ELECTRON_RENDERER_URL', 'ANTHROPIC_AUTH_TOKEN', 'CODEX_API_KEY', 'CURSOR_API_KEY', 'GOOGLE_API_KEY']) delete env[key];
  for (const dir of [env.APPDATA, env.LOCALAPPDATA, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, env.PI_CODING_AGENT_DIR]) await fs.mkdir(dir, { recursive: true });
  app = await electron.launch({
    executablePath: require('electron') as string,
    // No real credentials: keep the isolated fixture off the macOS login Keychain.
    args: [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`, ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : [])],
    env,
    timeout: 60_000
  });
  const win = await app.firstWindow();
  // The booted shell, not the sidebar's wordmark: Paper boots with no sidebar on screen.
  await win.waitForSelector('.shell > .app', { timeout: 60_000 });
  await expectQuietWindow(app);
  // A window cannot outgrow its screen and CI displays are small: pin the page, not the window.
  await win.setViewportSize({ width: 1280, height: 860 });
  page = win;
  return win;
}

const uiMode = (win: Page) => win.evaluate(() => document.documentElement.getAttribute('data-ui'));
const rect = (win: Page, selector: string) => win.locator(selector).first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
});
const style = (win: Page, selector: string, prop: string) => win.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
const draft = (win: Page) => win.locator('.pane.active .composer textarea').inputValue();
const activeRow = (win: Page) => win.locator('.sidebar .session-row.active').getAttribute('data-session-id');
/** The session the title bar names: Paper's only on-screen trace of which session is open. */
const activeTitle = (win: Page) => win.locator('.titlebar-search-text').innerText();
const switcherShown = (win: Page) => win.locator('.sidebar').count();
/** Far from the sidebar, the composer and the header, so no hover state leaks into an assertion. */
const park = (win: Page) => win.mouse.move(640, 300);

/** Clicks a session's dot in Zen's rail: the one part of the row the closed rail shows. */
async function clickDot(win: Page, id: string): Promise<void> {
  const dot = await win.locator(`[data-session-id="${id}"] .session-pin`).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await win.mouse.click(dot.x, dot.y);
}

async function shot(win: Page, name: string): Promise<void> {
  await park(win);
  await win.waitForTimeout(400);
  await fs.mkdir(shots, { recursive: true });
  await win.screenshot({ path: path.join(shots, `ui-modes-${name}.png`) });
}

describe.runIf(enabled)('electron e2e: interface modes', () => {
  it('switches Standard → Zen → Paper → Standard live, re-laying the window out without losing the session, its draft or the panel', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-ui-modes-'));
    const { userData } = await seed(tmp);
    const win = await launch(userData);
    expect(await uiMode(win)).toBe('standard');

    // Standard: open the first session, leave a draft, keep the side panel open.
    await win.locator(`[data-session-id="${FIRST}"]`).click();
    await win.locator('.work-head').waitFor({ timeout: 30_000 });
    if (!(await win.locator('.panel').count())) await win.keyboard.press('Control+j');
    await win.locator('.panel').waitFor();
    await win.locator('.pane.active .composer textarea').fill(DRAFT);
    const standardSidebar = await rect(win, '.sidebar');
    expect(standardSidebar.width).toBe(280);
    expect(await style(win, '.panel', 'position')).not.toBe('fixed');
    expect(await win.getByRole('button', { name: 'File', exact: true }).count()).toBe(1);

    // Settings → Appearance → Interface → Zen.
    await win.click('.sidebar-bottom .sidebar-link:has-text("Settings")');
    await win.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click();
    const picker = win.getByRole('group', { name: 'Interface' });
    await expect.poll(() => picker.getByRole('button').evaluateAll((cards) => cards.map((c) => c.getAttribute('aria-label')))).toEqual(['Standard interface', 'Zen interface', 'Paper interface']);
    await picker.getByRole('button', { name: 'Zen interface' }).click();
    await expect.poll(() => uiMode(win)).toBe('zen');
    expect(await picker.getByRole('button', { name: 'Zen interface' }).getAttribute('aria-pressed')).toBe('true');
    expect((await win.evaluate(() => window.harness.invoke('settings:get', undefined))).uiMode).toBe('zen');
    await shot(win, 'zen-settings');
    await win.keyboard.press('Control+,');
    await win.locator('.pane.active .composer textarea').waitFor();

    // Zen: a 52px rail that opens over the conversation on hover, the panel as a floating drawer.
    await park(win);
    await expect.poll(() => rect(win, '.sidebar').then((r) => r.width)).toBe(52);
    expect(await style(win, '.panel', 'position')).toBe('fixed');
    expect(await activeRow(win)).toBe(FIRST);
    expect(await draft(win)).toBe(DRAFT);
    // The title bar's words fold into one menu.
    expect(await win.getByRole('button', { name: 'File', exact: true }).count()).toBe(0);
    expect(await win.getByRole('button', { name: 'Menu', exact: true }).count()).toBe(1);
    // The composer's controls wait for the pointer; Send never hides.
    const modelPill = win.locator('.pane.active .composer .pill-model');
    await expect.poll(() => modelPill.evaluate((el) => getComputedStyle(el.closest('.dropdown')!).opacity)).toBe('0');
    expect(await style(win, '.pane.active .composer .send-btn', 'opacity')).toBe('1');
    await shot(win, 'zen-session');
    await win.locator('.pane.active .composer-box').hover();
    await expect.poll(() => modelPill.evaluate((el) => getComputedStyle(el.closest('.dropdown')!).opacity)).toBe('1');
    // Hovering the rail opens it to the user's sidebar width, over the transcript: the pane does not move.
    const paneBefore = await rect(win, '.pane.active');
    await win.mouse.move(26, 420);
    await expect.poll(() => rect(win, '.sidebar').then((r) => r.width)).toBe(280);
    expect(await rect(win, '.pane.active')).toEqual(paneBefore);
    await win.waitForTimeout(300);
    await fs.mkdir(shots, { recursive: true });
    await win.screenshot({ path: path.join(shots, 'ui-modes-zen-rail-open.png') });
    // A dot in the rail opens its session, whether the rail is open or still closed.
    await clickDot(win, SECOND);
    await expect.poll(() => activeRow(win)).toBe(SECOND);
    await park(win);
    await expect.poll(() => rect(win, '.sidebar').then((r) => r.width)).toBe(52);
    await clickDot(win, FIRST);
    await expect.poll(() => activeRow(win)).toBe(FIRST);
    expect(await draft(win)).toBe(DRAFT);

    // Command palette → Paper.
    await park(win);
    await win.keyboard.press('Control+k');
    await win.locator('.palette input').fill('Paper interface');
    await win.locator('.palette-item', { hasText: 'Switch to the Paper interface' }).click();
    await expect.poll(() => uiMode(win)).toBe('paper');
    // Paper: no sidebar at all. The page takes the full width and the side panel docks below it.
    await expect.poll(() => switcherShown(win)).toBe(0);
    expect(await activeTitle(win)).toBe(FIRST_TITLE);
    const main = await rect(win, '.main');
    expect(main.x).toBe(0);
    expect(main.width).toBe(1280);
    const sheet = await rect(win, '.panel');
    expect(sheet.x).toBe(0);
    expect(sheet.width).toBe(1280);
    expect(Math.abs(sheet.y - (main.y + main.height))).toBeLessThanOrEqual(1);
    expect(await style(win, '.pane.active .msg-assistant .md', 'font-family')).toMatch(/Iowan|Charter|Palatino|Georgia|serif/);
    expect(await draft(win)).toBe(DRAFT);
    await shot(win, 'paper-session');
    // The title drops the switcher: the same sessions, one under the other, centred under the title.
    const title = win.locator('.titlebar-switch');
    await title.click();
    await win.locator('.sidebar').waitFor();
    expect(await title.getAttribute('aria-expanded')).toBe('true');
    const [a, b] = [await rect(win, `[data-session-id="${FIRST}"]`), await rect(win, `[data-session-id="${SECOND}"]`)];
    expect(a.x).toBe(b.x);
    expect(b.y).toBeGreaterThan(a.y);
    const list = await rect(win, '.sidebar');
    expect(Math.abs(list.x + list.width / 2 - 640)).toBeLessThanOrEqual(1);
    await shot(win, 'paper-switcher');
    // Picking a row opens it and closes the switcher; clicking its title never starts a rename.
    await win.locator(`[data-session-id="${SECOND}"] .session-title`).click();
    await expect.poll(() => activeTitle(win)).toBe(SECOND_TITLE);
    await expect.poll(() => switcherShown(win)).toBe(0);
    expect(await win.locator('.session-rename').count()).toBe(0);
    // Ctrl+B opens it too; Escape and a click outside close it.
    await win.keyboard.press('Control+b');
    await win.locator('.sidebar').waitFor();
    await win.keyboard.press('Escape');
    await expect.poll(() => switcherShown(win)).toBe(0);
    await title.click();
    await win.locator('.sidebar').waitFor();
    await win.mouse.click(1200, 640);
    await expect.poll(() => switcherShown(win)).toBe(0);
    await title.click();
    await win.locator(`[data-session-id="${FIRST}"]`).click();
    await expect.poll(() => activeTitle(win)).toBe(FIRST_TITLE);
    expect(await draft(win)).toBe(DRAFT);

    // The one-button menu → View → Standard interface.
    await win.getByRole('button', { name: 'Menu', exact: true }).click();
    await win.getByRole('tablist', { name: 'Menus' }).getByRole('tab', { name: 'View', exact: true }).hover();
    await shot(win, 'paper-menu').catch(() => undefined);
    await win.getByRole('button', { name: 'Standard interface', exact: true }).click();
    await expect.poll(() => uiMode(win)).toBe('standard');

    // Standard is back exactly, with the same session, draft and panel.
    await expect.poll(() => rect(win, '.sidebar')).toEqual(standardSidebar);
    expect(await style(win, '.panel', 'position')).not.toBe('fixed');
    expect(await win.getByRole('button', { name: 'File', exact: true }).count()).toBe(1);
    expect(await activeRow(win)).toBe(FIRST);
    expect(await draft(win)).toBe(DRAFT);
    expect(await win.locator('.panel').count()).toBe(1);
    expect((await win.evaluate(() => window.harness.invoke('settings:get', undefined))).uiMode).toBe('standard');
  }, 180_000);

  it('reopens in the interface it was closed in', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-ui-modes-restart-'));
    const { userData } = await seed(tmp, 'zen');
    let win = await launch(userData);
    await expect.poll(() => uiMode(win)).toBe('zen');
    await park(win);
    await expect.poll(() => rect(win, '.sidebar').then((r) => r.width)).toBe(52);
    await win.keyboard.press('Control+k');
    await win.locator('.palette input').fill('Paper interface');
    await win.locator('.palette-item', { hasText: 'Switch to the Paper interface' }).click();
    await expect.poll(() => uiMode(win)).toBe('paper');
    await app!.close();
    app = null;

    win = await launch(userData);
    await expect.poll(() => uiMode(win)).toBe('paper');
    await win.locator('.titlebar-switch').waitFor();
    expect(await switcherShown(win)).toBe(0);
    expect(JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')).uiMode).toBe('paper');
  }, 180_000);
});
