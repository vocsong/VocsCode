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
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { expectQuietWindow, openNewSession, seedSettings } from './e2e-ui';

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
    // Isolate git's global/system config so the guided "tell git who you are" step is deterministic
    // even on a machine that already has a user.name (CI runners, dev boxes).
    env.GIT_CONFIG_GLOBAL = path.join(tmp, 'gitconfig');
    env.GIT_CONFIG_NOSYSTEM = '1';

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
    // Suites run off-screen and inactive so a test run does not disturb the desktop; the app's
    // window is the thing to check, since that is invisible from the page.
    await expectQuietWindow(app);
    const consoleLines: string[] = [];
    const watch = (p: Page) => {
      p.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
      p.on('pageerror', (err) => consoleLines.push(`[pageerror] ${err.message}`));
    };
    watch(win);
    await win.waitForSelector('.brand', { timeout: 60_000 });

    // The per-folder New session control must be findable before the pointer goes anywhere near
    // it: a 0-opacity icon reads as absent to anyone scanning the sidebar.
    const newSession = win.getByTestId('new-session').first();
    await newSession.waitFor({ timeout: 60_000 });
    expect(await newSession.evaluate((el) => getComputedStyle(el).opacity), 'the New session icon is visible without hover').toBe('1');
    // And it reads as "new session" (a chat bubble with a plus), not a bare plus.
    expect(await newSession.locator('svg').getAttribute('data-icon'), 'the New session control uses the session-plus icon').toBe('sessionPlus');

    try {
      // A session with no prompt: nothing is sent to a harness, so this runs without any API key.
      await openNewSession(win);
      await win.locator('.harness-card', { has: win.locator('.harness-card-name', { hasText: /^Native loop$/ }) }).click();
      await win.click('button:has-text("Start session")');
      await win.waitForSelector('.header', { timeout: 30_000 });

      // The MCP tab ships GitNexus built in: on by default, scoped to this repo, not shared.
      await win.click('.panel-tab:has-text("MCP")');
      const builtin = win.locator('.mcp-section', { has: win.locator('h3', { hasText: 'Built-in' }) });
      await builtin.waitFor({ timeout: 20_000 });
      expect(await builtin.innerText()).toContain('gitnexus');
      const builtinToggles = builtin.locator('input[type="checkbox"]');
      expect(await builtinToggles.nth(0).isChecked()).toBe(true); // enabled by default
      expect(await builtinToggles.nth(1).isChecked()).toBe(false); // not shared globally

      // The MCP page chooses between one shared server and per-repo servers; the repo tab follows.
      await win.click('.sidebar-link:has-text("MCP")');
      await win.waitForSelector('.mcp-page', { timeout: 20_000 });
      await win.click('.mcp-page button:has-text("One shared server")');
      await win.locator('[data-testid="session-row"]').first().click();
      await win.click('.panel-tab:has-text("MCP")');
      await expect
        .poll(async () => builtin.innerText(), { timeout: 20_000 })
        .toContain('shared server');
      // Restore the default so the rest of the run is unaffected.
      await win.click('.sidebar-link:has-text("MCP")');
      await win.waitForSelector('.mcp-page', { timeout: 20_000 });
      await win.click('.mcp-page button:has-text("Per-repo servers")');
      await win.locator('[data-testid="session-row"]').first().click();

      // The project is a brand-new folder, so the Git tab guides setup. Initializing turns the
      // guide into the branches view with the GitHub continuation; the first commit runs through
      // real git, proving the panel's actions reach the repository rather than only its own state.
      await win.click('.panel-tab:has-text("Git")');
      await win.waitForSelector('.git-setup', { timeout: 20_000 });
      expect(await win.locator('.git-setup-title').innerText()).toBe('Set up git in this folder');
      await win.click('.git-setup button:has-text("Initialize repository")');
      await win.waitForSelector('.git-setup-banner', { timeout: 20_000 });
      expect(await win.locator('.git-setup-banner .git-setup-title').innerText()).toBe('Publish this repository to GitHub');
      await fs.stat(path.join(project, '.git')); // the repository exists on disk, not just in the UI

      // With no global git identity, the commit step must ask for a name and email instead of
      // surfacing git's "Author identity unknown" — and the commit must carry them.
      await win.getByLabel('Your name').fill('Vocs Code E2E');
      await win.getByLabel('Your email').fill('e2e@example.com');
      await win.click('.git-setup-banner button:has-text("Save and commit")');
      await expect
        .poll(
          () => {
            try {
              return execFileSync('git', ['-C', project, 'rev-parse', '--verify', 'HEAD'], { stdio: 'pipe' }).toString().trim().length > 0;
            } catch {
              return false;
            }
          },
          { timeout: 20_000 }
        )
        .toBe(true);
      expect(execFileSync('git', ['-C', project, 'log', '-1', '--format=%an <%ae>'], { stdio: 'pipe' }).toString().trim()).toBe('Vocs Code E2E <e2e@example.com>');
      expect(await win.locator('.git-setup-banner').innerText()).toContain('Connect a GitHub repository');

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

      // A killed renderer must not leave a blank window: main logs it and reloads automatically,
      // and the reloaded page paints the app again — without restarting the main process. The
      // Playwright page object for a crashed target stays crashed, so prove recovery through main.
      const electronApp = app;
      const mainPid = await electronApp.evaluate(() => process.pid);
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer());
      await expect
        .poll(
          async () =>
            electronApp.evaluate(async ({ BrowserWindow }) => {
              const wc = BrowserWindow.getAllWindows()[0]?.webContents;
              if (!wc || wc.isDestroyed() || wc.isLoading()) return false;
              try {
                return (await wc.executeJavaScript("Boolean(document.querySelector('.brand'))")) === true;
              } catch {
                return false;
              }
            }),
          { timeout: 60_000 }
        )
        .toBe(true);
      expect(await electronApp.evaluate(() => process.pid)).toBe(mainPid);
      expect(mainLog.join('')).toMatch(/ERROR renderer process gone: crashed/);
    } catch (e) {
      await win.screenshot({ path: path.join(shots, 'e2e-fail-terminal.png') }).catch(() => undefined);
      const tail = (arr: string[], n: number) => arr.slice(-n).join('\n');
      console.error(`[e2e terminal] failure\nrenderer console:\n${tail(consoleLines.filter((l) => !l.startsWith('[debug]')), 30)}\nmain log:\n${tail(mainLog.join('').split('\n').filter((l) => !l.includes(' DEBUG ')), 30)}`);
      throw e;
    }
  });
});
