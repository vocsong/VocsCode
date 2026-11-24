/** Command palette for slash commands and quick navigation. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { sessionTitleText } from '../../../shared/session-title';
import { HARNESSES } from '../../../shared/harness-meta';
import type { SessionMeta } from '../../../shared/types';
import { invoke } from '../api';
import { harnessShort } from '../format';
import { canHousekeepHere, openHousekeep } from '../housekeep';
import { useStore } from '../store';
import { isTopLevelSession, MISSION_MANAGED_REASON, pauseMissionSession } from '../missions';
import { switchHarnessDisabledReason, switchSessionHarness } from './SwitchHarness';
import { createTerminal } from '../terminal/host';
import { canSplit, sessionPanes } from '../panes';
import { Icon } from './ui';
import { SessionTitle } from './SessionTitle';
import { setUiMode } from '../ui-mode';
import { UI_MODES } from '../../../shared/ui-modes';


interface Cmd {
  id: string;
  label: string;
  hint?: string;
  icon: string;
  run: () => void;
  disabled?: boolean;
  session?: SessionMeta;
}

export function CommandPalette() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const availability = useStore((s) => s.availability);
  const availabilityError = useStore((s) => s.availabilityError);
  const close = () => useStore.getState().openPalette(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const cmds = useMemo<Cmd[]>(() => {
    const st = useStore.getState();
    const active = sessions.find((session) => session.id === activeId);
    const base: Cmd[] = [
      { id: 'new', label: 'New session in folder…', hint: 'Ctrl+Alt+N', icon: 'plus', run: () => void st.startNewSession() },
      { id: 'new-quick', label: 'New session (quick picker)', hint: 'Ctrl+N', icon: 'folder', run: () => st.openQuickSession(true) },
      { id: 'settings', label: 'Open settings', hint: 'Ctrl+,', icon: 'settings', run: () => st.setView('settings') },
      { id: 'analytics', label: 'Open analytics dashboard', icon: 'chart', run: () => st.setView('analytics') },
      { id: 'skills', label: 'Open skills', icon: 'puzzle', run: () => st.setView('skills') },
      { id: 'mcp', label: 'Open MCP servers', icon: 'server', run: () => st.setView('mcp') },
      { id: 'panel', label: 'Toggle right side panel', hint: 'Ctrl+J', icon: 'layout', run: () => st.togglePanel() },
      { id: 'sidebar', label: 'Toggle left sidebar', hint: 'Ctrl+B', icon: 'sidebar', run: () => st.toggleSidebar() },
      { id: 'changes', label: 'Show changes', icon: 'diff', run: () => st.setPanelTab('changes') },
      { id: 'goal', label: active?.mission ? 'Show Mission' : 'Show goal', icon: 'target', run: () => st.setPanelTab('goal') },
      { id: 'terminal', label: 'Show terminal', hint: 'Ctrl+`', icon: 'terminal', run: () => { st.setPanelTab('terminal'); st.focusTerminal(); } },
      { id: 'thinking', label: 'Toggle thinking visibility', icon: 'brain', run: () => st.toggleThinking() },
      // The interface mode is one keystroke away from anywhere, so trying Zen costs nothing.
      ...UI_MODES.filter((m) => m.id !== (st.settings?.uiMode ?? 'standard')).map((m) => ({ id: `ui:${m.id}`, label: `Switch to the ${m.name} interface`, hint: m.tagline, icon: 'layout', run: () => setUiMode(m.id) }))
    ];
    if (canHousekeepHere()) base.push({ id: 'housekeep', label: 'Housekeep sessions', hint: '/housekeep', icon: 'archive', run: openHousekeep });
    if (activeId) {
      base.push(
        { id: 'new-here', label: 'New session in this folder', hint: 'Ctrl+Shift+N', icon: 'sessionPlus', run: () => void st.startNewSession(st.sessions.find((x) => x.id === st.activeId)?.config.projectRoot) },
        { id: 'new-terminal', label: 'New terminal', hint: 'Ctrl+Shift+`', icon: 'terminal', run: () => void createTerminal(activeId) },
        { id: 'stop', label: active?.mission ? 'Pause Mission' : 'Interrupt current turn', hint: 'Esc', icon: 'stop', run: () => active && pauseMissionSession(active) },
        { id: 'export', label: 'Export transcript as Markdown', icon: 'download', run: () => void invoke('sessions:export', { id: activeId }) },
        { id: 'fork', label: 'Fork session', icon: 'fork', disabled: !!active?.mission, hint: active?.mission ? MISSION_MANAGED_REASON : undefined, run: () => void invoke('sessions:fork', { id: activeId }).then((f) => f && st.setActive(f.id)) },
        { id: 'compact', label: 'Compact context', icon: 'compact', run: () => void invoke('sessions:compact', { id: activeId }) }
      );
      if (active && !active.mission && !active.archived) {
        const disabledReason = switchHarnessDisabledReason(active);
        const acpAgents = st.settings?.acpAgents ?? [];
        for (const h of HARNESSES) {
          const av = availability[h.id];
          const unavailable = !!av && !av.available;
          if (h.id === 'acp') {
            for (const preset of acpAgents) {
              if (active.config.harness === 'acp' && active.config.acpAgent === preset.id) continue;
              base.push({
                id: `switch-harness:acp:${preset.id}`,
                label: `Switch harness to ${harnessShort('acp')} (${preset.name})`,
                hint: disabledReason ?? (unavailable ? 'Not installed' : 'Same workspace'),
                icon: 'swap',
                disabled: !!disabledReason || unavailable || !!availabilityError,
                run: () => switchSessionHarness(active, 'acp', st.toast, undefined, preset.id)
              });
            }
            continue;
          }
          if (h.id === active.config.harness) continue;
          base.push({
            id: `switch-harness:${h.id}`,
            label: `Switch harness to ${harnessShort(h.id)}`,
            hint: disabledReason ?? (unavailable ? 'Not installed' : 'Same workspace'),
            icon: 'swap',
            disabled: !!disabledReason || unavailable || !!availabilityError,
            run: () => switchSessionHarness(active, h.id, st.toast)
          });
        }
      }
    }
    // Split view: the pane commands only appear when they can do something.
    const layout = st.layout;
    if (activeId && canSplit(layout)) {
      base.push(
        { id: 'split-right', label: 'Split right', hint: 'Ctrl+\\', icon: 'splitRight', run: () => st.splitPane('horizontal') },
        { id: 'split-down', label: 'Split down', hint: 'Ctrl+Shift+\\', icon: 'splitDown', run: () => st.splitPane('vertical') }
      );
    }
    // A file preview is never the active pane, so only session panes take part.
    const slots = sessionPanes(layout);
    if (slots.length > 1) {
      const at = slots.findIndex((p) => p.id === layout.activePaneId);
      const other = slots[(at + 1) % slots.length]!;
      base.push(
        { id: 'pane-next', label: 'Focus other pane', icon: 'layout', run: () => st.focusPane(other.id) },
        { id: 'pane-close', label: 'Close pane (session keeps running)', icon: 'x', run: () => st.closePane(layout.activePaneId) }
      );
    }
    for (const session of sessions.filter((s) => !s.archived && isTopLevelSession(s))) {
      base.push({ id: `s:${session.id}`, label: sessionTitleText(session), session, icon: 'sparkles', run: () => void st.setActive(session.id) });
    }
    return base;
  }, [sessions, activeId, availability, availabilityError]);

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
              else if (e.key === 'Enter' && filtered[idx] && !filtered[idx].disabled) {
                close();
                filtered[idx].run();
              } else if (e.key === 'Escape') close();
            }}
          />
        </div>
        <div className="palette-list">
          {filtered.slice(0, 40).map((c, i) => (
            <button key={c.id} type="button" disabled={c.disabled} className={`palette-item ${i === idx ? 'active' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => { close(); c.run(); }}>
              <Icon name={c.icon} size={14} />
              {c.session ? <SessionTitle session={c.session} /> : <span>{c.label}</span>}
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
