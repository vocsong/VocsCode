/** Exercises the production reducer at its model, host and persistence boundaries. All events
 * are explicit observations; send() resolving never stands in for a terminal turn or evidence. */
import { describe, expect, it } from 'vitest';
import { createDefaultMissionConfig, type ExecutionPreset } from '../src/shared/mission-config';
import type { MissionAttempt, MissionCodeRevision, MissionEvidence, MissionProfile, MissionRecord, MissionResult, MissionReview, MissionTask } from '../src/shared/mission';
import { assertMissionMutation, assertMissionRecord, completionBlockers, implementationBlockers, missionCompletionReport, missionMutationPayloadSchema, readyTasks, reduceMission, type MissionActor, type MissionMutation, type MissionTaskContract } from '../src/main/mission/state';

const host: MissionActor = { kind: 'host' };
const lead: MissionActor = { kind: 'lead', sessionId: 'lead-session', generation: 1 };
const user: MissionActor = { kind: 'user', actionId: 'user-proceed' };
const worker: MissionActor = { kind: 'worker', sessionId: 'worker-session', generation: 1, attemptId: 'a1' };
const reviewer: MissionActor = { kind: 'worker', sessionId: 'reviewer-session', generation: 1, attemptId: 'a-review' };
const baseline: MissionCodeRevision = { baseCommitSha: 'base-sha', contentHash: 'base-tree' };
const finalRevision: MissionCodeRevision = { baseCommitSha: 'base-sha', contentHash: 'final-tree', artifactId: 'patch1' };
const leadPreset: ExecutionPreset = { id: 'frontier', revision: 1, name: 'Principal', harnessId: 'pi', model: { provider: 'provider', model: 'frontier-model' }, reasoning: { kind: 'default' }, enabled: true };
const workerPreset: ExecutionPreset = { ...leadPreset, id: 'standard', name: 'Specialist', model: { provider: 'provider', model: 'standard-model' } };
const profile: MissionProfile = { id: 'implementer', revision: 1, name: 'Implementer', purpose: 'Implement the assigned change', instructions: 'Stay within the contract', tierId: 3, contextRefs: [], requestedTools: ['read', 'write'], sourceAccess: 'assigned_workspace', resultExpectations: 'Candidate and captured checks' };
const reviewProfile: MissionProfile = { ...profile, id: 'reviewer', name: 'Reviewer', purpose: 'Independently challenge the candidate', requestedTools: ['read'], sourceAccess: 'read_only' };
const task: MissionTaskContract = {
  id: 't1', revision: 1, specificationRevision: 1, objective: 'Fix the feature', scope: 'Feature module', ownedPaths: ['src/feature.ts'], exclusions: [], dependsOn: [], decisionRefs: [], sharedContracts: [], requiredTools: ['write'],
  criteria: [{ id: 'correctness', description: 'The requested behavior passes its regression test', required: true, evidenceKinds: ['test'] }], verificationIds: ['unit'], assignment: { kind: 'worker', profileId: profile.id, profileRevision: profile.revision }, required: true
};
function initial(mode: MissionRecord['entryMode'] = 'autonomous'): MissionRecord {
  const config = createDefaultMissionConfig(); config.presets = [structuredClone(leadPreset), structuredClone(workerPreset)];
  config.tiers.find((t) => t.id === 5)!.presetIds = [leadPreset.id]; config.tiers.find((t) => t.id === 3)!.presetIds = [workerPreset.id]; config.defaultLeadPresetId = leadPreset.id;
  return {
    schemaVersion: 1, id: 'mission1', revision: 0, lastEventSequence: 0, title: 'Feature Mission', objective: 'Fix the feature', projectRoot: '/repo', sourceCwd: '/repo', sourceUserActionId: 'launch-action',
    leadSessionId: 'lead-session', leadGeneration: 1, leadPreset: structuredClone(leadPreset), config, providerRestrictions: {}, configHistory: [], entryMode: mode, phase: 'planning', status: 'created', requestedPermissionMode: 'accept-edits', specificationRevision: 1, planRevision: 0,
    ...(mode === 'autonomous' ? { executionAuthorization: { kind: 'autonomous_launch' as const, sourceUserActionId: 'launch-action', specificationRevision: 1, recordedAt: 1 } } : {}),
    questions: [], plan: { objective: 'Fix the feature', scope: 'Feature module', exclusions: [], behavior: 'Correct feature behavior', integrationPoints: [], verificationApproach: 'A real regression test', criteria: structuredClone(task.criteria), assumptions: [] },
    decisions: [], profiles: [], tasks: [], attempts: [], candidates: [], evidence: [], reviews: [], operations: [], mailbox: [], workspaces: [],
    deliveryPolicy: { endpoint: 'local_commit', checks: [{ id: 'unit', name: 'Regression tests', kind: 'test', command: 'npm test', criterionIds: ['correctness'], required: true, heavy: false, testReport: { format: 'vitest-json', minimumTests: 1, maximumSkipped: 0 }, timeoutMs: 60_000 }], requireIndependentReview: true, allowPush: false, allowMerge: false, holdConditions: [], holdIsEndpoint: false, provenance: [{ source: 'AGENTS.md', text: 'Verify and retain a local commit' }], fallback: false, conflicts: [] },
    blockers: [], progress: { completedTurns: 0, checkpointsWithoutProgress: 0, lastProgressRevision: 0 }, createdAt: 1, updatedAt: 1
  };
}
const mutate = (r: MissionRecord, actor: MissionActor, m: MissionMutation) => reduceMission(r, actor, m);
function planned(mode: MissionRecord['entryMode'] = 'autonomous'): MissionRecord {
  let r = mutate(initial(mode), host, { kind: 'host.start' });
  r = mutate(r, lead, { kind: 'profile.upsert', profile });
  r = mutate(r, lead, { kind: 'plan.update', expectedPlanRevision: 0, plan: r.plan, tasks: [task] });
  return mutate(r, host, { kind: 'host.baseline.set', revision: baseline });
}
function executing(): MissionRecord { return mutate(planned(), lead, { kind: 'phase.set', phase: 'executing' }); }
function attempt(overrides: Partial<MissionAttempt> = {}): MissionAttempt {
  return { id: 'a1', taskId: 't1', taskRevision: 1, specificationRevision: 1, generation: 1, sessionId: 'worker-session', profile: structuredClone(profile), tierId: 3, preset: structuredClone(workerPreset), selectionReason: 'Bounded implementation', sourceRevision: baseline, workspaceId: 'w1', continuationOwner: 'mission', status: 'created', repairTurns: 0, requestedAt: 5, ...overrides };
}
function dispatch(r = executing(), a = attempt()): MissionRecord {
  r = mutate(r, host, { kind: 'host.workspace.register', workspace: { id: a.workspaceId, role: a.profile ? 'worker' : 'lead', path: `/repo/${a.workspaceId}`, branch: `mission/${a.workspaceId}`, base: a.sourceRevision, ownerSessionId: a.sessionId } });
  r = mutate(r, host, { kind: 'host.attempt.create', attempt: a });
  r = mutate(r, host, { kind: 'host.attempt.transition', attemptId: a.id, expectedStatus: 'created', status: 'starting', at: 5 });
  return mutate(r, host, { kind: 'host.attempt.transition', attemptId: a.id, expectedStatus: 'starting', status: 'running', at: 6 });
}
function evidence(overrides: Partial<MissionEvidence> = {}): MissionEvidence {
  return { id: 'e1', criterionIds: ['correctness'], specificationRevision: 1, taskId: 't1', taskRevision: 1, attemptId: 'a1', sourceRevision: finalRevision, checkId: 'unit', kind: 'test', commandOrFlow: 'npm test', cwd: '/repo/w1', environmentRef: 'isolated-node-runtime', provenance: 'host_executed', result: 'passed', exitCode: 0, executedTests: 1, skippedTests: 0, artifactIds: ['check-log1'], startedAt: 7, endedAt: 8, ...overrides };
}
function result(overrides: Partial<MissionResult> = {}): MissionResult {
  return { taskId: 't1', taskRevision: 1, attemptId: 'a1', specificationRevision: 1, status: 'candidate', summary: 'Fixed and checked the requested behavior', artifactIds: ['patch1'], evidenceIds: ['e1'], decisionIds: [], unresolved: [], ...overrides };
}
function submitted(): MissionRecord {
  let r = dispatch(); r = mutate(r, host, { kind: 'host.evidence.capture', evidence: evidence() }); r = mutate(r, worker, { kind: 'result.report', result: result() });
  r = mutate(r, host, { kind: 'host.attempt.transition', attemptId: 'a1', expectedStatus: 'running', status: 'terminal', outcome: 'submitted', terminalTurnId: 'turn1', at: 9 });
  return mutate(r, host, { kind: 'host.candidate.capture', candidate: { id: 'c1', taskId: 't1', taskRevision: 1, specificationRevision: 1, attemptId: 'a1', sourceRevision: baseline, revision: finalRevision, changedPaths: ['src/feature.ts'], capturedAt: 10 } });
}
function review(): MissionReview { return { id: 'review1', candidateId: 'c1', reviewerAttemptId: 'a-review', sourceRevision: finalRevision, criterionIds: ['correctness'], findings: [], submittedAt: 12 }; }
function reviewed(): MissionRecord {
  let r = mutate(submitted(), lead, { kind: 'task.accept', taskId: 't1', attemptId: 'a1' });
  r = mutate(r, lead, { kind: 'profile.upsert', profile: reviewProfile });
  r = mutate(r, lead, { kind: 'plan.update', expectedPlanRevision: r.planRevision, plan: r.plan, tasks: [{ ...task, id: 'review-task', objective: 'Review the candidate', required: false, criteria: [], verificationIds: [], requiredTools: ['read'], ownedPaths: [], dependsOn: [{ taskId: 't1', condition: 'accepted_artifact' }], assignment: { kind: 'worker', profileId: reviewProfile.id, profileRevision: 1 } }] });
  r = dispatch(r, attempt({ id: 'a-review', taskId: 'review-task', sessionId: 'reviewer-session', profile: reviewProfile, workspaceId: 'w-review', sourceRevision: finalRevision, requestedAt: 11 }));
  r = mutate(r, reviewer, { kind: 'review.submit', review: review() });
  r = mutate(r, reviewer, { kind: 'result.report', result: result({ taskId: 'review-task', attemptId: 'a-review', summary: 'Independent review completed', artifactIds: ['review1'], evidenceIds: [] }) });
  r = mutate(r, host, { kind: 'host.attempt.transition', attemptId: 'a-review', expectedStatus: 'running', status: 'terminal', outcome: 'submitted', terminalTurnId: 'review-turn', at: 13 });
  return mutate(r, lead, { kind: 'task.accept', taskId: 'review-task', attemptId: 'a-review' });
}
function deliverable(): MissionRecord {
  let r = mutate(reviewed(), host, { kind: 'host.integration.promote', candidateId: 'c1', expectedAcceptedRevision: baseline, revision: finalRevision });
  r = mutate(r, lead, { kind: 'phase.set', phase: 'verifying' }); r = mutate(r, lead, { kind: 'phase.set', phase: 'delivering' });
  r = mutate(r, host, { kind: 'host.operation.record', operation: { id: 'delivery-op', idempotencyKey: 'deliver-once', kind: 'deliver', expectedRevision: r.revision, actor: 'host', state: 'intent_recorded', payload: {} } });
  r = mutate(r, host, { kind: 'host.operation.transition', operationId: 'delivery-op', expectedState: 'intent_recorded', state: 'in_flight' });
  r = mutate(r, host, { kind: 'host.delivery.record', delivery: { operationId: 'delivery-op', revision: finalRevision, endpoint: 'local_commit', status: 'delivered', commitSha: 'final-commit', completedAt: 20 } });
  return mutate(r, host, { kind: 'host.operation.transition', operationId: 'delivery-op', expectedState: 'in_flight', state: 'succeeded', resultRef: 'receipt1' });
}
/** Failure must be atomic for both inputs; assertions are not hidden in a catch handler. */
function refuses(r: MissionRecord, actor: MissionActor, m: unknown, message?: RegExp): void {
  const before = structuredClone(r); const payload = structuredClone(m);
  expect(() => reduceMission(r, actor, m as MissionMutation)).toThrow(message);
  expect(r).toEqual(before); expect(m).toEqual(payload);
}

