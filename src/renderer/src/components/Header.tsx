import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EffortLevel, GitBranchInfo, GitWorktreeInfo, ModelInfo, PermissionMode, SessionMeta } from '../../../shared/types';
import { EFFORT_LEVELS, HARNESS_BY_ID, PERMISSION_MODE_LABELS } from '../../../shared/harness-meta';
import { invoke } from '../api';
import { basename, fmtCost, fmtTokens } from '../format';
import { useSessionModels } from '../models';
import { useStore } from '../store';
import { askConfirm, Badge, Button, Dropdown, Icon, MenuItem, StatusDot } from './ui';
import { ModelPicker } from './ModelPicker';
import { harnessShort } from './Sidebar';

/**
 * Branch & worktree switcher shown when clicking the branch label in the header.
 * Renders through a portal: `.header-title` has `overflow: hidden`, which would clip an
 * absolutely-positioned menu inside the header.
 */
function BranchWorktreeMenu({ session, branch }: { session: SessionMeta; branch: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [branches, setBranches] = useState<GitBranchInfo[] | null>(null);
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[] | null>(null);
  const toast = useStore((s) => s.toast);

  useEffect(() => {
    if (!open || branches !== null) return;
    invoke('git:branches', { sessionId: session.id }).then((r) => setBranches(r.branches)).catch(() => setBranches([]));
    invoke('git:worktrees', { sessionId: session.id }).then((r) => setWorktrees(r.worktrees)).catch(() => setWorktrees([]));
  }, [open, session.id, branches, worktrees]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!btnRef.current?.parentElement?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    const el = btnRef.current;
    if (el && !open) {
      const r = el.getBoundingClientRect();
      // Keep the 280px menu inside the window.
      setPos({ left: Math.min(r.left, window.innerWidth - 292), top: r.bottom + 4 });
    }
    setOpen((o) => !o);
  };

  const close = () => setOpen(false);

  const refresh = () => useStore.setState((s) => ({ changesVersion: s.changesVersion + 1 }));

  const checkout = async (name: string) => {
    close();
    try {
      const r = await invoke('git:checkout', { sessionId: session.id, branch: name });
      if (r.ok) {
        toast(`Switched to ${name}`, 'success');
        refresh();
      } else {
        toast(r.error ?? 'Checkout failed', 'error');
      }
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const moveTo = async (wt: GitWorktreeInfo) => {
    close();
    try {
      await invoke('sessions:moveTo', { id: session.id, cwd: wt.path });
      toast(`Now working in ${basename(wt.path)}`, 'success');
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const menu = (() => {
    if (!open || !pos) return null;
    if (branches === null || worktrees === null) return <div className="menu-empty muted">Loading…</div>;
    if (branches.length === 0) return <div className="menu-empty muted">Not a git repository</div>;
    return (
      <>
        <div className="menu-group">Branch</div>
        {branches.map((b) => (
          <MenuItem key={b.name} active={b.current} disabled={b.current} onClick={() => void checkout(b.name)}>
            {b.name}
          </MenuItem>
        ))}
        {worktrees.length > 1 && (
          <>
            <div className="menu-group">Worktrees</div>
            {worktrees.map((w) => {
              const here = pathEquals(w.path, session.cwd);
              return (
                <MenuItem key={w.path} active={here} disabled={here} hint={basename(w.path)} onClick={() => void moveTo(w)}>
                  {w.branch ?? '(detached)'}
                </MenuItem>
              );
            })}
          </>
        )}
      </>
    );
  })();

  return (
    <>
      <button ref={btnRef} type="button" className={`header-path ${open ? 'open' : ''}`} title={`Branch ${branch} — click to switch branch or worktree`} onClick={toggle}>
        <Icon name="branch" size={12} /> {branch}
      </button>
      {open && pos && menu && <PortalMenu pos={pos} onClose={close}>{menu}</PortalMenu>}
    </>
  );
}

/** Fixed-position dropdown menu outside the clipped header, closed by any outside click. */
function PortalMenu({ pos, onClose, children }: { pos: { left: number; top: number }; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);
  return createPortal(
    <div ref={ref} className="dropdown-menu" style={{ position: 'fixed', left: pos.left, top: pos.top, width: 280, zIndex: 200 }}>
      {children}
    </div>,
    document.body
  );
}

function pathEquals(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[/\\]+$/, '');
  return norm(a).toLowerCase() === norm(b).toLowerCase();
}

export function Header({ session }: { session: SessionMeta }) {
  const { models, loading: modelsLoading, error: modelsError } = useSessionModels(session);
  const panelOpen = useStore((s) => s.panelOpen);
  const togglePanel = useStore((s) => s.togglePanel);
  const toast = useStore((s) => s.toast);
  const showThinking = useStore((s) => s.showThinking);
  const toggleThinking = useStore((s) => s.toggleThinking);
  const [branch, setBranch] = useState<string | undefined>();
  const changesVersion = useStore((s) => s.changesVersion);
  const h = HARNESS_BY_ID[session.config.harness];

  useEffect(() => {
    invoke('git:summary', { sessionId: session.id })
      .then((g) => setBranch(g.branch))
      .catch(() => setBranch(undefined));
  }, [session.id, changesVersion]);

  const current = session.activeModel ?? session.config.model;
  const currentInfo = models.find((m) => current && m.id === current.model && m.provider === current.provider);
  const effortOptions = currentInfo?.supportedEfforts?.length ? currentInfo.supportedEfforts : [...EFFORT_LEVELS];
  const mode = session.config.permissionMode;
  const busy = session.status === 'running' || session.status === 'awaiting' || session.status === 'starting';
  const ctxPct = session.usage.contextWindow && session.usage.contextTokens ? Math.min(100, Math.round((session.usage.contextTokens / session.usage.contextWindow) * 100)) : null;

  const setModel = async (m: ModelInfo) => {
    try {
      await invoke('sessions:setModel', { id: session.id, model: { provider: m.provider, model: m.id } });
    } catch (e) {
      toast(`Model switch failed: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <header className="header">
      <div className="header-title">
        <StatusDot status={session.status} />
        <span className="header-name" title={session.title}>
          {session.title}
        </span>
        <Badge tone="neutral" title={h.name}>
          {harnessShort(session.config.harness)}
          {session.config.harness === 'acp' && session.config.acpAgent ? ` · ${session.config.acpAgent}` : ''}
        </Badge>
        <button type="button" className="header-path" title={session.cwd} onClick={() => void invoke('app:openPath', { path: session.cwd, sessionId: session.id })}>
          <Icon name="folder" size={12} /> {basename(session.cwd)}
        </button>
        {branch && <BranchWorktreeMenu session={session} branch={branch} />}
        {session.statusDetail && busy && <span className="header-status muted">{session.statusDetail}</span>}
      </div>

      <div className="header-controls">
        <Dropdown align="right" width={380} trigger={(open) => <button type="button" className={`pill ${open ? 'open' : ''}`} title="Model"><Icon name="sparkles" size={13} /> {current?.model ?? 'default model'} <Icon name="chevron" size={12} /></button>}>
          {(close) => (
            <ModelPicker
              models={models}
              loading={modelsLoading}
              error={modelsError}
              selected={current}
              emptyText={
                h.capabilities.liveModelSwitch
                  ? 'No models available.'
                  : 'No models available (this harness cannot switch models live).'
              }
              onSelect={(m) => {
                close();
                if (m) void setModel(m);
              }}
            />
          )}
        </Dropdown>

        {h.capabilities.effort && (
          <Dropdown align="right" width={200} trigger={(open) => <button type="button" className={`pill ${open ? 'open' : ''}`} title="Reasoning effort"><Icon name="brain" size={13} /> {session.activeEffort ?? session.config.effort ?? 'effort'} <Icon name="chevron" size={12} /></button>}>
            {(close) => (
              <>
                {effortOptions.map((l) => (
                  <MenuItem key={l} active={(session.activeEffort ?? session.config.effort) === l} onClick={() => { close(); void invoke('sessions:setEffort', { id: session.id, effort: l as EffortLevel }).catch((e) => toast(String(e.message ?? e), 'error')); }}>
                    {l}
                  </MenuItem>
                ))}
              </>
            )}
          </Dropdown>
        )}

        <Dropdown align="right" width={300} trigger={(open) => <button type="button" className={`pill mode-${mode} ${open ? 'open' : ''}`} title={PERMISSION_MODE_LABELS[mode].description}><Icon name="shield" size={13} /> {PERMISSION_MODE_LABELS[mode].short} <Icon name="chevron" size={12} /></button>}>
          {(close) => (
            <>
              {h.capabilities.permissionModes.map((m) => (
                <MenuItem key={m} active={m === mode} hint={PERMISSION_MODE_LABELS[m].description} onClick={() => { close(); void invoke('sessions:setPermissionMode', { id: session.id, mode: m as PermissionMode }); }}>
                  {PERMISSION_MODE_LABELS[m].label}
                </MenuItem>
              ))}
            </>
          )}
        </Dropdown>

        <button type="button" className="pill" title={`Input ${fmtTokens(session.usage.inputTokens)} · Output ${fmtTokens(session.usage.outputTokens)} · Cache read ${fmtTokens(session.usage.cacheReadTokens)}${ctxPct !== null ? ` · Context ${ctxPct}%` : ''}`} onClick={() => useStore.getState().setPanelTab('usage')}>
          <Icon name="chart" size={13} /> {fmtCost(session.usage.costUsd)}
          {ctxPct !== null && (
            <span className="ctx-bar" title={`Context ${ctxPct}% used`}>
              <span style={{ width: `${ctxPct}%` }} />
            </span>
          )}
        </button>

        <Button variant="ghost" size="sm" icon={showThinking ? 'eye' : 'eyeOff'} onClick={toggleThinking} title={showThinking ? 'Hide thinking' : 'Show thinking'} />
        {busy && <Button variant="danger" size="sm" icon="stop" onClick={() => void invoke('sessions:interrupt', { id: session.id })} title="Interrupt (Esc)">Stop</Button>}
        <Button variant={panelOpen ? 'subtle' : 'ghost'} size="sm" icon="layout" onClick={() => togglePanel()} title="Toggle panel (Ctrl+J)" />
        <Dropdown align="right" width={220} trigger={() => <Button variant="ghost" size="sm" icon="more" aria-label="More" />}>
          {(close) => (
            <>
              <MenuItem onClick={() => { close(); void invoke('sessions:compact', { id: session.id }).then((r) => toast(r.ok ? 'Compaction requested' : r.detail ?? 'Not supported', r.ok ? 'success' : 'error')); }}>Compact context</MenuItem>
              <MenuItem onClick={() => { close(); void invoke('sessions:export', { id: session.id }).then((r) => r.path && toast(`Exported to ${r.path}`, 'success')); }}>Export Markdown</MenuItem>
              <MenuItem onClick={() => { close(); void invoke('sessions:fork', { id: session.id }).then((f) => f && useStore.getState().setActive(f.id)); }}>Fork session</MenuItem>
              <MenuItem onClick={() => { close(); void invoke('app:openInEditor', { path: session.cwd }).then((r) => !r.ok && toast(r.error ?? 'Failed', 'error')); }}>Open in editor</MenuItem>
              <MenuItem onClick={() => { close(); void invoke('app:openTerminal', { cwd: session.cwd }).then((r) => !r.ok && toast(r.error ?? 'Failed', 'error')); }}>Open terminal here</MenuItem>
              <MenuItem
                onClick={async () => {
                  close();
                  const ok = await askConfirm({ title: 'Clear the visible transcript?', body: 'The harness keeps its own state; only what you see here is removed.', confirmLabel: 'Clear' });
                  if (!ok) return;
                  void invoke('sessions:clearTranscript', { id: session.id });
                  useStore.getState().clearTranscriptLocal(session.id);
                }}
              >
                Clear transcript
              </MenuItem>
              <MenuItem onClick={() => { close(); void invoke('sessions:stop', { id: session.id }); }} disabled={session.status === 'idle' && !busy}>Stop harness process</MenuItem>
            </>
          )}
        </Dropdown>
      </div>
    </header>
  );
}
