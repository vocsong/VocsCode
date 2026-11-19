/**
 * The conversation workspace's split layout: which session each pane shows and which pane is active.
 *
 * Pane state and session state are separate. A pane only names a session id; transcripts, drafts,
 * streaming and the agent process stay keyed by session in the store, so showing a session in a
 * pane never starts or duplicates anything. The store keeps `activeId` equal to the active pane's
 * session, which is how every global panel (Changes, Files, Git, Terminal…) follows the active pane.
 *
 * A file pane is the one exception: it previews a file beside the session it came from instead of
 * showing a session. It always sits last in the row, never becomes the active pane (so `activeId` and
 * every panel keep following a session), does not count toward MAX_PANES, is not remembered across a
 * restart, and closes when its session leaves the screen.
 *
 * Panes are a flat row (or column) today. A four-pane grid would nest two of these; the functions
 * here are pure so that change stays inside this module and its tests.
 */

export type PaneOrientation = 'horizontal' | 'vertical';
/** Where a new pane lands relative to the one it splits. */
export type PaneSide = 'before' | 'after';

/** What a file pane previews: one file in one session's folder. */
export interface FilePreviewTarget {
  /** The session whose folder holds the file; the pane closes when that session leaves the screen. */
  sessionId: string;
  /** Workspace-relative path, already checked to stay inside the session folder. */
  path: string;
  /** 1-based line to bring into view. */
  line?: number;
  /** An exact path (a Files row, a chosen match): read as is, without the shortened-name lookup. */
  exact?: boolean;
  /** Mission sessions: the workspace the file is read from; undefined is the integration result. */
  missionWorkspaceId?: string;
  /** Tells two opens of the same path apart, so clicking a link again reloads the file. */
  nonce: number;
}

export interface SessionPane {
  id: string;
  /** null while a freshly split pane is waiting for the user to pick a session, and on a file pane. */
  sessionId: string | null;
  /** Set on a file pane, which previews this file instead of showing a session. */
  file?: FilePreviewTarget;
}

export interface PaneLayout {
  /** horizontal: panes side by side; vertical: stacked. */
  orientation: PaneOrientation;
  panes: SessionPane[];
  activePaneId: string;
  /** Share of the container each pane takes, in pane order; sums to 1. */
  sizes: number[];
}

/** How many panes the workspace holds at once. Raising it is all a three-pane row needs. */
export const MAX_PANES = 2;
/** A pane is never dragged narrower or shorter than this. */
export const MIN_PANE_PX = { horizontal: 360, vertical: 200 } as const;
/** A file preview needs less room than a conversation with its composer. */
export const MIN_FILE_PANE_PX = { horizontal: 280, vertical: 160 } as const;

export function paneMinPx(pane: SessionPane | undefined, orientation: PaneOrientation): number {
  return (pane?.file ? MIN_FILE_PANE_PX : MIN_PANE_PX)[orientation];
}

let paneCounter = 0;
function nextPaneId(taken: SessionPane[]): string {
  let id: string;
  do id = `pane-${++paneCounter}`;
  while (taken.some((p) => p.id === id));
  return id;
}

function evenSizes(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n);
}

/** The layout everyone starts with: one pane, which is the app as it was before split view. */
export function singlePaneLayout(sessionId: string | null = null): PaneLayout {
  return { orientation: 'horizontal', panes: [{ id: 'pane-1', sessionId }], activePaneId: 'pane-1', sizes: [1] };
}

export function activePane(layout: PaneLayout): SessionPane {
  return layout.panes.find((p) => p.id === layout.activePaneId) ?? layout.panes.find((p) => !p.file) ?? layout.panes[0]!;
}

/** The panes that show a session or wait for one; a file pane rides alongside them. */
export function sessionPanes(layout: PaneLayout): SessionPane[] {
  return layout.panes.filter((p) => !p.file);
}

export function filePane(layout: PaneLayout): SessionPane | undefined {
  return layout.panes.find((p) => p.file);
}

/** A file pane always closes; a session pane only while another session pane remains. */
export function canClosePane(layout: PaneLayout, paneId: string): boolean {
  const pane = layout.panes.find((p) => p.id === paneId);
  return !!pane && (!!pane.file || sessionPanes(layout).length > 1);
}

