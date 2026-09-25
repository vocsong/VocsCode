import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { MissionAttempt, MissionRecord, MissionUserControl } from '../../../../shared/mission';
import type { SessionMeta, TranscriptItem } from '../../../../shared/types';
import { HARNESS_BY_ID } from '../../../../shared/harness-meta';
import { controlMission, MISSION_MANAGED_REASON, missionStatusLabel } from '../../missions';
import { useStore } from '../../store';
import { invoke, isWeb } from '../../api';
import { fmtCost, fmtTokens } from '../../format';
import { DiffView } from '../DiffView';
import { ApprovalCard } from '../Transcript';
import { Badge, Button, Spinner } from '../ui';
import { MissionDeliveryIdentity } from './MissionCompletion';
import './mission.css';

export function useMission(session: SessionMeta) {
  const id = session.mission?.missionId;
  const record = useStore((s) => id ? s.missions[id] : undefined);
  const error = useStore((s) => id ? s.missionErrors[id] : undefined);
  useEffect(() => { if (id) void useStore.getState().loadMission(id); }, [id]);
  return { record, error };
}

function useMissionControl(record: MissionRecord) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string>();
  const run = async (control: MissionUserControl) => {
    if (pending.current || record.archived) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try { await controlMission(record, control); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { pending.current = false; setBusy(false); }
  };
  return { busy, error, run };
}