describe('Approved target integration state boundary', () => {
  function refreshing() {
    const r = executing(); r.deliveryPolicy = { ...r.deliveryPolicy, endpoint: 'open_pr', remote: 'origin', targetBranch: 'main', targetHead: 'old-head', allowPush: true };
    const intended = mutate(r, host, { kind: 'host.operation.record', operation: { id: 'target-op', idempotencyKey: 'target-op', kind: 'integrate', expectedRevision: r.revision, actor: 'host', state: 'intent_recorded', payload: { target: 'approved', remote: 'origin', targetBranch: 'main', observationId: 'host-observation' } } });
    return mutate(intended, host, { kind: 'host.operation.transition', operationId: 'target-op', expectedState: 'intent_recorded', state: 'in_flight' });
  }
  const promotion: MissionMutation = { kind: 'host.target.promote', operationId: 'target-op', observationId: 'host-observation', targetHead: 'new-head', expectedAcceptedRevision: baseline, revision: finalRevision };
  it('retains a genuine user publication ceiling on target promotion and rejects widened persisted grants', () => {
    let r = refreshing();
    r.publicationRestrictions = [{ endpoint: 'open_pr', previousEndpoint: 'merge_pr', sourceUserActionId: 'user-no-merge', receivedRevision: r.revision, recordedAt: r.updatedAt, priorRemoteOperationIds: [] }];
    r.deliveryPolicy.provenance.push({ source: 'user:user-no-merge', text: 'User reduced publication to open PR only.' });
    r = mutate(r, host, { kind: 'host.evidence.capture', evidence: evidence({ taskId: undefined, taskRevision: undefined, attemptId: undefined }) });
    const restrictions = structuredClone(r.publicationRestrictions);
    const promoted = mutate(r, host, promotion);
    expect(promoted.deliveryPolicy).toMatchObject({ endpoint: 'open_pr', allowMerge: false, targetHead: 'new-head' });
    expect(promoted.publicationRestrictions).toEqual(restrictions);
    expect(() => assertMissionRecord({ ...promoted, deliveryPolicy: { ...promoted.deliveryPolicy, endpoint: 'merge_pr' } })).toThrow(/publication/);
    expect(() => assertMissionRecord({ ...promoted, deliveryPolicy: { ...promoted.deliveryPolicy, allowMerge: true } })).toThrow(/Publication/);
    expect(() => assertMissionRecord({ ...promoted, deliveryPolicy: { ...promoted.deliveryPolicy, provenance: [] } })).toThrow(/provenance/);
    const local = structuredClone(r);
    local.deliveryPolicy = { ...local.deliveryPolicy, endpoint: 'local_commit', allowPush: false };
    local.publicationRestrictions![0].endpoint = 'local_commit';
    refuses(local, host, promotion, /approved endpoint/);
  });
  it('cannot promote from a model, another observation, a changed baseline or without exact combined-content checks', () => {
    let r = refreshing();
    refuses(r, lead, promotion); refuses(r, host, promotion, /checks/);
    r = mutate(r, host, { kind: 'host.evidence.capture', evidence: evidence({ taskId: undefined, taskRevision: undefined, attemptId: undefined }) });
    refuses(r, host, { ...promotion, observationId: 'model-selected' }, /recorded host/);
    refuses(r, host, { ...promotion, revision: { ...finalRevision, baseCommitSha: 'new-baseline' } }, /baseline/);
    r = mutate(r, host, promotion);
    expect(r.baseline).toEqual(baseline); expect(r.acceptedRevision).toEqual(finalRevision);
    expect(r.deliveryPolicy).toMatchObject({ remote: 'origin', targetBranch: 'main', targetHead: 'new-head' });
    expect(completionBlockers(r, { quiescent: true }).length).toBeGreaterThan(0);
    expect(r.status).toBe('running');
  });
});

