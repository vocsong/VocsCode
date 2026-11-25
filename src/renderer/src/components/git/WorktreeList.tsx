/** Git panel Worktrees view: lists checkout worktrees and guards removal while sessions are live in them. */
import React, { useMemo } from 'react';
import type { GitWorktreeInfo } from '../../../../shared/types';
import { invoke } from '../../api';
import { basename } from '../../format';
import { useStore } from '../../store';
import { askConfirm, Badge, Button, Icon } from '../ui';

/** Trailing-separator/case-insensitive path comparison for worktree paths. */
export function pathEq(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

/** True when `dir` is `cwd` itself or an ancestor of it. */
export function underPath(dir: string, cwd: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  return norm(cwd) === norm(dir) || norm(cwd).startsWith(`${norm(dir)}/`);
}

export function WorktreeList({
  sessionId,
  cwd,
  worktrees,
  onAct
}: {
  sessionId: string;
  cwd: string;
  worktrees: GitWorktreeInfo[];
  onAct: (p: Promise<{ ok: boolean; error?: string; output?: string }>, done: string) => Promise<void>;
}) {
  const sessions = useStore((s) => s.sessions);
  const toast = useStore((s) => s.toast);

  /** Sessions rooted inside a worktree — removals must respect them. */
  const sessionsIn = (wtPath: string) => sessions.filter((s) => underPath(wtPath, s.cwd)).length;
  const branchSessionCount = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sessions) if (s.worktreeBranch) map.set(s.worktreeBranch, (map.get(s.worktreeBranch) ?? 0) + 1);
    return map;
  }, [sessions]);

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
    if (ok) void onAct(invoke('git:removeWorktree', { sessionId, path: wt.path }), `Removed ${basename(wt.path)}`);
  };

  return (
    <div className="branches-table">
      <div className="branches-cols">
        <span>Worktree</span>
        <span>Branch</span>
        <span>Sessions</span>
        <span>Status</span>
        <span className="num">Actions</span>
      </div>
      {worktrees.map((wt) => (
        <WorktreeRow
          key={wt.path}
          wt={wt}
          current={pathEq(wt.path, cwd)}
          sessions={sessionsIn(wt.path)}
          branchSessions={wt.branch ? branchSessionCount.get(wt.branch) ?? 0 : 0}
          onOpen={() => void invoke('app:openInEditor', { path: wt.path, sessionId })}
          onRemove={() => void removeWorktree(wt)}
        />
      ))}
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
      <span className="small">{sessions + branchSessions || <span className="muted">0</span>}</span>
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
