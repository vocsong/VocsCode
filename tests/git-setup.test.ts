/**
 * Guided git setup (git.ts): the state probe that drives the panel guide and the four actions it
 * runs. These are the production boundaries — a folder that is not a repo, an unborn branch, a
 * remote that is missing or present, and gh being absent or signed out must each be reported
 * honestly so the guide never claims a step is done that is not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const { which, runCapture } = vi.hoisted(() => ({ which: vi.fn(), runCapture: vi.fn() }));

vi.mock('../src/main/runtime', () => ({ which, runCapture }));

import { gitCreateGitHubRepo, gitInit, gitInitialCommit, gitPush, gitSetRemote, gitSetupStatus, isRemoteUrl } from '../src/main/git';
import { defaultSettings, normalizeSettings } from '../src/main/settings';

const GIT = '/usr/bin/git';
const GH = '/usr/bin/gh';
/** git.ts normalizes roots to the platform separator; expectations must do the same. */
const root = (p: string) => p.replace(/\//g, path.sep);

/** Registered replies; probes are matched by exact command + args. */
const replies = new Map<string, { code: number; stdout: string; stderr: string }>();
const key = (cmd: string, args: string[]) => `${cmd} ${JSON.stringify(args)}`;

function reply(cmd: string, args: string[], res: { code: number; stdout?: string; stderr?: string }): void {
  replies.set(key(cmd, args), { code: res.code, stdout: res.stdout ?? '', stderr: res.stderr ?? '' });
}
const gitReply = (args: string[], res: { code: number; stdout?: string; stderr?: string }) => reply(GIT, args, res);
const ghReply = (args: string[], res: { code: number; stdout?: string; stderr?: string }) => reply(GH, args, res);

beforeEach(() => {
  which.mockReset();
  runCapture.mockReset();
  replies.clear();
  which.mockImplementation((cmd: string) => (cmd === 'git' ? GIT : cmd === 'gh' ? GH : null));
  runCapture.mockImplementation((cmd: string, args: string[]) => replies.get(key(cmd, args)) ?? { code: 1, stdout: '', stderr: 'unexpected call' });
});

describe('isRemoteUrl', () => {
  it('accepts https, ssh and scp-like remotes', () => {
    expect(isRemoteUrl('https://github.com/you/project.git')).toBe(true);
    expect(isRemoteUrl('http://git.example.com/you/project')).toBe(true);
    expect(isRemoteUrl('ssh://git@github.com/you/project.git')).toBe(true);
    expect(isRemoteUrl('git://example.com/you/project')).toBe(true);
    expect(isRemoteUrl('git@github.com:you/project.git')).toBe(true);
  });

  it('rejects empty, whitespace and option-looking strings', () => {
    expect(isRemoteUrl('')).toBe(false);
    expect(isRemoteUrl('  ')).toBe(false);
    expect(isRemoteUrl('https://github.com/you/project name')).toBe(false);
    expect(isRemoteUrl('--upload-pack=touch /tmp/pwned')).toBe(false);
    expect(isRemoteUrl('origin')).toBe(false);
  });
});

describe('gitSetupStatus', () => {
  it('reports a non-repository with the gh probe attached', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 128, stderr: 'not a git repository' });
    ghReply(['auth', 'status'], { code: 0, stdout: 'Logged in to github.com account octocat (keyring)' });
    expect(await gitSetupStatus('/project')).toEqual({
      isRepo: false,
      hasCommits: false,
      pushed: false,
      gh: { installed: true, authenticated: true, account: 'octocat' }
    });
  });

  it('reports an unborn branch with no remote', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/project' });
    ghReply(['auth', 'status'], { code: 1, stderr: 'not logged in' });
    gitReply(['symbolic-ref', '--quiet', '--short', 'HEAD'], { code: 0, stdout: 'main' });
    gitReply(['rev-parse', '--verify', '--quiet', 'HEAD'], { code: 128 });
    gitReply(['remote', 'get-url', 'origin'], { code: 2, stderr: "error: No such remote 'origin'" });
    expect(await gitSetupStatus('C:/project')).toEqual({
      isRepo: true,
      root: root('C:/project'),
      branch: 'main',
      hasCommits: false,
      pushed: false,
      gh: { installed: true, authenticated: false }
    });
  });

  it('marks pushed only when the branch exists on origin', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/project' });
    ghReply(['auth', 'status'], { code: 0, stdout: 'Logged in to github.com as octocat' });
    gitReply(['symbolic-ref', '--quiet', '--short', 'HEAD'], { code: 0, stdout: 'main' });
    gitReply(['rev-parse', '--verify', '--quiet', 'HEAD'], { code: 0, stdout: 'abc123' });
    gitReply(['remote', 'get-url', 'origin'], { code: 0, stdout: 'https://github.com/you/project.git' });
    gitReply(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], { code: 0, stdout: 'abc123' });
    const s = await gitSetupStatus('C:/project');
    expect(s.remote).toBe('https://github.com/you/project.git');
    expect(s.pushed).toBe(true);
    expect(s.hasCommits).toBe(true);
    expect(s.gh.account).toBe('octocat');
  });

  it('does not claim pushed when origin has no branch ref yet', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/project' });
    ghReply(['auth', 'status'], { code: 1 });
    gitReply(['symbolic-ref', '--quiet', '--short', 'HEAD'], { code: 0, stdout: 'main' });
    gitReply(['rev-parse', '--verify', '--quiet', 'HEAD'], { code: 0, stdout: 'abc123' });
    gitReply(['remote', 'get-url', 'origin'], { code: 0, stdout: 'git@github.com:you/project.git' });
    gitReply(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], { code: 1 });
    expect((await gitSetupStatus('C:/project')).pushed).toBe(false);
  });

  it('reports gh as missing without probing auth', async () => {
    which.mockImplementation((cmd: string) => (cmd === 'git' ? GIT : null));
    gitReply(['rev-parse', '--show-toplevel'], { code: 128 });
    const s = await gitSetupStatus('/project');
    expect(s.gh).toEqual({ installed: false, authenticated: false });
    expect(runCapture).not.toHaveBeenCalledWith(GH, expect.anything(), expect.anything());
  });
});

