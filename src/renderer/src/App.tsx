/** Top-level layout: sidebar, transcript, composer and the right-hand panel. */
import React, { useEffect } from 'react';
import { invoke } from './api';
import { useActiveSession, useStore } from './store';
import { AnalyticsDashboard } from './components/AnalyticsDashboard';
import { CommandPalette } from './components/CommandPalette';
import { Composer } from './components/Composer';
import { Header } from './components/Header';
import { NewSessionDialog } from './components/NewSessionDialog';
import { OnboardingWizard } from './components/OnboardingWizard';
import { QuickSessionPicker } from './components/QuickSessionPicker';
import { RightPanel } from './components/RightPanel';
import { SearchModal } from './components/SearchModal';
import { SettingsView } from './components/SettingsView';
import { nextFolderTarget, nextSessionTarget, sidebarNavModel, Sidebar } from './components/Sidebar';
import { McpView } from './components/McpView';
import { SkillsView } from './components/SkillsView';
import { TitleBar } from './components/TitleBar';
import { Transcript } from './components/Transcript';
import { Button, ConfirmHost, EmptyState, Icon, Kbd, Spinner } from './components/ui';
import { handleCustomShortcut } from './shortcuts';
import { createTerminal } from './terminal/host';
import { applyTheme } from './theme';

