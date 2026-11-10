/** What the activity tray lists (docs/superpowers/specs/2026-11-09-session-activity-tray-design.md):
 *  every top-level, unarchived session that needs you, is running, finished since you last looked,
 *  or was viewed recently — each session in one section only, the most urgent one. */
import type { SessionMeta } from '../../shared/types';
import { isTopLevelSession } from './missions';

/** How many recently viewed sessions the tray offers. */
export const RECENT_LIMIT = 5;

export interface ActivitySections {
  /** Waiting on an approval or a question. */
  needs: SessionMeta[];
  running: SessionMeta[];
  /** A turn ended while nobody was looking (`unseenAt`), newest first; failed turns included. */
  done: SessionMeta[];
  /** Viewed most recently, newest first, excluding the active session and everything above. */
  recent: SessionMeta[];
}

const newest = (key: (s: SessionMeta) => number) => (a: SessionMeta, b: SessionMeta) => key(b) - key(a);

export function activitySections(sessions: SessionMeta[], activeId: string | null): ActivitySections {
  const live = sessions.filter((s) => isTopLevelSession(s) && !s.archived);
  const needs = live.filter((s) => s.status === 'awaiting').sort(newest((s) => s.updatedAt));
  const running = live.filter((s) => s.status === 'running' || s.status === 'starting').sort(newest((s) => s.lastUserMessageAt ?? s.updatedAt));
  const listed = new Set([...needs, ...running].map((s) => s.id));
  const done = live.filter((s) => s.unseenAt !== undefined && !listed.has(s.id)).sort(newest((s) => s.unseenAt!));
  for (const s of done) listed.add(s.id);
  const recent = live
    .filter((s) => s.lastViewedAt !== undefined && s.id !== activeId && !listed.has(s.id))
    .sort(newest((s) => s.lastViewedAt!))
    .slice(0, RECENT_LIMIT);
  return { needs, running, done, recent };
}
