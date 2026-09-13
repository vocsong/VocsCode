/** Changes/Branches panels must surface a git timeout instead of silently showing a partial result (issue #127). */
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RightPanel } from '../src/renderer/src/components/RightPanel';
import { useStore } from '../src/renderer/src/store';
import type { SessionMeta } from '../src/shared/types';

const session: SessionMeta = {
  id: 's1',
  title: 'test',
  createdAt: 1,
  updatedAt: 2,
  config: { harness: 'native', projectRoot: 'G:/proj/a', permissionMode: 'auto' },
  cwd: 'G:/proj/a',
  status: 'idle',
  harnessRef: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
};

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

describe('git error banners', () => {
  it('shows a summary/diff timeout in the Changes panel instead of "Working tree clean"', async () => {
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'git:summary') {
        return Promise.resolve({ isRepo: true, root: 'G:/proj/a', files: [], error: 'git status timed out — the change list could not be loaded. Refresh to retry.' });
      }
      if (channel === 'git:diff') {
        return Promise.resolve({ diff: '', error: 'git diff timed out — the changes are too large to render here. Use the terminal for the full diff.' });
      }
      return Promise.resolve({});
    });
    useStore.setState({ panelTab: 'changes' });
    render(<RightPanel session={session} />);
    expect(await screen.findByText(/git status timed out/)).toBeTruthy();
    expect(screen.getByText(/git diff timed out/)).toBeTruthy();
    expect(screen.queryByText('Working tree clean.')).toBeNull();
  });

  it('shows a refs timeout in the Git panel', async () => {
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'git:branchesOverview') {
        return Promise.resolve({ isRepo: true, branches: [], worktrees: [], error: 'git for-each-ref timed out — the branch list could not be loaded. Refresh to retry.' });
      }
      // The Git tab eagerly loads both GitHub lists on open; a missing body would crash the count render.
      if (channel === 'git:pullRequests') return Promise.resolve({ prs: [], fetchedAt: Date.now() });
      if (channel === 'git:issues') return Promise.resolve({ issues: [], fetchedAt: Date.now() });
      return Promise.resolve({});
    });
    useStore.setState({ panelTab: 'branches' });
    render(<RightPanel session={session} />);
    expect(await screen.findByText(/for-each-ref timed out/)).toBeTruthy();
  });

  it('opens the full issue in a dialog and closes it from the backdrop', async () => {
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'git:branchesOverview') return Promise.resolve({ isRepo: true, branches: [], worktrees: [] });
      if (channel === 'git:pullRequests') return Promise.resolve({ fetchedAt: 1, prs: [] });
      if (channel === 'git:issues') {
        return Promise.resolve({
          fetchedAt: 1,
          issues: [
            {
              number: 42,
              title: 'Test issue',
              state: 'OPEN',
              url: 'https://example.com/acme/repo/issues/42',
              author: 'octocat',
              body: '## Details\n\nThis is the complete issue description.',
              labels: [{ name: 'bug' }],
              comments: 2
            }
          ]
        });
      }
      return Promise.resolve({});
    });
    useStore.setState({ panelTab: 'branches' });
    render(<RightPanel session={session} />);

    fireEvent.click(await screen.findByRole('button', { name: /Issues/ }));
    fireEvent.click(await screen.findByTitle('Open issue #42 on GitHub'));
    expect(invokeMock).toHaveBeenCalledWith('app:openExternal', { url: 'https://example.com/acme/repo/issues/42' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(await screen.findByText('Test issue'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('This is the complete issue description.');
    expect(screen.getByRole('button', { name: 'Open on GitHub' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start session' })).toBeTruthy();

    fireEvent.mouseDown(dialog.parentElement!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
