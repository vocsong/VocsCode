import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { HousekeepOutcome, HousekeepPreview, HousekeepRow } from '../../../shared/housekeep';
import { invoke, invokeErrorMessage } from '../api';
import { useStore } from '../store';
import { openSettings } from './SettingsView';
import { Badge, Button, Modal } from './ui';
import './housekeep-dialog.css';

type Operation = 'preview' | 'assess' | 'apply';
type ProtectionState = Pick<ReturnType<typeof useStore.getState>, 'activeId' | 'visibleSessionIds' | 'drafts'>;

function protectedSessionIds({ activeId, visibleSessionIds, drafts }: ProtectionState): string[] {
  const ids = new Set(visibleSessionIds);
  // activeId changes synchronously; the visible-pane report follows in an effect.
  if (activeId) ids.add(activeId);
  for (const [id, draft] of Object.entries(drafts)) if (draft) ids.add(id);
  return [...ids];
}

const VERDICT = {
  protected: { label: 'Protected', tone: 'neutral' },
  keep: { label: 'Keep', tone: 'blue' },
  review: { label: 'Review', tone: 'amber' },
  complete: { label: 'Complete', tone: 'green' }
} as const;

const OUTCOME = {
  archived: 'Archived',
  removed: 'Archived · original worktree removed',
  skipped: 'Skipped'
} satisfies Record<HousekeepOutcome['state'], string>;

function canArchive(row: HousekeepRow): boolean {
  return row.verdict === 'review' || row.verdict === 'complete';
}

function eligibleRows(rows: HousekeepRow[], protectedIds: ReadonlySet<string>): HousekeepRow[] {
  return rows.filter((row) => canArchive(row) && !protectedIds.has(row.sessionId));
}

function worktreeAction(row: HousekeepRow, eligible = true): string {
  if (!eligible || row.worktree === null) return 'No original worktree action';
  if (row.worktree === 'remove') return 'Remove original worktree if still safe';
  if (row.worktree === 'missing') return 'Original worktree already missing';
  return 'No original worktree to remove';
}

function AgeRule({ days, oneTime = false }: { days: number; oneTime?: boolean }) {
  return <p className="muted small">
    <strong>{oneTime ? 'Age rule for this review only: ' : 'Age rule: '}</strong>
    {days === 0
      ? '0 days: the recent activity window is off. '
      : `Activity within the last ${days} ${days === 1 ? 'day' : 'days'} (24 hours each, including the cutoff) is protected. `}
    Activity is the latest session creation, update, view, or transcript activity. Missing or future activity dates are protected.
  </p>;
}

const activityFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function SessionReview({ row, checked, busy, protectedNow, viewed, onView, onCheck }: {
  row: HousekeepRow;
  checked: boolean;
  busy: boolean;
  protectedNow: boolean;
  viewed: boolean;
  onView: () => void;
  onCheck: (checked: boolean) => void;
}) {
  const eligible = canArchive(row) && !protectedNow;
  const verdict = VERDICT[protectedNow ? 'protected' : row.verdict];
  const date = row.activityAt === null ? null : new Date(row.activityAt);
  const evidence = row.evidence;
  const showEvidence = !!(evidence?.request || evidence?.response);
  const disabled = busy || !eligible || row.verdict === 'review' && (!showEvidence || !viewed);
  return <li className="housekeep-row">
    <div className="housekeep-row-heading">
      <label>
        <input type="checkbox" aria-label={`Select ${row.title}`} checked={eligible && checked} disabled={disabled}
          onChange={(event) => { if (!disabled) onCheck(event.target.checked); }} />
        <strong>{row.title}</strong>
      </label>
      <Badge tone={verdict.tone}>{verdict.label}</Badge>
    </div>
    <div className="muted small">Project: {row.projectRoot || 'Unknown'} · Last activity: {date && Number.isFinite(date.getTime()) ? activityFormat.format(date) : 'Unknown'}</div>
    <div>{row.reason}</div>
    {protectedNow && row.verdict !== 'protected' && <div>Protected now: this session is open in a visible pane or has an unsent draft.</div>}
    <div className="muted small">{worktreeAction(row, eligible)}</div>
    {showEvidence && <details onToggle={(event) => { if (event.currentTarget.open && !viewed) onView(); }}>
      <summary tabIndex={0} aria-label={`Conversation excerpts for ${row.title}`}>Conversation excerpts</summary>
      <dl className="housekeep-excerpts">
        <dt>Latest user request</dt><dd>{evidence?.request || 'No excerpt available.'}</dd>
        <dt>Final response</dt><dd>{evidence?.response || 'No excerpt available.'}</dd>
      </dl>
    </details>}
    {!showEvidence && eligible && row.verdict === 'review' && <div className="muted small">No excerpts are available for manual review.</div>}
  </li>;
}

