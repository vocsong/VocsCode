/** Pure Mission transitions. Authenticated actors and host observations come from the service,
 * never from model arguments. No clocks, IO, scheduling or store revision/sequence writes here. */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { candidateScopeIssue } from './scope';
import { isMissionQuestionOperation } from '../../shared/mission';
import { createDefaultMissionConfig, validateMissionConfig, type ExecutionPreset, type MissionConfig } from '../../shared/mission-config';
import type {
  MissionAttempt, MissionCandidate, MissionCheck, MissionCodeRevision, MissionCompletionReport, MissionDecision, MissionDelivery, MissionEvidence,
  MissionMailboxItem, MissionOperation, MissionPhase, MissionPlan, MissionProfile, MissionProposal,
  MissionQuestion, MissionRecord, MissionResult, MissionReview, MissionTask, MissionWorkspace
} from '../../shared/mission';

export type MissionActor =
  | { kind: 'host' }
  | { kind: 'user'; actionId: string }
  | { kind: 'lead'; sessionId: string; generation: number }
  | { kind: 'worker'; sessionId: string; generation: number; attemptId: string };

/** Models submit contracts, not runtime task statuses or current-attempt pointers. */
export type MissionTaskContract = Omit<MissionTask, 'status' | 'currentAttemptId' | 'reason' | 'diagnosis'>;
export type MissionDecisionRequest = Omit<MissionDecision, 'requestedBy' | 'resolution' | 'rationale'>;
export type MissionPlanChange = {
  source: { kind: 'user'; actionId: string } | { kind: 'user_instruction' } | { kind: 'assumption'; assumptionId: string };
  affectedTaskIds: string[];
};

export type MissionMutation =
  | { kind: 'plan.update'; expectedPlanRevision: number; plan: MissionPlan; tasks?: MissionTaskContract[]; checks?: MissionCheck[]; material?: MissionPlanChange }
  | { kind: 'question.ask'; question: Pick<MissionQuestion, 'id' | 'text' | 'purpose'> }
  | { kind: 'question.answer'; questionId: string; answer: string }
  | { kind: 'execution.propose'; proposal: MissionProposal }
  | { kind: 'execution.authorize'; proposalId: string; specificationRevision: number; at: number }
  | { kind: 'profile.upsert'; profile: MissionProfile }
  | { kind: 'decision.request'; decision: MissionDecisionRequest }
  | { kind: 'decision.resolve'; decisionId: string; resolution: string; rationale: string; evidenceIds: string[]; affectedTaskIds: string[] }
  | { kind: 'result.report'; result: MissionResult }
  | { kind: 'review.submit'; review: MissionReview }
  | { kind: 'finding.resolve'; reviewId: string; findingId: string; resolution: NonNullable<MissionReview['findings'][number]['resolution']> }
  | { kind: 'task.accept'; taskId: string; attemptId: string }
  | { kind: 'task.diagnose'; taskId: string; afterAttempt: string; approach: string }
  | { kind: 'task.cancel'; taskId: string; reason: string }
  | { kind: 'phase.set'; phase: Exclude<MissionPhase, 'done'> }
  | { kind: 'control.pause' | 'control.stop' | 'control.continue_planning' }
  | { kind: 'control.resume'; quiescent: boolean }
  | { kind: 'control.steer'; text: string; at: number }
  | { kind: 'control.replace_lead'; sessionId: string; preset: ExecutionPreset; quiescent: boolean }
  | { kind: 'control.apply_configuration'; config: MissionConfig }
  | MissionHostMutation;

/** Operational facts cannot be submitted on the model tool transport. The service must observe
 * actual terminal events, quiescence, artifacts and process/remote outcomes before using these. */
export type MissionHostMutation =
  | { kind: 'host.start' }
  | { kind: 'host.baseline.set'; revision: MissionCodeRevision }
  | { kind: 'host.workspace.register'; workspace: MissionWorkspace }
  | { kind: 'host.attempt.create'; attempt: MissionAttempt }
  | { kind: 'host.attempt.transition'; attemptId: string; expectedStatus: MissionAttempt['status']; status: MissionAttempt['status']; at: number; outcome?: MissionAttempt['outcome']; terminalTurnId?: string; failure?: MissionAttempt['failure'] }
  | { kind: 'host.attempt.repair'; attemptId: string }
  | { kind: 'host.candidate.capture'; candidate: MissionCandidate }
  | { kind: 'host.evidence.capture'; evidence: MissionEvidence }
  | { kind: 'host.review.capture'; review: MissionReview }
  | { kind: 'host.integration.promote'; candidateId: string; expectedAcceptedRevision: MissionCodeRevision; revision: MissionCodeRevision }
  | { kind: 'host.target.promote'; operationId: string; observationId: string; targetHead: string; expectedAcceptedRevision: MissionCodeRevision; revision: MissionCodeRevision }
  | { kind: 'host.operation.record'; operation: MissionOperation }
  | { kind: 'host.operation.transition'; operationId: string; expectedState: MissionOperation['state']; state: MissionOperation['state']; resultRef?: string; error?: string }
  | { kind: 'host.delivery.record'; delivery: MissionDelivery }
  | { kind: 'host.blocker.add'; blocker: Omit<MissionRecord['blockers'][number], 'resolvedAt'> }
  | { kind: 'host.blocker.resolve'; blockerId: string; at: number }
  | { kind: 'host.mailbox.append'; item: MissionMailboxItem }
  | { kind: 'host.recover' }
  | { kind: 'host.quiesce'; quiescent: boolean }
  | { kind: 'host.complete'; quiescent: boolean };

export class MissionStateError extends Error {
  constructor(message: string) { super(message); this.name = 'MissionStateError'; }
}
function requireState(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MissionStateError(message);
}

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const text = z.string().min(1).max(100_000).refine((v) => !!v.trim() && !v.includes('\0'), 'Expected nonempty text without NUL.');
const rev = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const time = counter;
const artifactIds = z.array(id).max(10_000); // Identical stdout/stderr blobs may share a content-addressed ID.
const ids = z.array(id).max(10_000).refine((v) => new Set(v).size === v.length, 'Duplicate references.');
const texts = z.array(text).max(10_000);
const tier = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
const list = <T extends z.ZodType>(schema: T) => z.array(schema).max(50_000);
const failureKind = z.enum(['requirements', 'implementation', 'protocol', 'environment', 'provider', 'rate_limit', 'permission', 'stale_state', 'integration', 'verification', 'persistence', 'unknown']);
const phase = z.enum(['planning', 'executing', 'verifying', 'delivering', 'done']);
const status = z.enum(['created', 'running', 'waiting_for_user', 'awaiting_execution_approval', 'pausing', 'paused', 'recovering', 'blocked', 'stopping', 'stopped', 'completed', 'failed']);
const attemptStatus = z.enum(['created', 'starting', 'running', 'settling', 'terminal']);
const outcome = z.enum(['submitted', 'partial', 'failed', 'interrupted', 'canceled']);
const operationState = z.enum(['intent_recorded', 'in_flight', 'reconciling', 'succeeded', 'failed']);
const failure = z.strictObject({ kind: failureKind, message: text, code: id.optional(),
  source: z.enum(['turn', 'dispatch', 'error', 'status', 'backoff', 'tool', 'approval', 'preset']).optional(),
  confidence: z.enum(['observed', 'heuristic', 'unknown']).optional(), eventId: id.optional(),
  recovery: z.enum(['lead_diagnosis', 'same_preset_after_backoff', 'user_action']).optional() });
