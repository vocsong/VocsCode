/** Individual sidebar session row with inline rename, pin/drag, context menu, and status picker. */
import React, { memo, useRef, useState } from 'react';
import type { FolderStyle, SessionMeta } from '../../../../shared/types';
import { hasOngoingWork, ongoingBadgeLabel } from '../../../../shared/ongoing';
import { modelRefName } from '../../../../shared/model-names';
import { sessionTitleText } from '../../../../shared/session-title';
import { invoke, isMac, modKey } from '../../api';
import { basename, relTime } from '../../format';
import { BUILDER_STATE_LABELS, MISSION_STATE_LABELS } from '../../mission';
import { canSplit, paneShowing, SESSION_DRAG_TYPE } from '../../panes';
import { archiveSession } from '../../sessionActions';
import { useStore } from '../../store';
import { useMinimalUi } from '../../ui-mode';
import { isEditableTarget, showContextMenu, type ContextMenuItem } from '../ContextMenu';
import { ForkIntoDropdown } from '../ForkInto';
import { SessionTitle } from '../SessionTitle';
import { askConfirm, Dropdown, Icon, STATUS_LABELS, StatusLabel } from '../ui';
import { StatusLabelPicker } from './SidebarPickers';
import type { RowDndHandlers, RowDndState } from './useSidebarDnd';

export interface SessionRowProps {
  session: SessionMeta;
  /** Set in the Recent view, where no folder header says which project the row belongs to. */
  folder?: { root: string; style?: FolderStyle };
  active: boolean;
  /** Shown in a split pane that is not the active one. */
  inPane?: boolean;
  customLabels: string[];
  /** An archive request is in flight; the status pill shows a blinking Archiving state meanwhile. */
  archiving: boolean;
  onSelectSession: (id: string, pane?: 'right') => void;
  toast: (t: string, k?: 'info' | 'success' | 'error') => void;
  dnd: RowDndState;
  dndHandlers: RowDndHandlers;
}

