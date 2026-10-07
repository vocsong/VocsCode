/**
 * Split view through the real window: two seeded sessions in different worktrees side by side, the
 * Files panel following the active pane without mixing the two, a dragged divider, a split that
 * survives quitting and relaunching, and a closed pane that leaves its session in place. The sessions
 * are seeded on disk, so no harness and no provider key are involved. Requires `npm run build`
 * first; gated by VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
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
let tmp: string | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

const T = Date.now() - 600_000;

function seeded(id: string, title: string, project: string, cwd: string, harness: SessionMeta['config']['harness'], text: string): { meta: SessionMeta; items: TranscriptItem[] } {
  return {
    meta: {
      id,
      title,
      createdAt: T,
      updatedAt: T,
      config: { harness, projectRoot: project, permissionMode: 'ask' },
      cwd,
      status: 'idle',
      harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
    },
    items: [
      { id: `${id}-u`, kind: 'user', ts: T, text },
      { id: `${id}-a`, kind: 'assistant', ts: T + 1, text: `${title} answer`, phase: 'final' }
    ]
  };
}

async function launch(userData: string): Promise<Page> {
  app = await electron.launch({
    executablePath: require('electron') as string,
    args: [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`],
    env: isolatedEnv(userData),
    timeout: 60_000
  });
  const win = await app.firstWindow();
  await win.waitForSelector('.brand', { timeout: 60_000 });
  // Checked before the resize below, which grows the parked window back towards the screen.
  await expectQuietWindow(app);
  // Room for the sidebar, the panel and two panes above their minimum width.
  await win.setViewportSize({ width: 1600, height: 900 });
  return win;
}

const pane = (win: Page, i: number) => win.locator('[data-testid="session-pane"]').nth(i);

describe.runIf(enabled)('electron e2e: split view', () => {
  it('shows two sessions side by side, follows the active pane, resizes, restores and closes', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-split-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    const wtA = path.join(project, 'wt-architecture');
    const wtB = path.join(project, 'wt-tests');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(shots, { recursive: true });
    for (const dir of [wtA, wtB]) await fs.mkdir(dir, { recursive: true });
    // One file per worktree: the Files panel must list exactly the active pane's.
    await fs.writeFile(path.join(wtA, 'architecture-only.txt'), 'a\n');
    await fs.writeFile(path.join(wtB, 'tests-only.txt'), 'b\n');
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    const a = seeded('s_split_a', 'Architecture', project, wtA, 'claude', 'Design the state machine');
    const b = seeded('s_split_b', 'Integration tests', project, wtB, 'codex', 'Run the integration tests');
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([a.meta, b.meta]));
    for (const s of [a, b]) {
      await fs.mkdir(path.join(userData, 'sessions', s.meta.id), { recursive: true });
      await fs.writeFile(path.join(userData, 'sessions', s.meta.id, 'transcript.jsonl'), s.items.map((i) => JSON.stringify(i)).join('\n') + '\n');
    }

    let win = await launch(userData);
    await win.locator(`.session-row[data-session-id="${a.meta.id}"]`).click();
    await expect.poll(() => pane(win, 0).locator('.transcript').innerText(), { timeout: 15_000 }).toContain('Design the state machine');
    expect(await win.locator('[data-testid="session-pane"]').count(), 'one pane until the user splits').toBe(1);
    expect(await win.locator('.pane-divider').count()).toBe(0);

    // Split right, then pick the second session from the sidebar: it lands in the new pane.
    await pane(win, 0).getByRole('button', { name: 'Split right' }).click();
    await expect.poll(() => win.locator('[data-testid="session-pane"]').count(), { timeout: 10_000 }).toBe(2);
    await expect.poll(() => pane(win, 1).innerText()).toContain('Open a session in this pane');
    await win.locator(`.session-row[data-session-id="${b.meta.id}"]`).click();
    await expect.poll(() => pane(win, 1).locator('.transcript').innerText(), { timeout: 15_000 }).toContain('Run the integration tests');
    expect(await pane(win, 0).locator('.transcript').innerText()).toContain('Design the state machine');
    expect(await win.locator('.composer textarea').count(), 'each pane has its own composer').toBe(2);
    const left = await pane(win, 0).boundingBox();
    const right = await pane(win, 1).boundingBox();
    expect(left && right && right.x >= left.x + left.width - 1, 'the panes sit side by side').toBe(true);
    expect(left!.width).toBeGreaterThan(360);
    expect(right!.width).toBeGreaterThan(360);
    await win.screenshot({ path: path.join(shots, 'split-01-side-by-side.png') });

    // The Files panel follows the active pane, and never mixes the two worktrees.
    await win.locator('.panel-tab:has-text("Files")').click();
    await expect.poll(() => win.locator('.file-list').innerText(), { timeout: 10_000 }).toContain('tests-only.txt');
    expect(await win.locator('.file-list').innerText()).not.toContain('architecture-only.txt');
    await pane(win, 0).locator('.transcript').click();
    await expect.poll(() => win.locator('.file-list').innerText(), { timeout: 10_000 }).toContain('architecture-only.txt');
    expect(await win.locator('.file-list').innerText()).not.toContain('tests-only.txt');
    expect(await pane(win, 0).getAttribute('class')).toContain('active');

    // Typing in a pane makes it the active one and leaves the other composer untouched.
    await pane(win, 1).locator('.composer textarea').fill('draft for the tests pane');
    expect(await pane(win, 0).locator('.composer textarea').inputValue()).toBe('');
    await expect.poll(() => pane(win, 1).getAttribute('class')).toContain('active');
    await expect.poll(() => win.locator('.file-list').innerText(), { timeout: 10_000 }).toContain('tests-only.txt');

    // Drag the divider right: the left pane grows, and the right one stops at its minimum width.
    const divider = await win.locator('.pane-divider').boundingBox();
    await win.mouse.move(divider!.x + divider!.width / 2, divider!.y + divider!.height / 2);
    await win.mouse.down();
    await win.mouse.move(divider!.x + 400, divider!.y + divider!.height / 2, { steps: 8 });
    await win.mouse.up();
    await expect.poll(async () => (await pane(win, 0).boundingBox())!.width, { timeout: 5_000 }).toBeGreaterThan(left!.width + 60);
    expect((await pane(win, 1).boundingBox())!.width, 'a pane is never dragged below its minimum').toBeGreaterThanOrEqual(359);
    const resizedLeft = (await pane(win, 0).boundingBox())!.width;

    // Quit and relaunch on the same profile: the split, its sessions and its shares come back.
    await app!.close();
    app = null;
    win = await launch(userData);
    await expect.poll(() => win.locator('[data-testid="session-pane"]').count(), { timeout: 20_000 }).toBe(2);
    await expect.poll(() => pane(win, 0).locator('.transcript').innerText(), { timeout: 15_000 }).toContain('Design the state machine');
    await expect.poll(() => pane(win, 1).locator('.transcript').innerText(), { timeout: 15_000 }).toContain('Run the integration tests');
    expect(Math.abs((await pane(win, 0).boundingBox())!.width - resizedLeft)).toBeLessThan(12);
    expect(await pane(win, 1).getAttribute('class'), 'the pane that was active is active again').toContain('active');
    expect(await pane(win, 0).getAttribute('class')).not.toContain('active');
    // The panel opens on its default tab after a launch; Files still shows the active pane's worktree.
    await win.locator('.panel-tab:has-text("Files")').click();
    await expect.poll(() => win.locator('.file-list').innerText(), { timeout: 10_000 }).toContain('tests-only.txt');

    // Closing a pane only removes it from the layout; the session stays listed and untouched.
    await pane(win, 1).getByRole('button', { name: 'Close pane' }).click();
    await expect.poll(() => win.locator('[data-testid="session-pane"]').count(), { timeout: 10_000 }).toBe(1);
    expect(await win.locator('.pane-divider').count()).toBe(0);
    expect(await win.locator(`.session-row[data-session-id="${b.meta.id}"]`).count()).toBe(1);
    const stored = JSON.parse(await fs.readFile(path.join(userData, 'sessions.json'), 'utf8')) as SessionMeta[];
    expect(stored.find((s) => s.id === b.meta.id)?.archived ?? false).toBe(false);
    await win.screenshot({ path: path.join(shots, 'split-02-closed.png') });
  }, 240_000);
});
