import { beforeEach, describe, expect, it, vi } from 'vitest';

const { which, runCapture } = vi.hoisted(() => ({ which: vi.fn(), runCapture: vi.fn() }));

vi.mock('../src/main/runtime', () => ({ which, runCapture }));

import { branchGitState, gitFolderBranch } from '../src/main/git';

const GIT = '/usr/bin/git';

/** Registered git replies; the branch probes branchGitState makes are matched by exact args. */
const replies = new Map<string, { code: number; stdout: string; stderr: string }>();
const key = (args: string[]) => `${GIT} ${JSON.stringify(args)}`;

function gitReply(args: string[], res: { code: number; stdout?: string; stderr?: string }): void {
  replies.set(key(args), { code: res.code, stdout: res.stdout ?? '', stderr: res.stderr ?? '' });
  runCapture.mockImplementation((cmd: string, args2: string[]) => replies.get(`${cmd} ${JSON.stringify(args2)}`) ?? { code: 1, stdout: '', stderr: 'unexpected call' });
}

const TIP = 'abc123';

/** The per-base merge-commit scans branchGitState makes when gh is unavailable. */
const mergeScan = (base: string) => ['log', base, '--merges', '--format=%P', '-n', '200'];

describe('gitFolderBranch', () => {
  beforeEach(() => {
    which.mockReset();
    runCapture.mockReset();
    replies.clear();
    which.mockImplementation((cmd: string) => cmd === 'git' ? GIT : null);
  });

  it.each(['G:\\repo', '/repo', '/repo/.vocs-code/worktrees/task'])('reads HEAD in the requested folder %s', async (cwd) => {
    gitReply(['symbolic-ref', '--quiet', '--short', 'HEAD'], { code: 0, stdout: 'develop\n' });
    expect(await gitFolderBranch(cwd)).toEqual({ branch: 'develop' });
    expect(runCapture).toHaveBeenCalledWith(GIT, ['symbolic-ref', '--quiet', '--short', 'HEAD'], expect.objectContaining({ cwd }));
    // Symbolic HEAD also works before the repository has its first commit.
    expect(runCapture).toHaveBeenCalledTimes(1);
  });

  it('identifies a detached checkout by its short commit', async () => {
    gitReply(['symbolic-ref', '--quiet', '--short', 'HEAD'], { code: 1 });
    gitReply(['rev-parse', '--verify', '--short', 'HEAD'], { code: 0, stdout: 'abc1234\n' });
    expect(await gitFolderBranch('/repo')).toEqual({ branch: 'abc1234', detached: true });
  });

  it('omits the branch for non-repositories and inaccessible folders', async () => {
    gitReply(['symbolic-ref', '--quiet', '--short', 'HEAD'], { code: 128 });
    gitReply(['rev-parse', '--verify', '--short', 'HEAD'], { code: 128 });
    expect(await gitFolderBranch('/missing')).toEqual({});
  });
});

