/** Git panel tab: GitHub-style branch overview, worktree housekeeping and the repo's pull requests and issues (pulled via gh). */
import React, { useEffect, useMemo, useState } from 'react';
import type { GitBranchOverviewItem, GitIssue, GitPullRequest, GitSetupStatus, SessionMeta } from '../../../shared/types';
import { invoke } from '../api';
import { basename, relTime } from '../format';
import type { GitPanelCache } from '../git-panel-cache';
import { useStore } from '../store';
import { GitSetup, remoteWebUrl } from './GitSetup';
import { BranchList, type BranchFilter } from './git/BranchList';
import { IssueList, PrList, type IssueFilter, type PrFilter } from './git/GitHubLists';
import { IssueDialog, ListedPrDialog, PrDialog } from './git/GitItemDialogs';
import { useGitPanelPolling } from './git/useGitPanelPolling';
import { WorktreeList } from './git/WorktreeList';
import { askConfirm, askPrompt, Button, Dropdown, MenuItem, Spinner } from './ui';

export function BranchesTab({ session, cache }: { session: SessionMeta; cache: GitPanelCache }) {
  const preview = useStore((s) => s.gitPullRequestPreview?.sessionId === session.id ? s.gitPullRequestPreview : null);
  const closePreview = useStore((s) => s.closePullRequestPreview);
  return (
    <>
      <RepositoryGitTab session={session} cache={cache} />
      {preview && (
        <PrDialog
          number={preview.number}
          pr={preview.detail?.pr}
          comments={preview.detail?.comments ?? null}
          loadError={preview.detail?.error}
          onClose={closePreview}
          onViewExternal={() => {
            closePreview();
            void invoke('app:openExternal', { url: preview.url });
          }}
        />
      )}
    </>
  );
}