const codeRevision = z.strictObject({ baseCommitSha: text, contentHash: text, artifactId: id.optional() });
const evidenceKind = z.enum(['test', 'build', 'review', 'behavior', 'delivery']);
const criterion = z.strictObject({ id, description: text, required: z.boolean(), evidenceKinds: z.array(evidenceKind).min(1).max(5).refine((v) => new Set(v).size === v.length) });
const assumption = z.strictObject({ id, description: text, rationale: text, source: text, affectedTaskIds: ids, criterionIds: ids, status: z.enum(['assumed', 'confirmed', 'superseded', 'rejected']) });
const planSchema = z.strictObject({ objective: text, scope: text, exclusions: texts, behavior: text, integrationPoints: texts, verificationApproach: text, criteria: list(criterion), assumptions: list(assumption) });
const profileSchema = z.strictObject({ id, revision: rev, name: text, purpose: text, instructions: text, tierId: tier, contextRefs: ids, requestedTools: texts, sourceAccess: z.enum(['read_only', 'assigned_workspace']), resultExpectations: text });
const taskContractSchema = z.strictObject({
  id, revision: rev, specificationRevision: rev, objective: text, scope: text, ownedPaths: texts, exclusions: texts,
  dependsOn: list(z.strictObject({ taskId: id, condition: z.enum(['accepted_artifact', 'integrated_code']) })),
  decisionRefs: ids, sharedContracts: texts, requiredTools: texts, criteria: list(criterion), verificationIds: ids,
  assignment: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('lead') }), z.strictObject({ kind: z.literal('worker'), profileId: id, profileRevision: rev })]), required: z.boolean()
});
const taskSchema = taskContractSchema.extend({
  status: z.enum(['planned', 'ready', 'running', 'candidate_ready', 'changes_requested', 'accepted', 'integrated', 'blocked', 'failed', 'canceled', 'superseded']),
  currentAttemptId: id.optional(), reason: text.optional(), diagnosis: z.strictObject({ afterAttempt: id, approach: text }).optional()
});
function validated<T>(validate: (value: unknown) => T) {
  return z.unknown().transform((value, ctx) => {
    try { return validate(value); }
    catch { ctx.addIssue({ code: 'custom', message: 'Invalid Mission configuration or preset.' }); return z.NEVER; }
  });
}
const configSchema = validated(validateMissionConfig);
const presetSchema = validated((value: unknown): ExecutionPreset => validateMissionConfig({ ...createDefaultMissionConfig(), presets: [value] }).presets[0]);
const resultSchema = z.strictObject({
  taskId: id, taskRevision: rev, attemptId: id, specificationRevision: rev, status: z.enum(['candidate', 'blocked', 'partial', 'failed']), summary: text,
  artifactIds, evidenceIds: ids, decisionIds: ids, unresolved: list(z.strictObject({ description: text, blocking: z.boolean() }))
});
const attemptSchema = z.strictObject({
  id, taskId: id, taskRevision: rev, specificationRevision: rev, generation: rev, sessionId: id, profile: profileSchema.optional(), tierId: tier, preset: presetSchema,
  selectionReason: text, sourceRevision: codeRevision, workspaceId: id, continuationOwner: z.literal('mission'), status: attemptStatus,
  outcome: outcome.optional(), terminalTurnId: id.optional(), result: resultSchema.optional(), repairTurns: counter.max(1), requestedAt: time, endedAt: time.optional(), failure: failure.optional(),
  effectiveModel: z.strictObject({ provider: id, model: text }).optional(), effectiveEffort: text.optional()
});
const candidateSchema = z.strictObject({
  id, attemptId: id, taskId: id, taskRevision: rev, specificationRevision: rev, sourceRevision: codeRevision, revision: codeRevision,
  changedPaths: texts, capturedAt: time, integratedRevision: codeRevision.optional()
});
const checkSchema = z.strictObject({
  id, name: text, kind: z.enum(['test', 'build', 'behavior']), command: text, criterionIds: ids, required: z.boolean(), heavy: z.boolean(),
  testReport: z.strictObject({ format: z.enum(['vitest-json', 'node-tap']), path: text.optional(), minimumTests: rev, maximumSkipped: counter }).optional(), timeoutMs: rev
});
const evidenceSchema = z.strictObject({
  id, criterionIds: ids, specificationRevision: rev, taskId: id.optional(), taskRevision: rev.optional(), attemptId: id.optional(), sourceRevision: codeRevision,
  checkId: id, kind: evidenceKind, commandOrFlow: text, cwd: text, environmentRef: text, provenance: z.enum(['host_executed', 'verified_runtime', 'agent_claim']),
  result: z.enum(['not_run', 'passed', 'failed', 'skipped', 'blocked', 'not_applicable', 'waived']), exitCode: z.number().int().optional(), executedTests: counter.optional(), skippedTests: counter.optional(),
  outcomeHash: id.optional(), failure: failure.optional(),
  artifactIds, startedAt: time, endedAt: time.optional(), invalidatedBy: text.optional(), exception: z.strictObject({ sourceUserActionId: id, reason: text }).optional()
});
const findingResolution = z.strictObject({ kind: z.enum(['fixed', 'rejected']), reason: text, evidenceIds: ids.min(1) });
const reviewSchema = z.strictObject({
  id, candidateId: id, reviewerAttemptId: id, sourceRevision: codeRevision, criterionIds: ids,
  findings: list(z.strictObject({ id, severity: z.enum(['critical', 'major', 'minor', 'info']), description: text, evidenceIds: ids, criterionIds: ids, reproduction: text, resolution: findingResolution.optional() })), submittedAt: time
});
const endpoint = z.enum(['local_commit', 'open_pr', 'merge_pr', 'custom']);
const policySchema = z.strictObject({ endpoint, targetBranch: text.optional(), targetHead: text.optional(), remote: text.optional(), mergeMethod: z.enum(['merge', 'squash', 'rebase']).optional(), checks: list(checkSchema), requireIndependentReview: z.boolean(), allowPush: z.boolean(), allowMerge: z.boolean(), holdConditions: texts, holdIsEndpoint: z.boolean(), provenance: list(z.strictObject({ source: text, text })), fallback: z.boolean(), conflicts: texts });
const deliverySchema = z.strictObject({ operationId: id, revision: codeRevision, endpoint, status: z.enum(['pending', 'blocked', 'delivered', 'held']), expectedTargetHead: text.optional(), commitSha: text.optional(), pullRequestUrl: z.url().optional(), mergedCommitSha: text.optional(), reason: text.optional(), completedAt: time.optional() });
const operationSchema = z.strictObject({ id, idempotencyKey: id, kind: z.enum(['dispatch', 'interrupt', 'capture', 'verify', 'integrate', 'deliver', 'cleanup']), expectedRevision: counter, actor: text, state: operationState, payload: z.record(z.string(), z.unknown()), resultRef: id.optional(), error: text.optional() });
const cleanupPayloadSchema = z.strictObject({
  request: z.strictObject({ missionId: id, idempotencyKey: id, expectedRevision: counter, control: z.strictObject({ action: z.literal('cleanup') }) }), workspaceIds: ids,
  receipts: list(z.discriminatedUnion('removed', [z.strictObject({ workspaceId: id, removed: z.literal(true) }), z.strictObject({ workspaceId: id, removed: z.literal(false), reason: z.enum(['busy', 'uncaptured', 'not_owned', 'git_refused']), message: text })]))
});
const workspaceSchema = z.strictObject({ id, role: z.enum(['lead', 'worker', 'integration', 'verification']), path: text, branch: text, base: codeRevision, ownerSessionId: id.optional(), capturedRevision: codeRevision.optional(), cleanedAt: time.optional() });
const decisionRequestSchema = z.strictObject({ id, question: text, evidenceIds: ids, proposedResolution: text.optional(), affectedTaskIds: ids });
const decisionSchema = decisionRequestSchema.extend({ resolution: text.optional(), rationale: text.optional(), requestedBy: id });
const completionReportSchema = z.strictObject({
  schemaVersion: z.literal(1), objective: text, specificationRevision: rev, planRevision: counter, acceptedRevision: codeRevision, completedAt: time, delivery: deliverySchema,
  deliveryPolicy: policySchema.pick({ holdConditions: true, holdIsEndpoint: true, fallback: true }),
  tasks: z.strictObject({ required: counter, satisfiedRequired: counter, total: counter, satisfied: counter, canceled: counter, superseded: counter }),
  checks: list(z.strictObject({ check: checkSchema, evidence: evidenceSchema.optional(), verified: z.boolean() })),
  review: z.strictObject({ required: z.boolean(), integratedCandidates: counter, independentlyReviewedCandidates: counter, reviews: list(reviewSchema) }),
  exclusions: texts, assumptions: list(assumption), decisions: list(decisionSchema),
  limitations: list(z.strictObject({ taskId: id, description: text })), narrative: z.strictObject({ sessionId: id, text }).optional()
}) satisfies z.ZodType<MissionCompletionReport>;
const questionSchema = z.strictObject({ id, text, purpose: z.enum(['clarification', 'authorization', 'blocker']).optional(), answer: text.optional(), sourceUserActionId: id.optional() });
const proposalSchema = z.strictObject({ id, specificationRevision: rev, planRevision: counter, assistantMessageId: id, requestedAt: time });
const blockerSchema = z.strictObject({ id, kind: failureKind, message: text, resolvedAt: time.optional() });
const mailboxSchema = z.strictObject({ id, kind: z.enum(['user', 'permission', 'decision', 'verification', 'candidate', 'progress']), sessionId: id, taskId: id.optional(), text, artifactIds,
  attachments: list(z.strictObject({ ref: id, mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']), name: text.optional() })).optional(),
  userAction: z.strictObject({ kind: z.enum(['instruction', 'answer', 'authorization', 'question']), receivedRevision: counter, specificationRevision: rev, planRevision: counter, requestFingerprint: id, questionId: id.optional(),
    materialBinding: z.strictObject({ revision: counter, operationId: id, sessionId: id, generation: rev }).optional(), appliedPlanRevision: rev.optional() }).optional(),
  createdAt: time, deliveredAt: time.optional() });
const recordSchema: z.ZodType<MissionRecord> = z.strictObject({
  schemaVersion: z.literal(1), id, revision: counter, lastEventSequence: counter, title: text, objective: text, projectRoot: text, sourceCwd: text,
  originSessionId: id.optional(), sourceSnapshotId: id.optional(), sourceCutoffId: id.optional(), sourceUserActionId: id,
  leadSessionId: id, leadGeneration: rev, leadPreset: presetSchema, config: configSchema,
  providerRestrictions: z.strictObject({ allowedProviderIds: ids.optional(), allowedConnectionIds: ids.optional() }),
  configHistory: list(configSchema), entryMode: z.enum(['interactive_plan', 'autonomous']), phase, status,
  requestedPermissionMode: z.enum(['ask', 'accept-edits', 'plan', 'auto', 'full-auto']), specificationRevision: rev, planRevision: counter,
  executionAuthorization: z.strictObject({ kind: z.enum(['autonomous_launch', 'approved_plan']), sourceUserActionId: id, specificationRevision: rev, recordedAt: time }).optional(), pendingProposal: proposalSchema.optional(),
  questions: list(questionSchema), plan: planSchema, decisions: list(decisionSchema), profiles: list(profileSchema), tasks: list(taskSchema), attempts: list(attemptSchema), candidates: list(candidateSchema), evidence: list(evidenceSchema), reviews: list(reviewSchema), operations: list(operationSchema), mailbox: list(mailboxSchema), workspaces: list(workspaceSchema),
  baseline: codeRevision.optional(), acceptedRevision: codeRevision.optional(), deliveryPolicy: policySchema, delivery: deliverySchema.optional(), completionReport: completionReportSchema.optional(), blockers: list(blockerSchema),
  publicationRestrictions: list(z.strictObject({ endpoint: z.enum(['local_commit', 'open_pr']), previousEndpoint: z.enum(['open_pr', 'merge_pr']), sourceUserActionId: id, receivedRevision: counter, recordedAt: time, priorRemoteOperationIds: ids })).optional(),
  progress: z.strictObject({ completedTurns: counter, checkpointsWithoutProgress: counter, lastProgressRevision: counter }), createdAt: time, updatedAt: time, archived: z.boolean().optional()
});
const actorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('host') }), z.strictObject({ kind: z.literal('user'), actionId: id }),
  z.strictObject({ kind: z.literal('lead'), sessionId: id, generation: rev }), z.strictObject({ kind: z.literal('worker'), sessionId: id, generation: rev, attemptId: id })
]);
const mutationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('plan.update'), expectedPlanRevision: counter, plan: planSchema, tasks: list(taskContractSchema).optional(), checks: list(checkSchema).optional(), material: z.strictObject({ source: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('user'), actionId: id }).describe('Host-only actual user actor. Model callers must use user_instruction without an action ID.'), z.strictObject({ kind: z.literal('user_instruction') }).describe('Interpret the fresh user instruction delivered in this lead turn. The host binds the action; never supply an action ID. This grants no execution, permission or configuration authority.'), z.strictObject({ kind: z.literal('assumption'), assumptionId: id })]), affectedTaskIds: ids }).optional() }),
  z.strictObject({ kind: z.literal('question.ask'), question: questionSchema.omit({ answer: true, sourceUserActionId: true }) }),
  z.strictObject({ kind: z.literal('question.answer'), questionId: id, answer: text }),
  z.strictObject({ kind: z.literal('execution.propose'), proposal: proposalSchema }),
  z.strictObject({ kind: z.literal('execution.authorize'), proposalId: id, specificationRevision: rev, at: time }),
  z.strictObject({ kind: z.literal('profile.upsert'), profile: profileSchema }),
  z.strictObject({ kind: z.literal('decision.request'), decision: decisionRequestSchema }),
  z.strictObject({ kind: z.literal('decision.resolve'), decisionId: id, resolution: text, rationale: text, evidenceIds: ids, affectedTaskIds: ids }),
  z.strictObject({ kind: z.literal('result.report'), result: resultSchema }), z.strictObject({ kind: z.literal('review.submit'), review: reviewSchema }),
  z.strictObject({ kind: z.literal('finding.resolve'), reviewId: id, findingId: id, resolution: findingResolution }),
  z.strictObject({ kind: z.literal('task.accept'), taskId: id, attemptId: id }), z.strictObject({ kind: z.literal('task.diagnose'), taskId: id, afterAttempt: id, approach: text }),
  z.strictObject({ kind: z.literal('task.cancel'), taskId: id, reason: text }), z.strictObject({ kind: z.literal('phase.set'), phase: z.enum(['planning', 'executing', 'verifying', 'delivering']) }),
  z.strictObject({ kind: z.literal('control.pause') }), z.strictObject({ kind: z.literal('control.stop') }), z.strictObject({ kind: z.literal('control.continue_planning') }),
  z.strictObject({ kind: z.literal('control.resume'), quiescent: z.boolean() }), z.strictObject({ kind: z.literal('control.steer'), text, at: time }),
  z.strictObject({ kind: z.literal('control.replace_lead'), sessionId: id, preset: presetSchema, quiescent: z.boolean() }), z.strictObject({ kind: z.literal('control.apply_configuration'), config: configSchema }),
  z.strictObject({ kind: z.literal('host.start') }), z.strictObject({ kind: z.literal('host.baseline.set'), revision: codeRevision }),
  z.strictObject({ kind: z.literal('host.workspace.register'), workspace: workspaceSchema }), z.strictObject({ kind: z.literal('host.attempt.create'), attempt: attemptSchema }),
  z.strictObject({ kind: z.literal('host.attempt.transition'), attemptId: id, expectedStatus: attemptStatus, status: attemptStatus, at: time, outcome: outcome.optional(), terminalTurnId: id.optional(), failure: failure.optional() }),
  z.strictObject({ kind: z.literal('host.attempt.repair'), attemptId: id }), z.strictObject({ kind: z.literal('host.candidate.capture'), candidate: candidateSchema }),
  z.strictObject({ kind: z.literal('host.evidence.capture'), evidence: evidenceSchema }), z.strictObject({ kind: z.literal('host.review.capture'), review: reviewSchema }),
  z.strictObject({ kind: z.literal('host.integration.promote'), candidateId: id, expectedAcceptedRevision: codeRevision, revision: codeRevision }),
  z.strictObject({ kind: z.literal('host.target.promote'), operationId: id, observationId: id, targetHead: id, expectedAcceptedRevision: codeRevision, revision: codeRevision }),
  z.strictObject({ kind: z.literal('host.operation.record'), operation: operationSchema }),
  z.strictObject({ kind: z.literal('host.operation.transition'), operationId: id, expectedState: operationState, state: operationState, resultRef: id.optional(), error: text.optional() }),
  z.strictObject({ kind: z.literal('host.delivery.record'), delivery: deliverySchema }), z.strictObject({ kind: z.literal('host.blocker.add'), blocker: blockerSchema.omit({ resolvedAt: true }) }),
  z.strictObject({ kind: z.literal('host.blocker.resolve'), blockerId: id, at: time }), z.strictObject({ kind: z.literal('host.mailbox.append'), item: mailboxSchema }),
  z.strictObject({ kind: z.literal('host.recover') }), z.strictObject({ kind: z.literal('host.quiesce'), quiescent: z.boolean() }), z.strictObject({ kind: z.literal('host.complete'), quiescent: z.boolean() })
]) satisfies z.ZodType<MissionMutation>;

