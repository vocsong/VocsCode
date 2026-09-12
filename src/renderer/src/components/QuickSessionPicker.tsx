/** Ctrl+Shift+N quick picker: pick a known folder, start a session with defaults — keyboard only. */
import React, { useEffect, useMemo, useState } from 'react';
import { basename } from '../format';
import { useStore } from '../store';
import { Icon, Kbd } from './ui';

export function QuickSessionPicker() {
  const sessions = useStore((s) => s.sessions);
  const settings = useStore((s) => s.settings);
  const close = () => useStore.getState().openQuickSession(false);

  // Known folders: everything the sidebar could show — session roots, pinned folders and
  // recent projects — ordered like the sidebar (saved order, then alphabetical).
  const roots = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) set.add(s.config.projectRoot);
    for (const r of settings?.folders ?? []) set.add(r);
    for (const r of settings?.recentProjects ?? []) set.add(r);
    const order = settings?.folderOrder ?? [];
    const pos = (root: string) => {
      const i = order.indexOf(root);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...set].sort((a, b) => pos(a) - pos(b) || basename(a).localeCompare(basename(b)));
  }, [sessions, settings]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) if (!s.archived) m.set(s.config.projectRoot, (m.get(s.config.projectRoot) ?? 0) + 1);
    return m;
  }, [sessions]);

  // The last row falls back to the Ctrl+N flow: native folder picker, then the full dialog.
  const browse = () => {
    close();
    void useStore.getState().startNewSession();
  };

  const [idx, setIdx] = useState(0);
  const total = roots.length + 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setIdx((i) => (i + 1) % total);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setIdx((i) => (i - 1 + total) % total);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (idx < roots.length) {
          const root = roots[idx];
          close();
          void useStore.getState().createQuickSession(root);
        } else browse();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [idx, roots, total]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette">
        <div className="palette-input">
          <Icon name="plus" size={16} />
          <span className="row gap6" style={{ padding: '6px 0' }}>
            New session in… <span className="spacer" /> <Kbd>↑↓</Kbd> <Kbd>↵</Kbd>
          </span>
        </div>
        <div className="palette-list">
          {roots.map((root, i) => (
            <button
              key={root}
              type="button"
              className={`palette-item ${i === idx ? 'active' : ''}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => {
                close();
                void useStore.getState().createQuickSession(root);
              }}
            >
              <Icon name="folder" size={14} />
              <span>{basename(root)}</span>
              <span className="spacer" />
              {counts.get(root) ? <span className="muted small">{counts.get(root)} session{counts.get(root) === 1 ? '' : 's'}</span> : null}
              <span className="muted small qs-root" title={root}>
                {root}
              </span>
            </button>
          ))}
          <button type="button" className={`palette-item ${roots.length === idx ? 'active' : ''}`} onMouseEnter={() => setIdx(roots.length)} onClick={browse}>
            <Icon name="search" size={14} />
            <span>Browse for another folder…</span>
            <span className="spacer" />
            <span className="muted small">Ctrl+N</span>
          </button>
        </div>
      </div>
    </div>
  );
}
