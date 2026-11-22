/**
 * Electron end-to-end for the interface modes (Settings → Appearance → Interface): Standard and the
 * minimalist Zen layout. It switches live through all three ways in (the Appearance picker, the
 * command palette and Zen's one-button title-bar menu) and checks that
 * - Zen really re-lays the window out: the sidebar is a 52px rail that opens over the conversation
 *   on hover, the side panel a floating drawer, and the menu bar one button; Standard comes back
 *   exactly;
 * - nothing is lost on a switch: the open session, its unsent draft and the open side panel stay;
 * - Zen still works: a rail dot opens its session whether the rail is open or closed, and the
 *   composer's controls wait for the pointer while Send never hides;
 * - a confirmation asked from the rail (archiving a worktree session) opens at its button, holds
 *   the rail open, and focuses the action so Enter or Space can confirm it;
 * - the side panel is one rail of icons on the right whose drawer slides out on hover or a peek and
 *   shows one view at a time, and either side pins open (the column moves aside) across a restart;
 * - the choice survives a restart;
 * - both modes make room for tables and the composer without widening prose or scrolling the pane sideways.
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
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright-core';
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
    // Enough history to use the windowed transcript when switching modes.
    ...Array.from({ length: 150 }, (_, i): TranscriptItem => ({
      id: `earlier-${i}`, kind: 'assistant', ts: T - 150 + i, text: `Earlier progress update ${i + 1}.`
    })),
    { id: 'u1', kind: 'user', ts: T, text: 'Add rate limiting to the public API.' },
    { id: 't1', kind: 'tool', ts: T + 1, name: 'Edit', hint: 'edit', summary: 'src/server.ts', status: 'done', changes: [{ path: 'src/server.ts', kind: 'update', diff: '--- a/src/server.ts\n+++ b/src/server.ts\n@@ -1 +1,2 @@\n export const port = 3000;\n+export const limit = 100;' }] },
    { id: 't2', kind: 'tool', ts: T + 2, name: 'shell', hint: 'execute', summary: 'npm test', status: 'done', exitCode: 0, durationMs: 4200, output: '6 passed' },
    { id: 'f1', kind: 'assistant', ts: T + 3, text: 'Rate limiting is in place on every `/v1` route.', phase: 'final' },
    { id: 'turn1', kind: 'turn', ts: T + 4, status: 'completed', durationMs: 154_000, costUsd: 0.61, usage: { inputTokens: 48_200, outputTokens: 6_100 } }
  ];
}

const TABLE_HEADERS = ['Client', 'Region', 'Project', 'Branch', 'Runtime', 'Version', 'Status', 'Owner', 'Team', 'Retry', 'Quota', 'Latency', 'Budget', 'Fallback', 'Updated', 'Result'];
const LAYOUT_PROSE = 'The rollout will start in one region before expanding to the remaining clients.';

function chatLayoutTranscript(): TranscriptItem[] {
  const tableRow = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [{
    id: 'chat-layout', kind: 'assistant', ts: T, phase: 'final',
    text: [
      `${LAYOUT_PROSE} Before adding another region, confirm that the current clients can reconnect after a restart. Compare the retry rate with the previous release and give the support team time to review the results. Record any exceptions in the handoff notes so the next team can make the decision without reconstructing the timeline.`,
      '',
      tableRow(TABLE_HEADERS),
      tableRow(TABLE_HEADERS.map(() => '---')),
      tableRow(['Northwind', 'North America', 'Notifications', 'release candidate', 'Node.js LTS', 'v22.12.0', 'In progress', 'Casey Morgan', 'Release Engineering', 'Exponential', '120 requests/min', '45 milliseconds', 'Within budget', 'Secondary region', 'Monday morning', 'Ready for review']),
      '',
      '| Check | State |',
      '| --- | --- |',
      '| Smoke | Pass |'
    ].join('\n')
  }];
}

const usage = (): SessionMeta['usage'] => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 });

/** `extra` adds that many idle sessions, enough of them to overflow the window's height. */
async function seed(tmp: string, uiMode?: string, extra = 0, firstTranscript = transcript()): Promise<{ userData: string; project: string }> {
  const userData = path.join(tmp, 'userData');
  const project = path.join(tmp, 'project');
  await fs.mkdir(userData, { recursive: true });
  await seedProject(project);
  await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, { theme: 'dark', windowBounds: { width: 1280, height: 860 }, ...(uiMode ? { uiMode } : {}) }));
  const sessions: SessionMeta[] = [
    { id: FIRST, title: 'Add rate limiting to the public API', createdAt: T, updatedAt: T + 10, lastUserMessageAt: T, config: { harness: 'claude', projectRoot: project, permissionMode: 'accept-edits', model: { provider: 'anthropic', model: 'claude-opus-5-5' } }, cwd: project, status: 'idle', harnessRef: {}, usage: usage() },
    { id: SECOND, title: 'Fix flaky auth refresh test', createdAt: T - 1000, updatedAt: T - 1000, lastUserMessageAt: T - 1000, config: { harness: 'native', projectRoot: project, permissionMode: 'ask' }, cwd: project, status: 'idle', harnessRef: {}, usage: usage() },
    ...Array.from({ length: extra }, (_, i): SessionMeta => ({ id: `s_modes_extra_${i}`, title: `Backlog item ${i + 1}`, createdAt: T - 2000 - i, updatedAt: T - 2000 - i, lastUserMessageAt: T - 2000 - i, config: { harness: 'native', projectRoot: project, permissionMode: 'ask' }, cwd: project, status: 'idle', harnessRef: {}, usage: usage() }))
  ];
  await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify(sessions));
  for (const s of sessions) {
    await fs.mkdir(path.join(userData, 'sessions', s.id), { recursive: true });
    const items = s.id === FIRST ? firstTranscript : [{ id: 'u1', kind: 'user', ts: T - 1000, text: s.title } as TranscriptItem];
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
  // The booted shell itself, whichever interface it opens in.
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
const horizontalBox = (locator: Locator) => locator.evaluate((el) => {
  const { left, right, width } = el.getBoundingClientRect();
  return { left, right, width, overflow: el.scrollWidth - el.clientWidth };
});
const style = (win: Page, selector: string, prop: string) => win.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
const draft = (win: Page) => win.locator('.pane.active .composer textarea').inputValue();
const activeRow = (win: Page) => win.locator('.sidebar .session-row.active').getAttribute('data-session-id');
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
  it('switches Standard → Zen → Standard live, re-laying the window out without losing the session, its draft or the panel', async () => {
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
    const titlebarPill = '.titlebar-search .harness-pill[data-harness="claude"]';
    const sidebarPill = `[data-session-id="${FIRST}"] .harness-pill[data-harness="claude"]`;
    const pillColors = (selector: string) => Promise.all(['color', 'background-color'].map((property) => style(win, selector, property)));
    const standardPillColors = await pillColors(titlebarPill);

    // Settings → Appearance → Interface → Zen.
    await win.click('.sidebar-bottom .sidebar-link:has-text("Settings")');
    const sections = win.getByRole('navigation', { name: 'Settings sections' });
    const appearance = sections.getByRole('button', { name: 'Appearance', exact: true });
    await appearance.click();
    const fullSettingsWidth = (await rect(win, '.settings-nav')).width;
    const picker = win.getByRole('group', { name: 'Interface' });
    await expect.poll(() => picker.getByRole('button').evaluateAll((cards) => cards.map((c) => c.getAttribute('aria-label')))).toEqual(['Standard interface', 'Zen interface']);
    await picker.getByRole('button', { name: 'Zen interface' }).click();
    await expect.poll(() => uiMode(win)).toBe('zen');
    expect(await picker.getByRole('button', { name: 'Zen interface' }).getAttribute('aria-pressed')).toBe('true');
    expect((await win.evaluate(() => window.harness.invoke('settings:get', undefined))).uiMode).toBe('zen');
    await shot(win, 'zen-settings');

    const labels = sections.locator('.settings-nav-label, .settings-link > span');
    const visibleLabels = () => labels.filter({ visible: true }).count();
    const labelCount = await labels.count();
    const closedNav = await rect(win, '.settings-nav');
    const settingsPage = await rect(win, '.settings-main');
    expect(await visibleLabels()).toBe(0);

    await appearance.hover();
    await expect.poll(visibleLabels).toBe(labelCount);
    await expect.poll(() => rect(win, '.settings-nav').then((r) => r.width)).toBe(fullSettingsWidth);
    expect(await rect(win, '.settings-main')).toEqual(settingsPage);
    await win.screenshot({ path: path.join(shots, 'ui-modes-zen-settings-open.png') });

    // The label can be clicked beyond the edge of the closed rail.
    const defaults = sections.getByText('Session defaults', { exact: true });
    const label = (await defaults.boundingBox())!;
    expect(label.x + label.width / 2).toBeGreaterThan(closedNav.x + closedNav.width);
    await defaults.click();
    await win.getByRole('heading', { name: 'Session defaults', exact: true }).waitFor();
    await park(win);
    await expect.poll(() => rect(win, '.settings-nav')).toEqual(closedNav);
    expect(await visibleLabels()).toBe(0);

    // Keyboard navigation reveals the same labels. Search stays usable away from the rail.
    await win.keyboard.press('Tab');
    await expect.poll(visibleLabels).toBe(labelCount);
    await win.keyboard.press('Control+f');
    await win.keyboard.type('color theme');
    await win.getByRole('heading', { name: 'Find a setting', exact: true }).waitFor();
    await expect.poll(() => rect(win, '.settings-nav')).toEqual(closedNav);
    expect(await style(win, '.settings-search input', 'opacity')).toBe('1');
    await win.getByRole('button', { name: 'Clear search' }).click();
    await win.getByRole('heading', { name: 'Session defaults', exact: true }).waitFor();

    await win.keyboard.press('Control+,');
    await win.locator('.pane.active .composer textarea').waitFor();

    // Zen: a 52px rail that opens over the conversation on hover, the panel as a floating drawer.
    await park(win);
    await expect.poll(() => rect(win, '.sidebar').then((r) => r.width)).toBe(52);
    expect(await style(win, '.panel', 'position')).toBe('fixed');
    expect(await activeRow(win)).toBe(FIRST);
    expect(await draft(win)).toBe(DRAFT);
    await win.locator(titlebarPill).waitFor();
    expect(await win.locator('.titlebar-search .session-label > span').allTextContents()).toEqual(['Claude', 'project', '|', 'Add rate limiting to the public API']);
    expect(await pillColors(titlebarPill)).toEqual(standardPillColors);
    expect(await win.locator('.pane.active .header .session-label').isVisible()).toBe(false);
    // The title bar's words fold into one menu.
    expect(await win.getByRole('button', { name: 'File', exact: true }).count()).toBe(0);
    expect(await win.getByRole('button', { name: 'Menu', exact: true }).count()).toBe(1);
    // The composer's controls wait for the pointer; Send never hides.
    const modelPill = win.locator('.pane.active .composer .pill-model');
    await expect.poll(() => modelPill.evaluate((el) => getComputedStyle(el.closest('.dropdown')!).opacity)).toBe('0');
    expect(await style(win, '.pane.active .composer .send-btn', 'opacity')).toBe('1');
    await shot(win, 'zen-session');
    const [workBottom, replyTop] = await Promise.all([
      win.locator('.transcript.virtual .work-head').evaluate((el) => el.getBoundingClientRect().bottom),
      win.getByText('Rate limiting is in place', { exact: false }).evaluate((el) => el.getBoundingClientRect().top)
    ]);
    expect(replyTop - workBottom).toBeGreaterThanOrEqual(0);
    expect(replyTop - workBottom).toBeLessThanOrEqual(12);

    const composerBox = win.locator('.pane.active .composer-box');
    await composerBox.hover();
    await expect.poll(() => modelPill.evaluate((el) => getComputedStyle(el.closest('.dropdown')!).opacity)).toBe('1');
    const menu = composerBox.getByRole('menu');
    for (const pill of [modelPill, composerBox.getByRole('button', { name: 'Permission mode: Edits' })]) {
      await pill.click();
      await menu.waitFor();
      const [popup, trigger] = await Promise.all([menu.boundingBox(), pill.boundingBox()]);
      expect(Math.abs(popup!.x - trigger!.x), 'run menu sits over its own Zen button').toBeLessThanOrEqual(1);
      await win.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
    }
    // Hovering the rail opens it to the user's sidebar width, over the transcript: the pane does not move.
    const paneBefore = await rect(win, '.pane.active');
    await win.mouse.move(26, 420);
    await expect.poll(() => rect(win, '.sidebar').then((r) => r.width)).toBe(280);
    expect(await rect(win, '.pane.active')).toEqual(paneBefore);
    await win.locator(sidebarPill).waitFor();
    expect(await pillColors(sidebarPill)).toEqual(standardPillColors);
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

    // The one-button menu → View → Standard interface.
    await win.getByRole('button', { name: 'Menu', exact: true }).click();
    await win.getByRole('tablist', { name: 'Menus' }).getByRole('tab', { name: 'View', exact: true }).hover();
    await shot(win, 'zen-menu').catch(() => undefined);
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

  it.for(['standard', 'zen'])('lays out chat and scrolls Markdown tables locally in %s', { timeout: 120_000 }, async (mode, { onTestFinished }) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-ui-modes-chat-layout-'));
    onTestFinished(() => fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }));
    const { userData } = await seed(tmp, mode, 0, chatLayoutTranscript());
    const win = await launch(userData);
    // Zen animates the main area's padding when its drawer closes. Measure the settled layout.
    await win.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => uiMode(win)).toBe(mode);
    if (mode === 'zen') await clickDot(win, FIRST);
    else await win.locator(`[data-session-id="${FIRST}"]`).click();

    const pane = win.locator('.pane.active');
    const transcriptView = pane.locator('.transcript');
    const row = transcriptView.locator('.transcript-row').filter({ hasText: LAYOUT_PROSE });
    const prose = row.getByText(LAYOUT_PROSE, { exact: false });
    await prose.waitFor({ timeout: 30_000 });
    // Ctrl+J in both modes: in Zen the side panel's rail stands in for the header's toggle.
    if (await win.locator('.panel').count()) await win.keyboard.press('Control+j');
    await win.locator('.panel').waitFor({ state: 'hidden' });
    await park(win);
    await win.evaluate(() => document.fonts.ready.then(() => undefined));

    const wide = row.getByRole('region', { name: 'Scrollable table', exact: true })
      .and(row.locator('div.md-table')).filter({ has: win.getByRole('columnheader', { name: 'Client', exact: true }) });
    const smallTable = row.getByRole('table').filter({ has: win.getByRole('columnheader', { name: 'Check', exact: true }) });
    const readLayout = async (width: number) => {
      await win.setViewportSize({ width, height: 860 });
      // Read all parent and child bounds in the same renderer evaluation.
      const [paneBounds, transcriptBounds, rowBounds, composerBounds, boxBounds, actionsBounds] = await pane.evaluate((el) => {
        const measure = (target: Element) => {
          const { left, right, width } = target.getBoundingClientRect();
          return { left, right, width, overflow: target.scrollWidth - target.clientWidth };
        };
        const descendants = ['.transcript', '.transcript-row:has([data-item-id="chat-layout"])', '.composer', '.composer-box', '.composer-actions'];
        return [measure(el), ...descendants.map((selector) => {
          const target = el.querySelector(selector);
          if (!target) throw new Error(`Missing chat layout element: ${selector}`);
          return measure(target);
        })];
      });
      for (const [label, bounds, parent] of [
        ['transcript', transcriptBounds, paneBounds], ['transcript row', rowBounds, transcriptBounds],
        ['composer', composerBounds, paneBounds], ['composer box', boxBounds, composerBounds], ['composer controls', actionsBounds, boxBounds]
      ] as const) {
        expect(bounds.overflow, `${width}px viewport: ${label} has no horizontal overflow`).toBeLessThanOrEqual(1);
        expect(bounds.left, `${width}px viewport: ${label} stays inside its parent`).toBeGreaterThanOrEqual(parent.left - 1);
        expect(bounds.right, `${width}px viewport: ${label} stays inside its parent`).toBeLessThanOrEqual(parent.right + 1);
      }
      return { row: rowBounds, composer: boxBounds };
    };

    // Make the pane wider than the target cap; check layout independently of the table wrapper.
    const roomy = await readLayout(1600);
    for (const [label, box] of [['transcript row', roomy.row], ['composer', roomy.composer]] as const) {
      expect(box.width, `roomy ${label} uses more than the old reading column`).toBeGreaterThan(1000);
      expect(box.width, `roomy ${label} still caps its width`).toBeLessThan(1180);
    }
    const proseLines = await prose.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return Array.from(range.getClientRects(), (line) => line.width);
    });
    expect(proseLines.length, 'the long paragraph still wraps').toBeGreaterThan(1);
    expect(Math.max(...proseLines), 'prose has a shorter measure than its row').toBeLessThan(roomy.row.width - 150);

    await wide.waitFor();
    const roomyTable = await horizontalBox(wide);
    expect(roomyTable.width, 'the wide table uses the wider row').toBeGreaterThan(roomy.row.width * 0.9);
    const narrow = await readLayout(900);
    expect(roomy.row.width - narrow.row.width).toBeGreaterThan(100);
    expect(roomy.composer.width - narrow.composer.width).toBeGreaterThan(100);
    const narrowTable = await horizontalBox(wide);
    expect(roomyTable.width - narrowTable.width, 'more of the wide table is visible in the roomy pane').toBeGreaterThan(100);
    expect(narrowTable.overflow, 'the wide table overflows its own region in the narrow pane').toBeGreaterThan(0);

    const nativeTable = wide.getByRole('table');
    expect(await nativeTable.evaluate((el) => el.tagName)).toBe('TABLE');
    expect(await nativeTable.getByRole('row').count()).toBe(2);
    expect(await nativeTable.getByRole('cell', { name: 'Ready for review', exact: true }).count()).toBe(1);
    const headerLines = await nativeTable.getByRole('columnheader').evaluateAll((headers) => headers.map((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return { label: el.textContent, lines: range.getClientRects().length };
    }));
    expect(headerLines, 'short headers do not break across lines in the narrow pane')
      .toEqual(TABLE_HEADERS.map((label) => ({ label, lines: 1 })));

    const small = await horizontalBox(smallTable);
    expect(small.width, 'the small native table remains compact').toBeLessThan(narrow.row.width / 2);
    expect(small.overflow, 'the small table needs no horizontal scroll').toBeLessThanOrEqual(1);
    expect(await smallTable.evaluate((el) => {
      const wrapper = el.closest('.md-table');
      return wrapper ? wrapper.scrollWidth - wrapper.clientWidth : 0;
    }), 'a wrapper around the small table does not scroll either').toBeLessThanOrEqual(1);

    await shot(win, `${mode}-narrow-table`);
    expect(await wide.getAttribute('tabindex')).toBe('0');
    await wide.focus();
    expect(await wide.evaluate((el) => document.activeElement === el)).toBe(true);
    const scrollLeft = () => wide.evaluate((el) => el.scrollLeft);
    const before = await scrollLeft();
    await win.keyboard.press('ArrowRight');
    await expect.poll(scrollLeft, { message: 'the focused table scrolls with the keyboard' }).toBeGreaterThan(before);
    expect(await transcriptView.evaluate((el) => el.scrollLeft)).toBe(0);
  });

  it('edits a session label and title while its Zen row actions are showing', async ({ onTestFinished }) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-ui-modes-label-'));
    onTestFinished(() => fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }));
    const { userData } = await seed(tmp, 'zen');
    const win = await launch(userData);
    const row = win.locator(`[data-session-id="${FIRST}"]`);
    const railDot = { position: { x: 26, y: 10 } };
    await row.hover(railDot);
    await expect.poll(() => rect(win, '.sidebar').then((r) => r.width)).toBe(280);

    const fork = row.getByRole('button', { name: 'Fork session', exact: true });
    await fork.waitFor();
    await row.getByText('Idle', { exact: true }).click({ timeout: 5_000 });
    await row.getByRole('menuitem', { name: 'Merged', exact: true }).click();
    await row.getByText('Merged', { exact: true }).waitFor();

    await row.hover(railDot);
    await fork.click();
    await row.getByRole('menuitem', { name: 'Fork into', exact: true }).waitFor();
    await win.keyboard.press('Escape');
    await row.getByRole('button', { name: 'Archive session', exact: true }).click({ trial: true });

    // Select the other fixture first so a click on the title itself has to change the active row.
    await clickDot(win, SECOND);
    await expect.poll(() => activeRow(win)).toBe(SECOND);
    await row.hover(railDot);
    const originalTitle = 'Add rate limiting to the public API';
    const title = row.getByText(originalTitle, { exact: true });
    await title.click();
    await expect.poll(() => activeRow(win)).toBe(FIRST);
    expect(await row.getByRole('textbox').count()).toBe(0);

    await title.dblclick();
    const rename = row.getByRole('textbox', { name: 'Rename session', exact: true });
    await rename.waitFor();
    expect(await rename.inputValue()).toBe(originalTitle);
    await rename.fill('Rename from the Zen sidebar');
    await rename.press('Enter');
    await row.getByText('Rename from the Zen sidebar', { exact: true }).waitFor();
  }, 60_000);

  it('scrolls Zen’s rail open or closed and matches the transcript’s scrollbar when open', async ({ onTestFinished }) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-ui-modes-scroll-'));
    onTestFinished(() => fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }));
    const { userData } = await seed(tmp, 'zen', 40);
    const win = await launch(userData);
    await expect.poll(() => uiMode(win)).toBe('zen');
    const viewport = win.viewportSize()!;
    const list = win.locator('.sidebar-list');
    const transcript = win.locator('.pane.active .transcript');
    const last = win.locator('[data-session-id="s_modes_extra_39"]');
    const listBox = () => rect(win, '.sidebar-list');
    const railBox = () => rect(win, '.sidebar');
    const clientWidth = () => list.evaluate((el) => el.clientWidth);

    await park(win);
    await expect.poll(() => railBox().then((r) => r.width)).toBe(52);
    await clickDot(win, FIRST);
    await expect.poll(() => transcript.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    // Closed: the list overflows with the gear still on screen, and the rail clips the scrollbar.
    await park(win);
    await expect.poll(() => railBox().then((r) => r.width)).toBe(52);
    const scroll = () => list.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
    const { height, client } = await scroll();
    expect(height).toBeGreaterThan(client);
    const box = await listBox();
    const rail = await railBox();
    const closedClientWidth = await clientWidth();
    expect(box.x + closedClientWidth).toBeGreaterThan(rail.x + rail.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    const gear = await rect(win, '.sidebar-bottom .sidebar-link');
    expect(gear.y + gear.height).toBeLessThanOrEqual(viewport.height);
    // A wheel over the closed rail scrolls it (the rail opens under the pointer as it does so).
    await win.mouse.move(26, box.y + box.height / 2);
    await win.mouse.wheel(0, 4000);
    await expect.poll(async () => (await scroll()).top).toBeGreaterThan(0);
    await expect.poll(() => railBox().then((r) => r.width)).toBe(280);

    // Non-auto scrollbar settings can bypass the themed pseudo-elements even if their styles match.
    const scrollbar = (scroller: typeof list) => scroller.evaluate((el) => {
      const { scrollbarWidth, scrollbarColor } = getComputedStyle(el);
      return {
        scrollbarWidth, scrollbarColor,
        width: getComputedStyle(el, '::-webkit-scrollbar').width,
        thumb: getComputedStyle(el, '::-webkit-scrollbar-thumb').background,
        track: getComputedStyle(el, '::-webkit-scrollbar-track').background
      };
    });
    expect(await scrollbar(list)).toEqual(await scrollbar(transcript));
    expect(await clientWidth()).toBe(closedClientWidth);

    // Scrolled to the end, the last session is inside the list's visible box, and it opens.
    await expect.poll(async () => {
      const [row, l] = [await rect(win, '[data-session-id="s_modes_extra_39"]'), await listBox()];
      return row.y >= l.y && row.y + row.height <= l.y + l.height;
    }).toBe(true);
    await fs.mkdir(shots, { recursive: true });
    await win.screenshot({ path: path.join(shots, 'ui-modes-zen-rail-scrolled.png') });
    await last.locator('.session-pin').click();
    await expect.poll(() => activeRow(win)).toBe('s_modes_extra_39');
  }, 120_000);

  it('keeps Zen’s rail on its dots after the new-session dialog hands focus back to a button in it', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-ui-modes-focus-'));
    const { userData } = await seed(tmp, 'zen');
    const win = await launch(userData);
    await expect.poll(() => uiMode(win)).toBe('zen');
    await park(win);
    await expect.poll(() => rect(win, '.sidebar').then((r) => r.width)).toBe(52);
    const dotX = () => rect(win, `[data-session-id="${FIRST}"] .session-pin`).then((r) => r.x);
    const restingDot = await dotX();
    // The folder's + sits at the open rail's right edge, far outside the closed rail.
    await win.mouse.move(26, 420);
    await expect.poll(() => rect(win, '.sidebar').then((r) => r.width)).toBe(280);
    await win.locator('.project-new-btn').first().click();
    const dialog = win.locator('.modal[role="dialog"]');
    await dialog.waitFor();
    // The pointer leaves the rail for the dialog, so the rail closes behind it; closing the dialog
    // restores focus to the + (a mouse close, so no focus ring reopens the rail).
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect.poll(() => dialog.count()).toBe(0);
    await park(win);
    await expect.poll(() => rect(win, '.sidebar').then((r) => r.width)).toBe(52);
    // Focusing a clipped button must not scroll the rail sideways and leave it showing row ends.
    expect(await win.locator('.sidebar').evaluate((el) => el.scrollLeft)).toBe(0);
    expect(await dotX()).toBe(restingDot);
  }, 120_000);

  it.for(['Enter', 'Space'])('keeps the archive confirmation at its rail button and lets %s confirm it', { timeout: 120_000 }, async (key, { onTestFinished }) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-ui-modes-archive-'));
    onTestFinished(() => fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }));
    const { userData, project } = await seed(tmp, 'zen');
    const worktree = path.join(tmp, 'worktree');
    git(project, 'worktree', 'add', '-b', 'agent/flaky-auth', worktree);
    const file = path.join(userData, 'sessions.json');
    const sessions = JSON.parse(await fs.readFile(file, 'utf8')) as SessionMeta[];
    await fs.writeFile(file, JSON.stringify(sessions.map((s) => (s.id === SECOND ? { ...s, cwd: worktree, worktreeBranch: 'agent/flaky-auth' } : s))));
    const win = await launch(userData);
    await expect.poll(() => uiMode(win)).toBe('zen');
    const railWidth = () => rect(win, '.sidebar').then((r) => r.width);
    await park(win);
    await expect.poll(railWidth).toBe(52);

    const row = win.locator(`[data-session-id="${SECOND}"]`);
    await row.hover({ position: { x: 26, y: 10 } });
    await expect.poll(railWidth).toBe(280);
    const archive = row.getByRole('button', { name: 'Archive session', exact: true });
    await archive.click();
    const dialog = win.locator('.modal[role="dialog"]');
    await dialog.getByText('Remove the worktree for "Fix flaky auth refresh test"?').waitFor();
    const confirm = dialog.getByRole('button', { name: 'Archive & remove', exact: true });
    expect(await confirm.evaluate((el) => el === document.activeElement)).toBe(true);
    // It opens right under the button, not mid-window, and without dimming what it is about.
    expect(await dialog.evaluate((el) => el.classList.contains('is-anchored'))).toBe(true);
    const button = await archive.boundingBox();
    const box = await dialog.boundingBox();
    expect(Math.abs(box!.y - (button!.y + button!.height + 6))).toBeLessThanOrEqual(1);
    expect(box!.x).toBeLessThan(button!.x + button!.width);
    expect(await style(win, '.modal-backdrop', 'background-color')).toBe('rgba(0, 0, 0, 0)');
    // The pointer leaves the rail for the dialog; the rail stays open beside it, button showing.
    await park(win);
    await win.waitForTimeout(700);
    expect(await railWidth()).toBe(280);
    expect(await archive.isVisible()).toBe(true);
    await fs.mkdir(shots, { recursive: true });
    await win.screenshot({ path: path.join(shots, 'ui-modes-zen-archive-confirm.png') });

    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(() => dialog.count()).toBe(0);
    await park(win);
    await expect.poll(railWidth).toBe(52);
    // Cancelled: the session is still listed, not archived.
    expect(await row.count()).toBe(1);

    await row.hover({ position: { x: 26, y: 10 } });
    await expect.poll(railWidth).toBe(280);
    await archive.click();
    await confirm.waitFor();
    // Send the key to the window without focusing the button from the test.
    await win.keyboard.press(key);
    await row.waitFor({ state: 'detached' });
    expect(await dialog.count()).toBe(0);
    await expect(fs.stat(worktree)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('folds the side panel into one rail on the right whose drawer shows a view at a time, and pins either side open across a restart', async ({ onTestFinished }) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-ui-modes-panel-'));
    onTestFinished(() => fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }));
    const { userData } = await seed(tmp, 'zen');
    let win = await launch(userData);
    await expect.poll(() => uiMode(win)).toBe('zen');
    await clickDot(win, FIRST);
    await win.locator('.work-head').waitFor({ timeout: 30_000 });
    const panelWidth = () => rect(win, '.panel').then((r) => r.width);
    const sidebarWidth = () => rect(win, '.sidebar').then((r) => r.width);
    const title = () => win.locator('.panel-head-title').textContent();
    const visibility = (half: 'top' | 'bottom') => style(win, `.panel > .panel-${half}`, 'visibility');
    // The Standard panel is 420px; Zen's drawer opens over the column, so it gets 560.
    const OPEN = 52 + 560;

    // Closed, the panel is a 52px rail on the window's right edge: one series of icons, six workspace
    // views and five live services, with no tab strips. It stands in for the header's panel toggle
    // and changes chip, and carries the fixture's uncommitted change as a dot.
    await park(win);
    await expect.poll(panelWidth).toBe(52);
    const rail = await rect(win, '.panel');
    expect(rail.x + rail.width).toBe(1280);
    expect(await win.locator('.panel-rail .panel-tab').count()).toBe(11);
    expect(await win.locator('.panel .panel-tabs').count()).toBe(0);
    expect(await win.locator('.pane.active .header-panel-toggle').isVisible()).toBe(false);
    expect(await win.locator('.pane.active .header-changes').isVisible()).toBe(false);
    await win.getByTestId('panel-changes-dot').waitFor();
    // The column's padding animates in once the session (and so the rail) is showing: let it settle.
    await expect.poll(() => rect(win, '.pane.active').then((r) => r.x + r.width)).toBe(1280 - 52);
    const pane = await rect(win, '.pane.active');
    await shot(win, 'zen-panel-rail');

    // Hovering the rail slides the drawer out over the conversation: the pane does not move.
    await win.mouse.move(1280 - 26, 400);
    await expect.poll(panelWidth).toBe(OPEN);
    expect(await rect(win, '.pane.active')).toEqual(pane);
    // One view at a time: a workspace view, then a live service, each taking the whole drawer.
    await win.getByTestId('panel-top-files').click();
    await expect.poll(title).toBe('Files');
    expect(await visibility('top')).toBe('visible');
    expect(await visibility('bottom')).toBe('hidden');
    await win.getByTestId('panel-bottom-processes').click();
    await expect.poll(title).toBe('Processes');
    expect(await visibility('top')).toBe('hidden');
    expect(await visibility('bottom')).toBe('visible');
    await win.getByTestId('panel-top-changes').click();
    await expect.poll(title).toBe('Changes');
    await win.locator('.panel .file-row', { hasText: 'server.ts' }).waitFor();
    await win.waitForTimeout(300);
    await fs.mkdir(shots, { recursive: true });
    await win.screenshot({ path: path.join(shots, 'ui-modes-zen-panel-open.png') });
    // Pointer and focus gone (a mouse click leaves no focus ring), it folds back to the rail.
    await park(win);
    await expect.poll(panelWidth).toBe(52);

    // A peek: the composer's usage meter opens the drawer on Usage without the rail being hovered;
    // a press elsewhere folds it back.
    const meter = win.locator('.pane.active .session-meter');
    await win.locator('.pane.active .composer-box').hover();
    await meter.click();
    await expect.poll(panelWidth).toBe(OPEN);
    await expect.poll(title).toBe('Usage');
    expect(await meter.getAttribute('aria-expanded')).toBe('true');
    await win.mouse.click(300, 300);
    await expect.poll(panelWidth).toBe(52);
    expect(await meter.getAttribute('aria-expanded')).toBe('false');

    // Pinned, the drawer stays out without the pointer, and the column moves out of its way.
    await win.mouse.move(1280 - 26, 400);
    await expect.poll(panelWidth).toBe(OPEN);
    await win.getByRole('button', { name: 'Pin side panel', exact: true }).click();
    await park(win);
    await win.waitForTimeout(600);
    expect(await panelWidth()).toBe(OPEN);
    await expect.poll(() => rect(win, '.pane.active').then((r) => r.x + r.width)).toBeLessThanOrEqual(1280 - OPEN);
    // The sidebar pins the same way, owning its column instead of opening over the conversation.
    await win.mouse.move(26, 420);
    await expect.poll(sidebarWidth).toBe(280);
    await win.getByRole('button', { name: 'Pin sidebar', exact: true }).click();
    await park(win);
    await win.waitForTimeout(600);
    expect(await sidebarWidth()).toBe(280);
    await expect.poll(() => rect(win, '.pane.active').then((r) => r.x)).toBeGreaterThanOrEqual(280);
    await shot(win, 'zen-pinned');

    // Both pins survive a restart; unpinned, each side folds back to its rail.
    await app!.close();
    app = null;
    win = await launch(userData);
    await expect.poll(() => uiMode(win)).toBe('zen');
    await win.locator(`[data-session-id="${FIRST}"] .session-pin`).click();
    await win.locator('.work-head').waitFor({ timeout: 30_000 });
    await park(win);
    await expect.poll(sidebarWidth).toBe(280);
    await expect.poll(panelWidth).toBe(OPEN);
    await win.getByRole('button', { name: 'Unpin side panel', exact: true }).click();
    await win.getByRole('button', { name: 'Unpin sidebar', exact: true }).click();
    await park(win);
    await expect.poll(panelWidth).toBe(52);
    await expect.poll(sidebarWidth).toBe(52);
  }, 180_000);

  it('reopens in the interface it was closed in', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-ui-modes-restart-'));
    const { userData } = await seed(tmp);
    let win = await launch(userData);
    expect(await uiMode(win)).toBe('standard');
    // The command palette offers the interface not in use.
    await win.keyboard.press('Control+k');
    await win.locator('.palette input').fill('Zen interface');
    await win.locator('.palette-item', { hasText: 'Switch to the Zen interface' }).click();
    await expect.poll(() => uiMode(win)).toBe('zen');
    await app!.close();
    app = null;

    win = await launch(userData);
    await expect.poll(() => uiMode(win)).toBe('zen');
    await park(win);
    await expect.poll(() => rect(win, '.sidebar').then((r) => r.width)).toBe(52);
    expect(await win.getByRole('button', { name: 'Menu', exact: true }).count()).toBe(1);
    expect(JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')).uiMode).toBe('zen');
  }, 180_000);
});
