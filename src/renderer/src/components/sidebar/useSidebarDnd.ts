/** Drag-and-drop hooks for reordering sidebar folder groups and pinned session rows. */
import React, { useMemo, useRef, useState } from 'react';
import type { SessionMeta } from '../../../../shared/types';
import { invoke } from '../../api';
import { sortSessionRows } from '../../sessionOrder';
import type { SidebarFolderGroup } from './nav';

/** Drag state for reordering the pinned section of one folder. */
export interface RowDndState {
  dragId: string | null;
  overId: string | null;
  pos: 'before' | 'after';
}

export const ROW_DND_CLEAR: RowDndState = { dragId: null, overId: null, pos: 'before' };

export type RowDndHandlers = {
  start: (id: string) => void;
  end: () => void;
  over: (id: string, e: React.DragEvent<HTMLElement>) => void;
  leave: (id: string, e: React.DragEvent<HTMLElement>) => void;
  drop: (id: string) => void;
};

export interface FolderDragState {
  root: string;
  over: string | null;
  after: boolean;
}

export function useSidebarDnd(groups: SidebarFolderGroup[], sessions: SessionMeta[]) {
  // Drag-to-reorder state: which folder block is being dragged, and where it currently hovers.
  const [folderDrag, setFolderDrag] = useState<FolderDragState | null>(null);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  /** Persist a drop of `from` next to `to` (before or after, by drop edge). */
  const commitOrder = (from: string, to: string, after: boolean) => {
    const roots = groupsRef.current.map((g) => g.root);
    const fromIdx = roots.indexOf(from);
    const toBase = roots.indexOf(to);
    if (from === to || fromIdx === -1 || toBase === -1) return;
    roots.splice(fromIdx, 1);
    const toIdx = roots.indexOf(to);
    if (toIdx === -1) return;
    roots.splice(after ? toIdx + 1 : toIdx, 0, from);
    void invoke('settings:update', { folderOrder: roots });
  };

  const onDragStartFolder = (e: React.DragEvent, root: string) => {
    e.dataTransfer.effectAllowed = 'move';
    // Firefox needs some payload before it will start a drag at all.
    e.dataTransfer.setData('text/plain', root);
    setFolderDrag({ root, over: null, after: false });
  };

  const onDragOverGroup = (e: React.DragEvent, root: string) => {
    if (!folderDrag) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    if (folderDrag.over !== root || folderDrag.after !== after) setFolderDrag({ ...folderDrag, over: root, after });
  };

  const onDropGroup = (e: React.DragEvent, root: string) => {
    if (!folderDrag) return;
    e.preventDefault();
    e.stopPropagation();
    if (root !== folderDrag.root) commitOrder(folderDrag.root, root, folderDrag.after);
    setFolderDrag(null);
  };

  const onDragOverList = (e: React.DragEvent) => {
    // Only the empty space below the last group lands here (group handlers stop
    // propagation); treat it as "move to the end".
    if (!folderDrag) return;
    e.preventDefault();
    const last = groupsRef.current[groupsRef.current.length - 1];
    if (last && (folderDrag.over !== last.root || !folderDrag.after)) setFolderDrag({ ...folderDrag, over: last.root, after: true });
  };

  const onDropList = (e: React.DragEvent) => {
    if (!folderDrag) return;
    e.preventDefault();
    if (folderDrag.over && folderDrag.over !== folderDrag.root) commitOrder(folderDrag.root, folderDrag.over, folderDrag.after);
    setFolderDrag(null);
  };

  // Pinned-section drag reorder: only pinned rows of the same folder accept a drop.
  const [rowDnd, setRowDnd] = useState<RowDndState>(ROW_DND_CLEAR);
  const rowDndRef = useRef(rowDnd);
  rowDndRef.current = rowDnd;

  const rowDndHandlers = useMemo<RowDndHandlers>(() => ({
    start: (id: string) => setRowDnd({ dragId: id, overId: null, pos: 'before' }),
    end: () => setRowDnd(ROW_DND_CLEAR),
    over: (id: string, e: React.DragEvent<HTMLElement>) => {
      const { dragId } = rowDndRef.current;
      const list = sessionsRef.current;
      const dragged = dragId ? list.find((x) => x.id === dragId) : null;
      const target = list.find((x) => x.id === id);
      if (!dragged?.pinned || !target?.pinned || target.id === dragId || target.config.projectRoot !== dragged.config.projectRoot) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = e.currentTarget.getBoundingClientRect();
      const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      setRowDnd((d) => (d.overId === id && d.pos === pos ? d : { ...d, overId: id, pos }));
    },
    leave: (id: string, e: React.DragEvent<HTMLElement>) => {
      const next = e.relatedTarget as Node | null;
      if (next && e.currentTarget.contains(next)) return;
      setRowDnd((d) => (d.overId === id ? { ...d, overId: null, pos: 'before' } : d));
    },
    drop: (id: string) => {
      const { dragId, pos } = rowDndRef.current;
      const list = sessionsRef.current;
      const dragged = dragId ? list.find((x) => x.id === dragId) : null;
      const target = list.find((x) => x.id === id);
      if (dragged?.pinned && target && target.pinned && target.id !== dragId && target.config.projectRoot === dragged.config.projectRoot) {
        const section = sortSessionRows(list.filter((x) => x.config.projectRoot === target.config.projectRoot && !x.archived))
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
      setRowDnd(ROW_DND_CLEAR);
    }
  }), []);

  return {
    folderDrag,
    clearFolderDrag: () => setFolderDrag(null),
    onDragStartFolder,
    onDragOverGroup,
    onDropGroup,
    onDragOverList,
    onDropList,
    rowDnd,
    rowDndHandlers
  };
}
