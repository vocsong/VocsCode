/**
 * The conversation workspace's split layout: which session each pane shows and which pane is active.
 *
 * Pane state and session state are separate. A pane only names a session id; transcripts, drafts,
 * streaming and the agent process stay keyed by session in the store, so showing a session in a
 * pane never starts or duplicates anything. The store keeps `activeId` equal to the active pane's
 * session, which is how every global panel (Changes, Files, Git, Terminal…) follows the active pane.
 *
 * Panes are a flat row (or column) today. A four-pane grid would nest two of these; the functions
 * here are pure so that change stays inside this module and its tests.
 */

export type PaneOrientation = 'horizontal' | 'vertical';
/** Where a new pane lands relative to the one it splits. */
export type PaneSide = 'before' | 'after';

export interface SessionPane {
  id: string;
  /** null while a freshly split pane is waiting for the user to pick a session. */
  sessionId: string | null;
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
  return layout.panes.find((p) => p.id === layout.activePaneId) ?? layout.panes[0]!;
}

export function paneShowing(layout: PaneLayout, sessionId: string): SessionPane | undefined {
  return layout.panes.find((p) => p.sessionId === sessionId);
}

export function canSplit(layout: PaneLayout): boolean {
  return layout.panes.length < MAX_PANES;
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
  return { ...layout, panes: layout.panes.map((p) => (p.id === active.id ? { ...p, sessionId } : p)) };
}

export function focusPane(layout: PaneLayout, paneId: string): PaneLayout {
  if (layout.activePaneId === paneId || !layout.panes.some((p) => p.id === paneId)) return layout;
  return { ...layout, activePaneId: paneId };
}

/**
 * Splits `paneId` and makes the new pane active. The new pane starts on `sessionId`, or empty so the
 * user can choose; a session already on screen is not opened a second time.
 */
export function splitPane(layout: PaneLayout, paneId: string, orientation: PaneOrientation, sessionId: string | null = null, side: PaneSide = 'after'): PaneLayout {
  const at = layout.panes.findIndex((p) => p.id === paneId);
  if (at < 0 || !canSplit(layout)) return layout;
  // A row cannot hold a column yet; a single pane can turn either way.
  if (layout.panes.length > 1 && orientation !== layout.orientation) return layout;
  if (sessionId && paneShowing(layout, sessionId)) return layout;
  const pane: SessionPane = { id: nextPaneId(layout.panes), sessionId };
  const panes = [...layout.panes];
  panes.splice(side === 'after' ? at + 1 : at, 0, pane);
  return { orientation, panes, activePaneId: pane.id, sizes: evenSizes(panes.length) };
}

/** Removes a pane from the layout. The session it showed keeps running; the last pane cannot close. */
export function closePane(layout: PaneLayout, paneId: string): PaneLayout {
  const at = layout.panes.findIndex((p) => p.id === paneId);
  if (at < 0 || layout.panes.length <= 1) return layout;
  const panes = layout.panes.filter((p) => p.id !== paneId);
  const sizes = layout.sizes.filter((_, i) => i !== at);
  const total = sizes.reduce((a, b) => a + b, 0);
  const activePaneId = layout.activePaneId === paneId ? panes[Math.max(0, at - 1)]!.id : layout.activePaneId;
  return { ...layout, panes, activePaneId, sizes: total > 0 && sizes.length === panes.length ? sizes.map((s) => s / total) : evenSizes(panes.length) };
}

/**
 * A session dragged onto a pane: shown there. When another pane already shows it, the two panes
 * swap, which is how a drag moves a session from one side to the other.
 */
export function dropOnPane(layout: PaneLayout, paneId: string, sessionId: string): PaneLayout {
  const target = layout.panes.find((p) => p.id === paneId);
  if (!target) return layout;
  if (target.sessionId === sessionId) return focusPane(layout, paneId);
  const source = paneShowing(layout, sessionId);
  const panes = layout.panes.map((p) => {
    if (p.id === target.id) return { ...p, sessionId };
    if (source && p.id === source.id) return { ...p, sessionId: target.sessionId };
    return p;
  });
  return { ...layout, panes, activePaneId: target.id };
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
    if (next.panes.length > 1) next = closePane(next, pane.id);
    else next = { ...next, panes: next.panes.map((p) => (p.id === pane.id ? { ...p, sessionId: replacement } : p)) };
  }
  return next;
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
  const horizontal = layout.panes.length === 1 || layout.orientation === 'horizontal';
  const vertical = layout.panes.length === 1 || layout.orientation === 'vertical';
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

/** Remembers a split for the next launch; a single pane leaves nothing behind, so boot stays as it was. */
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
