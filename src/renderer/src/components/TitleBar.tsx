/**
 * The window's own title bar: sidebar toggle, back/forward history, an in-app File/Edit/View/Help
 * menu bar and the drag region. The BrowserWindow is frameless (`titleBarStyle: 'hidden'`), so on
 * Windows/Linux the OS paints its caption buttons over the right end of this bar and `.titlebar-tail`
 * reserves that space; on macOS the traffic lights sit in the padded left edge instead.
 */
import React, { useEffect, useRef, useState } from 'react';
import { invoke, isMac, modKey } from '../api';
import { useActiveSession, useStore } from '../store';
import type { PanelTab } from '../store';
import { Icon, MenuItem } from './ui';
import { ForkIntoItems } from './ForkInto';

const REPO = 'https://github.com/vocsong/VocsCode';

const PANEL_TABS: { id: PanelTab; label: string }[] = [
  { id: 'changes', label: 'Changes' },
  { id: 'files', label: 'Files' },
  { id: 'goal', label: 'Goal' },
  { id: 'usage', label: 'Usage' },
  { id: 'terminal', label: 'Terminal' }
];

export function TitleBar() {
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const canBack = useStore((s) => s.historyIndex > 0);
  const canForward = useStore((s) => s.historyIndex < s.history.length - 1);
  const navBack = useStore((s) => s.navBack);
  const navForward = useStore((s) => s.navForward);
  const view = useStore((s) => s.view);
  const session = useActiveSession();
  const title = view === 'settings' ? 'Settings · Vocs Code' : session ? `${session.title} · Vocs Code` : 'Vocs Code';

  return (
    <div className={`titlebar ${isMac ? 'titlebar-mac' : ''}`}>
      <div className="titlebar-lead">
        <TitleBarButton icon="sidebar" label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} hint={`${modKey}+B`} onClick={toggleSidebar} />
        <TitleBarButton icon="arrowLeft" label="Back" hint={isMac ? '⌘[' : 'Alt+←'} disabled={!canBack} onClick={() => void navBack()} />
        <TitleBarButton icon="arrowRight" label="Forward" hint={isMac ? '⌘]' : 'Alt+→'} disabled={!canForward} onClick={() => void navForward()} />
        <MenuBar />
      </div>
      <div className="titlebar-title" title={title}>
        {title}
      </div>
      <div className="titlebar-tail" />
    </div>
  );
}

function TitleBarButton({ icon, label, hint, onClick, disabled }: { icon: string; label: string; hint?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="titlebar-btn" onClick={onClick} disabled={disabled} title={hint ? `${label} (${hint})` : label} aria-label={label}>
      <Icon name={icon} size={15} />
    </button>
  );
}