describe('gitInit', () => {
  it('refuses a folder already inside a repository', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/parent' });
    expect(await gitInit('C:/parent/child')).toEqual({ ok: false, error: `Already inside the repository at ${root('C:/parent')}` });
  });

  it('initializes on main and names the branch', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 128 });
    gitReply(['init', '-b', 'main'], { code: 0, stdout: 'Initialized empty Git repository' });
    expect(await gitInit('C:/project')).toEqual({ ok: true });
  });

  it('falls back for git builds without -b and still names the branch main', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 128 });
    gitReply(['init', '-b', 'main'], { code: 129, stderr: "error: unknown switch `b'" });
    gitReply(['init'], { code: 0 });
    gitReply(['symbolic-ref', 'HEAD', 'refs/heads/main'], { code: 0 });
    expect(await gitInit('C:/project')).toEqual({ ok: true });
    expect(runCapture).toHaveBeenCalledWith(GIT, ['symbolic-ref', 'HEAD', 'refs/heads/main'], expect.anything());
  });

  it('surfaces the failing init', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 128 });
    gitReply(['init', '-b', 'main'], { code: 128, stderr: 'permission denied' });
    gitReply(['init'], { code: 128, stderr: 'permission denied' });
    expect(await gitInit('C:/project')).toEqual({ ok: false, error: 'permission denied' });
  });
});

