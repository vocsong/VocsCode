import React, { useEffect } from 'react';
import { invoke } from './api';
import { useActiveSession, useStore } from './store';
import { CommandPalette } from './components/CommandPalette';
import { Composer } from './components/Composer';
import { Header } from './components/Header';
import { NewSessionDialog } from './components/NewSessionDialog';
import { RightPanel } from './components/RightPanel';
import { SettingsView } from './components/SettingsView';
import { Sidebar } from './components/Sidebar';
import { Transcript } from './components/Transcript';
import { Button, EmptyState, Icon, Kbd, Spinner } from './components/ui';

export function App() {
  const booted = useStore((s) => s.booted);
  const boot = useStore((s) => s.boot);
  const settings = useStore((s) => s.settings);
  const view = useStore((s) => s.view);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const panelOpen = useStore((s) => s.panelOpen);
  const newSessionOpen = useStore((s) => s.newSessionOpen);
  const paletteOpen = useStore((s) => s.paletteOpen);
  const toasts = useStore((s) => s.toasts);
  const session = useActiveSession();

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    const theme = settings?.theme ?? 'system';
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }, [settings?.theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        st.openNewSession(true);
      } else if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        st.openPalette(!st.paletteOpen);
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        st.toggleSidebar();
      } else if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        st.togglePanel();
      } else if (mod && e.key === ',') {
        e.preventDefault();
        st.setView(st.view === 'settings' ? 'chat' : 'settings');
      } else if (mod && /^[1-9]$/.test(e.key)) {
        const list = st.sessions.filter((s) => !s.archived);
        const target = list[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          void st.setActive(target.id);
        }
      } else if (e.key === 'Escape' && !st.newSessionOpen && !st.paletteOpen && st.activeId) {
        // Escape interrupts the agent only when nothing else would consume it: no open menu, dialog or
        // popover, and focus is on the page body or an empty composer.
        if (document.querySelector('.dropdown-menu, .modal, .popover, .session-rename')) return;
        const el = document.activeElement as HTMLElement | null;
        const onBody = !el || el === document.body;
        const onEmptyComposer = el?.tagName === 'TEXTAREA' && el.closest('.composer') !== null && !(el as HTMLTextAreaElement).value;
        if (!onBody && !onEmptyComposer) return;
        const s = st.sessions.find((x) => x.id === st.activeId);
        if (s && (s.status === 'running' || s.status === 'awaiting')) void invoke('sessions:interrupt', { id: s.id });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!booted || !settings) {
    return (
      <div className="boot">
        <Spinner size={20} /> Loading Vocs Code…
      </div>
    );
  }

  return (
    <div className={`app ${sidebarOpen ? '' : 'no-sidebar'} ${panelOpen && session && view === 'chat' ? '' : 'no-panel'}`} style={{ ['--sidebar' as string]: `${settings.sidebarWidth}px`, ['--panel' as string]: `${settings.panelWidth}px` }}>
      {sidebarOpen && <Sidebar />}
      <main className="main">
        {view === 'settings' ? (
          <SettingsView />
        ) : session ? (
          <>
            <Header session={session} />
            <Transcript session={session} />
            <Composer session={session} />
          </>
        ) : (
          <div className="main-empty">
            <EmptyState icon="sparkles" title="Welcome to Vocs Code">
              <p>One desktop for every coding agent. Pick a harness per session — Claude Agent SDK, Codex, Pi, DeepSeek Harness or any ACP agent, or the built-in loop — and any model it can reach.</p>
              <div className="row gap8 center">
                <Button variant="primary" icon="plus" onClick={() => useStore.getState().openNewSession(true)}>
                  New session
                </Button>
                <Button icon="settings" onClick={() => useStore.getState().setView('settings')}>
                  Settings
                </Button>
              </div>
              <p className="muted small">
                <Kbd>Ctrl+N</Kbd> new · <Kbd>Ctrl+K</Kbd> palette · <Kbd>Ctrl+1…9</Kbd> switch · <Kbd>Ctrl+J</Kbd> panel
              </p>
            </EmptyState>
          </div>
        )}
      </main>
      {panelOpen && session && view === 'chat' && <RightPanel session={session} />}
      {newSessionOpen && <NewSessionDialog />}
      {paletteOpen && <CommandPalette />}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => useStore.getState().dismissToast(t.id)}>
            <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : 'info'} size={14} /> <span>{t.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
