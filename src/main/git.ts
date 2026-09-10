/** Git plumbing behind the Changes panel: status and diff summaries, per-file revert, staging, commits, and isolated worktrees. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { GitFileStatus, GitSummary } from '../shared/types';
import { isOutsideWorkspace } from './harness/permissions';
import { runCapture, which } from './runtime';
import { exists } from './util/fs';

const gitBin = () => which('git') ?? 'git';

async function git(cwd: string, args: string[], timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runCapture(gitBin(), args, { cwd, timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
}

export async function gitRoot(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (r.code !== 0) return null;
  return r.stdout.trim().replace(/\//g, path.sep);
}

export async function gitSummary(cwd: string): Promise<GitSummary> {
  const root = await gitRoot(cwd);
  if (!root) return { isRepo: false, files: [] };
  const [branch, status, numstat, upstream] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '--no-renames']),
    git(cwd, ['diff', '--numstat', 'HEAD']),
    git(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
  ]);
  const counts = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstat.stdout.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (m) counts.set(m[3].trim(), { additions: m[1] === '-' ? 0 : Number(m[1]), deletions: m[2] === '-' ? 0 : Number(m[2]) });
  }
  const files: GitFileStatus[] = [];
  for (const raw of status.stdout.split('\n')) {
    if (!raw.trim()) continue;
    const x = raw[0];
    const y = raw[1];
    let p = raw.slice(3).trim();
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    const code = (y !== ' ' ? y : x) as GitFileStatus['status'];
    const st: GitFileStatus['status'] = code === '?' ? '?' : (['M', 'A', 'D', 'R', 'U', 'C', 'T'].includes(code) ? code : 'M') as GitFileStatus['status'];
    const c = counts.get(p);
    let additions = c?.additions;
    if (st === '?' && additions === undefined) {
      try {
        const content = await fs.readFile(path.join(root, p), 'utf8');
        additions = content.split('\n').length;
      } catch {
        /* binary or gone */
      }
    }
    files.push({ path: p, status: st, staged: x !== ' ' && x !== '?', additions, deletions: c?.deletions });
  }
  let ahead: number | undefined;
  let behind: number | undefined;
  if (upstream.code === 0) {
    const m = upstream.stdout.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) {
      ahead = Number(m[1]);
      behind = Number(m[2]);
    }
  }
  return { isRepo: true, root, branch: branch.stdout.trim() || undefined, files, ahead, behind };
}

export async function gitDiff(cwd: string, file?: string, staged = false): Promise<string> {
  const root = await gitRoot(cwd);
  if (!root) return '';
  if (file) {
    if (isOutsideWorkspace(root, file, path)) return 'Path outside workspace';
    const abs = path.join(root, file);
    const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', file]);
    if (tracked.code !== 0) {
      // Untracked: synthesize an add diff.
      try {
        const content = await fs.readFile(abs, 'utf8');
        if (content.length > 2_000_000) return `Binary or very large file: ${file}`;
        return createTwoFilesPatch('/dev/null', file, '', content, '', '', { context: 3 });
      } catch {
        return '';
      }
    }
    const r = await git(cwd, ['diff', ...(staged ? ['--cached'] : ['HEAD']), '--', file]);
    return r.stdout;
  }
  const r = await git(cwd, ['diff', ...(staged ? ['--cached'] : ['HEAD'])]);
  let out = r.stdout;
  // Append untracked files.
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
  for (const f of untracked.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    try {
      const content = await fs.readFile(path.join(root, f), 'utf8');
      if (content.length > 500_000) continue;
      out += createTwoFilesPatch('/dev/null', f, '', content, '', '', { context: 3 });
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function gitRevertFile(cwd: string, file: string): Promise<{ ok: boolean; error?: string }> {
  const root = await gitRoot(cwd);
  if (!root) return { ok: false, error: 'Not a git repository' };
  if (isOutsideWorkspace(root, file, path)) return { ok: false, error: 'Path outside workspace' };
  const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', file]);
  if (tracked.code !== 0) {
    try {
      await fs.rm(path.join(root, file), { force: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  const r = await git(cwd, ['checkout', 'HEAD', '--', file]);
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr || r.stdout };
}

export async function gitStageAll(cwd: string): Promise<{ ok: boolean; error?: string }> {
  const r = await git(cwd, ['add', '-A']);
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr };
}

export async function gitCommit(cwd: string, message: string): Promise<{ ok: boolean; output: string }> {
  await git(cwd, ['add', '-A']);
  const r = await git(cwd, ['commit', '-m', message]);
  return { ok: r.code === 0, output: (r.stdout + r.stderr).trim() };
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'session';
}

/** Creates an isolated worktree under <root>/.vocs-code/worktrees/<slug> on a new branch. */
export async function createWorktree(projectRoot: string, slug: string): Promise<{ path: string; branch: string }> {
  const root = await gitRoot(projectRoot);
  if (!root) throw new Error('Worktrees require a git repository.');
  const base = path.join(root, '.vocs-code', 'worktrees');
  await fs.mkdir(base, { recursive: true });
  // Keep the app folder out of git status.
  try {
    const exclude = path.join(root, '.git', 'info', 'exclude');
    const cur = (await exists(exclude)) ? await fs.readFile(exclude, 'utf8') : '';
    if (!cur.includes('.vocs-code/')) await fs.appendFile(exclude, `${cur.endsWith('\n') || !cur ? '' : '\n'}.vocs-code/\n`);
  } catch {
    /* ignore */
  }
  // Pick a name whose directory AND branch are both free (a removed worktree leaves its branch behind).
  const branchExists = async (b: string) => (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])).code === 0;
  let name = slug;
  let i = 1;
  while ((await exists(path.join(base, name))) || (await branchExists(`harness/${name}`))) name = `${slug}-${++i}`;
  const wtPath = path.join(base, name);
  const branch = `harness/${name}`;
  const r = await git(root, ['worktree', 'add', '-b', branch, wtPath], 60_000);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr || r.stdout}`);
  return { path: wtPath, branch };
}

export async function removeWorktree(projectRoot: string, wtPath: string): Promise<void> {
  const root = await gitRoot(projectRoot);
  if (!root) return;
  await git(root, ['worktree', 'remove', '--force', wtPath], 60_000);
  await git(root, ['worktree', 'prune']);
}

export async function worktreeInfo(cwd: string): Promise<{ branch?: string; mainRoot?: string } | null> {
  const r = await git(cwd, ['rev-parse', '--git-common-dir']);
  if (r.code !== 0) return null;
  const common = r.stdout.trim();
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  return { branch, mainRoot: path.dirname(path.resolve(cwd, common)) };
}
