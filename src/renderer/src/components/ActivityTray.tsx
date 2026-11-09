/** The sidebar header's activity tray: what needs you, what is running, what finished since you last
 *  looked and what you viewed recently, across every folder. Hovering the trigger opens it after a
 *  short pause and leaving closes it; a click pins it open until Escape, a click outside, or a row. */
import React, { useEffect, useRef, useState } from 'react';
import type { SessionMeta } from '../../../shared/types';
import { activitySections } from '../activity';
import { invoke } from '../api';
import { basename, harnessShort, relTime } from '../format';
import { toastError, useStore } from '../store';
import { StatusDot } from './ui';

const OPEN_DELAY_MS = 250;
const CLOSE_DELAY_MS = 300;

/**
 * Wraps the trigger and the tray in one hover region, so the pointer can cross from one to the
 * other without the tray closing. `className` lands on that region, so the badge cluster keeps its
 * own layout rule (`.sidebar-status`) as the header's flex child.
 */
export function ActivityMenu({ className, triggerClassName, label, title, children }: {
  className: string;
  triggerClassName: string;
  label?: string;
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const region = useRef<HTMLDivElement>(null);
  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const close = () => {
    clearTimer();
    setOpen(false);
    setPinned(false);
  };

  useEffect(() => clearTimer, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape belongs to the tray while it is open: App's window-level Escape would otherwise
      // interrupt the running turn (focus is often on the body after a hover-open).
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    const onDown = (e: MouseEvent) => { if (!region.current?.contains(e.target as Node)) close(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <div
      ref={region}
      className={className ? `${className} activity-anchor` : 'activity-anchor'}
      onMouseEnter={() => {
        clearTimer();
        if (!open) timer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
      }}
      onMouseLeave={() => {
        clearTimer();
        if (open && !pinned) timer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
      }}
    >
      <button
        type="button"
        className={triggerClassName}
        data-testid="activity-trigger"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        onClick={() => {
          clearTimer();
          if (open && pinned) close();
          else {
            setOpen(true);
            setPinned(true);
          }
        }}
      >
        {children}
      </button>
      {open && <ActivityTray onClose={close} />}
    </div>
  );
}

function ActivityTray({ onClose }: { onClose: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const { needs, running, done, recent } = activitySections(sessions, activeId);
  const ref = useRef<HTMLDivElement>(null);

  const openSession = async (s: SessionMeta) => {
    onClose();
    const collapsed = useStore.getState().settings?.collapsedFolders ?? [];
    // The tray reaches into folders the list has folded away; unfold it so the row is there too.
    if (collapsed.includes(s.config.projectRoot)) {
      void invoke('settings:update', { collapsedFolders: collapsed.filter((root) => root !== s.config.projectRoot) }).catch(toastError);
    }
    await useStore.getState().setActive(s.id).catch(toastError);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...(ref.current?.querySelectorAll<HTMLButtonElement>('.activity-row') ?? [])];
    if (!rows.length) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1);
    rows[next]?.focus();
  };

  const section = (label: string, list: SessionMeta[], time: (s: SessionMeta) => string) =>
    list.length > 0 && (
      <div className="activity-section" key={label}>
        <div className="activity-section-label">{label}</div>
        {list.map((s) => (
          <button key={s.id} type="button" className="activity-row" data-testid="activity-row" onClick={() => void openSession(s)}>
            {/* A failed turn has usually returned the session to idle; the dot says how it ended. */}
            <StatusDot status={s.unseenAt !== undefined && s.unseenFailed ? 'error' : s.status} />
            <span className="activity-row-main">
              <span className="activity-row-title">{s.title}</span>
              <span className="activity-row-meta">{`${basename(s.config.projectRoot)} · ${harnessShort(s.config.harness)}`}</span>
            </span>
            <span className="activity-row-time">{time(s)}</span>
          </button>
        ))}
      </div>
    );

  const empty = !needs.length && !running.length && !done.length && !recent.length;
  return (
    <div ref={ref} className="activity-tray" role="dialog" aria-label="Session activity" data-testid="activity-tray" onKeyDown={onKeyDown}>
      {section('Needs you', needs, () => 'Pending')}
      {/* No turn-start time exists, and the last user message can be hours before a goal's turn. */}
      {section('Running', running, () => 'Working')}
      {section('Done · not viewed', done, (s) => relTime(s.unseenAt!))}
      {section('Recent', recent, (s) => relTime(s.lastViewedAt!))}
      {empty && <div className="activity-empty">Nothing running and no recent sessions yet.</div>}
    </div>
  );
}
