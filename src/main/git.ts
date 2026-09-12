/** Git plumbing behind the Changes panel: status and diff summaries, per-file revert, staging, commits, and isolated worktrees plus the /pr and /merge GitHub flow. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { GitBranchInfo, GitBranchOverview, GitBranchOverviewItem, GitFileStatus, GitPrInfo, GitPullRequest, GitPullRequestList, GitSummary, GitWorktreeInfo } from '../shared/types';
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

/** Reads HEAD in this exact folder, including unborn branches and linked worktrees. */
export async function gitFolderBranch(cwd: string): Promise<{ branch?: string; detached?: boolean }> {
  const branch = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch.code === 0 && branch.stdout.trim()) return { branch: branch.stdout.trim() };
  const head = await git(cwd, ['rev-parse', '--verify', '--short', 'HEAD']);
  return head.code === 0 ? { branch: head.stdout.trim(), detached: true } : {};
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

/** A PR as reported by `gh pr list`, scoped to what session PR/merge resolution needs. */
export interface PrInfo {
  number: number;
  state: string;
  headRefName?: string;
  baseRefName?: string;
  url?: string;
  title?: string;
}

/** A PR reference extracted from a session transcript: the number plus the repo slug in the URL, when it is a GitHub link. */
export interface PrRef {
  repo?: string;
  number: number;
}

/** How a session's PR is resolved, shared by the sidebar label check and /merge. */
export interface SessionPrQuery {
  /** PRs the session itself referenced (the agent's report links them) — strongest signal. */
  prRefs?: PrRef[];
  /** Branches directly tied to the session: its worktree branch plus the checked-out HEAD. */
  branches?: string[];
  /** Worktree branches owned by other sessions; the repo-wide fallback never matches them. */
  excludeBranches?: string[];
  /** Git roots of other repos this app knows, used to resolve transcript PRs from a foreign repo. */
  extraRoots?: string[];
  /** Fallback PRs must have their head branch tip committed within the session's activity window. */
  createdAfter?: number;
  updatedBefore?: number;
}

const PR_FIELDS = 'number,state,headRefName,baseRefName,url,title';

