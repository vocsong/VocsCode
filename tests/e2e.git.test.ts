/**
 * End-to-end Git panel flow: a real repository whose GitHub data comes from a fake `gh` on PATH.
 * Clicking a PR row opens the same kind of detail dialog issues already have, with GitHub's
 * markdown body and metadata; the issue dialog keeps working, comment counts included. Both previews
 * pull the conversation's comments on open and render them below the description. The PR
 * table keeps the number in its own column at the default panel width and when the panel is wide.
 * The row's New session action confirms first in a dialog carrying the review template, editable
 * before the session starts on the repo; the issue row does the same with the fix template. That
 * turn is not asserted, since no provider key is configured.
 * The Branches view runs against a real bare remote: a branch pushed and then deleted server-side
 * reads as live until Refresh re-syncs remote-tracking refs, and says "Deleted on origin" after.
 * The session is seeded on disk so no harness and no provider key is involved. Requires
 * `npm run build` first; gated by VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';
import { expectQuietWindow, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const isWin = process.platform === 'win32';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
const launched: ElectronApplication[] = [];

afterAll(async () => {
  await Promise.all(launched.map((a) => a.close().catch(() => undefined)));
});

const PR_JSON =
  '[{"number":7,"title":"Ship the widget","state":"OPEN","headRefName":"feature/widget","baseRefName":"main","url":"https://example.com/acme/repo/pull/7",' +
  '"author":{"login":"octocat"},"body":"Adds the **widget** to the panel.","labels":[{"name":"enhancement","color":"00ff00"}],"comments":[{"body":"looks good"}],' +
  '"reviewDecision":"APPROVED","additions":24,"deletions":3}]';
const ISSUE_JSON =
  '[{"number":12,"title":"Widget is wobbly","state":"OPEN","url":"https://example.com/acme/repo/issues/12","author":{"login":"octocat"},' +
  '"body":"It **wobbles** badly.","labels":[{"name":"bug","color":"ff0000"}],"comments":[{"body":"me too"}]}]';
const PR_VIEW_JSON =
  '{"comments":[{"author":{"login":"reviewer"},"body":"Looks **good** to me.","createdAt":"2024-01-02T03:04:05Z",' +
  '"url":"https://example.com/acme/repo/pull/7#issuecomment-1","authorAssociation":"MEMBER"}]}';
const ISSUE_VIEW_JSON =
  '{"comments":[{"author":{"login":"octocat"},"body":"Me **too**.","createdAt":"2024-02-03T04:05:06Z",' +
  '"url":"https://example.com/acme/repo/issues/12#issuecomment-1"}]}';

const GH_SH = [
  '#!/bin/sh',
  'case "$1 $2" in',
  `  'pr list') echo '${PR_JSON}' ;;`,
  `  'pr view') echo '${PR_VIEW_JSON}' ;;`,
  `  'issue list') echo '${ISSUE_JSON}' ;;`,
  `  'issue view') echo '${ISSUE_VIEW_JSON}' ;;`,
  "  'auth status') echo 'Logged in to github.com account octocat (keyring)' ;;",
  'esac',
  'exit 0'
].join('\n');

const GH_CMD = [
  '@echo off',
  `if /i "%~1"=="pr" if /i "%~2"=="list" echo ${PR_JSON}`,
  `if /i "%~1"=="pr" if /i "%~2"=="view" echo ${PR_VIEW_JSON}`,
  `if /i "%~1"=="issue" if /i "%~2"=="list" echo ${ISSUE_JSON}`,
  `if /i "%~1"=="issue" if /i "%~2"=="view" echo ${ISSUE_VIEW_JSON}`,
  'if /i "%~1"=="auth" if /i "%~2"=="status" echo Logged in to github.com account octocat (keyring)',
  'exit /b 0'
].join('\r\n');

/**
 * Seeds a repository and session with the fake gh, launches the app and lands on the Git tab.
 * `seedRepo` runs after the initial commit, still before the app starts, so a test can add a remote
 * and branches for the panel to read.
 */
