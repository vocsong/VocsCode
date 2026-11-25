/** Git panel GitHub views: pull requests and issues lists pulled via gh. */
import React, { useMemo } from 'react';
import type { GitIssue, GitIssueList, GitPullRequest, GitPullRequestList } from '../../../../shared/types';
import { relTime } from '../../format';
import { Badge, Button, Icon, Spinner } from '../ui';

export type PrFilter = 'open' | 'merged' | 'closed' | 'all';
export type IssueFilter = 'open' | 'closed' | 'all';

const PR_FILTERS: { id: PrFilter; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'merged', label: 'Merged' },
  { id: 'closed', label: 'Closed' },
  { id: 'all', label: 'All' }
];

const ISSUE_FILTERS: { id: IssueFilter; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'closed', label: 'Closed' },
  { id: 'all', label: 'All' }
];

function GitHubListStatus({
  data,
  noun,
  onRefresh
}: {
  data: { ghMissing?: boolean; error?: string } | null;
  noun: 'PR' | 'issue';
  onRefresh: () => void;
}) {
  return (
    <>
      {data?.ghMissing && (
        <div className="muted small pad">GitHub CLI (gh) not found — the {noun} list needs it. Install gh and run `gh auth login`.</div>
      )}
      {data?.error && (
        <div className="pad small">
          <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>
            Could not pull the {noun} list from GitHub: {data.error}
          </div>
          <Button variant="ghost" size="sm" icon="refresh" onClick={onRefresh}>
            Try again
          </Button>
        </div>
      )}
      {!data && (
        <div className="pad">
          <Spinner />
        </div>
      )}
    </>
  );
}

export function PrList({
  data,
  loading,
  filter,
  setFilter,
  query,
  setQuery,
  onRefresh,
  onOpen,
  onView,
  onNewSession
}: {
  data: GitPullRequestList | null;
  loading: boolean;
  filter: PrFilter;
  setFilter: (f: PrFilter) => void;
  query: string;
  setQuery: (q: string) => void;
  onRefresh: () => void;
  onOpen: (pr: GitPullRequest) => void;
  onView: (pr: GitPullRequest) => void;
  onNewSession: (pr: GitPullRequest) => void;
}) {
  const prs = data?.prs ?? [];
  const counts = useMemo(() => {
    let open = 0;
    let merged = 0;
    let closed = 0;
    for (const p of prs) {
      if (p.state === 'OPEN') open++;
      else if (p.state === 'MERGED') merged++;
      else if (p.state === 'CLOSED') closed++;
    }
    return { open, merged, closed, all: prs.length };
  }, [prs]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return prs
      .filter((p) => (filter === 'all' ? true : p.state === filter.toUpperCase()))
      .filter((p) => !q || p.title.toLowerCase().includes(q) || `#${p.number}`.includes(q) || (p.headRefName ?? '').toLowerCase().includes(q) || (p.author ?? '').toLowerCase().includes(q));
  }, [prs, filter, query]);

  return (
    <>
      <div className="branches-toolbar">
        <div className="branches-search">
          <Icon name="search" size={13} />
          <input placeholder="Search PRs (title, #number, branch, author)…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="branches-filters">
          {PR_FILTERS.map((f) => (
            <button key={f.id} type="button" className={filter === f.id ? 'active' : ''} onClick={() => setFilter(f.id)}>
              {f.label}
              {data && counts[f.id] > 0 && <span className="count">{counts[f.id]}</span>}
            </button>
          ))}
        </div>
        {data && !data.error && !data.ghMissing && (
          <span className="pr-pulled" title={`${new Date(data.fetchedAt).toLocaleString()} — refreshed automatically every minute`}>
            {loading ? 'Pulling from GitHub…' : `Pulled ${relTime(data.fetchedAt)}`}
          </span>
        )}
      </div>
      <GitHubListStatus data={data} noun="PR" onRefresh={onRefresh} />
      {data && !data.error && !data.ghMissing && (
        <div className="branches-table">
          <div className="branches-cols pr-cols">
            <span>#</span>
            <span>Pull request</span>
            <span>Author</span>
            <span>Updated</span>
            <span>Status</span>
            <span className="num">Actions</span>
          </div>
          {visible.map((pr) => (
            <PrRow
              key={pr.number}
              pr={pr}
              onOpen={() => onOpen(pr)}
              onView={() => onView(pr)}
              onNewSession={() => onNewSession(pr)}
            />
          ))}
          {visible.length === 0 && <div className="muted pad">{prs.length === 0 ? 'No pull requests on GitHub for this repo.' : 'No pull requests match.'}</div>}
        </div>
      )}
    </>
  );
}

