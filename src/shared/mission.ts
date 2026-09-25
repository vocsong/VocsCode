/** Mission control-plane contracts. SessionManager still owns each harness and its usage ledger. */
import type { ExecutionPreset, MissionConfig, MissionProviderRestrictions, TierId } from './mission-config';
import type { ImageAttachment, PermissionMode, TranscriptItem, UsageTotals } from './types';

export type MissionMode = 'interactive_plan' | 'autonomous';
export type MissionPhase = 'planning' | 'executing' | 'verifying' | 'delivering' | 'done';
export type MissionStatus = 'created' | 'running' | 'waiting_for_user' | 'awaiting_execution_approval' | 'pausing' | 'paused' | 'recovering' | 'blocked' | 'stopping' | 'stopped' | 'completed' | 'failed';
export type MissionFailureKind = 'requirements' | 'implementation' | 'protocol' | 'environment' | 'provider' | 'rate_limit' | 'permission' | 'stale_state' | 'integration' | 'verification' | 'persistence' | 'unknown';

/** Diagnosis is not success evidence or permission to retry. Legacy records may lack provenance. */
export interface MissionFailure {
  kind: MissionFailureKind;
  message: string;
  code?: string;
  source?: 'turn' | 'dispatch' | 'error' | 'status' | 'backoff' | 'tool' | 'approval' | 'preset';
  confidence?: 'observed' | 'heuristic' | 'unknown';
  eventId?: string;
  recovery?: 'lead_diagnosis' | 'same_preset_after_backoff' | 'user_action';
}
export type MissionRole = 'lead' | 'worker';

/** Host-only metadata; never accepted through generic sessions:create/patch. */
export interface MissionOwnership {
  missionId: string;
  role: MissionRole;
  generation: number;
  attemptId?: string;
  sourceAccess: 'read_only' | 'assigned_workspace';
  requestedTools: string[];
  /** Exact genuine-user mailbox question; grants answer-only access, never execution. */
  questionId?: string;
  /** Prevent the app-wide effort preference overriding a preset's runtime Default. */
  reasoningDefault: boolean;
}

export interface MissionAuthorization {
  kind: 'autonomous_launch' | 'approved_plan';
  sourceUserActionId: string;
  specificationRevision: number;
  recordedAt: number;
}

export interface MissionCriterion {
  id: string;
  description: string;
  required: boolean;
  evidenceKinds: Array<'test' | 'build' | 'review' | 'behavior' | 'delivery'>;
}

export interface MissionAssumption {
  id: string;
  description: string;
  rationale: string;
  source: string;
  affectedTaskIds: string[];
  criterionIds: string[];
  status: 'assumed' | 'confirmed' | 'superseded' | 'rejected';
}

export interface MissionDecision {
  id: string;
  question: string;
  evidenceIds: string[];
  proposedResolution?: string;
  resolution?: string;
  rationale?: string;
  affectedTaskIds: string[];
  requestedBy: string;
}

export interface MissionPlan {
  objective: string;
  scope: string;
  exclusions: string[];
  behavior: string;
  integrationPoints: string[];
  verificationApproach: string;
  criteria: MissionCriterion[];
  assumptions: MissionAssumption[];
}

export interface MissionQuestion {
  id: string;
  text: string;
  /** Defaults to clarification; exceptional input never grants execution or tool authority. */
  purpose?: 'clarification' | 'authorization' | 'blocker';
  answer?: string;
  sourceUserActionId?: string;
}

export interface MissionProposal {
  id: string;
  specificationRevision: number;
  planRevision: number;
  assistantMessageId: string;
  requestedAt: number;
}

export interface MissionProfile {
  id: string;
  revision: number;
  name: string;
  purpose: string;
  instructions: string;
  tierId: TierId;
  contextRefs: string[];
  requestedTools: string[];
  sourceAccess: 'read_only' | 'assigned_workspace';
  resultExpectations: string;
}

/** Tree identity includes binary files/modes. No intermediate commit is required. */
export interface MissionCodeRevision {
  baseCommitSha: string;
  contentHash: string;
  artifactId?: string;
}