async function seedAndLaunch(
  { tag, panelWidth, seedRepo }: { tag: string; panelWidth: number; seedRepo?: (project: string, git: (...args: string[]) => void) => void }
): Promise<{ app: ElectronApplication; win: Page }> {
  const tmp = path.join(os.tmpdir(), `vocs-code-git-${Date.now()}-${tag}`);
  const userData = path.join(tmp, 'userData');
  const project = path.join(tmp, 'project');
  const bin = path.join(tmp, 'bin');
  await fs.mkdir(userData, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(project, 'README.md'), '# git panel project\n');
  const gh = path.join(bin, isWin ? 'gh.cmd' : 'gh');
  await fs.writeFile(gh, isWin ? GH_CMD : GH_SH);
  if (!isWin) await fs.chmod(gh, 0o755);

  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', 'commit', '-qm', 'init');
  seedRepo?.(project, git);

  // A dismissed setup banner keeps the panel to its tables.
  await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, { gitSetupSkipped: [project], panelWidth }));

  const sid = 's_git_e2e';
  const session = {
    id: sid,
    title: 'Git panel',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    config: { harness: 'native', projectRoot: project, permissionMode: 'ask' },
    cwd: project,
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    queued: 0
  } as SessionMeta;
  const items: TranscriptItem[] = [
    { id: 'u1', kind: 'user', ts: Date.now(), text: 'Hello' },
    { id: 'a1', kind: 'assistant', ts: Date.now(), text: 'Hi' }
  ];
  await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session]));
  await fs.mkdir(path.join(userData, 'sessions', sid), { recursive: true });
  await fs.writeFile(path.join(userData, 'sessions', sid, 'transcript.jsonl'), items.map((i) => JSON.stringify(i)).join('\n') + '\n');

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === 'ELECTRON_RUN_AS_NODE' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue;
    if (/^(ANTHROPIC|OPENAI|DEEPSEEK|OPENROUTER|OPENCODE|GEMINI|GROQ|XAI|MISTRAL)_API_KEY$/.test(k)) continue;
    env[k] = v;
  }
  env.PATH = `${bin}${path.delimiter}${env.PATH ?? ''}`;
  env.VOCS_CODE_USER_DATA = userData;

  const packaged = process.env.HARNESS_E2E_EXE;
  const app = await electron.launch({ executablePath: packaged || (require('electron') as string), args: packaged ? [`--user-data-dir=${userData}`] : [path.join(root, 'out', 'main', 'index.js')], env, timeout: 60_000 });
  launched.push(app);
  const win: Page = await app.firstWindow();
  await win.waitForSelector('.brand', { timeout: 60_000 });
  // The suite runs off-screen and inactive so it does not disturb the desktop; assert the window itself.
  await expectQuietWindow(app);

  await win.locator('.panel-tab', { hasText: 'Git' }).click();
  return { app, win };
}

/** Lands on the PR view of a seeded repo. */
async function launchGitPanel(panelWidth: number): Promise<{ app: ElectronApplication; win: Page }> {
  const { app, win } = await seedAndLaunch({ tag: `pr-${panelWidth}`, panelWidth });
  await fs.mkdir(shots, { recursive: true });
  await win.getByTitle('Pull requests on GitHub (via gh)').click();
  await win.getByRole('button', { name: 'Read pull request #7: Ship the widget' }).waitFor({ timeout: 30_000 });
  return { app, win };
}

/**
 * Lands on the Branches view of a repo whose `feature/ghost` was pushed, then deleted on the server
 * the way it was in the report. The delete happens in the bare remote rather than through a
 * `git push --delete` from this checkout, because that command prunes the local remote-tracking ref
 * as it goes: deleting directly leaves this clone with the stale `origin/feature/ghost` the panel
 * has to cope with.
 */
async function launchBranchesPanel(): Promise<{ app: ElectronApplication; win: Page }> {
  const { app, win } = await seedAndLaunch({
    tag: 'branches',
    // Wide enough that the Status column is on screen: the narrow panel collapses it, and a
    // collapsed column is exactly where a stale row would go unnoticed.
    panelWidth: 760,
    seedRepo: (project, git) => {
      const origin = path.join(path.dirname(project), 'origin.git');
      execFileSync('git', ['init', '-q', '--bare', origin], { stdio: 'ignore' });
      git('remote', 'add', 'origin', origin);
      git('push', '-q', '-u', 'origin', 'HEAD');
      git('checkout', '-q', '-b', 'feature/ghost');
      git('-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', 'commit', '-qm', 'ghost work', '--allow-empty');
      git('push', '-q', '-u', 'origin', 'feature/ghost');
      execFileSync('git', ['--git-dir', origin, 'branch', '-D', 'feature/ghost'], { stdio: 'ignore' });
    }
  });
  await win.locator('.branch-row', { hasText: 'feature/ghost' }).waitFor({ timeout: 30_000 });
  return { app, win };
}