function PrRow({
  pr,
  onOpen,
  onView,
  onNewSession
}: {
  pr: GitPullRequest;
  onOpen: () => void;
  onView: () => void;
  onNewSession: () => void;
}) {
  const open = pr.state === 'OPEN';
  const review = pr.reviewDecision === 'APPROVED' ? 'approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes requested' : undefined;
  const diffStat = pr.additions !== undefined || pr.deletions !== undefined ? `+${pr.additions ?? 0} −${pr.deletions ?? 0}` : undefined;
  // Clicking anywhere but the actions opens the detail dialog, same as an issue row.
  const onRowClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('.branch-actions') || target.closest('.pr-open')) return;
    onOpen();
  };
  return (
    <div className="branch-row pr-row" onClick={onRowClick}>
      <span className="pr-num mono" title={`Pull request #${pr.number}`}>
        #{pr.number}
      </span>
      <button type="button" className="pr-title pr-open" aria-label={`Read pull request #${pr.number}: ${pr.title}`} onClick={onOpen}>
        <span className="pr-head">
          <span title={pr.title}>{pr.title}</span>
        </span>
        <span className="pr-refs mono" title={`${pr.headRefName ?? '?'} → ${pr.baseRefName ?? '?'}`}>
          {pr.headRefName ?? '?'} → {pr.baseRefName ?? '?'}
          {diffStat && <span className="muted"> · {diffStat}</span>}
        </span>
      </button>
      <span className="pr-author muted small" title={pr.author}>
        {pr.author ?? '—'}
      </span>
      <span className="muted small" title={pr.updatedAt ? new Date(pr.updatedAt).toLocaleString() : undefined}>
        {pr.updatedAt ? relTime(pr.updatedAt) : '—'}
      </span>
      <span className="branch-status">
        {open ? (
          pr.isDraft ? (
            <Badge tone="neutral">Draft</Badge>
          ) : (
            <Badge tone="blue">Open</Badge>
          )
        ) : pr.state === 'MERGED' ? (
          <Badge tone="purple">Merged</Badge>
        ) : (
          <Badge tone="neutral">Closed</Badge>
        )}
        {open && review && (
          <span className={`small ${pr.reviewDecision === 'APPROVED' ? 'ahead' : 'behind'}`} title={`Review: ${review}`}>
            {review}
          </span>
        )}
      </span>
      <div className="branch-actions">
        <Button variant="ghost" size="sm" icon="external" title={`Open PR #${pr.number} on GitHub`} onClick={onView} />
        <Button
          variant="ghost"
          size="sm"
          icon="sessionPlus"
          title={`Start a new session on this repo to review PR #${pr.number}`}
          aria-label={`New session to review PR #${pr.number}`}
          onClick={onNewSession}
        />
      </div>
    </div>
  );
}

