/**
 * Electron end-to-end for the transcript's layers of collapse: a turn's tool calls, commentary and
 * thinking sit behind one "Worked for …" header, the answer stays visible, commands render as
 * compact rows that expand into a shell panel. The session and transcript are seeded on disk, so
 * no harness and no provider key are involved. Requires `npm run build` first; gated by
 * VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';
import { expectQuietWindow, isolatedEnv, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

const SID = 's_transcript_e2e';
const T = Date.now() - 600_000;

/** One finished turn: commentary, a lone command, a two-command run, a read, and the answer. */
function transcript(): TranscriptItem[] {
  return [
    { id: 'u1', kind: 'user', ts: T, text: 'Resolve the npm run update EBUSY failure.' },
    {
      id: 'a1',
      kind: 'assistant',
      ts: T + 1,
      text: 'npm install is trying to replace Electron’s default_app.asar, but an Electron process still has that file open. I’ll find the exact processes first.',
      thinking: 'Enumerate electron processes and read their command lines before killing anything.'
    },
    {
      id: 'c1',
      kind: 'tool',
      ts: T + 2,
      name: 'shell',
      hint: 'execute',
      summary: 'Get-Process electron,node -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path',
      output: '94884 node    C:\\Program Files\\nodejs\\node.exe\n97720 node    C:\\Users\\vocs\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua\\node.exe',
      status: 'done',
      durationMs: 1200
    },
    { id: 'a2', kind: 'assistant', ts: T + 3, text: 'A blanket kill would be unsafe, so I am resolving the three orphaned trees precisely.' },
    {
      id: 'c2',
      kind: 'tool',
      ts: T + 4,
      name: 'shell',
      hint: 'execute',
      summary: 'Get-CimInstance Win32_Process | Where-Object { $_.Name -in @(\'electron.exe\',\'node.exe\') } | Select-Object ProcessId,CommandLine',
      output: '51964  "node" "…\\node_modules\\electron\\cli.js" tests/e2e.ui',
      status: 'done',
      durationMs: 800
    },
    {
      id: 'c3',
      kind: 'tool',
      ts: T + 5,
      name: 'shell',
      hint: 'execute',
      summary: '$ids=@(51964,73228,73716); Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ProcessId } | Stop-Process -Force',
      output: 'Terminated 51964, 73228, 73716',
      status: 'done',
      durationMs: 640
    },
    { id: 'r1', kind: 'tool', ts: T + 6, name: 'read_file', hint: 'read', summary: 'package.json', status: 'done', durationMs: 40, output: '{ "name": "vocs-code" }' },
    {
      id: 'f1',
      kind: 'assistant',
      ts: T + 7,
      text: '## Done\n\n- **Task** — resolved the `npm run update` Electron EBUSY failure.\n- **Files** — no tracked source files changed.',
      phase: 'final'
    },
    { id: 'turn1', kind: 'turn', ts: T + 8, status: 'completed', durationMs: 197_000, costUsd: 0.04, usage: { inputTokens: 4200, outputTokens: 900 } }
  ];
}

describe.runIf(enabled)('electron e2e: transcript collapse layers', () => {
  it('keeps the answer visible, opens work on demand, and expands a command into its shell', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-transcript-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));

    const session: SessionMeta = {
      id: SID,
      title: 'Transcript collapse',
      createdAt: T,
      updatedAt: T,
      config: { harness: 'native', projectRoot: project, permissionMode: 'ask' },
      cwd: project,
      status: 'idle',
      harnessRef: {},
      usage: { inputTokens: 4200, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.04, turns: 1 }
    };
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session]));
    await fs.mkdir(path.join(userData, 'sessions', SID), { recursive: true });
    await fs.writeFile(path.join(userData, 'sessions', SID, 'transcript.jsonl'), transcript().map((i) => JSON.stringify(i)).join('\n') + '\n');

    const packaged = process.env.HARNESS_E2E_EXE;
    app = await electron.launch({
      executablePath: packaged || (require('electron') as string),
      args: packaged ? [`--user-data-dir=${userData}`] : [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`],
      env: isolatedEnv(userData),
      timeout: 60_000
    });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });
    await expectQuietWindow(app);
    await fs.mkdir(shots, { recursive: true });

    // Collapsed: the answer and the worked header are on screen, the work itself is not.
    await win.waitForSelector('.work-head', { timeout: 30_000 });
    expect(await win.locator('.work-head').innerText()).toContain('Worked for 3m 17s');
    expect(await win.locator('.msg-assistant .md').innerText()).toContain('Done');
    expect(await win.locator('.tool-card').count()).toBe(0);
    expect(await win.locator('.thinking-toggle').count()).toBe(0);
    await win.screenshot({ path: path.join(shots, 'transcript-01-collapsed.png') });

    // Expanded by the user: commentary and command rows appear, thinking stays collapsed.
    await win.locator('.work-head').click();
    expect(await win.locator('.msg-assistant').filter({ hasText: 'blanket kill' }).count()).toBe(1);
    expect(await win.locator('.tool-card').count()).toBe(2);
    await expect(win.locator('.tool-name').first().innerText()).resolves.toBe('Ran');
    expect(await win.locator('.tool-group-head').innerText()).toContain('Ran 2 commands');
    expect(await win.locator('.thinking-toggle').count()).toBe(1);
    expect(await win.locator('.thinking-body').count()).toBe(0);
    await win.screenshot({ path: path.join(shots, 'transcript-02-expanded.png') });

    // The command run opens into its two rows, and one row opens into the shell panel.
    await win.locator('.tool-group-head').click();
    expect(await win.locator('.tool-card').count()).toBe(4);
    await win.locator('.tool-card').filter({ hasText: 'Get-Process electron,node' }).locator('.tool-head').click();
    const shell = win.locator('.shell-card');
    await shell.waitFor({ timeout: 10_000 });
    expect(await shell.locator('.shell-bar').innerText()).toBe('Shell');
    expect(await shell.locator('.shell-cmd').innerText()).toContain('$ Get-Process electron,node');
    expect(await shell.locator('.tool-output').innerText()).toContain('94884 node');
    expect(await shell.locator('.shell-foot').innerText()).toContain('done');
    await win.screenshot({ path: path.join(shots, 'transcript-03-shell.png') });

    // Thinking opens on its own click, not with the work group.
    await win.locator('.thinking-toggle').click();
    expect(await win.locator('.thinking-body').innerText()).toContain('Enumerate electron processes');
  }, 120_000);
});