/** The sessions actually on screen: every pane's, or only the active pane's when the split is too
 *  narrow to show the others (SessionPanes hides them then). Empty panes show no session. A narrow
 *  workspace with a file open shows the file, which is what the user just asked to see. */
export function visiblePaneSessions(layout: PaneLayout, narrow: boolean): string[] {
  if (narrow && filePane(layout)) return [];
  const shown = narrow ? [activePane(layout)] : layout.panes;
  return shown.flatMap((p) => (p.sessionId ? [p.sessionId] : []));
}

export function paneShowing(layout: PaneLayout, sessionId: string): SessionPane | undefined {
  return layout.panes.find((p) => p.sessionId === sessionId);
}

export function canSplit(layout: PaneLayout): boolean {
  return sessionPanes(layout).length < MAX_PANES;
}

/** Removes the given panes, keeping the others' shares in proportion. Never removes the active pane. */
function removePanes(layout: PaneLayout, ids: Set<string>): PaneLayout {
  const keep = layout.panes.map((p) => !ids.has(p.id));
  const panes = layout.panes.filter((_, i) => keep[i]);
  const sizes = layout.sizes.filter((_, i) => keep[i]);
  const total = sizes.reduce((a, b) => a + b, 0);
  return { ...layout, panes, sizes: total > 0 && sizes.length === panes.length ? sizes.map((s) => s / total) : evenSizes(panes.length) };
}

/** A file pane belongs beside its session: once that session is no longer on screen, it closes. */
function pruneFilePanes(layout: PaneLayout): PaneLayout {
  const shown = new Set(layout.panes.flatMap((p) => (p.sessionId ? [p.sessionId] : [])));
  const stale = layout.panes.filter((p) => p.file && !shown.has(p.file.sessionId));
  return stale.length ? removePanes(layout, new Set(stale.map((p) => p.id))) : layout;
}

/**
 * Previews a file in the split view. An open file pane switches to the new file; otherwise a new
 * one opens at the end of the row, beside the session it belongs to. The active pane stays where it
 * is, so the conversation keeps the keyboard and the panels. Without its session on screen there is
 * nothing to sit beside, so nothing opens.
 */
export function openFilePane(layout: PaneLayout, target: FilePreviewTarget): PaneLayout {
  if (!paneShowing(layout, target.sessionId)) return layout;
  const existing = filePane(layout);
  if (existing) return { ...layout, panes: layout.panes.map((p) => (p.id === existing.id ? { ...p, file: target } : p)) };
  const share = 1 / (layout.panes.length + 1);
  return {
    ...layout,
    // A lone session turns either way, and a preview reads best beside the conversation.
    orientation: sessionPanes(layout).length > 1 ? layout.orientation : 'horizontal',
    panes: [...layout.panes, { id: nextPaneId(layout.panes), sessionId: null, file: target }],
    sizes: [...layout.sizes.map((s) => s * (1 - share)), share]
  };
}

/**
 * Opens a session in the active pane, the way a sidebar click does. A session another pane already
 * shows is focused there instead, so one session never appears twice.
 */
export function openSession(layout: PaneLayout, sessionId: string | null): PaneLayout {
  if (sessionId) {
    const showing = paneShowing(layout, sessionId);
    if (showing) return showing.id === layout.activePaneId ? layout : { ...layout, activePaneId: showing.id };
  }
  const active = activePane(layout);
  if (active.sessionId === sessionId) return layout;
  return pruneFilePanes({ ...layout, panes: layout.panes.map((p) => (p.id === active.id ? { ...p, sessionId } : p)) });
}

/** Makes a session pane active. A file pane never is: the panels must keep following a session. */
export function focusPane(layout: PaneLayout, paneId: string): PaneLayout {
  const pane = layout.panes.find((p) => p.id === paneId);
  if (layout.activePaneId === paneId || !pane || pane.file) return layout;
  return { ...layout, activePaneId: paneId };
}