export function IssueList({
  data,
  loading,
  filter,
  setFilter,
  query,
  setQuery,
  onRefresh,
  onOpen,
  onViewExternal,
  onNewSession
}: {
  data: GitIssueList | null;
  loading: boolean;
  filter: IssueFilter;
  setFilter: (f: IssueFilter) => void;
  query: string;
  setQuery: (q: string) => void;
  onRefresh: () => void;
  onOpen: (issue: GitIssue) => void;
  onViewExternal: (issue: GitIssue) => void;
  onNewSession: (issue: GitIssue) => void;
}) {
  const issues = data?.issues ?? [];
  const counts = useMemo(() => {
    let open = 0;
    let closed = 0;
    for (const i of issues) {
      if (i.state === 'OPEN') open++;
      else if (i.state === 'CLOSED') closed++;
    }
    return { open, closed, all: issues.length };
  }, [issues]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return issues
      .filter((i) => (filter === 'all' ? true : i.state === filter.toUpperCase()))
      .filter((i) => !q || i.title.toLowerCase().includes(q) || `#${i.number}`.includes(q) || (i.author ?? '').toLowerCase().includes(q) || (i.labels ?? []).some((l) => l.name.toLowerCase().includes(q)));
  }, [issues, filter, query]);

  return (
    <>
      <div className="branches-toolbar">
        <div className="branches-search">
          <Icon name="search" size={13} />
          <input placeholder="Search issues (title, #number, author, label)…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="branches-filters">
          {ISSUE_FILTERS.map((f) => (
            <button key={f.id} type="button" className={filter === f.id ? 'active' : ''} onClick={() => setFilter(f.id)}>
              {f.label}
              {data && counts[f.id] > 0 && <span className="count">{counts[f.id]}</span>}
            </button>
          ))}
        </div>
        {data && !data.error && !data.ghMissing && (
          <span className="pr-pulled" title={`${new Date(data.fetchedAt).toLocaleString()} — refreshed automatically every minute`}>
            {loading ? 'Pulling from GitHub…' : `Pulled ${relTime(data.fetchedAt)}`}
          </span>
        )}
      </div>
      <GitHubListStatus data={data} noun="issue" onRefresh={onRefresh} />
      {data && !data.error && !data.ghMissing && (
        <div className="branches-table">
          <div className="branches-cols issue-cols">
            <span>#</span>
            <span>Issue</span>
            <span>Author</span>
            <span className="num">Actions</span>
          </div>
          {visible.map((issue) => (
            <IssueRow
              key={issue.number}
              issue={issue}
              onOpen={() => onOpen(issue)}
              onViewExternal={() => onViewExternal(issue)}
              onNewSession={() => onNewSession(issue)}
            />
          ))}
          {visible.length === 0 && <div className="muted pad">{issues.length === 0 ? 'No issues on GitHub for this repo.' : 'No issues match.'}</div>}
        </div>
      )}
    </>
  );
}

function IssueRow({ issue, onOpen, onViewExternal, onNewSession }: { issue: GitIssue; onOpen: () => void; onViewExternal: () => void; onNewSession: () => void }) {
  const onRowClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('.branch-actions') || target.closest('.issue-open')) return;
    onOpen();
  };
  return (
    <div className="branch-row pr-row issue-row" onClick={onRowClick}>
      <span className="issue-num mono" title={`Issue #${issue.number}`}>
        #{issue.number}
      </span>
      <button type="button" className="pr-title issue-open" aria-label={`Read issue #${issue.number}: ${issue.title}`} onClick={onOpen}>
        <span className="pr-head">
          <span className="issue-title" title={issue.title}>
            {issue.title}
          </span>
        </span>
        {(issue.labels?.length || issue.comments) && (
          <span className="pr-refs">
            {(issue.labels ?? []).slice(0, 4).map((l) => (
              <Badge key={l.name} tone="neutral" title={`Label: ${l.name}`}>
                {l.name}
              </Badge>
            ))}
            {!!issue.comments && <span className="muted small">{issue.comments} comment{issue.comments === 1 ? '' : 's'}</span>}
          </span>
        )}
      </button>
      <span className="pr-author muted small" title={issue.author}>
        {issue.author ?? '—'}
      </span>
      <div className="branch-actions">
        <Button variant="ghost" size="sm" icon="external" title={`Open issue #${issue.number} on GitHub`} onClick={onViewExternal} />
        <Button
          variant="ghost"
          size="sm"
          icon="sessionPlus"
          title={`Start a new session on this repo to fix issue #${issue.number}`}
          aria-label={`New session on issue #${issue.number}`}
          onClick={onNewSession}
        />
      </div>
    </div>
  );
}
