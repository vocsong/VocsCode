/** @vitest-environment jsdom */
/**
 * PR rows in the Git panel are readable at a glance but carry no description. Clicking one opens a
 * detail dialog with GitHub's markdown body, labels and review state — the same affordance issues
 * already have — while the row's own action buttons keep acting without opening it. The row's New
 * session button starts a review session on the repo, with the review template as its first message;
 * the issue row and its dialog footer do the same with the fix template.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { RightPanel } from '../src/renderer/src/components/RightPanel';
import { ConfirmHost } from '../src/renderer/src/components/ui';
import { useStore } from '../src/renderer/src/store';
import type { GitBranchOverview, GitIssue, GitIssueList, GitPullRequest, GitPullRequestList, SessionMeta } from '../src/shared/types';

const session = (): SessionMeta => ({
  id: 's1',
  title: 'test',
  createdAt: 1,
  updatedAt: 2,
  config: { harness: 'native', projectRoot: 'G:/proj/a', permissionMode: 'auto' },
  cwd: 'G:/proj/a',
  status: 'idle',
  harnessRef: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
});

const OVERVIEW: GitBranchOverview = { isRepo: true, base: 'develop', branches: [{ name: 'develop', current: true, isBase: true, merged: false }], worktrees: [] };
const PR: GitPullRequest = {
  number: 7,
  title: 'Add the thing',
  state: 'OPEN',
  headRefName: 'feature/thing',
  baseRefName: 'develop',
  url: 'https://github.com/o/r/pull/7',
  author: 'octocat',
  body: 'This **fixes** the thing.',
  labels: [{ name: 'enhancement', color: '00ff00' }],
  comments: 2,
  reviewDecision: 'APPROVED',
  additions: 12,
  deletions: 3,
  createdAt: Date.now() - 86_400_000,
  updatedAt: Date.now() - 3_600_000
};

let prs: GitPullRequest[] = [];

const ISSUE: GitIssue = {
  number: 12,
  title: 'Widget is wobbly',
  state: 'OPEN',
  url: 'https://github.com/o/r/issues/12',
  author: 'octocat',
  body: 'It **wobbles** badly.',
  labels: [{ name: 'bug', color: 'ff0000' }],
  comments: 1
};

let issues: GitIssue[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockReset();
  prs = [];
  issues = [];
  // Reset the module-level store, activeId included, so each test's assertions stand on their own.
  useStore.setState({ panelTab: 'branches', toasts: [], activeId: null });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  invokeMock.mockImplementation((channel: string) => {
    if (channel === 'git:branchesOverview') return Promise.resolve(OVERVIEW);
    if (channel === 'git:pullRequests') return Promise.resolve({ prs: [...prs], fetchedAt: Date.now() } satisfies GitPullRequestList);
    if (channel === 'git:issues') return Promise.resolve({ issues: [...issues], fetchedAt: Date.now() } satisfies GitIssueList);
    if (channel === 'git:issueComments') return Promise.resolve({ comments: [{ author: 'octocat', body: 'Me **too**', createdAt: Date.now() - 7_200_000, url: 'https://github.com/o/r/issues/12#issuecomment-1' }] });
    if (channel === 'git:prComments') return Promise.resolve({ comments: [{ author: 'reviewer', body: 'Looks **good**', createdAt: Date.now() - 3_600_000, url: 'https://github.com/o/r/pull/7#issuecomment-1', authorAssociation: 'MEMBER' }] });
    if (channel === 'git:merge') return Promise.resolve({ ok: true, url: 'https://github.com/o/r/pull/7' });
    if (channel === 'sessions:create') return Promise.resolve({ id: 's_new', title: 'Review PR #7' });
    if (channel === 'sessions:transcript') return Promise.resolve([]);
    return Promise.resolve({});
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const prTab = () => screen.getByTitle('Pull requests on GitHub (via gh)');
const issueTab = () => screen.getByTitle('Issues on GitHub (via gh)');

/** Renders the panel on the PR view of an open repository with one pull request on GitHub. */
async function openPrList(withConfirm = false) {
  prs = [PR];
  render(
    <>
      <RightPanel session={session()} />
      {withConfirm && <ConfirmHost />}
    </>
  );
  await act(async () => {});
  await act(async () => {
    fireEvent.click(prTab());
  });
  // Fake timers keep waitFor from polling, so the promise flush above is the only wait needed.
  return screen.getByRole('button', { name: 'Read pull request #7: Add the thing' });
}

