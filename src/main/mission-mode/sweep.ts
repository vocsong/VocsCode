/**
 * Mission mode housekeeping: removing a Builder's or the Lead's worktree once its work is safe, and
 * the startup sweep over missions that ended or stopped. Work that is not landed, merged or pushed
 * is never deleted: its worktree and branch stay and the result says so. Orphan `mission/*`
 * worktrees (no record names them; the retired Mission feature used the same prefix) are only
 * reported. No Electron imports.
 */
import path from 'node:path';
import { gitWorktrees } from '../git';
import { cleanupWorktree, currentHead, isLanded, MISSION_BRANCH_PREFIX, statusPorcelain } from './git-ops';
import type { BuilderRecord, MissionRecord } from './service';

export interface CleanupOutcome {
  /** The worktree folder is gone. */
  removed: boolean;
  /** A sentence for the Lead or the log when something was kept or failed. */
  note?: string;
}

const who = (b: BuilderRecord): string => `Builder ${b.index} (${b.id})`;

/**
 * Removes a Builder's own worktree when its work is on the Lead branch (accepted, landed, or found
 * landed now) and the tree holds no uncommitted changes. Shared Builders own no worktree.
 */
export async function cleanBuilderWorktree(record: MissionRecord, builder: BuilderRecord): Promise<CleanupOutcome> {
  const wt = builder.worktree;
  if (!wt || builder.cleaned || !record.git) return { removed: false };
  let landed = !!builder.landed || !!builder.accepted;
  if (!landed && record.leadBranch) {
    const check = await isLanded(record.projectRoot, record.leadBranch, wt.branch);
    landed = check.ok && check.landed;
  }
  if (!landed) return { removed: false, note: `${who(builder)}'s branch ${wt.branch} is not on the Lead branch, so its worktree ${wt.path} was kept.` };
  const status = await statusPorcelain(wt.path);
  if (status.ok && !status.clean) return { removed: false, note: `${who(builder)}'s worktree ${wt.path} has uncommitted changes, so it was kept.` };
  const result = await cleanupWorktree({
    projectRoot: record.projectRoot,
    path: wt.path,
    branch: wt.branch,
    mergedInto: [record.leadBranch, record.baseBranch].filter((b): b is string => !!b)
  });
  if (!result.ok) return { removed: false, note: `${who(builder)}'s worktree could not be removed: ${result.error}` };
  return { removed: result.removed, ...(result.branch && !result.branch.deleted ? { note: result.branch.note } : {}) };
}

/**
 * Removes the Lead's worktree after the mission ended, only when the mission created it, its tree is
 * clean, and its tip is merged or is exactly what was last pushed.
 */
export async function cleanLeadWorktree(record: MissionRecord, merged: boolean): Promise<CleanupOutcome> {
  if (!record.git || !record.leadWorktreeOwned || record.leadWorktreeCleaned || !record.leadBranch) return { removed: false };
  const status = await statusPorcelain(record.leadWorktree);
  if (status.ok && !status.clean) return { removed: false, note: `The Lead's worktree ${record.leadWorktree} has uncommitted changes, so it was kept.` };
  const head = await currentHead(record.leadWorktree);
  const pushed = head.ok && !!record.pr?.lastPushedSha && head.sha === record.pr.lastPushedSha;
  if (!merged && !pushed) return { removed: false, note: `The Lead branch ${record.leadBranch} has commits that were never pushed, so its worktree was kept.` };
  const result = await cleanupWorktree({
    projectRoot: record.projectRoot,
    path: record.leadWorktree,
    branch: record.leadBranch,
    mergedInto: record.baseBranch ? [record.baseBranch] : []
  });
  if (!result.ok) return { removed: false, note: `The Lead's worktree could not be removed: ${result.error}` };
  return { removed: result.removed, ...(result.branch && !result.branch.deleted ? { note: result.branch.note } : {}) };
}

const samePath = (a: string, b: string): boolean => {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
};

/** `mission/*` worktrees of these projects that no mission record names. Read-only. */
export async function orphanMissionWorktrees(records: readonly MissionRecord[]): Promise<{ projectRoot: string; path: string; branch: string }[]> {
  const known = records.flatMap((r) => [r.leadWorktree, ...r.builders.flatMap((b) => (b.worktree ? [b.worktree.path] : []))]);
  const roots = [...new Set(records.filter((r) => r.git).map((r) => r.projectRoot))];
  const out: { projectRoot: string; path: string; branch: string }[] = [];
  for (const projectRoot of roots) {
    const { worktrees } = await gitWorktrees(projectRoot).catch(() => ({ worktrees: [] as { path: string; branch?: string }[] }));
    for (const wt of worktrees) {
      if (!wt.branch?.startsWith(`${MISSION_BRANCH_PREFIX}/`)) continue;
      if (known.some((p) => samePath(p, wt.path))) continue;
      out.push({ projectRoot, path: wt.path, branch: wt.branch });
    }
  }
  return out;
}
