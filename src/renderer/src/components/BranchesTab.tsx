/** Git panel tab: GitHub-style branch overview, worktree housekeeping and the repo's pull requests (pulled via gh). */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { GitBranchOverview, GitBranchOverviewItem, GitPullRequest, GitPullRequestList, GitWorktreeInfo, SessionMeta } from '../../../shared/types';
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

type View = 'branches' | 'worktrees' | 'prs';
type PrFilter = 'open' | 'merged' | 'closed' | 'all';

const PR_FILTERS: { id: PrFilter; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'merged', label: 'Merged' },
  { id: 'closed', label: 'Closed' },
  { id: 'all', label: 'All' }
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
  const setActive = useStore((s) => s.setActive);
  const [data, setData] = useState<GitBranchOverview | null>(null);
  const [view, setView] = useState<View>('branches');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  /** Pull requests are pulled from GitHub separately (slower, needs gh) and only once the PR view is opened. */
  const [prData, setPrData] = useState<GitPullRequestList | null>(null);
  const [prLoading, setPrLoading] = useState(false);
  const [prFilter, setPrFilter] = useState<PrFilter>('open');
  const [prQuery, setPrQuery] = useState('');
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
  const refreshPrs = async () => {
    const sid = session.id;
    setPrLoading(true);
    try {
      const r = await invoke('git:pullRequests', { sessionId: sid });
      if (liveId.current === sid) setPrData(r);
    } catch (e) {
      if (liveId.current === sid) toast(String((e as Error).message ?? e), 'error');
    } finally {
      if (liveId.current === sid) setPrLoading(false);
    }
  };
  useEffect(() => {
    liveId.current = session.id;
    setData(null);
    setPrData(null);
    void refresh();
    if (view === 'prs') void refreshPrs();
  }, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (view === 'prs' && !prData && !prLoading) void refreshPrs();
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

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

  /** The outcome is also recorded as a persistent note in this session's chat transcript. */
  const runPr = (b: GitBranchOverviewItem) => {
    if (!data?.base) return;
    const noteId = `local-bpr-${session.id}`;
    useStore.getState().setLocalInfo(session.id, noteId, `Opening a PR from ${b.name} into ${data.base}…`, { pending: true });
    void invoke('git:pr', { sessionId: session.id, base: data.base, head: b.name })
      .catch((e): { ok: boolean; url?: string; output?: string } => ({ ok: false, output: String((e as Error).message ?? e) }))
      .then((r) => {
        useStore.getState().setLocalInfo(session.id, noteId, null);
        if (!r.ok) toast(r.output ?? 'Failed to open the PR', 'error');
        else toast(`PR opened: ${r.url ?? data.base}`, 'success');
        void refresh();
      });
  };

  const mergePr = async (b: GitBranchOverviewItem) => {
    if (!b.pr) return;
    const ok = await askConfirm({
      title: `Merge the PR for ${b.name}?`,
      body: `Merge #${b.pr.number} into its target branch via gh.\n\n${b.pr.title ?? ''}`.trim(),
      confirmLabel: 'Merge PR'
    });
    if (!ok) return;
    void act(invoke('git:merge', { sessionId: session.id, head: b.name }), `Merged ${b.name}`);
  };

  /** Merging from the PR list goes through the same gh path, pinned to the PR's head branch; both lists are refreshed after. */
  const mergeListedPr = async (pr: GitPullRequest) => {
    if (!pr.headRefName) return;
    const ok = await askConfirm({
      title: `Merge PR #${pr.number}?`,
      body: `${pr.title}\n\n${pr.headRefName} → ${pr.baseRefName ?? 'its target branch'}, via gh.`.trim(),
      confirmLabel: 'Merge PR'
    });
    if (!ok) return;
    const r = await invoke('git:merge', { sessionId: session.id, head: pr.headRefName });
    if (!r.ok) toast(r.output ?? 'Failed to merge the PR', 'error');
    else {
      toast(`Merged #${pr.number}`, 'success');
      void refresh();
      void refreshPrs();
    }
  };

  /** Prefills the composer with the PR so the agent can review it without leaving the desk. */
  const askAgentAboutPr = (pr: GitPullRequest) => {
    useStore.getState().insertIntoComposer(
      `Review pull request #${pr.number} "${pr.title}" (${pr.url})${pr.headRefName ? `, branch \`${pr.headRefName}\`` : ''}${pr.baseRefName ? ` into \`${pr.baseRefName}\`` : ''}: summarize what it changes, flag risks, and say whether it is ready to merge.`
    );
  };

  const newSessionOnBranch = async (b: GitBranchOverviewItem) => {
    try {
      const meta = await invoke('sessions:create', { config: { ...session.config, useWorktree: false }, title: b.name, checkoutBranch: b.name });
      await setActive(meta.id);
      toast(`Session started on ${b.name}`, 'success');
    } catch (e) {
      toast(String((e as Error).message ?? e), 'error');
    }
  };

  /** Prefills the composer so the agent reasons about a branch it is not checked out on. */
  const askAgent = (b: GitBranchOverviewItem) => {
    useStore.getState().insertIntoComposer(
      `The repo has a branch \`${b.name}\`${data?.base ? ` (base: ${data.base})` : ''}. Review its changes: summarize what it does, flag risks, and suggest a PR title and description.`
    );
  };

  const copyName = (b: GitBranchOverviewItem) => {
    void navigator.clipboard.writeText(b.name).then(() => toast(`Copied ${b.name}`, 'success'));
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
  const openPrCount = prData?.prs.filter((p) => p.state === 'OPEN').length;
  const localBranches = new Set(data.branches.map((b) => b.name));

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
          <button type="button" className={view === 'prs' ? 'active' : ''} onClick={() => setView('prs')} title="Pull requests on GitHub (via gh)">
            PR {openPrCount !== undefined && <span className="muted">{openPrCount}</span>}
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
        <Button
          variant="ghost"
          size="sm"
          icon="refresh"
          disabled={prLoading}
          onClick={() => {
            void refresh();
            if (view === 'prs' || prData) void refreshPrs();
          }}
          title={view === 'prs' ? 'Pull the PR list from GitHub again' : 'Refresh'}
        />
      </div>

      {view === 'prs' ? (
        <PrList
          data={prData}
          loading={prLoading}
          filter={prFilter}
          setFilter={setPrFilter}
          query={prQuery}
          setQuery={setPrQuery}
          isLocal={(name) => localBranches.has(name)}
          onRefresh={() => void refreshPrs()}
          onView={(pr) => void invoke('app:openExternal', { url: pr.url })}
          onMerge={(pr) => void mergeListedPr(pr)}
          onCopyUrl={(pr) => void navigator.clipboard.writeText(pr.url).then(() => toast(`Copied ${pr.url}`, 'success'))}
          onAskAgent={askAgentAboutPr}
          onNewSession={(pr) => pr.headRefName && void newSessionOnBranch({ name: pr.headRefName } as GitBranchOverviewItem)}
        />
      ) : view === 'branches' ? (
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
              <span className="num">Behind / Ahead</span>
              <span>Status</span>
              <span />
            </div>
            {visible.map((b) => (
              <BranchRow
                key={b.name}
                b={b}
                base={data.base}
                ghMissing={data.ghMissing}
                onDelete={() => void deleteBranch(b)}
                onOpenPr={() => runPr(b)}
                onViewPr={() => b.pr && void invoke('app:openExternal', { url: b.pr.url })}
                onMergePr={() => void mergePr(b)}
                onUpdate={() => void act(invoke('git:updateBranch', { sessionId: session.id, branch: b.name }), `Updated ${b.name}`)}
                onCopy={() => copyName(b)}
                onNewSession={() => void newSessionOnBranch(b)}
                onAskAgent={() => askAgent(b)}
              />
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

function BranchRow({
  b,
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
        {b.upstream && b.upstreamAhead === undefined && b.upstreamBehind === undefined && <span className="muted small" title={b.upstream}>synced</span>}
      </span>
      <div className="branch-actions">
        {b.worktreePath && (
          <Button variant="ghost" size="sm" icon="external" title={`Open worktree ${basename(b.worktreePath)}`} onClick={() => void invoke('app:openInEditor', { path: b.worktreePath! })} />
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
        <Dropdown
          align="right"
          width={260}
          trigger={() => <Button variant="ghost" size="sm" icon="more" title="Branch actions" aria-label={`Actions for ${b.name}`} />}
        >
          {(close) => (
            <>
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

function PrList({
  data,
  loading,
  filter,
  setFilter,
  query,
  setQuery,
  isLocal,
  onRefresh,
  onView,
  onMerge,
  onCopyUrl,
  onAskAgent,
  onNewSession
}: {
  data: GitPullRequestList | null;
  loading: boolean;
  filter: PrFilter;
  setFilter: (f: PrFilter) => void;
  query: string;
  setQuery: (q: string) => void;
  isLocal: (branch: string) => boolean;
  onRefresh: () => void;
  onView: (pr: GitPullRequest) => void;
  onMerge: (pr: GitPullRequest) => void;
  onCopyUrl: (pr: GitPullRequest) => void;
  onAskAgent: (pr: GitPullRequest) => void;
  onNewSession: (pr: GitPullRequest) => void;
}) {
  const prs = data?.prs ?? [];
  const counts = {
    open: prs.filter((p) => p.state === 'OPEN').length,
    merged: prs.filter((p) => p.state === 'MERGED').length,
    closed: prs.filter((p) => p.state === 'CLOSED').length,
    all: prs.length
  };
  const q = query.trim().toLowerCase();
  const visible = prs
    .filter((p) => (filter === 'all' ? true : p.state === filter.toUpperCase()))
    .filter((p) => !q || p.title.toLowerCase().includes(q) || `#${p.number}`.includes(q) || (p.headRefName ?? '').toLowerCase().includes(q) || (p.author ?? '').toLowerCase().includes(q));

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
          <span className="pr-pulled" title={new Date(data.fetchedAt).toLocaleString()}>
            {loading ? 'Pulling from GitHub…' : `Pulled ${relTime(data.fetchedAt)}`}
          </span>
        )}
      </div>
      {data?.ghMissing && (
        <div className="muted small pad">GitHub CLI (gh) not found — the PR list needs it. Install gh and run `gh auth login`.</div>
      )}
      {data?.error && (
        <div className="pad small">
          <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>
            Could not pull the PR list from GitHub: {data.error}
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
      {data && !data.error && !data.ghMissing && (
        <div className="branches-table">
          <div className="branches-cols pr-cols">
            <span>Pull request</span>
            <span>Author</span>
            <span>Updated</span>
            <span>Status</span>
            <span />
          </div>
          {visible.map((pr) => (
            <PrRow
              key={pr.number}
              pr={pr}
              local={!!pr.headRefName && isLocal(pr.headRefName)}
              onView={() => onView(pr)}
              onMerge={() => onMerge(pr)}
              onCopyUrl={() => onCopyUrl(pr)}
              onAskAgent={() => onAskAgent(pr)}
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
  local,
  onView,
  onMerge,
  onCopyUrl,
  onAskAgent,
  onNewSession
}: {
  pr: GitPullRequest;
  local: boolean;
  onView: () => void;
  onMerge: () => void;
  onCopyUrl: () => void;
  onAskAgent: () => void;
  onNewSession: () => void;
}) {
  const open = pr.state === 'OPEN';
  const review = pr.reviewDecision === 'APPROVED' ? 'approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes requested' : undefined;
  const diffStat = pr.additions !== undefined || pr.deletions !== undefined ? `+${pr.additions ?? 0} −${pr.deletions ?? 0}` : undefined;
  return (
    <div className="branch-row pr-row">
      <div className="pr-title">
        <div className="pr-head">
          <span className="mono muted">#{pr.number}</span>
          <span title={pr.title}>{pr.title}</span>
        </div>
        <div className="pr-refs mono" title={`${pr.headRefName ?? '?'} → ${pr.baseRefName ?? '?'}`}>
          {pr.headRefName ?? '?'} → {pr.baseRefName ?? '?'}
          {diffStat && <span className="muted"> · {diffStat}</span>}
        </div>
      </div>
      <span className="muted small" title={pr.author}>
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
        <Dropdown
          align="right"
          width={260}
          trigger={() => <Button variant="ghost" size="sm" icon="more" title="PR actions" aria-label={`Actions for PR #${pr.number}`} />}
        >
          {(close) => (
            <>
              <MenuItem
                onClick={() => {
                  close();
                  onView();
                }}
              >
                View PR on GitHub
              </MenuItem>
              <MenuItem
                disabled={!open || pr.isDraft || !pr.headRefName}
                onClick={() => {
                  close();
                  onMerge();
                }}
                hint={pr.isDraft ? 'draft' : open ? `into ${pr.baseRefName ?? 'base'}` : undefined}
              >
                Merge PR
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  onAskAgent();
                }}
                hint="Prefill the composer"
              >
                Ask the agent about this PR
              </MenuItem>
              <MenuItem
                disabled={!local}
                onClick={() => {
                  close();
                  onNewSession();
                }}
                hint={local ? 'isolated worktree' : 'branch not local'}
              >
                New session on its branch
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  onCopyUrl();
                }}
              >
                Copy PR link
              </MenuItem>
            </>
          )}
        </Dropdown>
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