// Deliberately drives unknown runtime input rather than just TypeScript types.
describe('Mission storage and tool validation', () => {
  it('exposes strict model payload schemas from production mutations without host-assigned provenance requirements', () => {
    const question = missionMutationPayloadSchema('question.ask');
    expect(question).toMatchObject({ type: 'object', additionalProperties: false, required: ['question'], properties: { question: { additionalProperties: false, properties: { purpose: { enum: ['clarification', 'authorization', 'blocker'] } } } } });
    expect(question.properties).not.toHaveProperty('kind');
    expect(missionMutationPayloadSchema('plan.update')).toMatchObject({ properties: { checks: { type: 'array', items: { additionalProperties: false, properties: { command: { type: 'string' }, testReport: { type: 'object' } } } } } });
    expect(missionMutationPayloadSchema('execution.propose')).toMatchObject({ properties: { proposal: { required: ['id', 'specificationRevision', 'planRevision'] } } });
    expect(() => assertMissionMutation({ kind: 'execution.propose', proposal: { id: 'proposal', specificationRevision: 1, planRevision: 1 } })).toThrow();
  });
  it('accepts all existing permission modes and a not-yet-planned launch', () => {
    const r = initial('interactive_plan'); r.plan.criteria = []; r.deliveryPolicy.checks = []; r.plan.objective = 'Not yet planned';
    for (const mode of ['ask', 'accept-edits', 'plan', 'auto', 'full-auto'] as const) { r.requestedPermissionMode = mode; expect(() => assertMissionRecord(r)).not.toThrow(); }
  });
  it.each([
    ['unknown root fields', (r: Record<string, unknown>) => { r.secret = 'not a settings store'; }],
    ['future schema', (r: Record<string, unknown>) => { r.schemaVersion = 2; }],
    ['noninteger revision', (r: Record<string, unknown>) => { r.revision = 1.2; }],
    ['negative generation', (r: Record<string, unknown>) => { r.leadGeneration = -1; }],
    ['string boolean', (r: Record<string, unknown>) => { r.archived = 'false'; }],
    ['NaN timestamp', (r: Record<string, unknown>) => { r.updatedAt = NaN; }],
    ['missing restrictions', (r: Record<string, unknown>) => { delete r.providerRestrictions; }],
    ['unknown restrictions', (r: Record<string, unknown>) => { r.providerRestrictions = { arbitrary: true }; }],
    ['wrong restrictions', (r: Record<string, unknown>) => { r.providerRestrictions = { allowedProviderIds: 'provider' }; }]
  ])('rejects %s at the persistence boundary', (_name, corrupt) => {
    const r = initial() as unknown as Record<string, unknown>; corrupt(r); expect(() => assertMissionRecord(r)).toThrow();
  });
  it('rejects malformed nested results, configs, actor spoof fields and direct status writes', () => {
    const r = dispatch();
    refuses(r, worker, { kind: 'result.report', result: { ...result(), status: 'completed' } });
    refuses(r, worker, { kind: 'result.report', result: { ...result(), evidenceIds: [null] } });
    refuses(r, worker, { kind: 'result.report', result: result(), actor: { kind: 'host' } });
    refuses(r, worker, { kind: 'phase.set', phase: 'done' });
    refuses(r, user, { kind: 'control.apply_configuration', config: { ...r.config, revision: 2, presets: [{ ...workerPreset, apiKey: 'forbidden' }] } });
    expect(() => assertMissionMutation({ kind: 'host.start', status: 'completed' })).toThrow();
  });
  it('rejects prototypes, getters, cycles and functions before execution', () => {
    const r = initial(); let read = false;
    const accessor = { ...r, get objective() { read = true; return 'hidden'; } };
    expect(() => assertMissionRecord(accessor)).toThrow(/accessor/); expect(read).toBe(false);
    expect(() => assertMissionRecord(Object.assign(Object.create({ privileged: true }), r))).toThrow(/plain data/);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => assertMissionMutation({ kind: 'host.operation.record', operation: { id: 'op', idempotencyKey: 'once', kind: 'dispatch', expectedRevision: 0, actor: 'host', state: 'intent_recorded', payload: cycle } })).toThrow(/Cyclic/);
    expect(() => assertMissionMutation({ kind: 'host.operation.record', operation: { id: 'op', idempotencyKey: 'once', kind: 'dispatch', expectedRevision: 0, actor: 'host', state: 'intent_recorded', payload: { execute: () => true } } })).toThrow(/plain data/);
  });
  it('validates phase/status pairs, launch authority, duplicate IDs and one live lead', () => {
    const cases: Array<(r: MissionRecord) => void> = [
      (r) => { r.phase = 'executing'; }, (r) => { r.status = 'completed'; }, (r) => { r.status = 'waiting_for_user'; },
      (r) => { r.executionAuthorization!.sourceUserActionId = 'invented'; }, (r) => { r.executionAuthorization!.specificationRevision = 2; },
      (r) => { r.leadPreset = workerPreset; }
    ];
    for (const change of cases) { const r = initial(); change(r); expect(() => assertMissionRecord(r)).toThrow(); }
    const r = dispatch(); r.tasks.push(structuredClone(r.tasks[0])); expect(() => assertMissionRecord(r)).toThrow(/Duplicate/);
  });
});

