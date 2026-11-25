/** Branch listing, overview, checkout, fast-forward update, deletion, fetch-prune, and worktree pruning. */
import type { GitBranchInfo, GitBranchOverview, GitBranchOverviewItem } from '../../shared/types';
import { BASE_BRANCHES, BRANCH_NAME_RE, canonicalDir, git, gitRoot, timedOut } from './exec';
import { gitPrMap } from './github';
import { gitWorktrees } from './worktrees';

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

export async function gitCheckout(cwd: string, branch: string): Promise<{ ok: boolean; error?: string }> {
  if (!BRANCH_NAME_RE.test(branch)) return { ok: false, error: 'Invalid branch name' };
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

async function readBranchOverviewRefs(root: string) {
  const refs = await git(root, ['for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(committerdate:unix)%09%(subject)%09%(upstream:short)%09%(upstream:track)%09%(objectname)']);
  const rows = refs.stdout.split('\n').filter(Boolean).map((line) => line.split('\t'));
  const base = pickBase(rows.map(([name]) => name).filter(Boolean));
  const baseCommit = rows.find(([name]) => name === base)?.at(-1)?.trim();
  const counts = new Map<string, { ahead: number; behind: number }>();
  if (refs.code === 0 && !refs.truncated && !timedOut(refs) && rows.length > 1 && baseCommit && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit)) {
    // Git can walk all tips in one process. Join by object ID (not ref name) so a branch
    // advanced between the two reads cannot lend its new counts to the older snapshot.
    const batch = await git(root, ['for-each-ref', 'refs/heads', `--format=%(objectname)%09%(ahead-behind:${baseCommit})`]);
    if (batch.code === 0 && !batch.truncated && !timedOut(batch)) {
      for (const line of batch.stdout.split('\n')) {
        const match = line.trimEnd().match(/^(\S+)\t(\d+) (\d+)$/);
        if (match) counts.set(match[1], { ahead: Number(match[2]), behind: Number(match[3]) });
      }
    }
  }
  return { refs, rows, base, counts };
}

/**
 * GitHub-style branch overview for the Branches panel: age, ahead/behind vs base, merged state, worktree binding.
 * The list is the repo's LOCAL branches (`refs/heads`), which a server-side delete never removes — a branch
 * deleted on GitHub still exists here. `upstreamGone` is how the panel tells the two apart; it is read from
 * remote-tracking refs, so it is only accurate as of the last fetch (the panel's refresh runs `fetch --prune`).
 */
export async function gitBranchesOverview(cwd: string): Promise<GitBranchOverview> {
  const root = await gitRoot(cwd);
  if (!root) return { isRepo: false, branches: [], worktrees: [] };
  const [wt, { refs, rows, base, counts: batchCounts }, pr] = await Promise.all([
    gitWorktrees(cwd),
    readBranchOverviewRefs(root),
    gitPrMap(cwd)
  ]);
  if (timedOut(refs)) {
    return { isRepo: true, branches: [], worktrees: wt.worktrees, error: 'git for-each-ref timed out — the branch list could not be loaded. Refresh to retry.' };
  }
  // Git prints each worktree's real long path; the session's cwd may be a Windows 8.3 short name
  // (`RUNNER~1`), another case, or a link to it. Compare real paths, or no branch reads as current.
  const here = await canonicalDir(wt.current);
  const currentWorktree = (await Promise.all(wt.worktrees.map(async (w) => (await canonicalDir(w.path)) === here ? w : undefined))).find(Boolean);
  const wtByBranch = new Map(wt.worktrees.filter((w) => w.branch).map((w) => [w.branch!, w.path]));
  const branches: GitBranchOverviewItem[] = new Array(rows.length);
  let next = 0;
  // Older Git or unobserved tips fall back to individual, bounded probes.
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
    while (next < rows.length) {
      const index = next++;
      const row = rows[index];
      const [name, date, subject, upstream, track] = row;
      const counts =
        name === base
          ? undefined
          : batchCounts.get(row.at(-1)!.trim()) ?? await git(root, ['rev-list', '--left-right', '--count', `${base}...${name}`]).then((r) => {
              if (r.code !== 0 || r.truncated || timedOut(r)) return undefined;
              const m = r.stdout.trim().match(/^(\d+)\s+(\d+)$/);
              return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : undefined;
            });
      const merged =
        name === base
          ? false
          : counts ? counts.ahead === 0 : (await git(root, ['merge-base', '--is-ancestor', name, base])).code === 0;
      const up = parseUpstreamTrack(track ?? '');
      const item: GitBranchOverviewItem = {
        name,
        current: currentWorktree?.branch === name,
        isBase: name === base,
        lastCommitAt: date ? Number(date) * 1000 : undefined,
        lastCommitSubject: subject || undefined,
        merged,
        upstream: upstream?.trim() || undefined,
        ...counts,
        ...(up.ahead !== undefined ? { upstreamAhead: up.ahead } : {}),
        ...(up.behind !== undefined ? { upstreamBehind: up.behind } : {}),
        // A branch deleted on the server keeps its local ref, so the row stays; `[gone]` is the only
        // sign it is local-only, and it appears once the stale remote-tracking ref has been pruned.
        ...(up.gone ? { upstreamGone: true } : {}),
        ...(wtByBranch.has(name) ? { worktreePath: wtByBranch.get(name) } : {}),
        ...(pr.prs?.[name] ? { pr: pr.prs[name] } : {})
      };
      branches[index] = item;
    }
  }));
  // Newest work first, base branch pinned to top like GitHub's default-branch row.
  branches.sort((a, b) => Number(b.isBase) - Number(a.isBase) || (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0));
  return { isRepo: true, base, branches, worktrees: wt.worktrees, ...(pr.ghMissing ? { ghMissing: true } : {}) };
}

export async function gitDeleteBranch(cwd: string, branch: string, force: boolean): Promise<{ ok: boolean; error?: string }> {
  const root = await gitRoot(cwd);
  if (!root) return { ok: false, error: 'Not a git repository' };
  if (!BRANCH_NAME_RE.test(branch)) return { ok: false, error: 'Invalid branch name' };
  const r = await git(root, ['branch', force ? '-D' : '-d', branch]);
  return { ok: r.code === 0, error: (r.stderr || r.stdout).trim() || undefined };
}

/** Fast-forwards a local branch to its upstream, whether or not it is checked out. */
export async function gitUpdateBranch(cwd: string, branch: string): Promise<{ ok: boolean; error?: string }> {
  const root = await gitRoot(cwd);
  if (!root) return { ok: false, error: 'Not a git repository' };
  if (!BRANCH_NAME_RE.test(branch)) return { ok: false, error: 'Invalid branch name' };
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
