/**
 * Regression test for an empty model dropdown on a brand-new session. A harness process is only
 * spawned by the first message, so its `models` event does not exist before that; the header has to
 * fall back to the pre-session catalog instead of showing "no model list yet". Additional cases cover
 * the new-session dialog listing configured providers and both Codex harnesses' live runtime catalog.
 *
 * Requires `npm run build` first. Gated by VOCS_CODE_E2E_UI=1. Each session is seeded straight into a
 * fresh userData — the New Session dialog picks its folder through a native chooser Playwright cannot
 * drive, and a seeded session is the exact state under test: persisted, idle, never sent to. Every
 * provider key is stripped as well, so nothing leaves the machine and no turn can start.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { ProviderConfig, SessionMeta } from '../src/shared/types';
import { openNewSession, pickModel, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
const apps: ElectronApplication[] = [];

afterAll(async () => {
  for (const a of apps) await a.close().catch(() => undefined);
});

function session(id: string, harness: SessionMeta['config']['harness'], project: string): SessionMeta {
  return {
    id,
    title: `${harness} session`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    config: { harness, projectRoot: project, permissionMode: 'ask', useWorktree: false },
    cwd: project,
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    queued: 0
  };
}

/** Opens a harness card in the new-session dialog by its exact name. */
async function pickHarness(win: Page, name: RegExp): Promise<void> {
  await win.locator('.harness-card', { has: win.locator('.harness-card-name', { hasText: name }) }).click();
}