export function HousekeepDialog({ onClose, recentDaysOverride }: { onClose: () => void; recentDaysOverride?: number }) {
  const protectedIds = useStore(useShallow(protectedSessionIds));
  const protectedNow = new Set(protectedIds);
  const [preview, setPreview] = useState<HousekeepPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [viewed, setViewed] = useState<Set<string>>(() => new Set());
  const [confirmation, setConfirmation] = useState<HousekeepRow[] | null>(null);
  const [outcomes, setOutcomes] = useState<HousekeepOutcome[] | null>(null);
  const [assessed, setAssessed] = useState(false);
  const [busy, setBusy] = useState<Operation | null>('preview');
  const [error, setError] = useState<{ step: Operation; message: string } | null>(null);
  const mounted = useRef(false);
  const pending = useRef(false);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const analysisDisclosureId = useId();
  const applyFailed = error?.step === 'apply';

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback(async <T,>(step: Operation, request: () => Promise<T>, receive: (value: T) => void) => {
    if (!mounted.current || pending.current) return;
    pending.current = true;
    setBusy(step);
    setError(null);
    try {
      const result = await request();
      if (mounted.current) receive(result);
    } catch (cause) {
      if (mounted.current) setError({ step, message: invokeErrorMessage(cause) });
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(null);
    }
  }, []);

  const loadPreview = useCallback(() => run('preview', () => {
    setPreview(null);
    setSelected(new Set());
    setViewed(new Set());
    setConfirmation(null);
    setAssessed(false);
    const protectedIds = protectedSessionIds(useStore.getState());
    return invoke('housekeep:preview', recentDaysOverride === undefined ? { protectedIds } : { protectedIds, recentDaysOverride });
  }, setPreview), [run, recentDaysOverride]);

  useEffect(() => {
    let cancelled = false;
    // Don't send a preview from the discarded StrictMode mount effect.
    queueMicrotask(() => { if (!cancelled) void loadPreview(); });
    return () => { cancelled = true; };
  }, [loadPreview]);

  useEffect(() => { stepHeading.current?.focus(); }, [confirmation, outcomes]);

  const assessable = preview?.rows.filter((row) => row.verdict === 'review') ?? [];
  const assessmentNeedsRefresh = assessable.some((row) => protectedNow.has(row.sessionId));
  const eligible = eligibleRows(preview?.rows ?? [], protectedNow);
  const picks = eligible.filter((row) => selected.has(row.sessionId));
  const completed = assessed ? eligible.filter((row) => row.verdict === 'complete') : [];
  const confirmationBlocked = confirmation?.some((row) => protectedNow.has(row.sessionId));

  const analyze = () => {
    if (!preview?.reviewModel || assessed || !assessable.length) return;
    const latest = new Set(protectedSessionIds(useStore.getState()));
    if (assessable.some((row) => latest.has(row.sessionId))) return;
    void run('assess', () => invoke('housekeep:assess', { previewId: preview.id }), (next) => {
      const protectedOnReturn = new Set(protectedSessionIds(useStore.getState()));
      const stillEligible = new Set(eligibleRows(next.rows, protectedOnReturn).map((row) => row.sessionId));
      setPreview(next);
      // Assessment can disqualify an existing pick but never adds one.
      setSelected((current) => new Set([...current].filter((id) => stillEligible.has(id))));
      setAssessed(true);
    });
  };

  const selectCompleted = () => {
    if (!preview || !completed.length || busy) return;
    const recommendations = new Set(completed.map((row) => row.sessionId));
    const latest = new Set(protectedSessionIds(useStore.getState()));
    setSelected((current) => new Set(eligibleRows(preview.rows, latest)
      .map((row) => row.sessionId)
      .filter((id) => current.has(id) || recommendations.has(id))));
  };

  const apply = () => {
    if (!preview || !confirmation?.length || busy || applyFailed) return;
    const ids = confirmation.map((row) => row.sessionId);
    const latest = protectedSessionIds(useStore.getState());
    // Do not silently change the set the user just reviewed, even if the store changed between
    // rendering the button and clicking it. The host still rechecks the session and Git state.
    if (latest.some((id) => ids.includes(id))) return;
    void run('apply', () => invoke('housekeep:apply', { previewId: preview.id, ids, protectedIds: latest }), setOutcomes);
  };

  const removeCount = confirmation?.filter((row) => row.worktree === 'remove').length ?? 0;
  const footer = outcomes ? <Button onClick={onClose}>Done</Button>
    : applyFailed || error?.step === 'preview' ? <Button onClick={() => void loadPreview()}>Load fresh preview</Button>
    : confirmation ? <>
      <Button disabled={busy !== null} onClick={() => setConfirmation(null)}>Back to review</Button>
      <span className="spacer" />
      <Button variant="danger" disabled={busy !== null || confirmationBlocked} onClick={apply}>Confirm archive ({confirmation.length})</Button>
    </> : <>
      <span className="muted small" role="status">{preview && `${picks.length} selected`}</span>
      <span className="spacer" />
      <Button disabled={busy !== null || !picks.length} onClick={() => setConfirmation(picks)}>Review selected</Button>
    </>;

  return <Modal title="Housekeep sessions" width={720} onClose={onClose} footer={footer}>
    <div className="housekeep-dialog">
      {busy === 'preview' && <p role="status">Loading session preview…</p>}
      {error && <p className="callout warn" role="alert">
        {error.step === 'apply' ? 'Could not get archive results. Some sessions may have been processed; load a fresh preview before trying again. '
          : error.step === 'assess' ? 'Analysis failed. You can still review manually. ' : 'Could not load session preview. '}{error.message}
      </p>}
      {outcomes ? <>
        <h2 ref={stepHeading} tabIndex={-1}>Archive results</h2>
        {outcomes.length ? <ul className="housekeep-list" aria-label="Archive results">
          {outcomes.map((outcome) => <li className="housekeep-row" key={outcome.sessionId}>
            <div><strong>{outcome.title}</strong> — {OUTCOME[outcome.state]}</div>
            {outcome.detail && <div>{outcome.detail}</div>}
          </li>)}
        </ul> : <p role="status">No results were returned. Check the session list before trying again.</p>}
      </> : applyFailed ? null : confirmation ? <>
        <h2 ref={stepHeading} tabIndex={-1}>Final archive review</h2>
        {preview && recentDaysOverride !== undefined && <AgeRule days={preview.recentDays} oneTime />}
        <p>Archive {confirmation.length} {confirmation.length === 1 ? 'session' : 'sessions'} · {removeCount} original {removeCount === 1 ? 'worktree' : 'worktrees'} to remove if still safe.</p>
        <p>Transcripts and branches are kept. Vocs Code rechecks each session and moves only clean worktrees to the system Trash when available.</p>
        {confirmationBlocked && <p className="callout warn" role="alert">A selected session is now protected. Go back to review the selection again.</p>}
        {busy === 'apply' && <p role="status">Archiving selected sessions… Closing this dialog won’t stop the archive.</p>}
        <ul className="housekeep-list" aria-label="Selected sessions to archive">
          {confirmation.map((row) => <li className="housekeep-row" key={row.sessionId}>
            <strong>{row.title}</strong>
            <div className="muted small">{row.projectRoot} · {worktreeAction(row)}</div>
          </li>)}
        </ul>
      </> : preview && <>
        <h2 ref={stepHeading} tabIndex={-1}>Review sessions</h2>
        <AgeRule days={preview.recentDays} oneTime={recentDaysOverride !== undefined} />
        <p><button className="link-btn" type="button" disabled={busy !== null} onClick={() => { onClose(); openSettings('housekeep'); }}>Housekeep settings</button></p>
        {preview.rows.length === 0 ? <p role="status">No sessions to review.</p> : <>
          <p>Open the conversation excerpts for each session marked Review before selecting it. Protected and Keep sessions can’t be selected.</p>
          {preview.reviewModel ? <div className="housekeep-analysis">
            <p id={analysisDisclosureId}>
              <strong>Utility model: {preview.reviewModel}</strong>. Choosing Analyze can send this model short conversation excerpts (latest request and final response)
              from eligible older sessions across all projects. These excerpts may contain sensitive text. Housekeep won’t use another model or start provider setup.
            </p>
            <p className="muted small">Analysis makes recommendations without selecting sessions. Your picks stay selected if they’re still eligible.</p>
            {!assessed && <Button aria-describedby={analysisDisclosureId} disabled={busy !== null || !assessable.length || assessmentNeedsRefresh} onClick={analyze}>Analyze</Button>}
            {busy === 'assess' && <span role="status">Analyzing excerpts…</span>}
            {assessed && <p role="status">Analysis finished. No sessions were added to your selection.</p>}
            {completed.length > 0 && <Button onClick={selectCompleted}>Select completed ({completed.length})</Button>}
            {!assessed && assessmentNeedsRefresh && <p role="status">A session in the preview is now protected. Refresh before running analysis.</p>}
            {!assessed && (assessmentNeedsRefresh || error?.step === 'assess') && <Button onClick={() => void loadPreview()} disabled={busy !== null}>Load fresh preview</Button>}
          </div> : <p>No utility model is available for Housekeep. Review the excerpts locally; no other model or provider setup will be used.</p>}
          {!eligible.length && <p role="status">No sessions are eligible for archiving.</p>}
          <ul className="housekeep-list" aria-label="Sessions in preview">
            {preview.rows.map((row) => <SessionReview key={row.sessionId} row={row} checked={selected.has(row.sessionId)}
              busy={busy !== null} protectedNow={protectedNow.has(row.sessionId)} viewed={viewed.has(row.sessionId)}
              onView={() => setViewed((current) => new Set(current).add(row.sessionId))} onCheck={(checked) => setSelected((current) => {
                const next = new Set(current);
                if (checked) next.add(row.sessionId);
                else next.delete(row.sessionId);
                return next;
              })} />)}
          </ul>
        </>}
      </>}
    </div>
  </Modal>;
}
