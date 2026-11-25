/**
 * Pure sidebar grouping, ordering, and keyboard-navigation helpers.
 * Keeps rendered folder groups and Ctrl+Arrow / Ctrl+Shift+Arrow navigation on one shared model.
 */
import type { AppSettings, SessionMeta, SidebarView } from '../../../../shared/types';
import { basename } from '../../format';
import { nestMissionRows, sortSessionRows } from '../../sessionOrder';

export { sortSessionRows };

/** One folder in sidebar display order, with its non-archived session ids in row order. */
export interface SidebarNavFolder {
  root: string;
  sessionIds: string[];
}

export interface SidebarFolderGroup {
  root: string;
  list: SessionMeta[];
}

/** The sidebar's list layout; anything but an explicit `recent` is the folder-grouped default. */
export const sidebarViewOf = (settings: AppSettings | null): SidebarView => (settings?.sidebarView === 'recent' ? 'recent' : 'folders');

/**
 * Group sessions by `projectRoot`, optionally include empty remembered folders, and sort folders
 * by saved `folderOrder` (with unpositioned folders alphabetically after positioned ones).
 */
export function groupSidebarFolders(
  visible: SessionMeta[],
  opts: { folders?: readonly string[]; folderOrder?: readonly string[]; includeEmptyFolders: boolean }
): SidebarFolderGroup[] {
  const byProject = new Map<string, SessionMeta[]>();
  for (const s of visible) {
    const key = s.config.projectRoot;
    const bucket = byProject.get(key);
    if (bucket) bucket.push(s);
    else byProject.set(key, [s]);
  }
  const groups: SidebarFolderGroup[] = [...byProject.entries()].map(([root, list]) => ({
    root,
    list: nestMissionRows(sortSessionRows(list))
  }));
  if (opts.includeEmptyFolders) {
    // A folder whose last active session was archived or deleted stays listed so a new
    // session can still be added to it.
    for (const root of opts.folders ?? []) {
      if (!byProject.has(root)) groups.push({ root, list: [] });
    }
  }
  // Positioning is persistent: folders follow the manually saved order and stay put no
  // matter which session was active last. Folders never positioned sort alphabetically
  // after the positioned ones.
  const order = opts.folderOrder ?? [];
  const pos = (root: string) => {
    const i = order.indexOf(root);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  groups.sort((a, b) => pos(a.root) - pos(b.root) || basename(a.root).localeCompare(basename(b.root)));
  return groups;
}

/**
 * The Recent view as nav entries: one flat recency order (sortSessionRows over every folder),
 * cut into runs of consecutive rows from the same folder, so Ctrl+Shift+Arrow jumps to the next
 * row that belongs to a different folder.
 */
function recentNavModel(visible: SessionMeta[]): SidebarNavFolder[] {
  const runs: SidebarNavFolder[] = [];
  for (const s of nestMissionRows(sortSessionRows(visible))) {
    const last = runs[runs.length - 1];
    if (last?.root === s.config.projectRoot) last.sessionIds.push(s.id);
    else runs.push({ root: s.config.projectRoot, sessionIds: [s.id] });
  }
  return runs;
}

/**
 * Sidebar display order mirrored as a pure model so keyboard navigation (Ctrl+Arrow) matches what
 * the sidebar renders: folders by saved order with sessions by sortSessionRows, or — in the Recent
 * view — one recency order across folders. Always reflects non-archived sessions, no search filter.
 */
export function sidebarNavModel(sessions: SessionMeta[], settings: AppSettings | null): SidebarNavFolder[] {
  const visible = sessions.filter((s) => !s.archived);
  if (sidebarViewOf(settings) === 'recent') return recentNavModel(visible);
  return groupSidebarFolders(visible, {
    folders: settings?.folders,
    folderOrder: settings?.folderOrder,
    includeEmptyFolders: true
  }).map((g) => ({ root: g.root, sessionIds: g.list.map((s) => s.id) }));
}

/** Flat session rows in visual order across all folders. */
function flatRows(model: SidebarNavFolder[]): { sessionId: string; root: string }[] {
  return model.flatMap((f) => f.sessionIds.map((sessionId) => ({ sessionId, root: f.root })));
}

/** Ctrl+Arrow: the session visually above/below the active one, wrapping at the ends. */
export function nextSessionTarget(model: SidebarNavFolder[], activeId: string | null, down: boolean): { sessionId: string; root: string } | null {
  const rows = flatRows(model);
  if (rows.length === 0) return null;
  const at = rows.findIndex((r) => r.sessionId === activeId);
  if (at === -1) return down ? rows[0] : rows[rows.length - 1];
  return rows[(at + (down ? 1 : -1) + rows.length) % rows.length];
}

/**
 * Ctrl+Shift+Arrow: the first session of the folder below/above the active one, wrapping at the
 * ends. Folders with no sessions are skipped (there is nothing to select in them).
 */
export function nextFolderTarget(model: SidebarNavFolder[], activeId: string | null, down: boolean): { sessionId: string; root: string } | null {
  const withSessions = model.filter((f) => f.sessionIds.length > 0);
  if (withSessions.length === 0) return null;
  const at = withSessions.findIndex((f) => f.sessionIds.includes(activeId ?? ''));
  if (at === -1) return { sessionId: withSessions[0].sessionIds[0], root: withSessions[0].root };
  const folder = withSessions[(at + (down ? 1 : -1) + withSessions.length) % withSessions.length];
  return { sessionId: folder.sessionIds[0], root: folder.root };
}