function RepositoryGitTab({ session, cache }: { session: SessionMeta; cache: GitPanelCache }) {
  const toast = useStore((s) => s.toast);
  const setActive = useStore((s) => s.setActive);
  // The selected view survives a panel remount, including when a PR row starts a new session.
  const view = useStore((s) => s.gitPanelView);
  const setView = useStore((s) => s.setGitPanelView);
  const { id: sessionId, cwd } = session;
  const setupKey = `${sessionId}:${cwd}`;

  const {
    data,
    prData,
    prLoading,
    issueData,
    issueLoading,
    visit,
    liveVisit,
    isCurrentVisit,
    refresh,
    refreshPrs,
    refreshIssues,
    refreshAll
  } = useGitPanelPolling({ sessionId, cwd, status: session.status, cache });

  /** Guided-setup state reported by GitSetup, for the housekeeping menu's "Set up GitHub" entry. */
  const [setup, setSetup] = useState<GitSetupStatus | null>(null);
  const [filter, setFilter] = useState<BranchFilter>('all');
  const [query, setQuery] = useState('');
  const [prFilter, setPrFilter] = useState<PrFilter>('open');
  const [prQuery, setPrQuery] = useState('');
  const [issueFilter, setIssueFilter] = useState<IssueFilter>('open');
  const [issueQuery, setIssueQuery] = useState('');
  const [selectedIssue, setSelectedIssue] = useState<GitIssue | null>(null);
  const [selectedPr, setSelectedPr] = useState<GitPullRequest | null>(null);

  useEffect(() => {
    setSetup(null);
    setSelectedIssue(null);
    setSelectedPr(null);
  }, [visit]);

  const reportSetup = (status: GitSetupStatus) => {
    if (liveVisit.current === visit) setSetup(status);
  };

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

  /** Merging from the PR list goes through the same gh path, pinned to the PR's head branch; both lists are refreshed after. Returns true when a merge was attempted (the user confirmed). */
  const mergeListedPr = async (pr: GitPullRequest): Promise<boolean> => {
    if (!pr.headRefName) return false;
    const ok = await askConfirm({
      title: `Merge PR #${pr.number}?`,
      body: `${pr.title}\n\n${pr.headRefName} → ${pr.baseRefName ?? 'its target branch'}, via gh.`.trim(),
      confirmLabel: 'Merge PR'
    });
    if (!ok) return false;
    const r = await invoke('git:merge', { sessionId: session.id, head: pr.headRefName });
    if (!r.ok) toast(r.output ?? 'Failed to merge the PR', 'error');
    else {
      toast(`Merged #${pr.number}`, 'success');
      void refresh();
      void refreshPrs();
    }
    return true;
  };

  /** Starts a review session on this repo: the PR table's New session action, no folder picker. */
  const reviewPrInNewSession = async (pr: GitPullRequest) => {
    const initial = `Review pull request #${pr.number} "${pr.title}" (${pr.url})${pr.headRefName ? `, branch \`${pr.headRefName}\`` : ''}${pr.baseRefName ? ` into \`${pr.baseRefName}\`` : ''}. Run \`gh pr diff ${pr.number}\` for the patch: summarize what it changes, flag risks, and say whether it is ready to merge.`;
    const prompt = await askPrompt({
      title: `Start a session to review PR #${pr.number}?`,
      body: `New session in ${session.config.projectRoot}, on its current checkout.`,
      confirmLabel: 'Start session',
      input: { label: 'First message', value: initial, rows: 6, testId: 'pr-review-prompt', submitOnEnter: true }
    });
    if (prompt === null) return;
    const firstMessage = prompt.trim();
    try {
      const meta = await invoke('sessions:create', {
        config: { ...session.config, useWorktree: false },
        title: `Review PR #${pr.number}`,
        initialPrompt: firstMessage || undefined
      });
      await setActive(meta.id);
      toast(`Session started to review PR #${pr.number}`, 'success');
    } catch (e) {
      toast(String((e as Error).message ?? e), 'error');
    }
  };

  /** Starts a session on this repo: the issue table's New session action, no folder picker. */
  const fixIssueInNewSession = async (issue: GitIssue) => {
    const initial = `Fix issue #${issue.number} "${issue.title}" (${issue.url}): figure out the cause and implement a fix.`;
    const prompt = await askPrompt({
      title: `Start a session on issue #${issue.number}?`,
      body: `New session in ${session.config.projectRoot}, on its current checkout.`,
      confirmLabel: 'Start session',
      input: { label: 'First message', value: initial, rows: 6, testId: 'issue-prompt', submitOnEnter: true }
    });
    if (prompt === null) return;
    const firstMessage = prompt.trim();
    try {
      const meta = await invoke('sessions:create', {
        config: { ...session.config, useWorktree: false },
        title: `Fix issue #${issue.number}`,
        initialPrompt: firstMessage || undefined
      });
      await setActive(meta.id);
      toast(`Session started on issue #${issue.number}`, 'success');
    } catch (e) {
      toast(String((e as Error).message ?? e), 'error');
    }
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

  const openPrCount = useMemo(() => prData?.prs.filter((p) => p.state === 'OPEN').length, [prData]);
  const openIssueCount = useMemo(() => issueData?.issues.filter((i) => i.state === 'OPEN').length, [issueData]);

  if (data && !data.isRepo) {
    return (
      <div className="branches">
        <GitSetup key={setupKey} variant="page" session={session} onChanged={() => void refresh()} onStatus={reportSetup} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="pad">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="branches">
      <GitSetup key={setupKey} variant="banner" session={session} onChanged={() => void refresh()} onStatus={reportSetup} />
      {data.error && (
        <div className="callout warn" role="status">
          {data.error}
        </div>
      )}
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
          <button type="button" className={view === 'issues' ? 'active' : ''} onClick={() => setView('issues')} title="Issues on GitHub (via gh)">
            Issues {openIssueCount !== undefined && <span className="muted">{openIssueCount}</span>}
          </button>
        </div>
        <span className="spacer" />
        <Dropdown
          align="right"
          width={230}
          trigger={() => <Button variant="ghost" size="sm" icon="more" title="Housekeeping" aria-label="Housekeeping actions" />}
        >
          {(close) => {
            const status = isCurrentVisit ? setup : null;
            const root = status?.mainRoot ?? status?.root ?? cwd;
            const skipped = useStore.getState().settings?.gitSetupSkipped ?? [];
            // The panel lists this checkout's branches; the server's own list is the cross-check, so keep
            // a way out of the app within reach of the list it disagrees with.
            const repoUrl = status?.remote ? remoteWebUrl(status.remote) : undefined;
            return (
              <>
                {repoUrl && (
                  <MenuItem
                    onClick={() => {
                      close();
                      void invoke('app:openExternal', { url: `${repoUrl}/branches` });
                    }}
                    hint={repoUrl.replace(/^https?:\/\//, '')}
                  >
                    Open branches on GitHub
                  </MenuItem>
                )}
                {status?.isRepo && !status.published && skipped.includes(root) && (
                  <MenuItem
                    onClick={() => {
                      close();
                      void invoke('settings:update', { gitSetupSkipped: skipped.filter((p) => p !== root) });
                    }}
                    hint="Finish connecting a repository"
                  >
                    Set up GitHub
                  </MenuItem>
                )}
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
            );
          }}
        </Dropdown>
        <Button
          variant="ghost"
          size="sm"
          icon="refresh"
          disabled={prLoading || issueLoading}
          onClick={refreshAll}
          title={view === 'prs' ? 'Pull the PR list from GitHub again' : view === 'issues' ? 'Pull the issue list from GitHub again' : 'Refresh — re-syncs with the remote, then re-reads the branch list'}
        />
      </div>

      {view === 'issues' ? (
        <IssueList
          data={issueData}
          loading={issueLoading}
          filter={issueFilter}
          setFilter={setIssueFilter}
          query={issueQuery}
          setQuery={setIssueQuery}
          onRefresh={() => void refreshIssues()}
          onOpen={(issue) => setSelectedIssue(issue)}
          onViewExternal={(issue) => void invoke('app:openExternal', { url: issue.url })}
          onNewSession={fixIssueInNewSession}
        />
      ) : view === 'prs' ? (
        <PrList
          data={prData}
          loading={prLoading}
          filter={prFilter}
          setFilter={setPrFilter}
          query={prQuery}
          setQuery={setPrQuery}
          onRefresh={() => void refreshPrs()}
          onOpen={(pr) => setSelectedPr(pr)}
          onView={(pr) => void invoke('app:openExternal', { url: pr.url })}
          onNewSession={reviewPrInNewSession}
        />
      ) : view === 'branches' ? (
        <BranchList
          data={data}
          sessionId={session.id}
          filter={filter}
          setFilter={setFilter}
          query={query}
          setQuery={setQuery}
          onDelete={(b) => void deleteBranch(b)}
          onOpenPr={runPr}
          onViewPr={(b) => b.pr && void invoke('app:openExternal', { url: b.pr.url })}
          onMergePr={(b) => void mergePr(b)}
          onUpdate={(b) => void act(invoke('git:updateBranch', { sessionId: session.id, branch: b.name }), `Updated ${b.name}`)}
          onCopy={copyName}
          onNewSession={(b) => void newSessionOnBranch(b)}
          onAskAgent={askAgent}
        />
      ) : (
        <WorktreeList sessionId={session.id} cwd={session.cwd} worktrees={data.worktrees} onAct={act} />
      )}
      {isCurrentVisit && selectedIssue && (
        <IssueDialog
          issue={selectedIssue}
          sessionId={session.id}
          onClose={() => setSelectedIssue(null)}
          onViewExternal={() => {
            setSelectedIssue(null);
            void invoke('app:openExternal', { url: selectedIssue.url });
          }}
          onNewSession={() => {
            setSelectedIssue(null);
            void fixIssueInNewSession(selectedIssue);
          }}
        />
      )}
      {isCurrentVisit && selectedPr && (
        <ListedPrDialog
          pr={selectedPr}
          sessionId={session.id}
          onClose={() => setSelectedPr(null)}
          onViewExternal={() => {
            setSelectedPr(null);
            void invoke('app:openExternal', { url: selectedPr.url });
          }}
          onMerge={async () => {
            if (await mergeListedPr(selectedPr) && liveVisit.current === visit) setSelectedPr(null);
          }}
        />
      )}
    </div>
  );
}