describe.runIf(enabled)('git panel PR details', () => {
  it('opens a pull request dialog from its row and keeps the issue dialog working', async () => {
    const { app, win } = await launchGitPanel(420);

    // Default panel width: the number is its own column and the author/updated columns collapse.
    expect(await win.locator('.pr-cols > span:visible').allInnerTexts()).toEqual(['#', 'Pull request', 'Status', 'Actions']);
    expect(await win.locator('.pr-row .pr-num').first().innerText()).toBe('#7');
    await win.screenshot({ path: path.join(shots, 'git-panel-00-pr-table.png') });

    await win.getByRole('button', { name: 'Read pull request #7: Ship the widget' }).click();
    await win.waitForSelector('.pr-dialog-body', { timeout: 10_000 });
    expect(await win.locator('.modal-title').innerText()).toContain('#7');
    expect(await win.locator('.modal-title').innerText()).toContain('Ship the widget');
    const prMeta = await win.locator('.pr-dialog-meta').innerText();
    expect(prMeta).toContain('feature/widget → main');
    expect(prMeta).toContain('enhancement');
    expect(prMeta).toContain('1 comment');
    expect(prMeta).toContain('Approved');
    // GitHub's markdown is rendered, not dumped as source text.
    expect(await win.locator('.pr-dialog-body strong').innerText()).toBe('widget');
    // The conversation is fetched on open and rendered below the description.
    await win.waitForSelector('.pr-dialog-body ~ .git-comments .git-comment-body', { timeout: 10_000 });
    expect(await win.locator('.git-comments').innerText()).toMatch(/comments \(1\)/i);
    expect(await win.locator('.git-comments').innerText()).toContain('reviewer');
    expect(await win.locator('.git-comment-body strong').innerText()).toBe('good');
    expect(await win.locator('.modal-footer').innerText()).toContain('Merge PR');
    await win.screenshot({ path: path.join(shots, 'git-panel-01-pr-dialog.png') });
    await win.keyboard.press('Escape');
    await win.waitForSelector('.modal', { state: 'detached', timeout: 10_000 });

    // The Issues view still opens its dialog, and `gh`'s comment array now counts as one comment.
    await win.getByTitle('Issues on GitHub (via gh)').click();
    const issueRow = win.getByRole('button', { name: 'Read issue #12: Widget is wobbly' });
    await issueRow.waitFor({ timeout: 30_000 });
    await issueRow.click();
    await win.waitForSelector('.issue-dialog-body', { timeout: 10_000 });
    expect(await win.locator('.issue-dialog-meta').innerText()).toContain('1 comment');
    expect(await win.locator('.issue-dialog-body').innerText()).toContain('It wobbles badly.');
    await win.waitForSelector('.issue-dialog-body ~ .git-comments .git-comment-body', { timeout: 10_000 });
    expect(await win.locator('.git-comments').innerText()).toMatch(/comments \(1\)/i);
    expect(await win.locator('.git-comments').innerText()).toContain('Me too');

    await app.close();
  }, 180_000);

  it('keeps the full pull request table when the panel is wide', async () => {
    const { app, win } = await launchGitPanel(760);

    expect(await win.locator('.pr-cols > span:visible').allInnerTexts()).toEqual(['#', 'Pull request', 'Author', 'Updated', 'Status', 'Actions']);
    const num = await win.locator('.pr-row .pr-num').first().boundingBox();
    const title = await win.locator('.pr-row .pr-title').first().boundingBox();
    expect(num).not.toBeNull();
    expect(title).not.toBeNull();
    // The number ends before the title starts: a real column, not inline text.
    expect(num!.x + num!.width).toBeLessThanOrEqual(title!.x);
    await win.screenshot({ path: path.join(shots, 'git-panel-02-pr-table-wide.png') });

    await app.close();
  }, 180_000);
});

describe.runIf(enabled)('git panel PR review session', () => {
  it('confirms the review prompt in a dialog, then starts the session on the repo', async () => {
    const { app, win } = await launchGitPanel(420);

    // The ⋯ menu is gone: the row keeps the GitHub link and gains the New session action.
    expect(await win.locator('.pr-row .branch-actions .btn').count()).toBe(2);
    await win.getByRole('button', { name: 'New session to review PR #7' }).click();

    // The action confirms first: the dialog is seeded with the review template, and nothing is
    // created until it is confirmed.
    const promptBox = win.getByTestId('pr-review-prompt');
    await promptBox.waitFor({ timeout: 30_000 });
    expect(await promptBox.inputValue()).toContain('Review pull request #7 "Ship the widget"');
    expect(await win.locator('[data-testid="session-row"]', { hasText: 'Review PR #7' }).count()).toBe(0);

    // Whatever is left in the dialog is the session's first message.
    await promptBox.fill('Custom brief for PR #7.\nRun `gh pr diff 7` and flag risks.');
    await promptBox.press('Enter');

    // The app switches to a session titled for the PR, open on the review template. The seeded
    // session's own transcript is already on screen, so wait for the new session's title and
    // prompt instead of the first user message that happens to be visible.
    await win.waitForSelector('[data-testid="session-title"][title="Review PR #7"]', { timeout: 30_000 });
    const opened = win.locator('.msg-user .msg-text', { hasText: 'Custom brief for PR #7' });
    await opened.first().waitFor({ timeout: 30_000 });
    const promptText = await opened.first().innerText();
    expect(await win.getByTestId('session-title').innerText()).toBe('Review PR #7');
    expect(promptText).toContain('Custom brief for PR #7.');
    expect(promptText).toContain('gh pr diff 7');
    // On the repo itself rather than an isolated worktree: the sidebar row carries no worktree tag.
    const row = win.locator('[data-testid="session-row"]', { hasText: 'Review PR #7' });
    expect(await row.count()).toBe(1);
    expect(await row.locator('.session-worktree').count()).toBe(0);
    // The Git panel re-renders for the new session, so the table is back with the review running.
    await win.waitForSelector('.pr-row', { timeout: 30_000 });
    await win.screenshot({ path: path.join(shots, 'git-panel-03-pr-review-session.png') });

    await app.close();
  }, 180_000);
});

