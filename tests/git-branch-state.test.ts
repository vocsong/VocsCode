import { beforeEach, describe, expect, it, vi } from 'vitest';

const { which, runCapture } = vi.hoisted(() => ({ which: vi.fn(), runCapture: vi.fn() }));

vi.mock('../src/main/runtime', () => ({ which, runCapture }));

import { branchGitState, findSessionPrs, gitFolderBranch } from '../src/main/git';
import type { CaptureResult } from '../src/main/runtime';

const GIT = '/usr/bin/git';
const GH = '/usr/bin/gh';
const PR_LIST_ARGS = ['pr', 'list', '--state', 'all', '--limit', '50', '--json', 'number,state,headRefName,baseRefName,url,title'];

/** Registered git replies; the branch probes branchGitState makes are matched by exact args. */
const replies = new Map<string, CaptureResult>();
const key = (args: string[]) => `${GIT} ${JSON.stringify(args)}`;

function gitReply(args: string[], res: { code: number; stdout?: string; stderr?: string }): void {
  replies.set(key(args), { code: res.code, stdout: res.stdout ?? '', stderr: res.stderr ?? '' });
  runCapture.mockImplementation((cmd: string, args2: string[]) => replies.get(`${cmd} ${JSON.stringify(args2)}`) ?? { code: 1, stdout: '', stderr: 'unexpected call' });
}

