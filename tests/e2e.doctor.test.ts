/**
 * Electron end-to-end for `/doctor`: the app answers it itself and prints its runtime report into the
 * transcript as one multi-line note, so no message reaches the harness. Runs with a fresh userData
 * directory and no provider key — the report is read off the real `app:doctor` handler, which is the
 * half a mocked invoke cannot prove — and asserts the rendered line breaks, which is the half jsdom
 * cannot see. Requires `npm run build` first; gated by VOCS_CODE_E2E_UI=1.
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

describe.runIf(enabled)('electron e2e: /doctor', () => {
  it('prints one multi-line report in the transcript and sends nothing to the harness', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-doctor-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    const session: SessionMeta = {
      id: 's_doctor',
      title: 'Doctor',
      createdAt: T,
      updatedAt: T,
      config: { harness: 'native', projectRoot: project, permissionMode: 'ask' },
      cwd: project,
      status: 'idle',
      harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
    };
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session]));

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

    await win.fill('.composer textarea', '/doctor');
    await win.press('.composer textarea', 'Enter');

    // Runtimes are probed for real (a missing CLI is a process spawn), so the note appears as a
    // placeholder first and is replaced once main answers.
    const note = win.locator('.transcript .info-line');
    await expect.poll(() => note.first().innerText(), { timeout: 120_000 }).toContain('Harnesses (');
    const text = await note.first().innerText();
    expect(text).toContain('Vocs Code');
    expect(text).toContain('Providers');
    expect(text).toContain('userData:');
    expect(text).toContain('Settings → About & doctor');
    // Rendered as separate lines: a stale `white-space` rule would collapse the report into one line.
    expect(text).toContain('\n');

    // One note — the placeholder was replaced, not stacked — and the command never became a prompt.
    expect(await note.count()).toBe(1);
    expect(await win.locator('.transcript .msg').count()).toBe(0);
    expect(await win.locator('.composer textarea').inputValue()).toBe('');
  }, 240_000);
});
