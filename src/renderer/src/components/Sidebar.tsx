/** Session list grouped by project, with live status badges per harness. */
import React, { useMemo, useState } from 'react';
import type { SessionMeta } from '../../../shared/types';
import { HARNESS_BY_ID } from '../../../shared/harness-meta';
import { invoke } from '../api';
import { basename, fmtCost, relTime } from '../format';
import { useStore } from '../store';
import { Resizer } from './Resizer';
import { FolderBranch } from './FolderBranch';
import { askConfirm, Badge, Button, Dropdown, Icon, MenuItem, StatusLabel } from './ui';

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

/** Icon choices for folder headers (names from the renderer icon set). */
const FOLDER_ICONS = [
  'folder', 'bolt', 'brain', 'shield', 'star', 'sparkles', 'target', 'branch', 'terminal', 'chart',
  'play', 'file', 'code', 'bug', 'wrench', 'rocket', 'globe', 'lock', 'key', 'cpu',
  'database', 'cloud', 'fire', 'cube', 'layers', 'box', 'flag', 'bulb', 'link', 'map',
  'moon', 'sun', 'palette', 'puzzle', 'robot', 'server', 'tag', 'heart', 'home', 'book',
  'mail', 'bell', 'coffee', 'music', 'camera', 'video', 'gamepad', 'leaf', 'compass', 'gift'
] as const;
/** Swatch palette for folder headers. */
const FOLDER_COLORS = [
  '#5b9bf8', '#2563eb', '#0ea5e9', '#22d3ee', '#2dd4bf', '#34d399', '#4ade80', '#84cc16',
  '#a3e635', '#fbbf24', '#facc15', '#fb923c', '#f97316', '#f87171', '#ef4444', '#fb7185',
  '#f472b6', '#e879f9', '#c084fc', '#a78bfa', '#818cf8', '#94a3b8', '#64748b', '#e2e8f0'
] as const;

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const settings = useStore((s) => s.settings);
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
    const groups = [...byProject.entries()]
      .map(([root, list]) => ({ root, list: list.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt) }))
      .sort((a, b) => Math.max(...b.list.map((x) => x.updatedAt)) - Math.max(...a.list.map((x) => x.updatedAt)));
    if (!showArchived) {
      // A folder whose last active session was archived or deleted stays listed so a new
      // session can still be added to it; empty folders sort alphabetically at the bottom.
      const empties = (settings?.folders ?? [])
        .filter((root) => !byProject.has(root) && (!q || root.toLowerCase().includes(q)))
        .sort((a, b) => basename(a).localeCompare(basename(b)))
        .map((root) => ({ root, list: [] as SessionMeta[] }));
      groups.push(...empties);
    }
    return groups;
  }, [sessions, settings, query, showArchived]);

  const folderStyles = settings?.folderStyles ?? {};

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
          {awaiting > 0 && <Badge tone="red">{awaiting} awaiting approval</Badge>}
          {running > 0 && <Badge tone="blue">{running} running</Badge>}
        </div>
      )}
      <div className="sidebar-list">
        {groups.length === 0 && <div className="sidebar-empty">{showArchived ? 'No archived sessions.' : 'No sessions yet. Create one to start.'}</div>}
        {groups.map((g) => (
          <div key={g.root} className="project-group">
            <div className="project-header" title={g.root}>
              <FolderStyleButton root={g.root} style={folderStyles[g.root]} onPick={(patch) => {
                const next = { ...folderStyles };
                if (patch) next[g.root] = { ...next[g.root], ...patch };
                else delete next[g.root];
                void invoke('settings:update', { folderStyles: next });
              }} />
              <span
                className={`project-title ${folderStyles[g.root]?.color ? 'colored' : ''}`}
                style={folderStyles[g.root]?.color ? { color: folderStyles[g.root].color } : undefined}
              >
                {basename(g.root)}
              </span>
              <FolderBranch root={g.root} />
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
        <button type="button" className={`sidebar-link ${view === 'skills' ? 'active' : ''}`} onClick={() => setView('skills')}>
          <Icon name="puzzle" size={14} /> Skills
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
          {s.worktreeBranch && (
            <span className="session-worktree" title={`Worktree · ${s.worktreeBranch}`}>
              <Icon name="branch" size={12} />
              <span className="session-worktree-name">{s.worktreeBranch}</span>
            </span>
          )}
          {(s.queued ?? 0) > 0 && <span className="session-queued">+{s.queued}</span>}
        </div>
      </div>
      <StatusLabel status={s.status} />
      <div onClick={(e) => e.stopPropagation()}>
        <Dropdown align="right" width={220} trigger={() => <button type="button" className="row-menu-btn" aria-label="Session menu"><Icon name="more" size={18} /></button>}>
          {(close) => (
            <>
              <MenuItem onClick={() => { close(); startRename(); }}>Rename</MenuItem>
              <MenuItem onClick={() => { close(); void invoke('sessions:pin', { id: s.id, pinned: !s.pinned }); }}>{s.pinned ? 'Unpin' : 'Pin'}</MenuItem>
              <MenuItem onClick={async () => { close(); const f = await invoke('sessions:fork', { id: s.id }); if (f) toast('Forked session created', 'success'); }}>Fork</MenuItem>
              <MenuItem onClick={() => { close(); void invoke('app:openPath', { path: s.cwd, sessionId: s.id }); }}>Open folder</MenuItem>
              <MenuItem onClick={() => { close(); void invoke('sessions:stop', { id: s.id }); }} disabled={s.status === 'idle' || s.status === 'stopped'}>Stop process</MenuItem>
              <MenuItem
                onClick={async () => {
                  close();
                  if (s.archived) {
                    void invoke('sessions:archive', { id: s.id, archived: false });
                    return;
                  }
                  if (s.worktreeBranch) {
                    const ok = await askConfirm({
                      title: `Remove the worktree for "${s.title}"?`,
                      body: `The worktree folder is deleted; uncommitted changes block this. The branch ${s.worktreeBranch} is kept — unarchiving recreates the worktree.`,
                      confirmLabel: 'Archive & remove',
                      danger: true
                    });
                    if (!ok) return;
                    try {
                      await invoke('sessions:archive', { id: s.id, archived: true, removeWorktree: true });
                      toast('Worktree removed; the branch is kept', 'success');
                    } catch (e) {
                      toast(e instanceof Error ? e.message : String(e), 'error');
                    }
                    return;
                  }
                  void invoke('sessions:archive', { id: s.id, archived: true });
                }}
              >
                {s.archived ? 'Unarchive' : s.worktreeBranch ? 'Archive & remove worktree' : 'Archive'}
              </MenuItem>
              <MenuItem
                danger
                onClick={async () => {
                  close();
                  const ok = await askConfirm({
                    title: `Delete session "${s.title}"?`,
                    body: s.worktreeBranch
                      ? `Its worktree and the branch ${s.worktreeBranch} are removed with it.`
                      : 'Its transcript is removed. This cannot be undone.',
                    confirmLabel: 'Delete',
                    danger: true
                  });
                  if (ok) void invoke('sessions:delete', { id: s.id, removeWorktree: !!s.worktreeBranch });
                }}
              >
                Delete
              </MenuItem>
            </>
          )}
        </Dropdown>
      </div>
    </div>
  );
}

/** Folder icon button opening a popover to pick the folder's icon and color. */
function FolderStyleButton({ root, style, onPick }: { root: string; style?: { color?: string; icon?: string }; onPick: (patch?: { color?: string; icon?: string }) => void }) {
  const name = basename(root);
  return (
    <Dropdown align="left" width={240} trigger={() => (
      <button
        type="button"
        className="project-icon-btn"
        style={style?.color ? { color: style.color } : undefined}
        title={`Customize ${name}`}
        aria-label={`Customize ${name}`}
      >
        <Icon name={style?.icon ?? 'folder'} size={13} />
      </button>
    )}>
      {() => (
        <div className="folder-style-picker">
          <div className="picker-label">Icon</div>
          <div className="picker-grid">
            {FOLDER_ICONS.map((n) => (
              <button
                key={n}
                type="button"
                className={`picker-opt ${style?.icon === n ? 'active' : ''}`}
                title={n}
                aria-label={`Icon ${n}`}
                onClick={() => onPick({ icon: n })}
              >
                <Icon name={n} size={14} />
              </button>
            ))}
          </div>
          <div className="picker-label">Color</div>
          <div className="picker-grid">
            {FOLDER_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`picker-swatch ${style?.color === c ? 'active' : ''}`}
                style={{ background: c }}
                title={c}
                aria-label={`Color ${c}`}
                onClick={() => onPick({ color: c })}
              />
            ))}
          </div>
          <MenuItem onClick={() => onPick(undefined)}>Reset to default</MenuItem>
        </div>
      )}
    </Dropdown>
  );
}