describe('Mission authority and planning', () => {
  it('keeps authorization user-backed, revision-bound and in the same Mission', () => {
    let r = planned('interactive_plan');
    r = mutate(r, lead, { kind: 'question.ask', question: { id: 'q1', text: 'Should the new behavior preserve existing names?' } });
    refuses(r, lead, { kind: 'question.ask', question: { id: 'q2', text: 'Another question?' } }, /one question/);
    refuses(r, lead, { kind: 'question.answer', questionId: 'q1', answer: 'Yes' }, /user action/);
    r = mutate(r, { kind: 'user', actionId: 'design-answer' }, { kind: 'question.answer', questionId: 'q1', answer: 'Yes' });
    expect(r.executionAuthorization).toBeUndefined(); expect(r.questions[0].sourceUserActionId).toBe('design-answer');
    refuses(r, user, { kind: 'execution.authorize', proposalId: 'not-proposed', specificationRevision: 1, at: 2 }, /proposal/);
    r = mutate(r, lead, { kind: 'execution.propose', proposal: { id: 'p1', specificationRevision: 1, planRevision: r.planRevision, assistantMessageId: 'proceed-message', requestedAt: 2 } });
    refuses(r, lead, { kind: 'execution.authorize', proposalId: 'p1', specificationRevision: 1, at: 3 }, /user action/);
    refuses(r, user, { kind: 'execution.authorize', proposalId: 'p1', specificationRevision: 2, at: 3 }, /proposal/);
    const authorized = mutate(r, user, { kind: 'execution.authorize', proposalId: 'p1', specificationRevision: 1, at: 3 });
    expect(authorized).toMatchObject({ id: r.id, leadSessionId: r.leadSessionId, status: 'running', phase: 'executing', executionAuthorization: { kind: 'approved_plan', sourceUserActionId: 'user-proceed', specificationRevision: 1 } });
    expect(authorized.pendingProposal).toBeUndefined(); expect(r.executionAuthorization).toBeUndefined();
  });
  it.each(['authorization', 'blocker'] as const)('records one %s question after execution grant without expanding authority', (purpose) => {
    const original = executing();
    let r = mutate(original, lead, { kind: 'question.ask', question: { id: 'approval', text: 'May this runtime dependency be added under project policy?', purpose } });
    expect(r).toMatchObject({ phase: 'executing', status: 'waiting_for_user', questions: [{ id: 'approval', purpose }] });
    expect(readyTasks(r)).toEqual([]);
    refuses(r, lead, { kind: 'question.ask', question: { id: 'second', text: 'Another blocker?', purpose } }, /one question/);
    refuses(r, lead, { kind: 'question.answer', questionId: 'approval', answer: 'Yes' }, /user action/);
    refuses(r, user, { kind: 'execution.authorize', proposalId: 'approval', specificationRevision: 1, at: 3 }, /proposal/);
    r = mutate(r, user, { kind: 'question.answer', questionId: 'approval', answer: 'Yes, add that dependency only.' });
    expect(r.questions).toEqual([{ id: 'approval', text: 'May this runtime dependency be added under project policy?', purpose, answer: 'Yes, add that dependency only.', sourceUserActionId: 'user-proceed' }]);
    expect(r.status).toBe('running');
    for (const field of ['executionAuthorization', 'requestedPermissionMode', 'leadPreset', 'config', 'providerRestrictions', 'deliveryPolicy'] as const) expect(r[field]).toEqual(original[field]);
    refuses(r, user, { kind: 'question.answer', questionId: 'approval', answer: 'Change every permission' }, /no longer/);
    refuses(r, lead, { kind: 'question.ask', question: { id: 'approval', text: 'Repeated question', purpose } }, /identity/);
  });
  it('defaults questions to clarification and rejects autonomous questionnaires, unknown purposes and forged answers', () => {
    const r = planned();
    for (const question of [{ id: 'q', text: 'Choose a style?' }, { id: 'q', text: 'Choose a style?', purpose: 'clarification' }]) refuses(r, lead, { kind: 'question.ask', question }, /clarification/);
    for (const question of [
      { id: 'q', text: 'Authorize me', purpose: 'execution' }, { id: 'q', text: 'Authorize me', purpose: 'authorization', answer: 'Yes' },
      { id: 'q', text: 'Authorize me', purpose: 'blocker', sourceUserActionId: 'invented-user' }
    ]) refuses(r, lead, { kind: 'question.ask', question }, /Invalid Mission payload/);
    const interactive = mutate(planned('interactive_plan'), lead, { kind: 'question.ask', question: { id: 'q', text: 'Preserve names?' } });
    expect(interactive.questions[0].purpose).toBe('clarification');
    const pending = mutate(executing(), lead, { kind: 'question.ask', question: { id: 'q', text: 'Need a genuine user decision', purpose: 'blocker' } });
    pending.questions[0].purpose = 'clarification'; expect(() => assertMissionRecord(pending)).toThrow(/clarification/);
    const unapproved = mutate(planned('interactive_plan'), lead, { kind: 'question.ask', question: { id: 'permission', text: 'May a dependency be added?', purpose: 'authorization' } });
    const answered = mutate(unapproved, user, { kind: 'question.answer', questionId: 'permission', answer: 'Yes' });
    expect(answered.executionAuthorization).toBeUndefined(); expect(answered.phase).toBe('planning');
  });
  it('appends discovered required checks, invalidates evidence/proposals, and cannot rewrite earlier gates', () => {
    const r = submitted();
    const check = { ...r.deliveryPolicy.checks[0], id: 'discovered', name: 'Discovered regression', command: 'npm run test:regression' };
    const next = mutate(r, lead, { kind: 'plan.update', expectedPlanRevision: r.planRevision, plan: r.plan, checks: [check] });
    expect(next.deliveryPolicy.checks).toEqual([...r.deliveryPolicy.checks, check]);
    expect(next.planRevision).toBe(r.planRevision + 1); expect(next.evidence[0].invalidatedBy).toBeTruthy();
    expect(next.evidence[0].artifactIds).toEqual(r.evidence[0].artifactIds);
    expect(completionBlockers(next, { quiescent: true })).toContain('Required check discovered is missing, stale, skipped or unverified.');
    const repeated = mutate(next, lead, { kind: 'plan.update', expectedPlanRevision: next.planRevision, plan: next.plan, checks: [check] });
    expect(repeated.deliveryPolicy.checks).toHaveLength(2);
    for (const changed of [{ ...check, command: 'echo pass' }, { ...check, required: false }, { ...check, criterionIds: [] }]) refuses(next, lead, { kind: 'plan.update', expectedPlanRevision: next.planRevision, plan: next.plan, checks: [changed] }, /immutable/);
    for (const changed of [{ ...check, id: 'new', required: false }, { ...check, id: 'new', testReport: undefined }, { ...check, id: 'new', criterionIds: [] }]) refuses(next, lead, { kind: 'plan.update', expectedPlanRevision: next.planRevision, plan: next.plan, checks: [changed] }, /required|test|criterion/);
    let proposal = planned('interactive_plan');
    proposal = mutate(proposal, lead, { kind: 'execution.propose', proposal: { id: 'proposal', specificationRevision: 1, planRevision: proposal.planRevision, assistantMessageId: 'proceed', requestedAt: 2 } });
    proposal = mutate(proposal, lead, { kind: 'plan.update', expectedPlanRevision: proposal.planRevision, plan: proposal.plan, checks: [check] });
    expect(proposal.pendingProposal).toBeUndefined(); expect(proposal.status).toBe('running');
    refuses(proposal, user, { kind: 'execution.authorize', proposalId: 'proposal', specificationRevision: 1, at: 3 }, /proposal/);
  });
  it('keeps a pending proposal for nonmaterial rationale/presentation corrections', () => {
    let r = planned('interactive_plan');
    r.plan.assumptions = [{ id: 'style-note', description: 'Existing conventions apply', rationale: 'Project conventons', source: 'AGENTS.md', affectedTaskIds: [], criterionIds: [], status: 'assumed' }];
    r = mutate(r, lead, { kind: 'execution.propose', proposal: { id: 'p1', specificationRevision: 1, planRevision: r.planRevision, assistantMessageId: 'proceed-message', requestedAt: 2 } });
    const plan = structuredClone(r.plan); plan.assumptions[0].rationale = 'Project conventions';
    r = mutate(r, lead, { kind: 'plan.update', expectedPlanRevision: r.planRevision, plan });
    expect(r.pendingProposal).toMatchObject({ id: 'p1', specificationRevision: 1, planRevision: 2, assistantMessageId: 'proceed-message' });
    expect(r.status).toBe('awaiting_execution_approval');
    expect(mutate(r, user, { kind: 'execution.authorize', proposalId: 'p1', specificationRevision: 1, at: 3 }).phase).toBe('executing');
  });
  it('resume and ordinary answers cannot authorize a plan; baseline blockers cannot be bypassed', () => {
    let r = planned('interactive_plan'); r = mutate(r, user, { kind: 'control.pause' }); r = mutate(r, host, { kind: 'host.quiesce', quiescent: true });
    r = mutate(r, user, { kind: 'control.resume', quiescent: true }); expect(r.phase).toBe('planning'); expect(r.executionAuthorization).toBeUndefined(); expect(readyTasks(r)).toEqual([]);
    refuses(r, lead, { kind: 'phase.set', phase: 'executing' }, /authorized/);
    r = mutate(r, lead, { kind: 'execution.propose', proposal: { id: 'p1', specificationRevision: 1, planRevision: 1, assistantMessageId: 'message1', requestedAt: 2 } });
    r = mutate(r, host, { kind: 'host.blocker.add', blocker: { id: 'dirty', kind: 'environment', message: 'Source checkout is dirty' } });
    refuses(r, user, { kind: 'execution.authorize', proposalId: 'p1', specificationRevision: 1, at: 3 }, /baseline/);
  });
  it('allows only read-only specialist admission in planning', () => {
    let r = planned('interactive_plan'); r = mutate(r, lead, { kind: 'profile.upsert', profile: reviewProfile });
    r = mutate(r, lead, { kind: 'plan.update', expectedPlanRevision: 1, plan: r.plan, tasks: [{ ...task, id: 'scout', required: false, ownedPaths: [], requiredTools: ['read'], criteria: [], verificationIds: [], assignment: { kind: 'worker', profileId: reviewProfile.id, profileRevision: 1 } }] });
    expect(readyTasks(r).map((t) => t.id)).toEqual(['scout']);
    expect(dispatch(r, attempt({ id: 'scout-attempt', taskId: 'scout', sessionId: 'scout-session', workspaceId: 'scout-workspace', profile: reviewProfile })).tasks.find((t) => t.id === 'scout')?.status).toBe('running');
    expect(() => dispatch(r)).toThrow(/not ready/);
  });
  it.each([
    { kind: 'lead', sessionId: 'other-session', generation: 1 }, { kind: 'lead', sessionId: 'lead-session', generation: 0 }, { kind: 'lead', sessionId: 'lead-session', generation: 2 }
  ] as MissionActor[])('rejects stale/fabricated lead identity for every model control branch: %j', (actor) => {
    const r = planned(); const mutations: MissionMutation[] = [
      { kind: 'profile.upsert', profile: { ...profile, id: 'other' } }, { kind: 'plan.update', expectedPlanRevision: 1, plan: r.plan },
      { kind: 'phase.set', phase: 'executing' }, { kind: 'decision.request', decision: { id: 'd1', question: 'A choice?', affectedTaskIds: ['t1'], evidenceIds: [] } },
      { kind: 'task.cancel', taskId: 't1', reason: 'Remove it' }
    ];
    for (const m of mutations) refuses(r, actor, m);
  });
  it('workers cannot modify plans/profiles, accept themselves, authorize, control, or forge host facts', () => {
    const r = dispatch(); const mutations: MissionMutation[] = [
      { kind: 'profile.upsert', profile }, { kind: 'plan.update', expectedPlanRevision: 1, plan: r.plan }, { kind: 'task.accept', taskId: 't1', attemptId: 'a1' },
      { kind: 'execution.authorize', proposalId: 'p1', specificationRevision: 1, at: 3 }, { kind: 'control.stop' }, { kind: 'control.resume', quiescent: true },
      { kind: 'host.evidence.capture', evidence: evidence() }, { kind: 'host.complete', quiescent: true }, { kind: 'phase.set', phase: 'executing' }
    ];
    for (const m of mutations) refuses(r, worker, m);
  });
  it('clones all accepted inputs without touching store revision, sequence, timestamps or profiles', () => {
    const r = planned(); const p = { ...profile, revision: 2, instructions: 'New approach' }; const m: MissionMutation = { kind: 'profile.upsert', profile: p };
    const next = mutate(r, lead, m); next.profiles[1].instructions = 'Mutated returned object'; next.plan.criteria[0].description = 'Changed returned criterion';
    expect(r.profiles).toEqual([profile]); expect(p.instructions).toBe('New approach'); expect(r.plan.criteria).toEqual(task.criteria);
    expect([next.revision, next.lastEventSequence, next.updatedAt]).toEqual([r.revision, r.lastEventSequence, r.updatedAt]);
  });
});

