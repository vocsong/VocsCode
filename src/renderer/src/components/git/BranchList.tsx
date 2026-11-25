/** Git panel Branches view: search/filter toolbar and per-branch row actions. */
import React, { useMemo } from 'react';
import type { GitBranchOverview, GitBranchOverviewItem } from '../../../../shared/types';
import { invoke } from '../../api';
import { basename, relTime } from '../../format';
import { Badge, Button, Dropdown, Icon, MenuItem } from '../ui';

/** Branches untouched for this long land in the Stale filter. */
export const STALE_DAYS = 14;

export type BranchFilter = 'all' | 'stale' | 'merged';

const FILTERS: { id: BranchFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'stale', label: 'Stale' },
  { id: 'merged', label: 'Merged' }
];

export function BranchList({
  data,
  sessionId,
  filter,
  setFilter,
  query,
  setQuery,
  onDelete,
  onOpenPr,
  onViewPr,
  onMergePr,
  onUpdate,
  onCopy,
  onNewSession,
  onAskAgent
}: {
  data: GitBranchOverview;
  sessionId: string;
  filter: BranchFilter;
  setFilter: (f: BranchFilter) => void;
  query: string;
  setQuery: (q: string) => void;
  onDelete: (b: GitBranchOverviewItem) => void;
  onOpenPr: (b: GitBranchOverviewItem) => void;
  onViewPr: (b: GitBranchOverviewItem) => void;
  onMergePr: (b: GitBranchOverviewItem) => void;
  onUpdate: (b: GitBranchOverviewItem) => void;
  onCopy: (b: GitBranchOverviewItem) => void;
  onNewSession: (b: GitBranchOverviewItem) => void;
  onAskAgent: (b: GitBranchOverviewItem) => void;
}) {
  // Anchor the stale cutoff to the snapshot rather than recomputing Date.now() every render.
  const staleAt = useMemo(() => Date.now() - STALE_DAYS * 86_400_000, [data]);
  const { staleCount, mergedCount } = useMemo(() => {
    let stale = 0;
    let merged = 0;
    for (const b of data.branches) {
      if (b.isBase) continue;
      if ((b.lastCommitAt ?? 0) < staleAt) stale++;
      if (b.merged) merged++;
    }
    return { staleCount: stale, mergedCount: merged };
  }, [data, staleAt]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.branches
      .filter((b) => !q || b.name.toLowerCase().includes(q))
      .filter((b) => (filter === 'stale' ? !b.isBase && (b.lastCommitAt ?? 0) < staleAt : filter === 'merged' ? b.merged && !b.isBase : true));
  }, [data, filter, query, staleAt]);

  return (
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
      {data.ghMissing && (
        <div className="muted small pad" title="PR actions need the GitHub CLI">
          GitHub CLI (gh) not found — PR actions are hidden. Install gh and run `gh auth login`.
        </div>
      )}
      <div className="branches-table">
        <div className="branches-cols">
          <span>Branch</span>
          <span>Updated</span>
          <span>Behind/Ahead</span>
          <span>Status</span>
          <span className="num">Actions</span>
        </div>
        {visible.map((b) => (
          <BranchRow
            key={b.name}
            b={b}
            sessionId={sessionId}
            base={data.base}
            ghMissing={data.ghMissing}
            onDelete={() => onDelete(b)}
            onOpenPr={() => onOpenPr(b)}
            onViewPr={() => onViewPr(b)}
            onMergePr={() => onMergePr(b)}
            onUpdate={() => onUpdate(b)}
            onCopy={() => onCopy(b)}
            onNewSession={() => onNewSession(b)}
            onAskAgent={() => onAskAgent(b)}
          />
        ))}
        {visible.length === 0 && <div className="muted pad">No branches match.</div>}
      </div>
    </>
  );
}