/** Model tool documentation comes from the actual host validator; the transport assigns kind. */
export function missionMutationPayloadSchema(kind: MissionMutation['kind']): Record<string, unknown> {
  const variant = mutationSchema.options.find((schema) => schema.shape.kind.value === kind);
  requireState(variant, 'Unknown Mission mutation kind.');
  const schema = z.toJSONSchema(variant, { unrepresentable: 'any' });
  delete schema.properties?.kind;
  if (schema.required) schema.required = schema.required.filter((field) => field !== 'kind');
  if (kind === 'execution.propose') {
    const proposal = schema.properties?.proposal;
    if (proposal && typeof proposal === 'object' && proposal.required) proposal.required = proposal.required.filter((field) => !['assistantMessageId', 'requestedAt'].includes(field));
  }
  return schema;
}

/** Reject accessors/prototypes/cycles before validation or cloning. Unknown operation payloads
 * are inert JSON data, not an escape hatch for executable objects or non-finite numbers. */
function assertData(value: unknown, ancestors = new Set<object>(), depth = 0, budget = { left: 1_000_000 }): void {
  requireState(--budget.left >= 0 && depth < 100, 'Mission payload exceeds validation bounds.');
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { requireState(Number.isFinite(value), 'Non-finite Mission value.'); return; }
  requireState(typeof value === 'object', 'Mission payload must be plain data.');
  requireState(!ancestors.has(value), 'Cyclic Mission payload.');
  requireState(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'Mission payload must be plain data.');
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    requireState(typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key), 'Unsafe Mission field.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    requireState('value' in descriptor, 'Mission accessors are not supported.');
    assertData(descriptor.value, ancestors, depth + 1, budget);
  }
  ancestors.delete(value);
}
function assertSchema<T>(schema: z.ZodType<T>, value: unknown): asserts value is T {
  assertData(value);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MissionStateError(`Invalid Mission payload at ${parsed.error.issues[0]?.path.join('.') || 'root'}: ${parsed.error.issues[0]?.message}`);
}
export function assertMissionMutation(value: unknown): asserts value is MissionMutation { assertSchema(mutationSchema, value); }
export function assertMissionResult(value: unknown): asserts value is MissionResult { assertSchema(resultSchema, value); }
export function assertMissionPlan(value: unknown): asserts value is MissionPlan { assertSchema(planSchema, value); }

function unique<T>(values: T[], key: (v: T) => string, label: string): void {
  requireState(new Set(values.map(key)).size === values.length, `Duplicate ${label}.`);
}
function lookup<T extends { id: string }>(values: T[], key: string, label: string): T {
  const item = values.find((v) => v.id === key);
  requireState(item, `Unknown ${label} reference.`);
  return item;
}
function refs<T extends { id: string }>(values: T[], keys: string[], label: string): void { for (const key of keys) lookup(values, key, label); }
function sameContent(a: MissionCodeRevision | undefined, b: MissionCodeRevision | undefined): boolean { return !!a && !!b && a.contentHash === b.contentHash; }
function sameRevision(a: MissionCodeRevision | undefined, b: MissionCodeRevision | undefined): boolean { return sameContent(a, b) && a?.baseCommitSha === b?.baseCommitSha; }
const active = (attempt: MissionAttempt) => attempt.status !== 'terminal';
const pending = (operation: MissionOperation) => operation.state !== 'succeeded' && operation.state !== 'failed';
const satisfied = (task: MissionTask) => task.status === 'accepted' || task.status === 'integrated';
const currentResult = (task: MissionTask, attempt: MissionAttempt) => task.currentAttemptId === attempt.id && task.revision === attempt.taskRevision && task.specificationRevision === attempt.specificationRevision && !['superseded', 'canceled'].includes(task.status);
const writable = (task: MissionTask, record: MissionRecord) => task.assignment.kind === 'lead' || record.profiles.find((p) => task.assignment.kind === 'worker' && p.id === task.assignment.profileId && p.revision === task.assignment.profileRevision)?.sourceAccess !== 'read_only';
function member(config: MissionConfig, preset: ExecutionPreset, tierId: number): boolean {
  return preset.enabled && !!config.tiers.find((t) => t.id === tierId)?.presetIds.includes(preset.id) && config.presets.some((p) => isDeepStrictEqual(p, preset));
}
function assertDag(tasks: MissionTask[]): void {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const degrees = new Map(tasks.map((t) => [t.id, t.dependsOn.length]));
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    unique(task.dependsOn, (d) => d.taskId, 'task dependency');
    for (const edge of task.dependsOn) {
      requireState(edge.taskId !== task.id && byId.has(edge.taskId), 'Missing or self-referencing task dependency.');
      const dependents = children.get(edge.taskId) ?? []; dependents.push(task.id); children.set(edge.taskId, dependents);
    }
  }
  const queue = tasks.filter((t) => !t.dependsOn.length).map((t) => t.id);
  for (let cursor = 0; cursor < queue.length; cursor++) for (const child of children.get(queue[cursor]) ?? []) {
    const n = degrees.get(child)! - 1; degrees.set(child, n); if (!n) queue.push(child);
  }
  requireState(queue.length === tasks.length, 'Task dependency cycle.');
}

