/**
 * Canonical sidebar row order for one folder's sessions. It lives outside the Sidebar component
 * because the store needs the same order to pick the row below a session that just left the list —
 * and the store cannot import a component that imports the store.
 */
import type { SessionMeta } from '../../shared/types';

/** Pinned rows sort to the top by pin stamp (first pin on top); the rest stay in recency order. */
function pinRank(s: SessionMeta): number {
  return s.pinned ? (s.pinnedAt ?? s.createdAt) : Number.POSITIVE_INFINITY;
}

/**
 * What a row's recency is measured from: the user's own last message here. Agent activity keeps
 * `updatedAt` moving, so ordering by that let a long turn in the background pull a session the user
 * was not working in over the one they were. Rows written before the stamp existed (or never sent a
 * prompt) fall back to `updatedAt`, so the upgrade does not reshuffle every folder at once.
 */
export function recencyAt(s: SessionMeta): number {
  return s.lastUserMessageAt ?? s.updatedAt;
}

/** Canonical display order for one folder's session list. */
export function sortSessionRows(list: SessionMeta[]): SessionMeta[] {
  return [...list].sort((a, b) => pinRank(a) - pinRank(b) || recencyAt(b) - recencyAt(a) || a.id.localeCompare(b.id));
}

/**
 * Mission mode: each Builder moves directly under its Lead, in Builder number order, wherever the
 * sorted list put the Lead. A Builder whose Lead is not in the list (archived, filtered out) keeps
 * its own place. Applied after `sortSessionRows`, so the vertical list and keyboard order agree.
 */
export function nestMissionRows(sorted: SessionMeta[]): SessionMeta[] {
  const leads = new Set(sorted.filter((s) => s.mission?.role === 'lead').map((s) => s.id));
  if (!leads.size) return sorted;
  const builders = new Map<string, SessionMeta[]>();
  for (const s of sorted) {
    const lead = s.mission?.role === 'builder' ? s.mission.leadId : undefined;
    if (lead && lead !== s.id && leads.has(lead)) builders.set(lead, [...(builders.get(lead) ?? []), s]);
  }
  if (!builders.size) return sorted;
  const nested = new Set([...builders.values()].flat().map((s) => s.id));
  const index = (s: SessionMeta) => s.mission?.builderIndex ?? Number.MAX_SAFE_INTEGER;
  const out: SessionMeta[] = [];
  for (const s of sorted) {
    if (nested.has(s.id)) continue;
    out.push(s);
    const under = builders.get(s.id);
    if (under) out.push(...[...under].sort((a, b) => index(a) - index(b) || a.id.localeCompare(b.id)));
  }
  return out;
}