export const SessionRow = memo(function SessionRow({
  session: s,
  folder,
  active,
  inPane = false,
  customLabels,
  archiving,
  onSelectSession,
  toast,
  dnd,
  dndHandlers
}: SessionRowProps) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(s.title);
  const renameAction = useRef<'idle' | 'committed' | 'cancelled'>('idle');
  // Zen's rail hides the title, so the row names itself on hover there.
  const minimal = useMinimalUi();
  const startRename = () => {
    setTitle(s.title);
    renameAction.current = 'idle';
    setRenaming(true);
  };
  const cancelRename = () => {
    renameAction.current = 'cancelled';
    setTitle(s.title);
    setRenaming(false);
  };
  const commit = async () => {
    if (renameAction.current !== 'idle') return;
    renameAction.current = 'committed';
    setRenaming(false);
    if (!title.trim() || title === s.title) return;
    try {
      await invoke('sessions:rename', { id: s.id, title: title.trim() });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };
  // Confirmations open at the control that asked; from the right-click menu, whose item is gone by
  // then, they open at the row.
  const rowRef = useRef<HTMLDivElement>(null);
  const deleteRow = async (anchor: HTMLElement | null) => {
    const ok = await askConfirm({
      title: `Delete session "${s.title}"?`,
      body: s.worktreeBranch ? `Its worktree and the branch ${s.worktreeBranch} are removed with it.` : 'Its transcript is removed. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
      anchor
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
  /** "Open to the side": a new pane beside the active one, while there is room for another. */
  const openToSide = (): ContextMenuItem[] => {
    const st = useStore.getState();
    if (!canSplit(st.layout) || paneShowing(st.layout, s.id) || !st.activeId) return [];
    return [{ label: 'Open to the side', icon: 'splitRight', hint: `${modKey}+click`, onSelect: () => onSelectSession(s.id, 'right') }];
  };
  /** Right-click menu for a session row; it mirrors the inline actions plus rename and delete. */
  const rowMenu = (): ContextMenuItem[] => [
    ...(active ? [] : [{ label: 'Open session', icon: 'arrowRight' as const, onSelect: () => onSelectSession(s.id) }]),
    ...openToSide(),
    { label: 'Rename', icon: 'edit', hint: 'Double-click', onSelect: startRename },
    { label: s.pinned ? 'Unpin' : 'Pin to top', icon: s.pinned ? 'pinOff' : 'pin', onSelect: () => void invoke('sessions:pin', { id: s.id, pinned: !s.pinned }) },
    { separator: true },
    s.archived
      ? { label: 'Restore session', icon: 'restore', onSelect: () => void invoke('sessions:archive', { id: s.id, archived: false }) }
      : { label: s.worktreeBranch ? 'Archive & remove worktree' : 'Archive', icon: 'archive', onSelect: () => void archiveSession(s, toast, rowRef.current) },
    { label: 'Delete session', icon: 'trash', danger: true, onSelect: () => void deleteRow(rowRef.current) }
  ];

  // Any live row drags into the workspace to open it in a pane; only pinned rows also reorder.
  const canDrag = !s.archived && !renaming;
  const dragClass = dnd.dragId === s.id ? ' dragging' : '';
  const indicator = dnd.overId === s.id && dnd.dragId && dnd.dragId !== s.id ? (dnd.pos === 'before' ? ' drag-above' : ' drag-below') : '';
  // Mission mode: a Builder sits indented under its Lead with a status dot; the Lead carries a marker.
  const mission = s.mission;
  const builderState = mission?.role === 'builder' ? mission.builderState ?? 'working' : undefined;
  const builderName = mission?.builderIndex ? `Builder ${mission.builderIndex}` : 'Builder';
  return (
    <div
      ref={rowRef}
      className={`session-row ${active ? 'active' : ''}${inPane ? ' in-pane' : ''}${s.unseenAt !== undefined ? ' unseen' : ''}${builderState ? ' mission-builder' : ''}${dragClass}${indicator}`}
      data-testid="session-row"
      data-session-id={s.id}
      data-status={archiving ? 'archiving' : s.status}
      data-ongoing={!archiving && hasOngoingWork(s) ? 'true' : undefined}
      data-harness={s.config.harness}
      data-pinned={s.pinned ? '' : undefined}
      data-mission-role={mission?.role}
      title={minimal && !renaming ? sessionTitleText(s) : undefined}
      draggable={canDrag}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', s.id);
        e.dataTransfer.setData(SESSION_DRAG_TYPE, s.id);
        dndHandlers.start(s.id);
      }}
      onDragEnd={dndHandlers.end}
      onDragOver={(e) => dndHandlers.over(s.id, e)}
      onDragLeave={(e) => dndHandlers.leave(s.id, e)}
      onDrop={() => dndHandlers.drop(s.id)}
      onContextMenu={(e) => {
        // The rename field keeps the native editing menu (cut/copy/paste/undo).
        if (!isEditableTarget(e.target)) showContextMenu(e, rowMenu());
      }}
      onClick={(e) => onSelectSession(s.id, (isMac ? e.metaKey : e.ctrlKey) ? 'right' : undefined)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        startRename();
      }}
    >
      {/* The pin lives at the start of the row, so its state reads before the title. It is the
          pinned state that keeps it on screen: selecting a row never reveals a pin it does not have.
          Archived rows toggle it the same way, so pinning survives archiving in both directions. */}
      <div className="session-pin">
        <button
          type="button"
          className={`row-act-btn ${s.pinned ? 'is-pinned' : ''}`}
          data-testid="session-pin"
          title={s.pinned ? 'Unpin' : 'Pin to top'}
          aria-label={s.pinned ? 'Unpin session' : 'Pin session'}
          onClick={(e) => { e.stopPropagation(); void invoke('sessions:pin', { id: s.id, pinned: !s.pinned }); }}
        >
          <Icon name="pin" size={13} className="pin-on" />
          {/* Hovering a pinned row turns its state pin into the unpin action. */}
          {s.pinned && <Icon name="pinOff" size={13} className="pin-off" />}
        </button>
      </div>
      <div className="session-main">
        <div className="session-heading">
          {renaming ? (
            <input
              className="session-rename"
              aria-label="Rename session"
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={(e) => {
                e.stopPropagation();
                void commit();
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') void commit();
                if (e.key === 'Escape') cancelRename();
              }}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            />
          ) : (
            <div className="session-title">
              {builderState && (
                <span className="mission-dot" data-state={builderState} role="img" aria-label={`${builderName}: ${BUILDER_STATE_LABELS[builderState]}`} title={`${builderName} · ${BUILDER_STATE_LABELS[builderState]}`} />
              )}
              {s.unseenAt !== undefined && <span className="session-unseen-dot" data-testid="session-unseen-dot" title="Finished since you last looked" />}
              <SessionTitle session={s} showProject={!!folder} projectLabel={folder && (
                <span className="session-folder" data-testid="session-folder" title={folder.root} style={folder.style?.color ? { color: folder.style.color } : undefined}>
                  <Icon name={folder.style?.icon ?? 'folder'} size={11} />
                  <span className="session-folder-name">{basename(folder.root)}</span>
                </span>
              )} />
            </div>
          )}
          <div className="row-actions" onClick={(e) => e.stopPropagation()}>
            {s.archived ? (
              <>
                <button type="button" className="row-act-btn" title="Restore session" aria-label="Restore session" onClick={() => void invoke('sessions:archive', { id: s.id, archived: false })}>
                  <Icon name="restore" size={15} />
                </button>
                <button type="button" className="row-act-btn danger" title="Delete session" aria-label="Delete session" onClick={(e) => void deleteRow(e.currentTarget)}>
                  <Icon name="trash" size={15} />
                </button>
              </>
            ) : (
              <>
                <ForkIntoDropdown session={s} />
                <button type="button" className="row-act-btn" title={s.worktreeBranch ? 'Archive & remove worktree' : 'Archive'} aria-label="Archive session" onClick={(e) => void archiveSession(s, toast, e.currentTarget)}>
                  <Icon name="archive" size={15} />
                </button>
              </>
            )}
          </div>
        </div>
        <div className="session-meta">
          {mission?.role === 'lead' && (
            <span className="session-mission" data-state={mission.state} title={`Mission Lead${mission.state ? ` · ${MISSION_STATE_LABELS[mission.state]}` : ''}`}>
              <Icon name="flag" size={11} />
              <span>Mission</span>
            </span>
          )}
          {s.activeModel && (
            <span className="session-model" title={modelRefName(s.activeModel)}>
              {modelRefName(s.activeModel)}
            </span>
          )}
          {s.worktreeBranch && (
            <span className="session-worktree" title={`Worktree · ${s.worktreeBranch}`}>
              <Icon name="branch" size={12} />
              <span className="session-worktree-name">{s.worktreeBranch}</span>
            </span>
          )}
          {(s.queued ?? 0) > 0 && <span className="session-queued">+{s.queued}</span>}
          <span className="spacer" />
          {/* Time clicks must bubble to the row so they select the session; only the status pill swallows them. */}
          <span className="session-side" onClick={(e) => e.stopPropagation()}>
            <Dropdown align="right" width={200} trigger={() => archiving
              ? <span className="session-status status-archiving" title="Archiving…">Archiving</span>
              : !s.statusLabel && s.status === 'idle' && hasOngoingWork(s)
                ? <span className="session-status status-ongoing" data-testid="session-ongoing-status" title={s.ongoing!.map((i) => i.label).join(' · ')}>{ongoingBadgeLabel(s.ongoing!)}</span>
                : <StatusLabel status={s.status} label={s.statusLabel} />}>
              {(close) => <StatusLabelPicker session={s} customLabels={customLabels} onPick={setStatusLabel} close={close} />}
            </Dropdown>
          </span>
          <span className="session-time">{relTime(s.updatedAt)}</span>
        </div>
      </div>
    </div>
  );
});