function BranchRow({
  b,
  sessionId,
  base,
  ghMissing,
  onDelete,
  onOpenPr,
  onViewPr,
  onMergePr,
  onUpdate,
  onCopy,
  onNewSession,
  onAskAgent
}: {
  b: GitBranchOverviewItem;
  sessionId: string;
  base?: string;
  ghMissing?: boolean;
  onDelete: () => void;
  onOpenPr: () => void;
  onViewPr: () => void;
  onMergePr: () => void;
  onUpdate: () => void;
  onCopy: () => void;
  onNewSession: () => void;
  onAskAgent: () => void;
}) {
  const pr = b.pr;
  const hasOpenPr = pr?.state === 'OPEN';
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
      <span className="small mono">
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
        {b.upstreamGone && (
          <Badge tone="red" title={`${b.upstream} is gone from the server — this branch exists only in this checkout. Its work is not lost; delete it here when it is merged.`}>
            Deleted on origin
          </Badge>
        )}
        {pr ? (
          <Badge
            tone={pr.state === 'OPEN' ? 'blue' : pr.state === 'MERGED' ? 'purple' : 'neutral'}
            title={pr.title ? `#${pr.number}: ${pr.title}` : `#${pr.number}`}
          >
            {pr.state === 'OPEN' ? `PR #${pr.number}` : pr.state === 'MERGED' ? 'PR merged' : 'PR closed'}
          </Badge>
        ) : b.merged ? (
          <Badge tone="purple">Merged</Badge>
        ) : (
          <Badge tone="amber">Unmerged</Badge>
        )}
        {b.upstream && b.upstreamBehind !== undefined && <span className="muted small" title={`Behind ${b.upstream}`}>↓{b.upstreamBehind}</span>}
        {b.upstream && b.upstreamAhead !== undefined && <span className="muted small" title={`Ahead of ${b.upstream}`}>↑{b.upstreamAhead}</span>}
        {b.upstream && !b.upstreamGone && b.upstreamAhead === undefined && b.upstreamBehind === undefined && <span className="muted small" title={b.upstream}>synced</span>}
      </span>
      <div className="branch-actions">
        <span className="branch-inline">
          {b.worktreePath && (
            <Button variant="ghost" size="sm" icon="external" title={`Open worktree ${basename(b.worktreePath)}`} onClick={() => void invoke('app:openInEditor', { path: b.worktreePath!, sessionId })} />
          )}
          {!ghMissing && !b.isBase &&
            (hasOpenPr ? (
              <Button variant="ghost" size="sm" icon="external" title={`Open PR #${pr!.number} on GitHub`} onClick={onViewPr} />
            ) : (
              <Button variant="ghost" size="sm" icon="pr" title={`Open a PR from ${b.name} into ${base ?? 'the base branch'}`} onClick={onOpenPr} />
            ))}
          {!b.isBase && !b.current && (
            <Button
              variant="ghost"
              size="sm"
              icon="trash"
              title={b.worktreePath ? 'Remove the worktree first' : b.merged ? 'Delete branch (merged — safe)' : 'Force-delete branch (unmerged)'}
              onClick={onDelete}
            />
          )}
        </span>
        <Dropdown
          align="right"
          width={260}
          trigger={() => <Button variant="ghost" size="sm" icon="more" title="Branch actions" aria-label={`Actions for ${b.name}`} />}
        >
          {(close) => (
            <>
              {b.worktreePath && (
                <MenuItem
                  onClick={() => {
                    close();
                    void invoke('app:openInEditor', { path: b.worktreePath!, sessionId });
                  }}
                  hint={basename(b.worktreePath)}
                >
                  Open worktree in editor
                </MenuItem>
              )}
              <MenuItem
                onClick={() => {
                  close();
                  onAskAgent();
                }}
                hint="Prefill the composer"
              >
                Ask the agent about this branch
              </MenuItem>
              {!ghMissing && !b.isBase && (
                <MenuItem
                  onClick={() => {
                    close();
                    onOpenPr();
                  }}
                  hint={`into ${base ?? 'base'}`}
                >
                  Open PR
                </MenuItem>
              )}
              <MenuItem
                disabled={!hasOpenPr}
                onClick={() => {
                  close();
                  onViewPr();
                }}
                hint={hasOpenPr ? `#${pr!.number}` : undefined}
              >
                View PR on GitHub
              </MenuItem>
              <MenuItem
                disabled={!hasOpenPr}
                onClick={() => {
                  close();
                  void onMergePr();
                }}
              >
                Merge PR
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  onUpdate();
                }}
                hint="git fetch + fast-forward"
              >
                Update from origin
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  onCopy();
                }}
              >
                Copy branch name
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  void onNewSession();
                }}
                hint="isolated worktree"
              >
                New session on this branch
              </MenuItem>
              {!b.isBase && !b.current && (
                <MenuItem
                  danger
                  disabled={!!b.worktreePath}
                  onClick={() => {
                    close();
                    onDelete();
                  }}
                  hint={b.worktreePath ? 'remove worktree first' : undefined}
                >
                  Delete branch
                </MenuItem>
              )}
            </>
          )}
        </Dropdown>
      </div>
    </div>
  );
}
