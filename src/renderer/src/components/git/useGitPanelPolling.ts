/** Checkout-scoped data reads, visibility/focus polling, and turn-end activity refresh for the Git panel. */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { SessionMeta } from '../../../../shared/types';
import { invoke } from '../../api';
import type { GitPanelCache, GitPanelRead, GitPanelReadOptions } from '../../git-panel-cache';
import { useStore } from '../../store';

/** Git panel background poll cadence: GitHub cannot push PR/issue changes to a desktop app, so ask on a timer. */
export const POLL_MS = 60_000;
/** A refresh scheduled by a finished turn waits at least this long after the last poll, so a chatty session cannot hammer gh. */
const ACTIVITY_REFRESH_MIN_MS = 20_000;

export function useGitPanelPolling({
  sessionId,
  cwd,
  status,
  cache
}: {
  sessionId: string;
  cwd: string;
  status: SessionMeta['status'];
  cache: GitPanelCache;
}) {
  const toast = useStore((s) => s.toast);
  const reads = useMemo(() => cache.checkout(cwd), [cache, cwd]);
  const { data } = useSyncExternalStore(reads.overview.subscribe, reads.overview.getSnapshot);
  const { data: prData = null, loading: prLoading } = useSyncExternalStore(reads.prs.subscribe, reads.prs.getSnapshot);
  const { data: issueData = null, loading: issueLoading } = useSyncExternalStore(reads.issues.subscribe, reads.issues.getSnapshot);

  const visit = useMemo(() => ({ sessionId, cwd }), [sessionId, cwd]);
  const liveVisit = useRef<typeof visit | null>(null);
  const isCurrentVisit = liveVisit.current === visit;
  const pollInFlight = useRef<typeof visit | null>(null);
  const lastPollAt = useRef(0);
  const activityTimer = useRef<number | null>(null);
  /** Previous turn status, so the panel can refresh once a turn ends (the app-level "git hook"). */
  const prevStatus = useRef(status);

  /**
   * `background` refreshes stay silent: no spinner and no toast, so a transient gh failure leaves the last list on screen.
   * `remote` re-syncs remote-tracking refs first (`fetch --prune`). The list is the repo's LOCAL branches, which a
   * server-side delete never touches: without the prune, a branch deleted on GitHub keeps its stale `origin/<name>`
   * ref and reads as live, so re-reading alone looks like a refresh that did nothing. Only an explicit refresh pays
   * for the round trip; the minute poll stays local.
   */
  const load = async <T extends { error?: string }>(read: GitPanelRead<T>, fetch: () => Promise<T>, opts: GitPanelReadOptions) => {
    try {
      await read.load(fetch, opts);
    } catch (e) {
      if (liveVisit.current === visit && !opts.background) toast(String((e as Error).message ?? e), 'error');
    }
  };

  const refresh = async (opts: GitPanelReadOptions & { remote?: boolean } = { force: true }) => {
    if (opts.remote) {
      try {
        const f = await invoke('git:fetchPrune', { sessionId });
        if (liveVisit.current !== visit) return;
        // The branch list is still worth showing, so a failed fetch reports itself instead of aborting the refresh.
        if (!f.ok) toast(f.output || 'Could not reach the remote — showing local branch state.', 'error');
      } catch (e) {
        if (liveVisit.current !== visit) return;
        toast(String((e as Error).message ?? e), 'error');
      }
    }
    await load(reads.overview, () => invoke('git:branchesOverview', { sessionId }), opts);
  };

  const refreshPrs = (opts: GitPanelReadOptions = { force: true }) =>
    load(reads.prs, () => invoke('git:pullRequests', { sessionId }), opts);

  const refreshIssues = (opts: GitPanelReadOptions = { force: true }) =>
    load(reads.issues, () => invoke('git:issues', { sessionId }), opts);

  /**
   * GitHub-side PR/issue changes cannot be pushed to a desktop app, so the only way to see them
   * is to ask again. One silent round over everything the panel has loaded; a hidden window or a
   * non-repo folder skips it, and gh-less folders skip the two GitHub calls.
   */
  const poll = async () => {
    if (liveVisit.current !== visit || pollInFlight.current === visit || document.visibilityState === 'hidden' || !data?.isRepo) return;
    pollInFlight.current = visit;
    lastPollAt.current = Date.now();
    try {
      const jobs = [refresh({ background: true })];
      const ghMissing = data.ghMissing || prData?.ghMissing || issueData?.ghMissing;
      if (!ghMissing) jobs.push(refreshPrs({ background: true }), refreshIssues({ background: true }));
      await Promise.all(jobs);
    } finally {
      if (pollInFlight.current === visit) pollInFlight.current = null;
    }
  };
  const latestPoll = useRef(poll);
  latestPoll.current = poll;

  useEffect(() => {
    liveVisit.current = visit;
    prevStatus.current = status;
    return () => { liveVisit.current = null; };
  }, [visit]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    cache.remember(cwd, reads);
    lastPollAt.current = Date.now();
    void refresh({ background: !!data });
    void refreshPrs({ background: !!prData, reuseFor: POLL_MS });
    void refreshIssues({ background: !!issueData, reuseFor: POLL_MS });
  }, [cache, cwd, reads, visit]); // eslint-disable-line react-hooks/exhaustive-deps

  // Remote changes arrive between turns, so poll every minute while the tab is open. A hidden
  // window skips the tick and catches up on focus/visibility instead, like the sidebar's folder branch.
  useEffect(() => {
    const onWake = () => void latestPoll.current();
    const timer = window.setInterval(onWake, POLL_MS);
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
      if (activityTimer.current !== null) {
        window.clearTimeout(activityTimer.current);
        activityTimer.current = null;
      }
    };
  }, [reads]);

  // The app-level equivalent of a git hook: a finished turn is when the agent's commit / push /
  // `gh pr create` has settled, so refresh shortly after — throttled so a chatty session cannot
  // hammer gh between the timer's own ticks.
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = status;
    if (prev === 'idle' || status !== 'idle') return;
    if (activityTimer.current !== null) window.clearTimeout(activityTimer.current);
    const wait = Math.max(2_000, ACTIVITY_REFRESH_MIN_MS - (Date.now() - lastPollAt.current));
    activityTimer.current = window.setTimeout(() => {
      activityTimer.current = null;
      void latestPoll.current();
    }, wait);
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshAll = () => {
    lastPollAt.current = Date.now();
    void refresh({ remote: true, force: true });
    void refreshPrs();
    void refreshIssues();
  };

  return {
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
  };
}
