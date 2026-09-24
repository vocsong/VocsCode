/**
 * Electron end-to-end for the delegated goal: a session whose harness owns `/goal` shows who has the
 * command in the Goal panel — plus the goal commands the session actually sent, read back out of its
 * transcript — instead of the app's own controls, while an ordinary session keeps them. Two sessions
 * are seeded on disk, so the whole thing is driven through the real UI with no harness and no provider
 * key. Requires `npm run build` first; gated by VOCS_CODE_E2E_UI=1.
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
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

const T = Date.now() - 60_000;

const session = (id: string, title: string, over: Partial<SessionMeta>): SessionMeta => ({
  id,
  title,
  createdAt: T,
  updatedAt: T,
  config: { harness: 'claude', projectRoot: '/seed', permissionMode: 'ask' },
  cwd: '/seed',
  status: 'idle',
  harnessRef: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
  ...over
});

describe.runIf(enabled)('electron e2e: delegated /goal', () => {
  it('shows the harness as the owner of /goal, and the app controls for a session that owns it', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-goal-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    await fs.writeFile(
      path.join(userData, 'sessions.json'),
      JSON.stringify([
        // Newest first: the delegated session is the one the app opens with.
        session('s_goal_native', 'Harness goal', { config: { harness: 'claude', projectRoot: project, permissionMode: 'ask' }, cwd: project, nativeGoal: 'goal', harnessCommands: ['compact', 'goal'] }),
        session('s_goal_app', 'App goal', { config: { harness: 'native', projectRoot: project, permissionMode: 'ask' }, cwd: project, goal: { objective: 'ship it', status: 'active', createdAt: T, updatedAt: T, iterations: 0, maxIterations: 25, autoContinue: true } })
      ])
    );
    // The harness keeps its own goal state, so the panel's only source is the transcript the app owns:
    // the goal command the session sent, and what the harness answered.
    const transcript: TranscriptItem[] = [
      { id: 'u_goal', kind: 'user', ts: T, text: '/goal ship the release by Friday' },
      { id: 'a_goal', kind: 'assistant', ts: T + 1, text: 'Goal set. Status: active.' }
    ];
    await fs.mkdir(path.join(userData, 'sessions', 's_goal_native'), { recursive: true });
    await fs.writeFile(path.join(userData, 'sessions', 's_goal_native', 'transcript.jsonl'), transcript.map((i) => JSON.stringify(i)).join('\n') + '\n');

    const packaged = process.env.HARNESS_E2E_EXE;
    app = await electron.launch({
      executablePath: packaged || (require('electron') as string),
      args: packaged ? [`--user-data-dir=${userData}`] : [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`],
      env: isolatedEnv(userData),
      timeout: 60_000
    });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });
    await expectQuietWindow(app);

    await win.click('.panel-tab:has-text("Goal")');
    const panel = win.locator('.goal');
    await panel.waitFor({ timeout: 30_000 });

    // The harness owns the command: say so, and offer nothing that would start a second goal.
    const text = await panel.innerText();
    expect(text).toContain('belongs to Claude Agent SDK');
    expect(text).toContain('Settings → Goal defaults');
    expect(await panel.locator('textarea').count()).toBe(0);
    expect(await panel.getByText('Set goal').count()).toBe(0);
    expect(await panel.getByText('Restart goal').count()).toBe(0);
    expect(await panel.getByText('Iteration guard').count()).toBe(0);

    // And it shows the goal the session sent, with the harness's own answer to it — the state the
    // harness keeps to itself reaches the app only as transcript text, and that is what is quoted.
    expect(text).toContain('/goal ship the release by Friday');
    expect(text).toContain('Goal set. Status: active.');
    expect(text).toContain('Current goal');

    // The other session is unchanged: the app's own goal, with its controls (its seeded goal is
    // active, so the primary button offers a restart rather than a first set).
    await win.getByTestId('session-row').filter({ hasText: 'App goal' }).click();
    await win.locator('.goal textarea').waitFor({ timeout: 30_000 });
    expect(await win.locator('.goal textarea').inputValue()).toBe('ship it');
    expect(await win.locator('.goal').getByText('Restart goal').count()).toBe(1);
    expect(await win.locator('.goal').getByText('Iteration guard').count()).toBeGreaterThan(0);

    // A mid-session /goal command is handled by the app, not forwarded as a literal harness
    // command: the objective changes and a separate kickoff appears in the transcript.
    await win.locator('.composer textarea').fill('/goal fix mid-session delivery');
    await win.locator('.composer textarea').press('Enter');
    await expect.poll(() => win.locator('.goal textarea').inputValue()).toBe('fix mid-session delivery');
    await win.getByText(/You have a persistent goal for this session:/).waitFor({ timeout: 30_000 });

    // And back: the delegated state is per session, not a one-way switch.
    await win.getByTestId('session-row').filter({ hasText: 'Harness goal' }).click();
    await win.locator('.goal').getByText(/belongs to Claude Agent SDK/).waitFor({ timeout: 30_000 });
    expect(await win.locator('.goal textarea').count()).toBe(0);
  }, 180_000);
});