/** Full storage-boundary validation, including cross-record ownership and revision invariants. */
export function assertMissionRecord(value: unknown): asserts value is MissionRecord {
  assertSchema(recordSchema, value);
  const r = value;
  for (const [label, entries] of Object.entries({ tasks: r.tasks, attempts: r.attempts, candidates: r.candidates, evidence: r.evidence, reviews: r.reviews, decisions: r.decisions, questions: r.questions, workspaces: r.workspaces, operations: r.operations, mailbox: r.mailbox, blockers: r.blockers })) unique<{ id: string }>(entries, (v) => v.id, label);
  unique(r.profiles, (p) => `${p.id}:${p.revision}`, 'profile revision');
  unique(r.operations, (p) => p.idempotencyKey, 'operation idempotency key');
  unique(r.deliveryPolicy.checks, (c) => c.id, 'check');
  const restrictions = r.publicationRestrictions ?? [];
  unique(restrictions, (restriction) => restriction.sourceUserActionId, 'publication restriction');
  for (const [index, restriction] of restrictions.entries()) {
    requireState(restriction.receivedRevision <= r.revision && restriction.recordedAt >= r.createdAt, 'Publication restriction has a future revision or invalid timestamp.');
    requireState(restriction.endpoint === 'local_commit' || restriction.previousEndpoint === 'merge_pr', 'Publication controls can only reduce an existing endpoint.');
    requireState(!index || restrictions[index - 1].endpoint === restriction.previousEndpoint && restrictions[index - 1].receivedRevision < restriction.receivedRevision, 'Publication restrictions cannot be lifted or rewritten.');
    refs(r.operations, restriction.priorRemoteOperationIds, 'prior remote operation');
    requireState(r.deliveryPolicy.provenance.some((entry) => entry.source === `user:${restriction.sourceUserActionId}`), 'Publication restriction requires genuine user audit provenance.');
  }
  if (restrictions.length) {
    requireState(r.deliveryPolicy.endpoint === 'local_commit' || r.deliveryPolicy.endpoint === 'open_pr' && restrictions.at(-1)!.endpoint === 'open_pr', 'Delivery exceeds the retained user publication ceiling.');
    requireState(!r.deliveryPolicy.allowMerge && (r.deliveryPolicy.endpoint !== 'local_commit' || !r.deliveryPolicy.allowPush), 'Publication grants exceed the retained user restriction.');
  }
  unique(r.plan.criteria, (c) => c.id, 'plan criterion'); unique(r.plan.assumptions, (a) => a.id, 'assumption');
  requireState(r.updatedAt >= r.createdAt, 'Mission timestamps go backwards.');
  requireState(r.progress.lastProgressRevision <= r.revision, 'Future progress revision.');
  requireState([r.config, ...r.configHistory].some((c) => member(c, r.leadPreset, 5)), 'Lead must retain an approved T5 preset snapshot.');
  unique([...r.configHistory, r.config], (c) => String(c.revision), 'configuration revision');
  const presets = new Map<string, ExecutionPreset>();
  for (const config of [...r.configHistory, r.config]) {
    requireState(config.revision <= r.config.revision, 'Future historical configuration.');
    for (const preset of config.presets) {
      const key = `${preset.id}:${preset.revision}`;
      requireState(!presets.has(key) || isDeepStrictEqual(presets.get(key), preset), 'Preset revisions are immutable across configuration snapshots.'); presets.set(key, preset);
    }
  }
  const pendingQuestions = r.questions.filter((q) => q.answer === undefined);
  requireState(pendingQuestions.length <= 1, 'Only one pending question is allowed.');
  for (const q of r.questions) requireState((q.answer === undefined) === (q.sourceUserActionId === undefined), 'Answers require a user action.');
  requireState(!(r.pendingProposal && pendingQuestions.length), 'A question and execution proposal cannot both be pending.');
  if (r.pendingProposal) requireState(r.phase === 'planning' && r.pendingProposal.specificationRevision === r.specificationRevision && r.pendingProposal.planRevision === r.planRevision && !r.executionAuthorization, 'Stale or already authorized execution proposal.');
  if (pendingQuestions.some((q) => !q.purpose || q.purpose === 'clarification')) requireState(r.phase === 'planning' && !r.executionAuthorization, 'Pending clarification requires unapproved interactive planning.');
  if (r.status === 'waiting_for_user') requireState(pendingQuestions.length === 1, 'Waiting state requires one pending question.');
  if (r.status === 'awaiting_execution_approval') requireState(r.phase === 'planning' && !!r.pendingProposal, 'Approval state requires a proposal.');
  if (r.executionAuthorization) {
    requireState(r.executionAuthorization.specificationRevision === r.specificationRevision, 'Stale execution authorization.');
    if (r.executionAuthorization.kind === 'autonomous_launch') requireState(r.entryMode === 'autonomous' && r.executionAuthorization.sourceUserActionId === r.sourceUserActionId, 'Autonomous authorization must bind the launch user action.');
  }
  if (r.phase !== 'planning') requireState(!!r.executionAuthorization && !!r.baseline, 'Execution requires authorization and a baseline.');
  requireState((r.status === 'completed') === (r.phase === 'done'), 'Completed and done must transition together.');
  if (r.status === 'created') requireState(r.phase === 'planning', 'Created Mission must be planning.');
  const answers = r.operations.filter(isMissionQuestionOperation);
  requireState(answers.filter(pending).length <= 1, 'Only one completed-conversation answer may be pending.');
  unique(answers, (op) => String(op.payload.questionId), 'answered question');
  for (const op of answers) {
    const question = r.mailbox.find((item) => item.id === op.payload.questionId);
    requireState(r.status === 'completed' && op.actor === 'host' && op.payload.sessionId === r.leadSessionId && op.payload.generation === r.leadGeneration
      && op.payload.lead === true && !op.payload.attemptId && !op.payload.taskId && !op.payload.infrastructure && !op.payload.claim
      && question?.kind === 'user' && question.sessionId === r.leadSessionId && question.userAction?.kind === 'question'
      && question.userAction.specificationRevision === r.specificationRevision && question.userAction.planRevision === r.planRevision
      && !question.userAction.materialBinding && !question.userAction.appliedPlanRevision, 'Answer dispatch requires a genuine completed-conversation question, never execution authority.');
  }
  if (['paused', 'stopped', 'completed'].includes(r.status)) requireState(!r.attempts.some(active) && !r.operations.some((o) => pending(o) && o.kind !== 'cleanup' && !(r.status === 'completed' && isMissionQuestionOperation(o))), 'Quiescent status still owns active attempts or operations.');
  const cleanups = r.operations.filter((o) => o.kind === 'cleanup');
  requireState(cleanups.filter(pending).length <= 1, 'Only one cleanup may be pending.');
  for (const op of cleanups) {
    assertSchema(cleanupPayloadSchema, op.payload);
    const payload = op.payload;
    requireState(op.actor.startsWith('user:') && id.safeParse(op.actor.slice(5)).success && payload.request.missionId === r.id && payload.request.expectedRevision === op.expectedRevision, 'Cleanup requires its explicit user request and Mission ownership.');
    refs(r.workspaces, payload.workspaceIds, 'cleanup workspace'); unique(payload.receipts, (receipt) => receipt.workspaceId, 'cleanup receipt');
    requireState(!pending(op) || ['paused', 'stopped', 'completed', 'recovering', 'stopping'].includes(r.status) && !r.attempts.some(active), 'Cleanup requires quiescent retained ownership.');
    requireState(op.state !== 'intent_recorded' || !payload.receipts.length, 'Cleanup intent cannot contain removal receipts.');
    for (const receipt of payload.receipts) {
      requireState(payload.workspaceIds.includes(receipt.workspaceId), 'Cleanup receipt exceeds its owned workspace request.');
      if (receipt.removed) requireState(lookup(r.workspaces, receipt.workspaceId, 'cleanup workspace').cleanedAt !== undefined, 'Removal receipt requires its cleaned workspace marker.');
    }
    if (op.state === 'succeeded') requireState(payload.workspaceIds.every((workspaceId) => payload.receipts.some((receipt) => receipt.workspaceId === workspaceId && receipt.removed)), 'Successful cleanup requires every removal receipt.');
  }
  for (const workspace of r.workspaces.filter((w) => w.cleanedAt !== undefined)) requireState(cleanups.some((op) => (op.payload.receipts as Array<{ workspaceId: string; removed: boolean }>).some((receipt) => receipt.workspaceId === workspace.id && receipt.removed)), 'Cleaned workspace requires a retained host removal receipt.');
  assertDag(r.tasks);
  const allCriteria = [...r.plan.criteria, ...r.tasks.filter((t) => !['superseded', 'canceled'].includes(t.status)).flatMap((t) => t.criteria)];
  const criterionById = new Map<string, MissionTask['criteria'][number]>();
  for (const c of allCriteria) {
    requireState(!criterionById.has(c.id) || isDeepStrictEqual(criterionById.get(c.id), c), 'Conflicting criterion identity.'); criterionById.set(c.id, c);
  }
  for (const a of r.plan.assumptions) { refs(r.tasks, a.affectedTaskIds, 'assumption task'); if (a.status === 'assumed' || a.status === 'confirmed') refs(allCriteria, a.criterionIds, 'criterion'); }
  for (const c of r.deliveryPolicy.checks) { refs(allCriteria, c.criterionIds, 'check criterion'); requireState(c.kind === 'test' || !c.testReport, 'Only test checks have test-count requirements.'); }
  for (const task of r.tasks) {
    requireState(task.specificationRevision <= r.specificationRevision, 'Future task specification.');
    unique(task.criteria, (c) => c.id, 'task criterion'); refs(r.decisions, task.decisionRefs, 'decision'); refs(r.deliveryPolicy.checks, task.verificationIds, 'task check');
    if (!['superseded', 'canceled', 'failed', 'blocked'].includes(task.status)) requireState(task.dependsOn.every((edge) => !['canceled', 'superseded'].includes(lookup(r.tasks, edge.taskId, 'dependency').status)), 'Task has an impossible canceled/superseded dependency.');
    if (task.assignment.kind === 'worker') requireState(r.profiles.some((p) => task.assignment.kind === 'worker' && p.id === task.assignment.profileId && p.revision === task.assignment.profileRevision), 'Missing task profile revision.');
    if (task.currentAttemptId) requireState(lookup(r.attempts, task.currentAttemptId, 'current attempt').taskId === task.id, 'Task references another task\'s attempt.');
    const live = r.attempts.filter((a) => a.taskId === task.id && active(a));
    requireState(live.length <= 1 && (!live.length || task.currentAttemptId === live[0].id), 'Only one current active attempt per task.');
    if (['running', 'candidate_ready', 'accepted', 'integrated'].includes(task.status)) {
      const attempt = lookup(r.attempts, task.currentAttemptId ?? '', 'current attempt');
      requireState(currentResult(task, attempt), 'Task status references an obsolete attempt.');
      if (task.status === 'running') requireState(active(attempt), 'Running task has no live attempt.');
      else requireState(attempt.status === 'terminal' && attempt.outcome === 'submitted' && !!attempt.terminalTurnId && attempt.result?.status === 'candidate', 'Candidate/accepted task needs a submitted result AND an observed terminal turn.');
    }
    if (['canceled', 'superseded'].includes(task.status)) requireState(!!task.reason, 'Canceled or superseded task needs a reason.');
    if (task.diagnosis) requireState(lookup(r.attempts, task.diagnosis.afterAttempt, 'diagnosed attempt').taskId === task.id, 'Diagnosis belongs to another task.');
  }
  const liveSessions = new Set<string>();
  for (const a of r.attempts) {
    const task = lookup(r.tasks, a.taskId, 'attempt task');
    requireState(a.taskRevision <= task.revision && a.specificationRevision <= r.specificationRevision, 'Future attempt contract.');
    const workspace = lookup(r.workspaces, a.workspaceId, 'attempt workspace');
    requireState(workspace.ownerSessionId === a.sessionId, 'Attempt workspace owner mismatch.');
    if (a.profile) requireState(r.profiles.some((p) => isDeepStrictEqual(p, a.profile)), 'Attempt profile snapshot was rewritten.');
    requireState([r.config, ...r.configHistory].some((c) => member(c, a.preset, a.tierId)), 'Attempt preset/tier is not an approved snapshot.');
    if (active(a)) {
      requireState(!liveSessions.has(a.sessionId) && workspace.cleanedAt === undefined, 'Session/workspace has multiple live attempts or was cleaned.'); liveSessions.add(a.sessionId);
      requireState(a.taskRevision === task.revision && a.specificationRevision === task.specificationRevision, 'Live task contract was rewritten.');
      if (!a.profile) requireState(a.sessionId === r.leadSessionId && isDeepStrictEqual(a.preset, r.leadPreset)
        && (a.generation === r.leadGeneration || ['recovering', 'stopping'].includes(r.status) && a.generation < r.leadGeneration), 'Stale lead attempt generation or preset.');
      else requireState(a.sessionId !== r.leadSessionId, 'The principal engineer cannot also be a worker identity.');
    }
    if (a.taskRevision === task.revision) {
      if (task.assignment.kind === 'worker') requireState(a.profile?.id === task.assignment.profileId && a.profile.revision === task.assignment.profileRevision, 'Attempt/task profile mismatch.');
      else requireState(!a.profile && a.tierId === 5, 'Lead assignment cannot become a worker.');
    }
    requireState(a.profile?.tierId === undefined || a.profile.tierId === a.tierId, 'Profile/attempt tier mismatch.');
    if (a.status === 'terminal') requireState(!!a.outcome && a.endedAt !== undefined && a.endedAt >= a.requestedAt, 'Terminal attempt needs outcome and end timestamp.');
    else requireState(a.outcome === undefined && a.endedAt === undefined, 'Live attempt cannot have a terminal outcome.');
    if (a.outcome === 'submitted') requireState(a.result?.status === 'candidate' && !!a.terminalTurnId && !a.failure, 'Submitted outcome needs structured candidate and terminal observation without failure.');
    if (a.result) {
      requireState(a.result.attemptId === a.id && a.result.taskId === a.taskId && a.result.taskRevision === a.taskRevision && a.result.specificationRevision === a.specificationRevision, 'Result/attempt binding mismatch.');
      refs(r.evidence, a.result.evidenceIds, 'result evidence'); refs(r.decisions, a.result.decisionIds, 'result decision');
    }
  }
  for (const c of r.candidates) {
    const a = lookup(r.attempts, c.attemptId, 'candidate attempt');
    requireState(c.taskId === a.taskId && c.taskRevision === a.taskRevision && c.specificationRevision === a.specificationRevision && sameRevision(c.sourceRevision, a.sourceRevision), 'Candidate/attempt binding mismatch.');
    requireState(a.status === 'terminal', 'Candidate capture requires a settled attempt.');
  }
  for (const e of r.evidence) {
    requireState(e.specificationRevision <= r.specificationRevision, 'Future evidence specification.');
    requireState((e.taskId === undefined) === (e.taskRevision === undefined), 'Evidence task and revision must be paired.');
    if (e.taskId) requireState(e.taskRevision! <= lookup(r.tasks, e.taskId, 'evidence task').revision, 'Future evidence task revision.');
    if (e.attemptId) { const a = lookup(r.attempts, e.attemptId, 'evidence attempt'); requireState(a.taskId === e.taskId && a.taskRevision === e.taskRevision, 'Evidence/attempt binding mismatch.'); }
    if (e.endedAt !== undefined) requireState(e.endedAt >= e.startedAt, 'Evidence timestamps go backwards.');
  }
  for (const d of r.decisions) { refs(r.tasks, d.affectedTaskIds, 'decision task'); refs(r.evidence, d.evidenceIds, 'decision evidence'); requireState((d.resolution === undefined) === (d.rationale === undefined), 'Decision resolution requires rationale.'); }
  for (const review of r.reviews) {
    lookup(r.candidates, review.candidateId, 'review candidate'); lookup(r.attempts, review.reviewerAttemptId, 'reviewer attempt'); unique(review.findings, (f) => f.id, 'finding');
    for (const f of review.findings) { refs(r.evidence, f.evidenceIds, 'finding evidence'); if (f.resolution) refs(r.evidence, f.resolution.evidenceIds, 'resolution evidence'); }
  }
  if (r.delivery) requireState(lookup(r.operations, r.delivery.operationId, 'delivery operation').kind === 'deliver', 'Delivery references a different operation kind.');
  if (r.status === 'completed') {
    requireState(!completionProblems(r, { quiescent: true }).length, 'Persisted completed Mission does not satisfy its completion gates.');
    // Older completed journals predate this derived snapshot. They remain valid if the original
    // completion gates hold; host read models reconstruct the report without rerunning delivery.
    requireState(!r.completionReport || isDeepStrictEqual(r.completionReport, buildMissionCompletionReport(r)), 'Completed Mission report must match its authoritative evidence and delivery receipt.');
  } else requireState(!r.completionReport, 'Only a completed Mission can have a final report.');
}

function dependenciesReady(record: MissionRecord, task: MissionTask): boolean {
  return task.dependsOn.every((d) => { const parent = record.tasks.find((t) => t.id === d.taskId); return !!parent && (d.condition === 'integrated_code' ? parent.status === 'integrated' : satisfied(parent)); })
    && task.decisionRefs.every((key) => !!record.decisions.find((d) => d.id === key)?.resolution);
}
/** Dependency readiness only; the scheduler must additionally check live capabilities, resources,
 * permissions and actual workspace quiescence. Returned values are detached from the ledger. */
export function readyTasks(record: MissionRecord): MissionTask[] {
  assertMissionRecord(record);
  if (record.status !== 'running' || !['planning', 'executing'].includes(record.phase)) return [];
  return structuredClone(record.tasks.filter((task) => ['planned', 'ready', 'changes_requested', 'failed'].includes(task.status)
    && !record.attempts.some((a) => a.taskId === task.id && active(a)) && dependenciesReady(record, task)
    && (!writable(task, record) || record.phase === 'executing' && !!record.executionAuthorization && !!record.baseline)));
}

