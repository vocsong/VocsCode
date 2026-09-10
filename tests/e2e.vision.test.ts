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

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

/** 1x1 transparent PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

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
    await fs.mkdir(shots, { recursive: true });

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (k === 'ELECTRON_RUN_AS_NODE' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue;
      // No key means the turn cannot reach a provider, which is the point.
      if (/^(ANTHROPIC|OPENAI|DEEPSEEK|OPENROUTER|GEMINI|GROQ|XAI|MISTRAL)_API_KEY$/.test(k)) continue;
      env[k] = v;
    }
    env.VOCS_CODE_USER_DATA = userData;

    app = await electron.launch({ executablePath: require('electron') as string, args: [path.join(root, 'out', 'main', 'index.js')], env, timeout: 60_000 });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });

    // A DeepSeek model: the built-in catalog marks the whole provider text-only.
    await win.click('.sidebar-top button:has-text("New")');
    await win.waitForSelector('.modal');
    await win.fill('.ns-grid input[placeholder*="repo"]', project);
    await win.locator('.harness-card', { has: win.locator('.harness-card-name', { hasText: /^Native loop$/ }) }).click();
    const modelSelect = win.locator('.ns-grid .ns-col').nth(1).locator('select').first();
    await modelSelect.locator('option').nth(1).waitFor({ state: 'attached', timeout: 60_000 });
    await modelSelect.selectOption('deepseek::deepseek-v4-flash');
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
