import { beforeEach, describe, expect, it, vi } from 'vitest';

const { which, runCapture } = vi.hoisted(() => ({ which: vi.fn(), runCapture: vi.fn() }));

vi.mock('../src/main/runtime', () => ({ which, runCapture }));

import { branchGitState } from '../src/main/git';

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
      if (cmd === '/usr/bin/gh' && args[0] === 'pr') return Promise.resolve({ code: 0, stdout: '[{"state":"OPEN"}]', stderr: '' });
      if (cmd === GIT && JSON.stringify(args) === JSON.stringify(['rev-parse', '--show-toplevel'])) return Promise.resolve({ code: 0, stdout: 'C:/repo', stderr: '' });
      return Promise.resolve({ code: 1, stdout: '', stderr: 'unexpected call' });
    });
    expect(await branchGitState('/repo', 'work')).toEqual({ pr: true, merged: false });

    runCapture.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === '/usr/bin/gh' && args[0] === 'pr') return Promise.resolve({ code: 0, stdout: '[{"state":"MERGED"}]', stderr: '' });
      if (cmd === GIT && JSON.stringify(args) === JSON.stringify(['rev-parse', '--show-toplevel'])) return Promise.resolve({ code: 0, stdout: 'C:/repo', stderr: '' });
      return Promise.resolve({ code: 1, stdout: '', stderr: 'unexpected call' });
    });
    expect(await branchGitState('/repo', 'work')).toEqual({ pr: false, merged: true });
  });

  it('detects squash merges that git ancestry misses via gh', async () => {
    which.mockImplementation((cmd: string) => (cmd === 'git' ? GIT : cmd === 'gh' ? '/usr/bin/gh' : null));
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/repo' });
    runCapture.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === '/usr/bin/gh' && args[0] === 'pr') return Promise.resolve({ code: 0, stdout: '[{"state":"MERGED"},{"state":"CLOSED"}]', stderr: '' });
      if (cmd === GIT && JSON.stringify(args) === JSON.stringify(['rev-parse', '--show-toplevel'])) return Promise.resolve({ code: 0, stdout: 'C:/repo', stderr: '' });
      return Promise.resolve({ code: 1, stdout: '', stderr: 'unexpected call' });
    });
    expect(await branchGitState('/repo', 'work')).toEqual({ pr: false, merged: true });
  });
});