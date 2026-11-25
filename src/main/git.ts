/** Git plumbing facade behind the Changes/Branches panels, worktrees, and GitHub /pr & /merge flows. */
export { gh, gitFolderBranch, gitRoot, setGitLog } from './git/exec';
export { gitCommit, gitDiff, gitRangeEvidence, gitRevertFile, gitStageAll, gitSummary } from './git/working-tree';
export { gitCreateGitHubRepo, gitGithubIdentity, gitInit, gitInitialCommit, gitPush, gitSetIdentity, gitSetRemote, gitSetupStatus, isRemoteUrl } from './git/setup';
export {
  branchGitState,
  findSessionPrs,
  gitCreatePr,
  gitIssueComments,
  gitIssues,
  gitMergePr,
  gitPrMap,
  gitPullRequest,
  gitPullRequestComments,
  gitPullRequests,
  repoSlug,
  type BranchGitState,
  type PrInfo,
  type PrRef,
  type SessionPrQuery
} from './git/github';
export {
  confinedWorktreeRoot,
  createForkWorktree,
  createWorktree,
  excludeVocsCodeDir,
  gitIdentityFacts,
  gitResolveCommit,
  gitWorktrees,
  removeWorktree,
  restoreWorktree,
  slugify,
  worktreeAddForBranch,
  WorktreeDirtyError,
  worktreeInfo
} from './git/worktrees';
export {
  gitBranches,
  gitBranchesOverview,
  gitCheckout,
  gitDeleteBranch,
  gitFetchPrune,
  gitPruneWorktrees,
  gitUpdateBranch,
  parseUpstreamTrack,
  pickBase
} from './git/branches';
