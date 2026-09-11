/** /pr, /merge, per-branch PR actions and branch updates: exercised against a real git repo with a fake `gh` on PATH. */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitCreatePr, gitMergePr, gitPrMap, gitUpdateBranch, worktreeAddForBranch } from '../src/main/git';

const isWin = process.platform === 'win32';

const GH_SH = [
  '#!/bin/sh',
  'printf \'%s\\n\' "$*" >> "$GH_LOG"',
  'case "$1 $2" in',
  "  'pr create') echo 'https://example.com/acme/repo/pull/7' ;;",
  '  \'pr view\')',
  '    [ -n "$GH_VIEW_FAIL" ] && exit 1',
  '    echo "{\\"state\\":\\"${GH_STATE:-OPEN}\\",\\"url\\":\\"https://example.com/acme/repo/pull/7\\",\\"baseRefName\\":\\"$GH_BASE\\"}" ;;',
  '  \'pr list\')',
  '    echo "[{\\"number\\":7,\\"headRefName\\":\\"harness/test\\",\\"state\\":\\"OPEN\\",\\"url\\":\\"https://example.com/acme/repo/pull/7\\",\\"title\\":\\"Test PR\\"}]" ;;',
  'esac',
  'exit 0'
].join('\n');

const GH_CMD = [
  '@echo off',
  'echo %*>>"%GH_LOG%"',
  'if /i "%~1"=="pr" if /i "%~2"=="create" echo https://example.com/acme/repo/pull/7',
  'if /i "%~1"=="pr" if /i "%~2"=="view" if not "%GH_VIEW_FAIL%"=="" exit /b 1',
  'if "%GH_STATE%"=="" set "GH_STATE=OPEN"',
  'if /i "%~1"=="pr" if /i "%~2"=="view" echo {"state":"%GH_STATE%","url":"https://example.com/acme/repo/pull/7","baseRefName":"%GH_BASE%"}',
  'if /i "%~1"=="pr" if /i "%~2"=="list" echo [{"number":7,"headRefName":"harness/test","state":"OPEN","url":"https://example.com/acme/repo/pull/7","title":"Test PR"}]',
  'exit /b 0'
].join('\r\n');

const git = (args: string[], cwd?: string) => new Promise<string>((resolve, reject) => execFile('git', args, { cwd }, (e, stdout) => (e ? reject(e) : resolve(String(stdout)))));