describe('Mission tasks, revisions and generation ownership', () => {
  it('rejects cycles, missing/self/duplicate edges and missing profile revisions atomically', () => {
    const r = planned(); const bad: MissionTaskContract[][] = [
      [{ ...task, revision: 2, dependsOn: [{ taskId: 'missing', condition: 'integrated_code' }] }],
      [{ ...task, revision: 2, dependsOn: [{ taskId: 't1', condition: 'accepted_artifact' }] }],
      [{ ...task, revision: 2, dependsOn: [{ taskId: 't2', condition: 'integrated_code' }] }, { ...task, id: 't2', dependsOn: [{ taskId: 't1', condition: 'accepted_artifact' }] }],
      [{ ...task, id: 't2', dependsOn: [{ taskId: 't1', condition: 'accepted_artifact' }, { taskId: 't1', condition: 'integrated_code' }] }],
      [{ ...task, id: 't2', assignment: { kind: 'worker', profileId: 'implementer', profileRevision: 22 } }]
    ];
    for (const tasks of bad) refuses(r, lead, { kind: 'plan.update', expectedPlanRevision: r.planRevision, plan: r.plan, tasks });
  });
  it('distinguishes accepted-artifact dependencies from integrated-code dependencies', () => {
    let r = mutate(submitted(), lead, { kind: 'task.accept', taskId: 't1', attemptId: 'a1' });
    const contracts: MissionTaskContract[] = ['accepted_artifact', 'integrated_code'].map((condition, i) => ({ ...task, id: `child${i}`, dependsOn: [{ taskId: 't1', condition: condition as 'accepted_artifact' | 'integrated_code' }] }));
    r = mutate(r, lead, { kind: 'plan.update', expectedPlanRevision: r.planRevision, plan: r.plan, tasks: contracts });
    expect(readyTasks(r).map((t) => t.id)).toEqual(['child0']);
    const detached = readyTasks(r); detached[0].objective = 'mutated'; expect(r.tasks.find((t) => t.id === 'child0')?.objective).toBe(task.objective);
  });
  it('rejects a plan CAS conflict, rewriting a live contract, and fabricated revisions', () => {
    const r = dispatch();
    refuses(r, lead, { kind: 'plan.update', expectedPlanRevision: 0, plan: r.plan }, /Stale plan/);
    refuses(r, lead, { kind: 'plan.update', expectedPlanRevision: 1, plan: r.plan, tasks: [{ ...task, revision: 2, objective: 'Changed scope' }] }, /running task/);
    const idle = planned(); refuses(idle, lead, { kind: 'plan.update', expectedPlanRevision: 1, plan: idle.plan, tasks: [{ ...task, revision: 3 }] }, /advance exactly/);
  });
  it('material user changes invalidate affected/dependent attempts and approval, not unaffected contracts', () => {
    let r = executing(); r = mutate(r, lead, { kind: 'plan.update', expectedPlanRevision: r.planRevision, plan: r.plan, tasks: [{ ...task, id: 'dependent', dependsOn: [{ taskId: 't1', condition: 'integrated_code' }] }, { ...task, id: 'unaffected' }] });
    r = dispatch(r); const oldTask = structuredClone(r.tasks[0]);
    const next = mutate(r, user, { kind: 'plan.update', expectedPlanRevision: r.planRevision, plan: { ...r.plan, scope: 'Updated user scope' }, material: { source: { kind: 'user', actionId: user.kind === 'user' ? user.actionId : '' }, affectedTaskIds: ['t1'] } });
    expect(next).toMatchObject({ phase: 'planning', status: 'pausing', specificationRevision: 2 }); expect(next.executionAuthorization).toBeUndefined();
    expect(next.tasks.slice(0, 2).map((t) => t.status)).toEqual(['superseded', 'superseded']); expect(next.tasks[2].status).toBe('planned');
    expect(next.tasks[0]).toMatchObject({ revision: oldTask.revision, specificationRevision: oldTask.specificationRevision, objective: oldTask.objective, currentAttemptId: 'a1' });
    refuses(next, worker, { kind: 'result.report', result: result({ evidenceIds: [] }) }, /Obsolete/);
    expect(readyTasks(next)).toEqual([]);
  });
  it('does not let a model invent user approval or redefine away an explicit requirement', () => {
    const r = planned();
    refuses(r, lead, { kind: 'plan.update', expectedPlanRevision: 1, plan: { ...r.plan, criteria: [] }, material: { source: { kind: 'user', actionId: 'faked' }, affectedTaskIds: ['t1'] } }, /required criterion/);
    refuses(r, lead, { kind: 'plan.update', expectedPlanRevision: 1, plan: r.plan, material: { source: { kind: 'user', actionId: 'faked' }, affectedTaskIds: ['t1'] } }, /user action/);
    refuses(r, lead, { kind: 'plan.update', expectedPlanRevision: 1, plan: r.plan, tasks: [{ ...task, revision: 2, required: false }] }, /required task/);
  });
  it('retains autonomous authority for a recorded permitted assumption without routine plan approval', () => {
    const r = planned(); const assumption = { id: 'assumption1', description: 'Use existing module conventions', rationale: 'No contrary user requirement', source: 'Project rules', affectedTaskIds: ['t1'], criterionIds: ['correctness'], status: 'assumed' as const };
    const next = mutate(r, lead, { kind: 'plan.update', expectedPlanRevision: 1, plan: { ...r.plan, assumptions: [assumption] }, material: { source: { kind: 'assumption', assumptionId: 'assumption1' }, affectedTaskIds: ['t1'] } });
    expect(next.executionAuthorization).toMatchObject({ kind: 'autonomous_launch', sourceUserActionId: 'launch-action', specificationRevision: 2 }); expect(next.pendingProposal).toBeUndefined();
  });
  it('profile edits create immutable revisions; attempts preserve their pinned snapshot', () => {
    const r = dispatch(); const next = mutate(r, lead, { kind: 'profile.upsert', profile: { ...profile, revision: 2, tierId: 5, instructions: 'Different specialist instructions' } });
    expect(next.profiles).toHaveLength(2); expect(next.attempts[0].profile).toEqual(profile);
    refuses(next, lead, { kind: 'profile.upsert', profile: { ...profile, instructions: 'Retroactive rewrite' } }, /immutable/);
    const corrupt = structuredClone(next); corrupt.attempts[0].profile!.tierId = 5; expect(() => assertMissionRecord(corrupt)).toThrow(/snapshot/);
  });
  it('configuration snapshots cannot rewrite an old preset revision', () => {
    const r = planned(); const config = structuredClone(r.config); config.revision++;
    config.presets[0].model.model = 'silently-replaced-model';
    refuses(r, user, { kind: 'control.apply_configuration', config }, /immutable/);
    config.presets[0].revision++; const next = mutate(r, user, { kind: 'control.apply_configuration', config });
    expect(next.leadPreset).toEqual(leadPreset); expect(next.configHistory).toEqual([r.config]);
  });
  it('material corrections preserve old criterion contracts on superseded live tasks', () => {
    const r = dispatch(); const criteria = [{ ...r.plan.criteria[0], description: 'Corrected explicit user requirement' }];
    const next = mutate(r, user, { kind: 'plan.update', expectedPlanRevision: r.planRevision, plan: { ...r.plan, criteria }, material: { source: { kind: 'user', actionId: 'user-proceed' }, affectedTaskIds: ['t1'] } });
    expect(next.tasks[0].criteria).toEqual(task.criteria); expect(next.plan.criteria).toEqual(criteria); expect(next.tasks[0].status).toBe('superseded');
  });
  it('enforces one live attempt per task and session, whole approved preset and provider restrictions', () => {
    const r = dispatch(); refuses(r, host, { kind: 'host.attempt.create', attempt: attempt({ id: 'a2', generation: 2 }) }, /not ready/);
    for (const restrictions of [{ allowedProviderIds: [] }, { allowedConnectionIds: [] }]) { const blocked = executing(); blocked.providerRestrictions = restrictions; expect(() => dispatch(blocked)).toThrow(/not permitted/); }
    expect(() => dispatch(executing(), attempt({ preset: { ...workerPreset, model: { provider: 'invented', model: 'unknown' } } }))).toThrow(/preset/);
    const duplicate = structuredClone(r); duplicate.attempts.push({ ...duplicate.attempts[0], id: 'a2' }); expect(() => assertMissionRecord(duplicate)).toThrow(/one current active attempt/);
  });
  it('only the assigned identity may report; identical duplicates are inert and conflicting/delayed results fail', () => {
    let r = dispatch(); r = mutate(r, host, { kind: 'host.evidence.capture', evidence: evidence() });
    const badActors: MissionActor[] = [lead, { ...worker, sessionId: 'other' }, { ...worker, generation: 2 }, { kind: 'worker', sessionId: 'worker-session', generation: 1, attemptId: 'missing' }];
    for (const actor of badActors) refuses(r, actor, { kind: 'result.report', result: result() });
    refuses(r, worker, { kind: 'result.report', result: result({ taskRevision: 2 }) }, /contract/);
    r = mutate(r, worker, { kind: 'result.report', result: result() }); const repeated = mutate(r, worker, { kind: 'result.report', result: result() }); expect(repeated).toEqual(r);
    refuses(r, worker, { kind: 'result.report', result: result({ summary: 'different' }) }, /Conflicting duplicate/);
    const failed = mutate(dispatch(), host, { kind: 'host.attempt.transition', attemptId: 'a1', expectedStatus: 'running', status: 'terminal', outcome: 'failed', at: 9, failure: { kind: 'protocol', message: 'No structured result' } });
    refuses(failed, worker, { kind: 'result.report', result: result({ evidenceIds: [] }) }, /delayed/);
  });
  it('requires terminal observation, not a result alone, and allows one result-format repair', () => {
    let r = dispatch(); r = mutate(r, host, { kind: 'host.attempt.repair', attemptId: 'a1' }); refuses(r, host, { kind: 'host.attempt.repair', attemptId: 'a1' }, /one bounded/);
    r = mutate(r, host, { kind: 'host.evidence.capture', evidence: evidence() }); r = mutate(r, worker, { kind: 'result.report', result: result() });
    expect(r.tasks[0].status).toBe('running'); refuses(r, lead, { kind: 'task.accept', taskId: 't1', attemptId: 'a1' }, /settled candidate/);
    refuses(r, host, { kind: 'host.attempt.transition', attemptId: 'a1', expectedStatus: 'running', status: 'terminal', outcome: 'submitted', at: 9 }, /terminal turn/);
  });
  it('blocks retries after the configured failed-attempt budget until lead diagnosis', () => {
    let r = executing(); r.config.limits.maxTaskAttemptsBeforeLeadDiagnosis = 1; r = dispatch(r);
    r = mutate(r, host, { kind: 'host.attempt.transition', attemptId: 'a1', expectedStatus: 'running', status: 'terminal', outcome: 'failed', at: 9, failure: { kind: 'implementation', message: 'Wrong approach' } });
    const a2 = attempt({ id: 'a2', generation: 2, requestedAt: 10 });
    refuses(r, host, { kind: 'host.attempt.create', attempt: a2 }, /diagnosis/);
    r = mutate(r, lead, { kind: 'task.diagnose', taskId: 't1', afterAttempt: 'a1', approach: 'Reproduce the race before changing lifecycle code' });
    expect(mutate(r, host, { kind: 'host.attempt.create', attempt: a2 }).attempts).toHaveLength(2);
  });
  it('routes worker decisions only within assignment; a shared decision makes inputs stale', () => {
    let r = dispatch(); refuses(r, worker, { kind: 'decision.request', decision: { id: 'd1', question: 'Change sibling?', evidenceIds: [], affectedTaskIds: ['not-my-task'] } }, /exceeds/);
    r = mutate(r, worker, { kind: 'decision.request', decision: { id: 'd1', question: 'Change shared contract?', evidenceIds: [], affectedTaskIds: ['t1'], proposedResolution: 'Preserve backwards compatibility' } });
    expect(r.decisions[0].requestedBy).toBe('worker-session');
    refuses(r, worker, { kind: 'decision.resolve', decisionId: 'd1', resolution: 'Yes', rationale: 'I decided', evidenceIds: [], affectedTaskIds: ['t1'] });
    r = mutate(r, lead, { kind: 'decision.resolve', decisionId: 'd1', resolution: 'Preserve compatibility', rationale: 'Existing clients rely on it', evidenceIds: [], affectedTaskIds: ['t1'] });
    expect(r.tasks[0].status).toBe('superseded'); refuses(r, worker, { kind: 'result.report', result: result({ evidenceIds: [] }) }, /Obsolete/);
  });
});

