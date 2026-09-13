/**
 * End-to-end test for the text-only-model warning and the capability override, driven through the
 * real UI. Requires `npm run build` first. Gated by VOCS_CODE_E2E_UI=1.
 *
 * Deliberately runs with every provider key stripped from the environment and a fresh userData
 * directory, so no request ever leaves the machine: the native harness emits its model list during
 * start() and only needs a key once a turn actually runs.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { openAnalytics, openNewSession, pickModel, seedSettings } from './e2e-ui';
import { AnalyticsStore } from '../src/main/analytics';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
const packaged = process.env.HARNESS_E2E_EXE;
const launchOptions = { executablePath: packaged || require('electron') as string, args: packaged ? [] : [path.join(root, 'out', 'main', 'index.js')] };
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

/** 1x1 transparent PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function isolatedEnv(userData: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === 'ELECTRON_RUN_AS_NODE' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue;
    if (/^(ANTHROPIC|OPENAI|DEEPSEEK|OPENROUTER|GEMINI|GROQ|XAI|MISTRAL)_API_KEY$/.test(k)) continue;
    env[k] = v;
  }
  env.VOCS_CODE_USER_DATA = userData;
  return env;
}

describe.runIf(enabled)('vision capability UI', () => {
  it('warns on a text-only model and lets the user override it', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-vision-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    const imageFile = path.join(tmp, 'shot.png');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# vision e2e\n');
    await fs.writeFile(imageFile, Buffer.from(PNG_BASE64, 'base64'));
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    await fs.mkdir(shots, { recursive: true });

    const env = isolatedEnv(userData);

    app = await electron.launch({ ...launchOptions, env, timeout: 60_000 });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });

    // A DeepSeek model: the built-in catalog marks the whole provider text-only.
    await openNewSession(win);
    await win.locator('.harness-card', { has: win.locator('.harness-card-name', { hasText: /^Native loop$/ }) }).click();
    await pickModel(win, 'deepseek/deepseek-v4-flash');
    await win.fill('textarea[placeholder="What should the agent do?"]', 'hello');
    await win.click('button:has-text("Start session")');
    await win.waitForSelector('.header', { timeout: 30_000 });
    // start() publishes the model list before the turn fails for the missing key.
    await win.waitForSelector('.pill:has-text("deepseek-v4-flash")', { timeout: 30_000 });

    // No attachment, no warning.
    expect(await win.locator('.composer-warn').count()).toBe(0);

    await win.setInputFiles('.composer-actions input[type=file]', imageFile);
    const warn = win.locator('.composer-warn');
    await warn.waitFor({ timeout: 10_000 });
    expect(await warn.innerText()).toContain('DeepSeek V4 Flash');
    expect(await warn.innerText()).toContain('text-only');
    // The native loop passes attachments through; only Pi strips them itself.
    expect(await warn.innerText()).toContain('may reject');
    await win.screenshot({ path: path.join(shots, 'vision-01-warning.png') });

    // Overriding the model clears the warning without dropping the attachment.
    await warn.locator('button:has-text("It does accept images")').click();
    await warn.waitFor({ state: 'detached', timeout: 10_000 });
    expect(await win.locator('.attachment').count()).toBe(1);

    // The override is persisted and listed in settings, where it can be removed again.
    const stored = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')) as { modelOverrides: Record<string, { supportsImages?: boolean }> };
    expect(stored.modelOverrides['deepseek/deepseek-v4-flash']).toEqual({ supportsImages: true });

    await win.click('.sidebar-bottom .sidebar-link:has-text("Settings")');
    await win.locator('.settings-link:has-text("Providers & keys")').click({ timeout: 20_000 });
    const row = win.locator('.override-row', { hasText: 'deepseek/deepseek-v4-flash' });
    await row.waitFor({ timeout: 10_000 });
    await row.scrollIntoViewIfNeeded();
    expect(await row.innerText()).toContain('accepts images');
    await win.screenshot({ path: path.join(shots, 'vision-02-settings.png') });

    await row.locator('button[title="Remove override"]').click();
    await row.waitFor({ state: 'detached', timeout: 10_000 });
    const after = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')) as { modelOverrides: Record<string, unknown> };
    expect(after.modelOverrides).toEqual({});
  }, 180_000);
});

describe.runIf(enabled)('analytics harness/tool reliability UI', () => {
  it('compares same-model harness calls, failures and denials across exact selected dates', async () => {
    await app?.close();
    app = null;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-code-analytics-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    const now = Date.now();
    const dayMs = 86_400_000;
    const dateOf = (ago: number) => new Date(now - ago * dayMs).toISOString().slice(0, 10);
    const sessions: SessionMeta[] = (['claude', 'pi'] as const).map((harness) => ({
      id: harness, title: `${harness} same-model workload`, createdAt: now - 40 * dayMs, updatedAt: now,
      config: { harness, projectRoot: project, permissionMode: 'ask' }, cwd: project, status: 'idle', harnessRef: {},
      activeModel: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
    }));
    // Seed through the production store; no sessions are started and no providers are contacted.
    const store = new AnalyticsStore(userData, { log: () => undefined });
    await store.load(sessions);
    let id = 0;
    const call = (session: string, name: string, status: Extract<TranscriptItem, { kind: 'tool' }>['status'], daysAgo: number) => {
      const ts = now - daysAgo * dayMs;
      store.recordToolCall(session, { id: String(++id), kind: 'tool', name, status, ts }, ts);
    };
    call('claude', 'Read', 'error', 40);
    call('claude', 'Read', 'done', 40);
    call('claude', 'Read', 'done', 10);
    call('claude', 'Read', 'done', 1);
    call('claude', 'read', 'error', 1);
    call('claude', 'Read', 'declined', 1);
    call('pi', 'read', 'done', 1);
    call('pi', 'Read', 'declined', 1);
    call('pi', 'bash', 'declined', 1);
    await store.flush();

    try {
      app = await electron.launch({
        ...launchOptions,
        env: isolatedEnv(userData), timeout: 60_000
      });
      const win = await app.firstWindow();
      await openAnalytics(win);
      await win.getByRole('tab', { name: 'Tools & files' }).click();
      const table = win.getByRole('table', { name: 'Harness/tool reliability' });
      const rows = () => table.getByRole('row').evaluateAll((els) => els.slice(1).map((row) => Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)));
      const expected = (claude: string[]) => [claude, ['Pi', 'read', '2', '0', '1', '0%'], ['Pi', 'bash', '1', '0', '1', '—']];
      await table.waitFor();
      expect(await table.getByRole('columnheader').allTextContents()).toEqual(['Harness', 'Tool', 'Calls', 'Errors', 'Declined', 'Error rate']);
      expect(await rows()).toEqual(expected(['Claude', 'read', '4', '1', '1', '33%']));
      expect(await win.getByText(/Recorded since update/).innerText()).toContain('same model and workload');
      expect(await win.getByText(/Error rate = errors/).innerText()).toContain('executed calls (calls − declined)');
      expect(await win.getByText(`last 30 days · ${dateOf(29)} – ${dateOf(0)}`).count()).toBe(1);

      await win.getByRole('radio', { name: '7 days', exact: true }).click();
      await win.getByText(`last 7 days · ${dateOf(6)} – ${dateOf(0)}`).waitFor();
      await expect.poll(rows).toEqual(expected(['Claude', 'read', '3', '1', '1', '50%']));
      expect(await win.getByRole('radio', { name: '7 days', exact: true }).getAttribute('aria-checked')).toBe('true');

      await win.getByRole('radio', { name: 'All time' }).click();
      await win.getByText(`all time · ${dateOf(40)} – ${dateOf(0)}`).waitFor();
      await expect.poll(rows).toEqual(expected(['Claude', 'read', '6', '2', '1', '40%']));
      await win.getByRole('radio', { name: '30 days', exact: true }).click();
      await win.getByText(`last 30 days · ${dateOf(29)} – ${dateOf(0)}`).waitFor();
      await expect.poll(rows).toEqual(expected(['Claude', 'read', '4', '1', '1', '33%']));
      // A real process restart with the same userData must preserve exact counters.
      await app.close();
      app = await electron.launch({ ...launchOptions, env: isolatedEnv(userData), timeout: 60_000 });
      const restarted = await app.firstWindow();
      await openAnalytics(restarted);
      await restarted.getByRole('tab', { name: 'Tools & files' }).click();
      await restarted.getByRole('radio', { name: 'All time' }).click();
      const restored = restarted.getByRole('table', { name: 'Harness/tool reliability' });
      await restored.waitFor();
      await expect.poll(() => restored.getByRole('row').evaluateAll((els) => els.slice(1).map((row) => Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent))))
        .toEqual(expected(['Claude', 'read', '6', '2', '1', '40%']));
    } finally {
      await app?.close();
      app = null;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 180_000);
});
