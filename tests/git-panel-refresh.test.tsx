/** @vitest-environment jsdom */
/**
 * The Git panel's PR/issue data is stale by nature: GitHub-side changes are invisible until
 * something asks again. These tests pin that asking — eager load on open, a minute tick, a
 * hidden window that skips the tick and catches up on visibility, a turn-end refresh, and
 * silent failures that never wipe the last list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { act, cleanup, render, screen } from '@testing-library/react';
import { RightPanel } from '../src/renderer/src/components/RightPanel';
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
const pr = (n: number, state: GitPullRequest['state'] = 'OPEN'): GitPullRequest => ({ number: n, title: `PR ${n}`, state, url: `https://github.com/o/r/pull/${n}` });
const issue = (n: number): GitIssue => ({ number: n, title: `Issue ${n}`, state: 'OPEN', url: `https://github.com/o/r/issues/${n}` });

let prs: GitPullRequest[] = [];
let issues: GitIssue[] = [];
let failPrs = false;

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockReset();
  prs = [];
  issues = [];
  failPrs = false;
  useStore.setState({ panelTab: 'branches', toasts: [] });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  invokeMock.mockImplementation((channel: string) => {
    if (channel === 'git:branchesOverview') return Promise.resolve(OVERVIEW);
    if (channel === 'git:pullRequests') return failPrs ? Promise.reject(new Error('gh exploded')) : Promise.resolve({ prs: [...prs], fetchedAt: Date.now() } satisfies GitPullRequestList);
    if (channel === 'git:issues') return Promise.resolve({ issues: [...issues], fetchedAt: Date.now() } satisfies GitIssueList);
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

  it('keeps the last list when a background pull fails, without an error toast', async () => {
    prs = [pr(1)];
    render(<RightPanel session={session()} />);
    await act(async () => {});
    failPrs = true;
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(prTab().textContent).toContain('1');
    expect(useStore.getState().toasts).toHaveLength(0);
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
});
