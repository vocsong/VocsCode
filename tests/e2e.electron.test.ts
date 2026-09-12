/**
 * End-to-end test: launches the built Electron app with Playwright, creates a session through
 * the real UI, sends a prompt and waits for the assistant's reply. Requires `npm run build` first.
 * Gated by HARNESS_E2E=1. Harness under test: HARNESS_E2E_HARNESS (native | codex | pi | claude),
 * default native (needs DEEPSEEK_API_KEY or OPENAI_API_KEY in the environment).
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';

const enabled = process.env.HARNESS_E2E === '1';
const harness = process.env.HARNESS_E2E_HARNESS ?? 'native';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

const CARD_NAMES: Record<string, string> = {
  native: 'Native loop',
  codex: 'Codex (app-server)',
  'codex-exec': 'Codex (exec SDK)',
  cursor: 'Cursor',
  pi: 'Pi',
  claude: 'Claude Agent SDK',
  acp: 'ACP agent (DeepSeek Harness, ...)'
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe.runIf(enabled)('electron e2e', () => {
  it(`creates a ${harness} session through the UI and gets a reply`, async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-e2e-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# e2e project\n');
    try {
      execSync('git init -q && git add -A && git -c user.email=e2e@example.com -c user.name=e2e commit -qm init', {
        cwd: project,
        stdio: 'ignore',
        shell: process.platform === 'win32' ? 'bash' : undefined
      });
    } catch {
      /* git optional */
    }
    await fs.mkdir(shots, { recursive: true });

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (k === 'ELECTRON_RUN_AS_NODE' || k === 'ANTHROPIC_BASE_URL' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue;
      env[k] = v;
    }
    env.VOCS_CODE_USER_DATA = userData;
    env.VOCS_CODE_DEBUG = '1';

    app = await electron.launch({ executablePath: require('electron') as string, args: [path.join(root, 'out', 'main', 'index.js')], env, timeout: 60_000 });
    const mainLog: string[] = [];
    app.process().stdout?.on('data', (d: Buffer) => mainLog.push(d.toString()));
    app.process().stderr?.on('data', (d: Buffer) => mainLog.push(d.toString()));
    const win: Page = await app.firstWindow();
    const consoleLines: string[] = [];
    win.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
    win.on('pageerror', (err) => consoleLines.push(`[pageerror] ${err.message}`));
    await win.waitForSelector('.brand', { timeout: 60_000 });
    await win.screenshot({ path: path.join(shots, 'e2e-01-empty.png') });

    try {
      await runScenario(win, project);
    } catch (e) {
      await win.screenshot({ path: path.join(shots, `e2e-fail-${harness}.png`) }).catch(() => undefined);
      const toasts = await win.locator('.toast').allInnerTexts().catch(() => []);
      const tail = (arr: string[], n: number) => arr.slice(-n).join('\n');
      console.error(`[e2e ${harness}] failure\ntoasts=${JSON.stringify(toasts)}\nrenderer console:\n${tail(consoleLines.filter((l) => !l.startsWith('[debug]')), 30)}\nmain log:\n${tail(mainLog.join('').split('\n').filter((l) => !l.includes(' DEBUG ')), 30)}`);
      throw e;
    }
  });
});

async function runScenario(win: Page, project: string): Promise<void> {
  // New session dialog
  await win.click('.sidebar-top button:has-text("New")');
  await win.waitForSelector('.modal');
  await win.fill('.ns-grid input[placeholder*="repo"]', project);
  const cardName = CARD_NAMES[harness] ?? 'Native loop';
  await win.locator('.harness-card', { has: win.locator('.harness-card-name', { hasText: new RegExp(`^${escapeRe(cardName)}$`) }) }).click();
  const right = win.locator('.ns-grid .ns-col').nth(1);
  const modelSelect = right.locator('select').first();
  // The renderer CSP forbids eval, so wait with a locator instead of page.waitForFunction.
  await modelSelect.locator('option').nth(1).waitFor({ state: 'attached', timeout: 60_000 });
  if (harness === 'native') {
    const wanted = process.env.DEEPSEEK_API_KEY ? 'deepseek::deepseek-v4-flash' : process.env.OPENAI_API_KEY ? 'openai::gpt-5.4-mini' : 'anthropic::claude-sonnet-5';
    await modelSelect.selectOption(wanted);
  }
  await win.fill('textarea[placeholder="What should the agent do?"]', 'Reply with exactly the single word PONG and nothing else. Do not use tools.');
  await win.screenshot({ path: path.join(shots, `e2e-02-${harness}-dialog.png`) });
  await win.click('button:has-text("Start session")');
  await win.waitForSelector('.header', { timeout: 30_000 });
  await win.waitForSelector('.msg-user', { timeout: 30_000 });

  await win.waitForSelector('.msg-assistant .md:has-text("PONG")', { timeout: 170_000 });
  await win.waitForSelector('.turn-footer', { timeout: 60_000 });
  await win.screenshot({ path: path.join(shots, `e2e-03-${harness}-reply.png`) });

  // Header pills reflect model + mode; usage pill exists; Changes tab renders git state.
  expect(await win.locator('.pill').count()).toBeGreaterThanOrEqual(3);
  const title = await win.locator('.header-name').innerText();
  expect(title.length).toBeGreaterThan(3);
  await win.click('.panel-tab:has-text("Changes")');
  await win.waitForSelector('.changes', { timeout: 10_000 });
  await win.click('.panel-tab:has-text("Usage")');
  await win.waitForSelector('.stat-grid');
  const costText = await win.locator('.stat').first().innerText();
  expect(costText).toMatch(/\$/);
  await win.screenshot({ path: path.join(shots, `e2e-04-${harness}-usage.png`) });

  // Session persisted in the sidebar; transcript contains the reply exactly once (no delta duplication).
  const rows = await win.locator('.session-row').count();
  expect(rows).toBe(1);
  const reply = await win.locator('.msg-assistant .md').first().innerText();
  expect(reply.trim()).toMatch(/^PONG[.!]?$/i);

  // Layout must stay inside the viewport at the smallest window the app allows (minHeight 600,
  // so the web contents are smaller still). body is overflow:hidden, so anything that pushes the
  // document taller than the viewport becomes unreachable rather than scrollable.
  const OVERFLOW_PROBE = `(() => {
    const d = document.documentElement;
    const clipped = [];
    for (const el of document.querySelectorAll('.app, .main, .sidebar, .panel, .settings, .settings-nav')) {
      const oy = getComputedStyle(el).overflowY;
      const over = el.scrollHeight - el.clientHeight;
      if (over > 2 && oy !== 'auto' && oy !== 'scroll') clipped.push(el.className + ' +' + over + 'px');
    }
    return { docOverflow: d.scrollHeight - d.clientHeight, clipped };
  })()`;
  for (const size of [
    { width: 960, height: 600 },
    { width: 1100, height: 620 }
  ]) {
    await win.setViewportSize(size);
    await win.waitForTimeout(300);
    for (const view of ['.sidebar-link:has-text("Settings")', '.brand']) {
      await win.click(view).catch(() => undefined);
      await win.waitForTimeout(300);
      const r = (await win.evaluate(OVERFLOW_PROBE)) as { docOverflow: number; clipped: string[] };
      expect(`${size.width}x${size.height} ${view} docOverflow=${r.docOverflow}`).toContain('docOverflow=0');
      expect(r.clipped).toEqual([]);
    }
  }
}
