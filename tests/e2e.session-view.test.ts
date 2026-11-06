/**
 * Electron end-to-end for the session view's layout: a one-row header that carries the working
 * tree's changes, the run controls and usage readout under the composer, a turn's work behind one
 * chip with its plan still on screen, the title bar's search and Vesta launcher, the sidebar's New
 * session entry, and a header that sheds detail in a narrow split pane instead of overflowing it.
 * Sessions, transcripts and a git checkout with uncommitted work are seeded on disk, so no harness
 * and no provider key are involved; review screenshots land in tests/artifacts/session-view-*.png.
 * Requires `npm run build` first; gated by VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';
import { expectQuietWindow, isolatedEnv, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

const SID = 's_view_e2e';
const OTHER = 's_view_other';
const T = Date.now() - 600_000;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A committed project, then three uncommitted changes: one edit and two new files. */
async function seedProject(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'server.ts'), "export const port = 3000;\n");
  git(dir, 'init', '-q', '-b', 'main');
  // A throwaway fixture: commit under a local identity, whatever the machine has configured.
  git(dir, 'config', 'user.name', 'e2e');
  git(dir, 'config', 'user.email', 'e2e@example.invalid');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', 'feat/rate-limit');
  await fs.writeFile(path.join(dir, 'src', 'server.ts'), "export const port = 3000;\nexport const limit = 100;\n");
  await fs.writeFile(path.join(dir, 'src', 'rate-limit.ts'), 'export const windowMs = 60_000;\nexport const burst = 10;\n');
  await fs.writeFile(path.join(dir, 'src', 'rate-limit.test.ts'), 'export {};\n');
}

/** One finished turn whose work holds a plan update between its steps, edits with diffs and a command. */
function transcript(): TranscriptItem[] {
  return [
    { id: 'u1', kind: 'user', ts: T, text: 'Add rate limiting to the public API.' },
    { id: 'a1', kind: 'assistant', ts: T + 1, text: 'Reading the server first.' },
    { id: 't1', kind: 'tool', ts: T + 2, name: 'Read', hint: 'read', summary: 'src/server.ts', status: 'done', durationMs: 30 },
    { id: 'p1', kind: 'plan', ts: T + 3, entries: [{ content: 'Add the limiter', status: 'in_progress' }, { content: 'Wire it up', status: 'pending' }, { content: 'Test 429', status: 'pending' }] },
    { id: 't2', kind: 'tool', ts: T + 4, name: 'Write', hint: 'edit', summary: 'src/rate-limit.ts', status: 'done', changes: [{ path: 'src/rate-limit.ts', kind: 'add', diff: '--- /dev/null\n+++ b/src/rate-limit.ts\n@@ -0,0 +1,2 @@\n+export const windowMs = 60_000;\n+export const burst = 10;' }] },
    { id: 't3', kind: 'tool', ts: T + 5, name: 'Edit', hint: 'edit', summary: 'src/server.ts', status: 'done', changes: [{ path: 'src/server.ts', kind: 'update', diff: '--- a/src/server.ts\n+++ b/src/server.ts\n@@ -1 +1,2 @@\n export const port = 3000;\n+export const limit = 100;' }] },
    { id: 't4', kind: 'tool', ts: T + 6, name: 'Write', hint: 'edit', summary: 'src/rate-limit.test.ts', status: 'done', changes: [{ path: 'src/rate-limit.test.ts', kind: 'add' }] },
    { id: 'p2', kind: 'plan', ts: T + 7, entries: [{ content: 'Add the limiter', status: 'completed' }, { content: 'Wire it up', status: 'completed' }, { content: 'Test 429', status: 'completed' }] },
    { id: 't5', kind: 'tool', ts: T + 8, name: 'shell', hint: 'execute', summary: 'npm test -- rate-limit', status: 'done', exitCode: 0, durationMs: 4200, output: '6 passed' },
    { id: 'f1', kind: 'assistant', ts: T + 9, text: 'Rate limiting is in place on every `/v1` route.', phase: 'final' },
    { id: 'turn1', kind: 'turn', ts: T + 10, status: 'completed', durationMs: 154_000, costUsd: 0.61, usage: { inputTokens: 48_200, outputTokens: 6_100 } }
  ];
}