function evidenceApplies(record: MissionRecord, evidence: MissionEvidence, revision: MissionCodeRevision): boolean {
  return !evidence.invalidatedBy && evidence.specificationRevision === record.specificationRevision && sameContent(evidence.sourceRevision, revision)
    && (!evidence.taskId || record.tasks.some((t) => t.id === evidence.taskId && t.revision === evidence.taskRevision && !['canceled', 'superseded'].includes(t.status)));
}
function capturedEvidencePasses(record: MissionRecord, evidence: MissionEvidence, revision: MissionCodeRevision): boolean {
  if (!evidenceApplies(record, evidence, revision) || evidence.provenance === 'agent_claim' || evidence.result !== 'passed'
    || evidence.endedAt === undefined || !evidence.artifactIds.length) return false;
  const check = record.deliveryPolicy.checks.find((c) => c.id === evidence.checkId);
  if (check && (evidence.kind !== check.kind || evidence.commandOrFlow !== check.command || evidence.exitCode !== 0 || evidence.criterionIds.some((key) => !check.criterionIds.includes(key)))) return false;
  if (['test', 'build'].includes(evidence.kind) && (!check || evidence.exitCode !== 0)) return false;
  if (evidence.kind === 'test') return !!check?.testReport && evidence.executedTests !== undefined && evidence.executedTests >= Math.max(1, check.testReport.minimumTests)
    && evidence.skippedTests !== undefined && evidence.skippedTests <= check.testReport.maximumSkipped;
  return true;
}
function evidencePasses(record: MissionRecord, evidence: MissionEvidence, revision: MissionCodeRevision): boolean {
  if (!capturedEvidencePasses(record, evidence, revision)) return false;
  // A later failed, skipped or incomplete capture cannot be hidden behind an earlier pass.
  const last = record.evidence.filter((e) => e.checkId === evidence.checkId && e.kind === evidence.kind && e.provenance !== 'agent_claim' && evidenceApplies(record, e, revision))
    .reduce<MissionEvidence | undefined>((latest, e) => !latest || (e.endedAt ?? e.startedAt) >= (latest.endedAt ?? latest.startedAt) ? e : latest, undefined);
  return !last || capturedEvidencePasses(record, last, revision);
}
function presetMismatch(attempt: MissionAttempt): boolean {
  return !!attempt.effectiveModel && (attempt.effectiveModel.provider !== attempt.preset.model.provider || attempt.effectiveModel.model !== attempt.preset.model.model)
    || attempt.preset.reasoning.kind === 'explicit' && attempt.effectiveEffort !== undefined && attempt.effectiveEffort !== attempt.preset.reasoning.value;
}
/** Every declared kind is required. Reviews and delivery have their own authenticated records,
 * not synthetic check evidence. Task acceptance and delivery preflight defer only delivery;
 * completion evaluates it against the same final receipt predicate as the delivery policy. */
function criteriaBlockers(record: MissionRecord, criteria: MissionTask['criteria'], revision: MissionCodeRevision, requireDelivery = false): string[] {
  return criteria.filter((c) => c.required).flatMap((c) => c.evidenceKinds.filter((kind) => {
    if (kind === 'delivery') return requireDelivery && deliveryProblems(record, revision).length > 0;
    if (kind === 'review') return !record.reviews.some((review) => review.criterionIds.includes(c.id) && sameContent(review.sourceRevision, revision)
      && record.candidates.some((candidate) => candidate.id === review.candidateId && reviewPasses(record, review, candidate)));
    return !record.evidence.some((e) => e.kind === kind && e.criterionIds.includes(c.id) && evidencePasses(record, e, revision));
  }).map((kind) => `Criterion ${c.id} lacks valid ${kind} evidence.`));
}
function reviewPasses(record: MissionRecord, review: MissionReview, candidate: MissionCandidate): boolean {
  const author = record.attempts.find((a) => a.id === candidate.attemptId);
  const reviewer = record.attempts.find((a) => a.id === review.reviewerAttemptId);
  const task = record.tasks.find((t) => t.id === candidate.taskId);
  const reviewTask = record.tasks.find((t) => t.id === reviewer?.taskId);
  return !!task && (task.revision !== candidate.taskRevision || task.criteria.filter((c) => c.required && c.evidenceKinds.some((kind) => kind !== 'delivery')).every((c) => review.criterionIds.includes(c.id))) && review.candidateId === candidate.id && sameContent(review.sourceRevision, candidate.revision) && !!reviewer && !!author && reviewer.id !== author.id
    && reviewer.sessionId !== author.sessionId && sameContent(reviewer.sourceRevision, candidate.revision) && reviewer.status === 'terminal' && !!reviewer.terminalTurnId
    && reviewer.outcome === 'submitted' && reviewer.specificationRevision === record.specificationRevision && reviewer.profile?.sourceAccess === 'read_only'
    && !!reviewTask && currentResult(reviewTask, reviewer) && !presetMismatch(reviewer) && !reviewer.result?.unresolved.some((u) => u.blocking);
}

/** No waiver is inferred from agent prose or the policy's human-readable provenance. A required
 * check marked waived/not_applicable remains unverified until policy explicitly changes via the
 * trusted policy owner. Quiescence must be observed by the host, never supplied by a model. */
export function completionBlockers(record: MissionRecord, observations: { quiescent: boolean }): string[] {
  assertMissionRecord(record);
  return completionProblems(record, observations);
}
/** Delivery preflight without inventing a successful receipt. The host may exclude exactly its
 * own already-admitted in-flight delivery operation, not queued or unrelated mutations. */
export function implementationBlockers(record: MissionRecord, observations: { quiescent: boolean; deliveryOperationId?: string }): string[] {
  assertMissionRecord(record);
  return implementationProblems(record, observations);
}
function implementationProblems(record: MissionRecord, observations: { quiescent: boolean; deliveryOperationId?: string }, requireDelivery = false): string[] {
  const blockers: string[] = [];
  const revision = record.acceptedRevision;
  if (!observations || observations.quiescent !== true || record.attempts.some(active)) blockers.push('Owned activity is not quiescent.');
  if (record.operations.some((o) => pending(o) && !(record.status === 'completed' && (o.kind === 'cleanup' || isMissionQuestionOperation(o))) && !(o.id === observations?.deliveryOperationId && o.kind === 'deliver' && o.state === 'in_flight'))) blockers.push('Pending operations remain.');
  if (observations?.deliveryOperationId && !record.operations.some((o) => o.id === observations.deliveryOperationId && o.kind === 'deliver' && o.state === 'in_flight')) blockers.push('Delivery preflight does not identify its own in-flight delivery operation.');
  if (!record.executionAuthorization) blockers.push('Execution is not authorized.');
  if (!revision) blockers.push('No accepted final revision.');
  if (!record.plan.criteria.some((c) => c.required) || !record.tasks.some((t) => t.required)) blockers.push('Required outcomes and tasks are missing.');
  if (record.questions.some((q) => q.answer === undefined) || record.pendingProposal) blockers.push('A question or execution proposal is pending.');
  if (record.decisions.some((d) => !d.resolution)) blockers.push('Unresolved decisions remain.');
  if (record.blockers.some((b) => b.resolvedAt === undefined)) blockers.push('Unresolved Mission blockers remain.');
  if (record.deliveryPolicy.conflicts.length) blockers.push('Delivery policy conflicts remain.');
  for (const task of record.tasks.filter((t) => t.required)) {
    const attempt = record.attempts.find((a) => a.id === task.currentAttemptId);
    if (!satisfied(task) || !attempt || !currentResult(task, attempt)) blockers.push(`Task ${task.id} is not satisfied by a current result.`);
    if (attempt?.result?.unresolved.some((u) => u.blocking)) blockers.push(`Task ${task.id} has unresolved blocking results.`);
    if (attempt && presetMismatch(attempt)) blockers.push(`Task ${task.id} has a known effective preset mismatch.`);
    if (revision) blockers.push(...criteriaBlockers(record, task.criteria, revision, requireDelivery));
    const candidates = record.candidates.filter((c) => c.attemptId === task.currentAttemptId);
    if (writable(task, record) && !candidates.length) blockers.push(`Task ${task.id} has no captured code candidate.`);
    for (const c of candidates.filter((candidate) => candidate.changedPaths.length > 0)) {
      if (!c.integratedRevision || task.status !== 'integrated') blockers.push(`Candidate ${c.id} is not integrated.`);
    }
  }
  // Optional task code still changes the delivered product; it cannot evade independent review.
  for (const c of record.candidates.filter((candidate) => candidate.integratedRevision && candidate.changedPaths.length)) {
    if (record.deliveryPolicy.requireIndependentReview && !record.reviews.some((r) => reviewPasses(record, r, c))) blockers.push(`Candidate ${c.id} lacks independent review.`);
  }
  for (const review of record.reviews) for (const finding of review.findings) {
    if (!['critical', 'major'].includes(finding.severity)) continue;
    if (!finding.resolution || !revision || !finding.resolution.evidenceIds.every((key) => {
      const evidence = record.evidence.find((e) => e.id === key);
      const candidate = record.candidates.find((c) => c.id === review.candidateId);
      return !!evidence && evidencePasses(record, evidence, finding.resolution?.kind === 'rejected' && candidate ? candidate.revision : revision);
    })) blockers.push(`Mandatory finding ${finding.id} is unresolved or lacks valid resolution evidence.`);
  }
  if (revision) {
    blockers.push(...criteriaBlockers(record, record.plan.criteria, revision, requireDelivery));
    const checks = new Set([...record.deliveryPolicy.checks.filter((c) => c.required).map((c) => c.id), ...record.tasks.filter((t) => t.required).flatMap((t) => t.verificationIds)]);
    for (const check of checks) if (!record.evidence.some((e) => e.checkId === check && evidencePasses(record, e, revision))) blockers.push(`Required check ${check} is missing, stale, skipped or unverified.`);
  }
  return [...new Set(blockers)];
}
function completionProblems(record: MissionRecord, observations: { quiescent: boolean }): string[] {
  return [...new Set([...implementationProblems(record, observations, true), ...deliveryProblems(record, record.acceptedRevision)])];
}
/** Legacy completed records have the same frozen evidence authority, even without a cached
 * report. Only host read models use this projection; it cannot complete an unfinished Mission. */
export function missionCompletionReport(record: MissionRecord): MissionCompletionReport {
  assertMissionRecord(record);
  requireState(record.status === 'completed', 'A final report requires host-confirmed completion.');
  return record.completionReport ? structuredClone(record.completionReport) : buildMissionCompletionReport(record);
}

/** Called only after the host completion gates. No model payload, Markdown, session text or
 * mutable Git branch is report authority. This deterministic snapshot is journaled atomically
 * with completion, including the recovered-receipt + explicit Resume path. */
function buildMissionCompletionReport(record: MissionRecord): MissionCompletionReport {
  const revision = record.acceptedRevision!, delivery = record.delivery!;
  const required = record.tasks.filter((task) => task.required);
  const candidates = record.candidates.filter((candidate) => candidate.integratedRevision && candidate.changedPaths.length);
  const reviews = record.reviews.filter((review) => record.candidates.some((candidate) => candidate.id === review.candidateId && reviewPasses(record, review, candidate)));
  const operation = record.operations.find((op) => op.id === delivery.operationId)!;
  const narrative = typeof operation.payload.report === 'string' ? operation.payload.report.trim() : '';
  const report: MissionCompletionReport = {
    schemaVersion: 1, objective: record.objective, specificationRevision: record.specificationRevision, planRevision: record.planRevision,
    acceptedRevision: revision, completedAt: delivery.completedAt!, delivery,
    deliveryPolicy: { holdConditions: record.deliveryPolicy.holdConditions, holdIsEndpoint: record.deliveryPolicy.holdIsEndpoint, fallback: record.deliveryPolicy.fallback },
    tasks: { required: required.length, satisfiedRequired: required.filter(satisfied).length, total: record.tasks.length,
      satisfied: record.tasks.filter(satisfied).length, canceled: record.tasks.filter((task) => task.status === 'canceled').length, superseded: record.tasks.filter((task) => task.status === 'superseded').length },
    checks: record.deliveryPolicy.checks.map((check) => {
      const evidence = record.evidence.filter((e) => e.checkId === check.id && e.kind === check.kind && e.provenance !== 'agent_claim' && evidenceApplies(record, e, revision))
        .reduce<MissionEvidence | undefined>((latest, e) => !latest || (e.endedAt ?? e.startedAt) >= (latest.endedAt ?? latest.startedAt) ? e : latest, undefined);
      return { check, ...(evidence ? { evidence } : {}), verified: !!evidence && evidencePasses(record, evidence, revision) };
    }),
    review: { required: record.deliveryPolicy.requireIndependentReview, integratedCandidates: candidates.length,
      independentlyReviewedCandidates: candidates.filter((candidate) => reviews.some((review) => review.candidateId === candidate.id)).length, reviews },
    exclusions: record.plan.exclusions,
    assumptions: record.plan.assumptions.filter((assumption) => ['assumed', 'confirmed'].includes(assumption.status)),
    decisions: record.decisions,
    limitations: record.tasks.flatMap((task) => [
      ...(!satisfied(task) ? [{ taskId: task.id, description: `${task.status}: ${task.reason ?? task.objective}` }] : []),
      ...(record.attempts.find((attempt) => attempt.id === task.currentAttemptId)?.result?.unresolved.map((item) => ({ taskId: task.id, description: item.description })) ?? [])
    ]),
    ...(narrative ? { narrative: { sessionId: record.leadSessionId, text: narrative } } : {})
  };
  // Match the journal's omission of undefined optional fields before checking a restored report.
  return JSON.parse(JSON.stringify(report)) as MissionCompletionReport;
}