function ghReply(res: Partial<CaptureResult>): void {
  which.mockImplementation((cmd: string) => cmd === 'git' ? GIT : cmd === 'gh' ? GH : null);
  replies.set(`${GH} ${JSON.stringify(PR_LIST_ARGS)}`, { code: 0, stdout: '[]', stderr: '', ...res });
  runCapture.mockImplementation((cmd: string, args: string[]) => replies.get(`${cmd} ${JSON.stringify(args)}`) ?? { code: 1, stdout: '', stderr: 'unexpected call' });
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

  it('reports a missing repository as unknown', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 1 });
    expect(await branchGitState('/repo', 'work')).toEqual({ pr: false, merged: false, unknown: true });
  });

  it.each([
    ['nonzero exit', { code: 1, stdout: '[]', stderr: 'authentication failed' }],
    ['timeout', { code: null, timedOut: true }],
    ['timeout with zero exit', { code: 0, timedOut: true }],
    ['malformed JSON', { stdout: '[{"state":' }],
    ['non-array JSON', { stdout: '{}' }],
    ['invalid PR entry', { stdout: '[null]' }],
    ['truncated output', { stdout: '[]', truncated: true }]
  ] satisfies [string, Partial<CaptureResult>][])('reports %s as unknown rather than a confirmed empty list', async (_name, result) => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: '/repo' });
    ghReply(result);
    expect(await branchGitState('/repo', 'work')).toEqual({ pr: false, merged: false, unknown: true });
    expect(await findSessionPrs('/repo')).toEqual({ refs: [], direct: [], fallback: [], incomplete: true });
  });

  it.each(['[]', '[{"number":7,"state":"CLOSED","headRefName":"work"}]'])('keeps a successful empty or closed lookup known: %s', async (stdout) => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: '/repo' });
    ghReply({ stdout });
    expect(await branchGitState('/repo', 'work')).toEqual({ pr: false, merged: false });
    expect(await findSessionPrs('/repo')).toEqual({ refs: [], direct: [], fallback: [] });
  });

  it('retains positive git merge evidence despite a failed PR lookup', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: '/repo' });
    gitReply(['rev-parse', '--verify', 'work'], { code: 0, stdout: `${TIP}\n` });
    gitReply(mergeScan('develop'), { code: 0, stdout: `deadbeef ${TIP}\n` });
    ghReply({ code: 1 });
    expect(await branchGitState('/repo', 'work')).toEqual({ pr: false, merged: true });
  });

  it('propagates an incomplete foreign lookup without discarding local PR evidence', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: '/repo' });
    gitReply(['remote', 'get-url', 'origin'], { code: 0, stdout: 'https://github.com/owner/repo.git' });
    const pr = { number: 7, state: 'OPEN', headRefName: 'work' };
    ghReply({ stdout: JSON.stringify([pr]) });
    const query = { branches: ['work'], prRefs: [{ repo: 'other/repo', number: 8 }] };
    expect(await findSessionPrs('/repo', query)).toEqual({ refs: [], direct: [pr], fallback: [], incomplete: true });
    // The latest explicit reference could not be resolved: the older local PR must
    // not own this label just because its lookup happened to succeed.
    expect(await branchGitState('/repo', 'work', query)).toEqual({ pr: false, merged: false, unknown: true });
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
    expect(await branchGitState('/repo', 'work')).toEqual({ pr: false, merged: false, unknown: true });
  });

  it('does not mark a branch merely behind a base branch as merged', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/repo' });
    gitReply(['rev-parse', '--verify', 'work'], { code: 0, stdout: `${TIP}\n` });
    for (const base of ['develop', 'master', 'main']) gitReply(mergeScan(base), { code: 0, stdout: 'aaa bbb\n' });
    gitReply(['rev-parse', '--verify', '--quiet', 'origin/work'], { code: 1 });
    expect(await branchGitState('/repo', 'work')).toEqual({ pr: false, merged: false, unknown: true });
  });

  it('falls back to remote tracking for a pushed branch when gh is missing', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/repo' });
    gitReply(['rev-parse', '--verify', 'work'], { code: 0, stdout: `${TIP}\n` });
    for (const base of ['develop', 'master', 'main']) gitReply(mergeScan(base), { code: 0, stdout: '' });
    gitReply(['rev-parse', '--verify', '--quiet', 'origin/work'], { code: 0 });
    gitReply(['rev-list', '--count', 'origin/work..work'], { code: 0, stdout: '0\n' });
    expect(await branchGitState('/repo', 'work')).toEqual({ pr: true, merged: false, unknown: true });
  });

  it('treats local-only commits as neither PR nor merged', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/repo' });
    gitReply(['rev-parse', '--verify', 'work'], { code: 0, stdout: `${TIP}\n` });
    for (const base of ['develop', 'master', 'main']) gitReply(mergeScan(base), { code: 1 });
    gitReply(['rev-parse', '--verify', '--quiet', 'origin/work'], { code: 1 });
    expect(await branchGitState('/repo', 'work')).toEqual({ pr: false, merged: false, unknown: true });
    expect(await findSessionPrs('/repo')).toEqual({ refs: [], direct: [], fallback: [], incomplete: true });
  });

  it.each([
    ['MERGED', { pr: false, merged: true }],
    ['OPEN', { pr: true, merged: false }],
    ['CLOSED', { pr: false, merged: false }]
  ] as const)('follows the latest referenced PR (%s), not an older open PR on the session branch', async (state, expected) => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: '/repo' });
    gitReply(['remote', 'get-url', 'origin'], { code: 0, stdout: 'https://github.com/owner/repo.git' });
    ghReply({ stdout: JSON.stringify([
      { number: 8, state, headRefName: 'pi/new-work' },
      { number: 7, state: 'OPEN', headRefName: 'work' }
    ]) });
    expect(await branchGitState('/repo', 'work', { prRefs: [
      { repo: 'owner/repo', number: 7 }, { repo: 'owner/repo', number: 8 }
    ] })).toEqual(expected);
  });

  it('queries the latest referenced PR directly when it is outside the repo list limit', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: '/repo' });
    gitReply(['remote', 'get-url', 'origin'], { code: 0, stdout: 'https://github.com/owner/repo.git' });
    ghReply({ stdout: '[{"number":7,"state":"OPEN","headRefName":"work"}]' });
    const args = ['pr', 'view', '8', '--json', 'number,state,headRefName,baseRefName,url,title', '-R', 'owner/repo'];
    replies.set(`${GH} ${JSON.stringify(args)}`, { code: 0, stdout: '{"number":8,"state":"MERGED"}', stderr: '' });
    expect(await branchGitState('/repo', 'work', { prRefs: [{ repo: 'owner/repo', number: 8 }] })).toEqual({ pr: false, merged: true });
    expect(runCapture).toHaveBeenCalledWith(GH, args, expect.objectContaining({ cwd: '/repo', timeoutMs: 15_000 }));
  });

  it('does not fall back to an older open PR when the latest reference is unavailable', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: '/repo' });
    gitReply(['remote', 'get-url', 'origin'], { code: 0, stdout: 'https://github.com/owner/repo.git' });
    ghReply({ stdout: '[{"number":7,"state":"OPEN","headRefName":"work"}]' });
    expect(await branchGitState('/repo', 'work', { prRefs: [{ repo: 'owner/repo', number: 8 }] })).toEqual({ pr: false, merged: false, unknown: true });
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