describe.runIf(enabled)('git panel branch state', () => {
  it('re-syncs on refresh and marks a branch deleted on the server', async () => {
    const { app, win } = await launchBranchesPanel();
    const ghostRow = win.locator('.branch-row', { hasText: 'feature/ghost' });

    // The report's symptom: the local ref outlives the server's branch, so the stale row reads as live.
    expect(await ghostRow.innerText()).toContain('synced');
    expect(await ghostRow.innerText()).not.toContain('Deleted on origin');
    await fs.mkdir(shots, { recursive: true });
    await win.screenshot({ path: path.join(shots, 'git-panel-05-branches-stale.png') });

    await win.getByTitle(/^Refresh/).click();
    await ghostRow.getByText('Deleted on origin').waitFor({ timeout: 30_000 });
    // The branch is still there — only its server copy is gone, and the panel says so instead of hiding it.
    expect(await win.locator('.branch-row', { hasText: 'feature/ghost' }).count()).toBe(1);
    expect(await ghostRow.innerText()).not.toContain('synced');
    await win.screenshot({ path: path.join(shots, 'git-panel-06-branches-gone.png') });

    await app.close();
  }, 180_000);
});

describe.runIf(enabled)('git panel issue session', () => {
  it('confirms the fix prompt in a dialog, then starts the session on the repo', async () => {
    const { app, win } = await launchGitPanel(420);

    await win.getByTitle('Issues on GitHub (via gh)').click();
    const issueRow = win.getByRole('button', { name: 'Read issue #12: Widget is wobbly' });
    await issueRow.waitFor({ timeout: 30_000 });
    // Like the PR row: the GitHub link and the New session action, nothing else.
    expect(await win.locator('.issue-row .branch-actions .btn').count()).toBe(2);

    await win.getByRole('button', { name: 'New session on issue #12' }).click();

    // The action confirms first: the dialog is seeded with the fix template, and nothing is created
    // until it is confirmed.
    const promptBox = win.getByTestId('issue-prompt');
    await promptBox.waitFor({ timeout: 30_000 });
    expect(await promptBox.inputValue()).toContain('Fix issue #12 "Widget is wobbly"');
    expect(await win.locator('[data-testid="session-row"]', { hasText: 'Fix issue #12' }).count()).toBe(0);

    // Whatever is left in the dialog is the session's first message.
    await promptBox.fill('Custom brief for issue #12.\nStart with the wobble regression test.');
    await promptBox.press('Enter');

    // The app switches to a session titled for the issue, open on the fix template.
    await win.waitForSelector('[data-testid="session-title"][title="Fix issue #12"]', { timeout: 30_000 });
    const opened = win.locator('.msg-user .msg-text', { hasText: 'Custom brief for issue #12' });
    await opened.first().waitFor({ timeout: 30_000 });
    const promptText = await opened.first().innerText();
    expect(await win.getByTestId('session-title').innerText()).toBe('Fix issue #12');
    expect(promptText).toContain('Custom brief for issue #12.');
    expect(promptText).toContain('wobble regression test');
    // On the repo itself rather than an isolated worktree: the sidebar row carries no worktree tag.
    const row = win.locator('[data-testid="session-row"]', { hasText: 'Fix issue #12' });
    expect(await row.count()).toBe(1);
    expect(await row.locator('.session-worktree').count()).toBe(0);
    await win.waitForSelector('.issue-row', { timeout: 30_000 });
    await win.screenshot({ path: path.join(shots, 'git-panel-04-issue-session.png') });

    await app.close();
  }, 180_000);
});
