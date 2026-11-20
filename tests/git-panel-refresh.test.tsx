/** @vitest-environment jsdom */
/**
 * The Git panel's PR/issue data is stale by nature: GitHub-side changes are invisible until
 * something asks again. These tests cover checkout reuse, the initial reads, polling,
 * refresh on visibility and turn completion, and failures that leave the displayed list intact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RightPanel } from '../src/renderer/src/components/RightPanel';
import { GitPanelCache } from '../src/renderer/src/git-panel-cache';
import { useStore } from '../src/renderer/src/store';
import type { GitBranchOverview, GitIssue, GitIssueList, GitPullRequest, GitPullRequestList, SessionMeta } from '../src/shared/types';

const session = (status: SessionMeta['status'] = 'idle'): SessionMeta => ({
  id: 's1',
  title: 'test',
  createdAt: 1,
  updatedAt: 2,
  config: { harness: 'native', projectRoot: 'G:/proj/a', permissionMode: 'auto' },
  cwd: 'G:/proj/a',
  status,
  harnessRef: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
});

const OVERVIEW: GitBranchOverview = { isRepo: true, base: 'develop', branches: [{ name: 'develop', current: true, isBase: true, merged: false }], worktrees: [] };
/** The overview the panel reads; tests swap it to model a server-side change between refreshes. */
let overview: GitBranchOverview = OVERVIEW;
/** The repo's setup status, which carries the origin URL the housekeeping menu links to. */
let setupStatus: Record<string, unknown> = {};
const pr = (n: number, state: GitPullRequest['state'] = 'OPEN'): GitPullRequest => ({ number: n, title: `PR ${n}`, state, url: `https://github.com/o/r/pull/${n}` });
const issue = (n: number): GitIssue => ({ number: n, title: `Issue ${n}`, state: 'OPEN', url: `https://github.com/o/r/issues/${n}` });

