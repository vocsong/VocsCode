import React from 'react';
import type { MissionCompletionReport, MissionDelivery, MissionRecord } from '../../../../shared/mission';
import { invoke } from '../../api';
import { useStore } from '../../store';
import { Button } from '../ui';
import './mission.css';

/** Shared by the final answer and the panel. Only retained host delivery receipts supply IDs. */
export function MissionDeliveryIdentity({ delivery }: { delivery: MissionDelivery }) {
  return <div data-testid="mission-delivery-identity">
    <p>Local commit: {delivery.commitSha ? <code>{delivery.commitSha}</code> : 'Not recorded.'}</p>
    <p>Merge commit: {delivery.mergedCommitSha ? <code>{delivery.mergedCommitSha}</code> : 'Not recorded — no merge claimed.'}</p>
    <p>Pull request: {delivery.pullRequestUrl ? <Button size="sm" variant="ghost" onClick={() => void invoke('app:openExternal', { url: delivery.pullRequestUrl! })}>{delivery.pullRequestUrl}</Button> : 'Not recorded — no PR claimed.'}</p>
  </div>;
}

const outcome = (delivery: MissionDelivery) => delivery.status === 'held' ? 'Policy-authorized delivery hold; not merged.'
  : delivery.endpoint === 'local_commit' ? 'Verified final content committed locally; not published.'
    : delivery.endpoint === 'open_pr' ? 'Verified final content delivered as an open pull request; not merged.'
      : delivery.endpoint === 'merge_pr' ? 'Verified final content delivered and merged.' : 'Configured delivery endpoint satisfied.';

/** A host-owned final answer, never an assistant message or part of a collapsed Worked row. */
export function MissionCompletion({ record }: { record: MissionRecord }) {
  const report = record.completionReport;
  const source = useStore((state) => state.sessions.find((session) => session.id === record.originSessionId));
  if (record.status !== 'completed' || !report) return null;
  const exceptions = report.checks.filter(({ evidence }) => evidence?.exception || ['waived', 'not_applicable'].includes(evidence?.result ?? ''));
  const findings = report.review.reviews.flatMap((review) => review.findings);
  return <article className="msg mission-ui mission-completion" data-testid="mission-completion-report" aria-label="Mission completion report">
    <div className="msg-meta"><strong>Vocs Code · Mission completion report</strong><span className="muted small">Host-recorded outcome, not a model claim</span></div>
    <div className="msg-text">
      <section><h3>Outcome</h3><p>{report.objective}</p><p>{outcome(report.delivery)}</p>
        <p>{report.tasks.satisfiedRequired}/{report.tasks.required} required tasks satisfied · {report.tasks.satisfied}/{report.tasks.total} total satisfied · {report.tasks.canceled} canceled · {report.tasks.superseded} superseded.</p>
        <p className="small">Specification {report.specificationRevision} · plan {report.planRevision} · verified content <code>{report.acceptedRevision.contentHash}</code></p>
        <MissionDeliveryIdentity delivery={report.delivery} />
        {record.originSessionId && <p><Button size="sm" variant="ghost" disabled={!source} onClick={() => void useStore.getState().setActive(record.originSessionId!)}>Source discussion</Button>{!source && ' Original session unavailable; retained Mission source remains authoritative.'}</p>}
      </section>
      <section data-testid="mission-completion-checks"><h3>Final verification</h3>
        <p>{report.checks.filter((item) => item.check.required && item.verified).length}/{report.checks.filter((item) => item.check.required).length} required checks verified on the final content. Earlier, stale and model-claimed results are excluded.</p>
        {!report.checks.length && <p>No command checks recorded; no test count is claimed.</p>}
        {report.checks.map((item) => <CompletionCheck key={item.check.id} item={item} />)}
      </section>
      <section><h3>Independent review</h3><p>{report.review.required ? 'Required by policy.' : 'Not required by policy.'} {report.review.independentlyReviewedCandidates}/{report.review.integratedCandidates} changed candidates independently reviewed.</p>
        <p>{report.review.reviews.length} settled exact-candidate reviews · {findings.filter((finding) => !!finding.resolution).length}/{findings.length} findings resolved. Candidate review is separate from final verification.</p>
        {report.review.reviews.map((review) => <p key={review.id} className="small">Review {review.id} · candidate {review.candidateId} · content <code>{review.sourceRevision.contentHash}</code></p>)}
        {findings.filter((finding) => !finding.resolution).map((finding) => <p key={finding.id}>{finding.severity}: {finding.description}</p>)}
      </section>
      <section><h3>Exceptions, limitations and holds</h3>
        {!exceptions.length && <p>No recorded check waivers or exceptions.</p>}
        {exceptions.map(({ check, evidence }) => <p key={check.id}>{check.name}: {evidence!.result} — {evidence!.exception ? `${evidence!.exception.reason} (user action ${evidence!.exception.sourceUserActionId})` : 'No authorized exception recorded.'} Not counted as a verified check.</p>)}
        {report.deliveryPolicy.fallback && <p>Local delivery used the recorded fallback policy.</p>}
        {report.delivery.reason && <p>{report.delivery.reason}</p>}
        {report.deliveryPolicy.holdConditions.length ? <ul>{report.deliveryPolicy.holdConditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul> : <p>No policy holds recorded.</p>}
        {report.limitations.length ? <ul>{report.limitations.map((limit, index) => <li key={index}>{limit.taskId}: {limit.description}</li>)}</ul> : <p>No unresolved task limitations recorded.</p>}
        {!!report.exclusions.length && <><h4>Out of scope</h4><ul>{report.exclusions.map((exclusion, index) => <li key={index}>{exclusion}</li>)}</ul></>}
        <p className="muted small">Evidence covers the recorded checks and candidate reviews only; it is not a claim that every environment or live integration was tested.</p>
      </section>
      {!!(report.assumptions.length || report.decisions.length) && <section><h3>Recorded assumptions and decisions</h3>
        <p className="muted small">Engineering judgments retained from the plan, not additional verification evidence.</p>
        {report.assumptions.map((assumption) => <p key={assumption.id}>{assumption.status}: {assumption.description} — {assumption.rationale}</p>)}
        {report.decisions.map((decision) => <p key={decision.id}>{decision.question} — {decision.resolution}{decision.rationale ? ` (${decision.rationale})` : ''}</p>)}
      </section>}
      {report.narrative && <section data-testid="mission-completion-narrative"><h3>Optional lead narrative — unverified</h3><p className="muted small">Supplied by lead session {report.narrative.sessionId}. This prose cannot establish checks, completion or delivery identifiers.</p><pre>{report.narrative.text}</pre></section>}
    </div>
  </article>;
}

function CompletionCheck({ item: { check, evidence, verified } }: { item: MissionCompletionReport['checks'][number] }) {
  return <div className="mission-card"><strong>{check.name}</strong><p><code>{check.command}</code></p>
    <p>{check.required ? 'Required' : 'Optional'} · {evidence?.result ?? 'not_run'} · {verified ? 'verified' : 'not verified'}{evidence?.exitCode !== undefined ? ` · exit ${evidence.exitCode}` : ''}</p>
    <p>{evidence?.executedTests !== undefined ? `${evidence.executedTests} tests executed` : check.kind === 'test' ? 'Executed test count unknown' : 'No test count claimed'} · {evidence?.skippedTests !== undefined ? `${evidence.skippedTests} skipped` : 'Skipped count unknown'}</p>
    {evidence && <p className="small">{evidence.provenance} · evidence {evidence.id} · environment {evidence.environmentRef}</p>}
  </div>;
}