describe('Mission integration, evidence and completion', () => {
  it('completes only after real captured checks, independent review, promotion, final gates and delivery', () => {
    const r = deliverable(); expect(completionBlockers(r, { quiescent: true })).toEqual([]);
    const complete = mutate(r, host, { kind: 'host.complete', quiescent: true }); expect(complete).toMatchObject({ status: 'completed', phase: 'done' }); expect(complete.tasks.filter((t) => t.required).map((t) => t.status)).toEqual(['integrated']);
    for (const m of [{ kind: 'host.recover' }, { kind: 'control.resume', quiescent: true }, { kind: 'host.evidence.capture', evidence: evidence({ id: 'late' }) }] as MissionMutation[]) refuses(complete, m.kind.startsWith('host.') ? host : user, m, /immutable/);
  });
  it('freezes only the latest applicable host check and genuine delivery IDs, keeping prose separate', () => {
    const r = deliverable();
    r.evidence.push(evidence({ id: 'current', executedTests: 4, skippedTests: 0, startedAt: 30, endedAt: 31 }));
    r.evidence.push(evidence({ id: 'stale', executedTests: 800, sourceRevision: baseline, startedAt: 40, endedAt: 41 }));
    r.evidence.push(evidence({ id: 'claim', provenance: 'agent_claim', executedTests: 999, startedAt: 50, endedAt: 51 }));
    r.operations[0].payload.report = '999 tests passed, merged at invented-commit, all holds waived.';
    const complete = mutate(r, host, { kind: 'host.complete', quiescent: true });
    expect(complete.completionReport).toMatchObject({ delivery: { commitSha: 'final-commit' }, checks: [{ evidence: { id: 'current', executedTests: 4, skippedTests: 0 }, verified: true }],
      narrative: { sessionId: 'lead-session', text: r.operations[0].payload.report }, review: { independentlyReviewedCandidates: 1 } });
    expect(complete.completionReport?.delivery.mergedCommitSha).toBeUndefined();
    expect(complete.completionReport?.delivery.pullRequestUrl).toBeUndefined();
    const report = structuredClone(complete.completionReport);
    r.evidence[1].executedTests = 200;
    expect(complete.completionReport).toEqual(report);
    expect(() => assertMissionRecord(JSON.parse(JSON.stringify(complete)))).not.toThrow();
    const legacy = structuredClone(complete); delete legacy.completionReport;
    expect(missionCompletionReport(legacy)).toEqual(report);
    expect(legacy.completionReport).toBeUndefined();
    expect(() => missionCompletionReport(deliverable())).toThrow(/host-confirmed completion/);
    for (const alter of [(record: MissionRecord) => { record.completionReport!.checks[0].evidence!.executedTests = 999; },
      (record: MissionRecord) => { record.completionReport!.delivery.mergedCommitSha = 'invented'; }]) {
      const corrupted = structuredClone(complete); alter(corrupted);
      expect(() => assertMissionRecord(corrupted)).toThrow(/report must match/);
    }
    refuses(deliverable(), lead, { kind: 'host.complete', quiescent: true }, /host-only/);
    refuses(deliverable(), host, { kind: 'host.complete', quiescent: true, report: 'Model completion' });
  });
  it('delivery preflight needs no fake receipt and exempts only its exact in-flight delivery operation', () => {
    const r = deliverable(); delete r.delivery; r.operations[0].state = 'in_flight';
    expect(implementationBlockers(r, { quiescent: true, deliveryOperationId: 'delivery-op' })).toEqual([]);
    expect(implementationBlockers(r, { quiescent: true })).toContain('Pending operations remain.');
    expect(completionBlockers(r, { quiescent: true })).toContain('Pending operations remain.');
    expect(implementationBlockers(r, { quiescent: true, deliveryOperationId: 'wrong-op' })).toContain('Delivery preflight does not identify its own in-flight delivery operation.');
    r.operations.push({ id: 'other-delivery', idempotencyKey: 'other-once', kind: 'deliver', expectedRevision: 0, actor: 'host', state: 'in_flight', payload: {} });
    expect(implementationBlockers(r, { quiescent: true, deliveryOperationId: 'delivery-op' })).toContain('Pending operations remain.');
    r.operations.pop(); r.operations[0].state = 'reconciling';
    expect(implementationBlockers(r, { quiescent: true, deliveryOperationId: 'delivery-op' })).toContain('Pending operations remain.');
  });
  it('does not hide a later real failure or skip behind a previous successful check', () => {
    for (const patch of [{ result: 'failed' as const, exitCode: 1 }, { result: 'skipped' as const }, { executedTests: 0 }, { skippedTests: 2 }, { artifactIds: [] }]) {
      const r = deliverable(); r.evidence.push(evidence({ ...patch, id: 'later-check', startedAt: 30, endedAt: 31 }));
      expect(completionBlockers(r, { quiescent: true })).toContain('Required check unit is missing, stale, skipped or unverified.');
      refuses(r, host, { kind: 'host.complete', quiescent: true });
    }
  });
  it('validates retained completed records against the same completion gates', () => {
    const complete = mutate(deliverable(), host, { kind: 'host.complete', quiescent: true });
    for (const alter of [(r: MissionRecord) => { delete r.delivery; }, (r: MissionRecord) => { r.evidence[0].provenance = 'agent_claim'; }, (r: MissionRecord) => { r.reviews = []; }]) {
      const corrupted = structuredClone(complete); alter(corrupted); expect(() => assertMissionRecord(corrupted)).toThrow(/completion gates/);
    }
  });
  it('binds the delivery target head and validates merge policy values without inventing them', () => {
    const r = deliverable(); r.deliveryPolicy.targetHead = 'observed-target-sha'; r.deliveryPolicy.mergeMethod = 'rebase';
    expect(completionBlockers(r, { quiescent: true })).toContain('Delivery target differs from policy.');
    r.delivery!.expectedTargetHead = 'observed-target-sha'; expect(completionBlockers(r, { quiescent: true })).toEqual([]);
    (r.deliveryPolicy as unknown as Record<string, unknown>).mergeMethod = 'force-push'; expect(() => assertMissionRecord(r)).toThrow();
  });
  it('requires accepted-revision CAS and independent review before integration', () => {
    const unreviewed = mutate(submitted(), lead, { kind: 'task.accept', taskId: 't1', attemptId: 'a1' });
    refuses(unreviewed, host, { kind: 'host.integration.promote', candidateId: 'c1', expectedAcceptedRevision: baseline, revision: finalRevision }, /Independent review/);
    refuses(reviewed(), host, { kind: 'host.integration.promote', candidateId: 'c1', expectedAcceptedRevision: { ...baseline, contentHash: 'stale' }, revision: finalRevision }, /compare-and-swap/);
  });
  it.each([
    ['agent claim', { provenance: 'agent_claim' }], ['skipped', { result: 'skipped' }], ['missing', { result: 'not_run' }], ['blocked', { result: 'blocked' }],
    ['zero tests', { executedTests: 0 }], ['missing counts', { executedTests: undefined }], ['skipped tests', { skippedTests: 1 }], ['missing skip count', { skippedTests: undefined }],
    ['failed process', { exitCode: 1 }], ['missing process status', { exitCode: undefined }], ['unfinished capture', { endedAt: undefined }], ['no logs', { artifactIds: [] }],
    ['stale content', { sourceRevision: baseline }], ['invalidated', { invalidatedBy: 'Environment changed' }], ['different command', { commandOrFlow: 'echo success' }],
    ['waiver prose', { result: 'waived', exception: { sourceUserActionId: 'model-invented', reason: 'Trust me' } }]
  ] satisfies Array<[string, Partial<MissionEvidence>]>)('refuses completion with %s evidence', (_name, patch) => {
    const r = deliverable(); Object.assign(r.evidence[0], patch);
    expect(completionBlockers(r, { quiescent: true })).toContain('Required check unit is missing, stale, skipped or unverified.');
    refuses(r, host, { kind: 'host.complete', quiescent: true }, /evidence|check/);
  });
  it('does not impose test counts on build checks; identical content under a new commit retains evidence', () => {
    const r = deliverable(); r.deliveryPolicy.checks[0] = { ...r.deliveryPolicy.checks[0], kind: 'build', command: 'npm run build', testReport: undefined };
    r.plan.criteria[0].evidenceKinds = ['build']; r.tasks[0].criteria[0].evidenceKinds = ['build']; r.evidence[0] = { ...r.evidence[0], kind: 'build', commandOrFlow: 'npm run build', executedTests: undefined, skippedTests: undefined };
    r.delivery!.revision = { ...finalRevision, baseCommitSha: 'new-commit-same-tree' };
    expect(completionBlockers(r, { quiescent: true })).toEqual([]);
  });
  it('refuses absent/self/stale/unsettled reviews and unresolved mandatory findings', () => {
    const changes: Array<(r: MissionRecord) => void> = [
      (r) => { r.reviews = []; }, (r) => { r.reviews[0].reviewerAttemptId = 'a1'; },
      (r) => { r.reviews[0].sourceRevision = baseline; }, (r) => { r.attempts[1].terminalTurnId = undefined; r.attempts[1].outcome = 'partial'; r.tasks[1].status = 'changes_requested'; },
      (r) => { r.reviews[0].findings.push({ id: 'critical1', severity: 'critical', description: 'Cancellation leaves a writer alive', evidenceIds: ['e1'], criterionIds: ['correctness'], reproduction: 'Stop during a tool call' }); }
    ];
    for (const change of changes) { const r = deliverable(); change(r); expect(completionBlockers(r, { quiescent: true }).some((b) => /review|finding/.test(b))).toBe(true); refuses(r, host, { kind: 'host.complete', quiescent: true }); }
  });
  it('refuses a live optional writer even when a caller incorrectly reports quiescence', () => {
    const r = deliverable(); r.tasks.push({ ...structuredClone(task), id: 'optional-task', required: false, status: 'running', currentAttemptId: 'optional-attempt' });
    r.attempts.push(attempt({ id: 'optional-attempt', taskId: 'optional-task', sessionId: 'optional-worker', workspaceId: 'optional-workspace', status: 'running', sourceRevision: finalRevision }));
    r.workspaces.push({ id: 'optional-workspace', path: '/repo/optional', branch: 'mission/optional', role: 'worker', ownerSessionId: 'optional-worker', base: finalRevision });
    expect(completionBlockers(r, { quiescent: true })).toContain('Owned activity is not quiescent.');
    refuses(r, host, { kind: 'host.complete', quiescent: true });
  });
  it('known model substitution or missing criterion review cannot count as adherence', () => {
    const r = deliverable(); r.attempts[0].effectiveModel = { provider: 'provider', model: 'unapproved-model' };
    expect(completionBlockers(r, { quiescent: true })).toContain('Task t1 has a known effective preset mismatch.');
    delete r.attempts[0].effectiveModel; r.reviews[0].criterionIds = [];
    expect(completionBlockers(r, { quiescent: true })).toContain('Candidate c1 lacks independent review.');
  });
  it('requires finding resolutions to have real source-bound evidence', () => {
    let r = deliverable(); r.reviews[0].findings.push({ id: 'major1', severity: 'major', description: 'Concern about regression', evidenceIds: ['e1'], criterionIds: ['correctness'], reproduction: 'Run the reproducer' });
    r = mutate(r, lead, { kind: 'finding.resolve', reviewId: 'review1', findingId: 'major1', resolution: { kind: 'rejected', reason: 'Captured regression result disproves this finding', evidenceIds: ['e1'] } });
    expect(completionBlockers(r, { quiescent: true })).toEqual([]); r.evidence[0].provenance = 'agent_claim'; expect(completionBlockers(r, { quiescent: true }).some((b) => /finding/.test(b))).toBe(true);
  });
  it('refuses quiescence uncertainty, pending operations, unfinished delivery and policy mismatch', () => {
    const r = deliverable(); expect(completionBlockers(r, { quiescent: false })).toContain('Owned activity is not quiescent.');
    const changes: Array<(record: MissionRecord) => void> = [
      (v) => { v.operations[0].state = 'reconciling'; }, (v) => { v.delivery!.status = 'blocked'; }, (v) => { v.delivery!.revision = baseline; },
      (v) => { v.delivery!.endpoint = 'merge_pr'; }, (v) => { delete v.delivery!.commitSha; }, (v) => { v.deliveryPolicy.targetBranch = 'develop'; },
      (v) => { v.deliveryPolicy.conflicts.push('Conflicting authoritative instructions'); }, (v) => { v.decisions.push({ id: 'd1', question: 'Unresolved architecture', requestedBy: 'lead-session', evidenceIds: [], affectedTaskIds: [] }); }
    ];
    for (const change of changes) { const altered = structuredClone(r); change(altered); expect(completionBlockers(altered, { quiescent: true }).length).toBeGreaterThan(0); refuses(altered, host, { kind: 'host.complete', quiescent: true }); }
  });
  it('does not count required canceled/superseded tasks or silently treat a hold as delivery', () => {
    for (const status of ['canceled', 'superseded'] as const) { const r = deliverable(); for (const task of r.tasks) { task.status = status; task.reason = 'Retained old outcome'; } expect(completionBlockers(r, { quiescent: true }).some((b) => /not satisfied/.test(b))).toBe(true); }
    const r = deliverable(); r.delivery!.status = 'held'; r.delivery!.reason = 'Waiting for review'; expect(completionBlockers(r, { quiescent: true })).toContain('Delivery hold is not an authorized endpoint.');
    r.deliveryPolicy.holdIsEndpoint = true; r.deliveryPolicy.holdConditions = ['Waiting for review']; expect(completionBlockers(r, { quiescent: true })).toEqual([]);
  });
  it('evidence and host-captured candidates are immutable even to duplicate host callbacks', () => {
    const r = submitted(); expect(mutate(r, host, { kind: 'host.evidence.capture', evidence: evidence() })).toEqual(r);
    refuses(r, host, { kind: 'host.evidence.capture', evidence: evidence({ result: 'failed' }) }, /Conflicting duplicate/);
    refuses(r, host, { kind: 'host.candidate.capture', candidate: { ...r.candidates[0], changedPaths: ['different.ts'] } }, /Conflicting duplicate/);
  });
});

