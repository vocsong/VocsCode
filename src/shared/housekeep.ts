import type { SessionMeta } from './types';

export const DEFAULT_HOUSEKEEP_RECENT_DAYS = 7;
export const MAX_HOUSEKEEP_RECENT_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeHousekeepRecentDays(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_HOUSEKEEP_RECENT_DAYS
    ? value : DEFAULT_HOUSEKEEP_RECENT_DAYS;
}

/** Age is deliberately conservative: activity, a newer edit, or viewing the session all count. */
export function housekeepActivityAt(session: Pick<SessionMeta, 'createdAt' | 'updatedAt' | 'lastUserMessageAt' | 'lastViewedAt'>): number | null {
  const dates = [session.createdAt, session.updatedAt, session.lastUserMessageAt, session.lastViewedAt]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  return dates.length ? Math.max(...dates) : null;
}

export function housekeepIsRecent(activityAt: number, now: number, days: number): boolean {
  return activityAt > now || days > 0 && activityAt >= now - days * DAY_MS;
}

export interface HousekeepEvidence {
  request: string;
  response: string;
}

export interface HousekeepRow {
  sessionId: string;
  title: string;
  projectRoot: string;
  activityAt: number | null;
  verdict: 'protected' | 'keep' | 'review' | 'complete';
  reason: string;
  worktree: 'none' | 'missing' | 'remove' | null;
  evidence?: HousekeepEvidence;
}

export interface HousekeepPreview {
  id: string;
  recentDays: number;
  /** The exact configured utility model that can receive excerpts, after user opt-in. */
  reviewModel: string | null;
  rows: HousekeepRow[];
}

/** A read-only observation, never an archive candidate or a permission to remove anything. */
export interface HousekeepInventoryRow {
  projectRoot: string;
  kind: 'unregistered-folder' | 'stale-registration' | 'archived-worktree' | 'unlinked-worktree' | 'unverified-path' | 'retained-branch' | 'unlinked-branch';
  /** The checkout path or local branch name. */
  location: string;
  branch?: string;
  locked?: boolean;
  /** For registered checkouts: what the bounded filesystem scan could establish. */
  diskState?: 'present' | 'missing' | 'unknown';
  gitMarksStale?: boolean;
  /** Session path matches on checkout rows; recorded refs on branch-only rows. */
  sessions: { title: string; archived: boolean }[];
  /** Sessions that record the registered branch but don't match this checkout's path. */
  branchSessions?: HousekeepInventoryRow['sessions'];
  sessionLinksIncomplete?: boolean;
}

export interface HousekeepInventory {
  repositories: number;
  rows: HousekeepInventoryRow[];
  warnings: string[];
  limited: boolean;
}

export interface HousekeepOutcome {
  sessionId: string;
  title: string;
  state: 'archived' | 'removed' | 'skipped';
  detail?: string;
}
