/** Session list grouped by project, with live status badges per harness. */
import React, { useMemo, useRef, useState } from 'react';
import type { AppSettings, SessionMeta } from '../../../shared/types';
import { HARNESS_BY_ID } from '../../../shared/harness-meta';
import { invoke } from '../api';
import { basename, fmtCost, harnessShort, relTime } from '../format';
import { archiveSession } from '../sessionActions';
import { useStore } from '../store';
import { Resizer } from './Resizer';
import { FolderBranch } from './FolderBranch';
import { ForkIntoDropdown } from './ForkInto';
import { askConfirm, Badge, Button, Dropdown, Icon, MenuItem, STATUS_LABELS, StatusLabel } from './ui';

const HARNESS_TONE: Record<string, 'blue' | 'green' | 'amber' | 'purple' | 'neutral' | 'red'> = {
  claude: 'amber',
  codex: 'green',
  'codex-exec': 'green',
  cursor: 'blue',
  pi: 'purple',
  acp: 'blue',
  native: 'neutral'
};

/** Icon choices for folder headers (names from the renderer icon set). */
const FOLDER_ICONS = [
  'folder', 'bolt', 'brain', 'shield', 'star', 'sparkles', 'target', 'branch', 'terminal', 'chart',
  'play', 'file', 'code', 'bug', 'wrench', 'rocket', 'globe', 'lock', 'key', 'cpu',
  'database', 'cloud', 'fire', 'cube', 'layers', 'box', 'flag', 'bulb', 'link', 'map',
  'moon', 'sun', 'palette', 'puzzle', 'robot', 'server', 'tag', 'heart', 'home', 'book',
  'mail', 'bell', 'coffee', 'music', 'camera', 'video', 'gamepad', 'leaf', 'compass', 'gift'
] as const;
/** Swatch palette for folder headers. */
const FOLDER_COLORS = [
  '#5b9bf8', '#2563eb', '#0ea5e9', '#22d3ee', '#2dd4bf', '#34d399', '#4ade80', '#84cc16',
  '#a3e635', '#fbbf24', '#facc15', '#fb923c', '#f97316', '#f87171', '#ef4444', '#fb7185',
  '#f472b6', '#e879f9', '#c084fc', '#a78bfa', '#818cf8', '#94a3b8', '#64748b', '#e2e8f0'
] as const;

/** Drag state for reordering the pinned section of one folder. */
interface DndState {
  dragId: string | null;
  overId: string | null;
  pos: 'before' | 'after';
}
const DND_CLEAR: DndState = { dragId: null, overId: null, pos: 'before' };

/** Pinned rows sort to the top by pin stamp (first pin on top); the rest stay in recency order. */
function pinRank(s: SessionMeta): number {
  return s.pinned ? (s.pinnedAt ?? s.createdAt) : Number.POSITIVE_INFINITY;
}