/** Click to open, then hover to walk across the menus — the way a native menu bar behaves. */
function MenuBar() {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setOpen(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const menus: { label: string; width: number; render: (close: () => void) => React.ReactNode }[] = [
    { label: 'File', width: 280, render: (c) => <FileMenu close={c} /> },
    { label: 'Edit', width: 240, render: (c) => <EditMenu close={c} /> },
    { label: 'View', width: 260, render: (c) => <ViewMenu close={c} /> },
    { label: 'Help', width: 240, render: (c) => <HelpMenu close={c} /> }
  ];

  return (
    <nav className="menubar" ref={ref}>
      {menus.map((m) => (
        <div className="menubar-item" key={m.label}>
          <button
            type="button"
            className={`menubar-btn ${open === m.label ? 'open' : ''}`}
            aria-expanded={open === m.label}
            onClick={() => setOpen(open === m.label ? null : m.label)}
            onMouseEnter={() => open && setOpen(m.label)}
          >
            {m.label}
          </button>
          {open === m.label && (
            <div className="dropdown-menu dropdown-left menubar-panel" style={{ width: m.width }}>
              {m.render(close)}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}

function Sep() {
  return <div className="menu-sep" />;
}

function FileMenu({ close }: { close: () => void }) {
  const st = useStore.getState();
  const session = useActiveSession();
  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  const fail = (r: { ok: boolean; error?: string }) => !r.ok && st.toast(r.error ?? 'Failed', 'error');

  return (
    <>
      <MenuItem hint={`${modKey}+N`} onClick={run(() => void st.startNewSession())}>
        New session
      </MenuItem>
      <MenuItem disabled={!session} onClick={run(() => session && void invoke('sessions:fork', { id: session.id }).then((f) => f && st.setActive(f.id)).catch((e) => st.toast(e instanceof Error ? e.message : String(e), 'error')))}>
        Fork session
      </MenuItem>
      {session && <ForkIntoItems session={session} onForked={(f) => st.setActive(f.id)} />}
      <MenuItem disabled={!session} onClick={run(() => session && void invoke('sessions:export', { id: session.id }).then((r) => r.path && st.toast(`Exported to ${r.path}`, 'success')).catch((e) => st.toast(e instanceof Error ? e.message : String(e), 'error')))}>
        Export transcript…
      </MenuItem>
      <Sep />
      <MenuItem disabled={!session} onClick={run(() => session && void invoke('app:openPath', { path: session.cwd, sessionId: session.id }))}>
        Reveal project folder
      </MenuItem>
      <MenuItem disabled={!session} onClick={run(() => session && void invoke('app:openInEditor', { path: session.cwd }).then(fail))}>
        Open in editor
      </MenuItem>
      <MenuItem disabled={!session} onClick={run(() => session && void invoke('app:openTerminal', { cwd: session.cwd }).then(fail))}>
        Open terminal here
      </MenuItem>
      <Sep />
      <MenuItem hint={`${modKey}+,`} onClick={run(() => st.setView('settings'))}>
        Settings
      </MenuItem>
    </>
  );
}

function EditMenu({ close }: { close: () => void }) {
  const st = useStore.getState();
  const edit = (command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') => () => {
    close();
    void invoke('window:edit', { command });
  };
  return (
    <>
      <MenuItem hint={`${modKey}+Z`} onClick={edit('undo')}>
        Undo
      </MenuItem>
      <MenuItem hint={`${modKey}+Shift+Z`} onClick={edit('redo')}>
        Redo
      </MenuItem>
      <Sep />
      <MenuItem hint={`${modKey}+X`} onClick={edit('cut')}>
        Cut
      </MenuItem>
      <MenuItem hint={`${modKey}+C`} onClick={edit('copy')}>
        Copy
      </MenuItem>
      <MenuItem hint={`${modKey}+V`} onClick={edit('paste')}>
        Paste
      </MenuItem>
      <MenuItem hint={`${modKey}+A`} onClick={edit('selectAll')}>
        Select all
      </MenuItem>
      <Sep />
      <MenuItem
        hint={`${modKey}+K`}
        onClick={() => {
          close();
          st.openPalette(true);
        }}
      >
        Command palette…
      </MenuItem>
    </>
  );
}

function ViewMenu({ close }: { close: () => void }) {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const panelOpen = useStore((s) => s.panelOpen);
  const panelTab = useStore((s) => s.panelTab);
  const showThinking = useStore((s) => s.showThinking);
  const st = useStore.getState();
  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  return (
    <>
      <MenuItem active={sidebarOpen} hint={`${modKey}+B`} onClick={run(st.toggleSidebar)}>
        Sidebar
      </MenuItem>
      <MenuItem active={panelOpen} hint={`${modKey}+J`} onClick={run(() => st.togglePanel())}>
        Side panel
      </MenuItem>
      <Sep />
      {PANEL_TABS.map((t) => (
        <MenuItem
          key={t.id}
          active={panelOpen && panelTab === t.id}
          onClick={run(() => {
            st.togglePanel(true);
            st.setPanelTab(t.id);
          })}
        >
          {t.label}
        </MenuItem>
      ))}
      <Sep />
      <MenuItem active={showThinking} onClick={run(st.toggleThinking)}>
        Thinking
      </MenuItem>
      <Sep />
      <MenuItem onClick={run(() => st.setView('settings'))}>Theme</MenuItem>
    </>
  );
}

function HelpMenu({ close }: { close: () => void }) {
  const st = useStore.getState();
  const open = (url: string) => () => {
    close();
    void invoke('app:openExternal', { url });
  };
  return (
    <>
      <MenuItem onClick={open(REPO)}>Documentation</MenuItem>
      <MenuItem onClick={open(`${REPO}/issues/new`)}>Report an issue</MenuItem>
      <Sep />
      <MenuItem
        onClick={() => {
          close();
          st.setView('settings');
        }}
      >
        Diagnostics
      </MenuItem>
      <MenuItem
        onClick={() => {
          close();
          void invoke('app:info', undefined).then((i) => st.toast(`Vocs Code ${i.version} · ${i.platform}${i.isPackaged ? '' : ' · dev build'}`));
        }}
      >
        About Vocs Code
      </MenuItem>
    </>
  );
}
