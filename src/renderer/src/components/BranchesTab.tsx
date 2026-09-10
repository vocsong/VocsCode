/** Branches panel tab: GitHub-style branch overview plus worktree housekeeping for the session's repo. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { GitBranchOverview, GitBranchOverviewItem, GitWorktreeInfo, SessionMeta } from '../../../shared/types';
import { invoke } from '../api';
import { basename, relTime } from '../format';
import { useStore } from '../store';
import { askConfirm, Badge, Button, Dropdown, EmptyState, Icon, MenuItem, Spinner } from './ui';

/** Branches untouched for this long land in the Stale filter. */
const STALE_DAYS = 14;

type Filter = 'all' | 'stale' | 'merged';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'stale', label: 'Stale' },
  { id: 'merged', label: 'Merged' }
];

/** Trailing-separator/case-insensitive path comparison for worktree paths. */
function pathEq(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

/** True when `dir` is `cwd` itself or an ancestor of it. */
function underPath(dir: string, cwd: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  return norm(cwd) === norm(dir) || norm(cwd).startsWith(`${norm(dir)}/`);
}

export function BranchesTab({ session }: { session: SessionMeta }) {
  const toast = useStore((s) => s.toast);
  const sessions = useStore((s) => s.sessions);
  const [data, setData] = useState<GitBranchOverview | null>(null);
  const [view, setView] = useState<'branches' | 'worktrees'>('branches');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  /** The session this instance belongs to; async responses for other sessions are dropped. */
  const liveId = useRef(session.id);

  const refresh = async () => {
    const sid = session.id;
    try {
      const r = await invoke('git:branchesOverview', { sessionId: sid });
      if (liveId.current === sid) setData(r);
    } catch (e) {
      if (liveId.current === sid) toast(String((e as Error).message ?? e), 'error');
    }
  };
  useEffect(() => {
    liveId.current = session.id;
    setData(null);
    void refresh();
  }, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Sessions rooted inside a worktree — removals must respect them. */
  const sessionsIn = (wtPath: string) => sessions.filter((s) => underPath(wtPath, s.cwd)).length;
  const branchSessionCount = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sessions) if (s.worktreeBranch) map.set(s.worktreeBranch, (map.get(s.worktreeBranch) ?? 0) + 1);
    return map;
  }, [sessions]);

  const act = async (p: Promise<{ ok: boolean; error?: string; output?: string }>, done: string) => {
    const r = await p;
    if (!r.ok) toast(r.error ?? r.output ?? 'Failed', 'error');
    else {
      toast(done, 'success');
      void refresh();
    }
  };

  const deleteBranch = async (b: GitBranchOverviewItem) => {
    if (b.worktreePath) {
      toast(`Remove the worktree ${basename(b.worktreePath)} before deleting ${b.name}`, 'error');
      return;
    }
    const force = !b.merged && !b.isBase;
    const unmergedNote = force ? `\n\n${b.ahead ?? 0} commit(s) on this branch are not in ${data?.base ?? 'the base branch'} and will be lost.` : '';
    const ok = await askConfirm({
      title: `Delete branch ${b.name}?`,
      body: `Last commit ${b.lastCommitAt ? relTime(b.lastCommitAt) : 'unknown'}: ${b.lastCommitSubject ?? ''}${unmergedNote}`,
      confirmLabel: 'Delete branch',
      danger: true
    });
    if (ok) void act(invoke('git:deleteBranch', { sessionId: session.id, branch: b.name, force }), `Deleted ${b.name}`);
  };

  const removeWorktree = async (wt: GitWorktreeInfo) => {
    const n = sessionsIn(wt.path);
    if (n > 0) {
      toast(`${n} session(s) still live in ${basename(wt.path)} — delete them first`, 'error');
      return;
    }
    const ok = await askConfirm({
      title: `Remove worktree ${basename(wt.path)}?`,
      body: `${wt.path}\n\nThe directory is deleted; its branch stays and can be removed from the Branches list.`,
      confirmLabel: 'Remove worktree',
      danger: true
    });
    if (ok) void act(invoke('git:removeWorktree', { sessionId: session.id, path: wt.path }), `Removed ${basename(wt.path)}`);
  };

  const staleAt = Date.now() - STALE_DAYS * 86_400_000;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.branches ?? [])
      .filter((b) => !q || b.name.toLowerCase().includes(q))
      .filter((b) => (filter === 'stale' ? !b.isBase && (b.lastCommitAt ?? 0) < staleAt : filter === 'merged' ? b.merged && !b.isBase : true));
  }, [data, filter, query, staleAt]);

  if (data && !data.isRepo) {
    return (
      <EmptyState icon="branch" title="Not a git repository">
        Initialize git in this folder to manage branches and worktrees.
      </EmptyState>
    );
  }
  if (!data) {
    return (
      <div className="pad">
        <Spinner />
      </div>
    );
  }

  const staleCount = data.branches.filter((b) => !b.isBase && (b.lastCommitAt ?? 0) < staleAt).length;
  const mergedCount = data.branches.filter((b) => b.merged && !b.isBase).length;

  return (
    <div className="branches">
      <div className="branches-head">
        <div className="seg">
          <button type="button" className={view === 'branches' ? 'active' : ''} onClick={() => setView('branches')}>
            Branches <span className="muted">{data.branches.length}</span>
          </button>
          <button type="button" className={view === 'worktrees' ? 'active' : ''} onClick={() => setView('worktrees')}>
            Worktrees <span className="muted">{data.worktrees.length}</span>
          </button>
        </div>
        <span className="spacer" />
        <Dropdown
          align="right"
          width={230}
          trigger={() => <Button variant="ghost" size="sm" icon="more" title="Housekeeping" aria-label="Housekeeping actions" />}
        >
          {(close) => (
            <>
              <MenuItem
                onClick={() => {
                  close();
                  void act(invoke('git:pruneWorktrees', { sessionId: session.id }), 'Worktrees pruned');
                }}
                hint="Clean up deleted worktree folders"
              >
                Prune worktrees
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  void act(invoke('git:fetchPrune', { sessionId: session.id }), 'Fetched; stale remote branches pruned');
                }}
                hint="git fetch --prune"
              >
                Fetch & prune remotes
              </MenuItem>
            </>
          )}
        </Dropdown>
        <Button variant="ghost" size="sm" icon="refresh" onClick={() => void refresh()} title="Refresh" />
      </div>

      {view === 'branches' ? (
        <>
          <div className="branches-toolbar">
            <div className="branches-search">
              <Icon name="search" size={13} />
              <input placeholder="Search branches…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="branches-filters">
              {FILTERS.map((f) => (
                <button key={f.id} type="button" className={filter === f.id ? 'active' : ''} onClick={() => setFilter(f.id)}>
                  {f.label}
                  {f.id === 'stale' && staleCount > 0 && <span className="count">{staleCount}</span>}
                  {f.id === 'merged' && mergedCount > 0 && <span className="count">{mergedCount}</span>}
                </button>
              ))}
            </div>
          </div>
          <div className="branches-table">
            <div className="branches-cols">
              <span>Branch</span>
              <span>Updated</span>
              <span className="num">Behind / Ahead</span>
              <span>Status</span>
              <span />
            </div>
            {visible.map((b) => (
              <BranchRow key={b.name} b={b} onDelete={() => void deleteBranch(b)} />
            ))}
            {visible.length === 0 && <div className="muted pad">No branches match.</div>}
          </div>
        </>
      ) : (
        <div className="branches-table">
          <div className="branches-cols">
            <span>Worktree</span>
            <span>Branch</span>
            <span className="num">Sessions</span>
            <span>Status</span>
            <span />
          </div>
          {data.worktrees.map((wt) => (
            <WorktreeRow
              key={wt.path}
              wt={wt}
              current={pathEq(wt.path, session.cwd)}
              sessions={sessionsIn(wt.path)}
              branchSessions={wt.branch ? branchSessionCount.get(wt.branch) ?? 0 : 0}
              onOpen={() => void invoke('app:openInEditor', { path: wt.path })}
              onRemove={() => void removeWorktree(wt)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BranchRow({ b, onDelete }: { b: GitBranchOverviewItem; onDelete: () => void }) {
  return (
    <div className="branch-row">
      <div className="branch-name">
        <span className="mono" title={b.lastCommitSubject}>{b.name}</span>
        {b.isBase && <Badge tone="blue">Base</Badge>}
        {b.current && <Badge tone="green">Current</Badge>}
        {b.worktreePath && (
          <span className="branch-wt" title={`Worktree: ${b.worktreePath}`}>
            <Icon name="folder" size={11} /> {basename(b.worktreePath)}
          </span>
        )}
      </div>
      <span className="muted small">{b.lastCommitAt ? relTime(b.lastCommitAt) : '—'}</span>
      <span className="num small mono">
        {b.isBase ? (
          <span className="muted">—</span>
        ) : (
          <>
            {b.behind ? <span className="behind">↓{b.behind}</span> : <span className="muted">0</span>}
            <span className="muted"> / </span>
            {b.ahead ? <span className="ahead">↑{b.ahead}</span> : <span className="muted">0</span>}
          </>
        )}
      </span>
      <span className="branch-status">
        {b.merged ? <Badge tone="purple">Merged</Badge> : <Badge tone="amber">Unmerged</Badge>}
        {b.upstream && b.upstreamBehind !== undefined && <span className="muted small" title={`Behind ${b.upstream}`}>↓{b.upstreamBehind}</span>}
        {b.upstream && b.upstreamAhead !== undefined && <span className="muted small" title={`Ahead of ${b.upstream}`}>↑{b.upstreamAhead}</span>}
        {b.upstream && b.upstreamAhead === undefined && b.upstreamBehind === undefined && <span className="muted small" title={b.upstream}>synced</span>}
      </span>
      <div className="branch-actions">
        {b.worktreePath && (
          <Button variant="ghost" size="sm" icon="external" title={`Open worktree ${basename(b.worktreePath)}`} onClick={() => void invoke('app:openInEditor', { path: b.worktreePath! })} />
        )}
        {!b.isBase && !b.current && (
          <Button
            variant="ghost"
            size="sm"
            icon="trash"
            title={b.worktreePath ? 'Remove the worktree first' : b.merged ? 'Delete branch (merged — safe)' : 'Force-delete branch (unmerged)'}
            onClick={onDelete}
          />
        )}
      </div>
    </div>
  );
}

function WorktreeRow({
  wt,
  current,
  sessions,
  branchSessions,
  onOpen,
  onRemove
}: {
  wt: GitWorktreeInfo;
  current: boolean;
  sessions: number;
  branchSessions: number;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const busy = sessions > 0 || branchSessions > 0;
  return (
    <div className="branch-row">
      <div className="branch-name">
        <Icon name="folder" size={12} />
        <span className="mono" title={wt.path}>{basename(wt.path)}</span>
        {current && <Badge tone="green">This session</Badge>}
      </div>
      <span className="muted small mono">{wt.detached ? 'detached' : wt.branch ?? '—'}</span>
      <span className="num small">{sessions + branchSessions || <span className="muted">0</span>}</span>
      <span className="branch-status">{busy ? <Badge tone="blue">In use</Badge> : <Badge tone="neutral">Idle</Badge>}</span>
      <div className="branch-actions">
        <Button variant="ghost" size="sm" icon="external" title="Open worktree folder in editor" onClick={onOpen} />
        {!current && !wt.detached && (
          <Button variant="ghost" size="sm" icon="trash" title={busy ? 'Sessions still use this worktree' : 'Remove worktree (branch stays)'} disabled={busy} onClick={onRemove} />
        )}
      </div>
    </div>
  );
}