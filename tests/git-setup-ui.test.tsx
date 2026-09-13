/**
 * Guided git setup UI: the panel's Git/Changes tabs must walk a non-repo folder through init,
 * first commit, connecting a GitHub remote (one-click through gh, or by hand on github.com) and
 * pushing — advancing one step at a time as each action lands. Every step talks to the real IPC
 * boundary, so the guide cannot advance on state it never actually produced.
 */
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

// api.ts snapshots `platform` at import time, before the harness stub above runs.
vi.mock('../src/renderer/src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/api')>();
  return { ...actual, platform: 'win32' };
});

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GitSetup, remoteWebUrl, repoNameFor } from '../src/renderer/src/components/GitSetup';
import { RightPanel } from '../src/renderer/src/components/RightPanel';
import { useStore } from '../src/renderer/src/store';
import type { GitSetupStatus, SessionMeta } from '../src/shared/types';

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

const noGh: GitSetupStatus['gh'] = { installed: false, authenticated: false };
const ghReady: GitSetupStatus['gh'] = { installed: true, authenticated: true, account: 'octocat' };

const status = (patch: Partial<GitSetupStatus>): GitSetupStatus => ({ isRepo: false, hasCommits: false, pushed: false, gh: noGh, ...patch });

/** A fresh-per-test stateful backend: the guide must advance only because an action changed it. */
let setup: GitSetupStatus;

beforeEach(() => {
  invokeMock.mockReset();
  setup = status({});
  useStore.setState({ panelTab: 'branches', toasts: [], settings: null });
  invokeMock.mockImplementation((channel: string, req: { url?: string; name?: string; private?: boolean; message?: string }) => {
    switch (channel) {
      case 'git:branchesOverview':
        return Promise.resolve({ isRepo: setup.isRepo, base: 'main', branches: [], worktrees: [] });
      case 'git:summary':
        return Promise.resolve({ isRepo: setup.isRepo, files: [] });
      case 'git:diff':
        return Promise.resolve({ diff: '' });
      case 'git:pullRequests':
        return Promise.resolve({ prs: [], fetchedAt: Date.now() });
      case 'git:issues':
        return Promise.resolve({ issues: [], fetchedAt: Date.now() });
      case 'git:setupStatus':
        return Promise.resolve(setup);
      case 'git:init':
        setup = status({ ...setup, isRepo: true, root: 'G:/proj/a', branch: 'main' });
        return Promise.resolve({ ok: true });
      case 'git:initialCommit':
        setup = { ...setup, hasCommits: true };
        return Promise.resolve({ ok: true, output: '' });
      case 'git:setRemote':
        setup = { ...setup, remote: req.url };
        return Promise.resolve({ ok: true });
      case 'git:push':
        setup = { ...setup, pushed: true };
        return Promise.resolve({ ok: true, output: '' });
      case 'git:createGitHubRepo':
        setup = { ...setup, remote: 'https://github.com/octocat/a.git', pushed: true };
        return Promise.resolve({ ok: true, url: 'https://github.com/octocat/a', output: '' });
      case 'settings:update':
        return Promise.resolve({});
      case 'terminal:create':
        return Promise.resolve({ id: 't1', sessionId: 's1' });
      default:
        return Promise.resolve({});
    }
  });
});

afterEach(() => {
  cleanup();
});

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const query = (name: string | RegExp) => screen.queryByRole('button', { name });

