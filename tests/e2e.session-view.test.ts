/**
 * Electron end-to-end for the session view's layout: a one-row header that carries the working
 * tree's changes, the compact context readout and options menus under the composer, a turn's work behind one
 * chip with its plan still on screen, the title bar's search and Vesta launcher, the sidebar's New
 * session entry, a header that sheds detail in a narrow split pane instead of overflowing it, and the
 * sidebar's activity tray reaching a session that finished unviewed in a collapsed folder, and the
 * sidebar's Recent view listing every folder's sessions in one recency order across a restart, picked
 * from a Projects | Recent switch at the top of the sidebar, with the Archived filter and the New
 * session icon beside it (Standard and Zen).
 * Layout cases use seeded sessions and transcripts. The title refresh case runs native chat against
 * a scripted loopback provider. No provider keys; screenshots land in tests/artifacts/session-view-*.png.
 * Requires `npm run build` first; gated by VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright-core';
import { MCP_BUILTIN_IDS, type ProviderConfig, type SessionMeta, type TranscriptItem } from '../src/shared/types';
import { HARNESSES } from '../src/shared/harness-meta';
import type { PushPayloads } from '../src/shared/ipc';
import { expectQuietWindow, isolatedEnv, openNewSession, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
let app: ElectronApplication | null = null;

afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = null;
});

const SID = 's_view_e2e';
const OTHER = 's_view_other';
const T = Date.now() - 600_000;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A committed project, then three uncommitted changes: one edit and two new files. */
async function seedProject(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'server.ts'), "export const port = 3000;\n");
  git(dir, 'init', '-q', '-b', 'main');
  // A throwaway fixture: commit under a local identity, whatever the machine has configured.
  git(dir, 'config', 'user.name', 'e2e');
  git(dir, 'config', 'user.email', 'e2e@example.invalid');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', 'feat/rate-limit');
  await fs.writeFile(path.join(dir, 'src', 'server.ts'), "export const port = 3000;\nexport const limit = 100;\n");
  await fs.writeFile(path.join(dir, 'src', 'rate-limit.ts'), 'export const windowMs = 60_000;\nexport const burst = 10;\n');
  await fs.writeFile(path.join(dir, 'src', 'rate-limit.test.ts'), 'export {};\n');
}

/** One finished turn whose work holds a plan update between its steps, edits with diffs and a command. */
function transcript(): TranscriptItem[] {
  return [
    { id: 'u1', kind: 'user', ts: T, text: 'Add rate limiting to the public API.' },
    { id: 'a1', kind: 'assistant', ts: T + 1, text: 'Reading the server first.' },
    { id: 't1', kind: 'tool', ts: T + 2, name: 'Read', hint: 'read', summary: 'src/server.ts', status: 'done', durationMs: 30 },
    { id: 'p1', kind: 'plan', ts: T + 3, entries: [{ content: 'Add the limiter', status: 'in_progress' }, { content: 'Wire it up', status: 'pending' }, { content: 'Test 429', status: 'pending' }] },
    { id: 't2', kind: 'tool', ts: T + 4, name: 'Write', hint: 'edit', summary: 'src/rate-limit.ts', status: 'done', changes: [{ path: 'src/rate-limit.ts', kind: 'add', diff: '--- /dev/null\n+++ b/src/rate-limit.ts\n@@ -0,0 +1,2 @@\n+export const windowMs = 60_000;\n+export const burst = 10;' }] },
    { id: 't3', kind: 'tool', ts: T + 5, name: 'Edit', hint: 'edit', summary: 'src/server.ts', status: 'done', changes: [{ path: 'src/server.ts', kind: 'update', diff: '--- a/src/server.ts\n+++ b/src/server.ts\n@@ -1 +1,2 @@\n export const port = 3000;\n+export const limit = 100;' }] },
    { id: 't4', kind: 'tool', ts: T + 6, name: 'Write', hint: 'edit', summary: 'src/rate-limit.test.ts', status: 'done', changes: [{ path: 'src/rate-limit.test.ts', kind: 'add' }] },
    { id: 'p2', kind: 'plan', ts: T + 7, entries: [{ content: 'Add the limiter', status: 'completed' }, { content: 'Wire it up', status: 'completed' }, { content: 'Test 429', status: 'completed' }] },
    { id: 't5', kind: 'tool', ts: T + 8, name: 'shell', hint: 'execute', summary: 'npm test -- rate-limit', status: 'done', exitCode: 0, durationMs: 4200, output: '6 passed' },
    { id: 'f1', kind: 'assistant', ts: T + 9, text: 'Rate limiting is in place on every `/v1` route.', phase: 'final' },
    { id: 'turn1', kind: 'turn', ts: T + 10, status: 'completed', durationMs: 154_000, costUsd: 0.61, usage: { inputTokens: 48_200, outputTokens: 6_100 } }
  ];
}

const usage = (patch: Partial<SessionMeta['usage']> = {}): SessionMeta['usage'] => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0, ...patch });

/** Overflow of an element's content past its own box, in px; 0 when everything fits. */
const overflowX = (win: Page, selector: string) => win.locator(selector).evaluateAll((els) => els.map((el) => el.scrollWidth - el.clientWidth));

async function expectSessionLabel(container: Locator, expected: { harness: SessionMeta['config']['harness']; pill: string; project?: string; name: string }) {
  const label = container.locator('.session-label');
  const pill = label.locator(`:scope > .harness-pill[data-harness="${expected.harness}"]`);
  await pill.waitFor({ timeout: 10_000 });
  const parts = expected.project !== undefined ? [expected.pill, expected.project, '|', expected.name] : [expected.pill, expected.name];
  expect(await label.locator(':scope > span').allTextContents()).toEqual(parts);
  return pill.evaluate((el) => {
    const { color, backgroundColor } = getComputedStyle(el);
    return { color, backgroundColor };
  });
}

async function expectMenuLeft(menu: Locator, target: Locator): Promise<void> {
  await menu.waitFor();
  const [popup, edge] = await Promise.all([menu.boundingBox(), target.boundingBox()]);
  expect(Math.abs(popup!.x - edge!.x), 'popup aligns with its trigger’s left edge').toBeLessThanOrEqual(1);
  expect(popup!.y + popup!.height, 'popup opens above the trigger').toBeLessThanOrEqual(edge!.y + 1);
}

