import { expect, it } from 'vitest';
import { evidenceMakesProgress, missionMadeProgress, missionProgressSnapshot, verificationOutcomeHash, verificationRetryIssue, verificationScope } from '../src/main/mission/progress';
import type { MissionEvidence } from '../src/shared/mission';
import { missionFixture } from './support/mission-fixture';

const evidence = (patch: Partial<MissionEvidence> = {}): MissionEvidence => ({ id: 'first', criterionIds: ['actual'], specificationRevision: 1,
  sourceRevision: { baseCommitSha: 'base', contentHash: 'content' }, checkId: 'actual', kind: 'test', commandOrFlow: 'node --test', cwd: '/check/first', environmentRef: 'isolated-first',
  provenance: 'host_executed', result: 'failed', exitCode: 1, executedTests: 1, skippedTests: 0, outcomeHash: 'actual-failure', artifactIds: ['first-log'], startedAt: 1, endedAt: 2, ...patch });

it('distinguishes new failed-check findings from new receipt identities, observations, claims and blocked checks', () => {
  const first = evidence();
  const duplicate = evidence({ id: 'next', cwd: '/check/next', environmentRef: 'isolated-next', artifactIds: ['next-log', 'new-receipt'], startedAt: 100, endedAt: 110 });
  expect(evidenceMakesProgress(first, [])).toBe(true);
  expect(evidenceMakesProgress(duplicate, [first])).toBe(false);
  expect(evidenceMakesProgress(evidence({ outcomeHash: 'different-assertion' }), [first])).toBe(true);
  expect(evidenceMakesProgress(evidence({ sourceRevision: { ...first.sourceRevision, contentHash: 'changed-input' } }), [first])).toBe(true);
  for (const patch of [{ result: 'blocked' }, { result: 'skipped' }, { provenance: 'agent_claim' }, { executedTests: 0 }] as const) expect(evidenceMakesProgress(evidence(patch), [])).toBe(false);
  const record = missionFixture({ evidence: [first] }), before = missionProgressSnapshot(record);
  record.lastEventSequence++; record.updatedAt++; record.operations.push({ id: 'usage', idempotencyKey: 'usage', actor: 'host', kind: 'dispatch', expectedRevision: record.revision, state: 'succeeded', payload: { budgetUsage: { tokens: 100 } } });
  expect(missionMadeProgress(before, record)).toBe(false);
  record.evidence.push(duplicate); expect(missionMadeProgress(before, record)).toBe(false);
});

it('keeps the configured retry bound scoped to exact check/content and does not reset it for unrelated decisions', () => {
  const first = evidence(), record = missionFixture({ evidence: [first, evidence({ id: 'second' }), evidence({ id: 'third' })] });
  const check = { id: first.checkId, kind: 'test' as const, command: first.commandOrFlow }, scope = verificationScope(1, check, first.sourceRevision);
  expect(verificationRetryIssue(record, scope)).toMatchObject({ attempts: record.config.limits.maxTaskAttemptsBeforeLeadDiagnosis, evidenceId: 'third' });
  expect(verificationRetryIssue(record, verificationScope(1, check, { ...first.sourceRevision, contentHash: 'changed' }))).toBeUndefined();
  record.decisions.push({ id: 'unrelated', question: 'Other question', requestedBy: 'lead', evidenceIds: [], affectedTaskIds: [], resolution: 'Other answer', rationale: 'Not a diagnosis of this failure' });
  expect(verificationRetryIssue(record, scope)).toBeDefined();
  record.decisions.push({ id: 'diagnosis', question: 'Why this fails', requestedBy: 'lead', evidenceIds: ['third'], affectedTaskIds: [], resolution: 'Changed approach', rationale: 'Diagnosed retained output' });
  expect(verificationRetryIssue(record, scope)).toBeUndefined();
});

it('ignores only runner timings and owned paths when comparing reports, including JSON also captured on stdout', () => {
  const report = (cwd: string, time: number, failureMessage = 'assertion failed') => JSON.stringify({ startTime: time, endTime: time + 3,
    numFailedTests: 1, testResults: [{ name: `${cwd}/case.ts`, startTime: time, endTime: time + 2, assertionResults: [{ duration: time, failureMessages: [failureMessage] }] }] });
  const first = report('/first', 1), retry = report('/retry', 500);
  expect(verificationOutcomeHash([first, '', first], ['/first'], 'vitest-json')).toBe(verificationOutcomeHash([retry, '', retry], ['/retry'], 'vitest-json'));
  const changed = report('/retry', 500, 'a new failure');
  expect(verificationOutcomeHash([retry, '', retry], ['/retry'], 'vitest-json')).not.toBe(verificationOutcomeHash([changed, '', changed], ['/retry'], 'vitest-json'));
  expect(verificationOutcomeHash(['not ok 1\n  duration_ms: 1.25\n# duration_ms 2\n'], [], 'node-tap')).toBe(verificationOutcomeHash(['not ok 1\n  duration_ms: 9.75\n# duration_ms 100\n'], [], 'node-tap'));
});
