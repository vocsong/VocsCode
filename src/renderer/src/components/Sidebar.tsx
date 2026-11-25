/** Session list grouped by project, with live status badges per harness. */
import React, { useCallback, useMemo, useState } from 'react';
import type { FolderStyle, SessionMeta, SidebarView } from '../../../shared/types';
import { hasOngoingWork } from '../../../shared/ongoing';
import { invoke, modKey } from '../api';
import { basename } from '../format';
import { removeFolder } from '../sessionActions';
import { activitySections } from '../activity';
import { nestMissionRows, sortSessionRows } from '../sessionOrder';
import { useStore, toastError } from '../store';
import { useMinimalUi } from '../ui-mode';
import { Resizer } from './Resizer';
import { showContextMenu, type ContextMenuItem } from './ContextMenu';
import { FolderBranch } from './FolderBranch';
import { ActivityMenu } from './ActivityTray';
import { Badge, Button, Icon } from './ui';
import { groupSidebarFolders, nextFolderTarget, nextSessionTarget, sidebarNavModel, sidebarViewOf, type SidebarNavFolder } from './sidebar/nav';
import { SessionRow } from './sidebar/SessionRow';
import { FolderStyleButton, UpdatePill } from './sidebar/SidebarPickers';
import { useSidebarDnd } from './sidebar/useSidebarDnd';

export { nextFolderTarget, nextSessionTarget, sidebarNavModel, sidebarViewOf, sortSessionRows, type SidebarNavFolder };

const EMPTY_STRINGS: string[] = [];
const EMPTY_FOLDER_STYLES: Record<string, FolderStyle> = {};