describe('gitInitialCommit', () => {
  it('refuses outside a repository and on a repo that already has commits', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 128 });
    expect(await gitInitialCommit('/project', 'Initial commit')).toEqual({ ok: false, output: 'Not a git repository' });
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/project' });
    gitReply(['rev-parse', '--verify', '--quiet', 'HEAD'], { code: 0, stdout: 'abc' });
    expect(await gitInitialCommit('C:/project', 'Initial commit')).toEqual({ ok: false, output: 'This repository already has commits.' });
  });

  it('commits staged files normally', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/project' });
    gitReply(['rev-parse', '--verify', '--quiet', 'HEAD'], { code: 128 });
    gitReply(['add', '-A'], { code: 0 });
    gitReply(['diff', '--cached', '--name-only'], { code: 0, stdout: 'README.md\n' });
    gitReply(['commit', '-m', 'Initial commit'], { code: 0, stdout: '[main (root-commit) abc] Initial commit' });
    const r = await gitInitialCommit('C:/project', 'Initial commit');
    expect(r.ok).toBe(true);
    expect(runCapture).not.toHaveBeenCalledWith(GIT, ['commit', '--allow-empty', '-m', 'Initial commit'], expect.anything());
  });

  it('allows an empty commit so an empty folder can still be pushed', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/project' });
    gitReply(['rev-parse', '--verify', '--quiet', 'HEAD'], { code: 128 });
    gitReply(['add', '-A'], { code: 0 });
    gitReply(['diff', '--cached', '--name-only'], { code: 0, stdout: '' });
    gitReply(['commit', '--allow-empty', '-m', 'Initial commit'], { code: 0, stdout: '[main (root-commit) abc] Initial commit' });
    expect((await gitInitialCommit('C:/project', 'Initial commit')).ok).toBe(true);
  });
});

describe('gitSetRemote', () => {
  it('rejects a non-repository and a malformed URL before touching git', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 128 });
    expect(await gitSetRemote('/project', 'https://github.com/you/project.git')).toEqual({ ok: false, error: 'Initialize git first.' });
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/project' });
    expect((await gitSetRemote('C:/project', '--upload-pack=touch /tmp/pwned')).ok).toBe(false);
    expect(runCapture).not.toHaveBeenCalledWith(GIT, ['remote', 'add', 'origin', '--upload-pack=touch /tmp/pwned'], expect.anything());
  });

  it('adds origin when none exists and replaces it otherwise', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/project' });
    gitReply(['remote', 'get-url', 'origin'], { code: 2 });
    gitReply(['remote', 'add', 'origin', 'https://github.com/you/project.git'], { code: 0 });
    expect(await gitSetRemote('C:/project', 'https://github.com/you/project.git')).toEqual({ ok: true });

    replies.clear();
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/project' });
    gitReply(['remote', 'get-url', 'origin'], { code: 0, stdout: 'https://github.com/old/project.git' });
    gitReply(['remote', 'set-url', 'origin', 'git@github.com:you/project.git'], { code: 0 });
    expect(await gitSetRemote('C:/project', 'git@github.com:you/project.git')).toEqual({ ok: true });
  });
});

describe('gitPush', () => {
  function readyRepo(): void {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/project' });
    gitReply(['symbolic-ref', '--quiet', '--short', 'HEAD'], { code: 0, stdout: 'main' });
    gitReply(['rev-parse', '--verify', '--quiet', 'HEAD'], { code: 0, stdout: 'abc' });
    gitReply(['remote', 'get-url', 'origin'], { code: 0, stdout: 'https://github.com/you/project.git' });
  }

  it('pushes the current branch and sets its upstream', async () => {
    readyRepo();
    gitReply(['push', '-u', 'origin', 'main'], { code: 0, stdout: 'branch set up' });
    const r = await gitPush('C:/project');
    expect(r.ok).toBe(true);
    expect(r.output).toContain('branch set up');
  });

  it('says what is missing instead of asking git to fail', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 128 });
    expect((await gitPush('/project')).output).toBe('Not a git repository');

    replies.clear();
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/project' });
    gitReply(['symbolic-ref', '--quiet', '--short', 'HEAD'], { code: 0, stdout: '' });
    expect((await gitPush('C:/project')).output).toMatch(/Detached HEAD/);

    replies.clear();
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/project' });
    gitReply(['symbolic-ref', '--quiet', '--short', 'HEAD'], { code: 0, stdout: 'main' });
    gitReply(['rev-parse', '--verify', '--quiet', 'HEAD'], { code: 128 });
    expect((await gitPush('C:/project')).output).toMatch(/Nothing to push yet/);

    replies.clear();
    readyRepo();
    gitReply(['remote', 'get-url', 'origin'], { code: 2 });
    expect((await gitPush('C:/project')).output).toMatch(/No origin remote/);
  });

  it('surfaces git\'s own words when the push fails on credentials', async () => {
    readyRepo();
    gitReply(['push', '-u', 'origin', 'main'], { code: 128, stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" });
    const r = await gitPush('C:/project');
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/could not read Username/);
  });
});

