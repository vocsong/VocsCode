/**
 * End-to-end approval flow: native harness in Ask mode → the agent proposes write_file →
 * an approval card appears → the test clicks "Allow once" → the file exists on disk and the
 * tool card shows the diff. Gated by HARNESS_E2E=1; needs DEEPSEEK_API_KEY or OPENAI_API_KEY.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication } from 'playwright-core';

const enabled = process.env.HARNESS_E2E === '1' && !!(process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY);
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

describe.runIf(enabled)('electron e2e: approvals', () => {
  it('shows an approval card in Ask mode and applies the change after Allow', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-desk-e2e-approval-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# approval project\n');
    await fs.mkdir(shots, { recursive: true });

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'ANTHROPIC_BASE_URL' && k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_')) env[k] = v;
    env.VOCS_DESK_USER_DATA = userData;

    app = await electron.launch({ executablePath: require('electron') as string, args: [path.join(root, 'out', 'main', 'index.js')], env, timeout: 60_000 });
    const win = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });

    await win.click('.sidebar-top button:has-text("New")');
    await win.waitForSelector('.modal');
    await win.fill('.ns-grid input[placeholder*="repo"]', project);
    await win.locator('.harness-card', { has: win.locator('.harness-card-name', { hasText: /^Native loop$/ }) }).click();
    const right = win.locator('.ns-grid .ns-col').nth(1);
    const modelSelect = right.locator('select').first();
    await modelSelect.locator('option').nth(1).waitFor({ state: 'attached', timeout: 60_000 });
    await modelSelect.selectOption(process.env.DEEPSEEK_API_KEY ? 'deepseek::deepseek-v4-flash' : 'openai::gpt-5.4-mini');
    // Permissions select is the third select in the right column (model, effort, permissions).
    await right.locator('select').nth(2).selectOption('ask');
    await win.fill('textarea[placeholder="What should the agent do?"]', 'Use the write_file tool to create a file named approved.txt containing exactly: approved by vocs desk. Do not run any other tool. Then reply DONE.');
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
    expect(content).toMatch(/approved by vocs desk/i);

    // Tool card recorded the change; Changes panel shows the new file.
    expect(await win.locator('.tool-card').count()).toBeGreaterThanOrEqual(1);
    await win.click('.panel-tab:has-text("Changes")');
    await win.waitForSelector('.changes, .empty', { timeout: 10_000 }); // no git repo here → empty state
    await win.screenshot({ path: path.join(shots, 'e2e-06-approval-applied.png') });
    // Header shows the session title next to the status dot (layout regression check).
    const title = await win.locator('.header-name').innerText();
    expect(title.length).toBeGreaterThan(3);
  });
});
