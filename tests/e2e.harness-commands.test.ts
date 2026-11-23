/**
 * Electron end-to-end for harness-native slash commands: the `/` popover offers the commands the
 * harness last reported beside the app's own, under the harness's name, survives a restart (the list
 * is read back from sessions.json), and lends that list to a same-project session whose harness has
 * not started yet. Nothing is sent: picking completes, and `/help` answers in the transcript. No
 * harness runtime or provider key is needed. Requires `npm run build` first; gated by VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { SessionMeta } from '../src/shared/types';
import { expectQuietWindow, isolatedEnv, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

const T = Date.now() - 60_000;

describe.runIf(enabled)('electron e2e: harness slash commands', () => {
  it('lists the harness’s own commands, completes a partial name, and lends the list to a fresh sibling', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-harness-commands-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    const base = (id: string, title: string, updatedAt: number, over: Partial<SessionMeta> = {}): SessionMeta => ({
      id, title, createdAt: T, updatedAt,
      config: { harness: 'claude', projectRoot: project, permissionMode: 'ask' },
      cwd: project, status: 'idle', harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
      ...over
    });
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([
      // Newest first: the reporting session is the one the app opens with.
      base('s_reported', 'Reported', T + 2, {
        harnessCommands: ['review', 'deploy', 'pr'],
        harnessCommandList: [
          { name: 'review', description: 'Review a pull request', argumentHint: '[pr]', kind: 'command' },
          { name: 'deploy', description: 'Ship it to an environment', argumentHint: '<env>', kind: 'skill' },
          { name: 'pr', description: 'My own PR skill', kind: 'skill' }
        ]
      }),
      base('s_fresh', 'Fresh', T + 1)
    ]));

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

    const box = win.locator('.composer textarea');
    const rows = win.locator('.slash-popover .slash-item[data-source="harness"] .slash-name');
    await box.fill('/');
    await win.locator('.slash-popover').waitFor({ timeout: 30_000 });
    // A bare `/` leads with what only this harness has; the app's own commands follow.
    expect(await win.locator('.slash-popover .slash-section').allInnerTexts()).toEqual(['CLAUDE AGENT SDK', 'VOCS CODE']);
    expect(await win.locator('.slash-popover .slash-item').first().locator('.slash-name').innerText()).toBe('/review');
    expect(await rows.allInnerTexts()).toEqual(['/review', '/deploy', '//pr']);
    expect(await win.locator('.slash-popover .slash-item[data-source="harness"] .slash-kind').allInnerTexts()).toEqual(['skill', 'skill']);

    // Enter on a partial name completes it; nothing is sent.
    await box.fill('/dep');
    await box.press('Enter');
    expect(await box.inputValue()).toBe('/deploy ');
    expect(await win.locator('.transcript .msg').count()).toBe(0);

    // /help answers in the transcript with the harness's commands.
    await box.fill('/help');
    await box.press('Enter');
    await expect.poll(() => win.locator('.transcript .info-line').first().innerText(), { timeout: 30_000 }).toContain('Claude Agent SDK: /review /deploy //pr');

    // A same-project session whose harness never started borrows the list.
    await win.locator('.session-row', { hasText: 'Fresh' }).first().click();
    await box.fill('/rev');
    await win.locator('.slash-popover').waitFor({ timeout: 30_000 });
    expect(await rows.allInnerTexts()).toEqual(['/review']);
  }, 240_000);
});
