/**
 * End-to-end terminal flow: launches the built app, creates a session (no prompt, so no harness or
 * API key is needed), opens the Terminal tab, types a command into the real PTY and checks that it
 * ran in the project directory; then opens a second tab, reloads the renderer (the shells must
 * survive), closes a tab and exits a shell. Requires `npm run build`. Gated by HARNESS_E2E=1.
 * Set HARNESS_E2E_EXE to a packaged binary (dist/win-unpacked/Vocs Code.exe) to run the same flow
 * against the electron-builder output, which proves node-pty loads from the unpacked asar.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { openNewSession, seedSettings } from './e2e-ui';

const enabled = process.env.HARNESS_E2E === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

async function waitForFile(file: string, ms: number): Promise<string> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const text = await fs.readFile(file, 'utf8');
      // A shell redirect creates the file before it writes the line, so wait for content too.
      if (text.length) return text;
    } catch {
      /* not there yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${file}`);
}

describe.runIf(enabled)('electron e2e: terminal', () => {
  it('types into a real PTY, keeps shells across a reload, closes and exits tabs', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-e2e-terminal-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# terminal project\n');
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    await fs.mkdir(shots, { recursive: true });

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'ANTHROPIC_BASE_URL' && k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_')) env[k] = v;
    env.VOCS_CODE_USER_DATA = userData;
    env.VOCS_CODE_DEBUG = '1';

    const packaged = process.env.HARNESS_E2E_EXE;
    app = await electron.launch({
      executablePath: packaged || (require('electron') as string),
      // The single-instance lock is taken before VOCS_CODE_USER_DATA applies; the Chromium switch isolates a packaged run.
      args: packaged ? [`--user-data-dir=${userData}`] : [path.join(root, 'out', 'main', 'index.js')],
      env,
      timeout: 60_000
    });
    expect(await app.evaluate(({ app: electronApp }) => electronApp.getName())).toBe('Vocs Code');
    const mainLog: string[] = [];
    app.process().stdout?.on('data', (d: Buffer) => mainLog.push(d.toString()));
    app.process().stderr?.on('data', (d: Buffer) => mainLog.push(d.toString()));
    let win: Page = await app.firstWindow();
    // Only now is there a window to ask: launch() resolves as soon as the main process is up.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle())).toBe('Vocs Code');
    const consoleLines: string[] = [];
    const watch = (p: Page) => {
      p.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
      p.on('pageerror', (err) => consoleLines.push(`[pageerror] ${err.message}`));
    };
    watch(win);
    await win.waitForSelector('.brand', { timeout: 60_000 });

    try {
      // A session with no prompt: nothing is sent to a harness, so this runs without any API key.
      await openNewSession(win);
      await win.locator('.harness-card', { has: win.locator('.harness-card-name', { hasText: /^Native loop$/ }) }).click();
      await win.click('button:has-text("Start session")');
      await win.waitForSelector('.header', { timeout: 30_000 });

      // A `!` draft with no terminal yet opens one and runs the command there; the agent is not involved.
      await win.fill('.composer textarea', '!echo first-bang > first-bang.txt');
      await win.press('.composer textarea', 'Enter');
      const firstBang = await waitForFile(path.join(project, 'first-bang.txt'), 20_000);
      expect(firstBang.replace(/\0|﻿|�/g, '')).toMatch(/first-bang/);

      // The Terminal tab now shows that shell; xterm mounts with its hidden textarea.
      await win.click('.panel-tab:has-text("Terminal")');
      await win.waitForSelector('.term-tab', { timeout: 20_000 });
      await win.waitForSelector('.term-view .xterm .xterm-helper-textarea', { timeout: 20_000 });
      expect(await win.locator('.term-tab').count()).toBe(1);

      // Keystrokes reach the PTY and the shell runs in the project directory.
      await win.locator('.xterm-helper-textarea').focus();
      await win.waitForTimeout(1500); // let the shell print its prompt
      await win.keyboard.type('echo ok > vocs-marker.txt');
      await win.keyboard.press('Enter');
      const marker = await waitForFile(path.join(project, 'vocs-marker.txt'), 20_000);
      // Windows PowerShell redirects as UTF-16LE with a BOM; strip the NULs so the match is shell-agnostic.
      expect(marker.replace(/\0|﻿|�/g, '')).toMatch(/ok/);
      await win.screenshot({ path: path.join(shots, 'e2e-07-terminal.png') });

      // The tab strip shows the shell's directory; "send to agent" drops the screen into the composer.
      expect(await win.locator('.term-cwd').innerText()).toBe('project');
      await win.click('button[aria-label="Send output to agent"]');
      await expect.poll(async () => win.locator('.composer textarea').inputValue(), { timeout: 10_000 }).toMatch(/Terminal output \(.*\):\n```\n[\s\S]*vocs-marker\.txt[\s\S]*\n```/);
      await win.fill('.composer textarea', ''); // leave the composer as we found it

      // A draft starting with ! runs in the session's terminal instead of going to the agent.
      await win.fill('.composer textarea', '!echo bang-ok > bang-marker.txt');
      await win.press('.composer textarea', 'Enter');
      const bang = await waitForFile(path.join(project, 'bang-marker.txt'), 20_000);
      expect(bang.replace(/\0|﻿|�/g, '')).toMatch(/bang-ok/);
      await expect.poll(async () => win.locator('.composer textarea').inputValue(), { timeout: 10_000 }).toBe('');
      expect(await win.locator('.term-tab').count()).toBe(1); // reused the open terminal rather than spawning one

      // A second tab, then a renderer reload: the shells live in main and come back.
      await win.click('.term-new button[aria-label="New terminal"]');
      // The renderer CSP forbids eval, so poll with a locator instead of page.waitForFunction.
      await expect.poll(async () => win.locator('.term-tab').count(), { timeout: 20_000 }).toBe(2);
      await win.reload();
      await win.waitForSelector('.brand', { timeout: 60_000 });
      await win.click('.panel-tab:has-text("Terminal")');
      await win.waitForSelector('.term-tab', { timeout: 20_000 });
      await expect.poll(async () => win.locator('.term-tab').count(), { timeout: 20_000 }).toBe(2);
      await win.waitForSelector('.term-view .xterm .xterm-helper-textarea', { timeout: 20_000 });
      await win.screenshot({ path: path.join(shots, 'e2e-08-terminal-reload.png') });

      // Close the active tab with its ×; exit the remaining shell by typing `exit`.
      await win.locator('.term-tab.active .term-tab-close').click();
      await expect.poll(async () => win.locator('.term-tab').count(), { timeout: 10_000 }).toBe(1);
      await win.locator('.xterm-helper-textarea').focus();
      await win.waitForTimeout(500);
      await win.keyboard.type('exit');
      await win.keyboard.press('Enter');
      await expect.poll(async () => win.locator('.term-tab').count(), { timeout: 20_000 }).toBe(0);
      await win.waitForSelector('.term .empty', { timeout: 10_000 });
    } catch (e) {
      await win.screenshot({ path: path.join(shots, 'e2e-fail-terminal.png') }).catch(() => undefined);
      const tail = (arr: string[], n: number) => arr.slice(-n).join('\n');
      console.error(`[e2e terminal] failure\nrenderer console:\n${tail(consoleLines.filter((l) => !l.startsWith('[debug]')), 30)}\nmain log:\n${tail(mainLog.join('').split('\n').filter((l) => !l.includes(' DEBUG ')), 30)}`);
      throw e;
    }
  });
});
