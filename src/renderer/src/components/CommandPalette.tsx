/** Command palette for slash commands and quick navigation. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '../api';
import { useStore } from '../store';
import { createTerminal } from '../terminal/host';
import { Icon } from './ui';
import { harnessShort } from './Sidebar';

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  icon: string;
  run: () => void;
}

export function CommandPalette() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const close = () => useStore.getState().openPalette(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const cmds = useMemo<Cmd[]>(() => {
    const st = useStore.getState();
    const base: Cmd[] = [
      { id: 'new', label: 'New session', hint: 'Ctrl+N', icon: 'plus', run: () => void st.startNewSession() },
      { id: 'settings', label: 'Open settings', hint: 'Ctrl+,', icon: 'settings', run: () => st.setView('settings') },
      { id: 'analytics', label: 'Open analytics dashboard', icon: 'chart', run: () => st.setView('analytics') },
      { id: 'panel', label: 'Toggle side panel', hint: 'Ctrl+J', icon: 'layout', run: () => st.togglePanel() },
      { id: 'sidebar', label: 'Toggle sidebar', hint: 'Ctrl+B', icon: 'sidebar', run: () => st.toggleSidebar() },
      { id: 'changes', label: 'Show changes', icon: 'diff', run: () => st.setPanelTab('changes') },
      { id: 'goal', label: 'Show goal', icon: 'target', run: () => st.setPanelTab('goal') },
      { id: 'terminal', label: 'Show terminal', hint: 'Ctrl+`', icon: 'terminal', run: () => { st.setPanelTab('terminal'); st.focusTerminal(); } },
      { id: 'thinking', label: 'Toggle thinking visibility', icon: 'brain', run: () => st.toggleThinking() }
    ];
    if (activeId) {
      base.push(
        { id: 'new-terminal', label: 'New terminal', hint: 'Ctrl+Shift+`', icon: 'terminal', run: () => void createTerminal(activeId) },
        { id: 'stop', label: 'Interrupt current turn', hint: 'Esc', icon: 'stop', run: () => void invoke('sessions:interrupt', { id: activeId }) },
        { id: 'export', label: 'Export transcript as Markdown', icon: 'download', run: () => void invoke('sessions:export', { id: activeId }) },
        { id: 'fork', label: 'Fork session', icon: 'fork', run: () => void invoke('sessions:fork', { id: activeId }).then((f) => f && st.setActive(f.id)) },
        { id: 'compact', label: 'Compact context', icon: 'compact', run: () => void invoke('sessions:compact', { id: activeId }) }
      );
    }
    for (const s of sessions.filter((s) => !s.archived)) base.push({ id: `s:${s.id}`, label: s.title, hint: `${harnessShort(s.config.harness)} · ${s.config.projectRoot.split(/[\\/]/).pop()}`, icon: 'sparkles', run: () => void st.setActive(s.id) });
    return base;
  }, [sessions, activeId]);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return cmds;
    return cmds.filter((c) => c.label.toLowerCase().includes(n) || c.hint?.toLowerCase().includes(n));
  }, [cmds, q]);

  useEffect(() => setIdx(0), [q]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette">
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input
            ref={ref}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Type a command or session name…"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setIdx((i) => Math.min(i + 1, filtered.length - 1));
              else if (e.key === 'ArrowUp') setIdx((i) => Math.max(i - 1, 0));
              else if (e.key === 'Enter' && filtered[idx]) {
                close();
                filtered[idx].run();
              } else if (e.key === 'Escape') close();
            }}
          />
        </div>
        <div className="palette-list">
          {filtered.slice(0, 40).map((c, i) => (
            <button key={c.id} type="button" className={`palette-item ${i === idx ? 'active' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => { close(); c.run(); }}>
              <Icon name={c.icon} size={14} />
              <span>{c.label}</span>
              <span className="spacer" />
              {c.hint && <span className="muted small">{c.hint}</span>}
            </button>
          ))}
          {filtered.length === 0 && <div className="menu-empty">No matches</div>}
        </div>
      </div>
    </div>
  );
}