export function MissionHeaderControls({ record }: { record: MissionRecord }) {
  const { busy: pending, error, run } = useMissionControl(record);
  const busy = pending || !!record.archived;
  const [replacement, setReplacement] = useState('');
  const leadBusy = useStore((s) => s.sessions.some((session) => session.id === record.leadSessionId && ['starting', 'running', 'awaiting'].includes(session.status)));
  const quiet = !leadBusy && !record.attempts.some((a) => a.status !== 'terminal') && !record.operations.some((o) => ['intent_recorded', 'in_flight', 'reconciling'].includes(o.state));
  const settled = ['paused', 'stopped', 'completed', 'failed'].includes(record.status);
  const done = ['stopped', 'completed', 'failed'].includes(record.status);
  const t5 = record.config.tiers.find((t) => t.id === 5)?.presetIds ?? [];
  const presets = record.config.presets.filter((p) => p.enabled && t5.includes(p.id));
  const source = useStore((s) => s.sessions.find((session) => session.id === record.originSessionId));
  return <div className="mission-ui mission-header" data-testid="mission-header">
    <div className="row gap8 wrap"><Badge tone="purple">Mission</Badge><strong>{missionStatusLabel(record.status)}</strong><span>{record.phase}</span><span>{record.entryMode === 'interactive_plan' ? 'Plan together' : 'Autonomous'} origin</span>
      <Button size="sm" disabled={busy || settled || ['pausing', 'stopping', 'recovering'].includes(record.status)} onClick={() => void run({ action: 'pause' })}>Pause Mission</Button>
      {['paused', 'recovering', 'blocked'].includes(record.status) && <Button size="sm" disabled={busy || !quiet || record.status !== 'paused'} title="Pause and wait for owned work to settle before resuming." onClick={() => void run({ action: 'resume' })}>Resume Mission</Button>}
      <Button size="sm" variant="danger" disabled={busy || done || record.status === 'stopping'} onClick={() => void run({ action: 'stop' })}>Stop Mission</Button>
    </div>
    <div className="small">T5 principal engineer: <strong>{record.leadPreset.name}</strong> · {HARNESS_BY_ID[record.leadPreset.harnessId].name} · {record.leadPreset.model.connectionId ?? record.leadPreset.model.provider}/{record.leadPreset.model.model} · {record.leadPreset.reasoning.kind === 'default' ? 'Runtime default reasoning' : record.leadPreset.reasoning.value}</div>
    {record.archived && <p role="status">Archived Mission — read-only. Restore the Mission from Archived before resuming or changing it.</p>}
    {record.originSessionId && <div><Button size="sm" variant="ghost" disabled={!source} onClick={() => void useStore.getState().setActive(record.originSessionId!)}>Source discussion{source ? `: ${source.title}` : ' unavailable'}</Button><span className="muted small">{record.sourceCutoffId ? ` · retained through ${record.sourceCutoffId}` : ''}{!source && record.sourceSnapshotId ? ' · source evidence remains retained with the Mission' : ''}</span></div>}
    <details><summary>Lead handover and configuration</summary>
      <p className="muted small">Presets are pinned. Pause and wait for all work to settle before a T5-only handover; no automatic model or effort switch.</p>
      <div className="row gap8 wrap"><select aria-label="Replacement T5 principal engineer" value={replacement} onChange={(e) => setReplacement(e.target.value)}><option value="">Choose a T5 preset</option>{presets.filter((p) => p.id !== record.leadPreset.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <Button size="sm" disabled={busy || !quiet || record.status !== 'paused' || !replacement} onClick={() => void run({ action: 'replace_lead', presetId: replacement })}>Replace lead</Button>
        <Button size="sm" disabled={busy || !quiet || !settled} onClick={() => void run({ action: 'apply_configuration' })}>Apply updated configuration</Button>
      </div>
      <Button size="sm" disabled={busy || !quiet || !settled} title="Explicit managed cleanup only after all owned execution is quiescent; unresolved work stays protected." onClick={() => void run({ action: 'cleanup' })}>Clean up retained worktrees</Button>
      <p className="muted small">Archive retains worktrees. Stop is not rollback or delete.</p>
    </details>
    {error && <div className="callout warn" role="alert">{error}</div>}
  </div>;
}

export function MissionPanel({ session }: { session: SessionMeta }) {
  const { record, error } = useMission(session);
  if (!record) return <div className="mission-ui pad">{error ? <><p role="alert">{error}</p><Button onClick={() => void useStore.getState().loadMission(session.mission!.missionId)}>Retry Mission state</Button></> : <Spinner />}</div>;
  return <MissionDetails record={record} />;
}

function MissionDetails({ record }: { record: MissionRecord }) {
  const { busy: pending, error, run } = useMissionControl(record);
  const busy = pending || !!record.archived;
  const inspector = useStore((s) => s.missionInspector);
  const active = inspector?.missionId === record.id ? record.attempts.find((attempt) => attempt.sessionId === inspector.sessionId) : undefined;
  const proposal = record.pendingProposal;
  const leadBusy = useStore((s) => s.sessions.some((session) => session.id === record.leadSessionId && ['starting', 'running', 'awaiting'].includes(session.status)));
  const validProposal = proposal && proposal.specificationRevision === record.specificationRevision && proposal.planRevision === record.planRevision && record.status === 'awaiting_execution_approval';
  const ask = (reference: string) => {
    if (record.archived) return;
    void useStore.getState().setActive(record.leadSessionId);
    useStore.getState().insertIntoComposer(`About Mission ${record.id}, ${reference}: `);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus());
  };
  return <div className="mission-ui mission-panel pad" data-testid="mission-panel">
    <MissionWorkerApprovals record={record} />
    <section><h3>Objective</h3><p>{record.objective}</p><span className="muted small">Specification revision {record.specificationRevision} · Plan revision {record.planRevision}</span></section>
    <section><h3>Plan</h3><MissionPlanExport key={record.id} missionId={record.id} /><p>{record.plan.scope || 'The lead is consolidating the plan.'}</p><p>{record.plan.behavior}</p>
      {!!record.plan.exclusions.length && <><h4>Out of scope</h4><ul>{record.plan.exclusions.map((text, i) => <li key={i}>{text}</li>)}</ul></>}
      {!!record.plan.integrationPoints.length && <><h4>Integration points</h4><ul>{record.plan.integrationPoints.map((text, i) => <li key={i}>{text}</li>)}</ul></>}
      <h4>Verification approach</h4><p>{record.plan.verificationApproach || 'Not recorded yet.'}</p>
      {record.plan.criteria.map((criterion) => <p key={criterion.id}><strong>{criterion.required ? 'Required' : 'Optional'}:</strong> {criterion.description}</p>)}
      {!!record.plan.assumptions.length && <><h4>Assumptions</h4>{record.plan.assumptions.map((a) => <p key={a.id}>{a.description} · {a.status}<br /><span className="muted small">{a.rationale}</span></p>)}</>}
    </section>
    {!!record.questions.length && <section><h3>Questions and answers</h3>{record.questions.map((q) => <div key={q.id}><p><strong>{q.text}</strong></p><p>{q.answer ?? 'Awaiting your answer in the lead conversation.'}</p>{!q.answer && <Button size="sm" disabled={!!record.archived} onClick={() => ask(`question ${q.id}`)}>Answer in lead conversation</Button>}</div>)}</section>}
    {proposal && <section className="callout"><strong>Proceed with execution?</strong><p>Approve specification revision {proposal.specificationRevision}, plan revision {proposal.planRevision}.</p><div className="row gap8"><Button variant="primary" disabled={busy || leadBusy || !validProposal} onClick={() => void run({ action: 'execute', proposalId: proposal.id, specificationRevision: proposal.specificationRevision })}>Proceed</Button><Button disabled={busy || leadBusy || !validProposal} onClick={() => void run({ action: 'continue_planning' })}>Continue planning</Button></div>{!validProposal && <p>This proposal is no longer current. Wait for the lead's revised proposal.</p>}{validProposal && leadBusy && <p>Wait for the planning turn and its tools to settle before proceeding.</p>}</section>}
    {error && <div role="alert" className="callout warn">{error}</div>}
    <section><h3>Tasks and dependencies</h3>{record.tasks.length === 0 && <p className="muted">No tasks recorded yet.</p>}{record.tasks.map((task) => <article key={task.id} className="mission-card"><div><strong>{task.objective}</strong> <Badge>{missionStatusLabel(task.status)}</Badge></div><p>{task.scope}</p><p className="muted small">{task.id} · revision {task.revision} · {task.assignment.kind === 'lead' ? 'Principal engineer' : record.profiles.find((p) => p.id === (task.assignment as { profileId: string }).profileId)?.name ?? 'Specialist'}</p>{task.dependsOn.length > 0 && <p>Depends on: {task.dependsOn.map((dep) => `${dep.taskId} (${missionStatusLabel(dep.condition)})`).join(', ')}</p>}{task.reason && <p>{task.reason}</p>}<Button size="sm" variant="ghost" disabled={!!record.archived} onClick={() => ask(`task ${task.id}, revision ${task.revision}`)}>Ask lead about this</Button></article>)}</section>
    <section><h3>Blockers and decisions</h3>{record.blockers.filter((b) => !b.resolvedAt).map((b) => <p className="callout warn" key={b.id}>{b.kind}: {b.message}</p>)}{record.decisions.map((d) => <div key={d.id}><strong>{d.question}</strong><p>{d.resolution ?? d.proposedResolution ?? 'Unresolved'}{d.rationale ? ` — ${d.rationale}` : ''}</p></div>)}{!record.blockers.some((b) => !b.resolvedAt) && !record.decisions.length && <p className="muted">No recorded blockers or decisions.</p>}</section>
    <section><h3>Verification evidence</h3>{record.evidence.length === 0 && <p className="muted">No verification evidence recorded. Not verified.</p>}{record.evidence.map((e) => <article key={e.id} className="mission-card"><strong>{e.commandOrFlow}</strong><p>{e.result}{e.invalidatedBy ? ' · stale evidence' : ''} · {missionStatusLabel(e.provenance)}</p><p className="small">{e.executedTests !== undefined ? `${e.executedTests} tests executed · ${e.skippedTests ?? 0} skipped` : 'Executed test count unknown'} · revision {e.sourceRevision.contentHash}</p><p className="mono small">{e.cwd}</p></article>)}</section>
    <section><h3>Delivery</h3><p>{missionStatusLabel(record.deliveryPolicy.endpoint)}{record.deliveryPolicy.endpoint !== 'local_commit' && record.deliveryPolicy.targetBranch ? ` → ${record.deliveryPolicy.targetBranch}` : ''}{record.deliveryPolicy.fallback ? ' · fallback policy' : ''}</p><p>{record.delivery ? `${record.delivery.status}${record.delivery.reason ? ` — ${record.delivery.reason}` : ''}` : 'Not delivered.'}</p>
      {record.delivery && <MissionDeliveryIdentity delivery={record.delivery} />}
      {['merge_pr', 'open_pr'].includes(record.deliveryPolicy.endpoint) && <><p className="muted small">Reduce publication for this Mission only. This pauses owned work; resume after it settles. Checks, independent review and holds remain required. This cannot undo earlier publication or cancel a remote effect already in flight.</p><div className="row gap8 wrap">
        <Button size="sm" disabled={busy || ['stopped', 'completed', 'failed'].includes(record.status)} onClick={() => void run({ action: 'narrow_delivery', endpoint: 'local_commit' })}>Keep Mission local</Button>
        {record.deliveryPolicy.endpoint === 'merge_pr' && <Button size="sm" disabled={busy || ['stopped', 'completed', 'failed'].includes(record.status)} onClick={() => void run({ action: 'narrow_delivery', endpoint: 'open_pr' })}>Open PR only</Button>}
      </div></>}
      {!!record.publicationRestrictions?.length && <p role="status">User publication limit: {missionStatusLabel(record.publicationRestrictions.at(-1)!.endpoint)}. This limit survives restart and repository policy changes; it cannot be widened for this Mission.</p>}
      {record.publicationRestrictions?.some((restriction) => restriction.priorRemoteOperationIds.length > 0) && <p role="alert" className="callout warn">Remote activity was already admitted and may already have published. Narrowing cannot undo it. Reconcile retained receipts before resuming.</p>}
      {record.deliveryPolicy.holdConditions.map((condition, i) => <p key={i}>{condition}</p>)}{record.deliveryPolicy.conflicts.map((conflict, i) => <p key={i} className="callout warn">{conflict}</p>)}{record.delivery?.pullRequestUrl && <Button size="sm" onClick={() => void invoke('app:openExternal', { url: record.delivery!.pullRequestUrl! })}>Open delivery PR</Button>}</section>
    <section><h3>Specialists</h3><p className="muted small">Read-only inspection. Only the principal engineer receives instructions.</p>{record.attempts.filter((attempt) => attempt.sessionId !== record.leadSessionId).map((attempt) => <button type="button" key={attempt.id} className="mission-card mission-agent" onClick={() => void useStore.getState().inspectMissionSession(record.id, attempt.sessionId)}><strong>{attempt.profile?.name ?? attempt.taskId}</strong><span>T{attempt.tierId} · {attempt.preset.name} · {attempt.outcome ?? attempt.status}</span><span>{attempt.taskId} · {attempt.selectionReason}</span></button>)}{!record.attempts.length && <p className="muted">No specialists dispatched.</p>}
      {active && <MissionInspector key={active.id} record={record} attempt={active} itemId={inspector?.itemId} ask={() => ask(`task ${active.taskId}, attempt ${active.id}`)} />}
    </section>
    <MissionUsage record={record} />
    <p className="muted small">{MISSION_MANAGED_REASON}</p>
  </div>;
}

/** Fetch at click time: the panel's cached revision is not the export authority. */
function MissionPlanExport({ missionId }: { missionId: string }) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const save = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setMessage(undefined); setError(undefined);
    try {
      if (isWeb) throw new Error('Plan export requires the desktop Save As dialog. Open this Mission in the desktop app.');
      const exported = await invoke('missions:exportPlan', { missionId });
      const result = await invoke('app:fileSaveAs', { content: exported.markdown, suggestedName: exported.suggestedName });
      setMessage(result.path ? 'Plan exported. Editing it does not change the Mission.' : 'Plan export canceled.');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div>
    <Button size="sm" disabled={busy} title="Save a read-only snapshot of the latest structured plan. No execution approval or workspace write is granted." onClick={() => void save()}>Export plan.md</Button>
    {message && <p role="status" className="muted small">{message}</p>}
    {error && <p role="alert" className="callout warn">{error}</p>}
  </div>;
}

/** A reported-cost rollup is not a complete billing total; missing usage is never shown as zero. */
export function MissionUsage({ record }: { record: MissionRecord }) {
  const sessions = useStore((s) => s.sessions);
  const owned = sessions.filter((session) => session.mission?.missionId === record.id);
  const usage = owned.length ? owned.reduce((sum, session) => ({ costUsd: sum.costUsd + session.usage.costUsd, turns: sum.turns + session.usage.turns, inputTokens: sum.inputTokens + session.usage.inputTokens, outputTokens: sum.outputTokens + session.usage.outputTokens }), { costUsd: 0, turns: 0, inputTokens: 0, outputTokens: 0 }) : undefined;
  return <section className="mission-ui" data-testid="mission-usage"><h3>Mission usage</h3>
    <p>Billing coverage: {owned.length ? 'partial' : 'unknown'} — not a complete billing total.</p>
    <p>{usage?.costUsd === undefined ? 'Reported cost unknown' : `${fmtCost(usage.costUsd)} reported cost`}{usage?.turns === undefined ? '' : ` · ${usage.turns} turns reported`}</p>
    <p className="muted small">{usage?.inputTokens === undefined ? 'Input tokens unknown' : `${fmtTokens(usage.inputTokens)} input tokens`}{usage?.outputTokens === undefined ? ' · Output tokens unknown' : ` · ${fmtTokens(usage.outputTokens)} output tokens`}. Lead and specialists are counted once; individual session ledgers are unchanged.</p>
  </section>;
}

const EMPTY: TranscriptItem[] = [];

/** Human permission decisions are the existing approval channel, never a second worker chat. */
function MissionWorkerApprovals({ record }: { record: MissionRecord }) {
  const transcripts = useStore((s) => s.transcripts);
  const workers = useMemo(() => [...new Set(record.attempts.filter((a) => a.sessionId !== record.leadSessionId && a.status !== 'terminal').map((a) => a.sessionId))], [record.attempts, record.leadSessionId]);
  useEffect(() => { for (const id of workers) void useStore.getState().loadTranscript(id); }, [workers]);
  const pending = workers.flatMap((sessionId) => (transcripts[sessionId] ?? EMPTY).flatMap((item) => item.kind === 'approval' && !item.decision && ['permission', 'command', 'file_change'].includes(item.request.kind) && !item.request.questions?.length ? [{ sessionId, item }] : []));
  if (record.archived || !pending.length) return null;
  return <section data-testid="mission-worker-approvals"><h3>Specialist permissions</h3><p className="muted small">Approve or deny the requested operation. Instructions and questions still go only to the principal engineer.</p>{pending.map(({ sessionId, item }) => {
    const attempt = record.attempts.find((a) => a.sessionId === sessionId && a.status !== 'terminal');
    return <div key={`${sessionId}:${item.id}`}><p><strong>{attempt?.profile?.name ?? attempt?.taskId ?? 'Specialist'}</strong> · {sessionId}</p><ApprovalCard item={item} sessionId={sessionId} /></div>;
  })}</section>;
}

function MissionInspector({ record, attempt, itemId, ask }: { record: MissionRecord; attempt: MissionAttempt; itemId?: string; ask: () => void }) {
  const items = useStore((s) => s.transcripts[attempt.sessionId] ?? EMPTY);
  const loaded = useStore((s) => s.loaded[attempt.sessionId]);
  const error = useStore((s) => s.transcriptErrors[attempt.sessionId]);
  const [diff, setDiff] = useState<string>();
  const [diffError, setDiffError] = useState<string>();
  const [view, setView] = useState<'transcript' | 'result' | 'diff'>('transcript');
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { void useStore.getState().loadTranscript(attempt.sessionId); }, [attempt.sessionId]);
  useEffect(() => {
    if (view !== 'diff') return;
    let stale = false;
    invoke('git:diff', { sessionId: attempt.sessionId }).then((r) => { if (!stale) { setDiff(r.diff); setDiffError(r.error); } }).catch((e) => { if (!stale) setDiffError(String(e.message ?? e)); });
    return () => { stale = true; };
  }, [attempt.sessionId, view, record.revision]);
  useEffect(() => { if (itemId) body.current?.querySelector(`[data-mission-item="${CSS.escape(itemId)}"]`)?.scrollIntoView({ block: 'center' }); }, [itemId, items]);
  return <div className="mission-inspector" data-testid="mission-inspector" ref={body}>
    <h4>{attempt.profile?.name ?? attempt.taskId} — read-only</h4><p>T{attempt.tierId} · {attempt.preset.name} · {attempt.outcome ?? attempt.status}</p>
    <div className="row gap8 wrap">{(['transcript', 'result', 'diff'] as const).map((tab) => <Button size="sm" key={tab} aria-pressed={view === tab} onClick={() => setView(tab)}>{tab === 'diff' ? 'Unaccepted workspace diff' : tab === 'result' ? 'Result' : 'Transcript'}</Button>)}<Button size="sm" disabled={!!record.archived} onClick={ask}>Ask lead about this</Button></div>
    {view === 'transcript' && <>{!loaded && !error && <Spinner />}{error && <p role="alert">{error}</p>}{items.map((item) => <article key={item.id} data-mission-item={item.id} className={`mission-card ${item.id === itemId ? 'mission-match' : ''}`}><strong>{item.kind}</strong><pre>{transcriptText(item)}</pre></article>)}</>}
    {view === 'result' && <><p>{attempt.result?.summary ?? 'No structured result submitted.'}</p>{attempt.result?.unresolved.map((u, i) => <p key={i}>{u.blocking ? 'Blocking: ' : ''}{u.description}</p>)}{attempt.result && <p className="small">Artifacts: {attempt.result.artifactIds.join(', ') || 'none'} · Evidence: {attempt.result.evidenceIds.join(', ') || 'none'}</p>}{attempt.failure && <p role="alert">{attempt.failure.kind}: {attempt.failure.message}</p>}</>}
    {view === 'diff' && <>{diffError && <p role="alert">{diffError}</p>}{diff === undefined && !diffError ? <Spinner /> : <DiffView diff={diff ?? ''} />}</>}
  </div>;
}

function transcriptText(item: TranscriptItem): string {
  switch (item.kind) {
    case 'assistant': return [item.text, item.thinking].filter(Boolean).join('\n\n');
    case 'user': case 'info': return item.text;
    case 'tool': return `${item.name}\n${item.output ?? ''}`;
    case 'plan': return item.entries.map((e) => `${e.status}: ${e.content}`).join('\n');
    case 'turn': return item.status;
    case 'approval': return 'Permission request — respond through the Mission approval card, not worker chat.';
    default: return '';
  }
}