/** Launches the built app against a fresh userData with every provider key stripped. */
async function launch(userData: string): Promise<Page> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === 'ELECTRON_RUN_AS_NODE' || k === 'ELECTRON_RENDERER_URL' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue;
    if (/^(ANTHROPIC|OPENAI|DEEPSEEK|OPENROUTER|OPENCODE|GEMINI|GROQ|XAI|MISTRAL)_API_KEY$/.test(k)) continue;
    env[k] = v;
  }
  env.VOCS_CODE_USER_DATA = userData;
  // Keep the short-lived Claude model probe off the developer's real login. Claude Code may still
  // report its runtime catalog, but this suite never borrows account credentials or starts a turn.
  env.CLAUDE_CONFIG_DIR = path.join(userData, 'claude');
  // requestSingleInstanceLock() runs before VOCS_CODE_USER_DATA is applied, so a run started while
  // the app is open would exit silently; --user-data-dir is a Chromium switch and lands earlier.
  const args = [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`];
  const app = await electron.launch({ executablePath: require('electron') as string, args, env, timeout: 60_000 });
  apps.push(app);
  const win: Page = await app.firstWindow();
  await win.waitForSelector('.brand', { timeout: 60_000 });
  return win;
}

describe.runIf(enabled)('model picker before the first message', () => {
  it('lists models on a session whose harness has not been started', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-models-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# models e2e\n');
    await fs.mkdir(shots, { recursive: true });

    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session('s_fresh', 'native', project)]), 'utf8');
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project), 'utf8');

    const win = await launch(userData);
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
    // The row is named `provider/id`, and that qualified name is what the header pill then shows.
    const picked = (await first.locator('.mp-name').getAttribute('title')) ?? '';
    expect(picked).toContain('/');
    await first.click();
    await win.waitForSelector(`.pill[title="Model"]:has-text("${picked}")`, { timeout: 10_000 });

    // A gateway id that no catalog lists can still be typed and sticks: a bare id is adopted under
    // the provider already in use, and the pill names it that way.
    await win.click('.header-controls .pill[title="Model"]');
    const picker2 = win.locator('.model-picker');
    await picker2.waitFor({ timeout: 10_000 });
    await picker2.locator('.mp-search input').fill('acme-custom-1');
    await picker2.getByRole('button', { name: 'Use “acme-custom-1”' }).click();
    await win.waitForSelector(`.pill[title="Model"]:has-text("${picked.split('/')[0]}/acme-custom-1")`, { timeout: 10_000 });
  }, 180_000);

  it.each([
    { harness: 'codex', name: /^Codex \(app-server\)$/ },
    { harness: 'codex-exec', name: /^Codex \(exec SDK\)$/ }
  ] as const)('offers and selects the live $harness catalog in New Session', async ({ harness, name }) => {
    const tmp = path.join(os.tmpdir(), `vocs-code-${harness}-live-models-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, { providers: [] }), 'utf8');

    const win = await launch(userData);
    // Query the real main-process boundary, not a fixture or a renderer mock. A fallback catalog
    // must fail this live-runtime check even if it happens to contain the model we select below.
    const result = await win.evaluate(({ harness, projectRoot }) => window.harness.invoke('harness:models', { harness, projectRoot }), { harness, projectRoot: project });
    expect(result.error).toBeUndefined();
    expect(result.models.length).toBeGreaterThan(0);
    const expected = result.models.map((m) => `${m.provider}/${m.id}`).sort();

    await openNewSession(win);
    await pickHarness(win, name);
    const picker = win.locator('.ns-col-model .model-picker');
    await expect.poll(async () => picker.locator('.mp-row .mp-name').evaluateAll((els) => els.map((el) => el.getAttribute('title')).sort()), { timeout: 60_000 }).toEqual(expected);
    // The dialog makes its own discovery request: it must not silently display a fallback either.
    expect(await picker.locator('.menu-empty').count()).toBe(0);

    const picked = expected[expected.length - 1]!;
    await pickModel(win, picked);
    await expect.poll(async () => picker.locator('.mp-row.active .mp-name').getAttribute('title'), { timeout: 10_000 }).toBe(picked);
    expect(await picker.locator('.mp-row.active').count()).toBe(1);
  }, 180_000);

  it('offers a configured provider model for the Codex harness', async () => {
    // A codex session cannot reach OpenRouter on its own; the dialog catalog has to merge the
    // provider the user configured in Settings, and the adapter registers it on start (covered
    // offline in codex-provider.test.ts). Here the user-visible outcome is the picker entry.
    const tmp = path.join(os.tmpdir(), `vocs-code-codex-models-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# codex models e2e\n');
    await fs.writeFile(
      path.join(userData, 'settings.json'),
      seedSettings(project, {
        providers: [{ id: 'openrouter', enabled: true, models: [{ id: 'z-ai/glm-4.6', provider: 'openrouter', displayName: 'GLM 4.6', supportsImages: false }] }]
      }),
      'utf8'
    );
    await fs.mkdir(shots, { recursive: true });

    const win = await launch(userData);
    await openNewSession(win);
    await pickHarness(win, /^Codex \(app-server\)$/);
    await pickModel(win, 'openrouter/z-ai/glm-4.6');

    const picker = win.locator('.ns-col-model .model-picker');
    await expect.poll(async () => picker.locator('.mp-row.active .mp-name[title="openrouter/z-ai/glm-4.6"]').count(), { timeout: 10_000 }).toBe(1);
    await win.screenshot({ path: path.join(shots, 'models-02-codex-openrouter.png') });
  }, 180_000);

  it('offers an Anthropic-compatible provider\u2019s models to the Claude harness', async () => {
    // Claude Code only speaks the Anthropic API: a mapped vendor (OpenRouter, DeepSeek) or an added
    // Anthropic-compatible gateway has to appear in the new-session dialog for the Claude harness.
    const tmp = path.join(os.tmpdir(), `vocs-code-claude-models-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# claude models e2e\n');
    await fs.mkdir(shots, { recursive: true });

    const gateway: ProviderConfig = {
      id: 'zai',
      kind: 'anthropic',
      name: 'Z.AI (GLM)',
      baseUrl: 'https://api.z.ai/api/anthropic',
      hasApiKey: false,
      models: [{ id: 'glm-4.6', provider: 'zai', displayName: 'GLM-4.6' }],
      enabled: true
    };
    const openrouter: ProviderConfig = {
      id: 'openrouter',
      kind: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      hasApiKey: false,
      models: [{ id: 'z-ai/glm-4.6', provider: 'openrouter', displayName: 'GLM 4.6' }],
      enabled: true
    };
    await fs.writeFile(
      path.join(userData, 'settings.json'),
      seedSettings(project, { providers: [gateway, openrouter], claude: { runtime: 'bundled', useProviderKey: false, settingSources: [] } }),
      'utf8'
    );

    const win = await launch(userData);
    await openNewSession(win);
    await pickHarness(win, /^Claude Agent SDK$/);
    const picker = win.locator('.ns-col-model .model-picker');
    await picker.locator('.mp-row').first().waitFor({ timeout: 60_000 });
    await expect.poll(async () => picker.locator('.mp-name[title="anthropic/claude-opus-5-5[1m]"]').count(), { timeout: 20_000 }).toBe(1);
    await expect.poll(async () => picker.locator('.mp-row:has(.mp-name[title="anthropic/claude-opus-5-5[1m]"])').innerText(), { timeout: 20_000 }).toContain('Opus 5.5');
    await expect.poll(async () => picker.locator('.mp-name[title="zai/glm-4.6"]').count(), { timeout: 20_000 }).toBe(1);
    await expect.poll(async () => picker.locator('.mp-name[title="openrouter/z-ai/glm-4.6"]').count(), { timeout: 20_000 }).toBe(1);

    // SDK aliases and the recommended default can resolve to the same explicit choice; every
    // selectable provider/id must appear once.
    const catalogIds = await picker.locator('.mp-row .mp-name').evaluateAll((els) => els.map((el) => el.getAttribute('title')));
    expect(catalogIds).not.toContain(null);
    expect(new Set(catalogIds).size).toBe(catalogIds.length);

    // Claude's recommendation opens selected under the concrete id it resolves to, so a session
    // started without touching the picker is pinned to a version, never the moving `default` alias.
    expect(catalogIds).not.toContain('anthropic/default');
    const activeIds = () => picker.locator('.mp-row.active .mp-name').evaluateAll((els) => els.map((el) => el.getAttribute('title')));
    await expect.poll(activeIds, { timeout: 10_000 }).toEqual([expect.stringMatching(/^anthropic\/claude-/)]);
    expect(await picker.locator('.mp-row.active').innerText()).toContain('(recommended)');

    // A newly advertised Claude model is selectable under its explicit id, whether or not it is
    // today's recommendation.
    await pickModel(win, 'anthropic/claude-opus-5-5[1m]');
    await expect.poll(async () => picker.locator('.mp-row.active .mp-name[title="anthropic/claude-opus-5-5[1m]"]').count(), { timeout: 10_000 }).toBe(1);

    // The dialog starts on a listed model only: the header accepts a typed custom id after start,
    // but here the search must not offer one, so it can never leak into a new session's config.
    await picker.locator('.mp-search input').fill('acme-custom-1');
    await picker.locator('.mp-clear').waitFor({ timeout: 10_000 });
    expect(await picker.getByRole('button', { name: 'Use “acme-custom-1”' }).count()).toBe(0);
    await picker.locator('.mp-clear').click();

    await pickModel(win, 'openrouter/z-ai/glm-4.6');

    await expect.poll(async () => picker.locator('.mp-row.active .mp-name[title="openrouter/z-ai/glm-4.6"]').count(), { timeout: 10_000 }).toBe(1);
    await win.screenshot({ path: path.join(shots, 'models-03-claude-providers.png') });
  }, 180_000);

  it('disables reasoning effort for a Claude model the runtime lists without it', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-claude-effort-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# claude effort e2e\n');
    await fs.mkdir(shots, { recursive: true });
    await fs.writeFile(
      path.join(userData, 'settings.json'),
      seedSettings(project, { providers: [], defaultEffort: 'high', claude: { runtime: 'bundled', useProviderKey: false, settingSources: [] } }),
      'utf8'
    );

    const win = await launch(userData);
    // Which models take effort is the runtime's answer (Haiku 4.5 takes none today), so read it the
    // way the dialog does instead of hard-coding a model.
    const { models } = await win.evaluate(({ projectRoot }) => window.harness.invoke('harness:models', { harness: 'claude', projectRoot }), { projectRoot: project });
    const withEffort = models.find((m) => m.provider === 'anthropic' && m.supportedEfforts?.length);
    const without = models.find((m) => m.provider === 'anthropic' && m.supportedEfforts?.length === 0);
    expect(withEffort, 'the runtime lists a Claude model that takes effort').toBeDefined();
    expect(without, 'the runtime lists a Claude model that takes none').toBeDefined();

    await openNewSession(win);
    await pickHarness(win, /^Claude Agent SDK$/);
    const effort = win.locator('.ns-col-model .field', { has: win.locator('.field-label', { hasText: /^Reasoning effort$/ }) }).locator('select');
    await pickModel(win, `anthropic/${withEffort!.id}`);
    await expect.poll(() => effort.isEnabled(), { timeout: 10_000 }).toBe(true);
    expect(await effort.locator('option').evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value))).toEqual(['', ...withEffort!.supportedEfforts!]);

    await pickModel(win, `anthropic/${without!.id}`);
    await expect.poll(() => effort.isDisabled(), { timeout: 10_000 }).toBe(true);
    expect(await effort.locator('option').allInnerTexts()).toEqual(['Not supported']);

    // Started without a prompt, so no harness process exists; the header reads the same catalog.
    await win.getByRole('button', { name: /Start session/ }).click();
    const pill = win.locator('.header-controls .pill[aria-label="Reasoning effort"]');
    await expect.poll(async () => pill.count(), { timeout: 60_000 }).toBe(1);
    expect(await pill.isDisabled()).toBe(true);
    expect(await pill.getAttribute('title')).toContain('does not support reasoning effort');
    const sessions = await win.evaluate(() => window.harness.invoke('sessions:list', undefined));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].config.effort).toBeNull();
    expect((await win.evaluate(() => window.harness.invoke('settings:get', undefined))).defaultEffort).toBe('high');
    const saved = JSON.parse(await fs.readFile(path.join(userData, 'sessions.json'), 'utf8')) as SessionMeta[];
    expect(saved).toHaveLength(1);
    expect(saved[0].config.effort).toBeNull();
    await win.screenshot({ path: path.join(shots, 'models-04-claude-no-effort.png') });
  }, 180_000);
});
