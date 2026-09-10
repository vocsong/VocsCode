/** /pr and /merge git plumbing: exercised against a real git repo with a fake `gh` on PATH. */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitCreatePr, gitMergePr } from '../src/main/git';

const isWin = process.platform === 'win32';

const GH_SH = [
  '#!/bin/sh',
  'printf \'%s\\n\' "$*" >> "$GH_LOG"',
  'case "$1 $2" in',
  "  'pr create') echo 'https://example.com/acme/repo/pull/7' ;;",
  '  \'pr view\')',
  '    [ -n "$GH_VIEW_FAIL" ] && exit 1',
  '    echo "{\\"state\\":\\"${GH_STATE:-OPEN}\\",\\"url\\":\\"https://example.com/acme/repo/pull/7\\",\\"baseRefName\\":\\"$GH_BASE\\"}" ;;',
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
});