/** Renders the panel on the Issues view of an open repository with one issue on GitHub. */
async function openIssueList(withConfirm = false) {
  issues = [ISSUE];
  render(
    <>
      <RightPanel session={session()} />
      {withConfirm && <ConfirmHost />}
    </>
  );
  await act(async () => {});
  await act(async () => {
    fireEvent.click(issueTab());
  });
  return screen.getByRole('button', { name: 'Read issue #12: Widget is wobbly' });
}

describe('Git panel PR detail dialog', () => {
  it('opens the pull request details from the row, body and metadata included', async () => {
    const row = await openPrList();
    expect(screen.queryByRole('dialog')).toBeNull();
    // The number is its own column, like the issues table.
    expect(document.querySelector('.pr-cols > :first-child')?.textContent).toBe('#');
    expect(row.parentElement!.querySelector('.pr-num')?.textContent).toBe('#7');

    // The author cell is part of the row, not an action: clicking it opens the dialog too.
    await act(async () => {
      fireEvent.click(row.parentElement!.querySelector('.pr-author')!);
    });
    const dialog = screen.getByRole('dialog');
    const q = within(dialog);
    expect(q.getByText(/Add the thing/)).toBeTruthy();
    expect(q.getByText(/feature\/thing → develop/)).toBeTruthy();
    expect(q.getByText('Approved')).toBeTruthy();
    expect(q.getByText('enhancement')).toBeTruthy();
    expect(q.getByText('2 comments')).toBeTruthy();
    // GitHub's markdown is rendered, not dumped as source text.
    expect(dialog.textContent).toContain('This fixes the thing.');
    expect(dialog.querySelector('.pr-dialog-body strong')?.textContent).toBe('fixes');
    // The conversation is fetched with the preview and rendered below the description.
    const comments = dialog.querySelector('.git-comments')!;
    expect(comments.textContent).toContain('Comments (1)');
    expect(comments.textContent).toContain('Looks good');
    expect(comments.querySelector('.git-comment-body strong')?.textContent).toBe('good');
    expect(comments.querySelector('.git-comment-head strong')?.textContent).toBe('reviewer');

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the row action buttons from opening the dialog', async () => {
    await openPrList();
    await act(async () => {
      fireEvent.click(screen.getByTitle('Open PR #7 on GitHub'));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith('app:openExternal', { url: 'https://github.com/o/r/pull/7' });
  });

  it('merges from the dialog through the confirmation and closes it', async () => {
    const row = await openPrList(true);
    await act(async () => {
      fireEvent.click(row);
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Merge PR' }));
    });

    // The confirm stacks over the details; its own Merge PR is the one that executes.
    const dialogs = screen.getAllByRole('dialog');
    const confirm = dialogs[dialogs.length - 1];
    expect(confirm.textContent).toContain('Merge PR #7?');
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Merge PR' }));
    });
    await act(async () => {});

    expect(invokeMock).toHaveBeenCalledWith('git:merge', { sessionId: 's1', head: 'feature/thing' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Git panel issue detail dialog', () => {
  it('shows the issue conversation, markdown rendered', async () => {
    await openIssueList();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Read issue #12: Widget is wobbly' }));
    });
    const dialog = screen.getByRole('dialog');
    expect(invokeMock).toHaveBeenCalledWith('git:issueComments', { sessionId: 's1', number: 12 });
    const comments = dialog.querySelector('.git-comments')!;
    expect(comments.textContent).toContain('Comments (1)');
    expect(comments.textContent).toContain('Me too');
    expect(comments.querySelector('.git-comment-body strong')?.textContent).toBe('too');
  });
});

/**
 * The row's New session action replaces the ⋯ menu: one click starts a review session on the repo
 * itself, after a dialog confirms the first message (the template, editable before it starts).
 */
describe('Git panel PR review session', () => {
  it('confirms the first message in a dialog before starting the session', async () => {
    await openPrList(true);

    // The menu is gone, so the row's second action opens the dialog instead of starting anything.
    expect(screen.queryByTitle('PR actions')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New session to review PR #7' }));
    });

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Start a session to review PR #7?')).toBeTruthy();
    const prompt = within(dialog).getByTestId('pr-review-prompt') as HTMLTextAreaElement;
    expect(prompt.value).toBe(
      'Review pull request #7 "Add the thing" (https://github.com/o/r/pull/7), branch `feature/thing` into `develop`. Run `gh pr diff 7` for the patch: summarize what it changes, flag risks, and say whether it is ready to merge.'
    );
    // Nothing is created while the dialog is open.
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'sessions:create')).toHaveLength(0);

    // The edited first message is what the session opens with, on the repo itself (no worktree).
    // Shift+Enter remains available for multiline prompts; plain Enter confirms.
    fireEvent.change(prompt, { target: { value: 'Review PR #7, focusing on the migration.' } });
    fireEvent.keyDown(prompt, { key: 'Enter', shiftKey: true });
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'sessions:create')).toHaveLength(0);
    expect(screen.getByRole('dialog')).toBe(dialog);
    await act(async () => {
      fireEvent.keyDown(prompt, { key: 'Enter' });
    });

    const created = invokeMock.mock.calls.filter(([channel]) => channel === 'sessions:create');
    expect(created).toHaveLength(1);
    expect(created[0]![1]).toEqual({
      config: { harness: 'native', projectRoot: 'G:/proj/a', permissionMode: 'auto', useWorktree: false },
      title: 'Review PR #7',
      initialPrompt: 'Review PR #7, focusing on the migration.'
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useStore.getState().activeId).toBe('s_new');
    expect(useStore.getState().toasts.some((t) => t.kind === 'success' && t.text === 'Session started to review PR #7')).toBe(true);
  });

  it('starts nothing when the dialog is dismissed', async () => {
    await openPrList(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New session to review PR #7' }));
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    });

    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'sessions:create')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useStore.getState().activeId).toBeNull();
  });
});

