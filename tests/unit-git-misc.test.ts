import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { timed, watchEventLoop } from '../src/main/diag';
import { gitBranches, gitCheckout, gitWorktrees, removeWorktree, restoreWorktree, WorktreeDirtyError } from '../src/main/git';
import { createLogger } from '../src/main/log';
import { piHasCredentials } from '../src/main/runtime';

describe('git branch/worktree plumbing', () => {
  const tmpRoot = path.join(os.tmpdir(), `vocs-code-git-test-${Date.now()}-${process.pid}`);
  const repo = path.join(tmpRoot, 'repo');
  const wtDir = path.join(tmpRoot, 'wt');

  const g = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: repo,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });

  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('lists branches and checks out another branch', async () => {
    await fs.mkdir(repo, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo });
    g('commit', '--allow-empty', '-m', 'init');
    g('branch', 'feature');
    const { current, branches } = await gitBranches(repo);
    expect(branches.map((b) => b.name).sort()).toEqual(expect.arrayContaining(['feature']));
    const head = branches.find((b) => b.current)!;
    expect(current).toBe(head.name);
    expect(await gitCheckout(repo, '-evil')).toMatchObject({ ok: false });
    expect(await gitCheckout(repo, 'feature')).toMatchObject({ ok: true });
    expect((await gitBranches(repo)).current).toBe('feature');
  });

  it('lists worktrees with branches and marks the session cwd', async () => {
    g('checkout', '-'); // back to the default branch
    g('worktree', 'add', wtDir, '-b', 'wtbranch');
    const { current, worktrees } = await gitWorktrees(repo);
    expect(current).toBe(path.resolve(repo));
    expect(worktrees.map((w) => w.branch)).toContain('wtbranch');
    const wt = worktrees.find((w) => w.path === path.resolve(wtDir));
    expect(wt).toMatchObject({ branch: 'wtbranch', detached: false });
    // From inside the worktree, that worktree is "current".
    const fromWt = await gitWorktrees(wtDir);
    expect(fromWt.current).toBe(path.resolve(wtDir));
  });

  it('removes a worktree and restores it from its branch', async () => {
    const wt2 = path.join(tmpRoot, 'wt-cycle');
    g('worktree', 'add', wt2, '-b', 'wtcycle');
    // Uncommitted changes block a non-force removal (the archive flow surfaces this to the user).
    await fs.writeFile(path.join(wt2, 'dirty.txt'), 'x');
    await expect(removeWorktree(repo, wt2, { force: false })).rejects.toBeInstanceOf(WorktreeDirtyError);
    await fs.rm(path.join(wt2, 'dirty.txt'));
    await removeWorktree(repo, wt2, { force: false });
    await expect(fs.stat(wt2)).rejects.toMatchObject({ code: 'ENOENT' });
    // The branch survives the worktree removal, so a restore can recreate it at the same path.
    expect((await gitBranches(repo)).branches.map((b) => b.name)).toContain('wtcycle');
    await restoreWorktree(repo, wt2, 'wtcycle');
    expect((await gitWorktrees(repo)).worktrees.map((w) => w.branch)).toContain('wtcycle');
    // A folder deleted outside the app counts as already removed: removal prunes, not throws.
    await fs.rm(wt2, { recursive: true, force: true });
    await removeWorktree(repo, wt2, { force: false });
    // Unarchive still recreates the worktree over the stale registration.
    await restoreWorktree(repo, wt2, 'wtcycle');
    expect((await gitWorktrees(repo)).worktrees.map((w) => w.branch)).toContain('wtcycle');
    // A folder whose registration git lost (e.g. its .git link was deleted) is not a working tree:
    // removal prunes and deletes the folder instead of blocking archive.
    await fs.rm(path.join(wt2, '.git'));
    await removeWorktree(repo, wt2, { force: false });
    await expect(fs.stat(wt2)).rejects.toMatchObject({ code: 'ENOENT' });
    await restoreWorktree(repo, wt2, 'wtcycle');
    expect((await gitWorktrees(repo)).worktrees.map((w) => w.branch)).toContain('wtcycle');
    // A branch with its worktree still checked out cannot be deleted; remove the worktree first.
    await removeWorktree(repo, wt2, { force: false });
    g('branch', '-D', 'wtcycle');
    await expect(restoreWorktree(repo, wt2, 'wtcycle')).rejects.toThrow(/no longer exists/);
  });
});