describe('guided git setup', () => {
  it('starts a non-repo folder at initialize and follows through to pushed', async () => {
    render(<RightPanel session={session} />);
    expect(await screen.findByText('Set up git in this folder')).toBeTruthy();
    expect(screen.getByText('Initialize the repository')).toBeTruthy();
    // Later steps wait their turn: only the active step shows its controls.
    expect(query('Commit')).toBeNull();

    click('Initialize repository');
    expect(await screen.findByRole('button', { name: 'Commit' })).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith('git:init', { sessionId: 's1' });

    click('Commit');
    expect(await screen.findByText('Connect a GitHub repository')).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith('git:initialCommit', { sessionId: 's1', message: 'Initial commit' });

    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://github.com/me/a.git' } });
    click('Connect');
    expect(await screen.findByRole('button', { name: 'Push to GitHub' })).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith('git:setRemote', { sessionId: 's1', url: 'https://github.com/me/a.git' });

    click('Push to GitHub');
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('git:push', { sessionId: 's1' }));
    // The banner has nothing left to say once the branch exists on origin.
    await waitFor(() => expect(screen.queryByText('Publish this repository to GitHub')).toBeNull());
  });

  it('offers the GitHub CLI install command and the by-hand steps when gh is missing', async () => {
    setup = status({ isRepo: true, root: 'G:/proj/a', branch: 'main', hasCommits: true });
    render(<RightPanel session={session} />);
    expect(await screen.findByText('Publish this repository to GitHub')).toBeTruthy();
    expect(screen.getByText('winget install --id GitHub.cli')).toBeTruthy();
    expect(screen.getByText(/github\.com\/new/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Install page' })).toBeTruthy();
    // The install command can be pushed into the session's shell.
    fireEvent.click(screen.getByRole('button', { name: /Run in terminal: winget/ }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('terminal:input', { terminalId: 't1', data: 'winget install --id GitHub.cli\r' }));
  });

  it('creates the repository through gh when signed in, defaulting to private', async () => {
    setup = status({ isRepo: true, root: 'G:/proj/a', branch: 'main', hasCommits: true, gh: ghReady });
    render(<RightPanel session={session} />);
    expect(await screen.findByText(/Signed in to the GitHub CLI/)).toBeTruthy();
    expect((screen.getByLabelText('Repository name') as HTMLInputElement).value).toBe('a');
    click('Create repository and push');
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('git:createGitHubRepo', { sessionId: 's1', name: 'a', private: true }));
    // Creating the repository sets origin and pushes, so the banner has nothing left to say.
    await waitFor(() => expect(screen.queryByText('Publish this repository to GitHub')).toBeNull());
  });

  it('is hidable so it does not nag', async () => {
    setup = status({ isRepo: true, root: 'G:/proj/a', branch: 'main', hasCommits: true });
    render(<RightPanel session={session} />);
    expect(await screen.findByText('Publish this repository to GitHub')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss GitHub setup' }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('settings:update', { gitSetupSkipped: ['G:/proj/a'] }));
  });

  it('stays hidden once the branch is on origin', async () => {
    setup = status({ isRepo: true, root: 'G:/proj/a', branch: 'main', hasCommits: true, remote: 'https://github.com/me/a.git', pushed: true });
    render(<RightPanel session={session} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('git:setupStatus', { sessionId: 's1' }));
    expect(screen.queryByText('Publish this repository to GitHub')).toBeNull();
  });

  it('shows the guide in the Changes tab too, and swaps to the change list once initialized', async () => {
    useStore.setState({ panelTab: 'changes' });
    render(<RightPanel session={session} />);
    expect(await screen.findByText('Set up git in this folder')).toBeTruthy();
    click('Initialize repository');
    // The Changes tab has no publish banner; it hands over to the normal diff view.
    await waitFor(() => expect(screen.queryByText('Set up git in this folder')).toBeNull());
    expect(await screen.findByText('Working tree clean.')).toBeTruthy();
  });
});

describe('GitSetup helpers', () => {
  it('derives a GitHub-safe repository name from the folder', () => {
    expect(repoNameFor('G:/proj/My Project!')).toBe('My-Project-');
    expect(repoNameFor('G:/proj/.hidden')).toBe('hidden');
    expect(repoNameFor('G:/')).toBe('G-');
  });

  it('turns https and ssh remotes into a browser URL', () => {
    expect(remoteWebUrl('https://github.com/you/project.git')).toBe('https://github.com/you/project');
    expect(remoteWebUrl('git@github.com:you/project.git')).toBe('https://github.com/you/project');
    expect(remoteWebUrl('ssh://git@gitlab.com/you/project.git')).toBe('https://gitlab.com/you/project');
    expect(remoteWebUrl('not a url')).toBeUndefined();
  });

  it('renders nothing while the status is loading in the banner position', () => {
    invokeMock.mockImplementation(() => new Promise(() => undefined));
    const { container } = render(<GitSetup session={session} variant="banner" />);
    expect(container.textContent).toBe('');
  });

  it('confirms a fully pushed repository in the page position', async () => {
    setup = status({ isRepo: true, root: 'G:/proj/a', branch: 'main', hasCommits: true, remote: 'git@github.com:me/a.git', pushed: true, gh: ghReady });
    render(<GitSetup session={session} variant="page" />);
    expect(await screen.findByText(/Your repository is on GitHub/)).toBeTruthy();
    expect(screen.getByText('github.com/me/a')).toBeTruthy();
  });

  it('asks gh to sign in when the CLI is installed but signed out', async () => {
    setup = status({ isRepo: true, root: 'G:/proj/a', branch: 'main', hasCommits: true, gh: { installed: true, authenticated: false } });
    render(<GitSetup session={session} variant="page" />);
    expect(await screen.findByText('gh not signed in')).toBeTruthy();
    expect(screen.getByText('gh auth login')).toBeTruthy();
  });
});