function deliveryProblems(record: MissionRecord, revision: MissionCodeRevision | undefined): string[] {
  const blockers: string[] = [];
  const d = record.delivery;
  const p = record.deliveryPolicy;
  if (!d || !revision || !sameContent(d.revision, revision) || d.endpoint !== p.endpoint || d.completedAt === undefined) blockers.push('Delivery does not identify the verified final content and endpoint.');
  else {
    const op = record.operations.find((o) => o.id === d.operationId);
    if (!op || op.state !== 'succeeded' || op.kind !== 'deliver') blockers.push('Delivery operation is not confirmed.');
    if (p.targetBranch && op?.payload.targetBranch !== p.targetBranch || p.remote && op?.payload.remote !== p.remote || p.targetHead && d.expectedTargetHead !== p.targetHead) blockers.push('Delivery target differs from policy.');
    if (d.status === 'held') {
      if (!p.holdIsEndpoint || !p.holdConditions.length || !d.reason) blockers.push('Delivery hold is not an authorized endpoint.');
    } else if (d.status !== 'delivered') blockers.push('Delivery has not succeeded.');
    if (d.status === 'delivered') {
      if (p.endpoint === 'local_commit' && !d.commitSha) blockers.push('Local commit identifier is missing.');
      if (['open_pr', 'merge_pr'].includes(p.endpoint) && (!d.pullRequestUrl || !p.allowPush)) blockers.push('Authorized PR delivery is missing.');
      if (p.endpoint === 'merge_pr' && (!d.mergedCommitSha || !p.allowMerge)) blockers.push('Authorized merge outcome is missing.');
      if (p.endpoint === 'custom' && !record.evidence.some((e) => e.kind === 'delivery' && evidencePasses(record, e, revision))) blockers.push('Custom delivery evidence is missing.');
    }
  }
  return [...new Set(blockers)];
}

function assertLead(record: MissionRecord, actor: MissionActor): asserts actor is Extract<MissionActor, { kind: 'lead' }> {
  requireState(actor.kind === 'lead' && actor.sessionId === record.leadSessionId && actor.generation === record.leadGeneration, 'A live principal engineer identity is required.');
  requireState(['running', 'waiting_for_user', 'awaiting_execution_approval'].includes(record.status), 'Principal engineer control is not live.');
}
function assertUser(actor: MissionActor): asserts actor is Extract<MissionActor, { kind: 'user' }> { requireState(actor.kind === 'user', 'A host-authenticated user action is required.'); }
function assignedAttempt(record: MissionRecord, actor: MissionActor, attemptId: string): MissionAttempt {
  const attempt = lookup(record.attempts, attemptId, 'attempt');
  const task = lookup(record.tasks, attempt.taskId, 'task');
  if (actor.kind === 'lead') { assertLead(record, actor); requireState(!attempt.profile && task.assignment.kind === 'lead' && attempt.sessionId === actor.sessionId && attempt.generation === actor.generation, 'Lead is not assigned to this attempt.'); }
  else requireState(actor.kind === 'worker' && actor.attemptId === attempt.id && actor.sessionId === attempt.sessionId && actor.generation === attempt.generation && !!attempt.profile
    && ['running', 'waiting_for_user', 'awaiting_execution_approval', 'pausing', 'recovering'].includes(record.status), 'Worker identity is not bound to this attempt.');
  requireState(currentResult(task, attempt), 'Obsolete task/attempt result.');
  return attempt;
}
function settled(record: MissionRecord, quiescent: boolean): void {
  requireState(quiescent && !record.attempts.some(active) && !record.operations.some(pending), 'Owned activity/operations must first be reconciled and quiescent.');
}
function admit(record: MissionRecord): void { requireState(record.status === 'running' && !record.blockers.some((b) => b.resolvedAt === undefined), 'Mission is not admitting new operations.'); }
function contract(task: MissionTask): MissionTaskContract {
  const { status: _status, currentAttemptId: _attempt, reason: _reason, diagnosis: _diagnosis, ...value } = task; return value;
}
function invalidateTasks(record: MissionRecord, taskIds: string[], reason: string): void {
  // Contract changes propagate through dependent inputs, including accepted results.
  const affected = new Set(taskIds); let changed = true;
  while (changed) { changed = false; for (const task of record.tasks) if (!affected.has(task.id) && task.dependsOn.some((d) => affected.has(d.taskId))) { affected.add(task.id); changed = true; } }
  for (const key of affected) { const task = lookup(record.tasks, key, 'affected task'); task.status = 'superseded'; task.reason = reason; }
  for (const e of record.evidence) if (e.taskId && affected.has(e.taskId)) e.invalidatedBy = reason;
  delete record.delivery;
}
function appendImmutable<T extends { id: string }>(values: T[], item: T, label: string): void {
  const prior = values.find((v) => v.id === item.id);
  if (prior) requireState(isDeepStrictEqual(prior, item), `Conflicting duplicate ${label}.`);
  else values.push(item);
}

/** Returns an isolated next record. Invalid calls leave both input record and payload unchanged.
 * The store performs CAS/idempotency/journal sequencing and sets revision/updatedAt separately. */