export function App() {
  const booted = useStore((s) => s.booted);
  const bootError = useStore((s) => s.bootError);
  const boot = useStore((s) => s.boot);
  const settings = useStore((s) => s.settings);
  const view = useStore((s) => s.view);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const panelOpen = useStore((s) => s.panelOpen);
  const newSessionOpen = useStore((s) => s.newSessionOpen);
  const quickSessionOpen = useStore((s) => s.quickSessionOpen);
  const paletteOpen = useStore((s) => s.paletteOpen);
  const searchOpen = useStore((s) => s.searchOpen);
  const toasts = useStore((s) => s.toasts);
  const session = useActiveSession();

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    applyTheme(settings?.theme ?? 'system');
  }, [settings?.theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.altKey && e.key.toLowerCase() === 'n') {
        // Ctrl+Alt+N: folder-picker flow (native picker, then the full new-session dialog).
        e.preventDefault();
        void st.startNewSession();
      } else if (mod && e.key.toLowerCase() === 'n') {
        // Ctrl+N: quick-pick a known folder, start with defaults.
        e.preventDefault();
        st.openQuickSession(true);
      } else if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        st.openPalette(!st.paletteOpen);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        // Ctrl+Shift+F: deep session search (titles, goals, transcript contents).
        e.preventDefault();
        st.openSearch(true);
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        st.toggleSidebar();
      } else if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        st.togglePanel();
      } else if ((e.altKey && e.key === 'ArrowLeft') || (mod && e.key === '[')) {
        e.preventDefault();
        void st.navBack();
      } else if ((e.altKey && e.key === 'ArrowRight') || (mod && e.key === ']')) {
        e.preventDefault();
        void st.navForward();
      } else if (mod && e.key === ',') {
        e.preventDefault();
        st.setView(st.view === 'settings' ? 'chat' : 'settings');
      } else if (mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        // Ctrl+Arrow walks session rows; Ctrl+Shift+Arrow jumps to the first session of the
        // folder below/above — both work no matter where focus is (terminal, composer, sidebar).
        e.preventDefault();
        const down = e.key === 'ArrowDown';
        const model = sidebarNavModel(st.sessions, st.settings);
        const target = e.shiftKey ? nextFolderTarget(model, st.activeId, down) : nextSessionTarget(model, st.activeId, down);
        if (target) {
          const collapsed = st.settings?.collapsedFolders ?? [];
          if (collapsed.includes(target.root)) void invoke('settings:update', { collapsedFolders: collapsed.filter((r) => r !== target.root) });
          void st.setActive(target.sessionId);
          // The sidebar row may not be in view (long list, or folder just expanded above).
          requestAnimationFrame(() => document.querySelector(`[data-session-id="${CSS.escape(target.sessionId)}"]`)?.scrollIntoView({ block: 'nearest' }));
        }
      } else if (mod && /^[1-9]$/.test(e.key)) {
        const list = st.sessions.filter((s) => !s.archived);
        const target = list[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          void st.setActive(target.id);
        }
      } else if (mod && e.code === 'Backquote' && st.activeId && st.view === 'chat') {
        // Ctrl+` toggles focus between the terminal and the composer; Ctrl+Shift+` opens a new terminal.
        e.preventDefault();
        if (e.shiftKey) void createTerminal(st.activeId);
        else if (st.panelOpen && st.panelTab === 'terminal' && document.activeElement?.closest('.term-view')) document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
        else {
          st.setPanelTab('terminal');
          st.focusTerminal();
        }
      } else if (handleCustomShortcut(e)) {
        // A custom shortcut bound in Settings → Shortcuts consumed the key; the fixed
        // shortcuts above keep priority.
      } else if (e.key === 'Escape' && !st.newSessionOpen && !st.quickSessionOpen && !st.paletteOpen && !st.searchOpen && st.activeId) {
        // Escape interrupts the agent only when nothing else would consume it: no open menu, dialog or
        // popover, and focus is on the page body or an empty composer.
        if (document.querySelector('.dropdown-menu, .modal, .popover, .session-rename, .find-bar')) return;
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

  if (bootError) {
    return (
      <div className="shell">
        <TitleBar />
        <div className="boot boot-error" role="alert">
          <div className="boot-error-copy">
            <Icon name="alert" size={24} />
            <strong>Could not load Vocs Code</strong>
            <span className="boot-error-detail">{bootError}</span>
          </div>
          <Button variant="primary" icon="refresh" onClick={() => void boot()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!booted || !settings) {
    return (
      <div className="shell">
        <TitleBar />
        <div className="boot">
          <Spinner size={20} /> Loading Vocs Code…
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <TitleBar />
      <div className={`app ${sidebarOpen ? '' : 'no-sidebar'} ${panelOpen && session && view === 'chat' ? '' : 'no-panel'}`} style={{ ['--sidebar' as string]: `${settings.sidebarWidth}px`, ['--panel' as string]: `${settings.panelWidth}px` }}>
        {sidebarOpen && <Sidebar />}
        <main className="main">
          {view === 'settings' ? (
            <SettingsView />
          ) : view === 'analytics' ? (
            <AnalyticsDashboard />
          ) : view === 'skills' ? (
            <SkillsView />
          ) : view === 'mcp' ? (
            <McpView />
          ) : session ? (
            <>
              <Header session={session} />
              <Transcript session={session} />
              <Composer key={session.id} session={session} />
            </>
          ) : (
            <div className="main-empty">
              <EmptyState icon="sparkles" title="Welcome to Vocs Code">
                <p>One desktop for every coding agent. Pick a harness per session — Claude Agent SDK, Codex, Pi, DeepSeek Harness or any ACP agent, or the built-in loop — and any model it can reach.</p>
                <div className="row gap8 center">
                  <Button variant="primary" icon="plus" onClick={() => void useStore.getState().startNewSession()}>
                    New session
                  </Button>
                  <Button icon="settings" onClick={() => useStore.getState().setView('settings')}>
                    Settings
                  </Button>
                </div>
                <p className="muted small">
                  <Kbd>Ctrl+N</Kbd> new (quick) · <Kbd>Ctrl+Alt+N</Kbd> new in folder · <Kbd>Ctrl+K</Kbd> palette · <Kbd>Ctrl+Shift+F</Kbd> search · <Kbd>Ctrl+1…9</Kbd> switch · <Kbd>Ctrl+J</Kbd> panel
                </p>
              </EmptyState>
            </div>
          )}
        </main>
        {panelOpen && session && view === 'chat' && <RightPanel session={session} />}
      </div>
      {newSessionOpen && <NewSessionDialog />}
      {!settings.onboardingDone && <OnboardingWizard />}
      {quickSessionOpen && <QuickSessionPicker />}
      {paletteOpen && <CommandPalette />}
      {searchOpen && <SearchModal />}
      <ConfirmHost />
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