/**
 * Splits `paneId` and makes the new pane active. The new pane starts on `sessionId`, or empty so the
 * user can choose; a session already on screen is not opened a second time.
 */
export function splitPane(layout: PaneLayout, paneId: string, orientation: PaneOrientation, sessionId: string | null = null, side: PaneSide = 'after'): PaneLayout {
  const at = layout.panes.findIndex((p) => p.id === paneId);
  if (at < 0 || layout.panes[at]!.file || !canSplit(layout)) return layout;
  // A row cannot hold a column yet; a single session pane can turn either way, its file pane with it.
  if (sessionPanes(layout).length > 1 && orientation !== layout.orientation) return layout;
  if (sessionId && paneShowing(layout, sessionId)) return layout;
  const pane: SessionPane = { id: nextPaneId(layout.panes), sessionId };
  const panes = [...layout.panes];
  panes.splice(side === 'after' ? at + 1 : at, 0, pane);
  return { orientation, panes, activePaneId: pane.id, sizes: evenSizes(panes.length) };
}

/**
 * Removes a pane from the layout. The session it showed keeps running; the last session pane cannot
 * close, and a file pane goes with the session it belongs to.
 */
export function closePane(layout: PaneLayout, paneId: string): PaneLayout {
  if (!canClosePane(layout, paneId)) return layout;
  let activePaneId = layout.activePaneId;
  if (activePaneId === paneId) {
    const slots = sessionPanes(layout);
    const at = slots.findIndex((p) => p.id === paneId);
    activePaneId = (slots[at - 1] ?? slots.find((p) => p.id !== paneId))!.id;
  }
  return pruneFilePanes({ ...removePanes(layout, new Set([paneId])), activePaneId });
}

/**
 * A session dragged onto a pane: shown there. When another pane already shows it, the two panes
 * swap, which is how a drag moves a session from one side to the other.
 */
export function dropOnPane(layout: PaneLayout, paneId: string, sessionId: string): PaneLayout {
  const target = layout.panes.find((p) => p.id === paneId);
  if (!target) return layout;
  if (target.file) {
    // A session dropped on a preview takes the preview's place, as long as that adds no session pane.
    const showing = paneShowing(layout, sessionId);
    if (showing) return focusPane(layout, showing.id);
    if (!canSplit(layout)) return layout;
    return { ...layout, panes: layout.panes.map((p) => (p.id === target.id ? { id: p.id, sessionId } : p)), activePaneId: target.id };
  }
  if (target.sessionId === sessionId) return focusPane(layout, paneId);
  const source = paneShowing(layout, sessionId);
  const panes = layout.panes.map((p) => {
    if (p.id === target.id) return { ...p, sessionId };
    if (source && p.id === source.id) return { ...p, sessionId: target.sessionId };
    return p;
  });
  return pruneFilePanes({ ...layout, panes, activePaneId: target.id });
}

/** Sets the pane shares, normalised and clamped so no pane collapses to nothing. */
export function resizePanes(layout: PaneLayout, sizes: number[]): PaneLayout {
  if (sizes.length !== layout.panes.length || sizes.some((s) => !Number.isFinite(s) || s <= 0)) return layout;
  const total = sizes.reduce((a, b) => a + b, 0);
  const next = sizes.map((s) => Math.round((s / total) * 1000) / 1000);
  return next.every((s, i) => s === layout.sizes[i]) ? layout : { ...layout, sizes: next };
}

/**
 * Drops panes whose session left (deleted, archived, or no longer top level). An emptied pane closes
 * when another remains; the last pane takes `replacement` instead, which is the store's existing
 * "the active session went away" choice.
 */
export function withoutSessions(layout: PaneLayout, gone: (sessionId: string) => boolean, replacement: string | null): PaneLayout {
  let next = layout;
  for (const pane of layout.panes) {
    if (!pane.sessionId || !gone(pane.sessionId)) continue;
    if (sessionPanes(next).length > 1) next = closePane(next, pane.id);
    else next = { ...next, panes: next.panes.map((p) => (p.id === pane.id ? { ...p, sessionId: replacement } : p)) };
  }
  return pruneFilePanes(next);
}