async function listPrs(opts: { cwd: string; repo?: string }): Promise<PrInfo[]> {
  const gh = which('gh');
  if (!gh) return [];
  const args = ['pr', 'list', '--state', 'all', '--limit', '50', '--json', PR_FIELDS];
  if (opts.repo) args.push('-R', opts.repo);
  const r = await runCapture(gh, args, {
    cwd: opts.cwd,
    timeoutMs: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  if (r.code !== 0) return [];
  try {
    return JSON.parse(r.stdout) as PrInfo[];
  } catch {
    return [];
  }
}

async function localBranches(root: string): Promise<Set<string>> {
  const r = await git(root, ['for-each-ref', 'refs/heads', '--format=%(refname:short)']);
  return new Set(r.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
}

/** Committer time (ms) of a branch tip, or undefined when the branch is unknown. */
async function branchTipTime(root: string, branch: string): Promise<number | undefined> {
  const r = await git(root, ['show', '-s', '--format=%ct', branch]);
  const ts = r.code === 0 ? Number(r.stdout.trim()) * 1000 : NaN;
  return Number.isFinite(ts) ? ts : undefined;
}

/** owner/repo slug from the origin remote URL, for matching PR URLs in transcripts to this repo. */
export async function repoSlug(root: string): Promise<string | undefined> {
  const r = await git(root, ['remote', 'get-url', 'origin']);
  if (r.code !== 0) return undefined;
  const m = r.stdout.trim().match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/**
 * Resolves the PRs belonging to a session, in order of strength:
 * - `refs`: PRs the session itself named (the agent's report links them) — trusted outright.
 *   A ref is resolved against the session's repo when its URL slug matches; a foreign or
 *   stale slug (renamed repo) is resolved via `gh -R <slug>` or by number against other
 *   known repos, so a session whose agent worked in a different repo still resolves.
 * - `direct`: PRs whose head branch is the session's branch or worktree HEAD.
 * - `fallback`: repo-wide matches — head is a local, non-base branch not owned by another
 *   session, tip committed within the session's activity window. Callers must refuse to
 *   act when the fallback alone is ambiguous.
 */
export async function findSessionPrs(root: string, q: SessionPrQuery = {}): Promise<{ refs: PrInfo[]; direct: PrInfo[]; fallback: PrInfo[] }> {
  const localSlug = await repoSlug(root);
  const prRefs = q.prRefs ?? [];
  const prs = await listPrs({ cwd: root });
  const refs: PrInfo[] = [];
  for (const r of prRefs) {
    // A ref aimed at this repo resolves from the local list; same numbers in other repos
    // are never matched, so a foreign mention cannot steal a local PR (or vice versa).
    if (r.repo && r.repo !== localSlug) continue;
    const pr = prs.find((p) => p.number === r.number);
    if (pr && !refs.includes(pr)) refs.push(pr);
  }
  // Foreign-slug refs: try the URL's slug (may be stale after a rename), then by number
  // against the other repos the app knows about.
  const localNumbers = new Set(prs.map((p) => p.number));
  for (const r of prRefs) {
    if (!r.repo || r.repo === localSlug || localNumbers.has(r.number)) continue;
    let found = (await listPrs({ cwd: root, repo: r.repo })).find((p) => p.number === r.number);
    if (!found) {
      for (const extra of q.extraRoots ?? []) {
        found = (await listPrs({ cwd: extra })).find((p) => p.number === r.number);
        if (found) break;
      }
    }
    if (found && !refs.some((p) => p.number === found!.number)) refs.push(found);
  }
  const known = new Set(q.branches?.filter(Boolean).filter((b) => !BASE_BRANCHES.includes(b)) ?? []);
  const direct = prs.filter((p) => p.headRefName !== undefined && known.has(p.headRefName));
  if (!prs.length) return { refs, direct, fallback: [] };
  const exclude = new Set([...(q.excludeBranches ?? []), ...BASE_BRANCHES]);
  const branches = await localBranches(root);
  const fallback: PrInfo[] = [];
  for (const p of prs) {
    if (!p.headRefName || known.has(p.headRefName) || exclude.has(p.headRefName) || !branches.has(p.headRefName)) continue;
    if (q.createdAfter !== undefined || q.updatedBefore !== undefined) {
      const ts = await branchTipTime(root, p.headRefName);
      if (ts === undefined) continue;
      // Slack absorbs clock/debounce jitter; a tip outside the window belongs to another session.
      if (q.createdAfter !== undefined && ts < q.createdAfter - 60_000) continue;
      if (q.updatedBefore !== undefined && ts > q.updatedBefore + 60_000) continue;
    }
    fallback.push(p);
  }
  return { refs, direct, fallback };
}

/**
 * Classifies a session branch: open PR ('pr') or already merged into a base branch
 * ('merged'). Uses `gh` when available (also catches squash merges); otherwise falls
 * back to merge-commit ancestry, and to remote tracking (a fully pushed branch means
 * the PR was opened in this workflow).
 */
export async function branchGitState(cwd: string, branch: string, q: SessionPrQuery = {}): Promise<BranchGitState> {
  const root = await gitRoot(cwd);
  if (!root) return { pr: false, merged: false };
  const state: BranchGitState = { pr: false, merged: false };
  if (which('gh')) {
    // The agent may have checked its own branch out inside the worktree, so the
    // worktree's current HEAD joins the stored branch as a direct match.
    const head = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    const { refs, direct, fallback } = await findSessionPrs(root, { ...q, branches: [branch, head, ...(q.branches ?? [])] });
    // PRs the session itself referenced win; a mention with no open PR falls through.
    if (refs.length) {
      if (refs.some((p) => p.state === 'OPEN')) return { pr: true, merged: false };
      if (refs.every((p) => p.state === 'MERGED')) return { pr: false, merged: true };
    }
    if (direct.some((p) => p.state === 'MERGED')) return { pr: false, merged: true };
    if (direct.some((p) => p.state === 'OPEN')) return { pr: true, merged: false };
    // The repo-wide fallback only flips the label when it is unambiguous.
    const all = [...direct, ...fallback];
    if (all.length === 1) {
      if (all[0].state === 'MERGED') return { pr: false, merged: true };
      if (all[0].state === 'OPEN') return { pr: true, merged: false };
    }
  }
  // A merge commit on a base branch whose second parent is the branch tip means the
  // branch really landed; a fresh branch sitting at the base tip must not count.
  // Squash merges need gh above.
  const tip = await git(root, ['rev-parse', '--verify', branch]);
  const tipHash = tip.code === 0 ? tip.stdout.trim() : '';
  if (tipHash) {
    for (const base of BASE_BRANCHES) {
      const r = await git(root, ['log', base, '--merges', '--format=%P', '-n', '200']);
      if (r.code === 0 && r.stdout.split('\n').some((line) => line.trim().split(/\s+/)[1] === tipHash)) {
        return { pr: false, merged: true };
      }
    }
  }
  if (!which('gh')) {
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

/** Merges the open PR whose head is `branch` (explicit, e.g. from the Branches panel); `base`, when given, is checked against the PR's target. */
async function gitMergeBranchPr(cwd: string, branch: string, base?: string): Promise<PrResult> {
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

/** Merges the open PR for the session; an explicit `head` branch pins the PR, otherwise the session's own is resolved. */
export async function gitMergePr(cwd: string, base?: string, head?: string, q: SessionPrQuery = {}): Promise<PrResult> {
  const root = await gitRoot(cwd);
  if (!root) return { ok: false, output: 'Not a git repository' };
  if (!ghBin()) return noGh();
  if (head?.trim()) return gitMergeBranchPr(cwd, head.trim(), base);
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  if (!branch || branch === 'HEAD') return { ok: false, output: 'Detached HEAD — check out a branch first.' };
  const { refs, direct, fallback } = await findSessionPrs(root, { ...q, branches: [branch, ...(q.branches ?? [])] });
  // One PR can be reachable through several signals; count each PR once, strongest tier first.
  const byNumber = new Map<number, PrInfo>();
  for (const p of [...refs, ...direct, ...fallback]) if (!byNumber.has(p.number)) byNumber.set(p.number, p);
  const all = [...byNumber.values()];
  const open = all.filter((p) => p.state === 'OPEN');
  if (open.length > 1) {
    const list = open.map((p) => `#${p.number} (${p.headRefName ?? 'unknown head'})`).join(', ');
    return { ok: false, output: `Several open PRs could belong to this session: ${list}. Merge one explicitly from the Branches panel.` };
  }
  if (open.length === 1) {
    const pr = open[0];
    if (base && pr.baseRefName && pr.baseRefName !== base) {
      return { ok: false, output: `That PR targets ${pr.baseRefName}, not ${base}: ${pr.url ?? ''}`.trim() };
    }
    // Foreign PRs merge by URL, so the repo does not need to be the session's.
    const merge = await gh(cwd, ['pr', 'merge', pr.url ?? String(pr.number), '--merge']);
    if (merge.code !== 0) return { ok: false, output: (merge.stderr || merge.stdout).trim() || 'gh pr merge failed' };
    const headNote = pr.headRefName ? ` (head ${pr.headRefName})` : '';
    return { ok: true, url: pr.url, output: (merge.stdout + merge.stderr).trim() || `Merged PR #${pr.number}${headNote} into ${pr.baseRefName ?? base ?? 'base'}` };
  }
  const merged = all.find((p) => p.state === 'MERGED');
  if (merged) return { ok: true, url: merged.url, output: `PR is MERGED (already merged): ${merged.url ?? ''}`.trim() };
  const closed = all.find((p) => p.state === 'CLOSED');
  if (closed) return { ok: false, output: closed.url ? `PR is CLOSED: ${closed.url}` : `No open PR for ${branch}` };
  return {
    ok: false,
    output: `No pull requests found for branch "${branch}". If the agent pushed its own branch, ask it to merge, or use the Branches panel.`
  };
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

const PR_LIST_FIELDS = 'number,title,state,isDraft,headRefName,baseRefName,url,author,createdAt,updatedAt,mergedAt,reviewDecision,additions,deletions';

const isoMs = (v: unknown): number | undefined => {
  if (typeof v !== 'string' || !v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
};

/** Pulls the repo's pull requests from GitHub (`gh pr list`, every state, newest first) for the Git panel's PR view. */
export async function gitPullRequests(cwd: string): Promise<GitPullRequestList> {
  const fetchedAt = Date.now();
  if (!ghBin()) return { prs: [], fetchedAt, ghMissing: true };
  const root = await gitRoot(cwd);
  if (!root) return { prs: [], fetchedAt, error: 'Not a git repository' };
  const r = await gh(root, ['pr', 'list', '--state', 'all', '--limit', '100', '--json', PR_LIST_FIELDS], 30_000);
  if (r.code !== 0) return { prs: [], fetchedAt, error: (r.stderr || r.stdout).trim() || 'gh pr list failed' };
  try {
    const list = JSON.parse(r.stdout.trim()) as Record<string, unknown>[];
    const prs: GitPullRequest[] = [];
    for (const p of list) {
      if (typeof p.number !== 'number' || typeof p.url !== 'string') continue;
      const state = p.state === 'MERGED' || p.state === 'CLOSED' ? p.state : 'OPEN';
      const author = p.author && typeof p.author === 'object' ? (p.author as { login?: string; name?: string }) : undefined;
      const pr: GitPullRequest = { number: p.number, title: typeof p.title === 'string' ? p.title : '', state, url: p.url };
      if (p.isDraft === true) pr.isDraft = true;
      if (typeof p.headRefName === 'string') pr.headRefName = p.headRefName;
      if (typeof p.baseRefName === 'string') pr.baseRefName = p.baseRefName;
      if (author?.login || author?.name) pr.author = author.login || author.name;
      const created = isoMs(p.createdAt), updated = isoMs(p.updatedAt), merged = isoMs(p.mergedAt);
      if (created !== undefined) pr.createdAt = created;
      if (updated !== undefined) pr.updatedAt = updated;
      if (merged !== undefined) pr.mergedAt = merged;
      if (typeof p.reviewDecision === 'string' && p.reviewDecision) pr.reviewDecision = p.reviewDecision;
      if (typeof p.additions === 'number') pr.additions = p.additions;
      if (typeof p.deletions === 'number') pr.deletions = p.deletions;
      prs.push(pr);
    }
    prs.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || b.number - a.number);
    return { prs, fetchedAt };
  } catch {
    return { prs: [], fetchedAt, error: 'gh pr list returned something that is not JSON' };
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

/** Thrown when a non-force worktree removal hits uncommitted changes; callers offer a force retry. */
export class WorktreeDirtyError extends Error {
  constructor(wtPath: string) {
    super(`The worktree has modified or untracked files: ${wtPath}`);
    this.name = 'WorktreeDirtyError';
  }
}

export async function removeWorktree(projectRoot: string, wtPath: string, opts: { force?: boolean } = {}): Promise<void> {
  const root = await gitRoot(projectRoot);
  if (!root) return;
  // A folder deleted outside the app has nothing to protect; prune the stale registration instead of failing.
  if (!(await exists(wtPath))) {
    await git(root, ['worktree', 'prune']);
    return;
  }
  const force = opts.force ?? true;
  // Without --force git refuses a worktree holding uncommitted changes; callers decide whether to surface that.
  const r = await git(root, force ? ['worktree', 'remove', '--force', wtPath] : ['worktree', 'remove', wtPath], 60_000);
  if (r.code !== 0) {
    // A stale or foreign folder (registration pruned, .git link deleted, path drift, plain directory)
    // cannot be removed as a worktree, and archive must not block on it: drop the registration and the
    // folder directly. A folder that IS a worktree of this repo keeps its real error (dirty tree, ...).
    const probe = await git(wtPath, ['rev-parse', '--git-common-dir']);
    const eq = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    const commonDir = probe.code === 0 ? path.resolve(probe.stdout.trim()) : '';
    const ours = eq(commonDir, path.resolve(root)) || eq(commonDir, path.resolve(root, '.git'));
    if (probe.code === 0 && ours) {
      if (/contains modified or untracked files/.test(`${r.stderr}${r.stdout}`)) throw new WorktreeDirtyError(wtPath);
      throw new Error(`git worktree remove failed: ${r.stderr || r.stdout}`);
    }
    await git(root, ['worktree', 'prune']);
    await fs.rm(wtPath, { recursive: true, force: true }).catch(() => undefined);
    return;
  }
  await git(root, ['worktree', 'prune']);
}

/** Re-creates a worktree at `wtPath` for an existing branch (used when an archived session is unarchived). */
export async function restoreWorktree(projectRoot: string, wtPath: string, branch: string): Promise<void> {
  const root = await gitRoot(projectRoot);
  if (!root) return;
  const branchExists = (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
  if (!branchExists) throw new Error(`Branch ${branch} no longer exists.`);
  if (await exists(wtPath)) return;
  // The folder may have been deleted externally, leaving a registration that blocks `worktree add`.
  await git(root, ['worktree', 'prune']);
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