describe('branchGitState', () => {
  beforeEach(() => {
    which.mockReset();
    runCapture.mockReset();
    replies.clear();
    which.mockImplementation((cmd: string) => (cmd === 'git' ? GIT : null));
  });

  it('reports not-a-repo as neither PR nor merged', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 1 });
    expect(await branchGitState('/repo', 'work')).toEqual({ pr: false, merged: false });
  });

  it('marks a branch whose merge commit landed on a base branch as merged', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/repo' });
    gitReply(['rev-parse', '--verify', 'work'], { code: 0, stdout: `${TIP}\n` });
    gitReply(mergeScan('develop'), { code: 0, stdout: `deadbeef ${TIP}\n` });
    expect(await branchGitState('/repo', 'work')).toEqual({ pr: false, merged: true });
  });

  it('does not mark a fresh branch sitting at the base tip as merged', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/repo' });
    gitReply(['rev-parse', '--verify', 'work'], { code: 0, stdout: `${TIP}\n` });
    for (const base of ['develop', 'master', 'main']) gitReply(mergeScan(base), { code: 0, stdout: '' });
    gitReply(['rev-parse', '--verify', '--quiet', 'origin/work'], { code: 1 });
    expect(await branchGitState('/repo', 'work')).toEqual({ pr: false, merged: false });
  });

  it('does not mark a branch merely behind a base branch as merged', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/repo' });
    gitReply(['rev-parse', '--verify', 'work'], { code: 0, stdout: `${TIP}\n` });
    for (const base of ['develop', 'master', 'main']) gitReply(mergeScan(base), { code: 0, stdout: 'aaa bbb\n' });
    gitReply(['rev-parse', '--verify', '--quiet', 'origin/work'], { code: 1 });
    expect(await branchGitState('/repo', 'work')).toEqual({ pr: false, merged: false });
  });

  it('falls back to remote tracking for a pushed branch when gh is missing', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/repo' });
    gitReply(['rev-parse', '--verify', 'work'], { code: 0, stdout: `${TIP}\n` });
    for (const base of ['develop', 'master', 'main']) gitReply(mergeScan(base), { code: 0, stdout: '' });
    gitReply(['rev-parse', '--verify', '--quiet', 'origin/work'], { code: 0 });
    gitReply(['rev-list', '--count', 'origin/work..work'], { code: 0, stdout: '0\n' });
    expect(await branchGitState('/repo', 'work')).toEqual({ pr: true, merged: false });
  });

  it('treats local-only commits as neither PR nor merged', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/repo' });
    gitReply(['rev-parse', '--verify', 'work'], { code: 0, stdout: `${TIP}\n` });
    for (const base of ['develop', 'master', 'main']) gitReply(mergeScan(base), { code: 1 });
    gitReply(['rev-parse', '--verify', '--quiet', 'origin/work'], { code: 1 });
    expect(await branchGitState('/repo', 'work')).toEqual({ pr: false, merged: false });
  });

  it('uses gh when available: an open PR is pr, a merged PR is merged', async () => {
    which.mockImplementation((cmd: string) => (cmd === 'git' ? GIT : cmd === 'gh' ? '/usr/bin/gh' : null));
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/repo' });
    runCapture.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === '/usr/bin/gh' && args[0] === 'pr') return Promise.resolve({ code: 0, stdout: '[{"state":"OPEN","headRefName":"work"}]', stderr: '' });
      if (cmd === GIT && JSON.stringify(args) === JSON.stringify(['rev-parse', '--show-toplevel'])) return Promise.resolve({ code: 0, stdout: 'C:/repo', stderr: '' });
      return Promise.resolve({ code: 1, stdout: '', stderr: 'unexpected call' });
    });
    expect(await branchGitState('/repo', 'work')).toEqual({ pr: true, merged: false });

    runCapture.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === '/usr/bin/gh' && args[0] === 'pr') return Promise.resolve({ code: 0, stdout: '[{"state":"MERGED","headRefName":"work"}]', stderr: '' });
      if (cmd === GIT && JSON.stringify(args) === JSON.stringify(['rev-parse', '--show-toplevel'])) return Promise.resolve({ code: 0, stdout: 'C:/repo', stderr: '' });
      return Promise.resolve({ code: 1, stdout: '', stderr: 'unexpected call' });
    });
    expect(await branchGitState('/repo', 'work')).toEqual({ pr: false, merged: true });
  });

  it('detects squash merges that git ancestry misses via gh', async () => {
    which.mockImplementation((cmd: string) => (cmd === 'git' ? GIT : cmd === 'gh' ? '/usr/bin/gh' : null));
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/repo' });
    runCapture.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === '/usr/bin/gh' && args[0] === 'pr') return Promise.resolve({ code: 0, stdout: '[{"state":"MERGED","headRefName":"work"},{"state":"CLOSED","headRefName":"work"}]', stderr: '' });
      if (cmd === GIT && JSON.stringify(args) === JSON.stringify(['rev-parse', '--show-toplevel'])) return Promise.resolve({ code: 0, stdout: 'C:/repo', stderr: '' });
      return Promise.resolve({ code: 1, stdout: '', stderr: 'unexpected call' });
    });
    expect(await branchGitState('/repo', 'work')).toEqual({ pr: false, merged: true });
  });

  /** gh + repo replies for the agent-branch fallback: the PR's head is not the session branch. */
  const agentPrReply = (prs: object[]) =>
    runCapture.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === '/usr/bin/gh' && args[0] === 'pr') return Promise.resolve({ code: 0, stdout: JSON.stringify(prs), stderr: '' });
      return Promise.resolve(replies.get(`${cmd} ${JSON.stringify(args)}`) ?? { code: 1, stdout: '', stderr: 'unexpected call' });
    });

  it('attributes a PR on the agent-owned branch to the session when unambiguous', async () => {
    which.mockImplementation((cmd: string) => (cmd === 'git' ? GIT : cmd === 'gh' ? '/usr/bin/gh' : null));
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/repo' });
    gitReply(['for-each-ref', 'refs/heads', '--format=%(refname:short)'], { code: 0, stdout: 'work\nagent/feature\n' });
    const NOW = 1_000_000_000_000;
    gitReply(['show', '-s', '--format=%ct', 'agent/feature'], { code: 0, stdout: `${Math.floor(NOW / 1000)}\n` });
    agentPrReply([{ number: 7, state: 'OPEN', headRefName: 'agent/feature' }]);
    expect(
      await branchGitState('/repo', 'work', { createdAfter: NOW - 60_000 * 60, updatedBefore: NOW + 60_000 })
    ).toEqual({ pr: true, merged: false });
  });

  it('ignores fallback PRs committed after the session went idle', async () => {
    which.mockImplementation((cmd: string) => (cmd === 'git' ? GIT : cmd === 'gh' ? '/usr/bin/gh' : null));
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/repo' });
    gitReply(['for-each-ref', 'refs/heads', '--format=%(refname:short)'], { code: 0, stdout: 'work\nagent/feature\n' });
    const NOW = 1_000_000_000_000;
    gitReply(['show', '-s', '--format=%ct', 'agent/feature'], { code: 0, stdout: `${Math.floor(NOW / 1000) + 3600}\n` });
    agentPrReply([{ number: 7, state: 'OPEN', headRefName: 'agent/feature' }]);
    expect(
      await branchGitState('/repo', 'work', { createdAfter: NOW - 60_000 * 60, updatedBefore: NOW })
    ).toEqual({ pr: false, merged: false });
  });

  it('does not flip the label when the fallback is ambiguous', async () => {
    which.mockImplementation((cmd: string) => (cmd === 'git' ? GIT : cmd === 'gh' ? '/usr/bin/gh' : null));
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/repo' });
    gitReply(['for-each-ref', 'refs/heads', '--format=%(refname:short)'], { code: 0, stdout: 'work\nagent/a\nagent/b\n' });
    const NOW = 1_000_000_000_000;
    for (const b of ['agent/a', 'agent/b']) gitReply(['show', '-s', '--format=%ct', b], { code: 0, stdout: `${Math.floor(NOW / 1000)}\n` });
    agentPrReply([
      { number: 7, state: 'OPEN', headRefName: 'agent/a' },
      { number: 8, state: 'OPEN', headRefName: 'agent/b' }
    ]);
    expect(
      await branchGitState('/repo', 'work', { createdAfter: NOW - 60_000 * 60, updatedBefore: NOW + 60_000 })
    ).toEqual({ pr: false, merged: false });
  });

  it('never attributes a branch owned by another session to this one', async () => {
    which.mockImplementation((cmd: string) => (cmd === 'git' ? GIT : cmd === 'gh' ? '/usr/bin/gh' : null));
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/repo' });
    gitReply(['for-each-ref', 'refs/heads', '--format=%(refname:short)'], { code: 0, stdout: 'work\nother/session\n' });
    const NOW = 1_000_000_000_000;
    gitReply(['show', '-s', '--format=%ct', 'other/session'], { code: 0, stdout: `${Math.floor(NOW / 1000)}\n` });
    agentPrReply([{ number: 7, state: 'OPEN', headRefName: 'other/session' }]);
    expect(
      await branchGitState('/repo', 'work', { excludeBranches: ['other/session'], createdAfter: NOW - 60_000 * 60, updatedBefore: NOW + 60_000 })
    ).toEqual({ pr: false, merged: false });
  });
});