describe('git PR flow (/pr, /merge)', () => {
  let tmp: string;
  let repo: string;
  let oldPath: string;
  let oldEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-pr-'));
    const bin = path.join(tmp, 'bin');
    await fs.mkdir(bin);
    const gh = path.join(bin, isWin ? 'gh.cmd' : 'gh');
    await fs.writeFile(gh, isWin ? GH_CMD : GH_SH);
    if (!isWin) await fs.chmod(gh, 0o755);

    await fs.mkdir(path.join(tmp, 'origin.git'), { recursive: true });
    await git(['init', '--bare', path.join(tmp, 'origin.git')]);
    repo = path.join(tmp, 'repo');
    await fs.mkdir(repo);
    await git(['init'], repo);
    await git(['config', 'user.email', 'test@example.com'], repo);
    await git(['config', 'user.name', 'Test'], repo);
    await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
    await git(['add', '-A'], repo);
    await git(['commit', '-m', 'base'], repo);
    await git(['remote', 'add', 'origin', path.join(tmp, 'origin.git')], repo);
    await git(['push', 'origin', 'HEAD'], repo);
    await git(['checkout', '-b', 'harness/test'], repo);
    await fs.writeFile(path.join(repo, 'b.txt'), 'b\n');
    await git(['add', '-A'], repo);
    await git(['commit', '-m', 'feature'], repo);

    oldPath = process.env.PATH ?? '';
    oldEnv = { GH_LOG: process.env.GH_LOG, GH_BASE: process.env.GH_BASE, GH_STATE: process.env.GH_STATE, GH_VIEW_FAIL: process.env.GH_VIEW_FAIL };
    process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
    process.env.GH_LOG = path.join(tmp, 'gh.log');
    await fs.writeFile(process.env.GH_LOG, '');
    process.env.GH_BASE = 'develop';
    delete process.env.GH_VIEW_FAIL;
  });

  afterAll(async () => {
    process.env.PATH = oldPath;
    for (const [k, v] of Object.entries(oldEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const ghLog = async () => (await fs.readFile(process.env.GH_LOG!, 'utf8')).trim();

  it('refuses a dirty tree', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'dirty\n');
    const r = await gitCreatePr(repo, 'develop');
    expect(r.ok).toBe(false);
    expect(r.output).toContain('Uncommitted');
    await git(['checkout', '--', 'a.txt'], repo);
  });

  it('refuses when the head branch equals the base', async () => {
    const r = await gitCreatePr(repo, 'harness/test');
    expect(r.ok).toBe(false);
    expect(r.output).toContain('already the current branch');
  });

  it('refuses PRing the base branch itself', async () => {
    await git(['branch', 'develop'], repo);
    const r = await gitCreatePr(repo, 'develop', 'develop');
    expect(r.ok).toBe(false);
    expect(r.output).toContain('base branch itself');
  });

  it('refuses an unknown head branch', async () => {
    const r = await gitCreatePr(repo, 'develop', 'no/such/branch');
    expect(r.ok).toBe(false);
    expect(r.output).toContain('does not exist locally');
  });

  it('refuses outside a repository', async () => {
    const r = await gitCreatePr(tmp, 'develop');
    expect(r).toEqual({ ok: false, output: 'Not a git repository' });
  });

  it('pushes and opens a PR into the base branch', async () => {
    const r = await gitCreatePr(repo, 'develop');
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://example.com/acme/repo/pull/7');
    const log = await ghLog();
    expect(log).toContain('pr create --base develop --head harness/test --fill');
    expect(await git(['ls-remote', '--heads', path.join(tmp, 'origin.git'), 'harness/test'])).toContain('harness/test');
  });

  it('opens a PR for another branch without checking it out (dirty tree does not block)', async () => {
    await git(['branch', 'feature/other'], repo);
    await fs.writeFile(path.join(repo, 'a.txt'), 'dirty\n');
    const r = await gitCreatePr(repo, 'develop', 'feature/other');
    expect(r.ok).toBe(true);
    const log = await ghLog();
    expect(log).toContain('pr create --base develop --head feature/other --fill');
    expect(await git(['ls-remote', '--heads', path.join(tmp, 'origin.git'), 'feature/other'])).toContain('feature/other');
    await git(['checkout', '--', 'a.txt'], repo);
  });

  it('merges the open PR of another branch without checkout', async () => {
    const r = await gitMergePr(repo, 'develop', 'feature/other');
    expect(r.ok).toBe(true);
    const log = await ghLog();
    expect(log).toContain('pr view feature/other');
    expect(log).toContain('pr merge feature/other --merge');
  });

  it('maps branches to their PRs', async () => {
    const m = await gitPrMap(repo);
    expect(m.prs?.['harness/test']).toEqual({ number: 7, state: 'OPEN', url: 'https://example.com/acme/repo/pull/7', title: 'Test PR' });
    expect(m.prs?.['feature/other']).toBeUndefined();
  });

  it('merges the open PR and checks the requested base', async () => {
    const mismatch = await gitMergePr(repo, 'main');
    expect(mismatch.ok).toBe(false);
    expect(mismatch.output).toContain('targets develop, not main');

    const r = await gitMergePr(repo, 'develop');
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://example.com/acme/repo/pull/7');

    const anyBase = await gitMergePr(repo);
    expect(anyBase.ok).toBe(true);
  });

  it('treats an already-merged PR as a success, not an error', async () => {
    process.env.GH_STATE = 'MERGED';
    try {
      const r = await gitMergePr(repo, 'develop');
      expect(r.ok).toBe(true);
      expect(r.output).toContain('MERGED');
    } finally {
      if (oldEnv.GH_STATE === undefined) delete process.env.GH_STATE;
      else process.env.GH_STATE = oldEnv.GH_STATE;
    }
  });

  it('reports a missing PR', async () => {
    process.env.GH_VIEW_FAIL = '1';
    try {
      const r = await gitMergePr(repo, 'develop');
      expect(r.ok).toBe(false);
    } finally {
      delete process.env.GH_VIEW_FAIL;
    }
  });

  it('creates a worktree for an existing branch', async () => {
    await git(['branch', 'wt/branch'], repo);
    const wt = await worktreeAddForBranch(repo, 'wt/branch');
    expect(wt.branch).toBe('wt/branch');
    expect(wt.path).toContain('.vocs-code');
    await fs.rm(wt.path, { recursive: true, force: true });
    await git(['worktree', 'prune'], repo);
    await git(['branch', '-D', 'wt/branch'], repo);
  });

  it('updates a branch that is not checked out anywhere', async () => {
    await git(['branch', 'f1'], repo);
    await git(['push', 'origin', 'f1'], repo);
    const clone = path.join(tmp, 'clone');
    await fs.mkdir(clone, { recursive: true });
    await git(['clone', path.join(tmp, 'origin.git'), clone]);
    await git(['config', 'user.email', 'test@example.com'], clone);
    await git(['config', 'user.name', 'Test'], clone);
    await git(['checkout', 'f1'], clone);
    await fs.writeFile(path.join(clone, 'c.txt'), 'c\n');
    await git(['add', '-A'], clone);
    await git(['commit', '-m', 'remote work'], clone);
    await git(['push', 'origin', 'f1'], clone);
    const r = await gitUpdateBranch(repo, 'f1');
    expect(r.ok).toBe(true);
    expect(await git(['rev-parse', 'f1'], repo)).toBe(await git(['rev-parse', 'origin/f1'], repo));
  });

  it('refuses a non-fast-forward update of a branch ref', async () => {
    // A parentless commit on f1 diverges from origin/f1, so fetching into the ref is refused.
    const tree = (await git(['rev-parse', 'master^{tree}'], repo)).trim();
    const sha = (await git(['commit-tree', tree, '-m', 'divergent'], repo)).trim();
    await git(['update-ref', 'refs/heads/f1', sha], repo);
    const r = await gitUpdateBranch(repo, 'f1');
    expect(r.ok).toBe(false);
  });

  it('refuses to update a branch whose worktree is dirty', async () => {
    await fs.writeFile(path.join(repo, 'd.txt'), 'dirty\n');
    const r = await gitUpdateBranch(repo, 'harness/test');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Uncommitted');
    await fs.rm(path.join(repo, 'd.txt'), { force: true });
  });
});