/** Sessions in a folder whose last turn finished while nobody was looking. */
const unseenIn = (list: SessionMeta[]): number => list.filter((s) => s.unseenAt !== undefined).length;

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const sidebarView: SidebarView = useStore((s) => (s.settings?.sidebarView === 'recent' ? 'recent' : 'folders'));
  const folders = useStore((s) => s.settings?.folders) ?? EMPTY_STRINGS;
  const folderOrder = useStore((s) => s.settings?.folderOrder) ?? EMPTY_STRINGS;
  const folderStyles = useStore((s) => s.settings?.folderStyles) ?? EMPTY_FOLDER_STYLES;
  const collapsed = useStore((s) => s.settings?.collapsedFolders) ?? EMPTY_STRINGS;
  const customLabels = useStore((s) => s.settings?.customLabels) ?? EMPTY_STRINGS;
  const activeId = useStore((s) => s.activeId);
  // Rows another split pane shows get a quieter marker than the active one.
  const paneSessions = useStore((s) => (s.layout.panes.length > 1 ? s.layout.panes : null));
  const setActive = useStore((s) => s.setActive);
  const startNewSession = useStore((s) => s.startNewSession);
  const setView = useStore((s) => s.setView);
  const view = useStore((s) => s.view);
  const toast = useStore((s) => s.toast);
  const archiving = useStore((s) => s.archiving);
  const [showArchived, setShowArchived] = useState(false);

  const visible = useMemo(
    () => sessions.filter((s) => (showArchived ? s.archived : !s.archived)),
    [sessions, showArchived]
  );
  // Recent view: one list across every folder, by the same comparator a folder's rows use.
  const recentRows = useMemo(() => (sidebarView === 'recent' ? nestMissionRows(sortSessionRows(visible)) : []), [visible, sidebarView]);
  const groups = useMemo(
    () => groupSidebarFolders(visible, { folders, folderOrder, includeEmptyFolders: !showArchived }),
    [visible, folders, folderOrder, showArchived]
  );

  const {
    folderDrag,
    clearFolderDrag,
    onDragStartFolder,
    onDragOverGroup,
    onDropGroup,
    onDragOverList,
    onDropList,
    rowDnd,
    rowDndHandlers
  } = useSidebarDnd(groups, sessions);

  const onSelectSession = useCallback((id: string, pane?: 'right') => {
    void setActive(id, pane).catch(toastError);
  }, [setActive]);

  const toggleCollapsed = (root: string) => {
    const next = collapsed.includes(root) ? collapsed.filter((r) => r !== root) : [...collapsed, root];
    void invoke('settings:update', { collapsedFolders: next });
  };

  const copyPath = async (root: string) => {
    try {
      await navigator.clipboard.writeText(root);
      toast('Path copied', 'success');
    } catch {
      toast('Could not copy the path', 'error');
    }
  };

  /** Right-click menu for a folder header. */
  const folderMenu = (root: string, isCollapsed: boolean): ContextMenuItem[] => [
    { label: `New session in ${basename(root)}`, icon: 'sessionPlus', onSelect: () => void startNewSession(root) },
    { label: isCollapsed ? 'Expand folder' : 'Collapse folder', icon: isCollapsed ? 'chevronRight' : 'chevron', onSelect: () => toggleCollapsed(root) },
    { separator: true },
    { label: 'Copy path', icon: 'copy', onSelect: () => void copyPath(root) },
    { separator: true },
    { label: 'Remove folder from Vocs Code', icon: 'trash', danger: true, onSelect: () => void removeFolder(root, sessions, toast) }
  ];

  const awaiting = sessions.filter((s) => s.status === 'awaiting').length;
  const running = sessions.filter((s) => !s.archived && (s.status === 'running' || s.status === 'starting' || (s.status !== 'awaiting' && hasOngoingWork(s)))).length;
  const done = activitySections(sessions, null).done.length;
  const plural = (n: number) => `${n} ${n === 1 ? 'session' : 'sessions'}`;
  // Zen keeps only the icons of these links; their names move into tooltips.
  const minimal = useMinimalUi();
  const tip = (label: string) => (minimal ? label : undefined);
  const pinned = useStore((s) => s.pins.left);

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">
          <Icon name="logo" size={22} />
          <span>Vocs Code</span>
        </div>
        {(running > 0 || awaiting > 0 || done > 0) && (
          <ActivityMenu className="sidebar-status" triggerClassName="sidebar-status-trigger" title="Show session activity">
            {running > 0 && <Badge tone="blue">{running} running</Badge>}
            {awaiting > 0 && (
              <Badge tone="red" title={`${plural(awaiting)} awaiting approval`}>
                {awaiting} awaiting
              </Badge>
            )}
            {done > 0 && (
              <Badge tone="green" title={`${plural(done)} finished since you last looked`}>
                {done} done
              </Badge>
            )}
          </ActivityMenu>
        )}
        <div className="sidebar-top-actions">
          {running === 0 && awaiting === 0 && done === 0 && (
            <ActivityMenu className="" triggerClassName="btn btn-ghost btn-sm btn-icon" label="Recent sessions" title="Recent sessions">
              <Icon name="clock" size={14} />
            </ActivityMenu>
          )}
          <Button variant="ghost" size="sm" icon="search" className="btn-icon" onClick={() => useStore.getState().openSearch(true)} title="Search sessions (Ctrl+Shift+F)" aria-label="Search sessions" />
          <Button variant="ghost" size="sm" icon="plus" className="btn-icon" onClick={() => void startNewSession()} title="New folder (Ctrl+N)" aria-label="New folder" />
          {/* Zen: hold the list open instead of folding back to the rail of dots. */}
          {minimal && <Button variant={pinned ? 'subtle' : 'ghost'} size="sm" icon={pinned ? 'pinOff' : 'pin'} className="btn-icon" onClick={() => useStore.getState().togglePin('left')} title={pinned ? 'Unpin: fold back to the rail' : 'Pin open'} aria-label={pinned ? 'Unpin sidebar' : 'Pin sidebar'} aria-pressed={pinned} />}
        </div>
      </div>
      <div className="sidebar-nav">
        <div className="sidebar-views">
          <button type="button" className={`sidebar-link ${view === 'analytics' ? 'active' : ''}`} title={tip('Analytics')} onClick={() => setView('analytics')}>
            <Icon name="chart" size={14} /> Analytics
          </button>
          <button type="button" className={`sidebar-link ${view === 'skills' ? 'active' : ''}`} title={tip('Skills')} onClick={() => setView('skills')}>
            <Icon name="puzzle" size={14} /> Skills
          </button>
          <button type="button" className={`sidebar-link ${view === 'mcp' ? 'active' : ''}`} title={tip('MCP')} onClick={() => setView('mcp')}>
            <Icon name="server" size={14} /> MCP
          </button>
        </div>
      </div>
      {/* What the list shows, picked at the top of the sidebar: its layout (folder groups or one
          recency order) and, beside it, which sessions (live or archived). The two are independent:
          archived sessions list by project or by recent too. New session closes the row. */}
      <div className="sidebar-viewswitch" role="group" aria-label="Session list view">
        <Icon name={showArchived ? 'archive' : sidebarView === 'recent' ? 'list' : 'folder'} size={15} className="sidebar-viewswitch-icon" />
        <div className="segmented" role="group" aria-label="Session list layout">
          {([['folders', 'folder', 'Projects', 'Group sessions by project folder'], ['recent', 'list', 'Recent', 'Sort sessions by recent, across folders']] as const).map(([v, icon, label, title]) => (
            <button
              key={v}
              type="button"
              className={`segment ${sidebarView === v ? 'active' : ''}`}
              data-testid={`sidebar-${v}`}
              aria-pressed={sidebarView === v}
              title={title}
              onClick={() => {
                if (sidebarView !== v) void invoke('settings:update', { sidebarView: v }).catch(toastError);
              }}
            >
              <Icon name={icon} size={12} /> <span className="segment-label">{label}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`segmented-toggle sidebar-archived ${showArchived ? 'active' : ''}`}
          data-testid="sidebar-archived"
          aria-pressed={showArchived}
          aria-label="Archived"
          title={showArchived ? 'Back to active sessions' : 'Show archived sessions'}
          onClick={() => setShowArchived((v) => !v)}
        >
          {/* Icon only, like New session beside it, so Projects | Recent keeps room for its labels;
              the name lives in aria-label and the tooltip. */}
          <Icon name="archive" size={14} />
        </button>
        {/* Same as Ctrl+Shift+N: the full new-session dialog, seeded with the open session's folder
            (the folder picker first when no session is open). An icon at the row's end keeps the
            top of the sidebar to one line; the name and shortcut live in the tooltip. */}
        <button
          type="button"
          className="segmented-toggle sidebar-new"
          data-testid="sidebar-new"
          aria-label="New session"
          aria-keyshortcuts={`${modKey === 'Ctrl' ? 'Control' : 'Meta'}+Shift+N`}
          title={`New session in this folder (${modKey}+Shift+N)`}
          onClick={() => {
            const st = useStore.getState();
            void st.startNewSession(st.sessions.find((x) => x.id === st.activeId)?.config.projectRoot);
          }}
        >
          <Icon name="sessionPlus" size={14} />
        </button>
      </div>
      <div className="sidebar-section">
        <span className="sidebar-section-label">{showArchived ? 'Archived sessions' : 'Sessions'}</span>
      </div>
      <div className="sidebar-list" onDragOver={onDragOverList} onDrop={onDropList}>
        {(sidebarView === 'recent' ? recentRows.length === 0 : groups.length === 0) && (
          <div className="sidebar-empty">{showArchived ? 'No archived sessions.' : 'No sessions yet. Create one to start.'}</div>
        )}
        {sidebarView === 'recent' && recentRows.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            folder={{ root: s.config.projectRoot, style: folderStyles[s.config.projectRoot] }}
            active={s.id === activeId && view === 'chat'}
            inPane={!!paneSessions && view === 'chat' && s.id !== activeId && paneSessions.some((p) => p.sessionId === s.id)}
            customLabels={customLabels}
            archiving={!!archiving[s.id]}
            onSelectSession={onSelectSession}
            toast={toast}
            dnd={rowDnd}
            dndHandlers={rowDndHandlers}
          />
        ))}
        {sidebarView === 'folders' && groups.map((g) => {
          const isCollapsed = collapsed.includes(g.root);
          const dropMark = folderDrag && folderDrag.over === g.root && folderDrag.root !== g.root ? (folderDrag.after ? 'drop-after' : 'drop-before') : '';
          return (
            <div
              key={g.root}
              className={`project-group ${folderDrag?.root === g.root ? 'dragging' : ''} ${dropMark}`}
              onDragOver={(e) => onDragOverGroup(e, g.root)}
              onDrop={(e) => onDropGroup(e, g.root)}
            >
              <div
                className="project-header"
                title={g.root}
                draggable
                onDragStart={(e) => onDragStartFolder(e, g.root)}
                onDragEnd={clearFolderDrag}
                onContextMenu={(e) => showContextMenu(e, folderMenu(g.root, isCollapsed))}
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
                {isCollapsed && unseenIn(g.list) > 0 && (
                  <span className="project-unseen" data-testid="project-unseen" title={`${plural(unseenIn(g.list))} finished since you last looked`}>
                    ●{unseenIn(g.list)}
                  </span>
                )}
                <FolderBranch root={g.root} expanded={!isCollapsed} />
                <button
                  type="button"
                  className="project-new-btn"
                  data-testid="new-session"
                  title={`New session in ${basename(g.root)}`}
                  aria-label={`New session in ${basename(g.root)}`}
                  onClick={() => void startNewSession(g.root)}
                >
                  <Icon name="sessionPlus" size={14} />
                </button>
              </div>
              {!isCollapsed && g.list.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={s.id === activeId && view === 'chat'}
                  inPane={!!paneSessions && view === 'chat' && s.id !== activeId && paneSessions.some((p) => p.sessionId === s.id)}
                  customLabels={customLabels}
                  archiving={!!archiving[s.id]}
                  onSelectSession={onSelectSession}
                  toast={toast}
                  dnd={rowDnd}
                  dndHandlers={rowDndHandlers}
                />
              ))}
            </div>
          );
        })}
      </div>
      <div className="sidebar-bottom">
        <button type="button" className={`sidebar-link ${view === 'settings' ? 'active' : ''}`} title={tip('Settings')} onClick={() => setView('settings')}>
          <Icon name="settings" size={14} /> Settings
        </button>
        <UpdatePill />
      </div>
      <Resizer target="sidebar" />
    </aside>
  );
}