async function launch(userData: string): Promise<Page> {
  const home = path.join(userData, 'home');
  const env = isolatedEnv(userData, {
    HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: path.join(userData, 'claude'), CODEX_HOME: path.join(userData, 'codex'), PI_CODING_AGENT_DIR: path.join(userData, 'pi')
  });
  for (const key of ['ELECTRON_RENDERER_URL', 'ANTHROPIC_AUTH_TOKEN', 'CODEX_API_KEY', 'CURSOR_API_KEY', 'GOOGLE_API_KEY']) delete env[key];
  for (const dir of [env.APPDATA, env.LOCALAPPDATA, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, env.PI_CODING_AGENT_DIR]) await fs.mkdir(dir, { recursive: true });
  app = await electron.launch({
    executablePath: require('electron') as string,
    // No real credentials: keep the isolated fixture off the macOS login Keychain.
    args: [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`, ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : [])],
    env,
    timeout: 60_000
  });
  const win = await app.firstWindow();
  await win.waitForSelector('.brand', { timeout: 60_000 });
  await expectQuietWindow(app);
  return win;
}

describe.runIf(enabled)('electron e2e: session view layout', () => {
  it('runs the built-in Housekeep command with a preview, a protected age window, and one checked archive batch', async ({ onTestFinished }) => {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-housekeep-ui-')));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    const worktrees = path.join(project, '.vocs-code', 'worktrees');
    const clean = path.join(worktrees, 'clean');
    const dirty = path.join(worktrees, 'dirty');
    const stranded = path.join(worktrees, 'stranded');
    const strandedFile = path.join(stranded, 'notes.txt');
    const strandedContents = 'Keep this stranded data.\n';
    const retainedBranch = 'vocscode/stranded';
    const stale = path.join(worktrees, 'stale');
    const staleBranch = 'vocscode/stale';
    onTestFinished(async () => {
      await app?.close().catch(() => undefined);
      app = null;
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
    });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), 'Fixture.\n');
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'config', 'user.name', 'e2e');
    git(project, 'config', 'user.email', 'e2e@example.invalid');
    git(project, 'add', '--', 'README.md');
    git(project, 'commit', '-qm', 'fixture');
    await fs.mkdir(worktrees, { recursive: true });
    git(project, 'worktree', 'add', '-qb', 'vocscode/report', clean);
    git(project, 'worktree', 'add', '-qb', 'vocscode/draft', dirty);
    await fs.writeFile(path.join(dirty, 'draft.txt'), 'Keep this local file.\n');
    // Leave a real local ref and an ignored directory, but no Git checkout for that branch.
    git(project, 'branch', retainedBranch);
    await fs.mkdir(stranded);
    await fs.appendFile(path.join(project, '.git', 'info', 'exclude'), '\n/.vocs-code/worktrees/stranded/\n');
    await fs.writeFile(strandedFile, strandedContents);
    git(project, 'worktree', 'add', '-qb', staleBranch, stale);
    // Preserve the checkout and backlink bytes, but leave Git's recorded backlink path missing.
    const backlink = path.join(stale, '.git');
    const savedBacklink = path.join(stale, 'retained-backlink');
    const backlinkBytes = await fs.readFile(backlink);
    await fs.rename(backlink, savedBacklink);
    await fs.mkdir(userData, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    const old = T - 9 * 86_400_000;
    const make = (id: string, title: string, ts: number, cwd = project, worktreeBranch?: string): SessionMeta => ({
      id, title, cwd, worktreeBranch, status: 'idle', config: { projectRoot: project, harness: 'native', permissionMode: 'ask' },
      createdAt: ts, updatedAt: ts + 3, lastUserMessageAt: ts, usage: usage(), harnessRef: {}
    });
    const archived = { ...make('s_housekeep_archived', 'Previously archived report', old, stranded, retainedBranch), archived: true };
    const rows = [
      make('s_housekeep_current', 'Current session', T),
      make('s_housekeep_recent', 'Recent report', T - 86_400_000),
      make('s_housekeep_five_days', 'Five-day report', T - 5 * 86_400_000),
      make('s_housekeep_old', 'Old finished report', old, clean, 'vocscode/report'),
      make('s_housekeep_dirty', 'Old local draft', old, dirty, 'vocscode/draft'),
      archived
    ];
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify(rows));
    for (const row of rows) {
      const dir = path.join(userData, 'sessions', row.id);
      const items: TranscriptItem[] = [
        { kind: 'user', id: 'u1', ts: row.createdAt, text: `Deliver ${row.title}.` },
        { kind: 'assistant', id: 'a1', ts: row.createdAt + 1, text: 'Delivered and verified.' },
        { kind: 'turn', id: 't1', ts: row.createdAt + 2, status: 'completed' }
      ];
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'transcript.jsonl'), items.map(item => JSON.stringify(item)).join('\n') + '\n');
    }
    const win = await launch(userData);
    // Exercise the actual Git staging/unregistration flow without littering the real system Trash.
    const trashFixture = path.join(tmp, 'trash-fixture');
    await app!.evaluate(({ shell }, target) => {
      shell.trashItem = original => process.getBuiltinModule('node:fs')!.promises.rename(original, target);
    }, trashFixture);
    await win.locator('[data-session-id="s_housekeep_current"]').click();
    const input = win.locator('.composer-box textarea');
    const dialog = win.getByRole('dialog', { name: 'Housekeep sessions', exact: true });
    const suggestion = win.getByRole('button', { name: /^\/housekeep\b/ });
    await input.pressSequentially('/');
    await suggestion.waitFor({ state: 'visible' });
    await input.pressSequentially('hou');
    await suggestion.waitFor({ state: 'visible' });
    await input.press('Tab');
    expect(await input.inputValue()).toBe('/housekeep ');
    await input.pressSequentially('sessions');
    await input.press('Enter');
    await dialog.getByText(/Activity within the last 7 days/).waitFor();

    const inventoryName = 'Stranded worktrees and branches';
    const inventory = dialog.getByRole('region', { name: inventoryName, exact: true });
    await inventory.getByRole('heading', { name: inventoryName, exact: true }).waitFor();
    const scan = inventory.getByRole('button', { name: 'Scan worktrees and branches', exact: true });
    expect(await scan.isEnabled()).toBe(true);
    await inventory.getByText('Read-only:', { exact: true }).waitFor();
    const findings = inventory.getByRole('list', { name: 'Inventory findings', exact: true });
    expect(await findings.count()).toBe(0);
    const listWorktrees = () => execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: project, encoding: 'utf8' });
    const registrationsBeforeScan = listWorktrees();
    const staleRegistration = registrationsBeforeScan.split('\0\0').map(record => record.split('\0'))
      .find(([entry]) => entry.startsWith('worktree ') && path.normalize(entry.slice('worktree '.length)) === stale);
    expect(staleRegistration, 'Git must mark the fixture registration at this path as prunable').toEqual(expect.arrayContaining([
      `branch refs/heads/${staleBranch}`, expect.stringMatching(/^prunable(?: |$)/)
    ]));
    await scan.click();
    const staleRow = findings.getByRole('listitem').filter({ has: win.getByText(stale, { exact: true }) });
    await staleRow.getByText('Stale registration', { exact: true }).waitFor();
    await staleRow.getByText('Folder on disk: present', { exact: true }).waitFor();
    await staleRow.getByText('Git marks this registration as stale.', { exact: true }).waitFor();
    expect(listWorktrees()).toBe(registrationsBeforeScan);
    expect(await fs.readFile(savedBacklink)).toEqual(backlinkBytes);
    git(project, 'show-ref', '--verify', `refs/heads/${staleBranch}`);
    const folderRow = findings.getByRole('listitem').filter({ has: win.getByText('Unregistered folder', { exact: true }) });
    await folderRow.getByText('Unregistered folder', { exact: true }).waitFor();
    await folderRow.getByText(stranded, { exact: true }).waitFor();
    const branchRow = findings.getByRole('listitem').filter({ has: win.getByText(retainedBranch, { exact: true }) });
    await branchRow.getByText('Retained branch', { exact: true }).waitFor();
    await branchRow.getByText(`Linked session: ${archived.title} (archived)`, { exact: true }).waitFor();
    expect(await inventory.getByRole('checkbox', { includeHidden: true }).count()).toBe(0);

    const archivedIds = async () => (await win.evaluate(() => window.harness.invoke('sessions:list', undefined)))
      .filter(row => row.archived).map(row => row.id).sort();
    const expectStrandedIntact = async () => {
      expect(await fs.readFile(strandedFile, 'utf8')).toBe(strandedContents);
      git(project, 'show-ref', '--verify', `refs/heads/${retainedBranch}`);
    };
    expect(await archivedIds()).toEqual([archived.id]);
    await expectStrandedIntact();

    const fiveDayRow = dialog.getByRole('listitem').filter({ has: win.getByText('Five-day report', { exact: true }) });
    const fiveDayProtected = fiveDayRow.getByText('Protected', { exact: true });
    await fiveDayProtected.waitFor();
    const eligible = dialog.getByRole('checkbox', { name: 'Select Old finished report' });
    expect(await dialog.getByRole('checkbox', { name: 'Select Recent report' }).isDisabled()).toBe(true);
    expect(await dialog.getByRole('checkbox', { name: 'Select Old local draft' }).isDisabled()).toBe(true);
    expect(await eligible.isChecked()).toBe(false);
    await dialog.getByLabel('Conversation excerpts for Old finished report').click();
    await dialog.getByText('Delivered and verified.', { exact: true }).waitFor();
    await eligible.check();
    await dialog.getByRole('button', { name: 'Review selected' }).click();
    await dialog.getByRole('heading', { name: 'Final archive review' }).waitFor();
    await dialog.getByRole('button', { name: 'Back to review' }).click();
    const originalReadme = await fs.readFile(path.join(clean, 'README.md')); // May use CRLF on Windows.
    await dialog.getByRole('button', { name: 'Review selected' }).click();
    await dialog.getByRole('button', { name: 'Confirm archive (1)' }).click();
    await dialog.getByText(/Old finished report.*Archived.*worktree removed/).waitFor();
    await expect(fs.stat(clean)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(trashFixture, 'README.md'))).toEqual(originalReadme);
    expect(await fs.readFile(path.join(dirty, 'draft.txt'), 'utf8')).toBe('Keep this local file.\n');
    git(project, 'show-ref', '--verify', 'refs/heads/vocscode/report');
    expect(await archivedIds()).toEqual([archived.id, 's_housekeep_old']);
    await expectStrandedIntact();
    const current = await fs.readFile(path.join(userData, 'sessions', 's_housekeep_current', 'transcript.jsonl'), 'utf8');
    expect(current).not.toContain('/housekeep');
    expect(await fs.readFile(path.join(userData, 'sessions', 's_housekeep_old', 'transcript.jsonl'), 'utf8')).toContain('Delivered and verified.');
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await input.fill('/housekeep settings');
    await input.press('Enter');
    const days = win.getByRole('spinbutton', { name: 'Protect sessions used in the last (days)' });
    expect(await days.inputValue()).toBe('7');
    await days.fill('14');
    await days.press('Enter');
    await expect.poll(async () => (await win.evaluate(() => window.harness.invoke('settings:get', undefined))).housekeepRecentDays).toBe(14);
    const settingsOnDisk = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8'));
    expect(settingsOnDisk.housekeepRecentDays).toBe(14);
    await win.getByRole('button', { name: 'Back to workspace', exact: true }).click();

    // The shorter window applies only to this review, not the saved setting.
    await input.fill('/housekeep 3');
    await input.press('Enter');
    await dialog.getByText(/Activity within the last 3 days/).waitFor();
    await dialog.getByText('Age rule for this review only:', { exact: true }).waitFor();
    expect(await dialog.getByRole('checkbox', { name: 'Select Recent report' }).isDisabled()).toBe(true);
    await dialog.getByText(/No utility model is available for Housekeep/).waitFor();
    await fiveDayRow.getByLabel('Conversation excerpts for Five-day report').click();
    const fiveDayPick = fiveDayRow.getByRole('checkbox', { name: 'Select Five-day report' });
    await expect.poll(() => fiveDayPick.isEnabled()).toBe(true);
    expect(await fiveDayPick.isChecked()).toBe(false);
    expect(await dialog.getByRole('button', { name: 'Review selected', exact: true }).isDisabled()).toBe(true);
    expect((await win.evaluate(() => window.harness.invoke('settings:get', undefined))).housekeepRecentDays).toBe(14);
    const settingsAfterOverride = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8'));
    expect(settingsAfterOverride.housekeepRecentDays).toBe(14);
    await fiveDayPick.check();
    await dialog.getByRole('button', { name: 'Review selected', exact: true }).click();
    await dialog.getByRole('heading', { name: 'Final archive review' }).waitFor();
    await dialog.getByText(/Activity within the last 3 days/).waitFor();
    const closeReview = dialog.getByRole('button', { name: 'Close', exact: true });
    await closeReview.click();
    await dialog.waitFor({ state: 'hidden' });

    await input.fill('/housekeep');
    await input.press('Enter');
    await dialog.getByText(/Activity within the last 14 days/).waitFor();
    await fiveDayProtected.waitFor();
    await closeReview.click();
    await dialog.waitFor({ state: 'hidden' });
    await win.getByRole('button', { name: 'Skills', exact: true }).click();
    await win.getByRole('button', { name: 'Run /housekeep', exact: true }).click();
    await dialog.getByText(/Activity within the last 14 days/).waitFor();
  }, 90_000);

  it('reopens setup from Home without creating a session or changing the returning user’s defaults', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-home-setup-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    const win = await launch(userData);
    const before = await win.evaluate(() => window.harness.invoke('settings:get', undefined));
    const open = win.locator('.welcome').getByRole('button', { name: 'Setup guide', exact: true });
    await open.click();
    const guide = win.getByRole('dialog', { name: 'Welcome to Vocs Code', exact: true });
    await guide.getByRole('heading', { name: 'What would you like to use?', exact: true }).waitFor();
    await fs.mkdir(shots, { recursive: true });
    await win.screenshot({ path: path.join(shots, 'session-view-05-home-setup.png') });
    await guide.getByRole('button', { name: 'Close', exact: true }).click();
    await guide.waitFor({ state: 'hidden' });
    await expect.poll(() => open.evaluate((el) => el === document.activeElement)).toBe(true);
    const after = await win.evaluate(() => window.harness.invoke('settings:get', undefined));
    expect(after.onboardingDone).toBe(true);
    expect(after.defaultHarness).toBe(before.defaultHarness);
    expect(after.defaultModelByHarness).toEqual(before.defaultModelByHarness);
    expect(await win.evaluate(() => window.harness.invoke('sessions:list', undefined))).toEqual([]);

    // The read-only inventory is also available when there are no sessions to archive.
    await win.getByRole('button', { name: 'Skills', exact: true }).click();
    await win.getByRole('button', { name: 'Run /housekeep', exact: true }).click();
    const dialog = win.getByRole('dialog', { name: 'Housekeep sessions', exact: true });
    await dialog.getByText('No sessions to review.', { exact: true }).waitFor();
    const inventory = dialog.getByRole('region', { name: 'Stranded worktrees and branches', exact: true });
    expect(await inventory.getByRole('button', { name: 'Scan worktrees and branches', exact: true }).isEnabled()).toBe(true);
  }, 60_000);

  it('refreshes the automatic session title after each successful native turn using the utility model', async ({ onTestFinished }) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-session-title-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    const providerId = 'title-fixture';
    const chatModel = 'fixture-chat';
    const utilityModel = 'fixture-utility';
    type Completion = { model: string; stream?: boolean; messages: { role: string; content: string }[] };
    const requests: { body: Completion; response: ServerResponse }[] = [];
    // Hold replies until the test has observed the state that precedes each one.
    const server = createServer((req, response) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      let json = '';
      req.setEncoding('utf8').on('data', (chunk: string) => { json += chunk; });
      req.on('end', () => {
        try {
          requests.push({ body: JSON.parse(json) as Completion, response });
        } catch {
          response.writeHead(400).end();
        }
      });
    });
    onTestFinished(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Title fixture did not bind a TCP address');
    const provider: ProviderConfig = {
      id: providerId, kind: 'lmstudio', name: 'Scripted title fixture', enabled: true, hasApiKey: false,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      models: [chatModel, utilityModel].map((id) => ({ id, provider: providerId, displayName: id }))
    };
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, {
      defaultHarness: 'native', defaultModelByHarness: { native: { provider: providerId, model: chatModel } },
      providers: [provider], utilityModel: { provider: providerId, model: utilityModel },
      agent: { enabled: false }, knowledge: { prime: false, autoDistill: false }, mcpDisabledBuiltins: MCP_BUILTIN_IDS,
      // The 1024x768 screen of GitHub's Windows runners: the header title must stay visible when squeezed.
      windowBounds: { x: 0, y: 0, width: 1024, height: 728 }
    }));
    const win = await launch(userData);
    const row = win.getByTestId('session-row');
    const header = win.getByTestId('session-title');
    const expectTitle = async (title: string) => {
      await header.and(win.getByText(title, { exact: true })).waitFor({ timeout: 10_000 });
      await row.getByText(title, { exact: true }).waitFor({ timeout: 10_000 });
    };
    const request = async (model: string, count: number) => {
      const matching = () => requests.filter(({ body }) => body.model === model);
      await expect.poll(() => matching().length, { timeout: 10_000, message: `${model} request ${count}` }).toBe(count);
      return matching()[count - 1]!;
    };
    const reply = ({ body, response }: (typeof requests)[number], text: string) => {
      if (body.stream) {
        const chunk = (delta: Record<string, string>, finish_reason: 'stop' | null) =>
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
      }
    };

    const firstPrompt = 'Please investigate the settings panel rendering issue';
    const openingTitle = 'Investigate settings rendering';
    await openNewSession(win);
    await win.getByPlaceholder('What should the agent do?').fill(firstPrompt);
    await win.getByRole('button', { name: /^Start session/ }).click({ timeout: 20_000 });
    await expectTitle('Please investigate the settings panel rendering…');
    const id = await row.getAttribute('data-session-id');
    if (!id) throw new Error('New session row has no session id');
    const opening = await request(utilityModel, 1);
    expect(opening.body.stream).not.toBe(true);
    expect(opening.body.messages).toContainEqual({ role: 'user', content: firstPrompt });
    reply(opening, openingTitle);
    await expectTitle(openingTitle);

    const turns = [
      { prompt: firstPrompt, replyText: 'The orange badge uses the wrong color.', title: 'Fix orange badge color' },
      { prompt: 'Now look at the banner', replyText: 'The green banner needs a visual test.', title: 'Test green banner' }
    ];
    let previousTitle = openingTitle;
    for (const [i, turn] of turns.entries()) {
      if (i > 0) {
        await win.getByPlaceholder(/^Message the agent/).fill(turn.prompt);
        await win.getByRole('button', { name: 'Send', exact: true }).click();
      }
      const chat = await request(chatModel, i + 1);
      expect(chat.body.stream).toBe(true);
      expect(chat.body.messages.at(-1)).toEqual({ role: 'user', content: turn.prompt });
      // No refresh can have been requested while this turn is still waiting for its assistant reply.
      expect(requests.filter(({ body }) => body.model === utilityModel)).toHaveLength(i + 1);
      reply(chat, turn.replyText);

      // A held utility response must not delay the turn's transition to idle.
      await expect.poll(() => win.evaluate(async (sessionId) => {
        const meta = await window.harness.invoke('sessions:get', { id: sessionId });
        const items = await window.harness.invoke('sessions:transcript', { id: sessionId });
        return {
          status: meta?.status,
          turns: items.flatMap((item) => item.kind === 'turn' ? [item.status] : []),
          replies: items.flatMap((item) => item.kind === 'assistant' ? [item.text] : [])
        };
      }, id), { timeout: 10_000 }).toEqual({
        status: 'idle', turns: turns.slice(0, i + 1).map(() => 'completed'),
        replies: turns.slice(0, i + 1).map(({ replyText }) => replyText)
      });
      const refresh = await request(utilityModel, i + 2);
      expect(refresh.body.stream).not.toBe(true);
      expect(refresh.body.messages.find(({ role }) => role === 'system')?.content).toMatch(/\btitle\b.*\b(?:concise|short|\d+ words)\b|\b(?:concise|short)\b.*\btitle\b/i);
      expect(refresh.body.messages).toContainEqual({
        role: 'user', content: `Current title: ${previousTitle}\nLatest assistant reply: ${turn.replyText}`
      });
      await expectTitle(previousTitle);
      reply(refresh, turn.title);
      await expectTitle(turn.title);
      previousTitle = turn.title;
    }
    expect(requests.map(({ body }) => body.model)).toHaveLength(5);
  }, 90_000);

  it('carries changes, run controls, plan, search, Vesta and New session where the redesign puts them, and fits a narrow pane', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-session-view-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await seedProject(project);
    // A deliberately small window, like a CI runner's display (a window cannot outgrow its screen):
    // the page size is pinned after launch, so the layout under test never depends on the machine.
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, { theme: 'dark', windowBounds: { width: 1024, height: 768 }, agent: { enabled: true, collapsed: true } }));
    const sessions: SessionMeta[] = [
      {
        id: SID,
        title: 'Add rate limiting to the public API',
        createdAt: T,
        updatedAt: T + 10,
        lastUserMessageAt: T,
        config: { harness: 'claude', projectRoot: project, permissionMode: 'accept-edits', model: { provider: 'anthropic', model: 'claude-opus-5-5' } },
        cwd: project,
        status: 'idle',
        harnessRef: {},
        usage: usage({ inputTokens: 48_200, outputTokens: 6_100, costUsd: 0.84, turns: 1, contextTokens: 64_000, contextWindow: 200_000 })
      },
      {
        id: OTHER,
        title: 'Fix flaky auth refresh test',
        createdAt: T - 1000,
        updatedAt: T - 1000,
        lastUserMessageAt: T - 1000,
        config: { harness: 'native', projectRoot: project, permissionMode: 'ask' },
        cwd: project,
        status: 'idle',
        harnessRef: {},
        usage: usage()
      }
    ];
    for (const { id, name } of HARNESSES) {
      if (id === 'claude' || id === 'native') continue;
      sessions.push({
        ...sessions[1]!,
        id: `s_view_${id}`,
        title: `Existing ${name} session`,
        updatedAt: T - 2000,
        lastUserMessageAt: T - 2000,
        config: { harness: id, projectRoot: project, permissionMode: 'ask' }
      });
    }
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify(sessions));
    for (const s of sessions) {
      await fs.mkdir(path.join(userData, 'sessions', s.id), { recursive: true });
      const items = s.id === SID ? transcript() : [{ id: 'u1', kind: 'user', ts: T - 1000, text: s.title } as TranscriptItem];
      await fs.writeFile(path.join(userData, 'sessions', s.id, 'transcript.jsonl'), items.map((i) => JSON.stringify(i)).join('\n') + '\n');
    }

    const win = await launch(userData);
    // Wide enough for every header item: 1600 − sidebar − side panel leaves the pane ~900px.
    await win.setViewportSize({ width: 1600, height: 1000 });
    await fs.mkdir(shots, { recursive: true });
    const claude = { harness: 'claude', pill: 'Claude', project: 'project', name: sessions[0]!.title } as const;
    const native = { harness: 'native', pill: 'Native', project: 'project', name: sessions[1]!.title } as const;
    const claudeRow = win.locator(`[data-session-id="${SID}"]`);
    const nativeRow = win.locator(`[data-session-id="${OTHER}"]`);
    await claudeRow.click();
    await win.locator('.work-head').waitFor({ timeout: 30_000 });
    const claudeColors = await expectSessionLabel(claudeRow, { harness: claude.harness, pill: claude.pill, name: claude.name });
    const nativeColors = await expectSessionLabel(nativeRow, { harness: native.harness, pill: native.pill, name: native.name });
    expect(await claudeRow.locator('.session-label-project, .session-label-separator').count()).toBe(0);
    const palette = await win.locator('.session-row .harness-pill').evaluateAll((pills) => pills.map((pill) => {
      const { color, backgroundColor } = getComputedStyle(pill);
      return { harness: pill.getAttribute('data-harness'), color, backgroundColor };
    }));
    expect(palette.map((pill) => pill.harness).sort()).toEqual(HARNESSES.map((harness) => harness.id).sort());
    expect(new Set(palette.map((pill) => pill.backgroundColor)).size).toBe(HARNESSES.length);
    expect(new Set(palette.map((pill) => pill.color)).size).toBe(HARNESSES.length);

    // One header row: identity on the left, the working tree's changes and the actions on the right.
    const head = win.locator('.pane.active .header');
    const titleRow = head.locator('.header-title');
    expect(await expectSessionLabel(titleRow, claude)).toEqual(claudeColors);
    const projectClipping = await titleRow.locator('.session-label-project').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(projectClipping, 'project stays readable in the header with a long session name').toBeLessThanOrEqual(1);
    // innerText reads a hidden element's text too, so every header item is first waited on as visible.
    const crumbs = titleRow.locator('.header-crumbs');
    await crumbs.waitFor({ state: 'visible', timeout: 30_000 });
    // The folder crumb renders first; the branch arrives with the session's git summary, which
    // loads asynchronously, so wait for it rather than reading the crumbs once.
    await crumbs.getByText('feat/rate-limit', { exact: true }).waitFor({ timeout: 30_000 });
    expect(await crumbs.innerText()).toContain('feat/rate-limit');
    expect(await head.locator('.header-controls').count()).toBe(0);
    expect(await head.getAttribute('data-width')).toBe('wide');
    const changes = titleRow.locator('.header-changes');
    await changes.waitFor({ state: 'visible', timeout: 30_000 });
    await expect.poll(() => changes.innerText(), { timeout: 30_000 }).toContain('3 files');
    expect(await changes.locator('.add').innerText()).toBe('+4'); // +1 in server.ts, +2 and +1 in the new files
    expect(await changes.locator('.del').innerText()).toBe('−0');
    await win.screenshot({ path: path.join(shots, 'session-view-01-default.png') });

    // The turn's work is one chip with its tally, and the latest plan stays on screen while collapsed.
    const work = win.locator('.work-head');
    expect(await work.innerText()).toMatch(/Worked for 2m 34s[\s\S]*5 steps[\s\S]*3 files changed/);
    expect(await win.locator('.plan-card').count()).toBe(1);
    expect(await win.locator('.plan-progress').innerText()).toBe('3 of 3 done');
    expect(await win.locator('.tool-card').count()).toBe(0);
    await work.click();
    expect(await win.locator('.plan-card').count()).toBe(1);
    expect(await win.locator('.tool-card').count()).toBe(5);
    expect(await win.locator('.tool-card .badge').count()).toBe(0); // every step succeeded
    expect(await win.locator('.tool-card', { hasText: 'src/server.ts' }).filter({ has: win.locator('.diff-stat') }).locator('.add').innerText()).toBe('+1');
    await win.screenshot({ path: path.join(shots, 'session-view-02-work.png') });
    await work.click();

    // The changes chip opens Changes; the provider/model and context stay visible, spend lives in options.
    await changes.click();
    await win.locator('.panel-tab.active', { hasText: 'Changes' }).waitFor({ timeout: 10_000 });
    await win.locator('.changes').waitFor({ timeout: 10_000 });
    const composer = win.locator('.pane.active .composer');
    const model = composer.getByRole('button', { name: /^Model:/ });
    expect(await model.locator('.pill-text').innerText()).toMatch(/^anthropic\/(claude-opus-5-5|Opus 5\.5)/i);
    expect(await model.locator('.pill-effort').innerText()).toBe('default');
    expect(await model.getAttribute('aria-label')).toContain('anthropic/claude-opus-5-5');
    const meter = composer.getByRole('button', { name: 'Session usage' });
    expect(await meter.innerText()).toBe('32%');
    expect(await composer.getByRole('button', { name: 'More session controls' }).count()).toBe(0);
    const permission = composer.getByRole('button', { name: 'Permission mode: Edits' });
    for (const pill of [model, permission]) {
      const endGap = await pill.evaluate((el) => el.getBoundingClientRect().right - el.lastElementChild!.getBoundingClientRect().right);
      expect(endGap, 'only padding follows the chevron on a wide composer').toBeLessThanOrEqual(12);
    }
    const menu = composer.getByRole('menu');
    await model.click();
    await expectMenuLeft(menu, model);
    await win.screenshot({ path: path.join(shots, 'session-view-08-model-menu.png') });
    await menu.getByRole('menuitem', { name: 'More models' }).click();
    await menu.getByRole('textbox', { name: 'Search models' }).waitFor();
    await expectMenuLeft(menu, model);
    await win.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await permission.click();
    await expectMenuLeft(menu, permission);
    await win.screenshot({ path: path.join(shots, 'session-view-05-permission.png') });
    await composer.getByRole('menuitem', { name: /Ask before acting/ }).click();
    await expect.poll(async () => (await win.evaluate(() => window.harness.invoke('sessions:list', undefined))).find((s: SessionMeta) => s.id === SID)?.config.permissionMode).toBe('ask');
    await composer.getByRole('button', { name: 'Permission mode: Ask' }).waitFor({ timeout: 10_000 });
    await composer.getByRole('button', { name: 'Composer options', exact: true }).click();
    const usageItem = win.getByRole('menuitem', { name: /Session usage/ });
    expect(await usageItem.innerText()).toContain('$0.84');
    await usageItem.click();
    await win.locator('.panel-tab.active', { hasText: 'Usage' }).waitFor({ timeout: 10_000 });
    await win.keyboard.press('Escape');

    // The title bar and the palette it opens use the same labels as the sidebar.
    const search = win.locator('.titlebar-search');
    expect(await expectSessionLabel(search, claude)).toEqual(claudeColors);
    await search.click();
    await win.getByPlaceholder('Type a command or session name…').waitFor({ timeout: 10_000 });
    expect(await expectSessionLabel(win.locator('.palette-item', { hasText: claude.name }), claude)).toEqual(claudeColors);
    expect(await expectSessionLabel(win.locator('.palette-item', { hasText: native.name }), native)).toEqual(nativeColors);
    await win.keyboard.press('Escape');
    await expect.poll(() => win.locator('.palette').count()).toBe(0);

    // The sidebar's New session opens the Ctrl+Shift+N dialog on the open session's folder. That the
    // dialog mounts at all proves no native folder picker was raised (it would block app:pickFolder).
    await win.locator('.sidebar-new').click();
    await win.waitForSelector('.ns-root', { timeout: 10_000 });
    expect((await win.locator('.ns-root').innerText()).replace(/\\/g, '/')).toBe(project.replace(/\\/g, '/'));
    expect(await win.locator('.palette').count()).toBe(0);
    await win.locator('.modal').getByRole('button', { name: 'Cancel' }).click();
    await win.waitForSelector('.modal', { state: 'detached', timeout: 10_000 });

    // Vesta opens from, and minimizes back to, the title bar; nothing of it floats while minimized.
    const launcher = win.locator('.titlebar-vesta');
    await win.getByRole('button', { name: 'Open Vesta' }).click();
    await win.getByRole('dialog', { name: 'Vesta' }).waitFor({ timeout: 10_000 });
    await expect.poll(() => launcher.getAttribute('aria-pressed')).toBe('true');
    await win.screenshot({ path: path.join(shots, 'session-view-03-vesta.png') });
    await win.getByRole('button', { name: 'Minimize Vesta' }).click();
    await expect.poll(() => win.getByRole('dialog', { name: 'Vesta' }).count()).toBe(0);
    expect(await win.locator('.vesta').count()).toBe(0);

    // The split picker and narrow pane headers keep session labels as the folder and branch controls fold away.
    await win.getByRole('button', { name: 'Split right' }).click();
    await win.locator('.pane-picker').waitFor({ timeout: 10_000 });
    const pickNative = win.locator('.pane-picker-item', { hasText: native.name });
    expect(await expectSessionLabel(pickNative, native)).toEqual(nativeColors);
    await pickNative.click();
    const paneHeaders = win.locator('.pane .header');
    await expect.poll(() => paneHeaders.count()).toBe(2);
    await expect.poll(async () => (await paneHeaders.evaluateAll((els) => els.map((el) => el.getAttribute('data-width')))).every((w) => w !== 'wide')).toBe(true);
    expect(await expectSessionLabel(paneHeaders.filter({ hasText: claude.name }), claude)).toEqual(claudeColors);
    expect(await expectSessionLabel(paneHeaders.filter({ hasText: native.name }), native)).toEqual(nativeColors);
    expect(await win.locator('.pane .header-crumbs:visible').count()).toBe(0);
    await expect.poll(async () => (await overflowX(win, '.pane .header-title')).every((over) => over <= 1)).toBe(true);
    await expect.poll(async () => (await overflowX(win, '.pane .composer-actions')).every((over) => over <= 1)).toBe(true);
    expect(await win.locator('.pane.active .header').getByRole('button', { name: 'Close pane' }).count()).toBe(1);
    await win.screenshot({ path: path.join(shots, 'session-view-04-split.png') });
  }, 180_000);

  it('keeps a crowded busy composer on one row with every action reachable at wide and narrow widths', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-composer-crowded-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await seedProject(project);
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, { theme: 'dark', agent: { enabled: false } }));
    const model = { provider: 'anthropic', model: 'claude-opus-4-6[1m]' };
    const displayName = 'Claude Opus 4.6 · Extended context (1M tokens)';
    const session: SessionMeta = {
      id: SID, title: 'Crowded composer regression', createdAt: T, updatedAt: T + 10, lastUserMessageAt: T,
      config: { harness: 'claude', projectRoot: project, permissionMode: 'full-auto', model, effort: 'high', fastMode: true },
      cwd: project, status: 'idle', harnessRef: {},
      usage: usage({ inputTokens: 482_000, outputTokens: 61_000, costUsd: 12.34, turns: 1, contextTokens: 640_000, contextWindow: 1_000_000 })
    };
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session]));
    await fs.mkdir(path.join(userData, 'sessions', SID), { recursive: true });
    await fs.writeFile(path.join(userData, 'sessions', SID, 'transcript.jsonl'), transcript().map((item) => JSON.stringify(item)).join('\n') + '\n');
    const win = await launch(userData);
    await win.setViewportSize({ width: 1600, height: 1000 });
    await win.locator(`[data-session-id="${SID}"]`).click();
    await win.locator('.work-head').waitFor({ timeout: 30_000 });
    const settings = await win.evaluate(() => window.harness.invoke('settings:get', undefined));
    const composer = win.locator('.pane.active .composer');
    const box = composer.locator('.composer-box');
    const footer = composer.locator('.composer-actions');
    await composer.locator('textarea').fill('Keep the public API compatible while completing the rate limiter.');
    await fs.mkdir(shots, { recursive: true });

    // Startup intentionally resets saved running sessions. Push through the real typed preload
    // bridge after transcript loading instead: status/meta events do not replace renderer session
    // metadata, but sessionsChanged does. Main stays idle, so no harness or provider is started.
    // A visible local run must not let the viewing dwell publish main's deliberately idle
    // fixture back over this renderer-only busy state while screenshots/menus are exercised.
    await app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.emit('blur'); });
    const busy: PushPayloads['push:sessionsChanged'] = [{ ...session, status: 'running', queued: 3, fastModeStatus: { state: 'on' } }];
    const models: PushPayloads['push:sessionEvent'] = {
      sessionId: SID, ts: Date.now(),
      event: { type: 'models', models: [{ provider: model.provider, id: model.model, displayName, supportedEfforts: ['low', 'medium', 'high'] }] }
    };
    for (const theme of ['dark', 'light'] as const) {
      const themed: PushPayloads['push:settingsChanged'] = { ...settings, theme };
      await app!.evaluate(({ BrowserWindow }, payload) => {
        const contents = BrowserWindow.getAllWindows()[0]!.webContents;
        contents.send('push:settingsChanged', payload.themed);
        contents.send('push:sessionsChanged', payload.busy);
        contents.send('push:sessionEvent', payload.models);
      }, { themed, busy, models });
      await expect.poll(() => win.locator('html').getAttribute('data-theme')).toBe(theme);
      const modelPill = footer.locator('.pill[title="Model"]');
      await expect.poll(() => modelPill.locator('.pill-text').innerText()).toBe(`${model.provider}/${displayName}`);
      expect(await modelPill.locator('.pill-effort').innerText()).toBe('high');
      expect(await modelPill.getAttribute('aria-label')).toBe(`Model: ${model.provider}/${model.model} · Effort: high · Fast on`);
      const permission = footer.getByRole('button', { name: 'Permission mode: Full', exact: true });
      await permission.waitFor();

      for (const width of [780, 520, 440, 320]) {
        // Exercise the real container-query layout, independently of the CI screen's maximum size.
        await box.evaluate((el, w) => { el.style.width = `${w}px`; el.style.maxWidth = 'none'; }, width);
        await expect.poll(async () => Math.round((await box.boundingBox())!.width)).toBe(width);
        const steer = footer.getByRole('button', { name: 'Steer', exact: true });
        const sendOptions = footer.getByRole('button', { name: 'Send options', exact: true });
        await steer.waitFor();
        await sendOptions.waitFor();
        await footer.getByRole('button', { name: 'Interrupt (Esc)', exact: true }).waitFor();
        expect(await footer.getByRole('button', { name: 'Queue', exact: true }).count()).toBe(0);
        const meter = footer.locator('.session-meter');
        await expect.poll(() => meter.isVisible()).toBe(width > 440);
        if (width > 440) expect(await meter.innerText()).toBe('64%');
        expect(await footer.innerText()).not.toContain('$12.34');

        // Not just scrollWidth: a wrapped row can have no horizontal overflow. Every visible
        // button must share the same centre line, remain inside the footer, and not overlap a neighbour.
        await expect.poll(() => footer.evaluate((el) => {
          const row = el.getBoundingClientRect();
          const buttons = [...el.querySelectorAll('button')].filter((button) => button.getBoundingClientRect().width > 0 && getComputedStyle(button).visibility !== 'hidden');
          const rects = buttons.map((button) => button.getBoundingClientRect()).sort((a, b) => a.left - b.left);
          return {
            nowrap: getComputedStyle(el).flexWrap === 'nowrap',
            overflow: el.scrollWidth <= el.clientWidth + 1,
            centred: rects.length > 0 && rects.every((r) => Math.abs((r.top + r.bottom - rects[0].top - rects[0].bottom) / 2) <= 1),
            contained: rects.every((r) => r.left >= row.left - 1 && r.right <= row.right + 1 && r.top >= row.top - 1 && r.bottom <= row.bottom + 1),
            separate: rects.every((r, i) => i === 0 || r.left >= rects[i - 1].right - 1)
          };
        }), { message: `${theme} composer at ${width}px` }).toEqual({ nowrap: true, overflow: true, centred: true, contained: true, separate: true });
        await box.screenshot({ path: path.join(shots, `session-view-07-crowded-${theme}-${width}.png`) });

        if (theme === 'dark' && width === 320) {
          // Full-width menus must not overflow a split pane just to keep their left edges aligned.
          const menu = footer.getByRole('menu');
          for (const pill of [modelPill, permission]) {
            await pill.click();
            await menu.waitFor();
            const [popup, row, button] = await Promise.all([menu.boundingBox(), footer.boundingBox(), pill.boundingBox()]);
            expect(popup!.x).toBeGreaterThanOrEqual(row!.x - 1);
            expect(popup!.x).toBeLessThan(button!.x);
            expect(Math.abs((popup!.x + popup!.width) - (row!.x + row!.width))).toBeLessThanOrEqual(1);
            await win.keyboard.press('Escape');
            await menu.waitFor({ state: 'hidden' });
          }
        }

        await sendOptions.click();
        const queue = win.getByRole('menuitem', { name: /Queue/ });
        await queue.waitFor();
        expect(await queue.innerText()).toContain('After the current turn');
        expect(await queue.isEnabled()).toBe(true);
        // Do not submit: this fixture models renderer state, not a running provider turn.
        await win.keyboard.press('Escape');
        await queue.waitFor({ state: 'hidden' });

        await footer.getByRole('button', { name: 'Composer options', exact: true }).click();
        const usageItem = win.getByRole('menuitem', { name: /Session usage/ });
        expect(await usageItem.innerText()).toContain('$12.34');
        expect(await usageItem.innerText()).toContain('64% context');
        expect(await win.getByRole('status').filter({ hasText: '3 messages waiting for the current turn' }).count()).toBe(1);
        const attach = win.getByRole('menuitem', { name: 'Attach files', exact: true });
        await attach.waitFor();
        // Reach the real file input from the menu even when the inline attach button is hidden.
        const chooser = win.waitForEvent('filechooser');
        await attach.click();
        await (await chooser).setFiles([]);
        await footer.getByRole('button', { name: 'Composer options', exact: true }).click();
        await usageItem.click();
        await win.locator('.panel-tab.active', { hasText: 'Usage' }).waitFor();
        await usageItem.waitFor({ state: 'hidden' });
        // The active meter remains a direct way to close Usage even in a narrow busy composer.
        await expect.poll(() => meter.isVisible()).toBe(true);
        await expect.poll(() => footer.evaluate((el) => el.scrollWidth - el.clientWidth), { message: `${theme} composer at ${width}px with Usage open` }).toBeLessThanOrEqual(1);
        await win.locator('.panel-top').getByRole('button', { name: 'Changes', exact: true }).click();
      }
    }
    const saved = await win.evaluate(() => window.harness.invoke('sessions:list', undefined));
    expect(saved).toHaveLength(1);
    expect(saved[0].status).toBe('idle');
    expect(saved[0].queued ?? 0).toBe(0);
  }, 180_000);

  it('finds a session that finished unviewed in a collapsed folder from the activity tray, and clears it once viewed', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-activity-'));
    const userData = path.join(tmp, 'userData');
    const alpha = path.join(tmp, 'alpha');
    const beta = path.join(tmp, 'beta');
    for (const dir of [userData, alpha, beta]) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(alpha, { folders: [alpha, beta], recentProjects: [alpha, beta], collapsedFolders: [beta] }));
    const meta = (id: string, title: string, projectRoot: string, patch: Partial<SessionMeta> = {}): SessionMeta => ({
      id, title, createdAt: T, updatedAt: T, lastUserMessageAt: T,
      config: { harness: 'native', projectRoot, permissionMode: 'ask' }, cwd: projectRoot, status: 'idle', harnessRef: {}, usage: usage(), ...patch
    });
    const DONE = 's_activity_done';
    // The first row opens on boot; the unviewed one sits in the folded-away folder.
    const sessions = [meta('s_activity_here', 'Current work', alpha), meta(DONE, 'Migrate the billing tables', beta, { unseenAt: Date.now() - 12 * 60_000 })];
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify(sessions));
    for (const s of sessions) {
      await fs.mkdir(path.join(userData, 'sessions', s.id), { recursive: true });
      await fs.writeFile(path.join(userData, 'sessions', s.id, 'transcript.jsonl'), JSON.stringify({ id: 'u1', kind: 'user', ts: T, text: s.title }) + '\n');
    }

    const win = await launch(userData);
    await win.setViewportSize({ width: 1280, height: 800 });
    const trigger = win.getByTestId('activity-trigger');
    await expect.poll(() => trigger.textContent()).toContain('1 done');
    // The collapsed folder says it holds something unviewed even though its rows are hidden.
    await expect.poll(() => win.getByTestId('project-unseen').textContent()).toBe('●1');
    await expect.poll(() => win.locator(`[data-session-id="${DONE}"]`).count()).toBe(0);

    await trigger.hover();
    const tray = win.getByTestId('activity-tray');
    await tray.waitFor();
    expect(await tray.locator('.activity-section-label').allTextContents()).toEqual(['Done · not viewed']);
    const row = tray.getByTestId('activity-row');
    const done = { harness: 'native', pill: 'Native', project: 'beta', name: 'Migrate the billing tables' } as const;
    const trayColors = await expectSessionLabel(row, done);
    await fs.mkdir(shots, { recursive: true });
    await win.screenshot({ path: path.join(shots, 'session-view-06-activity-tray.png') });

    // As main sees it, the window is behind another app (a quiet run never focuses it; a visible
    // run might, so say so explicitly).
    const setFocused = (focused: boolean) => app!.evaluate(({ BrowserWindow }, f) => { BrowserWindow.getAllWindows()[0]!.emit(f ? 'focus' : 'blur'); }, focused);
    await setFocused(false);
    await row.click();
    await tray.waitFor({ state: 'hidden' });
    // The folder unfolded and the session is open in the active pane.
    const listRow = win.locator(`[data-session-id="${DONE}"]`);
    expect(await expectSessionLabel(listRow, { harness: done.harness, pill: done.pill, name: done.name })).toEqual(trayColors);
    expect(await expectSessionLabel(win.locator('.pane.active .header'), done)).toEqual(trayColors);

    // On screen alone is not viewed: with the window unfocused the mark stays.
    await win.waitForTimeout(2_500);
    expect(await listRow.getByTestId('session-unseen-dot').count()).toBe(1);
    expect(await trigger.textContent()).toContain('1 done');

    // Bring the window to the front (as main sees it); after the dwell the mark clears everywhere.
    await setFocused(true);
    await expect.poll(() => listRow.getByTestId('session-unseen-dot').count(), { timeout: 10_000 }).toBe(0);
    await expect.poll(() => win.getByTestId('activity-trigger').getAttribute('aria-label')).toBe('Recent sessions');
    await expect.poll(async () => {
      const saved = JSON.parse(await fs.readFile(path.join(userData, 'sessions.json'), 'utf8')) as SessionMeta[];
      const done = saved.find((s) => s.id === DONE)!;
      return { unseen: 'unseenAt' in done, viewed: typeof done.lastViewedAt };
    }, { timeout: 10_000 }).toEqual({ unseen: false, viewed: 'number' });
  }, 120_000);

  it('switches the sidebar to one Recent list across folders from the top switch, names each row’s folder, and keeps the view after a restart', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-recent-'));
    const userData = path.join(tmp, 'userData');
    const alpha = path.join(tmp, 'alpha');
    const beta = path.join(tmp, 'beta');
    for (const dir of [userData, alpha, beta]) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(alpha, { folders: [alpha, beta], recentProjects: [alpha, beta], folderOrder: [alpha, beta] }));
    // Recency interleaves the two folders; the folder view groups them, the Recent view must not.
    const meta = (id: string, title: string, projectRoot: string, at: number): SessionMeta => ({
      id, title, createdAt: T, updatedAt: T, lastUserMessageAt: at,
      config: { harness: 'native', projectRoot, permissionMode: 'ask' }, cwd: projectRoot, status: 'idle', harnessRef: {}, usage: usage()
    });
    const sessions = [
      meta('s_recent_a_old', 'Alpha oldest', alpha, T + 1_000),
      meta('s_recent_b_new', 'Beta newest', beta, T + 4_000),
      meta('s_recent_a_new', 'Alpha newer', alpha, T + 3_000),
      meta('s_recent_b_mid', 'Beta middle', beta, T + 2_000)
    ];
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify(sessions));
    for (const s of sessions) {
      await fs.mkdir(path.join(userData, 'sessions', s.id), { recursive: true });
      await fs.writeFile(path.join(userData, 'sessions', s.id, 'transcript.jsonl'), JSON.stringify({ id: 'u1', kind: 'user', ts: T, text: s.title }) + '\n');
    }
    const rowIds = (win: Page) => win.locator('.sidebar-list [data-testid="session-row"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-session-id')));

    let win = await launch(userData);
    await win.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(() => rowIds(win)).toEqual(['s_recent_a_new', 's_recent_a_old', 's_recent_b_new', 's_recent_b_mid']);
    const toggle = win.getByTestId('sidebar-recent');
    expect(await toggle.getAttribute('aria-pressed')).toBe('false');
    await toggle.click();
    await expect.poll(() => rowIds(win)).toEqual(['s_recent_b_new', 's_recent_a_new', 's_recent_b_mid', 's_recent_a_old']);
    expect(await win.locator('.sidebar-list .project-header').count()).toBe(0);
    expect(await win.locator('.sidebar-list .session-label-project, .sidebar-list .session-label-separator').count()).toBe(0);
    expect(await win.locator('.sidebar-list [data-testid="session-folder"]').allTextContents()).toEqual(['beta', 'alpha', 'beta', 'alpha']);
    await expectSessionLabel(win.locator('[data-session-id="s_recent_b_new"]'), { harness: 'native', pill: 'Native', name: 'Beta newest' });
    await fs.mkdir(shots, { recursive: true });
    await win.screenshot({ path: path.join(shots, 'session-view-07-sidebar-recent.png') });
    await expect.poll(async () => (JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')) as { sidebarView?: string }).sidebarView).toBe('recent');

    // Ctrl+ArrowDown follows the Recent order, crossing folders on every step.
    await win.locator(`[data-session-id="s_recent_b_new"]`).click();
    await win.keyboard.press('Control+ArrowDown');
    await expect.poll(() => win.locator('.pane.active .header').textContent()).toContain('Alpha newer');

    // Relaunch in Zen, where the nav links stack at the bottom of the rail: the switch must stay on top.
    await app!.close();
    app = null;
    const saved = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')) as Record<string, unknown>;
    await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ ...saved, uiMode: 'zen' }));
    win = await launch(userData);
    await win.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(() => rowIds(win)).toEqual(['s_recent_b_new', 's_recent_a_new', 's_recent_b_mid', 's_recent_a_old']);
    expect(await win.getByTestId('sidebar-recent').getAttribute('aria-pressed')).toBe('true');
    await win.locator('.sidebar').hover();
    const box = async (sel: string) => (await win.locator(sel).first().boundingBox())!;
    await expect.poll(async () => {
      const [brand, sw, list, analytics, archived, fresh] = await Promise.all(['.brand', '.sidebar-viewswitch', '.sidebar-list', '.sidebar-views', '[data-testid="sidebar-archived"]', '[data-testid="sidebar-new"]'].map(box));
      // Archived and the New session icon share the switch's row, right under the brand and above the
      // list and the nav links; New session ends the row.
      const inRow = (b: { y: number; height: number }) => b.y >= sw.y && b.y + b.height <= sw.y + sw.height;
      return brand.y < sw.y && sw.y < list.y && list.y < analytics.y && inRow(archived) && inRow(fresh) && fresh.x > archived.x;
    }).toBe(true);
    // The rail opens on hover after a short delay; shoot it open so the review image shows the switch.
    await expect.poll(async () => (await win.locator('.sidebar').boundingBox())!.width, { timeout: 5_000 }).toBeGreaterThan(200);
    await win.waitForTimeout(400);
    await win.screenshot({ path: path.join(shots, 'session-view-08-sidebar-recent-zen.png') });

    // Archived filters the same list from that row, and a second press returns to live sessions.
    const archivedToggle = win.getByTestId('sidebar-archived');
    expect(await archivedToggle.getAttribute('aria-pressed')).toBe('false');
    await archivedToggle.click();
    await expect.poll(() => win.locator('.sidebar-empty').textContent()).toBe('No archived sessions.');
    expect(await archivedToggle.getAttribute('aria-pressed')).toBe('true');
    await archivedToggle.click();
    await expect.poll(() => rowIds(win)).toEqual(['s_recent_b_new', 's_recent_a_new', 's_recent_b_mid', 's_recent_a_old']);

    // And back to folders.
    await win.getByTestId('sidebar-folders').click();
    await expect.poll(() => rowIds(win)).toEqual(['s_recent_a_new', 's_recent_a_old', 's_recent_b_new', 's_recent_b_mid']);
  }, 180_000);

  it('switches a worktree session harness in place without creating a second session or worktree, and persists across restart', async ({ onTestFinished }) => {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-switch-e2e-')));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    const wtPath = path.join(project, '.vocs-code', 'worktrees', 'shared-wt');
    onTestFinished(async () => {
      await app?.close().catch(() => undefined);
      app = null;
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
    });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), 'Initial.\n');
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'config', 'user.name', 'e2e');
    git(project, 'config', 'user.email', 'e2e@example.invalid');
    git(project, 'add', '--', 'README.md');
    git(project, 'commit', '-qm', 'init');
    await fs.mkdir(path.dirname(wtPath), { recursive: true });
    git(project, 'worktree', 'add', '-qb', 'vocscode/shared-wt', wtPath);
    await fs.writeFile(path.join(wtPath, 'uncommitted.txt'), 'keep me in place\n');
    await fs.mkdir(userData, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    const seeded: SessionMeta = {
      id: 's_switch_e2e',
      title: 'Continue in same worktree',
      createdAt: T,
      updatedAt: T,
      lastUserMessageAt: T,
      config: { harness: 'claude', projectRoot: project, permissionMode: 'ask', useWorktree: true },
      cwd: wtPath,
      worktreeBranch: 'vocscode/shared-wt',
      status: 'idle',
      harnessRef: { claudeSessionId: 'claude_old_1' },
      usage: usage({ costUsd: 1.25, turns: 1 })
    };
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([seeded]));
    const sDir = path.join(userData, 'sessions', seeded.id);
    await fs.mkdir(sDir, { recursive: true });
    await fs.writeFile(
      path.join(sDir, 'transcript.jsonl'),
      [
        { id: 'u1', kind: 'user', ts: T, text: 'Started on Claude' },
        { id: 'a1', kind: 'assistant', ts: T + 1, text: 'Edited uncommitted.txt' }
      ].map((item) => JSON.stringify(item)).join('\n') + '\n'
    );

    let win = await launch(userData);
    await win.setViewportSize({ width: 1280, height: 800 });
    await win.locator('[data-session-id="s_switch_e2e"]').click();
    await expectSessionLabel(win.locator('.pane.active .header'), { harness: 'claude', pill: 'Claude', project: 'project', name: 'Continue in same worktree' });

    // Switch harness in place via the composer model menu -> Switch harness -> Native.
    await win.locator('.pane.active [title="Model"]').click();
    await win.getByRole('menuitem', { name: /Switch harness/ }).click();
    await win.getByRole('menuitem', { name: /^Native/ }).click();

    await expectSessionLabel(win.locator('.pane.active .header'), { harness: 'native', pill: 'Native', project: 'project', name: 'Continue in same worktree' });
    // Still exactly one session row and the exact same worktree directory + uncommitted file.
    expect(await win.locator('.sidebar-list [data-testid="session-row"]').count()).toBe(1);
    expect(await fs.readdir(path.join(project, '.vocs-code', 'worktrees'))).toEqual(['shared-wt']);
    expect(await fs.readFile(path.join(wtPath, 'uncommitted.txt'), 'utf8')).toBe('keep me in place\n');
    await expect.poll(() => win.locator('.pane.active .transcript').textContent()).toContain('Switched harness from Claude Agent SDK to Native loop in the same workspace.');

    // Cold restart with the same userData proves persistence of the switched harness and handoff blob.
    await app!.close();
    app = null;
    win = await launch(userData);
    await win.setViewportSize({ width: 1280, height: 800 });
    await win.locator('[data-session-id="s_switch_e2e"]').click();
    await expectSessionLabel(win.locator('.pane.active .header'), { harness: 'native', pill: 'Native', project: 'project', name: 'Continue in same worktree' });
    const persisted = JSON.parse(await fs.readFile(path.join(userData, 'sessions.json'), 'utf8')) as SessionMeta[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.config.harness).toBe('native');
    expect(persisted[0]!.cwd).toBe(wtPath);
    expect(persisted[0]!.worktreeBranch).toBe('vocscode/shared-wt');
    expect(persisted[0]!.pendingForkContext).toBe(true);
    expect(await fs.readFile(path.join(sDir, 'fork-context.md'), 'utf8')).toContain('Started on Claude');
  }, 180_000);
});