describe('Mission recovery, pause, stop and operational intent', () => {
  it('pause closes admission immediately but reports can settle before host-confirmed quiescence', () => {
    let r = mutate(dispatch(), user, { kind: 'control.pause' }); expect(r.status).toBe('pausing'); expect(readyTasks(r)).toEqual([]);
    refuses(r, host, { kind: 'host.quiesce', quiescent: true }, /quiescent/);
    refuses(r, lead, { kind: 'profile.upsert', profile: { ...profile, revision: 2 } }, /not live/);
    r = mutate(r, worker, { kind: 'result.report', result: result({ status: 'partial', evidenceIds: [] }) });
    r = mutate(r, host, { kind: 'host.attempt.transition', attemptId: 'a1', expectedStatus: 'running', status: 'terminal', outcome: 'interrupted', at: 10 });
    r = mutate(r, host, { kind: 'host.quiesce', quiescent: true }); expect(r.status).toBe('paused'); expect(r.attempts[0].result?.status).toBe('partial');
    r = mutate(r, user, { kind: 'control.resume', quiescent: true }); expect(r.status).toBe('running'); expect(r.executionAuthorization?.kind).toBe('autonomous_launch');
  });
  it('restart recovery reconciles operations and pauses without restarting mutations', () => {
    let r = dispatch(); r = mutate(r, host, { kind: 'host.operation.record', operation: { id: 'capture1', idempotencyKey: 'capture-once', kind: 'capture', actor: 'host', expectedRevision: 0, state: 'intent_recorded', payload: { attemptId: 'a1' } } });
    r = mutate(r, host, { kind: 'host.recover' }); expect(r.status).toBe('recovering'); expect(r.leadGeneration).toBe(2); expect(r.operations[0].state).toBe('reconciling'); expect(readyTasks(r)).toEqual([]);
    refuses(r, lead, { kind: 'phase.set', phase: 'executing' }, /live principal/);
    refuses(r, host, { kind: 'host.operation.record', operation: { id: 'new', idempotencyKey: 'new', kind: 'dispatch', actor: 'host', expectedRevision: 0, state: 'intent_recorded', payload: {} } }, /not admitting/);
    r = mutate(r, host, { kind: 'host.attempt.transition', attemptId: 'a1', expectedStatus: 'running', status: 'terminal', outcome: 'interrupted', at: 12 });
    r = mutate(r, host, { kind: 'host.operation.transition', operationId: 'capture1', expectedState: 'reconciling', state: 'failed', error: 'Interrupted before capture' });
    r = mutate(r, host, { kind: 'host.quiesce', quiescent: true }); expect(r.status).toBe('paused'); expect(r.attempts).toHaveLength(1); expect(r.operations).toHaveLength(1);
    expect(mutate(executing(), host, { kind: 'host.recover' }).status).toBe('paused');
  });
  it('lead handover is user-only, quiescent, T5, generation-revoking and never a second lead', () => {
    let r = planned(); refuses(r, user, { kind: 'control.replace_lead', sessionId: 'new-lead', preset: leadPreset, quiescent: true }, /Pause/);
    r = mutate(r, user, { kind: 'control.pause' }); r = mutate(r, host, { kind: 'host.quiesce', quiescent: true });
    refuses(r, user, { kind: 'control.replace_lead', sessionId: 'new-lead', preset: workerPreset, quiescent: true }, /T5/);
    refuses(r, user, { kind: 'control.replace_lead', sessionId: 'new-lead', preset: leadPreset, quiescent: false }, /quiescent/);
    r = mutate(r, user, { kind: 'control.replace_lead', sessionId: 'new-lead', preset: leadPreset, quiescent: true }); r = mutate(r, user, { kind: 'control.resume', quiescent: true });
    expect(r.leadGeneration).toBe(2); refuses(r, lead, { kind: 'profile.upsert', profile }, /live principal/);
    expect(mutate(r, { kind: 'lead', sessionId: 'new-lead', generation: 2 }, { kind: 'profile.upsert', profile })).toEqual(r);
  });
  it('stop is terminal, retains artifacts and refuses delayed reports and every subsequent write', () => {
    let r = mutate(dispatch(), user, { kind: 'control.stop' }); expect(r.status).toBe('stopping');
    refuses(r, worker, { kind: 'result.report', result: result({ evidenceIds: [] }) }, /identity/);
    r = mutate(r, host, { kind: 'host.attempt.transition', attemptId: 'a1', expectedStatus: 'running', status: 'terminal', outcome: 'canceled', at: 12 }); r = mutate(r, host, { kind: 'host.quiesce', quiescent: true });
    expect(r).toMatchObject({ status: 'stopped', leadGeneration: 2 }); expect(r.workspaces).toHaveLength(1); expect(r.attempts).toHaveLength(1);
    for (const m of [{ kind: 'control.resume', quiescent: true }, { kind: 'host.recover' }, { kind: 'host.start' }, { kind: 'control.steer', text: 'Wake up', at: 20 }] as MissionMutation[]) refuses(r, m.kind.startsWith('host.') ? host : user, m, /immutable/);
  });
  it.each(['paused', 'stopped', 'completed'] as const)('permits only journaled user cleanup maintenance on a %s Mission', (status) => {
    let r = deliverable();
    if (status === 'completed') r = mutate(r, host, { kind: 'host.complete', quiescent: true });
    else { r = mutate(r, user, { kind: status === 'stopped' ? 'control.stop' : 'control.pause' }); r = mutate(r, host, { kind: 'host.quiesce', quiescent: true }); }
    const before = structuredClone(r);
    const operation = { id: 'cleanup', idempotencyKey: 'cleanup-once', kind: 'cleanup' as const, actor: 'user:user-proceed', expectedRevision: r.revision, state: 'intent_recorded' as const,
      payload: { request: { missionId: r.id, expectedRevision: r.revision, idempotencyKey: 'cleanup-once', control: { action: 'cleanup' } }, workspaceIds: ['w1'], receipts: [] } };
    refuses(r, host, { kind: 'host.operation.record', operation: { ...operation, payload: { ...operation.payload, workspaceIds: ['not-owned'] } } }, /workspace/);
    refuses(r, host, { kind: 'host.operation.record', operation: { ...operation, actor: 'lead' } }, /user/);
    r = mutate(r, host, { kind: 'host.operation.record', operation });
    r = mutate(r, host, { kind: 'host.operation.transition', operationId: operation.id, expectedState: 'intent_recorded', state: 'in_flight' });
    refuses(r, host, { kind: 'host.operation.transition', operationId: operation.id, expectedState: 'in_flight', state: 'succeeded' }, /receipt/);
    if (status === 'completed') {
      expect(completionBlockers(r, { quiescent: true })).toEqual([]);
      const corrupted = structuredClone(r); corrupted.evidence[0].provenance = 'agent_claim'; expect(() => assertMissionRecord(corrupted)).toThrow(/completion gates/);
      refuses(r, host, { kind: 'host.operation.transition', operationId: 'delivery-op', expectedState: 'succeeded', state: 'failed', error: 'Cannot rewrite completed delivery' }, /immutable/);
    }
    const corrupt = structuredClone(r); corrupt.workspaces[0].cleanedAt = 21; expect(() => assertMissionRecord(corrupt)).toThrow(/receipt/);
    r.operations.find((o) => o.id === 'cleanup')!.payload.receipts = [{ workspaceId: 'w1', removed: true }]; r.workspaces[0].cleanedAt = 21;
    r = mutate(r, host, { kind: 'host.operation.transition', operationId: operation.id, expectedState: 'in_flight', state: 'succeeded' });
    expect(r.status).toBe(before.status); expect(r.workspaces).toHaveLength(before.workspaces.length); expect(r.workspaces[0].ownerSessionId).toBe(before.workspaces[0].ownerSessionId);
    for (const field of ['attempts', 'candidates', 'evidence', 'reviews', 'delivery', 'executionAuthorization'] as const) expect(r[field]).toEqual(before[field]);
    expect(() => assertMissionRecord(r)).not.toThrow();
  });
  it('records side-effect intent first, rejects duplicate conflicting operations and stale transitions', () => {
    const op = { id: 'op1', idempotencyKey: 'once', kind: 'verify' as const, actor: 'host', expectedRevision: 0, state: 'intent_recorded' as const, payload: { checkId: 'unit' } };
    let r = mutate(executing(), host, { kind: 'host.operation.record', operation: op }); expect(mutate(r, host, { kind: 'host.operation.record', operation: op })).toEqual(r);
    refuses(r, host, { kind: 'host.operation.record', operation: { ...op, id: 'op2' } }, /idempotency/);
    refuses(r, host, { kind: 'host.operation.record', operation: { ...op, payload: { checkId: 'different' } } }, /Conflicting/);
    refuses(r, host, { kind: 'host.operation.transition', operationId: 'op1', expectedState: 'intent_recorded', state: 'succeeded' }, /Invalid operation/);
    r = mutate(r, host, { kind: 'host.operation.transition', operationId: 'op1', expectedState: 'intent_recorded', state: 'in_flight' });
    refuses(r, host, { kind: 'host.operation.transition', operationId: 'op1', expectedState: 'intent_recorded', state: 'failed', error: 'stale' }, /Stale/);
  });
});
