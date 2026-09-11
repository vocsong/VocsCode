/** Git plumbing behind the Changes panel: status and diff summaries, per-file revert, staging, commits, and isolated worktrees plus the /pr and /merge GitHub flow. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { GitBranchInfo, GitBranchOverview, GitBranchOverviewItem, GitFileStatus, GitPrInfo, GitSummary, GitWorktreeInfo } from '../shared/types';
import { isOutsideWorkspace } from './harness/permissions';
import { runCapture, which } from './runtime';
import { exists } from './util/fs';

const gitBin = () => which('git') ?? 'git';
const ghBin = () => which('gh');

const PR_URL = /https:\/\/[^\s/"]+\/[^\s]+\/pull\/\d+/;

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

/** PR/merge state of a session's branch, shown in the sidebar status labels. */
export interface BranchGitState {
  pr: boolean;
  merged: boolean;
}

const BASE_BRANCHES = ['develop', 'master', 'main'];

/**
 * Classifies a session branch: open PR ('pr') or already merged into a base branch
 * ('merged'). Uses `gh` when available (also catches squash merges); otherwise falls
 * back to merge-commit ancestry, and to remote tracking (a fully pushed branch means
 * the PR was opened in this workflow).
 */
export async function branchGitState(cwd: string, branch: string): Promise<BranchGitState> {
  const root = await gitRoot(cwd);
  if (!root) return { pr: false, merged: false };
  const state: BranchGitState = { pr: false, merged: false };
  const gh = which('gh');
  if (gh) {
    const r = await runCapture(gh, ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '10', '--json', 'state'], {
      cwd: root,
      timeoutMs: 15_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    if (r.code === 0) {
      try {
        const prs = JSON.parse(r.stdout) as { state: string }[];
        if (prs.some((p) => p.state === 'MERGED')) return { pr: false, merged: true };
        if (prs.some((p) => p.state === 'OPEN')) state.pr = true;
      } catch {
        /* ignore */
      }
    }
  }
  if (state.pr) return state;
  // A merge commit on a base branch whose second parent is the branch tip means the
  // branch really landed; a fresh branch sitting at the base tip must not count.
  // Squash merges need gh above.
  const tip = await git(root, ['rev-parse', '--verify', branch]);
  const tipHash = tip.code === 0 ? tip.stdout.trim() : '';
  if (tipHash) {
    for (const base of BASE_BRANCHES) {
      const r = await git(root, ['log', base, '--merges', '--format=%P', '-n', '200']);
      if (r.code === 0 && r.stdout.split('\n').some((line) => line.trim().split(/\s+/)[1] === tipHash)) {
        return { pr: state.pr, merged: true };
      }
    }
  }
  if (!gh) {
    // Without gh, a fully pushed branch stands in for "PR created".
    const remote = await git(root, ['rev-parse', '--verify', '--quiet', `origin/${branch}`]);
    if (remote.code === 0) {
      const ahead = await git(root, ['rev-list', '--count', `origin/${branch}..${branch}`]);
      if (ahead.code === 0 && ahead.stdout.trim() === '0') state.pr = true;
    }
  }
  return state;
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

type PrResult = { ok: boolean; url?: string; output?: string };

const noGh = (): PrResult => ({ ok: false, output: 'GitHub CLI (gh) is required — install it and run `gh auth login`.' });

async function gh(cwd: string, args: string[], timeoutMs = 120_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runCapture(ghBin() ?? 'gh', args, { cwd, timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

const prUrlIn = (out: string): string | undefined => out.match(PR_URL)?.[0];

/** Pushes `head` (default: the current branch) and opens a PR into `base` (gh). Refuses a dirty tree so the PR is complete. */
export async function gitCreatePr(cwd: string, base: string, head?: string): Promise<PrResult> {
  if (!(await gitRoot(cwd))) return { ok: false, output: 'Not a git repository' };
  if (!ghBin()) return noGh();
  const current = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const branch = head?.trim() || current;
  if (!branch || branch === 'HEAD') return { ok: false, output: 'Detached HEAD — check out a branch first.' };
  if (branch === base) {
    return { ok: false, output: branch === current ? `${base} is already the current branch — /pr takes the branch to merge into.` : `${base} is the base branch itself — pick a feature branch to PR into it.` };
  }
  if (branch !== current) {
    // PRing another branch works without checkout: only that branch must exist locally.
    const found = (await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
    if (!found) return { ok: false, output: `Branch ${branch} does not exist locally.` };
  } else {
    const dirty = await git(cwd, ['status', '--porcelain=v1']);
    if (dirty.stdout.trim()) return { ok: false, output: 'Uncommitted changes — commit them first (Changes panel or /diff).' };
  }
  const push = await git(cwd, ['push', '-u', 'origin', branch], 120_000);
  if (push.code !== 0) return { ok: false, output: (push.stderr || push.stdout).trim() || 'git push failed' };
  const r = await gh(cwd, ['pr', 'create', '--base', base, '--head', branch, '--fill']);
  const out = (r.stdout + r.stderr).trim();
  if (r.code !== 0) return { ok: false, output: out || 'gh pr create failed' };
  return { ok: true, url: prUrlIn(out), output: out };
}

/** Merges the open PR whose head is `branch` (default: the current branch); `base`, when given, is checked against the PR's target. */
export async function gitMergePr(cwd: string, base?: string, head?: string): Promise<PrResult> {
  if (!(await gitRoot(cwd))) return { ok: false, output: 'Not a git repository' };
  if (!ghBin()) return noGh();
  const branch = head?.trim() || (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const view = await gh(cwd, ['pr', 'view', branch, '--json', 'state,url,baseRefName'], 30_000);
  if (view.code !== 0) return { ok: false, output: (view.stdout + view.stderr).trim() || `No open PR for ${branch}` };
  let pr: { state?: string; url?: string; baseRefName?: string };
  try {
    pr = JSON.parse(view.stdout.trim());
  } catch {
    return { ok: false, output: 'Could not read PR details.' };
  }
  if (pr.state === 'MERGED') return { ok: true, url: pr.url, output: `PR is MERGED (already merged): ${pr.url ?? ''}`.trim() };
  if (pr.state !== 'OPEN') return { ok: false, output: pr.url ? `PR is ${pr.state ?? 'unknown'}: ${pr.url}` : `No open PR for ${branch}` };
  if (base && pr.baseRefName && pr.baseRefName !== base) {
    return { ok: false, output: `That PR targets ${pr.baseRefName}, not ${base}: ${pr.url ?? ''}`.trim() };
  }
  const merge = await gh(cwd, ['pr', 'merge', branch, '--merge']);
  if (merge.code !== 0) return { ok: false, output: (merge.stderr || merge.stdout).trim() || 'gh pr merge failed' };
  return { ok: true, url: pr.url, output: (merge.stdout + merge.stderr).trim() || `Merged into ${pr.baseRefName ?? base ?? 'base'}` };
}

/** Maps each local branch to its most relevant PR (an open one wins over an older merged/closed). */
export async function gitPrMap(cwd: string): Promise<{ prs?: Record<string, GitPrInfo>; ghMissing?: boolean }> {
  if (!ghBin()) return { ghMissing: true };
  const root = await gitRoot(cwd);
  if (!root) return {};
  const r = await gh(root, ['pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,headRefName,state,url,title'], 20_000);
  if (r.code !== 0) return {};
  try {
    const list = JSON.parse(r.stdout.trim()) as { number: number; headRefName?: string; state?: string; url?: string; title?: string }[];
    const prs: Record<string, GitPrInfo> = {};
    for (const p of list) {
      if (!p.headRefName || !p.url) continue;
      const info: GitPrInfo = { number: p.number, state: (p.state as GitPrInfo['state']) ?? 'OPEN', url: p.url, ...(p.title ? { title: p.title } : {}) };
      const prev = prs[p.headRefName];
      if (!prev || (prev.state !== 'OPEN' && info.state === 'OPEN')) prs[p.headRefName] = info;
    }
    return { prs };
  } catch {
    return {};
  }
}

export async function gitBranches(cwd: string): Promise<{ current?: string; branches: GitBranchInfo[] }> {
  const r = await git(cwd, ['branch', '--list', '--no-color']);
  if (r.code !== 0) return { branches: [] };
  const branches: GitBranchInfo[] = [];
  let current: string | undefined;
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const isCurrent = line.startsWith('*');
    const name = line.replace(/^\*\s*/, '').trim();
    branches.push({ name, current: isCurrent });
    if (isCurrent) current = name;
  }
  return { current, branches };
}

export async function gitWorktrees(cwd: string): Promise<{ current: string; worktrees: GitWorktreeInfo[] }> {
  const current = path.resolve(cwd);
  const r = await git(cwd, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) return { current, worktrees: [] };
  const worktrees: GitWorktreeInfo[] = [];
  let entry: GitWorktreeInfo | null = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (entry) worktrees.push(entry);
      // Git may print POSIX-style separators; normalize so comparisons with session cwd match.
      entry = { path: path.resolve(line.slice('worktree '.length).trim()), detached: false };
    } else if (entry && line.startsWith('branch ')) {
      entry.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      entry!.detached = true;
    }
  }
  if (entry) worktrees.push(entry);
  return { current, worktrees };
}

export async function gitCheckout(cwd: string, branch: string): Promise<{ ok: boolean; error?: string }> {
  if (!/^[\w][\w./-]*$/.test(branch)) return { ok: false, error: 'Invalid branch name' };
  const r = await git(cwd, ['checkout', branch], 60_000);
  return { ok: r.code === 0, error: (r.stderr || r.stdout).trim() || undefined };
}

/** Picks the diff base for the Branches panel: develop, else master/main, else the only branch. */
export function pickBase(names: string[]): string {
  const set = new Set(names);
  return BASE_BRANCHES.find((b) => set.has(b)) ?? names[0] ?? 'master';
}

/** Parses `%(upstream:track)` output like "[ahead 1]", "[behind 2]" or "[gone]". */
export function parseUpstreamTrack(track: string): { ahead?: number; behind?: number; gone?: boolean } {
  const t = track.trim();
  if (!t) return {};
  if (t.includes('gone')) return { gone: true };
  const ahead = Number(t.match(/ahead (\d+)/)?.[1]);
  const behind = Number(t.match(/behind (\d+)/)?.[1]);
  return {
    ...(Number.isFinite(ahead) && ahead > 0 ? { ahead } : {}),
    ...(Number.isFinite(behind) && behind > 0 ? { behind } : {})
  };
}

/** GitHub-style branch overview for the Branches panel: age, ahead/behind vs base, merged state, worktree binding. */
export async function gitBranchesOverview(cwd: string): Promise<GitBranchOverview> {
  const root = await gitRoot(cwd);
  if (!root) return { isRepo: false, branches: [], worktrees: [] };
  const [wt, refs, pr] = await Promise.all([
    gitWorktrees(cwd),
    git(root, ['for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(committerdate:unix)%09%(subject)%09%(upstream:short)%09%(upstream:track)']),
    gitPrMap(cwd)
  ]);
  const names = refs.stdout.split('\n').map((l) => l.split('\t')[0]).filter(Boolean);
  const base = pickBase(names);
  const wtByBranch = new Map(wt.worktrees.filter((w) => w.branch).map((w) => [w.branch!, w.path]));
  const branches = await Promise.all(
    refs.stdout
      .split('\n')
      .filter(Boolean)
      .map(async (line) => {
        const [name, date, subject, upstream, track] = line.split('\t');
        const counts =
          name === base
            ? undefined
            : await git(root, ['rev-list', '--left-right', '--count', `${base}...${name}`]).then((r) => {
                const m = r.stdout.trim().match(/^(\d+)\s+(\d+)$/);
                return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : undefined;
              });
        const merged =
          name === base
            ? false
            : (await git(root, ['merge-base', '--is-ancestor', name, base])).code === 0;
        const up = parseUpstreamTrack(track ?? '');
        const item: GitBranchOverviewItem = {
          name,
          current: Boolean(wt.worktrees.find((w) => w.branch === name && path.resolve(w.path) === wt.current)),
          isBase: name === base,
          lastCommitAt: date ? Number(date) * 1000 : undefined,
          lastCommitSubject: subject || undefined,
          merged,
          upstream: upstream?.trim() || undefined,
          ...counts,
          ...(up.ahead !== undefined ? { upstreamAhead: up.ahead } : {}),
          ...(up.behind !== undefined ? { upstreamBehind: up.behind } : {}),
          ...(wtByBranch.has(name) ? { worktreePath: wtByBranch.get(name) } : {}),
          ...(pr.prs?.[name] ? { pr: pr.prs[name] } : {})
        };
        return item;
      })
  );
  // Newest work first, base branch pinned to top like GitHub's default-branch row.
  branches.sort((a, b) => Number(b.isBase) - Number(a.isBase) || (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0));
  return { isRepo: true, base, branches, worktrees: wt.worktrees, ...(pr.ghMissing ? { ghMissing: true } : {}) };
}

export async function gitDeleteBranch(cwd: string, branch: string, force: boolean): Promise<{ ok: boolean; error?: string }> {
  const root = await gitRoot(cwd);
  if (!root) return { ok: false, error: 'Not a git repository' };
  if (!/^[\w][\w./-]*$/.test(branch)) return { ok: false, error: 'Invalid branch name' };
  const r = await git(root, ['branch', force ? '-D' : '-d', branch]);
  return { ok: r.code === 0, error: (r.stderr || r.stdout).trim() || undefined };
}

/** Fast-forwards a local branch to its upstream, whether or not it is checked out. */
export async function gitUpdateBranch(cwd: string, branch: string): Promise<{ ok: boolean; error?: string }> {
  const root = await gitRoot(cwd);
  if (!root) return { ok: false, error: 'Not a git repository' };
  if (!/^[\w][\w./-]*$/.test(branch)) return { ok: false, error: 'Invalid branch name' };
  const local = (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
  if (!local) return { ok: false, error: `Branch ${branch} does not exist locally.` };
  const wts = await gitWorktrees(root);
  const wt = wts.worktrees.find((w) => w.branch === branch);
  if (wt) {
    // Checked out in a worktree: fetch there and fast-forward, so the shared ref cannot move behind the checkout.
    const dirty = await git(wt.path, ['status', '--porcelain=v1']);
    if (dirty.stdout.trim()) return { ok: false, error: 'Uncommitted changes in the worktree — commit or stash them first.' };
    const fetch = await git(wt.path, ['fetch', 'origin', branch], 120_000);
    if (fetch.code !== 0) return { ok: false, error: (fetch.stderr || fetch.stdout).trim() || 'git fetch failed' };
    const merge = await git(wt.path, ['merge', '--ff-only', 'FETCH_HEAD'], 120_000);
    return { ok: merge.code === 0, error: merge.code === 0 ? undefined : (merge.stderr || merge.stdout).trim() || 'git merge failed' };
  }
  // Not checked out anywhere: fetch directly into the ref; git refuses a non-fast-forward.
  const ff = await git(root, ['fetch', 'origin', `${branch}:${branch}`], 120_000);
  return { ok: ff.code === 0, error: ff.code === 0 ? undefined : (ff.stderr || ff.stdout).trim() || 'git fetch failed' };
}

/** Drops administrative entries for worktrees whose directories were deleted by hand. */
export async function gitPruneWorktrees(cwd: string): Promise<{ ok: boolean; output: string }> {
  const root = await gitRoot(cwd);
  if (!root) return { ok: false, output: 'Not a git repository' };
  const r = await git(root, ['worktree', 'prune', '-v']);
  return { ok: r.code === 0, output: (r.stderr || r.stdout).trim() };
}

/** Refreshes remote tracking and drops remote refs whose branch was deleted upstream. */
export async function gitFetchPrune(cwd: string): Promise<{ ok: boolean; output: string }> {
  const root = await gitRoot(cwd);
  if (!root) return { ok: false, output: 'Not a git repository' };
  const remotes = await git(root, ['remote']);
  if (!remotes.stdout.trim()) return { ok: true, output: 'No remote configured.' };
  const r = await git(root, ['fetch', '--prune'], 120_000);
  return { ok: r.code === 0, output: (r.stderr || r.stdout).trim() || 'Up to date.' };
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'session';
}

/** Keeps the app's worktree folder out of git status. */
async function excludeWorktreesDir(root: string): Promise<void> {
  try {
    const exclude = path.join(root, '.git', 'info', 'exclude');
    const cur = (await exists(exclude)) ? await fs.readFile(exclude, 'utf8') : '';
    if (!cur.includes('.vocs-code/')) await fs.appendFile(exclude, `${cur.endsWith('\n') || !cur ? '' : '\n'}.vocs-code/\n`);
  } catch {
    /* ignore */
  }
}

/** Creates an isolated worktree under <root>/.vocs-code/worktrees/<slug> on a new branch. */
export async function createWorktree(projectRoot: string, slug: string): Promise<{ path: string; branch: string }> {
  const root = await gitRoot(projectRoot);
  if (!root) throw new Error('Worktrees require a git repository.');
  const base = path.join(root, '.vocs-code', 'worktrees');
  await fs.mkdir(base, { recursive: true });
  await excludeWorktreesDir(root);
  // Pick a name whose directory AND branch are both free (a removed worktree leaves its branch behind).
  const branchExists = async (b: string) => (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])).code === 0;
  let name = slug;
  let i = 1;
  while ((await exists(path.join(base, name))) || (await branchExists(`vocscode/${name}`))) name = `${slug}-${++i}`;
  const wtPath = path.join(base, name);
  const branch = `vocscode/${name}`;
  const r = await git(root, ['worktree', 'add', '-b', branch, wtPath], 60_000);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr || r.stdout}`);
  return { path: wtPath, branch };
}

/** Creates a worktree under .vocs-code/worktrees for an EXISTING branch (new-session-on-branch flow). */
export async function worktreeAddForBranch(projectRoot: string, branch: string): Promise<{ path: string; branch: string }> {
  const root = await gitRoot(projectRoot);
  if (!root) throw new Error('Worktrees require a git repository.');
  const base = path.join(root, '.vocs-code', 'worktrees');
  await fs.mkdir(base, { recursive: true });
  await excludeWorktreesDir(root);
  const name = slugify(branch.replace(/\//g, '-'));
  let wtPath = path.join(base, name);
  let i = 1;
  while (await exists(wtPath)) wtPath = path.join(base, `${name}-${++i}`);
  const r = await git(root, ['worktree', 'add', wtPath, branch], 60_000);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr || r.stdout}`);
  return { path: wtPath, branch };
}

export async function removeWorktree(projectRoot: string, wtPath: string, opts: { force?: boolean } = {}): Promise<void> {
  const root = await gitRoot(projectRoot);
  if (!root) return;
  const force = opts.force ?? true;
  // Without --force git refuses a worktree holding uncommitted changes; callers decide whether to surface that.
  const r = await git(root, force ? ['worktree', 'remove', '--force', wtPath] : ['worktree', 'remove', wtPath], 60_000);
  if (r.code !== 0) throw new Error(`git worktree remove failed: ${r.stderr || r.stdout}`);
  await git(root, ['worktree', 'prune']);
}

/** Re-creates a worktree at `wtPath` for an existing branch (used when an archived session is unarchived). */
export async function restoreWorktree(projectRoot: string, wtPath: string, branch: string): Promise<void> {
  const root = await gitRoot(projectRoot);
  if (!root) return;
  const branchExists = (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
  if (!branchExists) throw new Error(`Branch ${branch} no longer exists.`);
  if (await exists(wtPath)) return;
  const r = await git(root, ['worktree', 'add', wtPath, branch], 60_000);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr || r.stdout}`);
}

export async function worktreeInfo(cwd: string): Promise<{ branch?: string; mainRoot?: string } | null> {
  const r = await git(cwd, ['rev-parse', '--git-common-dir']);
  if (r.code !== 0) return null;
  const common = r.stdout.trim();
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  return { branch, mainRoot: path.dirname(path.resolve(cwd, common)) };
}
