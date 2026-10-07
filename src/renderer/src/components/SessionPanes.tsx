/**
 * The conversation workspace: one pane, or several side by side or stacked, each a full session view
 * (header, transcript, composer) over the shared store. A single pane renders exactly the app as it
 * was; the split chrome — active outline, divider, close — appears only once there are two.
 *
 * Every pane is a separate component instance keyed by pane id, so each keeps its own scroll and
 * follow state, and a pane re-renders only when its own session's transcript or metadata changes.
 */
import React, { useEffect, useRef, useState } from 'react';
import { harnessShort } from '../format';
import { isTopLevelSession } from '../missions';
import { MIN_PANE_PX, SESSION_DRAG_TYPE, dropZoneAt, type DropZone, type PaneLayout, type SessionPane } from '../panes';
import { sortSessionRows } from '../sessionOrder';
import { toastError, useStore } from '../store';
import { Composer } from './Composer';
import { Header } from './Header';
import { Transcript } from './Transcript';
import { Button, StatusDot } from './ui';

/** Shares sum to 1, but CSS leaves free space unfilled when grow factors sum below 1; scale them up. */
const grow = (share: number) => Math.round(share * 1000);

export function SessionPanes({ empty }: { empty: React.ReactNode }) {
  const layout = useStore((s) => s.layout);
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const split = layout.panes.length > 1;

  // Too little room for every pane at its minimum: show only the active one rather than squeezing
  // two unreadable chats. The others stay mounted, so nothing is lost when the window grows again.
  useEffect(() => {
    const el = ref.current;
    if (!el || !split || typeof ResizeObserver === 'undefined') {
      setNarrow(false);
      return;
    }
    const check = () => {
      const size = layout.orientation === 'horizontal' ? el.clientWidth : el.clientHeight;
      setNarrow(size > 0 && size < layout.panes.length * MIN_PANE_PX[layout.orientation]);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [split, layout.orientation, layout.panes.length]);

  return (
    <div ref={ref} className={`panes panes-${layout.orientation}${split ? ' split' : ''}${narrow ? ' narrow' : ''}`} data-testid="session-panes">
      {layout.panes.map((pane, i) => (
        <React.Fragment key={pane.id}>
          {i > 0 && <PaneDivider layout={layout} index={i} container={ref} />}
          <PaneView pane={pane} active={pane.id === layout.activePaneId} split={split} size={layout.sizes[i] ?? 1} empty={empty} />
        </React.Fragment>
      ))}
    </div>
  );
}

function PaneView({ pane, active, split, size, empty }: { pane: SessionPane; active: boolean; split: boolean; size: number; empty: React.ReactNode }) {
  const session = useStore((s) => (pane.sessionId ? s.sessions.find((x) => x.id === pane.sessionId) : undefined));
  const [zone, setZone] = useState<DropZone | null>(null);
  const focus = () => {
    if (!active) useStore.getState().focusPane(pane.id);
  };

  const isSessionDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(SESSION_DRAG_TYPE);
  const onDragOver = (e: React.DragEvent<HTMLElement>) => {
    if (!isSessionDrag(e)) return;
    // Capture phase: the composer's own file drop must not see a session being dragged.
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const next = dropZoneAt(useStore.getState().layout, e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
    setZone((z) => (z === next ? z : next));
  };
  const onDragLeave = (e: React.DragEvent<HTMLElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setZone(null);
  };
  const onDrop = (e: React.DragEvent<HTMLElement>) => {
    if (!isSessionDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const sessionId = e.dataTransfer.getData(SESSION_DRAG_TYPE);
    const at = dropZoneAt(useStore.getState().layout, e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
    setZone(null);
    if (sessionId) useStore.getState().dropSession(pane.id, at, sessionId);
  };

  return (
    <section
      className={`pane${active ? ' active' : ''}`}
      data-pane-id={pane.id}
      data-testid="session-pane"
      aria-label={split ? `${session?.title ?? 'Empty pane'}${active ? ' (active pane)' : ''}` : undefined}
      style={split ? { flexGrow: grow(size) } : undefined}
      onPointerDownCapture={focus}
      onFocusCapture={focus}
      onDragOverCapture={onDragOver}
      onDragLeave={onDragLeave}
      onDropCapture={onDrop}
    >
      {session ? (
        <>
          <Header session={session} paneId={pane.id} />
          <Transcript session={session} active={active} />
          <Composer key={session.id} session={session} />
        </>
      ) : split ? (
        <PanePicker pane={pane} />
      ) : (
        empty
      )}
      {zone && <div className={`pane-drop pane-drop-${zone}`} aria-hidden />}
    </section>
  );
}

/** What a freshly split pane shows until a session is chosen for it. */
function PanePicker({ pane }: { pane: SessionPane }) {
  const sessions = useStore((s) => s.sessions);
  const layout = useStore((s) => s.layout);
  const shown = new Set(layout.panes.map((p) => p.sessionId));
  const choices = sortSessionRows(sessions.filter((s) => !s.archived && isTopLevelSession(s) && !shown.has(s.id))).slice(0, 8);
  const open = (id: string) => void useStore.getState().setActive(id).catch(toastError);
  return (
    <div className="pane-picker">
      <div className="pane-picker-head">
        <span className="pane-picker-title">Open a session in this pane</span>
        <Button variant="ghost" size="sm" icon="x" title="Close pane" aria-label="Close pane" onClick={() => useStore.getState().closePane(pane.id)} />
      </div>
      <p className="muted small">Pick one below, click one in the sidebar, or drag it here. Each pane keeps its own session running.</p>
      {choices.length > 0 ? (
        <div className="pane-picker-list" role="list">
          {choices.map((s) => (
            <button key={s.id} type="button" role="listitem" className="pane-picker-item" onClick={() => open(s.id)}>
              <StatusDot status={s.status} />
              <span className="pane-picker-name">{s.title}</span>
              <span className="muted small">{harnessShort(s.config.harness)}{s.worktreeBranch ? ` · ${s.worktreeBranch}` : ''}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="muted small">Every other session is already on screen.</p>
      )}
      <div className="row gap8">
        <Button size="sm" icon="plus" onClick={() => void useStore.getState().startNewSession().catch(toastError)}>
          New session
        </Button>
      </div>
    </div>
  );
}

/**
 * Drag handle between two panes. Like the sidebar's Resizer it paints straight onto the panes while
 * dragging and commits the shares to the store on release, so a drag costs no React renders.
 */
function PaneDivider({ layout, index, container }: { layout: PaneLayout; index: number; container: React.RefObject<HTMLDivElement | null> }) {
  const [dragging, setDragging] = useState(false);
  const horizontal = layout.orientation === 'horizontal';
  const sizes = layout.sizes;

  /** New shares for the two panes either side of this divider, the pair's total kept. */
  const pairAt = (fraction: number, totalPx: number): number[] => {
    const before = sizes.slice(0, index - 1).reduce((a, b) => a + b, 0);
    const pair = sizes[index - 1]! + sizes[index]!;
    const min = Math.min(pair / 2, MIN_PANE_PX[layout.orientation] / Math.max(1, totalPx));
    const a = Math.min(pair - min, Math.max(min, fraction - before));
    const next = [...sizes];
    next[index - 1] = a;
    next[index] = pair - a;
    return next;
  };
  const paint = (next: number[]) => {
    const panes = container.current?.querySelectorAll<HTMLElement>(':scope > .pane');
    panes?.forEach((el, i) => (el.style.flexGrow = String(grow(next[i] ?? 1))));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = container.current;
    if (e.button !== 0 || !el) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const total = horizontal ? rect.width : rect.height;
    if (!total) return;
    let next = sizes;
    setDragging(true);
    document.body.classList.add(horizontal ? 'resizing' : 'resizing-row');
    const move = (ev: PointerEvent) => {
      next = pairAt(((horizontal ? ev.clientX - rect.left : ev.clientY - rect.top) / total), total);
      paint(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing', 'resizing-row');
      setDragging(false);
      useStore.getState().resizePanes(next);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const el = container.current;
    const total = el ? (horizontal ? el.clientWidth : el.clientHeight) : 0;
    const step = e.shiftKey ? 0.08 : 0.02;
    const at = sizes.slice(0, index).reduce((a, b) => a + b, 0);
    const back = horizontal ? 'ArrowLeft' : 'ArrowUp';
    const forward = horizontal ? 'ArrowRight' : 'ArrowDown';
    if (e.key === back) useStore.getState().resizePanes(pairAt(at - step, total));
    else if (e.key === forward) useStore.getState().resizePanes(pairAt(at + step, total));
    else if (e.key === 'Home' || e.key === 'Enter') useStore.getState().resizePanes(sizes.map(() => 1));
    else return;
    e.preventDefault();
  };

  return (
    <div
      className={`pane-divider ${dragging ? 'dragging' : ''}`}
      onPointerDown={onPointerDown}
      onDoubleClick={() => useStore.getState().resizePanes(sizes.map(() => 1))}
      onKeyDown={onKeyDown}
      role="separator"
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-label="Resize panes"
      aria-valuenow={Math.round((sizes.slice(0, index).reduce((a, b) => a + b, 0)) * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      title="Drag to resize · double-click to share evenly"
    />
  );
}