/**
 * Issues get the same two actions the PR rows have: the row's own New session button and the detail
 * dialog's footer both start a session on the repo itself, after a dialog confirms the first
 * message (the fix template, editable before it starts). Neither one routes through the folder
 * picker any more.
 */
describe('Git panel issue session', () => {
  it('confirms the first message in a dialog before starting the session', async () => {
    await openIssueList(true);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New session on issue #12' }));
    });

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Start a session on issue #12?')).toBeTruthy();
    const prompt = within(dialog).getByTestId('issue-prompt') as HTMLTextAreaElement;
    expect(prompt.value).toBe(
      'Fix issue #12 "Widget is wobbly" (https://github.com/o/r/issues/12): figure out the cause and implement a fix.'
    );
    // Nothing is created while the dialog is open.
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'sessions:create')).toHaveLength(0);

    // The edited first message is what the session opens with, on the repo itself (no worktree).
    fireEvent.change(prompt, { target: { value: 'Fix issue #12, starting with the regression test.' } });
    await act(async () => {
      fireEvent.keyDown(prompt, { key: 'Enter' });
    });

    const created = invokeMock.mock.calls.filter(([channel]) => channel === 'sessions:create');
    expect(created).toHaveLength(1);
    expect(created[0]![1]).toEqual({
      config: { harness: 'native', projectRoot: 'G:/proj/a', permissionMode: 'auto', useWorktree: false },
      title: 'Fix issue #12',
      initialPrompt: 'Fix issue #12, starting with the regression test.'
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useStore.getState().activeId).toBe('s_new');
    expect(useStore.getState().toasts.some((t) => t.kind === 'success' && t.text === 'Session started on issue #12')).toBe(true);
  });

  it('starts nothing when the dialog is dismissed', async () => {
    await openIssueList(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New session on issue #12' }));
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    });

    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'sessions:create')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useStore.getState().activeId).toBeNull();
  });

  it('starts the same session from the issue dialog footer, one dialog at a time', async () => {
    await openIssueList(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Read issue #12: Widget is wobbly' }));
    });

    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Start session' }));
    });

    // The details close as the prompt opens, so its confirm is the only Start session left.
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(1);
    expect(within(dialogs[0]!).getByTestId('issue-prompt')).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(dialogs[0]!).getByRole('button', { name: 'Start session' }));
    });

    const created = invokeMock.mock.calls.filter(([channel]) => channel === 'sessions:create');
    expect(created).toHaveLength(1);
    expect(created[0]![1]).toMatchObject({ title: 'Fix issue #12', initialPrompt: expect.stringContaining('Fix issue #12 "Widget is wobbly"') });
    expect(useStore.getState().activeId).toBe('s_new');
  });
});
