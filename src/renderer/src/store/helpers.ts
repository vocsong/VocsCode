/** Pure and runtime-scoped helpers shared by store slices. */
import type { SessionMeta } from '../../../shared/types';
import * as panes from '../panes';
import type { PaneLayout } from '../panes';
import { recencyAt, sortSessionRows } from '../sessionOrder';
import type { Getter, NavEntry, PanelBottomTab, Setter, State, StoreRuntime } from './types';

const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'costUsd', 'turns', 'contextWindow', 'contextTokens'] as const;

export function sameUsageTotals(a: SessionMeta['usage'], b: SessionMeta['usage']): boolean {
  return USAGE_FIELDS.every((field) => a[field] === b[field]);
}

/** Background sessions in another worktree do not change the foreground diff. */
export function affectsActiveWorkspace(s: State, sessionId: string): boolean {
  if (s.activeId === sessionId) return true;
  const cwd = s.sessions.find((session) => session.id === sessionId)?.cwd;
  return !!cwd && s.sessions.some((session) => session.id === s.activeId && session.cwd === cwd);
}

export function bootErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'An unexpected error occurred while loading Vocs Code.';
}

/**
 * Which session takes over once `activeId` leaves the visible list. Follows the sidebar: the row
 * directly below it in its own folder, or — when it was that folder's last row — the one above it.
 * The rows are ordered as the user was looking at them, active session included, so "below" means
 * the row that sat under the one that left rather than whatever ends up adjacent without it.
 *
 * Only a folder with nothing else left to show falls back to the most recent session anywhere, and
 * only a list with no active session at all leaves nothing to select.
 */
export function replacementFor(previous: SessionMeta[], next: SessionMeta[], activeId: string): SessionMeta | undefined {
  const visible = next.filter((x) => !x.archived);
  const root = previous.find((x) => x.id === activeId)?.config.projectRoot;
  const rows = sortSessionRows(previous.filter((x) => !x.archived && x.config.projectRoot === root));
  const at = rows.findIndex((x) => x.id === activeId);
  const neighbour = at === -1 ? undefined : rows[at + 1] ?? rows[at - 1];
  const picked = neighbour && visible.find((x) => x.id === neighbour.id);
  if (picked) return picked;
  return visible.sort((a, b) => recencyAt(b) - recencyAt(a) || b.createdAt - a.createdAt || a.id.localeCompare(b.id))[0];
}

export function dropPendingDeltas(rt: StoreRuntime, sessionId: string, itemId?: string): void {
  for (let i = rt.pendingDeltas.length - 1; i >= 0; i--) {
    const d = rt.pendingDeltas[i];
    if (d.sessionId === sessionId && (itemId === undefined || (d.event.type === 'item.delta' && d.event.id === itemId))) rt.pendingDeltas.splice(i, 1);
  }
}

/** Replays what arrived while a page was loading. The floor set with the page decides which of
 *  those events the snapshot already contains; the rest apply in arrival order. */
export function replayBuffered(rt: StoreRuntime, get: Getter, id: string): void {
  const events = rt.bufferedEvents.get(id);
  rt.bufferedEvents.delete(id);
  if (!events?.length) return;
  for (const env of events) get().applyEvent(env);
}

export function pushHistory(rt: StoreRuntime, set: Setter, get: Getter, entry: NavEntry): void {
  if (rt.navigating) return;
  // An empty pane is not a destination. Recording one would make a later Back replay
  // `setActive(null)`, which blanks whichever pane is active at that moment instead of
  // returning to the session the reader came from.
  if (entry.view === 'chat' && entry.sessionId === null) return;
  const { history, historyIndex } = get();
  const current = history[historyIndex];
  if (current && current.view === entry.view && current.sessionId === entry.sessionId) return;
  // A new destination truncates anything ahead, exactly like a browser.
  const next = [...history.slice(0, historyIndex + 1), entry].slice(-50);
  set({ history: next, historyIndex: next.length - 1 });
}

export async function applyNav(rt: StoreRuntime, set: Setter, get: Getter, entry: NavEntry, index: number): Promise<void> {
  rt.navigating = true;
  set({ historyIndex: index });
  try {
    if (entry.sessionId !== get().activeId) await get().setActive(entry.sessionId);
    set({ view: entry.view });
  } finally {
    rt.navigating = false;
  }
}

/** Adds a bottom-half tab to the opened set, keeping the array identity when it is already there. */
export function markPanelBottomOpened(list: PanelBottomTab[], tab: PanelBottomTab): PanelBottomTab[] {
  return list.includes(tab) ? list : [...list, tab];
}

/** Installs a restored split: every pane's transcript loads, the active one becomes the context. */
export async function applyLayout(rt: StoreRuntime, set: Setter, get: Getter, layout: PaneLayout): Promise<void> {
  const activeId = panes.activePane(layout).sessionId;
  set({ layout, activeId, view: 'chat' });
  pushHistory(rt, set, get, { view: 'chat', sessionId: activeId });
  await Promise.all(layout.panes.map((p) => (p.sessionId ? get().loadTranscript(p.sessionId) : undefined)));
}