/** The drag payload a sidebar session row carries, so a pane can tell it from a file drop. */
export const SESSION_DRAG_TYPE = 'application/x-vocs-session';

/** Where a session dropped on a pane goes: into it, or into a new pane on that edge. */
export type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom';

/** The outer quarter of each side splits; an edge that cannot split (full, or the wrong axis) replaces. */
export function dropZoneAt(layout: PaneLayout, rect: { left: number; top: number; width: number; height: number }, x: number, y: number): DropZone {
  if (!canSplit(layout) || rect.width <= 0 || rect.height <= 0) return 'center';
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  const single = sessionPanes(layout).length === 1;
  const horizontal = single || layout.orientation === 'horizontal';
  const vertical = single || layout.orientation === 'vertical';
  const edges: [DropZone, number, boolean][] = [['left', fx, horizontal], ['right', 1 - fx, horizontal], ['top', fy, vertical], ['bottom', 1 - fy, vertical]];
  const nearest = edges.filter(([, d, ok]) => ok && d < 0.25).sort((a, b) => a[1] - b[1])[0];
  return nearest ? nearest[0] : 'center';
}

/** The layout a drop produces; `layout` itself when the drop changes nothing. */
export function applyDrop(layout: PaneLayout, paneId: string, zone: DropZone, sessionId: string): PaneLayout {
  if (zone === 'center') return dropOnPane(layout, paneId, sessionId);
  // Splitting a pane with the session it already shows would put one session on screen twice.
  if (paneShowing(layout, sessionId)) return layout;
  const orientation: PaneOrientation = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical';
  return splitPane(layout, paneId, orientation, sessionId, zone === 'left' || zone === 'top' ? 'before' : 'after');
}

const STORAGE_KEY = 'vocs-code.sessionLayout';

/**
 * Reads a layout written by `saveLayout`. Anything malformed, or naming no session that still
 * exists, yields null so boot falls back to the single-pane start.
 */
export function restoreLayout(raw: string | null, exists: (sessionId: string) => boolean): PaneLayout | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const v = parsed as Partial<PaneLayout> | null;
  if (!v || (v.orientation !== 'horizontal' && v.orientation !== 'vertical') || !Array.isArray(v.panes)) return null;
  const seen = new Set<string>();
  const panes: SessionPane[] = [];
  const sizes: number[] = [];
  v.panes.forEach((p, i) => {
    if (!p || typeof p.id !== 'string' || typeof p.sessionId !== 'string' || seen.has(p.sessionId) || !exists(p.sessionId)) return;
    if (panes.length >= MAX_PANES || panes.some((x) => x.id === p.id)) return;
    seen.add(p.sessionId);
    panes.push({ id: p.id, sessionId: p.sessionId });
    const size = Array.isArray(v.sizes) ? v.sizes[i] : undefined;
    sizes.push(typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 1);
  });
  if (panes.length === 0) return null;
  const activePaneId = panes.some((p) => p.id === v.activePaneId) ? v.activePaneId! : panes[0]!.id;
  const total = sizes.reduce((a, b) => a + b, 0);
  return { orientation: v.orientation, panes, activePaneId, sizes: sizes.map((s) => s / total) };
}

/** Remembers a split for the next launch; a single pane leaves nothing behind, so boot stays as it was.
 *  A file pane is never remembered: its sessionId is null, so it drops out with the empty panes. */
export function saveLayout(layout: PaneLayout, storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = globalThis.localStorage): void {
  if (!storage) return;
  try {
    const panes = layout.panes.filter((p) => p.sessionId);
    if (panes.length < 2) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify({ ...layout, panes, sizes: layout.panes.map((p, i) => (p.sessionId ? layout.sizes[i] : null)).filter((s) => s !== null) }));
  } catch {
    // A full or disabled storage only costs the restore on next launch.
  }
}

export function loadStoredLayout(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): string | null {
  try {
    return storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** The composer of the active pane; with one pane, the only composer. */
export function activeComposer(): HTMLTextAreaElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLTextAreaElement>('.pane.active .composer textarea') ?? document.querySelector<HTMLTextAreaElement>('.composer textarea');
}