let prs: GitPullRequest[] = [];
let issues: GitIssue[] = [];
let prFailure: 'reject' | 'result' | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockReset();
  prs = [];
  issues = [];
  prFailure = undefined;
  overview = OVERVIEW;
  setupStatus = {};
  useStore.setState({ panelTab: 'branches', gitPanelView: 'branches', toasts: [] });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  invokeMock.mockImplementation((channel: string) => {
    if (channel === 'git:branchesOverview') return Promise.resolve(overview);
    if (channel === 'git:pullRequests') {
      if (prFailure === 'reject') return Promise.reject(new Error('gh exploded'));
      if (prFailure === 'result') return Promise.resolve({ prs: [], fetchedAt: Date.now(), error: 'gh exploded' } satisfies GitPullRequestList);
      return Promise.resolve({ prs: [...prs], fetchedAt: Date.now() } satisfies GitPullRequestList);
    }
    if (channel === 'git:issues') return Promise.resolve({ issues: [...issues], fetchedAt: Date.now() } satisfies GitIssueList);
    if (channel === 'git:setupStatus') return Promise.resolve(setupStatus);
    return Promise.resolve({});
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Number of times one channel was invoked. */
const calls = (channel: string) => invokeMock.mock.calls.filter(([c]) => c === channel).length;
const prTab = () => screen.getByTitle('Pull requests on GitHub (via gh)');
const issueTab = () => screen.getByTitle('Issues on GitHub (via gh)');

describe('Git panel background refresh', () => {
  it('keeps the issue rows and refreshes the branch overview when switching sessions in one checkout', async () => {
    issues = [issue(7)];
    const active = session();
    const panel = render(<RightPanel session={active} />);
    await act(async () => {});
    fireEvent.click(issueTab());
    const row = screen.getByRole('button', { name: 'Read issue #7: Issue 7' });
    overview = { ...OVERVIEW, branches: [{ ...OVERVIEW.branches[0], name: 'changed-branch' }] };

    panel.rerender(<RightPanel session={{ ...active, id: 's2' }} />);

    expect(screen.getByRole('button', { name: 'Read issue #7: Issue 7' })).toBe(row);
    await act(async () => {});
    expect(calls('git:branchesOverview')).toBe(2);
    expect(invokeMock).toHaveBeenCalledWith('git:branchesOverview', { sessionId: 's2' });
    expect(calls('git:pullRequests')).toBe(1);
    expect(calls('git:issues')).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: /^Branches/ }));
    expect(screen.getByText('changed-branch')).toBeTruthy();
  });

  it('shows each worktree’s last branches immediately and shares an in-flight refresh on return', async () => {
    const a = session();
    const b = { ...a, id: 's2', cwd: 'G:/proj/a/.vocs-code/worktrees/second' };
    const branch = (name: string): GitBranchOverview => ({
      isRepo: true, branches: [{ name, current: true, isBase: true, merged: false }], worktrees: []
    });
    let finish!: (value: GitBranchOverview) => void;
    const pending = new Promise<GitBranchOverview>((resolve) => { finish = resolve; });
    let aReads = 0;
    invokeMock.mockImplementation((channel: string, request: { sessionId: string }) => {
      if (channel === 'git:branchesOverview') {
        if (request.sessionId === b.id) return Promise.resolve(branch('second-worktree'));
        return ++aReads === 1 ? Promise.resolve(branch('first-worktree')) : pending;
      }
      if (channel === 'git:pullRequests') return Promise.resolve({ prs: [], fetchedAt: Date.now() });
      if (channel === 'git:issues') return Promise.resolve({ issues: [], fetchedAt: Date.now() });
      return Promise.resolve({});
    });
    const panel = render(<RightPanel session={a} />);
    await act(async () => {});
    expect(screen.getByText('first-worktree')).toBeTruthy();

    panel.rerender(<RightPanel session={b} />);
    expect(screen.queryByText('first-worktree')).toBeNull();
    await act(async () => {});
    expect(screen.getByText('second-worktree')).toBeTruthy();

    await act(async () => panel.rerender(<RightPanel session={a} />));
    expect(screen.getByText('first-worktree')).toBeTruthy();
    expect(screen.queryByText('second-worktree')).toBeNull();
    expect(aReads).toBe(2);

    panel.rerender(<RightPanel session={b} />);
    expect(screen.getByText('second-worktree')).toBeTruthy();
    await act(async () => panel.rerender(<RightPanel session={a} />));
    expect(aReads).toBe(2);
    expect(calls('git:pullRequests')).toBe(2);
    expect(calls('git:issues')).toBe(2);

    panel.rerender(<RightPanel session={b} />);
    await act(async () => finish(branch('first-worktree-updated')));
    expect(screen.getByText('second-worktree')).toBeTruthy();
    expect(screen.queryByText('first-worktree-updated')).toBeNull();

    panel.rerender(<RightPanel session={a} />);
    expect(screen.getByText('first-worktree-updated')).toBeTruthy();
    expect(screen.queryByText('first-worktree')).toBeNull();
  });

  it('loads the PR and issue counts on open and re-pulls them on the minute tick', async () => {
    prs = [pr(1), pr(2), pr(3, 'MERGED')];
    issues = [issue(7), issue(8)];
    render(<RightPanel session={session()} />);
    await act(async () => {});
    expect(prTab().textContent).toContain('2');
    expect(issueTab().textContent).toContain('2');

    prs = [pr(1), pr(2), pr(3, 'MERGED'), pr(4)];
    issues = [issue(7), issue(8), issue(9)];
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(prTab().textContent).toContain('3');
    expect(issueTab().textContent).toContain('3');
    expect(calls('git:branchesOverview')).toBe(2);
  });

  it('skips timer polls while the window is hidden and catches up on visibility', async () => {
    prs = [pr(1)];
    render(<RightPanel session={session()} />);
    await act(async () => {});
    const before = calls('git:pullRequests');

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(calls('git:pullRequests')).toBe(before);

    prs = [pr(1), pr(2)];
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(calls('git:pullRequests')).toBe(before + 1);
    expect(prTab().textContent).toContain('2');
  });

  it('refreshes once a turn ends so an agent-created PR lands without waiting for the timer', async () => {
    prs = [pr(1)];
    const view = render(<RightPanel session={session('running')} />);
    await act(async () => {});
    const before = calls('git:pullRequests');

    prs = [pr(1), pr(2)];
    view.rerender(<RightPanel session={session('idle')} />);
    // The refresh is throttled against the mount pull, so it fires on the 20s mark, not the 60s tick.
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(calls('git:pullRequests')).toBe(before + 1);
    expect(prTab().textContent).toContain('2');
  });

  it.each(['reject', 'result'] as const)('keeps the last list when a background pull fails (%s)', async (failure) => {
    prs = [pr(1)];
    render(<RightPanel session={session()} />);
    await act(async () => {});
    prFailure = failure;
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(prTab().textContent).toContain('1');
    expect(useStore.getState().toasts).toHaveLength(0);
  });

  it('re-syncs remote refs on Refresh, and only on Refresh', async () => {
    render(<RightPanel session={session()} />);
    await act(async () => {});
    // Opening the tab reads local state: no network on mount, and none on the minute tick either.
    expect(calls('git:fetchPrune')).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(calls('git:branchesOverview')).toBe(2);
    expect(calls('git:fetchPrune')).toBe(0);

    // The refresh button is what reaches the remote, and it must do so before re-reading the list —
    // without the prune, a branch deleted on the server keeps its stale ref and the read changes nothing.
    await act(async () => {
      fireEvent.click(screen.getByTitle(/^Refresh/));
    });
    const order = invokeMock.mock.calls.map(([c]) => c as string);
    expect(order.indexOf('git:fetchPrune')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('git:fetchPrune')).toBeLessThan(order.lastIndexOf('git:branchesOverview'));
    expect(calls('git:branchesOverview')).toBe(3);
  });

  it('marks a branch deleted on the server instead of reading as live', async () => {
    overview = {
      isRepo: true,
      base: 'develop',
      branches: [
        { name: 'develop', current: true, isBase: true, merged: false },
        { name: 'feature/widget', current: false, isBase: false, merged: false, upstream: 'origin/feature/widget' },
        { name: 'feature/ghost', current: false, isBase: false, merged: false, upstream: 'origin/feature/ghost', upstreamGone: true }
      ],
      worktrees: []
    };
    render(<RightPanel session={session()} />);
    await act(async () => {});

    const gone = screen.getByText('Deleted on origin').closest('.branch-row')!;
    expect(gone.textContent).toContain('feature/ghost');
    expect(gone.textContent).not.toContain('synced');
    const live = screen.getByText('feature/widget').closest('.branch-row')!;
    expect(live.textContent).toContain('synced');
    expect(live.textContent).not.toContain('Deleted on origin');
  });

  it('offers the server-side branch list from the housekeeping menu', async () => {
    setupStatus = {
      isRepo: true,
      hasCommits: true,
      published: true,
      pushed: true,
      remote: 'https://github.com/acme/repo.git',
      identity: { name: 'e2e', email: 'e2e@example.com' },
      gh: { installed: true, authenticated: true }
    };
    render(<RightPanel session={session()} />);
    await act(async () => {});

    fireEvent.click(screen.getByTitle('Housekeeping'));
    fireEvent.click(screen.getByText('Open branches on GitHub'));
    expect(invokeMock).toHaveBeenCalledWith('app:openExternal', { url: 'https://github.com/acme/repo/branches' });
  });

  it('stops polling when the panel unmounts', async () => {
    prs = [pr(1)];
    const view = render(<RightPanel session={session()} />);
    await act(async () => {});
    view.unmount();
    const before = calls('git:pullRequests');
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(calls('git:pullRequests')).toBe(before);
  });

  it('comes back on the GitHub list the user was reading when the panel is mounted again', async () => {
    issues = [issue(7)];
    const cache = new GitPanelCache();
    const panel = render(<RightPanel session={session()} gitPanelCache={cache} />);
    await act(async () => {});
    await act(async () => {
      issueTab().click();
    });
    expect(screen.getByRole('button', { name: 'Read issue #7: Issue 7' })).toBeTruthy();

    // Starting a session can unmount the panel before its metadata reaches the renderer.
    panel.unmount();
    render(<RightPanel session={session()} gitPanelCache={cache} />);
    expect(issueTab().className).toContain('active');
    expect(screen.getByRole('button', { name: 'Read issue #7: Issue 7' })).toBeTruthy();
    await act(async () => {});
    expect(calls('git:issues')).toBe(1);
  });
});