describe('gitCreateGitHubRepo', () => {
  function repoReady(): void {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/project' });
    ghReply(['auth', 'status'], { code: 0, stdout: 'Logged in to github.com account octocat' });
    gitReply(['rev-parse', '--verify', '--quiet', 'HEAD'], { code: 0, stdout: 'abc' });
    gitReply(['remote', 'get-url', 'origin'], { code: 2 });
  }

  it('creates the repository, sets origin and pushes through gh', async () => {
    repoReady();
    ghReply(
      ['repo', 'create', 'project', '--private', '--source', root('C:/project'), '--remote', 'origin', '--push'],
      { code: 0, stdout: 'https://github.com/octocat/project\n' }
    );
    const r = await gitCreateGitHubRepo('C:/project', 'project', true);
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://github.com/octocat/project');
  });

  it('refuses without gh, without auth, on an invalid name, with no commit, or with an existing origin', async () => {
    which.mockImplementation((cmd: string) => (cmd === 'git' ? GIT : null));
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/project' });
    expect((await gitCreateGitHubRepo('C:/project', 'project', true)).output).toMatch(/not installed/);

    which.mockImplementation((cmd: string) => (cmd === 'git' ? GIT : cmd === 'gh' ? GH : null));
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/project' });
    ghReply(['auth', 'status'], { code: 1, stderr: 'not logged in' });
    expect((await gitCreateGitHubRepo('C:/project', 'project', true)).output).toMatch(/Not signed in/);

    repoReady();
    expect((await gitCreateGitHubRepo('C:/project', 'bad name', true)).output).toMatch(/Repository names/);

    replies.clear();
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/project' });
    ghReply(['auth', 'status'], { code: 0, stdout: 'Logged in to github.com account octocat' });
    gitReply(['rev-parse', '--verify', '--quiet', 'HEAD'], { code: 128 });
    expect((await gitCreateGitHubRepo('C:/project', 'project', true)).output).toMatch(/first commit/);

    repoReady();
    gitReply(['remote', 'get-url', 'origin'], { code: 0, stdout: 'https://github.com/you/project.git' });
    expect((await gitCreateGitHubRepo('C:/project', 'project', true)).output).toMatch(/already configured/);
  });

  it('surfaces gh\'s failure output', async () => {
    repoReady();
    ghReply(['repo', 'create', 'project', '--public', '--source', root('C:/project'), '--remote', 'origin', '--push'], { code: 1, stderr: 'name already exists on this account' });
    const r = await gitCreateGitHubRepo('C:/project', 'project', false);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/already exists/);
  });
});

describe('gitSetupSkipped settings', () => {
  it('defaults to empty and drops malformed stored roots', () => {
    expect(defaultSettings().gitSetupSkipped).toEqual([]);
    expect(normalizeSettings(undefined).gitSetupSkipped).toEqual([]);
    expect(normalizeSettings({ gitSetupSkipped: ['C:/a', '', 3 as unknown as string] }).gitSetupSkipped).toEqual(['C:/a']);
  });
});
