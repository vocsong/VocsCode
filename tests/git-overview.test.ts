import { beforeEach, describe, expect, it, vi } from 'vitest';

const { which, runCapture } = vi.hoisted(() => ({ which: vi.fn(), runCapture: vi.fn() }));

vi.mock('../src/main/runtime', () => ({ which, runCapture }));

import { gitBranchesOverview, parseUpstreamTrack, pickBase } from '../src/main/git';

const GIT = '/usr/bin/git';

/** Registered git replies; probes are matched by exact args. */
const replies = new Map<string, { code: number; stdout: string; stderr: string }>();
const key = (args: string[]) => `${GIT} ${JSON.stringify(args)}`;

function gitReply(args: string[], res: { code: number; stdout?: string; stderr?: string }): void {
  replies.set(key(args), { code: res.code, stdout: res.stdout ?? '', stderr: res.stderr ?? '' });
  runCapture.mockImplementation((cmd: string, args2: string[]) => replies.get(`${cmd} ${JSON.stringify(args2)}`) ?? { code: 1, stdout: '', stderr: 'unexpected call' });
}

const WORKTREE_LIST = [
  'worktree C:/repo',
  'HEAD abc',
  'branch refs/heads/develop',
  '',
  'worktree C:/repo/.vocs-code/worktrees/fix',
  'HEAD def',
  'branch refs/heads/harness/fix',
  '',
  'worktree C:/repo/.vocs-code/worktrees/current',
  'HEAD 789',
  'branch refs/heads/vocscode/current',
  ''
].join('\n');

const REFS = [
  'develop\t1700000000\tBase branch\torigin/develop\t',
  'harness/fix\t1701000000\tFix the bug\t\t',
  'vocscode/current\t1702000000\tCurrent work\torigin/vocscode/current\t[behind 4, ahead 1]',
  'stale-old\t1690000000\tOld work\t\t'
].join('\n');

describe('pickBase', () => {
  it('prefers develop, then master/main', () => {
    expect(pickBase(['master', 'develop', 'work'])).toBe('develop');
    expect(pickBase(['main', 'work'])).toBe('main');
    expect(pickBase(['work', 'master'])).toBe('master');
  });
  it('falls back to the first branch when no base exists', () => {
    expect(pickBase(['harness/x', 'vocscode/y'])).toBe('harness/x');
    expect(pickBase([])).toBe('master');
  });
});

describe('parseUpstreamTrack', () => {
  it('parses ahead/behind/gone and ignores empty track output', () => {
    expect(parseUpstreamTrack('')).toEqual({});
    expect(parseUpstreamTrack('[ahead 3]')).toEqual({ ahead: 3 });
    expect(parseUpstreamTrack('[behind 7]')).toEqual({ behind: 7 });
    expect(parseUpstreamTrack('[behind 7, ahead 2]')).toEqual({ ahead: 2, behind: 7 });
    expect(parseUpstreamTrack('[gone]')).toEqual({ gone: true });
  });
  it('drops zero counts so synced branches show no arrows', () => {
    expect(parseUpstreamTrack('[ahead 0, behind 0]')).toEqual({});
  });
});

describe('gitBranchesOverview', () => {
  beforeEach(() => {
    which.mockReset();
    runCapture.mockReset();
    replies.clear();
    which.mockImplementation((cmd: string) => (cmd === 'git' ? GIT : null));
  });

  it('reports not-a-repo', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 1 });
    expect(await gitBranchesOverview('/repo')).toEqual({ isRepo: false, branches: [], worktrees: [] });
  });

  it('collects age, ahead/behind vs base, merged state and worktree binding', async () => {
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/repo' });
    gitReply(['worktree', 'list', '--porcelain'], { code: 0, stdout: WORKTREE_LIST });
    gitReply(['for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(committerdate:unix)%09%(subject)%09%(upstream:short)%09%(upstream:track)'], { code: 0, stdout: REFS });
    gitReply(['rev-list', '--left-right', '--count', 'develop...harness/fix'], { code: 0, stdout: '12\t3\n' });
    gitReply(['rev-list', '--left-right', '--count', 'develop...vocscode/current'], { code: 0, stdout: '4\t1\n' });
    gitReply(['rev-list', '--left-right', '--count', 'develop...stale-old'], { code: 0, stdout: '20\t0\n' });
    gitReply(['merge-base', '--is-ancestor', 'harness/fix', 'develop'], { code: 0 });
    gitReply(['merge-base', '--is-ancestor', 'vocscode/current', 'develop'], { code: 1 });
    gitReply(['merge-base', '--is-ancestor', 'stale-old', 'develop'], { code: 0 });

    const r = await gitBranchesOverview('C:/repo/.vocs-code/worktrees/current');
    expect(r.isRepo).toBe(true);
    expect(r.base).toBe('develop');
    expect(r.worktrees).toHaveLength(3);

    const byName = new Map(r.branches.map((b) => [b.name, b]));
    // Base branch pinned first and marked.
    expect(r.branches[0].name).toBe('develop');
    expect(r.branches[0].isBase).toBe(true);
    expect(r.branches[0].merged).toBe(false);

    const fix = byName.get('harness/fix')!;
    expect(fix.merged).toBe(true);
    expect(fix.behind).toBe(12);
    expect(fix.ahead).toBe(3);
    expect(fix.worktreePath).toContain('worktrees' + '\\' + 'fix');
    expect(fix.lastCommitSubject).toBe('Fix the bug');

    const cur = byName.get('vocscode/current')!;
    expect(cur.merged).toBe(false);
    expect(cur.upstreamAhead).toBe(1);
    expect(cur.upstreamBehind).toBe(4);
    // The worktree whose path matches the queried session cwd is "current".
    expect(cur.current).toBe(true);

    const old = byName.get('stale-old')!;
    expect(old.merged).toBe(true);
    expect(old.upstream).toBeUndefined();
  });
});