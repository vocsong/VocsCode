/**
 * Shared Git, GitHub, and workspace filesystem types.
 * Keep this file free of Node/Electron/DOM imports.
 */

export interface GitFileStatus {
  path: string;
  status: 'M' | 'A' | 'D' | 'R' | '?' | 'U' | 'C' | 'T';
  staged: boolean;
  additions?: number;
  deletions?: number;
  oldPath?: string;
}

export interface GitSummary {
  isRepo: boolean;
  root?: string;
  branch?: string;
  files: GitFileStatus[];
  ahead?: number;
  behind?: number;
  /** Set when git could not produce a trustworthy summary (timeout/corrupt repo); the file list may be empty or incomplete. */
  error?: string;
}

/**
 * Guided-setup state for a folder: how far a repository has come (init, first commit, GitHub
 * remote, push) and whether the GitHub CLI can automate the remote side.
 */
export interface GitSetupStatus {
  isRepo: boolean;
  /** Repository root, once initialized (a linked worktree reports its own root). */
  root?: string;
  /** Main repository root (the shared `.git`), so the guide is dismissed once per project, not per worktree. */
  mainRoot?: string;
  /** Current branch; absent on a detached HEAD. */
  branch?: string;
  /** False for a repository with no commits yet (an unborn branch). */
  hasCommits: boolean;
  /** The `origin` remote URL, when one is configured. */
  remote?: string;
  /** True once the current branch exists on origin (a remote-tracking ref). */
  pushed: boolean;
  /** True when the repo has any remote-tracking branch, i.e. it has been published; the guide never nags an established repo. */
  published: boolean;
  /** Git author identity (`user.name` / `user.email`, local or global); a commit fails while either is missing. */
  identity: { name?: string; email?: string };
  /** GitHub CLI availability, which powers one-click repository creation and credential setup. */
  gh: { installed: boolean; authenticated: boolean; account?: string };
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
}

export interface GitWorktreeInfo {
  path: string;
  branch?: string;
  detached: boolean;
}

/** One local branch in the Branches panel's GitHub-style overview. */
export interface GitBranchOverviewItem {
  name: string;
  current: boolean;
  /** The branch the panel diffs everything against (develop/master/main). */
  isBase: boolean;
  lastCommitAt?: number;
  lastCommitSubject?: string;
  /** Commits on this branch that the base branch does not have. */
  ahead?: number;
  /** Commits on the base branch that this branch does not have. */
  behind?: number;
  /** Ancestor of the base branch — safe to delete without losing work. */
  merged: boolean;
  upstream?: string;
  upstreamAhead?: number;
  upstreamBehind?: number;
  /** The upstream branch no longer exists on the server (`%(upstream:track)` = `[gone]`): this branch is local-only.
   *  Only shows up once remote-tracking refs have been pruned, which is why a refresh re-syncs them. */
  upstreamGone?: boolean;
  /** Set when the branch is checked out in a worktree. */
  worktreePath?: string;
  /** GitHub PR attached to this branch, when gh is available. */
  pr?: GitPrInfo;
}

/** A GitHub PR whose head is a local branch. */
export interface GitPrInfo {
  number: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  url: string;
  title?: string;
}

/** One GitHub pull request shown in the Git panel. */
export interface GitPullRequest {
  number: number;
  title: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft?: boolean;
  headRefName?: string;
  baseRefName?: string;
  url: string;
  author?: string;
  /** ms since epoch */
  createdAt?: number;
  updatedAt?: number;
  mergedAt?: number;
  /** GitHub's review decision: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or empty. */
  reviewDecision?: string;
  additions?: number;
  deletions?: number;
  /** Markdown description returned by GitHub. */
  body?: string;
  labels?: { name: string; color?: string }[];
  comments?: number;
}

/** The PR list pulled from GitHub; `error` carries gh's own words when the pull failed (not logged in, no remote…). */
export interface GitPullRequestList {
  prs: GitPullRequest[];
  /** When the list was pulled (ms since epoch). */
  fetchedAt: number;
  ghMissing?: boolean;
  error?: string;
}

/** The PR and conversation loaded on demand when a transcript links to it. */
export type GitPullRequestDetail =
  | { pr: GitPullRequest; comments: GitComment[]; error?: never }
  | { pr?: never; comments?: never; error: string };

/** One issue of the session's GitHub repo, as `gh issue list` reports it (Issues view of the Git panel). */
export interface GitIssue {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED';
  url: string;
  author?: string;
  /** Markdown description returned by GitHub. */
  body?: string;
  labels?: { name: string; color?: string }[];
  comments?: number;
  /** ms since epoch */
  createdAt?: number;
  updatedAt?: number;
  closedAt?: number;
}

/** The issue list pulled from GitHub; `error` carries gh's own words when the pull failed (not logged in, no remote…). */
export interface GitIssueList {
  issues: GitIssue[];
  /** When the list was pulled (ms since epoch). */
  fetchedAt: number;
  ghMissing?: boolean;
  error?: string;
}

/** One conversation comment on a GitHub issue or pull request, as `gh … view --json comments` reports it. */
export interface GitComment {
  author?: string;
  /** Markdown body returned by GitHub. */
  body?: string;
  /** ms since epoch */
  createdAt?: number;
  url?: string;
  /** GitHub's association of the commenter with the repo: OWNER, MEMBER, CONTRIBUTOR, … */
  authorAssociation?: string;
}

/** The conversation comments pulled for one issue or pull request; `error` carries gh's own words when the pull failed. */
export interface GitCommentList {
  comments: GitComment[];
  /** True when the GitHub CLI is unavailable; the preview then shows the comment count only. */
  ghMissing?: boolean;
  error?: string;
}

export interface GitBranchOverview {
  isRepo: boolean;
  base?: string;
  branches: GitBranchOverviewItem[];
  worktrees: GitWorktreeInfo[];
  /** True when the GitHub CLI is unavailable; PR actions are hidden in the Branches panel. */
  ghMissing?: boolean;
  /** Set when the branch list could not be read in full (e.g. git timed out). */
  error?: string;
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
}
