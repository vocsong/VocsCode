/**
 * Regression test for an empty model dropdown on a brand-new session. A harness process is only
 * spawned by the first message, so its `models` event does not exist before that; the header has to
 * fall back to the process-free catalog instead of showing "no model list yet".
 *
 * Requires `npm run build` first. Gated by VOCS_CODE_E2E_UI=1. The session is seeded straight into a
 * fresh userData — the New Session dialog picks its folder through a native chooser Playwright cannot
 * drive, and a seeded session is the exact state under test: persisted, idle, never sent to. Every
 * provider key is stripped as well: the native catalog is built from settings, so nothing leaves the
 * machine and no turn can start.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { SessionMeta } from '../src/shared/types';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

describe.runIf(enabled)('model picker before the first message', () => {
  it('lists models on a session whose harness has not been started', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-models-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# models e2e\n');
    await fs.mkdir(shots, { recursive: true });

    const session: SessionMeta = {
      id: 's_fresh',
      title: 'New session',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      config: { harness: 'native', projectRoot: project, permissionMode: 'ask', useWorktree: false },
      cwd: project,
      status: 'idle',
      harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
      queued: 0
    };
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session]), 'utf8');
    await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ onboardingDone: true }), 'utf8');

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (k === 'ELECTRON_RUN_AS_NODE' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue;
      if (/^(ANTHROPIC|OPENAI|DEEPSEEK|OPENROUTER|GEMINI|GROQ|XAI|MISTRAL)_API_KEY$/.test(k)) continue;
      env[k] = v;
    }
    env.VOCS_CODE_USER_DATA = userData;

    // requestSingleInstanceLock() runs before VOCS_CODE_USER_DATA is applied, so a run started while
    // the app is open would exit silently; --user-data-dir is a Chromium switch and lands earlier.
    const args = [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`];
    app = await electron.launch({ executablePath: require('electron') as string, args, env, timeout: 60_000 });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.header', { timeout: 60_000 });
    // Nothing was ever sent, so the harness never spawned: this is the state that used to be empty.
    expect(await win.locator('.transcript .item').count()).toBe(0);

    await win.click('.header-controls .pill[title="Model"]');
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
    const picked = (await first.locator('.mp-name').getAttribute('title')) ?? '';
    expect(picked).toContain('/');
    await first.click();
    await win.waitForSelector(`.pill[title="Model"]:has-text("${picked.split('/').slice(1).join('/')}")`, { timeout: 10_000 });
  }, 180_000);
});
