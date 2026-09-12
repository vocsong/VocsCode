/**
 * Offline tests for git failure surfacing (issue #127): a timed-out probe must not be rendered
 * as a complete diff/summary, and untracked files must be size-checked before being read.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { which, runCapture } = vi.hoisted(() => ({ which: vi.fn(), runCapture: vi.fn() }));

vi.mock('../src/main/runtime', () => ({ which, runCapture }));

import { gitBranchesOverview, gitDiff, gitSummary } from '../src/main/git';

const GIT = '/usr/bin/git';

interface Reply {
  code: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

const replies = new Map<string, Reply>();
const key = (args: string[]) => `${GIT} ${JSON.stringify(args)}`;
const gitReply = (args: string[], res: Reply): void => void replies.set(key(args), res);

/** runCapture's real timeout shape: code null plus the stderr marker. */
const TIMEOUT: Reply = { code: null, stdout: '', stderr: 'timed out after 20000ms', timedOut: true };

const REV_PARSE_HEAD = ['rev-parse', '--abbrev-ref', 'HEAD'];
const STATUS = ['status', '--porcelain=v1', '--untracked-files=all', '--no-renames'];
const NUMSTAT = ['diff', '--numstat', 'HEAD'];
const UPSTREAM = ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'];
const DIFF_HEAD = ['diff', 'HEAD'];
const UNTRACKED = ['ls-files', '--others', '--exclude-standard'];
const REFS = ['for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(committerdate:unix)%09%(subject)%09%(upstream:short)%09%(upstream:track)'];

let root: string;

beforeEach(async () => {
  which.mockReset();
  runCapture.mockReset();
  replies.clear();
  which.mockImplementation((cmd: string) => (cmd === 'git' ? GIT : null));
  runCapture.mockImplementation((cmd: string, args: string[]) => {
    const r = replies.get(`${cmd} ${JSON.stringify(args)}`);
    return Promise.resolve(r ? { stdout: '', stderr: '', ...r } : { code: 1, stdout: '', stderr: `unexpected call: ${args.join(' ')}` });
  });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-git-'));
  gitReply(['rev-parse', '--show-toplevel'], { code: 0, stdout: root });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('gitSummary', () => {
  it('surfaces a status timeout instead of rendering a partial file list', async () => {
    gitReply(REV_PARSE_HEAD, { code: 0, stdout: 'main\n' });
    // Legacy marker only (no timedOut field): still detected as a timeout.
    gitReply(STATUS, { code: null, stdout: '?? partial.txt\n', stderr: 'timed out after 20000ms' });
    gitReply(NUMSTAT, { code: 1 });
    gitReply(UPSTREAM, { code: 1 });

    const s = await gitSummary(root);
    expect(s.isRepo).toBe(true);
    expect(s.files).toEqual([]);
    expect(s.error).toMatch(/git status timed out/);
  });

  it('keeps the file list but flags missing line counts when numstat times out', async () => {
    gitReply(REV_PARSE_HEAD, { code: 0, stdout: 'main\n' });
    gitReply(STATUS, { code: 0, stdout: ' M a.txt\n' });
    gitReply(NUMSTAT, TIMEOUT);
    gitReply(UPSTREAM, { code: 1 });

    const s = await gitSummary(root);
    expect(s.files).toHaveLength(1);
    expect(s.files[0].additions).toBeUndefined();
    expect(s.error).toMatch(/numstat timed out/);
  });

  it('caps untracked line counting so a huge artifact is never read', async () => {
    await fs.writeFile(path.join(root, 'small.txt'), 'a\nb\nc', 'utf8');
    await fs.writeFile(path.join(root, 'big.bin'), 'x'.repeat(600_000), 'utf8');
    gitReply(REV_PARSE_HEAD, { code: 0, stdout: 'main\n' });
    gitReply(STATUS, { code: 0, stdout: '?? small.txt\n?? big.bin\n' });
    gitReply(NUMSTAT, { code: 1 });
    gitReply(UPSTREAM, { code: 1 });

    const s = await gitSummary(root);
    expect(s.error).toBeUndefined();
    expect(s.files.find((f) => f.path === 'small.txt')?.additions).toBe(3);
    expect(s.files.find((f) => f.path === 'big.bin')?.additions).toBeUndefined();
  });
});

describe('gitDiff', () => {
  it('returns an error instead of a truncated diff on timeout', async () => {
    gitReply(DIFF_HEAD, TIMEOUT);
    const r = await gitDiff(root);
    expect(r.diff).toBe('');
    expect(r.error).toMatch(/git diff timed out/);
  });

  it('caps untracked files before reading them into the diff', async () => {
    await fs.writeFile(path.join(root, 'small.txt'), 'hello\n', 'utf8');
    await fs.writeFile(path.join(root, 'big.bin'), 'x'.repeat(600_000), 'utf8');
    gitReply(DIFF_HEAD, { code: 0, stdout: 'diff --git a/tracked b/tracked\n' });
    gitReply(UNTRACKED, { code: 0, stdout: 'small.txt\nbig.bin\n' });

    const r = await gitDiff(root);
    expect(r.error).toBeUndefined();
    expect(r.diff).toContain('tracked');
    expect(r.diff).toContain('small.txt');
    expect(r.diff).not.toContain('big.bin');
  });

  it('flags a timeout while listing untracked files', async () => {
    gitReply(DIFF_HEAD, { code: 0, stdout: 'tracked\n' });
    gitReply(UNTRACKED, TIMEOUT);
    const r = await gitDiff(root);
    expect(r.diff).toBe('tracked\n');
    expect(r.error).toMatch(/untracked-file list timed out/);
  });
});

describe('gitBranchesOverview', () => {
  it('surfaces a refs timeout instead of a partial branch list', async () => {
    gitReply(['worktree', 'list', '--porcelain'], { code: 0, stdout: '' });
    gitReply(REFS, TIMEOUT);

    const r = await gitBranchesOverview(root);
    expect(r.isRepo).toBe(true);
    expect(r.branches).toEqual([]);
    expect(r.error).toMatch(/for-each-ref timed out/);
  });
});