export interface MissionTask {
  id: string;
  revision: number;
  specificationRevision: number;
  objective: string;
  scope: string;
  /** Relative paths/globs are scope hints; the integration service checks actual captured paths. */
  ownedPaths: string[];
  exclusions: string[];
  dependsOn: Array<{ taskId: string; condition: 'accepted_artifact' | 'integrated_code' }>;
  decisionRefs: string[];
  sharedContracts: string[];
  requiredTools: string[];
  criteria: MissionCriterion[];
  verificationIds: string[];
  assignment: { kind: 'lead' } | { kind: 'worker'; profileId: string; profileRevision: number };
  status: 'planned' | 'ready' | 'running' | 'candidate_ready' | 'changes_requested' | 'accepted' | 'integrated' | 'blocked' | 'failed' | 'canceled' | 'superseded';
  currentAttemptId?: string;
  required: boolean;
  reason?: string;
  diagnosis?: { afterAttempt: string; approach: string };
}

export interface MissionAttempt {
  id: string;
  taskId: string;
  taskRevision: number;
  specificationRevision: number;
  generation: number;
  sessionId: string;
  profile?: MissionProfile;
  tierId: TierId;
  preset: ExecutionPreset;
  selectionReason: string;
  sourceRevision: MissionCodeRevision;
  workspaceId: string;
  continuationOwner: 'mission';
  status: 'created' | 'starting' | 'running' | 'settling' | 'terminal';
  outcome?: 'submitted' | 'partial' | 'failed' | 'interrupted' | 'canceled';
  /** Terminal turn observation is required in addition to a structured result. */
  terminalTurnId?: string;
  result?: MissionResult;
  repairTurns: number;
  requestedAt: number;
  endedAt?: number;
  failure?: MissionFailure;
  effectiveModel?: { provider: string; model: string };
  effectiveEffort?: string;
}

export interface MissionResult {
  taskId: string;
  taskRevision: number;
  attemptId: string;
  specificationRevision: number;
  status: 'candidate' | 'blocked' | 'partial' | 'failed';
  summary: string;
  artifactIds: string[];
  evidenceIds: string[];
  decisionIds: string[];
  unresolved: Array<{ description: string; blocking: boolean }>;
}

export interface MissionCandidate {
  id: string;
  attemptId: string;
  taskId: string;
  taskRevision: number;
  specificationRevision: number;
  sourceRevision: MissionCodeRevision;
  revision: MissionCodeRevision;
  changedPaths: string[];
  capturedAt: number;
  integratedRevision?: MissionCodeRevision;
}

export interface MissionCheck {
  id: string;
  name: string;
  kind: 'test' | 'build' | 'behavior';
  command: string;
  criterionIds: string[];
  required: boolean;
  heavy: boolean;
  /** Tests need a machine-readable count, not a guessed line of model prose. */
  testReport?: { format: 'vitest-json' | 'node-tap'; path?: string; minimumTests: number; maximumSkipped: number };
  timeoutMs: number;
}

export interface MissionEvidence {
  id: string;
  criterionIds: string[];
  specificationRevision: number;
  taskId?: string;
  taskRevision?: number;
  attemptId?: string;
  sourceRevision: MissionCodeRevision;
  checkId: string;
  kind: MissionCriterion['evidenceKinds'][number];
  commandOrFlow: string;
  cwd: string;
  environmentRef: string;
  provenance: 'host_executed' | 'verified_runtime' | 'agent_claim';
  result: 'not_run' | 'passed' | 'failed' | 'skipped' | 'blocked' | 'not_applicable' | 'waived';
  exitCode?: number;
  executedTests?: number;
  skippedTests?: number;
  /** Host digest of substantive output, excluding per-run receipt IDs, paths and timings. */
  outcomeHash?: string;
  /** Typed host observation; a user denial is not an implementation failure. */
  failure?: MissionFailure;
  artifactIds: string[];
  startedAt: number;
  endedAt?: number;
  invalidatedBy?: string;
  exception?: { sourceUserActionId: string; reason: string };
}

export interface MissionReview {
  id: string;
  candidateId: string;
  reviewerAttemptId: string;
  sourceRevision: MissionCodeRevision;
  criterionIds: string[];
  findings: Array<{
    id: string;
    severity: 'critical' | 'major' | 'minor' | 'info';
    description: string;
    evidenceIds: string[];
    criterionIds: string[];
    reproduction: string;
    resolution?: { kind: 'fixed' | 'rejected'; reason: string; evidenceIds: string[] };
  }>;
  submittedAt: number;
}

export interface MissionDeliveryPolicy {
  endpoint: 'local_commit' | 'open_pr' | 'merge_pr' | 'custom';
  targetBranch?: string;
  remote?: string;
  /** Observed remote target at policy resolution; a later change requires fresh integration. */
  targetHead?: string;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
  checks: MissionCheck[];
  requireIndependentReview: boolean;
  allowPush: boolean;
  allowMerge: boolean;
  holdConditions: string[];
  /** A hold only satisfies delivery if this explicit policy says so. */
  holdIsEndpoint: boolean;
  provenance: Array<{ source: string; text: string }>;
  fallback: boolean;
  conflicts: string[];
}