export function reduceMission(record: MissionRecord, actor: MissionActor, mutation: MissionMutation): MissionRecord {
  assertMissionRecord(record); assertSchema(actorSchema, actor); assertMissionMutation(mutation);
  const terminalCleanup = actor.kind === 'host' && (mutation.kind === 'host.operation.record' && mutation.operation.kind === 'cleanup'
    || mutation.kind === 'host.operation.transition' && record.operations.some((o) => o.id === mutation.operationId && o.kind === 'cleanup'));
  requireState(!['stopped', 'completed'].includes(record.status) || terminalCleanup, 'Stopped/completed Missions are immutable except explicit cleanup receipts.');
  if (mutation.kind.startsWith('host.')) requireState(actor.kind === 'host', 'Operational observations are host-only.');
  if (mutation.kind.startsWith('control.')) assertUser(actor);
  // Check every model caller even on operations whose individual branch also checks authority.
  if (actor.kind === 'lead') assertLead(record, actor);
  if (actor.kind === 'worker') assignedAttempt(record, actor, actor.attemptId);
  const r = structuredClone(record);
  const m = structuredClone(mutation);
  switch (m.kind) {
    case 'plan.update': {
      if (actor.kind !== 'user') assertLead(r, actor);
      requireState(m.expectedPlanRevision === r.planRevision, 'Stale plan revision.');
      requireState(!['pausing', 'recovering', 'stopping'].includes(r.status), 'Plan update cannot race reconciliation.');
      const semanticPlan = (plan: MissionPlan) => ({ ...plan, assumptions: plan.assumptions.filter((a) => a.affectedTaskIds.length || a.criterionIds.length).map(({ rationale: _rationale, ...a }) => a) });
      const substantive = !isDeepStrictEqual(semanticPlan(r.plan), semanticPlan(m.plan));
      unique(m.checks ?? [], (check) => check.id, 'discovered check');
      const addedChecks = (m.checks ?? []).filter((check) => {
        const prior = r.deliveryPolicy.checks.find((old) => old.id === check.id);
        if (prior) requireState(isDeepStrictEqual(prior, check), 'Existing checks are immutable; discovery cannot weaken or relabel a gate.');
        else requireState(check.required && check.criterionIds.length > 0 && (check.kind !== 'test' || !!check.testReport), 'A discovered check must be required, map a criterion, and declare real test counts for tests.');
        return !prior;
      });
      const preserveProposal = !m.material && !substantive && !addedChecks.length && !(m.tasks ?? []).some((t) => !r.tasks.some((prior) => isDeepStrictEqual(contract(prior), t)));
      requireState(!substantive || r.planRevision === 0 || !!m.material, 'Material plan changes require an explicit source and affected tasks.');
      if (actor.kind !== 'user') for (const old of r.plan.criteria.filter((c) => c.required)) requireState(m.plan.criteria.some((c) => isDeepStrictEqual(c, old)), 'A model cannot remove or weaken an explicit required criterion.');
      if (m.material) {
        refs(r.tasks, m.material.affectedTaskIds, 'affected task');
        if (m.material.source.kind === 'user') { assertUser(actor); requireState(m.material.source.actionId === actor.actionId, 'Material change must bind the actual user action.'); }
        else if (m.material.source.kind === 'user_instruction') {
          assertLead(r, actor);
          const instructions = r.mailbox.filter((item) => item.kind === 'user' && item.userAction?.materialBinding?.revision === r.revision && item.userAction.appliedPlanRevision === undefined);
          requireState(instructions.length === 1, 'Material change needs a fresh host-bound user instruction from this lead turn.');
          const item = instructions[0], action = item.userAction!, binding = action.materialBinding!;
          requireState(action.kind !== 'authorization' && item.deliveredAt !== undefined && action.specificationRevision === r.specificationRevision && action.planRevision === r.planRevision
            && binding.sessionId === actor.sessionId && binding.generation === actor.generation
            && r.operations.some((op) => op.id === binding.operationId && op.kind === 'dispatch' && op.state === 'in_flight' && op.payload.sessionId === actor.sessionId
              && op.payload.generation === actor.generation && op.payload.dispatchStartedAt !== undefined && (op.payload.mailboxIds as string[] | undefined)?.includes(item.id)),
          'User instruction is stale, undelivered, consumed, or belongs to another lead dispatch.');
          action.appliedPlanRevision = r.planRevision + 1;
        } else {
          assertLead(r, actor); requireState(r.entryMode === 'autonomous' && r.executionAuthorization?.kind === 'autonomous_launch', 'Assumption changes need autonomous objective authorization.');
          const source = m.plan.assumptions.find((a) => m.material?.source.kind === 'assumption' && a.id === m.material.source.assumptionId);
          requireState(source && source.status === 'assumed' && m.material.affectedTaskIds.every((key) => source.affectedTaskIds.includes(key)), 'Material assumption must identify its affected tasks.');
        }
        r.specificationRevision++;
        invalidateTasks(r, m.material.affectedTaskIds, 'Material specification changed; replan stale inputs.');
        for (const e of r.evidence) e.invalidatedBy ??= 'Specification changed.';
        if (r.executionAuthorization?.kind === 'autonomous_launch' && m.material.source.kind === 'assumption') r.executionAuthorization.specificationRevision = r.specificationRevision;
        else {
          const needsPause = m.material.source.kind !== 'user_instruction' || !!r.executionAuthorization || r.phase !== 'planning' || r.attempts.some(active);
          delete r.executionAuthorization; r.phase = 'planning';
          r.status = needsPause && (r.attempts.some(active) || r.operations.some(pending)) ? 'pausing' : 'running';
        }
      }
      r.plan = m.plan; r.planRevision++;
      if (addedChecks.length) {
        r.deliveryPolicy.checks.push(...addedChecks);
        for (const evidence of r.evidence) evidence.invalidatedBy ??= 'Verification plan changed.';
        delete r.delivery;
      }
      if (preserveProposal && r.pendingProposal) r.pendingProposal.planRevision = r.planRevision;
      else delete r.pendingProposal;
      if (r.status === 'awaiting_execution_approval' && !r.pendingProposal) r.status = 'running';
      if (m.tasks) {
        unique(m.tasks, (t) => t.id, 'task contract');
        for (const input of m.tasks) {
          requireState(input.specificationRevision === r.specificationRevision, 'Task contract needs the current specification revision.');
          const prior = r.tasks.find((t) => t.id === input.id);
          if (!prior) { requireState(input.revision === 1, 'New task starts at revision one.'); r.tasks.push({ ...input, status: 'planned' }); continue; }
          if (isDeepStrictEqual(contract(prior), input)) continue;
          requireState(!r.attempts.some((a) => a.taskId === input.id && active(a)), 'Cannot rewrite a running task contract. Reconcile its attempt first.');
          requireState(input.revision === prior.revision + 1, 'Task revision must advance exactly once.');
          if (actor.kind !== 'user') requireState(!prior.required || input.required && prior.criteria.filter((c) => c.required).every((c) => input.criteria.some((next) => isDeepStrictEqual(c, next))), 'A model cannot remove a required task outcome.');
          invalidateTasks(r, [prior.id], 'Task contract changed.');
          r.tasks[r.tasks.indexOf(prior)] = { ...input, status: 'planned' };
        }
      }
      break;
    }
    case 'question.ask': {
      assertLead(r, actor); requireState(r.status === 'running' && !r.questions.some((q) => q.answer === undefined) && !r.pendingProposal, 'Ask one question at a time without a pending execution proposal.');
      const purpose = m.question.purpose ?? 'clarification';
      requireState(purpose !== 'clarification' || r.phase === 'planning' && !r.executionAuthorization, 'Ordinary clarification belongs to unapproved interactive planning, not autonomous execution.');
      requireState(!r.questions.some((q) => q.id === m.question.id), 'Question identity already exists.'); r.questions.push({ ...m.question, purpose }); r.status = 'waiting_for_user'; break;
    }
    case 'question.answer': {
      assertUser(actor); const q = lookup(r.questions, m.questionId, 'question'); requireState(r.status === 'waiting_for_user' && q.answer === undefined, 'Question is no longer awaiting an answer.');
      q.answer = m.answer; q.sourceUserActionId = actor.actionId; r.status = 'running'; break;
    }
    case 'execution.propose':
      assertLead(r, actor); requireState(r.phase === 'planning' && r.status === 'running' && !r.executionAuthorization && !r.pendingProposal && !r.questions.some((q) => q.answer === undefined), 'Only an unapproved ready plan can be proposed.');
      requireState(m.proposal.planRevision === r.planRevision && m.proposal.specificationRevision === r.specificationRevision && r.planRevision > 0 && r.tasks.some((t) => t.required) && r.plan.criteria.some((c) => c.required), 'Proposal does not identify a ready current plan.');
      r.pendingProposal = m.proposal; r.status = 'awaiting_execution_approval'; break;
    case 'execution.authorize':
      assertUser(actor); requireState(r.status === 'awaiting_execution_approval' && r.pendingProposal?.id === m.proposalId && r.pendingProposal.specificationRevision === m.specificationRevision && r.specificationRevision === m.specificationRevision && r.pendingProposal.planRevision === r.planRevision, 'No matching current execution proposal.');
      requireState(!!r.baseline && !r.blockers.some((b) => b.resolvedAt === undefined) && !r.deliveryPolicy.conflicts.length, 'Resolve baseline, capability and policy blockers before execution.');
      r.executionAuthorization = { kind: 'approved_plan', sourceUserActionId: actor.actionId, specificationRevision: r.specificationRevision, recordedAt: m.at }; delete r.pendingProposal; r.phase = 'executing'; r.status = 'running'; break;
    case 'profile.upsert': {
      assertLead(r, actor); const versions = r.profiles.filter((p) => p.id === m.profile.id); const latest = Math.max(0, ...versions.map((p) => p.revision));
      const existing = versions.find((p) => p.revision === m.profile.revision);
      if (existing) requireState(isDeepStrictEqual(existing, m.profile), 'Profile revisions are immutable.');
      else { requireState(m.profile.revision === latest + 1, 'Profile revision must advance exactly once.'); r.profiles.push(m.profile); } break;
    }
    case 'decision.request': {
      requireState(actor.kind === 'lead' || actor.kind === 'worker', 'Only Mission participants request decisions.');
      if (actor.kind === 'worker') {
        const a = assignedAttempt(r, actor, actor.attemptId); requireState(active(a) && m.decision.affectedTaskIds.length > 0 && m.decision.affectedTaskIds.every((key) => key === a.taskId), 'Worker decision exceeds its assignment.');
        requireState(m.decision.evidenceIds.every((key) => r.evidence.some((e) => e.id === key && e.attemptId === a.id)), 'Worker decision evidence exceeds its assignment.');
      }
      appendImmutable(r.decisions, { ...m.decision, requestedBy: actor.sessionId }, 'decision'); break;
    }
    case 'decision.resolve': {
      assertLead(r, actor); const decision = lookup(r.decisions, m.decisionId, 'decision'); requireState(!decision.resolution, 'Decision was already resolved.'); refs(r.evidence, m.evidenceIds, 'decision evidence');
      decision.resolution = m.resolution; decision.rationale = m.rationale; decision.evidenceIds = [...new Set([...decision.evidenceIds, ...m.evidenceIds])];
      refs(r.tasks, m.affectedTaskIds, 'affected task'); decision.affectedTaskIds = [...new Set([...decision.affectedTaskIds, ...m.affectedTaskIds])];
      if (m.affectedTaskIds.length) invalidateTasks(r, m.affectedTaskIds, 'Shared decision changed; task inputs are stale.'); break;
    }
    case 'result.report': {
      const attempt = assignedAttempt(r, actor, m.result.attemptId);
      requireState(m.result.taskId === attempt.taskId && m.result.taskRevision === attempt.taskRevision && m.result.specificationRevision === attempt.specificationRevision, 'Result contract does not match the assigned attempt.');
      if (attempt.result) { requireState(isDeepStrictEqual(attempt.result, m.result), 'Conflicting duplicate result submission.'); break; }
      requireState(['running', 'settling'].includes(attempt.status), 'Attempt cannot submit a delayed or premature result.');
      requireState(m.result.evidenceIds.every((key) => r.evidence.some((e) => e.id === key && e.attemptId === attempt.id)), 'Result evidence does not belong to the assigned attempt.');
      refs(r.decisions, m.result.decisionIds, 'result decision');
      requireState(m.result.decisionIds.every((key) => r.decisions.some((d) => d.id === key && (d.affectedTaskIds.includes(attempt.taskId) || lookup(r.tasks, attempt.taskId, 'task').decisionRefs.includes(key)))), 'Result decision does not belong to the assigned contract.');
      attempt.result = m.result; break;
    }
    case 'review.submit': {
      const a = assignedAttempt(r, actor, m.review.reviewerAttemptId); requireState(active(a) && a.profile?.sourceAccess === 'read_only', 'Review submission requires an assigned read-only reviewer.');
      const candidate = lookup(r.candidates, m.review.candidateId, 'review candidate'); const author = lookup(r.attempts, candidate.attemptId, 'author');
      requireState(a.id !== author.id && a.sessionId !== author.sessionId && sameContent(a.sourceRevision, candidate.revision) && sameContent(m.review.sourceRevision, candidate.revision), 'Review must be independent and bound to the assigned content.');
      requireState(m.review.findings.every((f) => !f.resolution), 'Reviewer cannot resolve its own findings.'); appendImmutable(r.reviews, m.review, 'review'); break;
    }
    case 'finding.resolve': {
      assertLead(r, actor); const f = lookup(lookup(r.reviews, m.reviewId, 'review').findings, m.findingId, 'finding'); requireState(!f.resolution, 'Finding already has a resolution.'); refs(r.evidence, m.resolution.evidenceIds, 'resolution evidence'); f.resolution = m.resolution; break;
    }
    case 'task.accept': {
      assertLead(r, actor); const task = lookup(r.tasks, m.taskId, 'task'); const attempt = lookup(r.attempts, m.attemptId, 'attempt');
      requireState(task.status === 'candidate_ready' && currentResult(task, attempt) && attempt.status === 'terminal' && attempt.outcome === 'submitted' && !!attempt.terminalTurnId && attempt.result?.status === 'candidate' && !attempt.result.unresolved.some((u) => u.blocking), 'Task needs a current settled candidate without blocking results.');
      requireState(!presetMismatch(attempt), 'Known effective preset mismatch must be resolved before acceptance.');
      const candidate = r.candidates.find((c) => c.attemptId === attempt.id); requireState(!writable(task, r) || candidate, 'Code acceptance requires host candidate capture.');
      const scopeIssue = candidate && candidateScopeIssue(task, candidate, r.plan.exclusions); requireState(!scopeIssue, scopeIssue!);
      requireState(!criteriaBlockers(r, task.criteria, candidate?.revision ?? attempt.sourceRevision).length && task.verificationIds.every((key) => r.evidence.some((e) => e.checkId === key && evidencePasses(r, e, candidate?.revision ?? attempt.sourceRevision))), 'Task acceptance requires captured checks/criteria.');
      task.status = 'accepted'; break;
    }
    case 'task.diagnose': {
      assertLead(r, actor); const task = lookup(r.tasks, m.taskId, 'task'); const attempt = lookup(r.attempts, m.afterAttempt, 'attempt'); requireState(attempt.taskId === task.id && attempt.status === 'terminal' && attempt.outcome === 'failed' && task.currentAttemptId === attempt.id, 'Diagnosis must follow the latest failed attempt.'); task.diagnosis = { afterAttempt: m.afterAttempt, approach: m.approach }; if (task.status === 'failed') task.status = 'changes_requested'; break;
    }
    case 'task.cancel':
      assertLead(r, actor); { const task = lookup(r.tasks, m.taskId, 'task'); requireState(!task.required, 'Required tasks must be replanned, not silently canceled.'); task.status = 'canceled'; task.reason = m.reason; } break;
    case 'phase.set':
      assertLead(r, actor); admit(r); requireState(m.phase !== 'planning' || r.phase === 'planning', 'Returning to planning requires a user control.');
      if (m.phase !== 'planning') requireState(!!r.executionAuthorization && !!r.baseline, 'Execution has not been authorized against a baseline.');
      requireState(m.phase !== 'delivering' || r.phase === 'verifying', 'Delivery follows integrated verification.');
      if (m.phase === 'verifying' || m.phase === 'delivering') requireState(!r.attempts.some(active) && r.tasks.filter((t) => t.required).every(satisfied), 'Settle and satisfy required tasks before final gates.');
      r.phase = m.phase; break;
    case 'control.pause': requireState(!['stopping', 'recovering'].includes(r.status), 'Cannot pause during stop/recovery.'); if (r.status !== 'paused') r.status = 'pausing'; break;
    case 'control.stop': r.status = 'stopping'; r.leadGeneration++; delete r.pendingProposal; break;
    case 'control.continue_planning':
      requireState(r.phase === 'planning' || r.status === 'paused', 'Pause before returning execution to planning.'); settled(r, true); r.phase = 'planning'; r.status = r.questions.some((q) => q.answer === undefined) ? 'waiting_for_user' : 'running'; delete r.executionAuthorization; delete r.pendingProposal; break;
    case 'control.resume':
      requireState(r.status === 'paused', 'Only a reconciled paused Mission can resume.'); settled(r, m.quiescent); requireState(!r.blockers.some((b) => b.resolvedAt === undefined), 'Resolve blockers before resuming.');
      r.status = r.questions.some((q) => q.answer === undefined) ? 'waiting_for_user' : r.pendingProposal ? 'awaiting_execution_approval' : 'running'; break;
    case 'control.steer':
      appendImmutable(r.mailbox, { id: actor.kind === 'user' ? actor.actionId : '', kind: 'user', sessionId: r.leadSessionId, text: m.text, artifactIds: [], createdAt: m.at }, 'user instruction');
      delete r.pendingProposal; if (r.status === 'awaiting_execution_approval') r.status = 'running'; break;
    case 'control.replace_lead':
      requireState(r.status === 'paused', 'Pause before replacing the principal engineer.'); settled(r, m.quiescent); requireState(member(r.config, m.preset, 5), 'Replacement must be a whole enabled T5 preset.');
      requireState(!r.attempts.some((a) => a.sessionId === m.sessionId), 'Replacement session must not inherit a worker identity.'); r.leadSessionId = m.sessionId; r.leadPreset = m.preset; r.leadGeneration++; delete r.pendingProposal; break;
    case 'control.apply_configuration':
      requireState(m.config.revision > r.config.revision, 'Configuration revision must advance.'); r.configHistory.push(r.config); r.config = m.config; break;
    case 'host.start': requireState(r.status === 'created', 'Mission has already started.'); r.status = 'running'; break;
    case 'host.baseline.set':
      requireState(r.phase === 'planning' && !r.baseline && !r.acceptedRevision && !r.attempts.some(active), 'Baseline is already pinned or owned execution is live.'); r.baseline = m.revision; r.acceptedRevision = m.revision; break;
    case 'host.workspace.register':
      requireState(!['stopping', 'paused', 'recovering'].includes(r.status), 'Workspace admission is closed.'); requireState(!r.workspaces.some((w) => w.id !== m.workspace.id && w.path === m.workspace.path), 'Workspace path is already owned.'); appendImmutable(r.workspaces, m.workspace, 'workspace'); break;
    case 'host.attempt.create': {
      admit(r); const a = m.attempt; const task = lookup(r.tasks, a.taskId, 'attempt task');
      requireState(!r.attempts.some((old) => old.id === a.id), 'Attempt identity already exists.'); requireState(readyTasks(r).some((t) => t.id === task.id), 'Task is not ready for admission.');
      requireState(a.status === 'created' && a.result === undefined && a.outcome === undefined && a.terminalTurnId === undefined && a.endedAt === undefined && a.repairTurns === 0 && a.failure === undefined, 'New attempt cannot contain execution results.');
      const approvedPreset = task.assignment.kind === 'lead'
        ? [r.config, ...r.configHistory].some((c) => member(c, a.preset, 5)) && r.config.presets.some((p) => p.id === a.preset.id && p.enabled)
        : member(r.config, a.preset, a.tierId);
      requireState(a.taskRevision === task.revision && a.specificationRevision === task.specificationRevision && approvedPreset, 'Attempt contract or preset selection is stale.');
      if (task.assignment.kind === 'lead') requireState(a.sessionId === r.leadSessionId && a.generation === r.leadGeneration && isDeepStrictEqual(a.preset, r.leadPreset) && !a.profile && a.tierId === 5, 'Lead execution must retain the one live T5 identity.');
      else { requireState(a.sessionId !== r.leadSessionId && !!a.profile && a.profile.id === task.assignment.profileId && a.profile.revision === task.assignment.profileRevision, 'Worker assignment identity mismatch.'); requireState(!r.attempts.some((old) => old.sessionId === a.sessionId && (old.generation >= a.generation || old.taskId !== a.taskId)), 'Reused worker session needs a fresh generation and the same reconciled assignment.'); }
      requireState(!(writable(task, r) || task.dependsOn.some((d) => d.condition === 'integrated_code')) || sameRevision(a.sourceRevision, r.acceptedRevision ?? r.baseline), 'Code attempt must start from the accepted revision containing dependencies.');
      requireState(!r.providerRestrictions.allowedProviderIds || r.providerRestrictions.allowedProviderIds.includes(a.preset.model.provider), 'Provider is not permitted for this Mission.');
      requireState(!r.providerRestrictions.allowedConnectionIds || r.providerRestrictions.allowedConnectionIds.includes(a.preset.model.connectionId ?? a.preset.model.provider), 'Connection is not permitted for this Mission.');
      const failed = r.attempts.filter((old) => old.taskId === task.id && old.outcome === 'failed');
      if (failed.length >= r.config.limits.maxTaskAttemptsBeforeLeadDiagnosis) requireState(task.diagnosis?.afterAttempt === failed.at(-1)?.id, 'Repeated failures require lead diagnosis of the latest failed attempt.');
      if (a.profile) requireState(r.attempts.filter((old) => active(old) && !!old.profile).length < r.config.limits.maxConcurrentWorkersPerMission, 'Mission worker concurrency limit reached.');
      r.attempts.push(a); task.currentAttemptId = a.id; task.status = 'running'; delete task.reason; break;
    }
    case 'host.attempt.transition': {
      const a = lookup(r.attempts, m.attemptId, 'attempt'); requireState(a.status === m.expectedStatus && active(a), 'Stale attempt transition.');
      const next: Record<MissionAttempt['status'], MissionAttempt['status'][]> = { created: ['starting', 'terminal'], starting: ['running', 'terminal'], running: ['settling', 'terminal'], settling: ['terminal'], terminal: [] };
      requireState(next[a.status].includes(m.status), 'Invalid attempt transition.'); a.status = m.status;
      if (m.status === 'terminal') {
        requireState(!!m.outcome && (m.outcome !== 'submitted' || !!m.terminalTurnId && a.result?.status === 'candidate'), 'Terminal submission requires a result and terminal turn observation.');
        a.outcome = m.outcome; a.endedAt = m.at; if (m.terminalTurnId) a.terminalTurnId = m.terminalTurnId; if (m.failure) a.failure = m.failure;
        const task = lookup(r.tasks, a.taskId, 'task'); if (currentResult(task, a)) { task.status = m.outcome === 'submitted' ? 'candidate_ready' : m.outcome === 'failed' ? 'failed' : 'changes_requested'; }
      } else requireState(!m.outcome && !m.terminalTurnId && !m.failure, 'Nonterminal transition cannot carry terminal facts.'); break;
    }
    case 'host.attempt.repair': { const a = lookup(r.attempts, m.attemptId, 'attempt'); admit(r); requireState(a.status === 'running' && !a.result && a.repairTurns === 0, 'Only one bounded result-format repair is allowed.'); a.repairTurns++; break; }
    case 'host.candidate.capture':
      requireState(!m.candidate.integratedRevision, 'Captured candidate cannot claim integration.'); appendImmutable(r.candidates, m.candidate, 'candidate'); break;
    case 'host.evidence.capture': appendImmutable(r.evidence, m.evidence, 'evidence'); break;
    case 'host.review.capture': appendImmutable(r.reviews, m.review, 'review'); break;
    case 'host.integration.promote': {
      admit(r); requireState(r.phase === 'executing' || r.phase === 'verifying', 'Integration is not admitted in this phase.'); requireState(sameRevision(r.acceptedRevision, m.expectedAcceptedRevision), 'Accepted revision compare-and-swap failed.');
      const c = lookup(r.candidates, m.candidateId, 'candidate'); const task = lookup(r.tasks, c.taskId, 'task'); const a = lookup(r.attempts, c.attemptId, 'attempt');
      requireState(task.status === 'accepted' && currentResult(task, a) && !c.integratedRevision, 'Candidate is stale, unaccepted, or already integrated.');
      const scopeIssue = candidateScopeIssue(task, c, r.plan.exclusions); requireState(!scopeIssue, scopeIssue!);
      requireState(!r.deliveryPolicy.requireIndependentReview || !c.changedPaths.length || r.reviews.some((review) => reviewPasses(r, review, c)), 'Independent review is required before promotion.');
      requireState(r.deliveryPolicy.checks.filter((check) => check.required).every((check) => r.evidence.some((e) => e.checkId === check.id && evidencePasses(r, e, m.revision))), 'Integrated checks must pass on the promoted content.');
      r.acceptedRevision = m.revision; c.integratedRevision = m.revision; task.status = 'integrated'; delete r.delivery;
      for (const e of r.evidence) if (!sameContent(e.sourceRevision, m.revision)) e.invalidatedBy ??= 'Accepted content advanced.'; break;
    }
    case 'host.target.promote': {
      if (r.status !== 'recovering') admit(r);
      requireState(!!r.executionAuthorization && !!r.baseline && r.phase !== 'planning', 'Target integration requires execution authorization.');
      requireState(!r.attempts.some(active), 'Target integration requires settled task attempts.');
      const op = lookup(r.operations, m.operationId, 'target integration operation');
      requireState(op.kind === 'integrate' && op.state === 'in_flight' && op.payload.target === 'approved' && op.payload.observationId === m.observationId, 'Only the recorded host target observation can be promoted.');
      requireState(op.payload.remote === r.deliveryPolicy.remote && op.payload.targetBranch === r.deliveryPolicy.targetBranch && r.deliveryPolicy.endpoint !== 'local_commit', 'Target integration cannot change the approved endpoint.');
      requireState(sameRevision(r.acceptedRevision, m.expectedAcceptedRevision) && m.revision.baseCommitSha === r.baseline.baseCommitSha, 'Target integration compare-and-swap failed or changed the immutable baseline.');
      requireState(r.deliveryPolicy.checks.filter((check) => check.required).every((check) => r.evidence.some((e) => e.checkId === check.id && evidencePasses(r, e, m.revision))), 'Target integration requires passing captured checks on its exact combined content.');
      r.acceptedRevision = m.revision; r.deliveryPolicy.targetHead = m.targetHead; delete r.delivery;
      if (r.phase === 'delivering') r.phase = 'verifying';
      for (const e of r.evidence) if (!sameContent(e.sourceRevision, m.revision)) e.invalidatedBy ??= 'Approved target content advanced.';
      break;
    }
    case 'host.operation.record':
      if (m.operation.kind === 'cleanup') {
        requireState(['paused', 'stopped', 'completed'].includes(r.status), 'Cleanup requires a paused or terminal Mission.'); settled(r, true);
        assertSchema(cleanupPayloadSchema, m.operation.payload);
        requireState(m.operation.payload.workspaceIds.every((workspaceId) => lookup(r.workspaces, workspaceId, 'cleanup workspace').cleanedAt === undefined), 'Cleanup cannot remove an already cleaned workspace.');
      } else if (m.operation.kind === 'capture' && ['waiting_for_user', 'awaiting_execution_approval'].includes(r.status)) {
        // Retain already-produced work while human input closes new dispatch admission. This is
        // an observed terminal attempt's capture, never permission to start another writer/check.
        requireState(r.attempts.some((a) => a.id === m.operation.payload.attemptId && a.workspaceId === m.operation.payload.workspaceId && a.status === 'terminal' && a.outcome === 'submitted'), 'Waiting-state capture must retain an owned submitted attempt.');
      } else if (m.operation.kind !== 'interrupt') admit(r);
      requireState(m.operation.state === 'intent_recorded' && m.operation.expectedRevision === r.revision && !m.operation.resultRef && !m.operation.error, 'Operation intent must precede side effects at the current revision.');
      requireState(!r.operations.some((o) => o.id !== m.operation.id && o.idempotencyKey === m.operation.idempotencyKey), 'Operation idempotency key already exists.');
      if (['integrate', 'deliver'].includes(m.operation.kind)) requireState(r.executionAuthorization && r.baseline && r.phase !== 'planning', 'Mutating operation is not authorized.');
      appendImmutable(r.operations, m.operation, 'operation'); break;
    case 'host.operation.transition': {
      const op = lookup(r.operations, m.operationId, 'operation'); requireState(op.state === m.expectedState && pending(op), 'Stale operation transition.');
      const allowed: Record<MissionOperation['state'], MissionOperation['state'][]> = { intent_recorded: ['in_flight', 'reconciling', 'failed'], in_flight: ['reconciling', 'succeeded', 'failed'], reconciling: ['succeeded', 'failed'], succeeded: [], failed: [] };
      requireState(allowed[op.state].includes(m.state), 'Invalid operation transition.'); requireState(m.state !== 'failed' || !!m.error, 'Failed operation needs a diagnostic.'); op.state = m.state; if (m.resultRef) op.resultRef = m.resultRef; if (m.error) op.error = m.error; break;
    }
    case 'host.delivery.record':
      requireState(r.phase === 'delivering' && r.status === 'running' && sameContent(m.delivery.revision, r.acceptedRevision) && m.delivery.endpoint === r.deliveryPolicy.endpoint
        && (!r.deliveryPolicy.targetHead || m.delivery.expectedTargetHead === r.deliveryPolicy.targetHead), 'Delivery is not bound to the active final revision/policy.');
      requireState(!r.delivery || !['delivered', 'held'].includes(r.delivery.status) || isDeepStrictEqual(r.delivery, m.delivery), 'Confirmed delivery is immutable.'); r.delivery = m.delivery; break;
    case 'host.blocker.add': appendImmutable(r.blockers, m.blocker, 'blocker'); break;
    case 'host.blocker.resolve': { const b = lookup(r.blockers, m.blockerId, 'blocker'); requireState(b.resolvedAt === undefined, 'Blocker already resolved.'); b.resolvedAt = m.at; break; }
    case 'host.mailbox.append': appendImmutable(r.mailbox, m.item, 'mailbox item'); break;
    case 'host.recover':
      r.leadGeneration++; r.status = 'recovering'; for (const op of r.operations) if (pending(op)) op.state = 'reconciling';
      if (!r.attempts.some(active) && !r.operations.some(pending)) r.status = 'paused'; break;
    case 'host.quiesce':
      requireState(['pausing', 'stopping', 'recovering'].includes(r.status), 'No pause/stop/recovery is being reconciled.'); settled(r, m.quiescent); r.status = r.status === 'stopping' ? 'stopped' : 'paused'; break;
    case 'host.complete': {
      requireState(r.status === 'running' && r.phase === 'delivering', 'Completion requires the delivery phase.');
      const blockers = completionBlockers(r, { quiescent: m.quiescent }); requireState(!blockers.length, blockers.join(' '));
      r.completionReport = buildMissionCompletionReport(r);
      r.phase = 'done'; r.status = 'completed'; break;
    }
  }
  assertMissionRecord(r);
  return r;
}