const usage = (patch: Partial<SessionMeta['usage']> = {}): SessionMeta['usage'] => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0, ...patch });

/** Overflow of an element's content past its own box, in px; 0 when everything fits. */
const overflowX = (win: Page, selector: string) => win.locator(selector).evaluateAll((els) => els.map((el) => el.scrollWidth - el.clientWidth));

describe.runIf(enabled)('electron e2e: session view layout', () => {
  it('carries changes, run controls, plan, search, Vesta and New session where the redesign puts them, and fits a narrow pane', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-session-view-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await seedProject(project);
    // A deliberately small window, like a CI runner's display (a window cannot outgrow its screen):
    // the page size is pinned after launch, so the layout under test never depends on the machine.
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, { theme: 'dark', windowBounds: { width: 1024, height: 768 }, agent: { enabled: true, collapsed: true } }));
    const sessions: SessionMeta[] = [
      {
        id: SID,
        title: 'Add rate limiting to the public API',
        createdAt: T,
        updatedAt: T + 10,
        lastUserMessageAt: T,
        config: { harness: 'claude', projectRoot: project, permissionMode: 'accept-edits', model: { provider: 'anthropic', model: 'claude-opus-5-5' } },
        cwd: project,
        status: 'idle',
        harnessRef: {},
        usage: usage({ inputTokens: 48_200, outputTokens: 6_100, costUsd: 0.84, turns: 1, contextTokens: 64_000, contextWindow: 200_000 })
      },
      {
        id: OTHER,
        title: 'Fix flaky auth refresh test',
        createdAt: T - 1000,
        updatedAt: T - 1000,
        lastUserMessageAt: T - 1000,
        config: { harness: 'native', projectRoot: project, permissionMode: 'ask' },
        cwd: project,
        status: 'idle',
        harnessRef: {},
        usage: usage()
      }
    ];
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify(sessions));
    for (const s of sessions) {
      await fs.mkdir(path.join(userData, 'sessions', s.id), { recursive: true });
      const items = s.id === SID ? transcript() : [{ id: 'u1', kind: 'user', ts: T - 1000, text: s.title } as TranscriptItem];
      await fs.writeFile(path.join(userData, 'sessions', s.id, 'transcript.jsonl'), items.map((i) => JSON.stringify(i)).join('\n') + '\n');
    }

    app = await electron.launch({
      executablePath: require('electron') as string,
      args: [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`],
      env: isolatedEnv(userData),
      timeout: 60_000
    });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });
    await expectQuietWindow(app);
    // Wide enough for every header item: 1600 − sidebar − side panel leaves the pane ~900px.
    await win.setViewportSize({ width: 1600, height: 1000 });
    await fs.mkdir(shots, { recursive: true });
    await win.locator(`[data-session-id="${SID}"]`).click();
    await win.locator('.work-head').waitFor({ timeout: 30_000 });

    // One header row: identity on the left, the working tree's changes and the actions on the right.
    const head = win.locator('.pane.active .header');
    const titleRow = head.locator('.header-title');
    await titleRow.getByTestId('session-title').waitFor();
    expect(await titleRow.locator('.badge').first().innerText()).toBe('Claude');
    // innerText reads a hidden element's text too, so every header item is first waited on as visible.
    const crumbs = titleRow.locator('.header-crumbs');
    await crumbs.waitFor({ state: 'visible', timeout: 30_000 });
    expect(await crumbs.innerText()).toContain('feat/rate-limit');
    expect(await head.locator('.header-controls').count()).toBe(0);
    expect(await head.getAttribute('data-width')).toBe('wide');
    const changes = titleRow.locator('.header-changes');
    await changes.waitFor({ state: 'visible', timeout: 30_000 });
    await expect.poll(() => changes.innerText(), { timeout: 30_000 }).toContain('3 files');
    expect(await changes.locator('.add').innerText()).toBe('+4'); // +1 in server.ts, +2 and +1 in the new files
    expect(await changes.locator('.del').innerText()).toBe('−0');
    await win.screenshot({ path: path.join(shots, 'session-view-01-default.png') });

    // The turn's work is one chip with its tally, and the latest plan stays on screen while collapsed.
    const work = win.locator('.work-head');
    expect(await work.innerText()).toMatch(/Worked for 2m 34s[\s\S]*5 steps[\s\S]*3 files changed/);
    expect(await win.locator('.plan-card').count()).toBe(1);
    expect(await win.locator('.plan-progress').innerText()).toBe('3 of 3 done');
    expect(await win.locator('.tool-card').count()).toBe(0);
    await work.click();
    expect(await win.locator('.plan-card').count()).toBe(1);
    expect(await win.locator('.tool-card').count()).toBe(5);
    expect(await win.locator('.tool-card .badge').count()).toBe(0); // every step succeeded
    expect(await win.locator('.tool-card', { hasText: 'src/server.ts' }).filter({ has: win.locator('.diff-stat') }).locator('.add').innerText()).toBe('+1');
    await win.screenshot({ path: path.join(shots, 'session-view-02-work.png') });
    await work.click();

    // The changes chip opens Changes; the readout under the composer opens Usage.
    await changes.click();
    await win.locator('.panel-tab.active', { hasText: 'Changes' }).waitFor({ timeout: 10_000 });
    await win.locator('.changes').waitFor({ timeout: 10_000 });
    const composer = win.locator('.pane.active .composer');
    expect(await composer.locator('.run-controls .pill[title="Model"]').innerText()).toContain('anthropic/claude-opus-5-5');
    const meter = composer.getByRole('button', { name: 'Session usage' });
    expect(await meter.innerText()).toMatch(/32%[\s\S]*\$0\.84/);
    await meter.click();
    await win.locator('.panel-tab.active', { hasText: 'Usage' }).waitFor({ timeout: 10_000 });

    // The title bar names the session and opens the command palette.
    const search = win.locator('.titlebar-search');
    expect(await search.innerText()).toContain('Add rate limiting to the public API');
    await search.click();
    await win.getByPlaceholder('Type a command or session name…').waitFor({ timeout: 10_000 });
    await win.keyboard.press('Escape');
    await expect.poll(() => win.locator('.palette').count()).toBe(0);

    // The sidebar's New session opens the quick folder picker.
    await win.locator('.sidebar-new').click();
    await win.locator('.palette', { hasText: 'New session in…' }).waitFor({ timeout: 10_000 });
    await win.keyboard.press('Escape');
    await expect.poll(() => win.locator('.palette').count()).toBe(0);

    // Vesta opens from, and minimizes back to, the title bar; nothing of it floats while minimized.
    const launcher = win.locator('.titlebar-vesta');
    await win.getByRole('button', { name: 'Open Vesta' }).click();
    await win.getByRole('dialog', { name: 'Vesta' }).waitFor({ timeout: 10_000 });
    await expect.poll(() => launcher.getAttribute('aria-pressed')).toBe('true');
    await win.screenshot({ path: path.join(shots, 'session-view-03-vesta.png') });
    await win.getByRole('button', { name: 'Minimize Vesta' }).click();
    await expect.poll(() => win.getByRole('dialog', { name: 'Vesta' }).count()).toBe(0);
    expect(await win.locator('.vesta').count()).toBe(0);

    // Split right: each pane is ~450px, so its header sheds the folder/branch crumbs, the harness badge
    // and the line totals, and still fits its row; the title, the actions and the pane controls stay.
    await win.getByRole('button', { name: 'Split right' }).click();
    await win.locator('.pane-picker').waitFor({ timeout: 10_000 });
    await win.locator('.pane-picker-item', { hasText: 'Fix flaky auth refresh test' }).click();
    await expect.poll(() => win.locator('.pane .header').count()).toBe(2);
    await expect.poll(async () => (await win.locator('.pane .header').evaluateAll((els) => els.map((el) => el.getAttribute('data-width')))).every((w) => w !== 'wide')).toBe(true);
    expect(await win.locator('.pane .header-crumbs:visible').count()).toBe(0);
    for (const over of await overflowX(win, '.pane .header-title')) expect(over).toBeLessThanOrEqual(1);
    expect(await win.locator('.pane.active .header').getByRole('button', { name: 'Close pane' }).count()).toBe(1);
    await win.screenshot({ path: path.join(shots, 'session-view-04-split.png') });
  }, 180_000);
});