describe('diagnostics', () => {
  const diagRoot = path.join(os.tmpdir(), `vocs-diag-${Date.now()}`);
  afterAll(async () => {
    await fs.rm(diagRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('writes every level to the log file and gates debug behind the flag', async () => {
    const dir = path.join(diagRoot, 'logs-quiet');
    const quiet = createLogger(dir, false);
    quiet.log('debug', 'hidden');
    quiet.log('info', 'shown');
    quiet.log('warn', 'careful');
    await new Promise((r) => setTimeout(r, 50));
    const text = await fs.readFile(path.join(dir, 'main.log'), 'utf8');
    expect(quiet.file).toBe(path.join(dir, 'main.log'));
    expect(text).not.toContain('hidden');
    expect(text).toContain('INFO shown');
    expect(text).toContain('WARN careful');

    const loud = createLogger(path.join(diagRoot, 'logs-debug'), true);
    loud.log('debug', 'visible');
    await new Promise((r) => setTimeout(r, 50));
    expect(await fs.readFile(path.join(diagRoot, 'logs-debug', 'main.log'), 'utf8')).toContain('DEBUG visible');
  });

  it('reports an event loop stall and stays quiet while the loop is free', async () => {
    const lines: string[] = [];
    const w = watchEventLoop((level, message) => lines.push(`${level} ${message}`), 10, 60);
    await new Promise((r) => setTimeout(r, 60));
    expect(lines).toHaveLength(0);
    const until = Date.now() + 150;
    while (Date.now() < until) {
      /* block the loop the way a synchronous main-process call would */
    }
    await new Promise((r) => setTimeout(r, 30));
    w.stop();
    expect(lines.some((l) => l.startsWith('warn') && /main event loop stalled \d+ms/.test(l))).toBe(true);
  });

  it('timed logs only past the threshold and passes the value through', async () => {
    const lines: string[] = [];
    const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => lines.push(`${level} ${message}`);
    expect(await timed(log, 'fast op', 1000, () => 7)).toBe(7);
    expect(lines).toHaveLength(0);
    await timed(log, 'slow op', 10, () => new Promise((r) => setTimeout(r, 40)));
    expect(lines[0]).toMatch(/^warn slow slow op: \d+ms$/);
  });
});

describe('renderer dialogs', () => {
  // Electron answers window.confirm/alert/prompt with a native message box that disables the whole
  // window until it is dismissed. A dialog the user does not notice is indistinguishable from a
  // frozen app: no clicks, no typing, no dropdowns, and nothing in the logs. Use askConfirm instead.
  const NATIVE_CALL = /(^|[^A-Za-z0-9_.$])(confirm|alert|prompt)[(]/;
  const VIA_WINDOW = /window[.](confirm|alert|prompt)[(]/;

  it('never calls a native window dialog', async () => {
    const root = path.resolve(__dirname, '..', 'src', 'renderer', 'src');
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) files.push(full);
      }
    };
    await walk(root);
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const file of files) {
      const lines = (await fs.readFile(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        const flat = line.split(' ').join('');
        if (NATIVE_CALL.test(flat) || VIA_WINDOW.test(flat)) offenders.push(`${path.basename(file)}:${i + 1} ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('pi credential detection', () => {
  const savedEnv = { ...process.env };
  const dirs: string[] = [];

  const withAgentDir = async (auth: string | null) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-auth-'));
    dirs.push(dir);
    process.env.PI_CODING_AGENT_DIR = dir;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    if (auth !== null) await fs.writeFile(path.join(dir, 'auth.json'), auth);
    return piHasCredentials();
  };

  afterAll(async () => {
    process.env = savedEnv;
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  });

  it('detects a stored login in auth.json', async () => {
    expect(await withAgentDir(JSON.stringify({ anthropic: { type: 'oauth', token: 'x' } }))).toBe(true);
  });

  it('treats an empty auth.json as not logged in', async () => {
    expect(await withAgentDir('{}')).toBe(false);
  });

  it('falls back to env API keys', async () => {
    expect(await withAgentDir('{}')).toBe(false);
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    expect(await piHasCredentials()).toBe(true);
  });

  it('handles a missing auth.json', async () => {
    expect(await withAgentDir(null)).toBe(false);
  });
});
