/**
 * End-to-end test for Settings → Pi, driven through the real UI. Requires `npm run build` first.
 * Gated by VOCS_CODE_E2E_UI=1 (the e2e guard sets it).
 *
 * The suite launches with PI_CODING_AGENT_DIR pointed at a temp agent dir seeded with one of every
 * resource type, so it can prove the page reads and rewrites pi's own files without touching the
 * user's real ~/.pi/agent.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { isolatedEnv, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const launchOptions = { executablePath: require('electron') as string, args: [path.join(root, 'out', 'main', 'index.js')] };
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

describe.runIf(enabled)('pi settings UI', () => {
  it('lists base-pi resources and writes toggles, preferences and prompt files', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-pi-settings-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    const agentDir = path.join(tmp, 'pi-agent');
    const pkgRoot = path.join(tmp, 'demo-pkg');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(path.join(agentDir, 'extensions'), { recursive: true });
    await fs.mkdir(path.join(agentDir, 'skills', 'demo'), { recursive: true });
    await fs.mkdir(path.join(agentDir, 'themes'), { recursive: true });
    await fs.mkdir(path.join(agentDir, 'agents'), { recursive: true });
    await fs.mkdir(path.join(pkgRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# pi e2e\n');
    await fs.writeFile(path.join(agentDir, 'extensions', 'goal.ts'), 'export default () => {};\n');
    await fs.writeFile(path.join(agentDir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo-skill\ndescription: Demo the thing\n---\n\nBody\n');
    await fs.writeFile(path.join(agentDir, 'themes', 'custom.json'), JSON.stringify({ name: 'custom-theme', colors: {} }));
    await fs.writeFile(path.join(agentDir, 'agents', 'Explore.md'), '---\nname: e2e-explore\ndescription: Read-only search\n---\nBody\n');
    await fs.writeFile(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: 'e2e-pkg', pi: { extensions: ['./src/index.ts'] } }));
    await fs.writeFile(path.join(pkgRoot, 'src', 'index.ts'), 'export default () => {};\n');
    await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ theme: 'dark', packages: [pkgRoot] }));
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));

    app = await electron.launch({ ...launchOptions, env: isolatedEnv(userData, { PI_CODING_AGENT_DIR: agentDir }), timeout: 60_000 });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });

    await win.click('.sidebar-bottom .sidebar-link:has-text("Settings")');
    await win.locator('.settings-link:has-text("Pi")').click({ timeout: 20_000 });
    await win.waitForSelector('.pi-head', { timeout: 20_000 });
    // The page must be explicit that it edits the real global pi config.
    await win.locator('.info-line.info-warn', { hasText: 'global pi settings' }).first().waitFor();

    const categories = win.getByRole('group', { name: 'Pi settings categories' });
    expect(await categories.getByRole('button', { name: 'Preferences', exact: true }).getAttribute('aria-pressed')).toBe('true');
    expect(await win.getByRole('combobox', { name: /Startup thinking level/ }).isVisible()).toBe(true);
    expect(await win.locator('.pi-prompt-editor').isVisible()).toBe(false);

    // Discovery: each category exposes its own resources without a page-long scroll.
    await categories.getByRole('button', { name: 'Resources', exact: true }).click();
    await win.locator('.pi-resource', { hasText: 'goal.ts' }).waitFor();
    await win.locator('.pi-resource', { hasText: 'demo-skill' }).waitFor();
    await win.locator('.pi-resource', { hasText: 'custom-theme' }).waitFor();
    await categories.getByRole('button', { name: 'Packages', exact: true }).click();
    await win.locator('.pi-package', { hasText: 'e2e-pkg' }).waitFor();
    await win.locator('.pi-package .pi-resource', { hasText: 'src/index.ts' }).waitFor();
    await categories.getByRole('button', { name: 'Subagents', exact: true }).click();
    await win.locator('.pi-resource', { hasText: 'e2e-explore' }).waitFor();

    const settingsPath = path.join(agentDir, 'settings.json');
    const readSettings = async (): Promise<Record<string, unknown>> => JSON.parse(await fs.readFile(settingsPath, 'utf8'));

    // Toggling a resource writes pi's own `-path` pattern.
    await categories.getByRole('button', { name: 'Resources', exact: true }).click();
    const skillRow = win.locator('.pi-resource', { hasText: 'demo-skill' });
    await skillRow.getByRole('checkbox', { name: /demo-skill/ }).press('Space');
    await expect.poll(async () => (await readSettings()).skills).toEqual(['-skills/demo/SKILL.md']);
    await expect.poll(async () => (await skillRow.getAttribute('class')) ?? '').toContain('disabled');

    // A preference lands under its pi settings key, preserving the theme.
    await categories.getByRole('button', { name: 'Preferences', exact: true }).click();
    await win.getByRole('combobox', { name: /Startup thinking level/ }).selectOption('low');
    await expect.poll(async () => (await readSettings()).defaultThinkingLevel).toBe('low');
    expect((await readSettings()).theme).toBe('dark');

    // Empty numeric fields remove overrides, and a valid zero remains visible after reopening.
    const reserve = win.getByRole('spinbutton', { name: /Reserve tokens/ });
    await reserve.fill('8192');
    await reserve.press('Tab');
    await expect.poll(async () => ((await readSettings()).compaction as { reserveTokens?: number })?.reserveTokens).toBe(8192);
    await reserve.fill('');
    await reserve.press('1');
    await reserve.press('e');
    expect(await reserve.evaluate((element: HTMLInputElement) => element.validity.badInput)).toBe(true);
    await reserve.press('Tab');
    const retries = win.getByRole('spinbutton', { name: 'Max retries', exact: true });
    await retries.fill('0');
    await retries.press('Tab');
    // This later write is a barrier: invalid numeric text must not have queued a deletion before it.
    await expect.poll(async () => ((await readSettings()).retry as { maxRetries?: number })?.maxRetries).toBe(0);
    expect(((await readSettings()).compaction as { reserveTokens?: number })?.reserveTokens).toBe(8192);
    expect(await reserve.inputValue()).toBe('8192');
    await reserve.fill('');
    await reserve.press('Tab');
    await expect.poll(async () => ((await readSettings()).compaction as { reserveTokens?: number })?.reserveTokens).toBeUndefined();
    const sections = win.getByRole('navigation', { name: 'Settings sections' });
    await sections.getByRole('button', { name: 'General', exact: true }).click();
    await sections.getByRole('button', { name: 'Pi', exact: true }).click();
    await expect.poll(() => retries.inputValue()).toBe('0');
    expect(await reserve.inputValue()).toBe('');

    // Drafts survive visiting another category before saving the selected prompt file.
    await categories.getByRole('button', { name: 'Prompts', exact: true }).click();
    await win.getByRole('group', { name: 'System prompt files' }).getByRole('button', { name: /AGENTS\.md/ }).click();
    const editor = win.getByRole('textbox', { name: 'AGENTS.md', exact: true });
    await editor.fill('# house rules\nBe brief.\n');
    await categories.getByRole('button', { name: 'Resources', exact: true }).click();
    expect(await win.locator('.pi-prompt-editor').count()).toBe(1);
    expect(await win.locator('.pi-prompt-editor').isVisible()).toBe(false);
    await categories.getByRole('button', { name: 'Prompts', exact: true }).click();
    expect(await editor.inputValue()).toBe('# house rules\nBe brief.\n');
    expect(await win.getByRole('button', { name: 'Save', exact: true }).isEnabled()).toBe(true);
    await win.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => fs.readFile(path.join(agentDir, 'AGENTS.md'), 'utf8').catch(() => '')).toBe('# house rules\nBe brief.\n');

    // A package resource toggle writes the package object filter pi itself uses.
    await categories.getByRole('button', { name: 'Packages', exact: true }).click();
    const pkgRow = win.locator('.pi-package .pi-resource', { hasText: 'src/index.ts' });
    expect(await pkgRow.getByRole('button').isDisabled()).toBe(true);
    await pkgRow.getByRole('checkbox', { name: /index\.ts/ }).press('Space');
    await expect.poll(async () => (await readSettings()).packages).toEqual([{ source: pkgRoot, extensions: ['-src/index.ts'] }]);

    // pi-subagents settings land in subagents.json.
    await categories.getByRole('button', { name: 'Subagents', exact: true }).click();
    await win.locator('.toggle', { hasText: 'Report subagent spend' }).click();
    const readSubagents = async (): Promise<Record<string, unknown>> => JSON.parse(await fs.readFile(path.join(agentDir, 'subagents.json'), 'utf8'));
    await expect.poll(readSubagents).toEqual({ reportUsage: true });
    const concurrent = win.getByRole('spinbutton', { name: /Max concurrent agents/ });
    await concurrent.fill('5');
    await concurrent.press('Tab');
    await expect.poll(readSubagents).toEqual({ reportUsage: true, maxConcurrent: 5 });
    await concurrent.fill('');
    await concurrent.press('Tab');
    await expect.poll(readSubagents).toEqual({ reportUsage: true });
  }, 120_000);
});
