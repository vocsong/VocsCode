/**
 * End-to-end flow for the Processes panel against the built app and the real OS process table:
 * a process an earlier run left behind (seeded in the saved list) is found on launch, badged on the
 * tab before it is opened, listed as left behind with the session it belonged to, and ended from
 * the panel; a shell opened in the session's terminal is listed under that session and ending its
 * row really ends it. No harness and no provider key is involved. Requires `npm run build`; gated
 * by VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { createProcessSource } from '../src/main/process-snapshot';
import type { SessionMeta } from '../src/shared/types';
import { isolatedEnv, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
let app: ElectronApplication | null = null;
let leftover: number | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
  if (leftover) {
    try {
      process.kill(leftover);
    } catch {
      /* already ended, as the suite expects */
    }
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.runIf(enabled)('electron e2e: processes', () => {
  it('finds what an earlier run left behind, tracks a session terminal, and ends both', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-code-e2e-processes-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    const id = 's_processes';
    const session = {
      id,
      title: 'Nightly batch',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      config: { harness: 'native', projectRoot: project, permissionMode: 'ask' },
      cwd: project,
      status: 'idle',
      harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
      queued: 0
    } as SessionMeta;
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session]));
    await fs.mkdir(path.join(userData, 'sessions', id), { recursive: true });
    await fs.writeFile(path.join(userData, 'sessions', id, 'transcript.jsonl'), '');

    // A long-running job an earlier run started and never stopped. It is recorded in the saved
    // list the way the tracker saves it: by PID and the OS's own creation time.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'vocs-e2e-leftover'], { detached: true, stdio: 'ignore' });
    child.unref();
    await new Promise((resolve) => child.once('spawn', resolve));
    leftover = child.pid!;
    const reader = createProcessSource(path.join(root, 'resources', 'processes', 'windows-process-snapshot.ps1'));
    const seen = (await reader.snapshot()).find((p) => p.pid === leftover);
    const command = process.platform === 'win32' ? (await reader.commandLines([leftover])).get(leftover) : seen?.command;
    reader.close();
    expect(seen?.startedAt, 'the reader sees the seeded process').toBeGreaterThan(0);
    await fs.writeFile(
      path.join(userData, 'processes.json'),
      JSON.stringify({ version: 1, savedAt: Date.now(), processes: [{ pid: leftover, ppid: seen!.ppid, startedAt: seen!.startedAt, name: seen!.name, command, owner: { sessionId: id } }] })
    );

    const packaged = process.env.HARNESS_E2E_EXE;
    app = await electron.launch({
      executablePath: packaged || (require('electron') as string),
      args: packaged ? [`--user-data-dir=${userData}`] : [path.join(root, 'out', 'main', 'index.js')],
      env: isolatedEnv(userData),
      timeout: 60_000
    });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });
    await win.locator('[data-testid="session-row"]').first().click();

    // The background sample finds the leftover and badges the tab before anyone opens it.
    const badge = win.getByTestId('processes-orphaned-count');
    await badge.waitFor({ timeout: 120_000 });
    expect(await badge.innerText()).toBe('1');

    await win.getByTestId('panel-bottom-processes').click();
    await win.getByTestId('processes-tab').waitFor({ timeout: 30_000 });
    const leftBehind = win.getByTestId('process-group-orphaned');
    const leftoverRow = leftBehind.locator(`[data-testid="process-row"][data-pid="${leftover}"]`);
    await leftoverRow.waitFor({ timeout: 30_000 });
    expect(await leftoverRow.innerText()).toContain('earlier run');
    expect(await leftoverRow.innerText()).toContain('from Nightly batch');

    // A shell opened in the session's terminal is the app's process, listed under that session.
    await win.click('.panel-tab:has-text("Terminal")');
    // The tab may open a shell by itself; open one only if it did not.
    await win.waitForSelector('.term-tab', { timeout: 5_000 }).catch(() => win.getByRole('button', { name: 'New terminal' }).first().click());
    await win.waitForSelector('.term-tab', { timeout: 20_000 });
    const tabs = await win.locator('.term-tab').count();
    const sessionGroup = win.getByTestId('process-group-session');
    const shellRows = sessionGroup.locator('[data-testid="process-row"]', { hasText: /Terminal · / });
    // One row per open shell, each named for its tab.
    await expect.poll(async () => shellRows.count(), { timeout: 30_000 }).toBe(tabs);
    const shellRow = shellRows.first();
    expect(await sessionGroup.innerText()).toContain('Nightly batch');
    const shellPid = Number(await shellRow.getAttribute('data-pid'));
    expect(alive(shellPid)).toBe(true);

    // Ending the row ends the real shell, and the row goes with it.
    await shellRow.getByTestId('process-end').click();
    await expect.poll(() => alive(shellPid), { timeout: 20_000 }).toBe(false);
    await expect.poll(async () => win.locator(`[data-testid="process-row"][data-pid="${shellPid}"]`).count(), { timeout: 20_000 }).toBe(0);

    // Ending the left-behind group takes a confirming second click, then ends the real process.
    const endAll = win.getByTestId('process-group-end-orphaned');
    await endAll.click();
    expect(alive(leftover)).toBe(true);
    await expect.poll(async () => endAll.innerText()).toBe('Confirm');
    await endAll.click();
    await expect.poll(() => alive(leftover!), { timeout: 20_000 }).toBe(false);
    await expect.poll(async () => win.getByTestId('process-group-orphaned').count(), { timeout: 20_000 }).toBe(0);
    await expect.poll(async () => badge.count(), { timeout: 30_000 }).toBe(0);

    await app.close();
    app = null;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }, 300_000);
});
