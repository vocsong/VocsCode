/** GitHub CLI (gh) PR and issue lookup, session PR attribution, /pr creation, and /merge operations. */
import { parseGitHubPullRequestUrl } from '../../shared/github-pull-request';
import type { GitComment, GitCommentList, GitIssue, GitIssueList, GitPrInfo, GitPullRequest, GitPullRequestDetail, GitPullRequestList } from '../../shared/types';
import { runCapture, which } from '../runtime';
import { BASE_BRANCHES, gh, ghBin, GH_REQUIRED, git, gitRoot, timedOut, type PrResult } from './exec';

const PR_URL = /https:\/\/[^\s/"]+\/[^\s]+\/pull\/\d+/;
const PR_FIELDS = 'number,state,headRefName,baseRefName,url,title';
const PR_DETAILS_FIELDS = 'number,title,state,isDraft,headRefName,baseRefName,url,author,createdAt,updatedAt,mergedAt,reviewDecision,additions,deletions,body,labels,comments';
const ISSUE_LIST_FIELDS = 'number,title,state,url,author,body,labels,comments,createdAt,updatedAt,closedAt';

const noGh = (): PrResult => ({ ok: false, output: GH_REQUIRED });
const prUrlIn = (out: string): string | undefined => out.match(PR_URL)?.[0];
const isPrState = (state: unknown) => state === 'OPEN' || state === 'CLOSED' || state === 'MERGED';

/** PR/merge state of a session's branch, shown in the sidebar status labels. */
export interface BranchGitState {
  pr: boolean;
  merged: boolean;
  /** The exact PR the session named was closed without merging. */
  closed?: true;
  /** An unavailable lookup is not evidence that an existing PR went away. */
  unknown?: true;
}

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

async function listPrs(opts: { cwd: string; repo?: string }): Promise<PrInfo[] | undefined> {
  const bin = which('gh');
  if (!bin) return undefined;
  const args = ['pr', 'list', '--state', 'all', '--limit', '50', '--json', PR_FIELDS];
  if (opts.repo) args.push('-R', opts.repo);
  const r = await runCapture(bin, args, {
    cwd: opts.cwd,
    timeoutMs: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  if (r.code !== 0 || r.truncated || timedOut(r)) return undefined;
  try {
    const prs = JSON.parse(r.stdout);
    return Array.isArray(prs) ? prs : undefined;
  } catch {
    return undefined;
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
  const prs = (await listPrs({ cwd: root })) ?? [];
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
    let found = (await listPrs({ cwd: root, repo: r.repo }))?.find((p) => p.number === r.number);
    if (!found) {
      for (const extra of q.extraRoots ?? []) {
        found = (await listPrs({ cwd: extra }))?.find((p) => p.number === r.number);
        if (found) break;
      }
    }
    if (found && !refs.some((p) => p.number === found!.number)) refs.push(found);
  }
  return { refs, ...(await matchBranchPrs(root, prs, q)) };
}

/** Keep the same branch attribution rules for both the sidebar and /merge. */
async function matchBranchPrs(root: string, prs: PrInfo[], q: SessionPrQuery): Promise<{ direct: PrInfo[]; fallback: PrInfo[] }> {
  const known = new Set(q.branches?.filter(Boolean).filter((b) => !BASE_BRANCHES.includes(b)) ?? []);
  const direct = prs.filter((p) => p.headRefName !== undefined && known.has(p.headRefName));
  if (!prs.length) return { direct, fallback: [] };
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
  return { direct, fallback };
}

const unknownBranchGitState = (): BranchGitState => ({ pr: false, merged: false, unknown: true });

/** One exact, repo-qualified lookup for the sidebar; never resolve a transcript PR by number alone. */
async function explicitPrState(cwd: string, ref: PrRef): Promise<BranchGitState> {
  const target = ref.repo && parseGitHubPullRequestUrl(`https://github.com/${ref.repo}/pull/${ref.number}`);
  if (!target || !ghBin()) return unknownBranchGitState();
  const r = await gh(cwd, ['pr', 'view', target.url, '--json', 'number,state,url'], 15_000);
  if (r.code !== 0 || r.truncated || timedOut(r)) return unknownBranchGitState();
  try {
    const pr = JSON.parse(r.stdout) as PrInfo | null;
    const resolved = typeof pr?.url === 'string' ? parseGitHubPullRequestUrl(pr.url) : undefined;
    if (pr?.number === target.number && resolved?.url.toLowerCase() === target.url.toLowerCase() && isPrState(pr.state)) {
      return { pr: pr.state === 'OPEN', merged: pr.state === 'MERGED', ...(pr.state === 'CLOSED' ? { closed: true as const } : {}) };
    }
  } catch { /* Unavailable is not evidence for an older PR. */ }
  return unknownBranchGitState();
}

/** Classifies the latest named PR or, with no explicit ref, the session's branch. */
export async function branchGitState(cwd: string, branch: string, q: SessionPrQuery = {}): Promise<BranchGitState> {
  const latestRef = q.prRefs?.at(-1);
  if (latestRef) return explicitPrState(cwd, latestRef);

  const root = await gitRoot(cwd);
  if (!root) return unknownBranchGitState();
  const prs = await listPrs({ cwd: root });
  const validPrs = prs?.every((pr) => pr && isPrState(pr.state) && typeof pr.headRefName === 'string') ?? false;
  if (prs?.length && validPrs) {
    // The agent may have checked its own branch out inside the worktree, so the
    // worktree's current HEAD joins the stored branch as a direct match.
    const head = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    const { direct, fallback } = await matchBranchPrs(root, prs, { ...q, branches: [branch, head, ...(q.branches ?? [])] });
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
  // A pushed branch without a successful GitHub lookup cannot establish PR state.
  return validPrs ? { pr: false, merged: false } : unknownBranchGitState();
}

/**
 * Pushes `head` (default: the current branch) and opens a PR into `base` (gh). Refuses a dirty tree
 * so the PR is complete. Without `pr` gh fills title and body from the commits; with it the body
 * goes through stdin, so no length or quoting limit of the command line applies.
 */
export async function gitCreatePr(cwd: string, base: string, head?: string, pr?: { title: string; body: string }): Promise<PrResult> {
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
  const r = pr
    ? await gh(cwd, ['pr', 'create', '--base', base, '--head', branch, '--title', pr.title, '--body-file', '-'], 120_000, pr.body)
    : await gh(cwd, ['pr', 'create', '--base', base, '--head', branch, '--fill']);
  const out = (r.stdout + r.stderr).trim();
  if (r.truncated) return { ok: false, output: 'gh pr create response was truncated' };
  if (r.code !== 0) return { ok: false, output: out || 'gh pr create failed' };
  return { ok: true, url: prUrlIn(out), output: out };
}

/** Merges the open PR whose head is `branch` (explicit, e.g. from the Branches panel); `base`, when given, is checked against the PR's target. */
async function gitMergeBranchPr(cwd: string, branch: string, base?: string): Promise<PrResult> {
  const view = await gh(cwd, ['pr', 'view', branch, '--json', 'state,url,baseRefName'], 30_000);
  if (view.code !== 0 || view.truncated) return { ok: false, output: view.truncated ? 'Could not read PR details: response was truncated.' : (view.stdout + view.stderr).trim() || `No open PR for ${branch}` };
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
  if (merge.truncated) return { ok: false, output: 'gh pr merge response was truncated' };
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
    if (merge.truncated) return { ok: false, output: 'gh pr merge response was truncated' };
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
  if (r.code !== 0 || r.truncated) return {};
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

const isoMs = (v: unknown): number | undefined => {
  if (typeof v !== 'string' || !v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
};

/** `gh` reports labels as objects; keep the named ones, dropping the colour key when GitHub did not send one. */
function ghLabels(v: unknown): { name: string; color?: string }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const labels = v
    .filter((l): l is { name?: string; color?: string } => !!l && typeof l === 'object')
    .map((l) => ({ name: typeof l.name === 'string' ? l.name : '', color: typeof l.color === 'string' ? l.color : undefined }))
    .filter((l) => l.name);
  return labels.length > 0 ? labels.map((l) => (l.color ? l : { name: l.name })) : undefined;
}

/** `gh <x> list --json comments` sends the comment array; tolerate a plain count so old fakes and payloads keep working. */
function ghCommentCount(v: unknown): number | undefined {
  if (Array.isArray(v)) return v.length;
  return typeof v === 'number' ? v : undefined;
}

function ghPullRequest(p: Record<string, unknown>): GitPullRequest | undefined {
  if (!p || typeof p.number !== 'number' || typeof p.url !== 'string') return;
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
  if (typeof p.body === 'string') pr.body = p.body;
  const labels = ghLabels(p.labels);
  if (labels) pr.labels = labels;
  const comments = ghCommentCount(p.comments);
  if (comments !== undefined) pr.comments = comments;
  return pr;
}

/** Pulls the repo's pull requests from GitHub (`gh pr list`, every state, newest first) for the Git panel's PR view. */
export async function gitPullRequests(cwd: string): Promise<GitPullRequestList> {
  const fetchedAt = Date.now();
  if (!ghBin()) return { prs: [], fetchedAt, ghMissing: true };
  const root = await gitRoot(cwd);
  if (!root) return { prs: [], fetchedAt, error: 'Not a git repository' };
  const r = await gh(root, ['pr', 'list', '--state', 'all', '--limit', '100', '--json', PR_DETAILS_FIELDS], 30_000);
  if (r.code !== 0 || r.truncated) return { prs: [], fetchedAt, error: r.truncated ? 'gh pr list response was truncated' : (r.stderr || r.stdout).trim() || 'gh pr list failed' };
  try {
    const list = JSON.parse(r.stdout.trim()) as Record<string, unknown>[];
    const prs: GitPullRequest[] = [];
    for (const p of list) {
      const pr = ghPullRequest(p);
      if (pr) prs.push(pr);
    }
    prs.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || b.number - a.number);
    return { prs, fetchedAt };
  } catch {
    return { prs: [], fetchedAt, error: 'gh pr list returned something that is not JSON' };
  }
}

/** The URL supplies the repo even when the transcript's checkout has been removed. */
export async function gitPullRequest(url: string): Promise<GitPullRequestDetail> {
  const link = parseGitHubPullRequestUrl(url);
  if (!link) return { error: 'Invalid GitHub pull request link.' };
  if (!ghBin()) return { error: GH_REQUIRED };
  const r = await gh(undefined, ['pr', 'view', link.url, '--json', PR_DETAILS_FIELDS], 30_000);
  if (r.code !== 0 || r.truncated) {
    return { error: r.truncated ? 'gh pr view response was truncated' : (r.stderr || r.stdout).trim() || 'gh pr view failed' };
  }
  try {
    const data = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
    const pr = ghPullRequest(data);
    if (!pr || pr.number !== link.number) return { error: 'GitHub did not return the linked pull request.' };
    return { pr, comments: ghComments(data.comments) };
  } catch {
    return { error: 'gh pr view returned something that is not JSON' };
  }
}

/** `gh <x> view --json comments` reports each comment's author, markdown body, timestamp and URL; keep the fields the preview shows. */
function ghComments(v: unknown): GitComment[] {
  if (!Array.isArray(v)) return [];
  const out: GitComment[] = [];
  for (const c of v) {
    if (!c || typeof c !== 'object') continue;
    const o = c as { author?: { login?: string; name?: string }; body?: string; createdAt?: string; url?: string; authorAssociation?: string };
    const author = o.author && typeof o.author === 'object' ? o.author.login || o.author.name : undefined;
    const comment: GitComment = {};
    if (author) comment.author = author;
    if (typeof o.body === 'string') comment.body = o.body;
    const created = isoMs(o.createdAt);
    if (created !== undefined) comment.createdAt = created;
    if (typeof o.url === 'string') comment.url = o.url;
    if (typeof o.authorAssociation === 'string' && o.authorAssociation) comment.authorAssociation = o.authorAssociation;
    out.push(comment);
  }
  return out;
}

/**
 * Pulls the conversation comments of one issue or PR, on demand: the list payload only carries the
 * count, and fetching every body up front would pay for issues the user never opens.
 */
async function gitComments(cwd: string, kind: 'issue' | 'pr', number: number): Promise<GitCommentList> {
  if (!ghBin()) return { comments: [], ghMissing: true };
  const root = await gitRoot(cwd);
  if (!root) return { comments: [], error: 'Not a git repository' };
  const r = await gh(root, [kind, 'view', String(number), '--json', 'comments'], 30_000);
  if (r.code !== 0 || r.truncated) {
    return { comments: [], error: r.truncated ? `gh ${kind} view response was truncated` : (r.stderr || r.stdout).trim() || `gh ${kind} view failed` };
  }
  try {
    const parsed = JSON.parse(r.stdout.trim()) as { comments?: unknown };
    return { comments: ghComments(parsed.comments) };
  } catch {
    return { comments: [], error: `gh ${kind} view returned something that is not JSON` };
  }
}

/** Pulls one issue's conversation comments, for the Git panel's issue preview. */
export async function gitIssueComments(cwd: string, number: number): Promise<GitCommentList> {
  return gitComments(cwd, 'issue', number);
}

/** Pulls one pull request's conversation comments, for the Git panel's PR preview. */
export async function gitPullRequestComments(cwd: string, number: number): Promise<GitCommentList> {
  return gitComments(cwd, 'pr', number);
}

/** Pulls the repo's issues from GitHub (`gh issue list`, every state, newest first) for the Git panel's Issues view. */
export async function gitIssues(cwd: string): Promise<GitIssueList> {
  const fetchedAt = Date.now();
  if (!ghBin()) return { issues: [], fetchedAt, ghMissing: true };
  const root = await gitRoot(cwd);
  if (!root) return { issues: [], fetchedAt, error: 'Not a git repository' };
  const r = await gh(root, ['issue', 'list', '--state', 'all', '--limit', '100', '--json', ISSUE_LIST_FIELDS], 30_000);
  if (r.code !== 0 || r.truncated) return { issues: [], fetchedAt, error: r.truncated ? 'gh issue list response was truncated' : (r.stderr || r.stdout).trim() || 'gh issue list failed' };
  try {
    const list = JSON.parse(r.stdout.trim()) as Record<string, unknown>[];
    const issues: GitIssue[] = [];
    for (const p of list) {
      if (typeof p.number !== 'number' || typeof p.url !== 'string') continue;
      const state = p.state === 'CLOSED' ? 'CLOSED' : 'OPEN';
      const author = p.author && typeof p.author === 'object' ? (p.author as { login?: string; name?: string }) : undefined;
      const issue: GitIssue = { number: p.number, title: typeof p.title === 'string' ? p.title : '', state, url: p.url };
      if (author?.login || author?.name) issue.author = author.login || author.name;
      if (typeof p.body === 'string') issue.body = p.body;
      const labels = ghLabels(p.labels);
      if (labels) issue.labels = labels;
      const comments = ghCommentCount(p.comments);
      if (comments !== undefined) issue.comments = comments;
      const created = isoMs(p.createdAt), updated = isoMs(p.updatedAt), closed = isoMs(p.closedAt);
      if (created !== undefined) issue.createdAt = created;
      if (updated !== undefined) issue.updatedAt = updated;
      if (closed !== undefined) issue.closedAt = closed;
      issues.push(issue);
    }
    issues.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || b.number - a.number);
    return { issues, fetchedAt };
  } catch {
    return { issues: [], fetchedAt, error: 'gh issue list returned something that is not JSON' };
  }
}
