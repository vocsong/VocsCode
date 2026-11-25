/** Durable Mission mode record types shared between service orchestration and worktree housekeeping. */
import type { BuilderState, MissionMessageKind, MissionState } from '../../shared/mission-mode';
import type { HarnessId } from '../../shared/harness-types';

/** One undelivered host message for a Lead or a Builder. */
export interface InboxEntry {
  id: string;
  kind: MissionMessageKind;
  text: string;
  builderId?: string;
  requestId?: string;
  ts: number;
}

export interface BuilderRecord {
  /** `b<n>`, what the Lead's tools name it by. */
  id: string;
  sessionId: string;
  index: number;
  title: string;
  task: string;
  state: BuilderState;
  harness: HarnessId;
  /** The folder it works in: its own worktree, the Lead's, or the project folder without git. */
  cwd: string;
  /** Where its own changes start (shared Builders; own worktrees diff from the merge base). */
  startSha?: string;
  worktree?: { path: string; branch: string };
  landed?: boolean;
  accepted?: boolean;
  /** Its worktree was removed. */
  cleaned?: boolean;
  failedChecks: number;
  lastReport?: { summary: string; verification: string[]; files?: string[]; uncommitted?: string[]; at: number };
  pendingQuestion?: string;
  /** What it was doing when the app restarted; the Resume message says so. */
  interruptedFrom?: BuilderState;
  startedAt: number;
  endedAt?: number;
}

export interface MissionRecord {
  v: 1;
  id: string;
  leadId: string;
  createdAt: number;
  updatedAt: number;
  state: MissionState;
  projectRoot: string;
  git: boolean;
  baseBranch?: string;
  leadBranch?: string;
  /** The Lead's folder: its worktree, or the project folder without git. */
  leadWorktree: string;
  /** The mission (or the Lead session) owns the worktree and may remove it when the mission ends. */
  leadWorktreeOwned: boolean;
  leadWorktreeCleaned?: boolean;
  startSha?: string;
  uncommittedAtStart?: boolean;
  pr?: { url: string; number?: number; lastPushedSha?: string };
  builders: BuilderRecord[];
  inbox: { lead: InboxEntry[]; builders: Record<string, InboxEntry[]> };
  /** Builders at the failed-check limit: message_builder is refused until the user next writes. */
  checksBlockedUntilUser?: string[];
  /** The last finish report, as the PR body reads. */
  report?: string;
}
