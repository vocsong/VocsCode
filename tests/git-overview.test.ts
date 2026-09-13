import path from 'node:path';
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
    // Three commits ahead of base cannot also be its ancestor.
    expect(fix.merged).toBe(false);
    expect(fix.behind).toBe(12);
    expect(fix.ahead).toBe(3);
    expect(fix.worktreePath).toContain('worktrees' + path.sep + 'fix');
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

  it('bounds branch probes across 100 refs and reuses successful ancestry counts', async () => {
    const names = Array.from({ length: 100 }, (_, i) => `work-${i}`);
    const pending: (() => void)[] = [];
    let active = 0;
    let peak = 0;
    let completed = false;
    runCapture.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'C:/repo', stderr: '' };
      if (args[0] === 'worktree') return { code: 0, stdout: 'worktree C:/repo\nbranch refs/heads/develop\n', stderr: '' };
      if (args[0] === 'for-each-ref') return {
        code: 0, stderr: '', stdout: ['develop\t1\tBase\t\t', ...names.map((name, i) => `${name}\t${i + 2}\tWork\t\t`)].join('\n'),
      };
      const index = Number((args[0] === 'rev-list' ? args[3].split('...')[1] : args[2]).slice(5));
      active++;
      peak = Math.max(peak, active);
      return new Promise((resolve) => pending.push(() => {
        active--;
        resolve(args[0] === 'rev-list'
          ? { code: 0, stdout: `${index}\t${index % 2}\n`, stderr: '' }
          : { code: 1, stdout: '', stderr: '' });
      }));
    });
    const result = gitBranchesOverview('C:/repo').then((value) => { completed = true; return value; });
    // Drain explicitly deferred child processes, allowing each worker to advance between batches.
    for (let turn = 0; turn < 1000 && !completed; turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      pending.splice(0).forEach((resolve) => resolve());
    }
    expect(completed).toBe(true);
    const overview = await result;
    expect(peak).toBeLessThanOrEqual(4);
    expect(active).toBe(0);
    expect(overview.branches.map((b) => b.name)).toEqual(['develop', ...[...names].reverse()]);
    expect(overview.branches.filter((b) => b.merged)).toHaveLength(50);
    for (const [index, name] of names.entries()) {
      expect(overview.branches.find((b) => b.name === name)).toMatchObject({
        ahead: index % 2, behind: index, merged: index % 2 === 0, current: false,
      });
    }
    expect(runCapture.mock.calls.filter(([, args]) => args[0] === 'rev-list')).toHaveLength(100);
    const ancestry = runCapture.mock.calls.filter(([, args]) => args[0] === 'merge-base');
    expect(ancestry).toHaveLength(0);
  });

  it.each([
    { code: 1, stdout: '8\t0\n', stderr: 'failed' },
    { code: 0, stdout: '8\t0\n', stderr: '', truncated: true },
    { code: null, stdout: '8\t0\n', stderr: 'timed out after 20000ms', timedOut: true },
    { code: 0, stdout: 'invalid', stderr: '' },
  ])('falls back to ancestry without trusting incomplete counts: %j', async (counts) => {
    runCapture.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'C:/repo', stderr: '' };
      if (args[0] === 'for-each-ref') return { code: 0, stdout: 'develop\t1\tBase\t\t\nwork\t2\tWork\t\t', stderr: '' };
      if (args[0] === 'rev-list') return counts;
      return { code: 0, stdout: '', stderr: '' };
    });
    const overview = await gitBranchesOverview('C:/repo');
    expect(overview.branches).toHaveLength(2);
    expect(overview.branches[1]).toMatchObject({ name: 'work', merged: true });
    expect(overview.branches[1].ahead).toBeUndefined();
    expect(overview.branches[1].behind).toBeUndefined();
    expect(runCapture.mock.calls.filter(([, args]) => args[0] === 'merge-base').map(([, args]) => args)).toEqual([
      ['merge-base', '--is-ancestor', 'work', 'develop'],
    ]);
  });

  it('attaches GitHub PR state when gh is available', async () => {
    which.mockImplementation((cmd: string) => (cmd === 'git' ? GIT : cmd === 'gh' ? '/usr/bin/gh' : null));
    gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: 'C:/repo' });
    gitReply(['worktree', 'list', '--porcelain'], { code: 0, stdout: WORKTREE_LIST });
    gitReply(['for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(committerdate:unix)%09%(subject)%09%(upstream:short)%09%(upstream:track)'], { code: 0, stdout: REFS });
    gitReply(['rev-list', '--left-right', '--count', 'develop...harness/fix'], { code: 0, stdout: '12\t3\n' });
    gitReply(['rev-list', '--left-right', '--count', 'develop...vocscode/current'], { code: 0, stdout: '4\t1\n' });
    gitReply(['rev-list', '--left-right', '--count', 'develop...stale-old'], { code: 0, stdout: '20\t0\n' });
    gitReply(['merge-base', '--is-ancestor', 'harness/fix', 'develop'], { code: 0 });
    gitReply(['merge-base', '--is-ancestor', 'vocscode/current', 'develop'], { code: 1 });
    gitReply(['merge-base', '--is-ancestor', 'stale-old', 'develop'], { code: 0 });
    replies.set(
      '/usr/bin/gh ' + JSON.stringify(['pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,headRefName,state,url,title']),
      { code: 0, stdout: JSON.stringify([
        { number: 21, headRefName: 'harness/fix', state: 'MERGED', url: 'https://example.com/acme/repo/pull/21' },
        { number: 22, headRefName: 'vocscode/current', state: 'OPEN', url: 'https://example.com/acme/repo/pull/22', title: 'Current work' }
      ]), stderr: '' }
    );

    const r = await gitBranchesOverview('C:/repo/.vocs-code/worktrees/current');
    const byName = new Map(r.branches.map((b) => [b.name, b]));
    expect(byName.get('harness/fix')!.pr).toEqual({ number: 21, state: 'MERGED', url: 'https://example.com/acme/repo/pull/21' });
    expect(byName.get('vocscode/current')!.pr).toEqual({ number: 22, state: 'OPEN', url: 'https://example.com/acme/repo/pull/22', title: 'Current work' });
    expect(byName.get('stale-old')!.pr).toBeUndefined();
  });
});