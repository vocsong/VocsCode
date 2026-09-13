/**
 * End-to-end approval flow: native harness in Ask mode → the agent proposes write_file →
 * an approval card appears → the test clicks "Allow once" → the file exists on disk and the
 * tool card shows the diff, then the fallback grep worker verifies the file. Supports the
 * packaged executable. Gated by HARNESS_E2E=1; needs DEEPSEEK_API_KEY or OPENAI_API_KEY.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { openNewSession, pickModel, seedSettings } from './e2e-ui';

const wantE2E = process.env.HARNESS_E2E === '1';
const hasProviderKey = !!(process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY);
const enabled = wantE2E && hasProviderKey;
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

// A HARNESS_E2E=1 run without a provider key must fail loudly, not exit green having tested nothing.
describe.runIf(wantE2E && !hasProviderKey)('electron e2e: approvals (misconfigured)', () => {
  it('requires DEEPSEEK_API_KEY or OPENAI_API_KEY', () => {
    throw new Error('HARNESS_E2E=1 but no provider API key found. Set DEEPSEEK_API_KEY or OPENAI_API_KEY before running tests/e2e.approval.test.ts.');
  });
});

describe.runIf(enabled)('electron e2e: approvals', () => {
  it('shows an approval card in Ask mode and applies the change after Allow', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-e2e-approval-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# approval project\n');
    await fs.mkdir(shots, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'ANTHROPIC_BASE_URL' && k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_')) env[k] = v;
    env.VOCS_CODE_USER_DATA = userData;
    // Exercise the packaged JavaScript grep worker, not a machine-specific ripgrep.
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    env.PATH = '';

    const packaged = process.env.HARNESS_E2E_EXE;
    app = await electron.launch({ executablePath: packaged || require('electron') as string, args: packaged ? [] : [path.join(root, 'out', 'main', 'index.js')], env, timeout: 60_000 });
    const win = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });

    await openNewSession(win);
    await win.locator('.harness-card', { has: win.locator('.harness-card-name', { hasText: /^Native loop$/ }) }).click();
    await pickModel(win, process.env.DEEPSEEK_API_KEY ? 'deepseek/deepseek-v4-flash' : 'openai/gpt-5.4-mini');
    // Permissions is the second select in the model column (effort, permissions).
    await win.locator('.ns-col-model select').nth(1).selectOption('ask');
    await win.fill('textarea[placeholder="What should the agent do?"]', 'Use write_file exactly once to create approved.txt containing exactly approved by vocs code (no newline). Then use grep exactly once with pattern "approved" and path "approved.txt" to verify it. Do not run other tools or narrate. Reply with exactly DONE.');
    await win.click('button:has-text("Start session")');

    // The approval card must appear and the file must NOT exist yet.
    await win.waitForSelector('.approval.pending', { timeout: 170_000 });
    await expect(fs.access(path.join(project, 'approved.txt'))).rejects.toBeTruthy();
    await win.screenshot({ path: path.join(shots, 'e2e-05-approval-pending.png') });
    const card = win.locator('.approval.pending').first();
    expect(await card.innerText()).toMatch(/approved\.txt|write_file/);

    await card.locator('button:has-text("Allow once")').click();
    await win.waitForSelector('.approval.decided', { timeout: 30_000 });
    await win.waitForSelector('.turn-footer', { timeout: 170_000 });
    const content = await fs.readFile(path.join(project, 'approved.txt'), 'utf8');
    expect(content).toBe('approved by vocs code');
    expect(await win.locator('.turn-footer').count()).toBe(1);
    expect(await win.locator('.turn-footer').innerText()).toMatch(/complete/i);
    expect(await win.locator('.turn-footer').innerText()).not.toMatch(/failed|interrupted/i);

    // Tool card recorded the change; Changes panel shows the new file.
    expect(await win.locator('.tool-card').count()).toBe(2);
    expect(await win.locator('.tool-name').allTextContents()).toEqual(['write_file', 'grep']);
    const grep = win.locator('.tool-card').filter({ has: win.locator('.tool-name', { hasText: /^grep$/ }) });
    expect(await grep.innerText()).toContain('done');
    await grep.getByRole('button').first().click();
    expect(await grep.innerText()).toContain('approved by vocs code');
    await win.click('.panel-tab:has-text("Changes")');
    await win.waitForSelector('.changes, .empty', { timeout: 10_000 }); // no git repo here → empty state
    await win.screenshot({ path: path.join(shots, 'e2e-06-approval-applied.png') });
    // Header shows the session title next to the status dot (layout regression check).
    const title = await win.getByTestId('session-title').innerText();
    expect(title.length).toBeGreaterThan(3);
  });
});