/** Host-stamped genuine user reductions, retained separately from reread repository policy.
 * Append-only: no model operation or later policy resolution can lift this ceiling. */
export interface MissionPublicationRestriction {
  endpoint: 'local_commit' | 'open_pr';
  previousEndpoint: 'open_pr' | 'merge_pr';
  sourceUserActionId: string;
  receivedRevision: number;
  recordedAt: number;
  /** A narrowing request cannot undo effects already admitted at an external boundary. */
  priorRemoteOperationIds: string[];
}

export interface MissionDelivery {
  operationId: string;
  revision: MissionCodeRevision;
  endpoint: MissionDeliveryPolicy['endpoint'];
  status: 'pending' | 'blocked' | 'delivered' | 'held';
  expectedTargetHead?: string;
  commitSha?: string;
  pullRequestUrl?: string;
  mergedCommitSha?: string;
  reason?: string;
  completedAt?: number;
}

/** Host-built, immutable completion snapshot. Model narrative never supplies these facts. */
export interface MissionCompletionReport {
  schemaVersion: 1;
  objective: string;
  specificationRevision: number;
  planRevision: number;
  acceptedRevision: MissionCodeRevision;
  completedAt: number;
  delivery: MissionDelivery;
  deliveryPolicy: Pick<MissionDeliveryPolicy, 'holdConditions' | 'holdIsEndpoint' | 'fallback'>;
  tasks: { required: number; satisfiedRequired: number; total: number; satisfied: number; canceled: number; superseded: number };
  checks: Array<{
    check: MissionCheck;
    /** Latest applicable host observation only; absent means not run, never a model claim. */
    evidence?: MissionEvidence;
    verified: boolean;
  }>;
  review: {
    required: boolean;
    integratedCandidates: number;
    independentlyReviewedCandidates: number;
    /** Authenticated, settled, exact-candidate reviews; not fabricated test evidence. */
    reviews: MissionReview[];
  };
  exclusions: string[];
  assumptions: MissionAssumption[];
  decisions: MissionDecision[];
  limitations: Array<{ taskId: string; description: string }>;
  /** Explicitly separate, unverified lead prose, with no invented assistant-message identity. */
  narrative?: { sessionId: string; text: string };
}

export interface MissionOperation {
  id: string;
  idempotencyKey: string;
  kind: 'dispatch' | 'interrupt' | 'capture' | 'verify' | 'integrate' | 'deliver' | 'cleanup';
  expectedRevision: number;
  actor: string;
  state: 'intent_recorded' | 'in_flight' | 'reconciling' | 'succeeded' | 'failed';
  /** Immutable request/receipt, not an executable arbitrary path. */
  payload: Record<string, unknown>;
  resultRef?: string;
  error?: string;
}

/** Answer turns are separate from completed execution, but still own capacity and usage. */
export function isMissionQuestionOperation(operation: MissionOperation): boolean {
  return operation.kind === 'dispatch' && typeof operation.payload.questionId === 'string';
}

/** Post-completion totals are deltas per answer, not extra execution turns. Null/missing
 * telemetry stays unknown; zero cost is not proof of free or subscription-billed work. */
export function missionQuestionUsage(record: MissionRecord): { tokens: number; costUsd: number; questions: number; pending: boolean; unknown: boolean } {
  const answers = record.operations.filter(isMissionQuestionOperation);
  let tokens = 0, costUsd = 0, unknown = false;
  for (const answer of answers) {
    if (answer.payload.dispatchStartedAt === undefined) continue;
    const usage = answer.payload.answerUsage as { tokens?: unknown; costUsd?: unknown } | null | undefined;
    if (typeof usage?.tokens === 'number' && Number.isFinite(usage.tokens) && usage.tokens > 0) tokens += usage.tokens; else unknown = true;
    if (typeof usage?.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd > 0) costUsd += usage.costUsd; else unknown = true;
  }
  return { tokens, costUsd, questions: answers.length, pending: answers.some((answer) => !['succeeded', 'failed'].includes(answer.state)), unknown };
}

/** A retained user instruction is evidence for one lead interpretation, never execution/tool authority. */
export interface MissionUserAction {
  kind: 'instruction' | 'answer' | 'authorization' | 'question';
  receivedRevision: number;
  specificationRevision: number;
  planRevision: number;
  requestFingerprint: string;
  questionId?: string;
  /** Host-stamped only inside the serialized material-update transaction. */
  materialBinding?: { revision: number; operationId: string; sessionId: string; generation: number };
  appliedPlanRevision?: number;
}

