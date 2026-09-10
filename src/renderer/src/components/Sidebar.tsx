/** Session list grouped by project, with live status badges per harness. */
import React, { useMemo, useState } from 'react';
import type { SessionMeta } from '../../../shared/types';
import { HARNESS_BY_ID } from '../../../shared/harness-meta';
import { invoke } from '../api';
import { basename, fmtCost, relTime } from '../format';
import { useStore } from '../store';
import { Resizer } from './Resizer';
import { Badge, Button, Dropdown, Icon, MenuItem, StatusLabel } from './ui';

const HARNESS_TONE: Record<string, 'blue' | 'green' | 'amber' | 'purple' | 'neutral' | 'red'> = {
  claude: 'amber',
  codex: 'green',
  'codex-exec': 'green',
  pi: 'purple',
  acp: 'blue',
  native: 'neutral'
};

export function harnessShort(id: string): string {
  return { claude: 'Claude', codex: 'Codex', 'codex-exec': 'Codex·exec', pi: 'Pi', acp: 'ACP', native: 'Native' }[id] ?? id;
}

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const setActive = useStore((s) => s.setActive);
  const startNewSession = useStore((s) => s.startNewSession);
  const setView = useStore((s) => s.setView);
  const view = useStore((s) => s.view);
  const toast = useStore((s) => s.toast);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = sessions.filter((s) => (showArchived ? s.archived : !s.archived)).filter((s) => !q || s.title.toLowerCase().includes(q) || s.config.projectRoot.toLowerCase().includes(q));
    const byProject = new Map<string, SessionMeta[]>();
    for (const s of visible) {
      const key = s.config.projectRoot;
      byProject.set(key, [...(byProject.get(key) ?? []), s]);
    }
    return [...byProject.entries()]
      .map(([root, list]) => ({ root, list: list.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt) }))
      .sort((a, b) => Math.max(...b.list.map((x) => x.updatedAt)) - Math.max(...a.list.map((x) => x.updatedAt)));
  }, [sessions, query, showArchived]);

  const awaiting = sessions.filter((s) => s.status === 'awaiting').length;
  const running = sessions.filter((s) => s.status === 'running').length;

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">
          <Icon name="logo" size={18} />
          <span>Vocs Code</span>
        </div>
        <Button variant="primary" size="sm" icon="folder" onClick={() => void startNewSession()} title="New folder (Ctrl+N)">
          New folder
        </Button>
      </div>
      <div className="sidebar-search">
        <Icon name="search" size={14} />
        <input placeholder="Search sessions" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {(awaiting > 0 || running > 0) && (
        <div className="sidebar-summary">
          {awaiting > 0 && <Badge tone="amber">{awaiting} awaiting approval</Badge>}
          {running > 0 && <Badge tone="blue">{running} running</Badge>}
        </div>
      )}
      <div className="sidebar-list">
        {groups.length === 0 && <div className="sidebar-empty">{showArchived ? 'No archived sessions.' : 'No sessions yet. Create one to start.'}</div>}
        {groups.map((g) => (
          <div key={g.root} className="project-group">
            <div className="project-header" title={g.root}>
              <Icon name="folder" size={13} />
              <span>{basename(g.root)}</span>
              <button
                type="button"
                className="project-new-btn"
                title={`New session in ${basename(g.root)}`}
                aria-label={`New session in ${basename(g.root)}`}
                onClick={() => void startNewSession(g.root)}
              >
                <Icon name="plus" size={13} />
              </button>
            </div>
            {g.list.map((s) => (
              <SessionRow key={s.id} session={s} active={s.id === activeId && view === 'chat'} onSelect={() => void setActive(s.id)} toast={toast} />
            ))}
          </div>
        ))}
      </div>
      <div className="sidebar-bottom">
        <button type="button" className={`sidebar-link ${showArchived ? 'active' : ''}`} onClick={() => setShowArchived((v) => !v)}>
          <Icon name="clock" size={14} /> {showArchived ? 'Show active' : 'Archived'}
        </button>
        <button type="button" className={`sidebar-link ${view === 'analytics' ? 'active' : ''}`} onClick={() => setView('analytics')}>
          <Icon name="chart" size={14} /> Analytics
        </button>
        <button type="button" className={`sidebar-link ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}>
          <Icon name="settings" size={14} /> Settings
        </button>
      </div>
      <Resizer target="sidebar" />
    </aside>
  );
}

function SessionRow({ session: s, active, onSelect, toast }: { session: SessionMeta; active: boolean; onSelect: () => void; toast: (t: string, k?: 'info' | 'success' | 'error') => void }) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(s.title);
  const h = HARNESS_BY_ID[s.config.harness];
  const startRename = () => {
    setTitle(s.title);
    setRenaming(true);
  };
  const commit = async () => {
    setRenaming(false);
    if (title.trim() && title !== s.title) await invoke('sessions:rename', { id: s.id, title: title.trim() });
  };
  return (
    <div className={`session-row ${active ? 'active' : ''}`} onClick={onSelect} onDoubleClick={startRename}>
      <div className="session-main">
        {renaming ? (
          <input
            className="session-rename"
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit();
              if (e.key === 'Escape') setRenaming(false);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div className="session-title">
            {s.pinned && <Icon name="pin" size={11} />}
            <span title="Click to rename" onClick={() => startRename()}>{s.title}</span>
          </div>
        )}
        <div className="session-meta">
          <Badge tone={HARNESS_TONE[s.config.harness]} title={h?.name}>
            {harnessShort(s.config.harness)}
          </Badge>
          {s.activeModel && <span className="session-model" title={`${s.activeModel.provider}/${s.activeModel.model}`}>{s.activeModel.model}</span>}
          <span className="session-time">{relTime(s.updatedAt)}</span>
          {s.usage.costUsd > 0 && <span className="session-cost">{fmtCost(s.usage.costUsd)}</span>}
          {s.worktreeBranch && <Icon name="branch" size={11} className="muted" />}
          {(s.queued ?? 0) > 0 && <span className="session-queued">+{s.queued}</span>}
        </div>
      </div>
      <StatusLabel status={s.status} />
      <div onClick={(e) => e.stopPropagation()}>
        <Dropdown align="right" width={220} trigger={() => <button type="button" className="row-menu-btn" aria-label="Session menu"><Icon name="more" size={14} /></button>}>
          {(close) => (
            <>
              <MenuItem onClick={() => { close(); startRename(); }}>Rename</MenuItem>
              <MenuItem onClick={() => { close(); void invoke('sessions:pin', { id: s.id, pinned: !s.pinned }); }}>{s.pinned ? 'Unpin' : 'Pin'}</MenuItem>
              <MenuItem onClick={async () => { close(); const f = await invoke('sessions:fork', { id: s.id }); if (f) toast('Forked session created', 'success'); }}>Fork</MenuItem>
              <MenuItem onClick={() => { close(); void invoke('app:openPath', { path: s.cwd, sessionId: s.id }); }}>Open folder</MenuItem>
              <MenuItem onClick={() => { close(); void invoke('sessions:stop', { id: s.id }); }} disabled={s.status === 'idle' || s.status === 'stopped'}>Stop process</MenuItem>
              <MenuItem onClick={() => { close(); void invoke('sessions:archive', { id: s.id, archived: !s.archived }); }}>{s.archived ? 'Unarchive' : 'Archive'}</MenuItem>
              <MenuItem danger onClick={() => { close(); if (confirm(`Delete session "${s.title}"?${s.worktreeBranch ? '\n\nIts worktree will also be removed.' : ''}`)) void invoke('sessions:delete', { id: s.id, removeWorktree: !!s.worktreeBranch }); }}>Delete</MenuItem>
            </>
          )}
        </Dropdown>
      </div>
    </div>
  );
}