/** Canonical display order for one folder's session list. */
export function sortSessionRows(list: SessionMeta[]): SessionMeta[] {
  return [...list].sort((a, b) => pinRank(a) - pinRank(b) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

/** One folder in sidebar display order, with its non-archived session ids in row order. */
export interface SidebarNavFolder {
  root: string;
  sessionIds: string[];
}

/**
 * Sidebar display order (folders by saved order, sessions by sortSessionRows) mirrored as a pure
 * model so keyboard navigation (Ctrl+Arrow) matches what the sidebar renders. Always reflects the
 * default view: non-archived sessions, no search filter.
 */
export function sidebarNavModel(sessions: SessionMeta[], settings: AppSettings | null): SidebarNavFolder[] {
  const visible = sessions.filter((s) => !s.archived);
  const byProject = new Map<string, SessionMeta[]>();
  for (const s of visible) byProject.set(s.config.projectRoot, [...(byProject.get(s.config.projectRoot) ?? []), s]);
  const model = [...byProject.entries()].map(([root, list]) => ({
    root,
    sessionIds: sortSessionRows(list).map((s) => s.id)
  }));
  for (const root of settings?.folders ?? []) {
    if (!byProject.has(root)) model.push({ root, sessionIds: [] });
  }
  const order = settings?.folderOrder ?? [];
  const pos = (root: string) => {
    const i = order.indexOf(root);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  model.sort((a, b) => pos(a.root) - pos(b.root) || basename(a.root).localeCompare(basename(b.root)));
  return model;
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

/** Built-in status labels offered in the picker; user-added labels extend these via settings. */
const STATUS_LABEL_CHOICES = ['Idle', 'Starting', 'Working', 'Awaiting', 'Error', 'Stopped', 'PR', 'Merged', 'Todo'];

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const settings = useStore((s) => s.settings);
  const activeId = useStore((s) => s.activeId);
  const setActive = useStore((s) => s.setActive);
  const startNewSession = useStore((s) => s.startNewSession);
  const setView = useStore((s) => s.setView);
  const view = useStore((s) => s.view);
  const toast = useStore((s) => s.toast);
  const [showArchived, setShowArchived] = useState(false);
  // Drag-to-reorder state: which folder block is being dragged, and where it currently hovers.
  const [drag, setDrag] = useState<{ root: string; over: string | null; after: boolean } | null>(null);

  const groups = useMemo(() => {
    const visible = sessions.filter((s) => (showArchived ? s.archived : !s.archived));
    const byProject = new Map<string, SessionMeta[]>();
    for (const s of visible) {
      const key = s.config.projectRoot;
      byProject.set(key, [...(byProject.get(key) ?? []), s]);
    }
    const groups = [...byProject.entries()].map(([root, list]) => ({
      root,
      list: sortSessionRows(list)
    }));
    if (!showArchived) {
      // A folder whose last active session was archived or deleted stays listed so a new
      // session can still be added to it.
      const empties = (settings?.folders ?? [])
        .filter((root) => !byProject.has(root))
        .map((root) => ({ root, list: [] as SessionMeta[] }));
      groups.push(...empties);
    }
    // Positioning is persistent: folders follow the manually saved order and stay put no
    // matter which session was active last. Folders never positioned sort alphabetically
    // after the positioned ones.
    const order = settings?.folderOrder ?? [];
    const pos = (root: string) => {
      const i = order.indexOf(root);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    groups.sort((a, b) => pos(a.root) - pos(b.root) || basename(a.root).localeCompare(basename(b.root)));
    return groups;
  }, [sessions, settings, showArchived]);

  const folderStyles = settings?.folderStyles ?? {};
  const collapsed = settings?.collapsedFolders ?? [];

  const toggleCollapsed = (root: string) => {
    const cur = settings?.collapsedFolders ?? [];
    const next = cur.includes(root) ? cur.filter((r) => r !== root) : [...cur, root];
    void invoke('settings:update', { collapsedFolders: next });
  };

  /** Persist a drop of `from` next to `to` (before or after, by drop edge). */
  const commitOrder = (from: string, to: string, after: boolean) => {
    const roots = groups.map((g) => g.root);
    const fromIdx = roots.indexOf(from);
    const toBase = roots.indexOf(to);
    if (from === to || fromIdx === -1 || toBase === -1) return;
    roots.splice(fromIdx, 1);
    const toIdx = roots.indexOf(to);
    if (toIdx === -1) return;
    roots.splice(after ? toIdx + 1 : toIdx, 0, from);
    void invoke('settings:update', { folderOrder: roots });
  };

  const onDragStart = (e: React.DragEvent, root: string) => {
    e.dataTransfer.effectAllowed = 'move';
    // Firefox needs some payload before it will start a drag at all.
    e.dataTransfer.setData('text/plain', root);
    setDrag({ root, over: null, after: false });
  };
  const onDragOverGroup = (e: React.DragEvent, root: string) => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    if (drag.over !== root || drag.after !== after) setDrag({ ...drag, over: root, after });
  };
  const onDropGroup = (e: React.DragEvent, root: string) => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    if (root !== drag.root) commitOrder(drag.root, root, drag.after);
    setDrag(null);
  };

  // Pinned-section drag reorder: only pinned rows of the same folder accept a drop.
  const [dnd, setDnd] = useState<DndState>(DND_CLEAR);
  const dndRef = useRef(dnd);
  dndRef.current = dnd;
  const onDragStartRow = (id: string) => setDnd({ dragId: id, overId: null, pos: 'before' });
  const onDragEndRow = () => setDnd(DND_CLEAR);
  const onDragOverRow = (id: string, e: React.DragEvent<HTMLElement>) => {
    const { dragId } = dndRef.current;
    const dragged = dragId ? sessions.find((x) => x.id === dragId) : null;
    const target = sessions.find((x) => x.id === id);
    if (!dragged || !target?.pinned || target.id === dragId || target.config.projectRoot !== dragged.config.projectRoot) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    setDnd((d) => (d.overId === id && d.pos === pos ? d : { ...d, overId: id, pos }));
  };
  const onDragLeaveRow = (id: string, e: React.DragEvent<HTMLElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setDnd((d) => (d.overId === id ? { ...d, overId: null, pos: 'before' } : d));
  };
  const onDropRow = (id: string) => {
    const { dragId, pos } = dndRef.current;
    const dragged = dragId ? sessions.find((x) => x.id === dragId) : null;
    const target = sessions.find((x) => x.id === id);
    if (dragged && target && target.pinned && target.id !== dragId && target.config.projectRoot === dragged.config.projectRoot) {
      const section = sortSessionRows(sessions.filter((x) => x.config.projectRoot === target.config.projectRoot && !x.archived))
        .filter((x) => x.pinned)
        .map((x) => x.id);
      const rest = section.filter((sid) => sid !== dragId);
      const at = rest.indexOf(id);
      if (at >= 0) {
        const at2 = pos === 'before' ? at : at + 1;
        const next = [...rest.slice(0, at2), dragId!, ...rest.slice(at2)];
        if (next.some((sid, i) => sid !== section[i])) void invoke('sessions:pinOrder', { ids: next });
      }
    }
    setDnd(DND_CLEAR);
  };
  const dndHandlers = { start: onDragStartRow, end: onDragEndRow, over: onDragOverRow, leave: onDragLeaveRow, drop: onDropRow };

  const awaiting = sessions.filter((s) => s.status === 'awaiting').length;
  const running = sessions.filter((s) => s.status === 'running').length;

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">
          <Icon name="logo" size={22} />
          <span>Vocs Code</span>
        </div>
        <div className="sidebar-top-actions">
          <Button variant="ghost" size="sm" icon="search" className="btn-icon" onClick={() => useStore.getState().openSearch(true)} title="Search sessions (Ctrl+Shift+F)" aria-label="Search sessions" />
          <Button variant="ghost" size="sm" icon="plus" className="btn-icon" onClick={() => void startNewSession()} title="New folder (Ctrl+N)" aria-label="New folder" />
        </div>
      </div>
      {(awaiting > 0 || running > 0) && (
        <div className="sidebar-summary">
          {awaiting > 0 && <Badge tone="red">{awaiting} awaiting approval</Badge>}
          {running > 0 && <Badge tone="blue">{running} running</Badge>}
        </div>
      )}
      <div
        className="sidebar-list"
        onDragOver={(e) => {
          // Only the empty space below the last group lands here (group handlers stop
          // propagation); treat it as "move to the end".
          if (!drag) return;
          e.preventDefault();
          const last = groups[groups.length - 1];
          if (last && (drag.over !== last.root || !drag.after)) setDrag({ ...drag, over: last.root, after: true });
        }}
        onDrop={(e) => {
          if (!drag) return;
          e.preventDefault();
          if (drag.over && drag.over !== drag.root) commitOrder(drag.root, drag.over, drag.after);
          setDrag(null);
        }}
      >
        {groups.length === 0 && <div className="sidebar-empty">{showArchived ? 'No archived sessions.' : 'No sessions yet. Create one to start.'}</div>}
        {groups.map((g) => {
          const isCollapsed = collapsed.includes(g.root);
          const dropMark = drag && drag.over === g.root && drag.root !== g.root ? (drag.after ? 'drop-after' : 'drop-before') : '';
          return (
            <div
              key={g.root}
              className={`project-group ${drag?.root === g.root ? 'dragging' : ''} ${dropMark}`}
              onDragOver={(e) => onDragOverGroup(e, g.root)}
              onDrop={(e) => onDropGroup(e, g.root)}
            >
              <div
                className="project-header"
                title={g.root}
                draggable
                onDragStart={(e) => onDragStart(e, g.root)}
                onDragEnd={() => setDrag(null)}
              >
                <button
                  type="button"
                  className="project-fold-btn"
                  title={isCollapsed ? 'Expand folder' : 'Collapse folder'}
                  aria-label={isCollapsed ? `Expand ${basename(g.root)}` : `Collapse ${basename(g.root)}`}
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleCollapsed(g.root)}
                >
                  <Icon name={isCollapsed ? 'chevronRight' : 'chevron'} size={12} />
                </button>
                <FolderStyleButton root={g.root} style={folderStyles[g.root]} onPick={(patch) => {
                const next = { ...folderStyles };
                if (patch) next[g.root] = { ...next[g.root], ...patch };
                else delete next[g.root];
                void invoke('settings:update', { folderStyles: next });
              }} />
              <button
                type="button"
                className={`project-title ${folderStyles[g.root]?.color ? 'colored' : ''}`}
                style={folderStyles[g.root]?.color ? { color: folderStyles[g.root].color } : undefined}
                title={isCollapsed ? 'Expand folder' : 'Collapse folder'}
                onClick={() => toggleCollapsed(g.root)}
              >
                {basename(g.root)}
              </button>
              {isCollapsed && g.list.length > 0 && <span className="project-count">{g.list.length}</span>}
              <FolderBranch root={g.root} expanded={!isCollapsed} />
              <button
                type="button"
                className="project-new-btn"
                title={`New session in ${basename(g.root)}`}
                aria-label={`New session in ${basename(g.root)}`}
                onClick={() => void startNewSession(g.root)}
              >
                <Icon name="plus" size={13} />
              </button>
              </div>
              {!isCollapsed && g.list.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={s.id === activeId && view === 'chat'}
                  customLabels={settings?.customLabels ?? []}
                  onSelect={() => void setActive(s.id)}
                  toast={toast}
                  dnd={dnd}
                  dndHandlers={dndHandlers}
                />
              ))}
            </div>
          );
        })}
      </div>
      <div className="sidebar-bottom">
        <button type="button" className={`sidebar-link ${showArchived ? 'active' : ''}`} onClick={() => setShowArchived((v) => !v)}>
          <Icon name="clock" size={14} /> {showArchived ? 'Show active' : 'Archived'}
        </button>
        <button type="button" className={`sidebar-link ${view === 'analytics' ? 'active' : ''}`} onClick={() => setView('analytics')}>
          <Icon name="chart" size={14} /> Analytics
        </button>
        <button type="button" className={`sidebar-link ${view === 'skills' ? 'active' : ''}`} onClick={() => setView('skills')}>
          <Icon name="puzzle" size={14} /> Skills
        </button>
        <button type="button" className={`sidebar-link ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}>
          <Icon name="settings" size={14} /> Settings
        </button>
      </div>
      <Resizer target="sidebar" />
    </aside>
  );
}

type DndHandlers = {
  start: (id: string) => void;
  end: () => void;
  over: (id: string, e: React.DragEvent<HTMLElement>) => void;
  leave: (id: string, e: React.DragEvent<HTMLElement>) => void;
  drop: (id: string) => void;
};

function SessionRow({ session: s, active, customLabels, onSelect, toast, dnd, dndHandlers }: {
  session: SessionMeta;
  active: boolean;
  customLabels: string[];
  onSelect: () => void;
  toast: (t: string, k?: 'info' | 'success' | 'error') => void;
  dnd: DndState;
  dndHandlers: DndHandlers;
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(s.title);
  const h = HARNESS_BY_ID[s.config.harness];
  const startRename = () => {
    setTitle(s.title);
    setRenaming(true);
  };
  const commit = async () => {
    setRenaming(false);
    if (title.trim() && title !== s.title) await invoke('sessions:rename', { id: s.id, title: title.trim() });
  };
  const deleteRow = async () => {
    const ok = await askConfirm({
      title: `Delete session "${s.title}"?`,
      body: s.worktreeBranch ? `Its worktree and the branch ${s.worktreeBranch} are removed with it.` : 'Its transcript is removed. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true
    });
    if (ok) void invoke('sessions:delete', { id: s.id, removeWorktree: !!s.worktreeBranch });
  };
  // Picking the label that names the current status resets to auto instead of labeling it red.
  // The pick must never fail silently: an error that swallows here loses the label on restart
  // with no trace, so surface it as a toast.
  const setStatusLabel = async (label?: string, nextCustom?: string[]) => {
    const picked = label && STATUS_LABELS[s.status] === label ? undefined : label;
    try {
      await invoke('sessions:label', { id: s.id, label: picked });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
    if (nextCustom) void invoke('settings:update', { customLabels: nextCustom });
  };
  // Only pinned rows can be dragged, and only while they are not being renamed.
  const canDrag = !!s.pinned && !s.archived && !renaming;
  const dragClass = dnd.dragId === s.id ? ' dragging' : '';
  const indicator = dnd.overId === s.id && dnd.dragId && dnd.dragId !== s.id ? (dnd.pos === 'before' ? ' drag-above' : ' drag-below') : '';
  return (
    <div
      className={`session-row ${active ? 'active' : ''}${dragClass}${indicator}`}
      data-session-id={s.id}
      draggable={canDrag}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', s.id);
        dndHandlers.start(s.id);
      }}
      onDragEnd={dndHandlers.end}
      onDragOver={(e) => dndHandlers.over(s.id, e)}
      onDragLeave={(e) => dndHandlers.leave(s.id, e)}
      onDrop={(e) => dndHandlers.drop(s.id)}
      onClick={onSelect}
      onDoubleClick={startRename}
    >
      <div className="session-main">
        {renaming ? (
          <input
            className="session-rename"
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit();
              if (e.key === 'Escape') setRenaming(false);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div className="session-title">
            {s.pinned && <Icon name="pin" size={11} />}
            <span title="Click to rename" onClick={(e) => { e.stopPropagation(); startRename(); }}>{s.title}</span>
          </div>
        )}
        <div className="session-meta">
          <Badge tone={HARNESS_TONE[s.config.harness]} title={h?.name}>
            {harnessShort(s.config.harness)}
          </Badge>
          {s.activeModel && <span className="session-model" title={`${s.activeModel.provider}/${s.activeModel.model}`}>{s.activeModel.model}</span>}
          {s.usage.costUsd > 0 && <span className="session-cost">{fmtCost(s.usage.costUsd)}</span>}
          {s.worktreeBranch && (
            <span className="session-worktree" title={`Worktree · ${s.worktreeBranch}`}>
              <Icon name="branch" size={12} />
              <span className="session-worktree-name">{s.worktreeBranch}</span>
            </span>
          )}
          {(s.queued ?? 0) > 0 && <span className="session-queued">+{s.queued}</span>}
        </div>
      </div>
      {/* Time clicks must bubble to the row so they select the session; only the status pill swallows them. */}
      <div className="session-side">
        <div onClick={(e) => e.stopPropagation()}>
          <Dropdown align="right" width={200} trigger={() => <StatusLabel status={s.status} label={s.statusLabel} />}>
            {(close) => <StatusLabelPicker session={s} customLabels={customLabels} onPick={setStatusLabel} close={close} />}
          </Dropdown>
        </div>
        <span className="session-time">{relTime(s.updatedAt)}</span>
      </div>
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        {s.archived ? (
          <>
            <button type="button" className="row-act-btn" title="Restore session" aria-label="Restore session" onClick={() => void invoke('sessions:archive', { id: s.id, archived: false })}>
              <Icon name="restore" size={15} />
            </button>
            <button type="button" className="row-act-btn danger" title="Delete session" aria-label="Delete session" onClick={() => void deleteRow()}>
              <Icon name="trash" size={15} />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={`row-act-btn ${s.pinned ? 'is-pinned' : ''}`}
              title={s.pinned ? 'Unpin' : 'Pin to top'}
              aria-label={s.pinned ? 'Unpin session' : 'Pin session'}
              onClick={() => void invoke('sessions:pin', { id: s.id, pinned: !s.pinned })}
            >
              <Icon name="pin" size={15} />
            </button>
            <ForkIntoDropdown session={s} />
            <button type="button" className="row-act-btn" title={s.worktreeBranch ? 'Archive & remove worktree' : 'Archive'} aria-label="Archive session" onClick={() => void archiveSession(s, toast)}>
              <Icon name="archive" size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Status-label picker: built-in choices, user-added labels, an add field, and a reset. */
function StatusLabelPicker({ session: s, customLabels, onPick, close }: { session: SessionMeta; customLabels: string[]; onPick: (label?: string, nextCustom?: string[]) => void; close: () => void }) {
  const [draft, setDraft] = useState('');
  const extras = customLabels.filter((l) => !STATUS_LABEL_CHOICES.some((c) => c.toLowerCase() === l.toLowerCase()));
  const add = () => {
    const label = draft.trim().slice(0, 24);
    if (!label) return;
    onPick(label, [...customLabels, label].filter((l, i, all) => all.findIndex((x) => x.toLowerCase() === l.toLowerCase()) === i).slice(0, 30));
    setDraft('');
    close();
  };
  return (
    <div className="status-label-picker">
      {[...STATUS_LABEL_CHOICES, ...extras].map((label) => (
        <MenuItem key={label} active={s.statusLabel === label} onClick={() => { onPick(label); close(); }}>{label}</MenuItem>
      ))}
      <div className="status-label-add">
        <input
          placeholder="Add label"
          value={draft}
          maxLength={24}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
        />
        <Button size="sm" variant="ghost" icon="plus" aria-label="Add label" onClick={add} />
      </div>
      {s.statusLabel && <MenuItem onClick={() => { onPick(undefined); close(); }}>Reset to status</MenuItem>}
    </div>
  );
}

/** Folder icon button opening a popover to pick the folder's icon and color. */
function FolderStyleButton({ root, style, onPick }: { root: string; style?: { color?: string; icon?: string }; onPick: (patch?: { color?: string; icon?: string }) => void }) {
  const name = basename(root);
  return (
    <Dropdown align="left" width={240} trigger={() => (
      <button
        type="button"
        className="project-icon-btn"
        style={style?.color ? { color: style.color } : undefined}
        title={`Customize ${name}`}
        aria-label={`Customize ${name}`}
      >
        <Icon name={style?.icon ?? 'folder'} size={13} />
      </button>
    )}>
      {() => (
        <div className="folder-style-picker">
          <div className="picker-label">Icon</div>
          <div className="picker-grid">
            {FOLDER_ICONS.map((n) => (
              <button
                key={n}
                type="button"
                className={`picker-opt ${style?.icon === n ? 'active' : ''}`}
                title={n}
                aria-label={`Icon ${n}`}
                onClick={() => onPick({ icon: n })}
              >
                <Icon name={n} size={14} />
              </button>
            ))}
          </div>
          <div className="picker-label">Color</div>
          <div className="picker-grid">
            {FOLDER_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`picker-swatch ${style?.color === c ? 'active' : ''}`}
                style={{ background: c }}
                title={c}
                aria-label={`Color ${c}`}
                onClick={() => onPick({ color: c })}
              />
            ))}
          </div>
          <MenuItem onClick={() => onPick(undefined)}>Reset to default</MenuItem>
        </div>
      )}
    </Dropdown>
  );
}