/** Immutable Mission-scoped blob, not a caller-selected path or inline base64 ledger payload. */
export interface MissionAttachmentRef {
  ref: string;
  mimeType: string;
  name?: string;
}

export interface MissionMailboxItem {
  id: string;
  kind: 'user' | 'permission' | 'decision' | 'verification' | 'candidate' | 'progress';
  sessionId: string;
  taskId?: string;
  text: string;
  artifactIds: string[];
  attachments?: MissionAttachmentRef[];
  userAction?: MissionUserAction;
  createdAt: number;
  deliveredAt?: number;
}

export interface MissionWorkspace {
  id: string;
  role: 'lead' | 'worker' | 'integration' | 'verification';
  path: string;
  branch: string;
  base: MissionCodeRevision;
  ownerSessionId?: string;
  capturedRevision?: MissionCodeRevision;
  cleanedAt?: number;
}

export interface MissionRecord {
  schemaVersion: 1;
  id: string;
  revision: number;
  lastEventSequence: number;
  title: string;
  objective: string;
  projectRoot: string;
  sourceCwd: string;
  originSessionId?: string;
  sourceSnapshotId?: string;
  sourceCutoffId?: string;
  sourceUserActionId: string;
  leadSessionId: string;
  leadGeneration: number;
  leadPreset: ExecutionPreset;
  config: MissionConfig;
  providerRestrictions: MissionProviderRestrictions;
  configHistory: MissionConfig[];
  entryMode: MissionMode;
  phase: MissionPhase;
  status: MissionStatus;
  requestedPermissionMode: PermissionMode;
  specificationRevision: number;
  planRevision: number;
  executionAuthorization?: MissionAuthorization;
  pendingProposal?: MissionProposal;
  questions: MissionQuestion[];
  plan: MissionPlan;
  decisions: MissionDecision[];
  profiles: MissionProfile[];
  tasks: MissionTask[];
  attempts: MissionAttempt[];
  candidates: MissionCandidate[];
  evidence: MissionEvidence[];
  reviews: MissionReview[];
  operations: MissionOperation[];
  mailbox: MissionMailboxItem[];
  workspaces: MissionWorkspace[];
  baseline?: MissionCodeRevision;
  acceptedRevision?: MissionCodeRevision;
  deliveryPolicy: MissionDeliveryPolicy;
  publicationRestrictions?: MissionPublicationRestriction[];
  delivery?: MissionDelivery;
  /** Written in the same host transaction as completed; survives receipt recovery and restart. */
  completionReport?: MissionCompletionReport;
  blockers: Array<{ id: string; kind: MissionFailureKind; message: string; resolvedAt?: number }>;
  progress: { completedTurns: number; checkpointsWithoutProgress: number; lastProgressRevision: number };
  createdAt: number;
  updatedAt: number;
  archived?: boolean;
}

export interface MissionSource {
  schemaVersion: 1;
  originSessionId?: string;
  cutoffId?: string;
  submittedCommand: string;
  objective: string;
  items: TranscriptItem[];
  images?: ImageAttachment[];
  capturedAt: number;
}

export interface CreateMissionRequest {
  idempotencyKey: string;
  projectRoot: string;
  originSessionId?: string;
  objective: string;
  mode: MissionMode;
  leadPresetId?: string;
  permissionMode: PermissionMode;
  submittedCommand?: string;
  images?: ImageAttachment[];
}

export interface MissionView {
  record: MissionRecord;
  /** Rollup only; never written back to the lead's ledger. */
  usage: Partial<UsageTotals>;
  billingCoverage: 'reported' | 'partial' | 'unknown';
}

export type MissionUserControl =
  | { action: 'execute'; proposalId: string; specificationRevision: number }
  | { action: 'pause' | 'resume' | 'stop' | 'continue_planning' | 'cleanup' }
  | { action: 'steer'; text: string; images?: ImageAttachment[] }
  | { action: 'replace_lead'; presetId: string }
  | { action: 'narrow_delivery'; endpoint: 'local_commit' | 'open_pr' }
  | { action: 'apply_configuration' };

/** User IPC actions and model tool operations are intentionally different types/transports. */
export interface MissionControlRequest {
  missionId: string;
  idempotencyKey: string;
  expectedRevision: number;
  control: MissionUserControl;
}
