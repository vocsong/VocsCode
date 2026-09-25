/** Mission owns coordination, not harnesses. Every external action follows a durable intent;
 * store callbacks are synchronous and never hold the state queue across harness/Git/check IO. */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { z } from 'zod';
import type {
  CreateMissionRequest, MissionAttachmentRef, MissionAttempt, MissionCodeRevision, MissionControlRequest, MissionDelivery,
  MissionDeliveryPolicy, MissionMailboxItem, MissionOperation, MissionOwnership, MissionRecord, MissionSource,
  MissionView, MissionWorkspace,
} from '../../shared/mission';
import {
  applyMissionProjectOverride, checkMissionPresetAdherence, checkMissionPresetRevocation,
  validatePresetEligibility,
  type ExecutionPreset, type MissionConfig, type MissionPresetCapabilities, type MissionProjectOverride,
} from '../../shared/mission-config';
import { isMissionAffirmative } from '../../shared/mission-command';
import { isMissionQuestionOperation } from '../../shared/mission';
import type { ImageAttachment, SessionConfig, SessionEventEnvelope, SessionMeta, TranscriptItem, UserInput } from '../../shared/types';
import type { SessionManager } from '../session-manager';
import { captureMissionSource, missionKickoff, missionLeadPolicy, missionWorkerBrief, missionWorkerPolicy } from './context';
import { assertMissionMutation, assertMissionRecord, implementationBlockers, missionCompletionReport, readyTasks, reduceMission, type MissionActor, type MissionMutation } from './state';
import { MissionStoreError, type MissionStore } from './store';
import type { CapacityLease, MissionScheduler } from './scheduler';
import { MissionToolBroker, type MissionToolActor, type MissionToolBinding, type MissionToolHost, type MissionToolName, type MissionToolRequest } from './tools';
import type { MissionVerification, VerificationRequest } from './verification';
import type { MissionDeliveryRequest } from './delivery';
import type { MissionBaseline, MissionWorkspaces, MissionWorkspace as GitWorkspace, TargetFetchAuthorization } from './workspaces';
import { budgetUsage, mergeBudgetUsage, missionBudgetIssue, missionBudgetSessions, type MissionBudgetUsage } from './budget';
import { classifyMissionDispatch, classifyMissionTurn, currentMissionFailureOwner, missionFailureNotice, observeMissionTrouble, type MissionTurnTrouble } from './failures';
import { missionMadeProgress, missionProgressSnapshot, verificationRetryIssue, verificationScope } from './progress';

export interface MissionCapabilityPort {
  /** Probe this exact pinned choice, not a generic catalog row or another connection. */
  probe(preset: ExecutionPreset, scope: {
    projectRoot: string; role: 'lead' | 'worker'; permissionMode: SessionConfig['permissionMode'];
    sourceAccess: MissionOwnership['sourceAccess']; requiredTools: string[];
    sessionId: string; generation: number; cwd: string;
  }): Promise<MissionPresetCapabilities>;
}
export interface MissionDeliveryPort {
  resolve(projectRoot: string, scope?: { changedPaths?: string[]; localOnly?: boolean }): Promise<MissionDeliveryPolicy>;
  deliver(request: MissionDeliveryRequest): Promise<MissionDelivery>;
  authorizeTargetFetch?(request: TargetFetchAuthorization): Promise<void>;
  /** Inspect completed/held local or remote receipts only. Partial effects stay undefined;
   * identity conflicts throw. This never grants authority, proves quiescence or replays effects. */
  inspect?(request: MissionDeliveryRequest): Promise<MissionDelivery | undefined>;
}
export interface MissionServiceDeps {
  store: MissionStore<MissionRecord>;
  sessions: SessionManager;
  workspaces: MissionWorkspaces;
  scheduler: MissionScheduler;
  verification: MissionVerification;
  /** Read on every dispatch; settings snapshots are not revocation authority. */
  settings(projectRoot: string): { config: MissionConfig; project?: MissionProjectOverride };
  capabilities: MissionCapabilityPort;
  delivery: MissionDeliveryPort;
  onChange?(view: MissionView): void;
  log?(message: string): void;
  /** Runtime's held-lease admission guard. Rechecked after compaction by beforeDispatch. */
  assertWorkspaceAvailable?(cwd: string): void | Promise<void>;
  /** True while host-owned shells are live, closing or uncertain (not merely producing output). */
  additionalActivity?(record: MissionRecord): boolean;
  stopOwnedTerminals?(record: MissionRecord): Promise<void>;
  /** Bind the already-journaled nonce before startup; never launches a process itself. */
  prepareRuntimeStart?(record: MissionRecord, operation: MissionOperation): Promise<void>;
  /** Positive bounded-owner reconciliation under held admission. Empty maps/PID absence are
   * not proof; unsupported or incomplete ownership stays blocked. */
  reconcileExternalActivity?(record: MissionRecord): Promise<{ quiescent: boolean; receipt?: string; detail?: string }>;
}

type Turn = Extract<TranscriptItem, { kind: 'turn' }>;
type LiveTurn = { operationId: string; lease: CapacityLease; generation: number; terminal?: Turn; trouble?: MissionTurnTrouble; dispatchFailed?: boolean;
  questionId?: string; answerMessageIds?: Set<string>; answerToolIds?: Set<string>; answerTimer?: NodeJS.Timeout };
/** Observed Q&A bounds, not provider billing ceilings. No autonomous retries or continuations. */
const ANSWER_TIMEOUT_MS = 120_000;
// Retained conversation/cache input still counts toward the whole-Mission budget, but must
// not exhaust the answer-output allowance before the model can return its first answer.
const ANSWER_MAX_OUTPUT_TOKENS = 16_000;
const ANSWER_MAX_TOOLS = 32;
const ANSWER_POLICY = 'This Mission is completed. Answer only the current genuine user question in this same conversation, using mission_read and mission_context_read for retained facts. Distinguish captured evidence from claims and unknowns. Do not plan, code, check, delegate, deliver, start a Goal, or change the completed outcome. A request for new implementation is not authorization: explain that the user must explicitly start a linked follow-up with /mission start -- <objective>. Do not start it yourself. End after your answer; do not yield or request another turn.';
const host: MissionActor = { kind: 'host' };
const pending = (o: MissionOperation) => !['succeeded', 'failed'].includes(o.state);
const active = (a: MissionAttempt) => a.status !== 'terminal';
const terminal = (r: MissionRecord) => ['stopped', 'completed', 'failed'].includes(r.status);
const identity = (prefix: string, ...values: unknown[]) => `${prefix}_${createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32)}`;
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const sameRevision = (a: MissionCodeRevision, b: MissionCodeRevision) => a.baseCommitSha === b.baseCommitSha && a.contentHash === b.contentHash;
const actorKey = (actor: MissionActor) => actor.kind === 'user' ? `user:${actor.actionId}` : actor.kind === 'host' ? 'host' : `${actor.kind}:${actor.sessionId}:${actor.generation}`;
const text = z.string().trim().min(1).max(100_000);
const key = z.string().min(1).max(200);
const createSchema = z.strictObject({
  idempotencyKey: key, projectRoot: text, originSessionId: key.optional(), objective: text,
  mode: z.enum(['interactive_plan', 'autonomous']), leadPresetId: key.optional(),
  permissionMode: z.enum(['ask', 'accept-edits', 'plan', 'auto', 'full-auto']), submittedCommand: text.optional(),
  images: z.array(z.unknown()).max(100).optional(),
});
const userImageSchema = z.strictObject({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']),
  data: z.string().min(1).max(24 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/), name: z.string().min(1).max(100_000).refine((value) => !!value.trim() && !value.includes('\0')).optional() });
const priority: Record<MissionMailboxItem['kind'], number> = { user: 0, permission: 1, decision: 2, verification: 3, candidate: 4, progress: 5 };

/** Intersect repository policy with an irrevocable user ceiling; never manufacture a grant. */
function restrictPublication(policy: MissionDeliveryPolicy, endpoint: 'local_commit' | 'open_pr' | undefined): MissionDeliveryPolicy {
  if (!endpoint || policy.endpoint === 'custom') return policy;
  const narrowed = policy.endpoint === 'local_commit' || endpoint === 'local_commit' ? 'local_commit' : 'open_pr';
  return { ...policy, endpoint: narrowed, allowPush: policy.allowPush && narrowed !== 'local_commit', allowMerge: false };
}

export class MissionService implements MissionToolHost {
  readonly broker: MissionToolBroker;
  readonly toolHost: MissionToolHost = this;
  private readonly detach: Array<() => void>;
  private readonly turns = new Map<string, LiveTurn>();
  private readonly budgetObservations = new Map<string, MissionBudgetUsage>();
  private readonly fenced = new Set<string>();
  private readonly externalUncertainty = new Set<string>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly reconciliations = new Map<string, Promise<void>>();
  private readonly launching = new Map<string, { request: CreateMissionRequest; promise: Promise<MissionRecord> }>();
  private readonly maintenance = new Map<string, { request: MissionControlRequest; promise: Promise<MissionRecord> }>();
  private readonly userInputs = new Map<string, { request: MissionControlRequest; fingerprint: string; attachments: MissionAttachmentRef[]; promise?: Promise<MissionRecord> }>();
  private readonly pumping = new Set<string>();
  private readonly pumpRuns = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private readonly yielded = new Set<string>();
  private readonly workspaceWaiters = new Map<string, Set<{ missionId: string; resolve(): void; reject(error: Error): void }>>();
  private closed = false;

  constructor(private readonly deps: MissionServiceDeps) {
    this.broker = new MissionToolBroker(this);
    this.detach = [deps.sessions.attachMissionHooks({
      beforeDispatch: (meta) => this.beforeDispatch(meta),
      mcpServers: async (meta, existing) => {
        const binding = this.binding(meta);
        await this.validate(binding);
        await this.broker.start();
        return [...(binding.questionId ? [] : existing.filter((s) => s.def.id !== 'vocs-mission')), this.broker.attach(binding)];
      },
    }), deps.sessions.subscribe((env) => this.onEvent(env))];
  }

  get(id: string): MissionRecord | undefined {
    const record = this.deps.store.get(id);
    return record && this.reportView(record);
  }
  list(): MissionRecord[] { return this.deps.store.list().map((record) => this.reportView(record)); }
  /** Legacy completed journals derive exactly the same host facts, without replay or mutation. */
  private reportView(record: MissionRecord): MissionRecord {
    if (record.status === 'completed' && !record.completionReport) record.completionReport = missionCompletionReport(record);
    return record;
  }
  view(id: string): MissionView | undefined {
    const record = this.get(id);
    if (!record) return undefined;
    const sessions = this.deps.sessions.list().filter((s) => s.mission?.missionId === id);
    const usage: MissionView['usage'] = {};
    for (const session of sessions) for (const [name, value] of Object.entries(session.usage)) {
      if (typeof value === 'number') { const field = name as keyof typeof usage; usage[field] = (usage[field] ?? 0) + value; }
    }
    return { record, usage, billingCoverage: sessions.length ? 'partial' : 'unknown' };
  }
  private record(id: string): MissionRecord {
    const r = this.deps.store.get(id);
    if (!r) throw new Error('Mission not found.');
    return r;
  }
  private publish(id: string): void { try { const view = this.view(id); if (view) this.deps.onChange?.(view); } catch (e) { this.deps.log?.(message(e)); } }

  /** Boot never replays external mutations. Unknown effects remain explicit reconciliation blockers. */
  async load(): Promise<MissionRecord[]> {
    await this.broker.start();
    await this.deps.store.load();
    for (const old of this.deps.store.list()) {
      if (old.status === 'completed' && !old.completionReport) {
        await this.change(old.id, 'completion-report-v1', (record) => ({ ...record, completionReport: missionCompletionReport(record) }));
      }
      if (terminal(old)) {
        for (const operation of old.operations.filter((op) => op.kind === 'cleanup' && pending(op))) await this.opState(old.id, operation.id, 'failed', 'Cleanup acknowledgment was lost during restart. Retained per-workspace receipts remain authoritative; no removal was replayed.');
        // Completion of model input does not prove an idle runtime/terminal descendant stopped.
        // Preserve the final outcome, but fence cleanup if its previous host lost ownership.
        if (this.deps.reconcileExternalActivity) {
          this.fenced.add(old.id); this.externalUncertainty.add(old.id);
          let observation: Awaited<ReturnType<NonNullable<MissionServiceDeps['reconcileExternalActivity']>>>;
          try { observation = await this.deps.reconcileExternalActivity(old); }
          catch (error) { observation = { quiescent: false, detail: message(error) }; }
          if (observation.quiescent && observation.receipt?.trim()) {
            await this.change(old.id, `terminal-ownership-${old.revision}`, (r) => {
              for (const op of r.operations.filter((o) => o.kind === 'dispatch' || o.kind === 'verify')) op.payload.externalQuiescenceReceipt = observation.receipt;
              for (const blocker of r.blockers.filter((b) => b.id.startsWith('external_') && b.resolvedAt === undefined)) blocker.resolvedAt = Date.now();
              return r;
            });
            this.externalUncertainty.delete(old.id);
          } else await this.block(old.id, 'environment', `Final Mission ownership remains uncertain; cleanup requires exact durable bounded-owner receipts. ${observation.detail ?? ''}`.trim(), 'external');
        }
        const answer = old.operations.find((op) => isMissionQuestionOperation(op) && pending(op));
        if (answer) {
          // No automatic replay, even if startup had not acknowledged a prompt. A prior host
          // may have crossed the boundary; only exact ownership inspection can release it.
          if (!this.deps.reconcileExternalActivity && answer.payload.runtimeStartRequestedAt !== undefined) this.externalUncertainty.add(old.id);
          this.fenced.add(old.id);
          if (this.externalUncertainty.has(old.id)) {
            if (!this.turns.has(old.leadSessionId)) {
              const lease = this.deps.scheduler.retainUnknownLead({ missionId: old.id, ownerId: answer.id, accountId: old.leadPreset.model.connectionId ?? old.leadPreset.model.provider }, old.config.limits.maxConcurrentWorkersPerMission);
              this.turns.set(old.leadSessionId, { operationId: answer.id, lease, generation: old.leadGeneration, questionId: String(answer.payload.questionId), answerMessageIds: new Set(), answerToolIds: new Set() });
            }
            await this.change(old.id, `${answer.id}-answer-restart-uncertain`, (r) => { const op = r.operations.find((entry) => entry.id === answer.id)!; op.state = 'reconciling'; op.error = 'Answer interrupted by restart; ownership remains uncertain. Cancel/reconcile before asking again. No prompt was replayed.'; return r; });
          } else await this.endQuestion(old.id, 'Answer interrupted by restart. Ask again explicitly; no prompt was replayed.');
        }
        continue;
      }
      this.fenced.add(old.id);
      this.deps.scheduler.pause(old.id);
      this.broker.revoke(old.id);
      if (this.deps.reconcileExternalActivity || old.blockers.some((blocker) => blocker.id.startsWith('external_') && blocker.resolvedAt === undefined)
        || this.deps.additionalActivity?.(old)
        || old.operations.some((op) => pending(op) && (op.kind === 'verify' && op.state !== 'intent_recorded'
          || op.kind === 'dispatch' && !op.payload.infrastructure && (op.payload.dispatchStartedAt !== undefined || op.payload.runtimeStartRequestedAt !== undefined || op.state !== 'intent_recorded' && op.payload.dispatchStage !== 'preparing')))) {
        this.externalUncertainty.add(old.id);
        // At least the lead scheduling reservation remains unavailable. Unknown writers keep
        // their workspace ownership even if the new host cannot reconstruct exact worker slots.
        this.deps.scheduler.register(old.id, old.config.limits.maxConcurrentWorkersPerMission);
        this.deps.scheduler.pause(old.id);
      }
      await this.change(old.id, `recover-${old.revision}`, (r) => reduceMission(r, host, { kind: 'host.recover' }));
      if (this.record(old.id).status === 'paused' && this.externalUncertainty.has(old.id)) await this.change(old.id, `recover-ownership-${old.revision}`, (r) => { r.status = 'recovering'; return r; });
      if (this.record(old.id).status !== 'paused') await this.reconcile(old.id, true);
      else await this.reconcileResources(old.id);
    }
    return this.list();
  }

  async create(input: CreateMissionRequest): Promise<MissionRecord> {
    createSchema.parse(input);
    if (input.images) z.array(userImageSchema).max(100).parse(input.images);
    if (!path.isAbsolute(input.projectRoot)) throw new Error('Choose an absolute project root.');
    const request = structuredClone(input);
    const id = identity('m', request.idempotencyKey);
    const flight = this.launching.get(id);
    if (flight) {
      if (!isDeepStrictEqual(flight.request, request)) throw new Error('Launch idempotency key was reused for a different request.');
      return flight.promise;
    }
    const promise = this.createOnce(id, request);
    this.launching.set(id, { request, promise });
    try { return await promise; } finally { this.launching.delete(id); }
  }

  private async createOnce(id: string, request: CreateMissionRequest): Promise<MissionRecord> {
    if (this.closed) throw new Error('Mission service is closed.');
    const existing = this.deps.store.get(id);
    // The immutable source owns the image bytes (up to 64 MiB). Journal request metadata is
    // bounded at 16 MiB: bind exact ordered bytes/name/type by digest instead of embedding
    // base64 again. This remains retry authority even after the source discussion changes.
    const retainedRequest = { ...request, images: request.images?.map(({ data, ...metadata }) => ({ ...metadata, sha256: createHash('sha256').update(data).digest('hex') })) };
    const metadata = { idempotencyKey: 'launch', actor: 'user', expectedRevision: 0, kind: 'mission.create', request: retainedRequest };
    if (existing) { await this.deps.store.create(existing, metadata); return this.get(id)!; }
    const origin = request.originSessionId ? this.deps.sessions.get(request.originSessionId) : undefined;
    if (request.originSessionId && !origin) throw new Error('The source session no longer exists.');
    if (origin && path.resolve(origin.config.projectRoot) !== path.resolve(request.projectRoot)) throw new Error('Source session belongs to a different project.');
    const source = captureMissionSource({
      originSessionId: origin?.id, submittedCommand: request.submittedCommand ?? `/mission ${request.mode === 'interactive_plan' ? 'plan ' : ''}${request.objective}`,
      objective: request.objective, items: origin ? await this.deps.sessions.transcript(origin.id) : [], images: request.images, capturedAt: Date.now(),
    });
    const settings = this.deps.settings(request.projectRoot);
    const config = applyMissionProjectOverride(settings.config, settings.project);
    const leadPreset = config.presets.find((p) => p.id === (request.leadPresetId ?? config.defaultLeadPresetId));
    if (!leadPreset?.enabled || !config.tiers.find((t) => t.id === 5)?.presetIds.includes(leadPreset.id)) throw new Error('Configure an enabled T5 principal-engineer preset before launching a Mission.');
    config.defaultLeadPresetId = leadPreset.id;
    const deliveryPolicy = await this.deps.delivery.resolve(request.projectRoot);
    const now = Date.now();
    const actionId = identity('user', id, 'launch');
    const criteria = [...new Set(deliveryPolicy.checks.flatMap((c) => c.criterionIds))].map((criterionId) => ({
      id: criterionId, description: `Required project verification: ${criterionId}`, required: true,
      evidenceKinds: [...new Set(deliveryPolicy.checks.filter((c) => c.criterionIds.includes(criterionId)).map((c) => c.kind))],
    }));
    const record: MissionRecord = {
      schemaVersion: 1, id, revision: 0, lastEventSequence: 0, title: request.objective.slice(0, 100), objective: request.objective,
      projectRoot: request.projectRoot, sourceCwd: origin?.cwd ?? request.projectRoot, originSessionId: origin?.id, sourceCutoffId: source.cutoffId,
      sourceUserActionId: actionId, leadSessionId: identity('s', id, 'lead'), leadGeneration: 1, leadPreset, config,
      providerRestrictions: { allowedProviderIds: settings.project?.allowedProviderIds && [...settings.project.allowedProviderIds], allowedConnectionIds: settings.project?.allowedConnectionIds && [...settings.project.allowedConnectionIds] },
      configHistory: [], entryMode: request.mode, phase: 'planning', status: 'created', requestedPermissionMode: request.permissionMode,
      specificationRevision: 1, planRevision: 0,
      executionAuthorization: request.mode === 'autonomous' ? { kind: 'autonomous_launch', sourceUserActionId: actionId, specificationRevision: 1, recordedAt: now } : undefined,
      questions: [], plan: { objective: request.objective, scope: request.objective, exclusions: [], behavior: request.objective, integrationPoints: [], verificationApproach: 'Establish behavior-specific evidence and all required project checks.', criteria, assumptions: [] },
      decisions: [], profiles: [], tasks: [], attempts: [], candidates: [], evidence: [], reviews: [], operations: [], mailbox: [], workspaces: [],
      deliveryPolicy, blockers: [], progress: { completedTurns: 0, checkpointsWithoutProgress: 0, lastProgressRevision: 0 }, createdAt: now, updatedAt: now,
    };
    assertMissionRecord(record);
    await this.deps.store.create(record, metadata);
    try {
      const sourceSnapshotId = await this.deps.store.writeSource(id, JSON.stringify(source));
      await this.change(id, 'source-retained', (r) => { r.sourceSnapshotId = sourceSnapshotId; return reduceMission(r, host, { kind: 'host.start' }); });
      this.config(this.record(id), leadPreset, 'read_only', '');
      if (!this.deps.scheduler.register(id, config.limits.maxConcurrentWorkersPerMission)) throw new Error('Global Mission capacity is full; pause another Mission, then resume this one.');
      await this.establishBaseline(id);
      await this.ensureLead(id);
      if (origin) this.deps.sessions.note(origin.id, `Mission created: ${id} (lead session ${record.leadSessionId}). Source discussion retained through ${source.cutoffId ?? 'the empty transcript'}.`);
      await this.mail(id, { id: identity('mail', id, 'kickoff'), kind: 'user', sessionId: record.leadSessionId, text: missionKickoff(this.record(id), source), artifactIds: [], createdAt: now });
      this.wake(id);
    } catch (e) {
      await this.block(id, 'environment', message(e), 'lead_dispatch');
      await this.change(id, 'launch-blocked', (r) => { r.status = 'blocked'; return r; });
      this.fenced.add(id); this.deps.scheduler.pause(id);
    }
    this.publish(id);
    return this.get(id)!;
  }

  private config(r: MissionRecord, preset: ExecutionPreset, sourceAccess: MissionOwnership['sourceAccess'], policy: string): SessionConfig {
    if (preset.runtimeVariantId && preset.harnessId !== 'acp') throw new Error('This runtime variant cannot be represented by the managed-session API. Select an explicitly supported preset.');
    if (preset.model.connectionId && preset.model.connectionId !== preset.model.provider) throw new Error('This separate account routing is not supported by the managed-session API; no billing-path substitution was made.');
    return { harness: preset.harnessId, model: { provider: preset.model.provider, model: preset.model.model },
      effort: preset.reasoning.kind === 'explicit' ? preset.reasoning.value : undefined,
      projectRoot: r.projectRoot, permissionMode: sourceAccess === 'read_only' ? 'plan' : r.requestedPermissionMode,
      acpAgent: preset.runtimeVariantId, appendSystemPrompt: policy };
  }
  /** The journal's last assigned attempt owns the current cwd; array order of retained trees
   * and a possibly stale session index must not choose an earlier lead workspace. */
  private leadWorkspace(r: MissionRecord): MissionWorkspace | undefined {
    const attempt = r.attempts.findLast((a) => a.sessionId === r.leadSessionId && !a.profile);
    const infrastructure = r.operations.findLast((op) => op.payload.leadSessionId === r.leadSessionId && ['baseline', 'lead_handover'].includes(String(op.payload.infrastructure)));
    const workspaceId = attempt?.workspaceId ?? (infrastructure?.payload.infrastructure === 'baseline' ? infrastructure.payload.leadWorkspaceId : infrastructure?.payload.workspaceId);
    if (workspaceId) {
      const workspace = r.workspaces.find((w) => w.id === workspaceId);
      if (!workspace || workspace.role !== 'lead' || workspace.ownerSessionId !== r.leadSessionId || workspace.cleanedAt) throw new Error('Current lead workspace mapping needs reconciliation; retained trees were not reassigned.');
      return workspace;
    }
    const retained = r.workspaces.filter((w) => w.role === 'lead' && w.ownerSessionId === r.leadSessionId && !w.cleanedAt);
    if (retained.length > 1) throw new Error('Multiple retained lead workspaces require an explicit current attempt mapping.');
    return retained[0];
  }
  private async ensureLead(id: string): Promise<void> {
    const r = this.record(id);
    const workspace = this.leadWorkspace(r);
    const ownership: MissionOwnership = { missionId: id, role: 'lead', generation: r.leadGeneration, sourceAccess: 'read_only', requestedTools: [], reasoningDefault: r.leadPreset.reasoning.kind === 'default' };
    const config = this.config(r, r.leadPreset, 'read_only', missionLeadPolicy(r));
    if (!this.deps.sessions.get(r.leadSessionId)) {
      // Lead creation is covered by the retained launch/lead-dispatch intent and preallocated ID.
      await this.deps.sessions.createManaged({ title: r.title, config }, { id: r.leadSessionId, cwd: workspace?.path ?? r.sourceCwd, worktreeBranch: workspace?.branch, ownership });
    }
  }

  private async establishBaseline(id: string): Promise<void> {
    const r = this.record(id);
    if (r.baseline) return;
    if (r.originSessionId && !this.deps.sessions.activity(r.originSessionId).quiescent) {
      await this.block(id, 'environment', 'Source workspace is active. Wait for its writer to settle, then resume or execute; the source session was not interrupted.', 'baseline'); return;
    }
    const probe = await this.deps.workspaces.probeBaseline(r.sourceCwd);
    if (!probe.ok) { await this.block(id, 'environment', `${probe.message}${probe.changes.length ? ` Changes: ${probe.changes.map((c) => c.path).join(', ')}` : ''}`, 'baseline'); return; }
    const opId = identity('op', id, 'baseline', r.revision);
    await this.change(id, `${opId}-intent`, (state) => {
      if (state.phase !== 'planning' || state.attempts.some(active) || this.fenced.has(id)) throw new Error('Baseline provisioning is not currently admitted.');
      state.operations.push({ id: opId, idempotencyKey: opId, kind: 'dispatch', actor: 'host', expectedRevision: state.revision, state: 'intent_recorded', payload: { infrastructure: 'baseline', baseline: probe.baseline, leadSessionId: state.leadSessionId, leadWorkspaceId: identity('w', id, 'lead'), integrationWorkspaceId: identity('w', id, 'integration') } });
      return state;
    });
    await this.opState(id, opId, 'in_flight');
    try {
      const integration = await this.deps.workspaces.provision({ missionId: id, baseline: probe.baseline, role: 'integration', workspaceId: identity('w', id, 'integration') });
      const lead = await this.deps.workspaces.provision({ missionId: id, baseline: probe.baseline, role: 'lead', workspaceId: identity('w', id, 'lead') });
      await this.change(id, `${opId}-baseline`, (state) => {
        state = reduceMission(state, host, { kind: 'host.baseline.set', revision: probe.baseline.revision });
        for (const w of [integration, lead]) state = reduceMission(state, host, { kind: 'host.workspace.register', workspace: this.workspace(w, w.role === 'lead' ? state.leadSessionId : undefined) });
        for (const b of state.blockers.filter((b) => b.id.startsWith('baseline_') && b.resolvedAt === undefined)) state = reduceMission(state, host, { kind: 'host.blocker.resolve', blockerId: b.id, at: Date.now() });
        return state;
      });
      await this.opState(id, opId, 'succeeded');
    } catch (e) { await this.opState(id, opId, 'failed', message(e)); throw e; }
  }
  private workspace(w: GitWorkspace, ownerSessionId?: string): MissionWorkspace {
    return { id: w.id, role: w.role === 'integration-attempt' ? 'verification' : w.role, path: w.cwd, branch: w.branch, base: w.baseRevision, ...(ownerSessionId ? { ownerSessionId } : {}) };
  }
  private baseline(r: MissionRecord): MissionBaseline {
    const value = r.operations.find((o) => o.payload.infrastructure === 'baseline' && o.state === 'succeeded')?.payload.baseline;
    if (!value || !r.baseline) throw new Error('A clean, quiescent source baseline has not been established.');
    return structuredClone(value) as MissionBaseline;
  }

  /** This is the host user transport. Models only receive broker.invoke, never this method. */
  async control(request: MissionControlRequest): Promise<MissionRecord> {
    if (request.control.action === 'narrow_delivery') {
      // A separate strict genuine-user route, not a model mutation or natural-text guess.
      const input = z.strictObject({ missionId: key, idempotencyKey: key, expectedRevision: z.number().int().nonnegative(),
        control: z.strictObject({ action: z.literal('narrow_delivery'), endpoint: z.enum(['local_commit', 'open_pr']) }) }).parse(request);
      const current = this.record(input.missionId), actionId = identity('user', current.id, input.idempotencyKey);
      const prior = current.publicationRestrictions?.find((restriction) => restriction.sourceUserActionId === actionId);
      if (prior) {
        if (prior.endpoint !== input.control.endpoint || prior.receivedRevision !== input.expectedRevision) throw new Error('Publication control idempotency key was reused for a different request.');
        return current;
      }
      if (current.revision !== input.expectedRevision) throw new MissionStoreError('REVISION_CONFLICT', `Expected revision ${input.expectedRevision}; current revision is ${current.revision}`);
      if (current.deliveryPolicy.endpoint !== 'merge_pr' && !(current.deliveryPolicy.endpoint === 'open_pr' && input.control.endpoint === 'local_commit')) throw new Error('Publication controls can only reduce merge to open PR/local commit, or open PR to local commit.');
      return this.controlOnce(input);
    }
    if (request.control.action !== 'steer') return this.controlOnce(request);
    if (this.closed) throw new Error('Mission service is closed.');
    const input = structuredClone(request);
    const control = z.strictObject({ action: z.literal('steer'), text: z.string().max(100_000).refine((value) => !value.includes('\0')), images: z.array(userImageSchema).max(100).optional() })
      .refine((value) => !!value.text.trim() || !!value.images?.length, 'Send an instruction or image.').parse(input.control);
    key.parse(input.idempotencyKey); z.number().int().nonnegative().parse(input.expectedRevision);
    const current = this.record(input.missionId), actionId = identity('user', current.id, input.idempotencyKey);
    const fingerprint = identity('input', control.text, control.images ?? []);
    const prior = current.mailbox.find((item) => item.id === actionId);
    if (prior) {
      if (prior.userAction?.requestFingerprint !== fingerprint || prior.userAction.receivedRevision !== input.expectedRevision) throw new Error('User action idempotency key was reused for a different request.');
      return current;
    }
    const existing = this.userInputs.get(actionId);
    if (existing && !isDeepStrictEqual(existing.request, input)) throw new Error('User action idempotency key was reused for a different request.');
    if (existing?.promise) return existing.promise;
    if (current.revision !== input.expectedRevision) throw new MissionStoreError('REVISION_CONFLICT', `Expected revision ${input.expectedRevision}; current revision is ${current.revision}`, { expectedRevision: input.expectedRevision, currentRevision: current.revision });
    if (terminal(current) && current.status !== 'completed') throw new Error('Stopped Missions cannot receive execution instructions.');
    const entry: { request: MissionControlRequest; fingerprint: string; attachments: MissionAttachmentRef[]; promise?: Promise<MissionRecord> } = existing ?? { request: input, fingerprint, attachments: [] };
    this.userInputs.set(actionId, entry);
    const promise = (async () => {
      // Bind the raw user key and image position, not a content-derived key: changed bytes
      // must conflict even if the host died before committing the mailbox. The receipt also
      // binds the complete instruction/ordered image identity without copying base64 into it.
      const retainedRequest = { text: control.text, images: (control.images ?? []).map(({ data, ...metadata }) => ({ ...metadata, sha256: createHash('sha256').update(data).digest('hex') })) };
      if (!control.images?.length && await this.deps.store.hasArtifactRetention(current.id, JSON.stringify(['user-image', input.idempotencyKey, 0]))) throw new MissionStoreError('IDEMPOTENCY_CONFLICT', 'User action idempotency key was already used for a different request with attachments.');
      for (let index = entry.attachments.length; index < (control.images?.length ?? 0); index++) {
        const image = control.images![index];
        const ref = await this.deps.store.retainArtifact(current.id, JSON.stringify(['user-image', input.idempotencyKey, index]), JSON.stringify(image), retainedRequest);
        entry.attachments.push({ ref, mimeType: image.mimeType, ...(image.name === undefined ? {} : { name: image.name }) });
      }
      return this.controlOnce(input, { fingerprint, attachments: entry.attachments });
    })();
    entry.promise = promise;
    try { const result = await promise; this.userInputs.delete(actionId); return result; }
    catch (error) {
      // A conflicting retry after restart must not poison the in-memory slot for the
      // original request: the immutable store receipt remains the authority.
      if (error instanceof MissionStoreError && error.code === 'IDEMPOTENCY_CONFLICT') this.userInputs.delete(actionId);
      throw error;
    } finally { entry.promise = undefined; }
  }

  private async controlOnce(request: MissionControlRequest, retained?: { fingerprint: string; attachments: MissionAttachmentRef[] }): Promise<MissionRecord> {
    if (this.closed) throw new Error('Mission service is closed.');
    key.parse(request.idempotencyKey);
    z.number().int().nonnegative().parse(request.expectedRevision);
    const initial = this.record(request.missionId);
    const actionId = identity('user', initial.id, request.idempotencyKey);
    const user: MissionActor = { kind: 'user', actionId };
    const control = request.control;
    if (initial.status === 'completed' && control.action === 'steer' && retained) return this.queueQuestion(request, retained);
    if (initial.status === 'completed' && (control.action === 'stop' || control.action === 'pause')) return this.cancelQuestion(request);
    if (control.action === 'replace_lead') return this.maintenanceControl(request, () => this.replaceLead(request, control.presetId));
    if (control.action === 'cleanup') return this.maintenanceControl(request, () => this.cleanup(request));
    const stopAdmission = ['pause', 'stop', 'continue_planning', 'narrow_delivery'].includes(control.action);
    if (stopAdmission) { this.fenced.add(initial.id); this.deps.scheduler.pause(initial.id); this.cancelWorkspaceWaiters(initial.id); }
    try {
      if (control.action === 'execute' || control.action === 'steer' && !control.images?.length && initial.pendingProposal && isMissionAffirmative(control.text)) {
        if (!this.deps.sessions.activity(initial.leadSessionId).quiescent) throw new Error('Wait for the planning turn and its tools to settle before approving execution.');
        if (!initial.baseline) {
          // Do not silently refresh the approval revision while resolving source state.
          await this.establishBaseline(initial.id);
          throw new Error('Baseline was rechecked. Review the current Mission revision and submit Proceed again.');
        }
      }
      const updated = await this.deps.store.transact(initial.id, { idempotencyKey: actionId, actor: actorKey(user), expectedRevision: request.expectedRevision, kind: `user.${control.action}`, request: retained ? { ...request, control: { action: 'steer', fingerprint: retained.fingerprint, attachments: retained.attachments } } : request }, (r) => {
        const receivedRevision = r.revision, specificationRevision = r.specificationRevision, planRevision = r.planRevision;
        const question = r.status === 'waiting_for_user' ? r.questions.find((q) => q.answer === undefined) : undefined;
        if (control.action === 'narrow_delivery') {
          if (terminal(r) || r.archived) throw new Error('Stopped/completed or archived Missions cannot change their publication endpoint.');
          const previousEndpoint = r.deliveryPolicy.endpoint;
          if (previousEndpoint !== 'merge_pr' && !(previousEndpoint === 'open_pr' && control.endpoint === 'local_commit')) throw new Error('Publication controls can only reduce merge to open PR/local commit, or open PR to local commit.');
          const now = Date.now();
          // Preserve already-crossed remote boundaries, including uncertain earlier failures.
          // Revocation stops future admissions; it cannot undo a push/PR/merge already in flight.
          const priorRemoteOperationIds = r.operations.filter((op) => op.kind === 'deliver' && op.payload.deliveryRequestedAt !== undefined
            && (op.payload.deliveryPolicy as MissionDeliveryPolicy | undefined)?.endpoint !== 'local_commit'
            || op.kind === 'integrate' && op.payload.target === 'approved' && op.state !== 'intent_recorded' && pending(op)).map((op) => op.id);
          (r.publicationRestrictions ??= []).push({ endpoint: control.endpoint, previousEndpoint, sourceUserActionId: actionId, receivedRevision,
            recordedAt: now, priorRemoteOperationIds });
          r.deliveryPolicy = restrictPublication(r.deliveryPolicy, control.endpoint);
          r.deliveryPolicy.provenance.push({ source: `user:${actionId}`, text: `User reduced publication from ${previousEndpoint} to ${control.endpoint} at Mission revision ${receivedRevision}. Checks, independent review, holds and target identity are unchanged.` });
          const notice = `User limited this Mission to ${control.endpoint}. Publication cannot be widened again by a model or repository policy. Checks, independent review and holds still apply.`;
          r.mailbox.push({ id: actionId, kind: 'permission', sessionId: r.leadSessionId, text: notice, artifactIds: [], createdAt: now });
          if (priorRemoteOperationIds.length) r.blockers.push({ id: `publication_${actionId}`, kind: 'permission', message: `Publication was narrowed, but remote activity was already admitted (${priorRemoteOperationIds.join(', ')}). It may already have published and cannot be undone by this control. Waiting for owned boundaries is not rollback; reconcile retained receipts before resuming.` });
          if (!['paused', 'pausing', 'stopping', 'recovering'].includes(r.status)) r.status = 'pausing';
          r.updatedAt = now;
          return r;
        }
        let mutation: MissionMutation;
        if (control.action === 'execute') mutation = { kind: 'execution.authorize', proposalId: control.proposalId, specificationRevision: control.specificationRevision, at: Date.now() };
        else if (control.action === 'steer') {
          if (!retained) throw new Error('User instructions require host-retained input.');
          const instruction = control.text.trim() ? control.text : '[User attached images]';
          if (!control.images?.length && r.pendingProposal && isMissionAffirmative(control.text)) mutation = { kind: 'execution.authorize', proposalId: r.pendingProposal.id, specificationRevision: r.pendingProposal.specificationRevision, at: Date.now() };
          else if (r.status === 'waiting_for_user') mutation = { kind: 'question.answer', questionId: question!.id, answer: instruction };
          else mutation = { kind: 'control.steer', text: instruction, at: Date.now() };
        } else if (control.action === 'pause' || control.action === 'stop') mutation = { kind: `control.${control.action}` };
        else if (control.action === 'resume') {
          if (r.workspaces.some((workspace) => workspace.cleanedAt && (workspace.role === 'integration' || workspace.ownerSessionId === r.leadSessionId))) throw new Error('Required managed workspaces were cleaned up; start a new Mission from the retained result.');
          // An explicit user retry clears only a safely stopped lead-start failure. The exact
          // runtime probe still runs again before any prompt; uncertainty/verification gates stay.
          if (r.status === 'paused' && this.isQuiescent(r)) for (const blocker of r.blockers.filter((b) => b.id.startsWith('lead_dispatch_') && b.resolvedAt === undefined)) blocker.resolvedAt = Date.now();
          const budget = this.budgetIssue(r);
          if (budget) throw new Error(budget);
          for (const blocker of r.blockers.filter((b) => b.id.startsWith('budget_') && b.resolvedAt === undefined)) blocker.resolvedAt = Date.now();
          mutation = { kind: 'control.resume', quiescent: this.isQuiescent(r) };
        }
        else if (control.action === 'continue_planning') mutation = { kind: 'control.continue_planning' };
        else if (control.action === 'apply_configuration') {
          const settings = this.deps.settings(r.projectRoot);
          mutation = { kind: 'control.apply_configuration', config: applyMissionProjectOverride(settings.config, settings.project) };
        } else throw new Error('Unsupported Mission control.');
        r = reduceMission(r, user, mutation);
        if (control.action === 'steer') {
          if (mutation.kind !== 'control.steer') r = reduceMission(r, host, { kind: 'host.mailbox.append', item: { id: actionId, kind: 'user', sessionId: r.leadSessionId, text: control.text.trim() ? control.text : '[User attached images]', artifactIds: [], createdAt: Date.now() } });
          const item = r.mailbox.find((entry) => entry.id === actionId)!;
          item.userAction = { kind: mutation.kind === 'execution.authorize' || question?.purpose === 'authorization' ? 'authorization' : question ? 'answer' : 'instruction',
            receivedRevision, specificationRevision, planRevision, requestFingerprint: retained!.fingerprint, ...(question ? { questionId: question.id } : {}) };
          if (retained!.attachments.length) item.attachments = structuredClone(retained!.attachments);
        }
        if (control.action === 'execute' || control.action === 'resume' || control.action === 'continue_planning') r = reduceMission(r, host, { kind: 'host.mailbox.append', item: { id: actionId, kind: 'user', sessionId: r.leadSessionId, text: `User ${control.action}; specification ${r.specificationRevision}. Continue within the recorded authorization.`, artifactIds: [], createdAt: Date.now() } });
        r.updatedAt = Date.now(); return r;
      });
      this.publish(initial.id);
      if (control.action === 'apply_configuration') this.budgetGate(initial.id);
      if (control.action === 'resume' && updated.delivery && updated.operations.some((op) => op.id === updated.delivery!.operationId && op.payload.reconciledReceipt)
        && !updated.mailbox.some((item) => item.kind === 'user' && item.id !== actionId && item.deliveredAt === undefined)) {
        const completed = await this.change(initial.id, `${actionId}-recovered-completion`, (state) => {
          const item = state.mailbox.find((entry) => entry.id === actionId); if (item) item.deliveredAt = Date.now();
          return reduceMission(state, host, { kind: 'host.complete', quiescent: this.isQuiescent(state) });
        });
        this.deps.scheduler.unregister(initial.id); this.broker.revoke(initial.id); return completed;
      }
      if (['pausing', 'stopping'].includes(updated.status) || control.action === 'narrow_delivery' && updated.status === 'recovering') {
        this.broker.revoke(initial.id);
        this.deps.verification.cancel(initial.id);
        await this.reconcile(initial.id, updated.status === 'recovering');
      } else {
        if (control.action === 'resume' || control.action === 'continue_planning') {
          if (!this.deps.scheduler.register(initial.id, updated.config.limits.maxConcurrentWorkersPerMission)) throw new Error('Global Mission lead capacity is unavailable.');
          this.fenced.delete(initial.id); this.deps.scheduler.resume(initial.id);
        }
        this.wake(initial.id);
      }
      return this.get(initial.id)!;
    } catch (e) {
      if (stopAdmission && !['pausing', 'stopping', 'paused', 'recovering'].includes(this.record(initial.id).status)) { this.fenced.delete(initial.id); this.deps.scheduler.resume(initial.id); }
      throw e;
    }
  }

  private maintenanceControl(request: MissionControlRequest, run: () => Promise<MissionRecord>): Promise<MissionRecord> {
    const actionId = identity('user', request.missionId, request.idempotencyKey);
    const existing = this.maintenance.get(actionId);
    if (existing) {
      if (!isDeepStrictEqual(existing.request, request)) return Promise.reject(new Error('Maintenance idempotency key was reused for a different request.'));
      return existing.promise;
    }
    const operationId = identity('op', actionId, request.control.action === 'cleanup' ? 'cleanup' : 'replace-lead');
    const promise = Promise.resolve().then(run);
    const settled = promise.then(() => undefined, () => undefined);
    this.maintenance.set(actionId, { request: structuredClone(request), promise });
    this.jobs.set(operationId, settled);
    void settled.then(() => { this.maintenance.delete(actionId); if (this.jobs.get(operationId) === settled) this.jobs.delete(operationId); });
    return promise;
  }

  private async replaceLead(request: MissionControlRequest, presetId: string): Promise<MissionRecord> {
    const initial = this.record(request.missionId);
    const actionId = identity('user', initial.id, request.idempotencyKey);
    const operationId = identity('op', actionId, 'replace-lead');
    const duplicate = initial.operations.find((op) => op.id === operationId);
    if (duplicate) {
      if (!isDeepStrictEqual(duplicate.payload.request, request)) throw new Error('Handover idempotency key was reused for a different request.');
      return initial;
    }
    const preset = initial.config.presets.find((p) => p.id === presetId);
    if (!preset?.enabled || !initial.config.tiers.find((tier) => tier.id === 5)?.presetIds.includes(presetId)) throw new Error('Replacement must be a whole enabled T5 preset.');
    this.config(initial, preset, 'read_only', '');
    const live = this.deps.settings(initial.projectRoot);
    const revoked = checkMissionPresetRevocation(preset, live.config, live.project);
    if (revoked.revoked) throw new Error(revoked.reasons.join(' '));
    if (initial.status !== 'paused' || !this.isQuiescent(initial)) throw new Error('Pause and positively reconcile all owned activity before replacing the principal engineer.');
    const sessionId = identity('s', actionId, 'lead'), workspaceId = identity('w', actionId, 'lead');
    await this.deps.store.transact(initial.id, { idempotencyKey: actionId, actor: `user:${actionId}`, expectedRevision: request.expectedRevision, kind: 'user.replace_lead', request }, (r) => {
      if (!this.isQuiescent(r)) throw new Error('Owned activity changed before handover.');
      r = reduceMission(r, { kind: 'user', actionId }, { kind: 'control.replace_lead', sessionId, preset, quiescent: true });
      r.status = 'recovering';
      r.operations.push({ id: operationId, idempotencyKey: operationId, kind: 'dispatch', actor: `user:${actionId}`, expectedRevision: r.revision, state: 'intent_recorded',
        payload: { infrastructure: 'lead_handover', request, oldLeadSessionId: initial.leadSessionId, leadSessionId: sessionId, workspaceId, preset, generation: r.leadGeneration } });
      return r;
    });
    this.fenced.add(initial.id); this.deps.scheduler.pause(initial.id); this.broker.revoke(initial.id);
    await this.opState(initial.id, operationId, 'in_flight');
    try {
      await this.deps.stopOwnedTerminals?.(this.record(initial.id));
      if (!this.isQuiescent(this.record(initial.id))) throw new Error('Owned activity did not remain quiescent during handover.');
      const old = this.deps.sessions.get(initial.leadSessionId);
      if (old?.mission) await this.deps.sessions.stopManaged(old.id, old.mission.generation);
      if (initial.baseline) {
        const workspace = await this.deps.workspaces.provision({ missionId: initial.id, baseline: this.baseline(initial), role: 'lead', workspaceId });
        await this.change(initial.id, `${operationId}-workspace`, (r) => { r.workspaces.push(this.workspace(workspace, sessionId)); return r; });
      }
      await this.ensureLead(initial.id);
      await this.mail(initial.id, { id: identity('mail', operationId, 'handover'), kind: 'user', sessionId,
        text: `Explicit T5 handover from ${initial.leadSessionId}. Read the retained Mission plan, decisions, evidence, source and unresolved mailbox. No old attempt or delivery may be replayed.`, artifactIds: [], createdAt: Date.now() });
      await this.opState(initial.id, operationId, 'succeeded');
    } catch (e) {
      await this.opState(initial.id, operationId, 'failed', message(e));
      await this.block(initial.id, 'environment', `Lead handover requires reconciliation: ${message(e)}`);
    }
    await this.change(initial.id, `${operationId}-quiet`, (r) => reduceMission(r, host, { kind: 'host.quiesce', quiescent: this.isQuiescent(r) }));
    this.publish(initial.id);
    return this.record(initial.id);
  }

  private async cleanup(request: MissionControlRequest): Promise<MissionRecord> {
    const initial = this.record(request.missionId);
    const actionId = identity('user', initial.id, request.idempotencyKey), operationId = identity('op', actionId, 'cleanup');
    const duplicate = initial.operations.find((op) => op.id === operationId);
    if (duplicate) {
      if (!isDeepStrictEqual(duplicate.payload.request, request)) throw new Error('Cleanup idempotency key was reused for a different request.');
      return initial;
    }
    if (!['paused', 'stopped', 'completed'].includes(initial.status) || !this.isQuiescent(initial) || initial.operations.some(pending) || initial.attempts.some(active)) throw new Error('Cleanup requires a paused/terminal Mission and positively reconciled owned activity.');
    this.fenced.add(initial.id); this.deps.scheduler.pause(initial.id); this.broker.revoke(initial.id);
    await this.deps.store.transact(initial.id, { idempotencyKey: actionId, actor: `user:${actionId}`, expectedRevision: request.expectedRevision, kind: 'user.cleanup', request }, (r) => {
      if (!this.isQuiescent(r) || r.operations.some(pending) || r.attempts.some(active)) throw new Error('Owned activity changed before cleanup.');
      return reduceMission(r, host, { kind: 'host.operation.record', operation: { id: operationId, idempotencyKey: operationId, kind: 'cleanup', actor: `user:${actionId}`, expectedRevision: r.revision, state: 'intent_recorded',
        payload: { request, workspaceIds: r.workspaces.filter((w) => w.cleanedAt === undefined).map((w) => w.id), receipts: [] } } });
    });
    await this.opState(initial.id, operationId, 'in_flight');
    try {
      await this.deps.stopOwnedTerminals?.(this.record(initial.id));
      for (const meta of this.deps.sessions.list().filter((s) => s.mission?.missionId === initial.id)) await this.deps.sessions.stopManaged(meta.id, meta.mission!.generation);
      if (!this.isQuiescent(this.record(initial.id))) throw new Error('Owned runtime/terminal quiescence could not be established.');
      const refused: string[] = [];
      for (const workspace of initial.workspaces.filter((w) => !w.cleanedAt)) {
        const result = await this.deps.workspaces.cleanup(workspace.id);
        await this.change(initial.id, `${operationId}-${workspace.id}-receipt`, (r) => {
          const op = r.operations.find((o) => o.id === operationId)!;
          (op.payload.receipts as unknown[]).push({ workspaceId: workspace.id, ...result });
          if (result.removed) r.workspaces.find((w) => w.id === workspace.id)!.cleanedAt = Date.now();
          return r;
        });
        if (!result.removed) refused.push(`${workspace.id}: ${result.message}`);
      }
      await this.opState(initial.id, operationId, refused.length ? 'failed' : 'succeeded', refused.join(' '));
    } catch (e) { await this.opState(initial.id, operationId, 'failed', message(e)); }
    this.publish(initial.id);
    return this.record(initial.id);
  }

  /** Host user transport only. The mailbox + answer intent commit together; no execution field
   * or completion fact is changed. A duplicate user key can observe, never repeat, this turn. */
  private async queueQuestion(request: MissionControlRequest, retained: { fingerprint: string; attachments: MissionAttachmentRef[] }): Promise<MissionRecord> {
    if (request.control.action !== 'steer') throw new Error('Expected a user question.');
    const initial = this.record(request.missionId), questionId = identity('user', initial.id, request.idempotencyKey);
    const operationId = identity('op', questionId, 'answer'), question = request.control;
    const result = await this.deps.store.transact(initial.id, { idempotencyKey: questionId, actor: `user:${questionId}`, expectedRevision: request.expectedRevision,
      kind: 'user.question', request: { fingerprint: retained.fingerprint, attachments: retained.attachments } }, (r) => {
      if (r.status !== 'completed' || r.archived || !this.isQuiescent(r) || r.operations.some(pending)) throw new Error('Wait for the current answer/owned activity to settle, or cancel it before asking another question. Archived Missions cannot answer.');
      const issue = this.budgetIssue(r); if (issue) throw new Error(issue);
      const settings = this.deps.settings(r.projectRoot), revoked = checkMissionPresetRevocation(r.leadPreset, settings.config, settings.project);
      if (revoked.revoked) throw new Error(revoked.reasons.join(' '));
      const now = Date.now();
      r.mailbox.push({ id: questionId, kind: 'user', sessionId: r.leadSessionId, text: question.text.trim() ? question.text : '[User attached images]', artifactIds: [],
        ...(retained.attachments.length ? { attachments: structuredClone(retained.attachments) } : {}), createdAt: now,
        userAction: { kind: 'question', receivedRevision: r.revision, specificationRevision: r.specificationRevision, planRevision: r.planRevision, requestFingerprint: retained.fingerprint } });
      r.operations.push({ id: operationId, idempotencyKey: operationId, actor: 'host', kind: 'dispatch', expectedRevision: r.revision, state: 'intent_recorded',
        payload: { questionId, lead: true, sessionId: r.leadSessionId, generation: r.leadGeneration, mailboxIds: [questionId],
          answerLimits: { turns: 1, tools: ANSWER_MAX_TOOLS, observedOutputTokens: ANSWER_MAX_OUTPUT_TOKENS, timeoutMs: ANSWER_TIMEOUT_MS } } });
      r.updatedAt = now; return r;
    });
    this.fenced.delete(initial.id);
    this.publish(initial.id);
    this.background(operationId, () => this.sendQuestion(initial.id, operationId));
    return result;
  }

  private assertQuestionAdmission(r: MissionRecord, operationId: string): MissionOperation {
    const op = r.operations.find((entry) => entry.id === operationId);
    if (this.closed || this.fenced.has(r.id) || r.status !== 'completed' || r.archived || this.externalUncertainty.has(r.id) || this.deps.store.isBlocked(r.id)
      || !op || !isMissionQuestionOperation(op) || !['intent_recorded', 'in_flight'].includes(op.state)) throw new Error('Read-only answer admission is closed.');
    const issue = this.budgetIssue(r); if (issue) throw new Error(issue);
    const live = this.deps.settings(r.projectRoot), revoked = checkMissionPresetRevocation(r.leadPreset, live.config, live.project);
    if (revoked.revoked) throw new Error(revoked.reasons.join(' '));
    return op;
  }

  private async sendQuestion(id: string, operationId: string): Promise<void> {
    let lease: CapacityLease | undefined;
    try {
      const initial = this.record(id), op = this.assertQuestionAdmission(initial, operationId);
      if (!this.deps.scheduler.register(id, initial.config.limits.maxConcurrentWorkersPerMission)) throw new Error('Global Mission capacity is full. Ask again after capacity is available.');
      this.deps.scheduler.resume(id);
      lease = await this.deps.scheduler.acquire({ missionId: id, ownerId: operationId, kind: 'lead', accountId: initial.leadPreset.model.connectionId ?? initial.leadPreset.model.provider });
      this.assertQuestionAdmission(this.record(id), operationId);
      const live: LiveTurn = { operationId, lease, generation: initial.leadGeneration, questionId: String(op.payload.questionId), answerMessageIds: new Set(), answerToolIds: new Set() };
      this.turns.set(initial.leadSessionId, live); lease = undefined;
      live.answerTimer = setTimeout(() => { void this.endQuestion(id, 'Read-only answer time limit reached. No automatic retry.').catch((error) => this.deps.log?.(message(error))); }, ANSWER_TIMEOUT_MS);
      live.answerTimer.unref?.();
      const meta = this.deps.sessions.get(initial.leadSessionId);
      if (!meta?.mission) throw new Error('The retained lead conversation is unavailable. No replacement Mission was started.');
      // Even an idle coding runtime is retired before installing the narrowed capability.
      await this.deps.sessions.stopManaged(meta.id, meta.mission.generation);
      this.assertQuestionAdmission(this.record(id), operationId);
      const workspace = initial.workspaces.find((w) => w.ownerSessionId === meta.id && w.path === meta.cwd && !w.cleanedAt);
      await this.deps.sessions.updateManaged(meta.id, meta.mission.generation, { cwd: workspace?.path ?? initial.sourceCwd, worktreeBranch: workspace?.branch,
        mission: { sourceAccess: 'read_only', requestedTools: [], attemptId: undefined, questionId: live.questionId },
        config: this.config(initial, initial.leadPreset, 'read_only', ANSWER_POLICY) });
      this.assertQuestionAdmission(this.record(id), operationId);
      await this.opState(id, operationId, 'in_flight');
      await this.markRuntimeStart(id, operationId);
      const question = this.record(id).mailbox.find((item) => item.id === live.questionId)!;
      const images: ImageAttachment[] = [];
      for (const attachment of question.attachments ?? []) {
        const image = userImageSchema.parse(JSON.parse((await this.deps.store.readArtifact(id, attachment.ref)).toString('utf8')));
        if (image.mimeType !== attachment.mimeType || image.name !== attachment.name) throw new Error('Retained user attachment metadata does not match its immutable content.');
        images.push(image);
      }
      this.assertQuestionAdmission(this.record(id), operationId);
      await this.deps.sessions.sendManaged(meta.id, { text: `[Read-only question about completed Mission ${id}; ${question.id}]\n${question.text}`, ...(images.length ? { images } : {}) }, initial.leadGeneration);
    } catch (error) {
      lease?.release(true);
      // Never await our own dispatch job from its teardown/reconciliation path.
      this.background(`answer-failure:${operationId}`, () => this.endQuestion(id, `Read-only answer could not finish: ${message(error)}`));
    }
  }

  private async beforeQuestionDispatch(meta: SessionMeta, binding: MissionToolBinding, live: LiveTurn): Promise<void> {
    const r = this.record(binding.missionId);
    this.assertQuestionAdmission(r, live.operationId);
    await this.checkPreset(r, r.leadPreset, 'lead', ['mission_read', 'mission_context_read'], 'read_only', meta.id);
    await this.validate(binding);
    await this.waitForWorkspace(r.id, meta.cwd);
    await this.validate(binding);
    await this.change(r.id, `${live.operationId}-question-boundary`, (state) => {
      const op = this.assertQuestionAdmission(state, live.operationId);
      const question = state.mailbox.find((item) => item.id === binding.questionId);
      if (op.state !== 'in_flight' || op.payload.dispatchStartedAt !== undefined || !question || question.userAction?.kind !== 'question' || question.deliveredAt !== undefined) throw new Error('Question dispatch was already consumed or is not genuine user input.');
      op.payload.budgetBaseline = missionBudgetSessions(state, this.deps.sessions.list(), this.observedBudgets()).get(meta.id) ?? { tokens: 0, costUsd: 0 };
      op.payload.answerOutputBaseline = meta.usage.outputTokens;
      op.payload.dispatchStartedAt = Date.now(); op.payload.dispatchStage = 'sending'; question.deliveredAt = Date.now(); return state;
    });
  }

  private async cancelQuestion(request: MissionControlRequest): Promise<MissionRecord> {
    const initial = this.record(request.missionId), actionId = identity('user', initial.id, request.idempotencyKey);
    const prior = initial.operations.filter(isMissionQuestionOperation).find((op) => (op.payload.cancellations as MissionControlRequest[] | undefined)?.some((control) => control.idempotencyKey === request.idempotencyKey));
    if (prior) {
      const saved = (prior.payload.cancellations as MissionControlRequest[]).find((control) => control.idempotencyKey === request.idempotencyKey);
      if (!isDeepStrictEqual(saved, request)) throw new Error('Answer cancellation idempotency key was reused for a different request.');
      if (pending(prior)) await this.endQuestion(initial.id, 'Read-only answer canceled by the user. The Mission remains completed.');
      return this.record(initial.id); // A lost cancellation acknowledgement can never stop a later question.
    }
    const answer = initial.operations.find((op) => isMissionQuestionOperation(op) && pending(op));
    if (!answer) return initial;
    if (initial.revision !== request.expectedRevision) throw new MissionStoreError('REVISION_CONFLICT', `Expected revision ${request.expectedRevision}; current revision is ${initial.revision}`, { expectedRevision: request.expectedRevision, currentRevision: initial.revision });
    this.fenced.add(initial.id); this.deps.scheduler.pause(initial.id); this.broker.revoke(initial.id); this.cancelWorkspaceWaiters(initial.id);
    try {
      await this.deps.store.transact(initial.id, { idempotencyKey: actionId, actor: `user:${actionId}`, expectedRevision: request.expectedRevision, kind: 'user.question.cancel', request }, (r) => {
        const op = r.operations.find((entry) => entry.id === answer.id)!;
        ((op.payload.cancellations ??= []) as MissionControlRequest[]).push(structuredClone(request));
        return r;
      });
    } finally { await this.endQuestion(initial.id, 'Read-only answer canceled by the user. The Mission remains completed.'); }
    return this.record(initial.id);
  }

  /** Completion stays immutable even on failure/cancel. Keep the lease until positive disposal;
   * an unknown startup/teardown cannot authorize a second prompt, archive or workspace cleanup. */
  private endQuestion(id: string, reason?: string): Promise<void> {
    const existing = this.reconciliations.get(id); if (existing) return existing;
    const record = this.record(id), operation = record.operations.find((op) => isMissionQuestionOperation(op) && pending(op));
    if (!operation) return Promise.resolve();
    this.fenced.add(id); this.deps.scheduler.pause(id); this.broker.revoke(id); this.cancelWorkspaceWaiters(id);
    const live = this.turns.get(record.leadSessionId);
    if (live?.answerTimer) clearTimeout(live.answerTimer);
    const promise = Promise.resolve().then(async () => {
      try {
        if (this.externalUncertainty.has(id)) {
          const observation = await this.deps.reconcileExternalActivity?.(this.record(id));
          if (!observation?.quiescent || !observation.receipt?.trim()) throw new Error(observation?.detail ?? 'No positive external ownership receipt.');
          await this.change(id, `${operation.id}-answer-ownership`, (r) => { r.operations.find((op) => op.id === operation.id)!.payload.externalQuiescenceReceipt = observation.receipt; return r; });
          this.externalUncertainty.delete(id);
        }
        const meta = this.deps.sessions.get(record.leadSessionId);
        if (meta?.mission) await this.deps.sessions.stopManaged(meta.id, meta.mission.generation);
        await this.jobs.get(operation.id);
        if (meta?.mission) await this.deps.sessions.stopManaged(meta.id, meta.mission.generation);
        if (!this.deps.sessions.activity(record.leadSessionId).quiescent || this.deps.additionalActivity?.(this.record(id))) throw new Error('Owned answer activity is not positively quiescent.');
        const effective = this.deps.sessions.get(record.leadSessionId);
        const adherence = checkMissionPresetAdherence(record.leadPreset, { model: effective?.activeModel, reasoning: effective?.activeEffort ? { kind: 'explicit', value: effective.activeEffort } : undefined });
        const failure = reason ?? (adherence.status === 'mismatch' ? `Read-only answer effective preset mismatch: ${adherence.mismatches.join(' ')}` : undefined)
          ?? (live?.terminal?.status !== 'completed' ? 'Answer turn did not complete; no prompt was replayed.' : !live.answerMessageIds?.size ? 'The model returned no answer. No automatic retry.' : undefined);
        await this.change(id, `${operation.id}-answer-settled`, (r) => {
          const op = r.operations.find((entry) => entry.id === operation.id)!;
          if (!pending(op)) return r;
          op.state = failure ? 'failed' : 'succeeded'; if (failure) op.error = failure;
          if (live?.terminal) op.payload.terminalTurnId = live.terminal.id;
          op.payload.answerMessageIds = [...(live?.answerMessageIds ?? [])]; op.payload.endedAt = Date.now();
          const baseline = op.payload.budgetBaseline as MissionBudgetUsage | undefined;
          const observed = effective && op.payload.dispatchStartedAt !== undefined ? mergeBudgetUsage(this.budgetObservations.get(op.id) ?? { tokens: 0, costUsd: 0 }, budgetUsage(effective.usage)) : this.budgetObservations.get(op.id);
          if (observed) op.payload.budgetUsage = observed;
          if (effective?.activeModel) op.payload.effectiveModel = structuredClone(effective.activeModel);
          if (effective?.activeEffort) op.payload.effectiveEffort = effective.activeEffort;
          op.payload.answerUsage = observed && baseline ? { tokens: Math.max(0, observed.tokens - baseline.tokens), costUsd: Math.max(0, observed.costUsd - baseline.costUsd) } : null;
          return r;
        });
        if (live && this.turns.get(record.leadSessionId) === live) { this.turns.delete(record.leadSessionId); live.lease.release(true); }
        this.deps.scheduler.unregister(id);
        if (failure) this.deps.sessions.note(record.leadSessionId, failure, 'warn');
      } catch (error) {
        await this.change(id, `${operation.id}-answer-uncertain-${this.record(id).revision}`, (r) => {
          const op = r.operations.find((entry) => entry.id === operation.id)!;
          if (pending(op)) { op.state = 'reconciling'; op.error = `Read-only answer ownership remains uncertain: ${message(error)}`; }
          return r;
        });
        throw error;
      }
    });
    this.reconciliations.set(id, promise);
    void promise.finally(() => { if (this.reconciliations.get(id) === promise) this.reconciliations.delete(id); }).catch(() => undefined);
    return promise;
  }

  async sendUser(leadSessionId: string, input: UserInput, idempotencyKey: string = randomUUID()): Promise<MissionRecord> {
    const meta = this.deps.sessions.get(leadSessionId);
    if (!meta?.mission || meta.mission.role !== 'lead') throw new Error('Workers have no direct user instruction channel. Send this instruction to the principal engineer.');
    const r = this.record(meta.mission.missionId);
    if (r.leadSessionId !== leadSessionId) throw new Error('This principal-engineer generation was replaced.');
    if (/^\/goal(?:\s|$)/i.test(input.text.trimStart())) throw new Error('Mission already owns continuation. Use Mission pause, resume or stop instead of /goal.');
    const actionId = identity('user', r.id, idempotencyKey);
    const expectedRevision = r.mailbox.find((item) => item.id === actionId)?.userAction?.receivedRevision ?? this.userInputs.get(actionId)?.request.expectedRevision ?? r.revision;
    return this.control({ missionId: r.id, expectedRevision, idempotencyKey, control: { action: 'steer', text: input.text, images: input.images } });
  }

  async archive(missionId: string, archived: boolean): Promise<MissionRecord> {
    let r = this.record(missionId);
    if (archived && r.status === 'completed') { await this.endQuestion(missionId, 'Read-only answer canceled for archive.'); r = this.record(missionId); }
    if (archived && !terminal(r) && r.status !== 'paused') r = await this.control({ missionId, expectedRevision: r.revision, idempotencyKey: randomUUID(), control: { action: 'pause' } });
    if (!this.isQuiescent(r)) throw new Error('Reconcile all owned activity before archiving a Mission.');
    for (const meta of this.deps.sessions.list().filter((s) => s.mission?.missionId === missionId)) {
      await this.deps.sessions.stopManaged(meta.id, meta.mission!.generation);
      await this.deps.sessions.archiveManaged(meta.id, meta.mission!.generation, archived);
    }
    return this.change(missionId, `archive-${r.revision}`, (state) => { state.archived = archived; return state; });
  }

  async ownsWorkspace(cwd: string): Promise<boolean> {
    const canonical = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    const target = canonical(await fs.realpath(cwd));
    for (const r of this.list()) for (const w of r.workspaces.filter((w) => !w.cleanedAt)) {
      let root: string;
      try { root = canonical(await fs.realpath(w.path)); } catch { continue; }
      const relative = path.relative(root, target);
      if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return true;
    }
    return false;
  }

  /** Settings notifications revoke authority, never replace pinned presets or certify stopped
   * tools. Only owned interruption/disposal and reconciliation can release the retained leases.
   * Connection IDs come from host-observed disables/removals, not model/catalog inference. */
  configurationChanged(revokedConnectionIds: readonly string[] = []): void {
    if (this.closed) return;
    for (const record of this.list()) {
      if (terminal(record) && !record.operations.some((op) => isMissionQuestionOperation(op) && pending(op)) || record.status === 'paused' && this.isQuiescent(record)) continue;
      const settings = this.deps.settings(record.projectRoot);
      const presets = [record.leadPreset, ...record.attempts.filter(active).map((attempt) => attempt.preset)];
      // Include queued dispatches that have not materialized an attempt/session yet, but not
      // unused library entries: changing a future pool must not revoke legitimate old work.
      for (const operation of record.operations.filter((op) => op.kind === 'dispatch' && pending(op))) {
        const preset = record.config.presets.find((entry) => entry.id === operation.payload.presetId);
        if (preset) presets.push(preset);
      }
      const reasons = new Set<string>();
      for (const preset of presets) {
        for (const reason of checkMissionPresetRevocation(preset, settings.config, settings.project).reasons) reasons.add(reason);
        if (revokedConnectionIds.includes(preset.model.provider) || revokedConnectionIds.includes(preset.model.connectionId ?? preset.model.provider)) reasons.add('The pinned provider connection or its stored credentials were disabled or removed.');
      }
      if (!reasons.size) continue;
      const id = record.id;
      if (record.status === 'completed') {
        void this.endQuestion(id, `Read-only answer stopped: live configuration revoked. ${[...reasons].join(' ')}`).catch((error) => this.deps.log?.(message(error)));
        continue;
      }
      this.fenced.add(id); this.deps.scheduler.pause(id); this.cancelWorkspaceWaiters(id);
      this.broker.revoke(id); this.deps.verification.cancel(id);
      this.background(`configuration-pause:${id}`, async () => {
        const reason = `Live Mission configuration revoked: ${[...reasons].join(' ')} Owned activity must stop before resuming; partial work is retained. No preset or billing path was replaced.`;
        await this.change(id, `configuration-pause-${record.revision}`, (state) => {
          if (!terminal(state) && !['stopping', 'recovering'].includes(state.status)) state.status = 'pausing';
          return reduceMission(state, host, { kind: 'host.mailbox.append', item: { id: identity('configuration', id, record.revision), kind: 'permission', sessionId: state.leadSessionId, text: reason, artifactIds: [], createdAt: Date.now() } });
        });
        this.deps.sessions.note(record.leadSessionId, reason, 'warn');
        await this.reconcile(id, false);
      });
    }
  }

  /** Host terminal/process observations are wakeups, never assertions of success. */
  ownedActivityChanged(missionId: string): void { this.wake(missionId); }

  /** Called by the held-lease provider on release. No timer polls a workspace into availability. */
  workspaceAvailable(cwd: string): void {
    const key = path.resolve(cwd);
    const waiting = this.workspaceWaiters.get(key);
    this.workspaceWaiters.delete(key);
    for (const waiter of waiting ?? []) waiter.resolve();
  }
  private async waitForWorkspace(missionId: string, cwd: string): Promise<void> {
    if (!this.deps.assertWorkspaceAvailable) return;
    for (;;) {
      if (this.fenced.has(missionId) || this.closed) throw new Error('Workspace admission canceled.');
      const key = path.resolve(cwd);
      // Install the wakeup before the async guard, so a lease release cannot be lost between it
      // reporting busy and this turn registering its wait.
      let waiter!: { missionId: string; resolve(): void; reject(error: Error): void };
      const notified = new Promise<void>((resolve, reject) => { waiter = { missionId, resolve, reject }; });
      void notified.catch(() => undefined);
      const waiting = this.workspaceWaiters.get(key) ?? new Set<typeof waiter>();
      waiting.add(waiter); this.workspaceWaiters.set(key, waiting);
      try {
        await this.deps.assertWorkspaceAvailable(cwd);
        waiting.delete(waiter); if (!waiting.size) this.workspaceWaiters.delete(key);
        return;
      } catch {
        await notified;
      }
    }
  }
  private cancelWorkspaceWaiters(id: string): void {
    for (const [key, waiting] of this.workspaceWaiters) {
      for (const waiter of waiting) if (waiter.missionId === id) { waiter.reject(new Error('Workspace admission canceled.')); waiting.delete(waiter); }
      if (!waiting.size) this.workspaceWaiters.delete(key);
    }
  }

  private binding(meta: SessionMeta): MissionToolBinding {
    const owned = meta.mission;
    if (!owned) throw new Error('Not a Mission participant.');
    return { missionId: owned.missionId, ...(owned.questionId ? { questionId: owned.questionId } : {}), actor: owned.role === 'lead' ? { kind: 'lead', sessionId: meta.id, generation: owned.generation }
      : { kind: 'worker', sessionId: meta.id, generation: owned.generation, attemptId: owned.attemptId! } };
  }
  async validate(binding: MissionToolBinding): Promise<void> {
    const r = this.record(binding.missionId);
    const a = binding.actor;
    const meta = this.deps.sessions.get(a.sessionId);
    if (this.closed || this.fenced.has(r.id) || terminal(r) && !(r.status === 'completed' && binding.questionId) || !meta?.mission || !isDeepStrictEqual(this.binding(meta), binding)) throw new Error('Mission connection is no longer authorized.');
    if (binding.questionId) {
      const live = this.turns.get(a.sessionId);
      const operation = r.operations.find((op) => op.id === live?.operationId);
      if (a.kind !== 'lead' || r.status !== 'completed' || r.archived || meta.mission.sourceAccess !== 'read_only' || meta.config.permissionMode !== 'plan'
        || !live || live.questionId !== binding.questionId || live.generation !== a.generation || !operation || !isMissionQuestionOperation(operation)
        || operation.state !== 'in_flight' || operation.payload.questionId !== binding.questionId) throw new Error('No pending read-only question owns this connection.');
    }
    let preset = r.leadPreset;
    if (a.kind === 'lead') {
      if (a.sessionId !== r.leadSessionId || a.generation !== r.leadGeneration) throw new Error('Stale principal-engineer generation.');
    } else {
      const attempt = r.attempts.find((v) => v.id === a.attemptId);
      if (!attempt || !active(attempt) || attempt.sessionId !== a.sessionId || attempt.generation !== a.generation || !attempt.profile) throw new Error('Worker is not assigned to a live attempt.');
      preset = attempt.preset;
    }
    const settings = this.deps.settings(r.projectRoot);
    const revoked = checkMissionPresetRevocation(preset, settings.config, settings.project);
    if (revoked.revoked) throw new Error(revoked.reasons.join(' '));
  }
  private async checkPreset(r: MissionRecord, preset: ExecutionPreset, role: 'lead' | 'worker', requiredTools: string[], sourceAccess: MissionOwnership['sourceAccess'], sessionId: string): Promise<void> {
    const settings = this.deps.settings(r.projectRoot);
    const revoked = checkMissionPresetRevocation(preset, settings.config, settings.project);
    if (revoked.revoked) throw new Error(revoked.reasons.join(' '));
    const session = this.deps.sessions.get(sessionId);
    if (!session?.mission || !this.deps.sessions.activity(sessionId).active) throw new Error('Exact-preset capability evidence requires the initialized managed runtime.');
    const capabilities = await this.deps.capabilities.probe(structuredClone(preset), { projectRoot: r.projectRoot, role, requiredTools, sourceAccess, permissionMode: sourceAccess === 'read_only' ? 'plan' : r.requestedPermissionMode, sessionId, generation: session.mission.generation, cwd: session.cwd });
    const check = validatePresetEligibility(preset, { role, restrictions: r.providerRestrictions, requiredTools, capabilities: () => capabilities });
    if (!check.eligible) throw new Error(`${check.status}: ${check.reasons.join(' ')}`);
    // A settings revocation can land while the async exact-preset probe is outstanding.
    const live = this.deps.settings(r.projectRoot);
    const recheck = checkMissionPresetRevocation(preset, live.config, live.project);
    if (recheck.revoked) throw new Error(recheck.reasons.join(' '));
  }
  private async beforeDispatch(meta: SessionMeta): Promise<void> {
    const binding = this.binding(meta);
    await this.validate(binding);
    const r = this.record(binding.missionId);
    const live = this.turns.get(meta.id);
    if (!live || live.generation !== meta.mission!.generation || !r.operations.some((o) => o.id === live.operationId && o.state === 'in_flight')) throw new Error('No durable dispatch intent owns this send.');
    if (binding.questionId) { await this.beforeQuestionDispatch(meta, binding, live); return; }
    if (r.status !== 'running') throw new Error('Mission is not admitting a new turn.');
    const budget = this.budgetGate(r.id);
    if (budget) throw new Error(budget);
    const attempt = r.attempts.find((a) => active(a) && a.sessionId === meta.id);
    const access = attempt?.profile?.sourceAccess ?? (attempt ? 'assigned_workspace' : 'read_only');
    if (attempt && (attempt.specificationRevision !== r.specificationRevision || !r.tasks.some((task) => task.id === attempt.taskId && task.revision === attempt.taskRevision && task.status === 'running'))) throw new Error('Attempt inputs became stale; reconcile before another turn.');
    if (access === 'assigned_workspace' && (!r.executionAuthorization || r.phase !== 'executing' || !r.baseline)) throw new Error('Implementation is not authorized.');
    await this.checkPreset(r, attempt?.preset ?? r.leadPreset, binding.actor.kind, attempt ? r.tasks.find((t) => t.id === attempt.taskId)!.requiredTools : [], access, meta.id);
    await this.validate(binding);
    await this.waitForWorkspace(r.id, meta.cwd);
    await this.validate(binding);
    await this.change(r.id, `${live.operationId}-dispatch-boundary`, (state) => {
      if (state.status !== 'running' || this.fenced.has(r.id)) throw new Error('Mission admission closed while capability verification was pending.');
      const budget = this.budgetGate(r.id);
      if (budget) throw new Error(budget);
      const op = state.operations.find((o) => o.id === live.operationId);
      if (!op || op.state !== 'in_flight' || op.payload.dispatchStartedAt !== undefined) throw new Error('Dispatch intent was already consumed or reconciled.');
      // Reserve input before the adapter call. An acknowledgment can be lost, so recovery must
      // never replay these instructions simply because sendManaged did not resolve.
      op.payload.budgetBaseline = missionBudgetSessions(state, this.deps.sessions.list(), this.observedBudgets()).get(meta.id) ?? { tokens: 0, costUsd: 0 };
      op.payload.dispatchStartedAt = Date.now();
      op.payload.dispatchStage = 'sending';
      for (const item of state.mailbox) if ((op.payload.mailboxIds as string[] | undefined)?.includes(item.id)) item.deliveredAt ??= Date.now();
      return state;
    });
  }

  async invoke(binding: MissionToolBinding, name: MissionToolName, request: MissionToolRequest): Promise<unknown> {
    await this.validate(binding);
    const r = this.record(binding.missionId);
    if (name === 'mission_read') return this.scopedRead(r, binding.actor);
    if (name === 'mission_context_read') return this.readContext(r, binding.actor, request.payload);
    if (binding.questionId || r.status === 'completed') throw new Error('Completed Mission questions are read-only; start a new Mission for implementation.');
    key.parse(request.idempotencyKey); z.number().int().nonnegative().parse(request.expectedRevision);
    if (['actor', 'missionId', 'sessionId', 'generation', 'authorization', 'sourceUserActionId', 'kind'].some((k) => Object.hasOwn(request.payload, k))) throw new Error('Model payload cannot select actor, mutation kind, or user authority.');
    const map: Partial<Record<MissionToolName, MissionMutation['kind']>> = {
      mission_plan_update: 'plan.update', mission_question_ask: 'question.ask', mission_execution_propose: 'execution.propose', mission_profile_upsert: 'profile.upsert',
      mission_report: 'result.report', mission_decision_request: 'decision.request', mission_decision_resolve: 'decision.resolve', mission_review_submit: 'review.submit',
      mission_task_accept: 'task.accept', mission_task_diagnose: 'task.diagnose', mission_finding_resolve: 'finding.resolve', mission_phase_set: 'phase.set', mission_task_cancel: 'task.cancel',
    };
    const kind = map[name];
    if (kind) {
      let payload = request.payload;
      if (kind === 'execution.propose') {
        if (binding.actor.kind !== 'lead') throw new Error('Only the principal engineer may propose execution.');
        const input = z.strictObject({ proposal: z.strictObject({ id: key, specificationRevision: z.number().int().positive(), planRevision: z.number().int().nonnegative(),
          assistantMessageId: key.optional(), requestedAt: z.number().int().nonnegative().optional(),
        }) }).parse(payload);
        const transcript = await this.deps.sessions.transcript(r.leadSessionId);
        const current = transcript.slice(transcript.findLastIndex((item) => item.kind === 'user') + 1).findLast((item) => item.kind === 'assistant' && !!item.text.trim());
        if (!current || input.proposal.assistantMessageId !== undefined && input.proposal.assistantMessageId !== current.id) throw new Error('Execution proposal must reference the actual current assistant message presenting the plan. Present the plan before proposing execution.');
        payload = { proposal: { ...input.proposal, assistantMessageId: current.id, requestedAt: Date.now() } };
      }
      const mutation = { ...payload, kind };
      assertMissionMutation(mutation);
      if (mutation.kind === 'profile.upsert') {
        const allowed = new Set([r.sourceSnapshotId, ...r.mailbox.flatMap((item) => item.attachments?.map((attachment) => attachment.ref) ?? []), ...r.candidates.map((c) => c.id), ...r.evidence.flatMap((e) => e.artifactIds)]);
        if (mutation.profile.contextRefs.some((ref) => !allowed.has(ref))) throw new Error('Profile context references must name retained Mission source, candidates, or evidence artifacts.');
      }
      if (mutation.kind === 'result.report') {
        const attempt = r.attempts.find((a) => a.id === mutation.result.attemptId);
        const allowed = new Set([...(attempt?.profile?.contextRefs ?? []), ...r.evidence.filter((e) => e.attemptId === attempt?.id).flatMap((e) => e.artifactIds)]);
        if (mutation.result.artifactIds.some((ref) => !allowed.has(ref))) throw new Error('Result artifacts must be host-retained references assigned to this attempt. Paths and self-asserted artifact identities are not accepted.');
      }
      const updated = await this.toolTransaction(binding, name, request, (state) => reduceMission(state, binding.actor, mutation));
      if (['result.report', 'decision.request', 'review.submit'].includes(kind) && binding.actor.kind === 'worker') {
        await this.mail(r.id, { id: identity('mail', binding.actor.sessionId, request.idempotencyKey), kind: kind === 'decision.request' ? 'decision' : 'progress', sessionId: binding.actor.sessionId,
          taskId: r.attempts.find((a) => binding.actor.kind === 'worker' && a.id === binding.actor.attemptId)?.taskId, text: `${name}: ${JSON.stringify(request.payload)}`, artifactIds: [], createdAt: Date.now() });
      }
      if (mutation.kind === 'decision.resolve') {
        const decision = updated.decisions.find((d) => d.id === mutation.decisionId)!;
        const waiting = updated.attempts.find((a) => a.sessionId === decision.requestedBy && active(a));
        if (waiting && this.yielded.has(waiting.sessionId)) this.background(identity('continue', waiting.id, decision.id), () => this.continueAttempt(updated.id, waiting, `Decision ${decision.id} resolved: ${decision.resolution}. ${decision.rationale}`, decision.id));
      }
      this.wake(r.id); return { revision: updated.revision };
    }
    if (name === 'mission_task_claim' || name === 'mission_task_delegate') return this.requestAttempt(binding, name, request);
    if (name === 'mission_yield') {
      z.strictObject({ events: z.array(text).min(1).max(100) }).parse(request.payload);
      await this.toolTransaction(binding, name, request, (state) => {
        const live = this.turns.get(binding.actor.sessionId);
        const op = state.operations.find((o) => o.id === live?.operationId);
        if (!op) throw new Error('Only an active owned turn can yield.');
        op.payload.waitFor = request.payload.events; return state;
      });
      this.yielded.add(binding.actor.sessionId);
      return { waiting: request.payload.events, release: 'after normalized terminal turn and tool quiescence' };
    }
    if (name === 'mission_verification_request' || name === 'mission_integration_request' || name === 'mission_finish_request') return this.requestOperation(binding, name, request);
    throw new Error('Unsupported Mission operation; no side effect was performed.');
  }

  private scopedRead(r: MissionRecord, actor: MissionToolActor): unknown {
    if (actor.kind === 'lead') return r;
    const attempt = r.attempts.find((a) => a.id === actor.attemptId)!;
    const task = r.tasks.find((t) => t.id === attempt.taskId)!;
    return { id: r.id, revision: r.revision, objective: r.objective, specificationRevision: r.specificationRevision, phase: r.phase, status: r.status,
      task, attempt, decisions: r.decisions.filter((d) => task.decisionRefs.includes(d.id) || d.requestedBy === actor.sessionId),
      evidence: r.evidence.filter((e) => e.attemptId === attempt.id), contextRefs: attempt.profile?.contextRefs ?? [] };
  }
  private async readContext(r: MissionRecord, actor: MissionToolActor, payload: Record<string, unknown>): Promise<unknown> {
    const query = z.strictObject({ ref: key, offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(64_000).optional(),
      imageIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), listImages: z.literal(true).optional(),
    }).refine((value) => !(value.imageIndex !== undefined && value.listImages)
      && (!(value.imageIndex !== undefined || value.listImages) || value.offset === undefined && value.limit === undefined),
    'Select text pagination, one image index, or image descriptors, never both.').parse(payload);
    const attempt = actor.kind === 'worker' ? r.attempts.find((a) => a.id === actor.attemptId)! : undefined;
    const allowed = attempt ? new Set([...(attempt.profile?.contextRefs ?? []), ...r.evidence.filter((e) => e.attemptId === attempt.id).flatMap((e) => e.artifactIds), ...(attempt.result?.artifactIds ?? [])])
      : new Set([r.sourceSnapshotId, ...r.mailbox.flatMap((item) => item.attachments?.map((attachment) => attachment.ref) ?? []), ...r.candidates.map((c) => c.id), ...r.profiles.flatMap((p) => p.contextRefs), ...r.evidence.flatMap((e) => e.artifactIds), ...r.attempts.flatMap((a) => a.result?.artifactIds ?? [])]);
    if (!allowed.has(query.ref)) throw new Error('This opaque context reference is not assigned to this participant.');
    const attachment = r.mailbox.flatMap((item) => item.attachments ?? []).find((item) => item.ref === query.ref);
    if (attachment) {
      if (query.offset !== undefined || query.limit !== undefined || query.imageIndex !== undefined && query.imageIndex !== 0) throw new Error('Retained user attachment is one image; use imageIndex 0 or listImages.');
      if (query.imageIndex === undefined) return { kind: 'source_images', ref: query.ref, images: [{ imageIndex: 0, mimeType: attachment.mimeType, ...(attachment.name === undefined ? {} : { name: attachment.name }) }] };
      const image = userImageSchema.parse(JSON.parse((await this.deps.store.readArtifact(r.id, query.ref)).toString('utf8')));
      if (image.mimeType !== attachment.mimeType || image.name !== attachment.name) throw new Error('Retained user attachment metadata does not match its immutable content.');
      return { kind: 'source_image', image };
    }
    if (query.imageIndex !== undefined || query.listImages) {
      if (query.ref !== r.sourceSnapshotId) throw new Error('Image selectors apply only to retained source.');
      const source = JSON.parse((await this.deps.store.readSource(r.id, query.ref)).toString('utf8')) as MissionSource;
      const images = z.array(z.strictObject({ mimeType: z.string().startsWith('image/'), data: z.string().min(1), name: z.string().optional() }))
        .parse([...source.items.flatMap((item) => item.kind === 'user' ? item.images ?? [] : []), ...(source.images ?? [])]);
      if (query.listImages) return { kind: 'source_images', ref: query.ref, images: images.map(({ mimeType, name }, imageIndex) => ({ imageIndex, mimeType, ...(name === undefined ? {} : { name }) })) };
      const image = images[query.imageIndex!];
      if (!image) throw new Error('Retained source image index does not exist.');
      return { kind: 'source_image', image };
    }
    const candidate = r.candidates.find((c) => c.id === query.ref);
    const contents = candidate ? JSON.stringify(await this.deps.workspaces.candidate(candidate.id)) : (query.ref === r.sourceSnapshotId ? await this.deps.store.readSource(r.id, query.ref) : await this.deps.store.readArtifact(r.id, query.ref)).toString('utf8');
    const offset = query.offset ?? 0, limit = query.limit ?? 24_000;
    return { ref: query.ref, text: contents.slice(offset, offset + limit), nextOffset: offset + limit < contents.length ? offset + limit : undefined, totalCharacters: contents.length };
  }
  private toolTransaction(binding: MissionToolBinding, name: string, request: MissionToolRequest, apply: (r: MissionRecord) => MissionRecord): Promise<MissionRecord> {
    return this.deps.store.transact(binding.missionId, { idempotencyKey: identity('tool', actorKey(binding.actor), request.idempotencyKey), actor: actorKey(binding.actor), expectedRevision: request.expectedRevision!, kind: name, request }, (r) => {
      if (terminal(r) || binding.questionId || this.fenced.has(r.id) || !this.turns.has(binding.actor.sessionId)) throw new Error('Mission mutation requires an active execution turn; completed answers are read-only.');
      // Revalidate the current generation at the actual serialized boundary, not only before IO.
      if (binding.actor.kind === 'lead' && (r.leadSessionId !== binding.actor.sessionId || r.leadGeneration !== binding.actor.generation)) throw new Error('Stale lead generation.');
      if (binding.actor.kind === 'worker' && !r.attempts.some((a) => binding.actor.kind === 'worker' && a.id === binding.actor.attemptId && active(a) && a.sessionId === binding.actor.sessionId && a.generation === binding.actor.generation)) throw new Error('Stale worker generation.');
      if (name === 'mission_plan_update' && (request.payload.material as { source?: { kind?: string } } | undefined)?.source?.kind === 'user_instruction') {
        if (binding.actor.kind !== 'lead') throw new Error('Only the principal engineer may interpret user instructions.');
        const live = this.turns.get(binding.actor.sessionId)!;
        const operation = r.operations.find((op) => op.id === live.operationId && op.kind === 'dispatch' && op.state === 'in_flight');
        const item = r.mailbox.findLast((mail) => mail.kind === 'user');
        const action = item?.userAction;
        if (!item || !action || action.kind === 'authorization' || action.appliedPlanRevision !== undefined || item.deliveredAt === undefined
          || action.specificationRevision !== r.specificationRevision || action.planRevision !== r.planRevision
          || operation?.payload.dispatchStartedAt === undefined || !(operation.payload.mailboxIds as string[] | undefined)?.includes(item.id)) {
          throw new Error('Material change needs the latest unconsumed user instruction delivered in this lead turn at the current plan/specification. Ask the user again if its context changed; old answers are not authority.');
        }
        action.materialBinding = { revision: r.revision, operationId: operation.id, sessionId: binding.actor.sessionId, generation: binding.actor.generation };
      }
      const progress = missionProgressSnapshot(r);
      const next = apply(r); next.updatedAt = Date.now();
      if (missionMadeProgress(progress, next)) next.progress.lastProgressRevision = r.revision;
      assertMissionRecord(next); return next;
    }).then((r) => {
      this.publish(r.id);
      if (name === 'mission_plan_update' && r.status === 'pausing') {
        this.fenced.add(r.id); this.deps.scheduler.pause(r.id); this.cancelWorkspaceWaiters(r.id); this.deps.verification.cancel(r.id); this.broker.revoke(r.id);
        this.background(`reconcile:${r.id}`, () => this.reconcile(r.id, false));
      }
      return r;
    });
  }

  private async requestAttempt(binding: MissionToolBinding, name: 'mission_task_claim' | 'mission_task_delegate', request: MissionToolRequest): Promise<unknown> {
    if (binding.actor.kind !== 'lead') throw new Error('Only the principal engineer dispatches specialists; delegation depth is one.');
    const payload = name === 'mission_task_claim' ? z.strictObject({ taskId: key }).parse(request.payload)
      : z.strictObject({ taskId: key, presetId: key, reason: text, candidateId: key.optional() }).parse(request.payload);
    const opId = identity('op', binding.missionId, binding.actor.sessionId, request.idempotencyKey);
    const attemptId = identity('a', opId);
    const sessionId = name === 'mission_task_claim' ? binding.actor.sessionId : identity('s', attemptId);
    const state = await this.toolTransaction(binding, name, request, (r) => {
      const task = r.tasks.find((t) => t.id === payload.taskId);
      if (!task) throw new Error('Unknown task.');
      if ((name === 'mission_task_claim') !== (task.assignment.kind === 'lead')) throw new Error('Task assignment does not match this dispatch.');
      if (r.phase === 'planning' && r.executionAuthorization && r.baseline) r = reduceMission(r, binding.actor, { kind: 'phase.set', phase: 'executing' });
      if (!readyTasks(r).some((t) => t.id === task.id) || r.operations.some((o) => pending(o) && o.kind === 'dispatch' && o.payload.taskId === task.id)) throw new Error('Task dependencies, authorization, or current attempt prevent admission.');
      const profile = task.assignment.kind === 'worker' ? r.profiles.find((p) => task.assignment.kind === 'worker' && p.id === task.assignment.profileId && p.revision === task.assignment.profileRevision)! : undefined;
      const presetId = 'presetId' in payload ? String(payload.presetId) : r.leadPreset.id;
      const tier = profile?.tierId ?? 5;
      if (!r.config.tiers.find((t) => t.id === tier)?.presetIds.includes(presetId)) throw new Error('Choose a whole approved preset in the profile’s pinned tier.');
      if (r.config.limits.maxDelegationDepth !== 1) throw new Error('Only depth-one delegation is supported.');
      const candidateId = 'candidateId' in payload ? payload.candidateId : undefined;
      if (candidateId && (profile?.sourceAccess !== 'read_only' || !profile.contextRefs.includes(String(candidateId)) || !r.candidates.some((c) => c.id === candidateId && c.specificationRevision === r.specificationRevision))) throw new Error('Exact-candidate assignment requires a read-only profile explicitly assigned that current candidate reference.');
      return reduceMission(r, host, { kind: 'host.operation.record', operation: { id: opId, idempotencyKey: opId, kind: 'dispatch', actor: actorKey(binding.actor), expectedRevision: r.revision, state: 'intent_recorded', payload: { taskId: task.id, taskRevision: task.revision, specificationRevision: r.specificationRevision, presetId, attemptId, sessionId, workspaceId: identity('w', attemptId), generation: name === 'mission_task_claim' ? r.leadGeneration : 1, candidateId, reason: 'reason' in payload ? payload.reason : 'Principal engineer direct implementation', claim: name === 'mission_task_claim' } } });
    });
    this.background(opId, () => this.dispatchAttempt(state.id, opId));
    return { operationId: opId, attemptId, sessionId, status: 'queued', revision: state.revision };
  }

  private async dispatchAttempt(id: string, opId: string): Promise<void> {
    const initial = this.record(id), op = initial.operations.find((o) => o.id === opId)!;
    if (op.state !== 'intent_recorded') return;
    const task = initial.tasks.find((t) => t.id === op.payload.taskId)!;
    const profile = task.assignment.kind === 'worker' ? initial.profiles.find((p) => task.assignment.kind === 'worker' && p.id === task.assignment.profileId && p.revision === task.assignment.profileRevision)! : undefined;
    const preset = profile ? initial.config.presets.find((p) => p.id === op.payload.presetId)! : initial.leadPreset;
    const sessionId = String(op.payload.sessionId), attemptId = String(op.payload.attemptId);
    let lease: CapacityLease | undefined;
    try {
      if (!preset) throw new Error('Pinned preset is no longer present in the Mission snapshot.');
      this.config(initial, preset, profile?.sourceAccess ?? 'assigned_workspace', '');
      if (initial.providerRestrictions.allowedProviderIds && !initial.providerRestrictions.allowedProviderIds.includes(preset.model.provider)
        || initial.providerRestrictions.allowedConnectionIds && !initial.providerRestrictions.allowedConnectionIds.includes(preset.model.connectionId ?? preset.model.provider)) throw new Error('Pinned provider/connection is outside this Mission’s grants.');
      const settings = this.deps.settings(initial.projectRoot);
      const revoked = checkMissionPresetRevocation(preset, settings.config, settings.project);
      if (revoked.revoked) throw new Error(revoked.reasons.join(' '));
      if (!profile && !this.deps.sessions.activity(sessionId).quiescent) {
        // The claim was made by the current lead turn. Reconfigure at its terminal boundary,
        // never grant writable tools to the already-running read-only planning runtime.
        return;
      }
      lease = await this.deps.scheduler.acquire({ missionId: id, ownerId: opId, kind: profile ? 'worker' : 'lead', accountId: preset.model.connectionId ?? preset.model.provider });
      this.assertAdmission(id);
      const current = this.record(id);
      if (!readyTasks(current).some((t) => t.id === task.id && t.revision === op.payload.taskRevision) || current.specificationRevision !== op.payload.specificationRevision) throw new Error('Queued task contract became stale before admission.');
      await this.opState(id, opId, 'in_flight');
      const reviewCandidate = op.payload.candidateId ? current.candidates.find((c) => c.id === op.payload.candidateId) : undefined;
      // Every claim has its own immutable input and writable tree, including the lead's.
      // A stopped attempt may have uncaptured bytes: never refresh it or adopt those bytes as
      // a new task's candidate. Its retained workspace remains available for inspection.
      const w = reviewCandidate
        ? await this.deps.workspaces.provisionVerification({ missionId: id, revision: reviewCandidate.revision, operationId: opId })
        : await this.deps.workspaces.provision({ missionId: id, baseline: this.baseline(current), role: profile ? 'worker' : 'lead', attemptId, workspaceId: String(op.payload.workspaceId) });
      this.assertAdmission(id);
      if (!reviewCandidate && !sameRevision(w.baseRevision, current.acceptedRevision!)) throw new Error('Attempt workspace does not match its accepted input revision.');
      const attempt: MissionAttempt = { id: attemptId, taskId: task.id, taskRevision: task.revision, specificationRevision: current.specificationRevision, generation: profile ? 1 : current.leadGeneration,
        sessionId, profile, tierId: profile?.tierId ?? 5, preset, selectionReason: String(op.payload.reason), sourceRevision: w.baseRevision, workspaceId: w.id,
        continuationOwner: 'mission', status: 'created', repairTurns: 0, requestedAt: Date.now() };
      await this.change(id, `${opId}-attempt`, (r) => {
        if (!r.workspaces.some((v) => v.id === w.id)) r = reduceMission(r, host, { kind: 'host.workspace.register', workspace: this.workspace(w, sessionId) });
        r.operations.find((o) => o.id === opId)!.payload.workspaceId = w.id;
        r = reduceMission(r, host, { kind: 'host.attempt.create', attempt });
        return reduceMission(r, host, { kind: 'host.attempt.transition', attemptId, expectedStatus: 'created', status: 'starting', at: Date.now() });
      });
      const ownership: MissionOwnership = { missionId: id, role: profile ? 'worker' : 'lead', generation: attempt.generation, attemptId, sourceAccess: profile?.sourceAccess ?? 'assigned_workspace', requestedTools: profile?.requestedTools ?? task.requiredTools, reasoningDefault: preset.reasoning.kind === 'default' };
      const r = this.record(id);
      const config = this.config(r, preset, ownership.sourceAccess, profile ? missionWorkerPolicy(r, task, attempt) : missionLeadPolicy(r));
      await this.waitForWorkspace(id, w.cwd);
      if (profile) await this.deps.sessions.createManaged({ title: `${profile.name}: ${task.objective}`, config }, { id: sessionId, cwd: w.cwd, worktreeBranch: w.branch, ownership });
      else { await this.deps.sessions.stopManaged(sessionId, attempt.generation); await this.deps.sessions.updateManaged(sessionId, attempt.generation, { config, mission: ownership, cwd: w.cwd, worktreeBranch: w.branch }); }
      this.turns.set(sessionId, { operationId: opId, lease, generation: attempt.generation }); lease = undefined;
      await this.change(id, `${opId}-running`, (state) => reduceMission(state, host, { kind: 'host.attempt.transition', attemptId, expectedStatus: 'starting', status: 'running', at: Date.now() }));
      await this.markRuntimeStart(id, opId);
      await this.deps.sessions.sendManaged(sessionId, { text: profile ? missionWorkerBrief(r, task, attempt) : `You claimed task ${task.id}. Work only in your assigned lead workspace ${w.id} at ${w.cwd}, starting from accepted content ${w.baseRevision.contentHash}, and report a structured result. Earlier attempt workspaces in mission_read are retained for read-only inspection, not accepted input or permission to edit them. Reimplement any useful partial work deliberately within this task's scope; nothing was automatically copied or promoted.\n${JSON.stringify(task)}` }, attempt.generation);
    } catch (e) {
      lease?.release(true);
      await this.dispatchFailure(id, opId, sessionId, message(e));
    }
  }

  private onEvent(env: SessionEventEnvelope): void {
    const meta = this.deps.sessions.get(env.sessionId);
    if (!meta?.mission || this.closed) return;
    const live = this.turns.get(env.sessionId);
    if (env.event.type === 'usage') {
      const r = this.record(meta.mission.missionId);
      const op = r.operations.find((entry) => entry.id === live?.operationId)
        ?? r.operations.findLast((entry) => entry.kind === 'dispatch' && entry.payload.sessionId === meta.id && entry.payload.dispatchStartedAt !== undefined);
      if (op?.payload.dispatchStartedAt !== undefined) {
        const usage = mergeBudgetUsage(this.budgetObservations.get(op.id) ?? { tokens: 0, costUsd: 0 }, budgetUsage(env.event.totals));
        this.budgetObservations.set(op.id, usage);
        if (isMissionQuestionOperation(op) || r.config.limits.maxTokens !== undefined || r.config.limits.maxBudgetUsd !== undefined) this.background(identity('budget-usage', op.id, usage), async () => {
          try { await this.change(r.id, identity('budget-usage', op.id, usage), (state) => { state.operations.find((entry) => entry.id === op.id)!.payload.budgetUsage = this.budgetObservations.get(op.id); return state; }, true); }
          catch (error) {
            const reason = `Mission usage checkpoint failed; budget admission is fenced: ${message(error)}`;
            if (r.status === 'completed') await this.endQuestion(r.id, reason); else this.pauseForBudget(r.id, reason);
          }
        });
      }
      this.budgetGate(r.id);
    }
    if (live?.questionId) {
      if (env.event.type === 'item.upsert' && env.event.item.kind === 'assistant' && env.event.item.text.trim()) live.answerMessageIds!.add(env.event.item.id);
      if (env.event.type === 'item.upsert' && env.event.item.kind === 'tool') live.answerToolIds!.add(env.event.item.id);
      if (env.event.type === 'item.upsert' && env.event.item.kind === 'turn' && !live.terminal) live.terminal = structuredClone(env.event.item);
      const r = this.record(meta.mission.missionId), op = r.operations.find((entry) => entry.id === live.operationId)!;
      const outputBaseline = op.payload.answerOutputBaseline;
      const output = typeof outputBaseline === 'number' && Number.isFinite(outputBaseline) ? Math.max(0, meta.usage.outputTokens - outputBaseline) : undefined;
      const reason = env.event.type === 'error' && env.event.fatal ? `Read-only answer failed: ${env.event.message}` : this.budgetIssue(r)
        ?? (op.payload.dispatchStartedAt !== undefined && output === undefined ? 'Read-only answer output baseline is unknown; no automatic continuation.' : undefined)
        ?? (output !== undefined && output >= ANSWER_MAX_OUTPUT_TOKENS ? 'Read-only answer observed output token limit reached; in-flight usage may overshoot.' : undefined)
        ?? (live.answerToolIds!.size >= ANSWER_MAX_TOOLS ? 'Read-only answer tool-call limit reached.' : undefined);
      if (reason || live.terminal && this.deps.sessions.activity(meta.id).quiescent) void this.endQuestion(r.id, reason).catch((error) => this.deps.log?.(message(error)));
      return; // Never enter the ordinary Mission pump, diagnosis/repair or progress accounting.
    }
    // Trouble belongs only to this durable dispatch/generation. Retired runtime callbacks are
    // fenced by SessionManager too; neither old transcripts nor meta.lastError are attribution.
    if (live && live.generation === meta.mission.generation && currentMissionFailureOwner(this.record(meta.mission.missionId), live.operationId, meta.id, live.generation)) {
      live.trouble = observeMissionTrouble(live.trouble, env.event, meta.config.harness);
      if (env.event.type === 'error' && env.event.fatal) {
        // Fatal normalized errors can end a runtime without a turn card. dispatchFailure waits
        // for SessionManager's exact owned disposal; it never manufactures successful completion.
        live.dispatchFailed = true;
        const reason = env.event.message;
        this.background(`fatal:${live.operationId}`, () => this.dispatchFailure(meta.mission!.missionId, live.operationId, meta.id, reason));
      }
    }
    if (env.event.type === 'item.upsert' && env.event.item.kind === 'turn' && live && live.generation === meta.mission.generation && currentMissionFailureOwner(this.record(meta.mission.missionId), live.operationId, meta.id, live.generation)) {
      const turn = env.event.item;
      if (!live.terminal && !this.record(meta.mission.missionId).operations.some((o) => o.payload.sessionId === env.sessionId && o.payload.terminalTurnId === turn.id)) live.terminal = structuredClone(turn);
    }
    if (env.event.type === 'approval.request') {
      this.deps.sessions.note(this.record(meta.mission.missionId).leadSessionId, `Mission participant ${meta.title} is awaiting a human permission decision. The lead cannot approve it.`);
    }
    this.wake(meta.mission.missionId);
  }
  private wake(id: string): void {
    if (this.closed) return;
    this.dirty.add(id);
    if (this.pumping.has(id)) return;
    this.pumping.add(id);
    const run = Promise.resolve().then(async () => {
      try { while (this.dirty.delete(id)) await this.pump(id); }
      catch (e) { await this.block(id, 'environment', message(e)); }
      finally { this.pumping.delete(id); this.pumpRuns.delete(id); }
    });
    this.pumpRuns.set(id, run);
  }
  private async pump(id: string): Promise<void> {
    let r = this.record(id);
    if (terminal(r)) return;
    if (this.fenced.has(id)) {
      if (['pausing', 'stopping', 'recovering'].includes(r.status)) this.background(`reconcile:${id}`, () => this.reconcile(id, r.status === 'recovering'));
      return;
    }
    for (const [sessionId, live] of this.turns) {
      if (this.deps.sessions.get(sessionId)?.mission?.missionId !== id || !live.terminal || !this.deps.sessions.activity(sessionId).quiescent || this.deps.additionalActivity?.(r)) continue;
      await this.settleTurn(id, sessionId, live);
    }
    r = this.record(id);
    if (r.status !== 'running' || this.fenced.has(id)) return;
    for (const op of r.operations.filter((o) => o.state === 'intent_recorded')) {
      if (op.payload.claim === true && this.deps.sessions.activity(r.leadSessionId).quiescent) this.background(op.id, () => this.dispatchAttempt(id, op.id));
      if (['verify', 'integrate', 'deliver'].includes(op.kind) && !op.payload.parentOperationId && this.isQuiescent(r)) this.background(op.id, () => this.performOperation(id, op.id));
    }
    for (const attempt of r.attempts.filter((a) => active(a) && this.yielded.has(a.sessionId) && !this.turns.has(a.sessionId))) {
      const decision = r.decisions.find((d) => d.requestedBy === attempt.sessionId && d.resolution && !r.operations.some((o) => o.payload.continuation === d.id && o.payload.attemptId === attempt.id));
      if (decision) this.background(identity('continue', attempt.id, decision.id), () => this.continueAttempt(id, attempt, `Decision ${decision.id} resolved: ${decision.resolution}. ${decision.rationale}`, decision.id));
      const evidence = r.evidence.find((e) => e.attemptId === attempt.id && !r.operations.some((o) => o.payload.continuation === e.id && o.payload.attemptId === attempt.id));
      if (!decision && evidence) this.background(identity('continue', attempt.id, evidence.id), () => this.continueAttempt(id, attempt, `Requested check ended: ${evidence.checkId} is ${evidence.result}; evidence ${evidence.id}. Continue or submit the structured result.`, evidence.id));
    }
    if (r.operations.some((o) => pending(o) && o.kind === 'deliver')) return;
    if (this.turns.has(r.leadSessionId) || !this.deps.sessions.activity(r.leadSessionId).quiescent || r.attempts.some((a) => a.sessionId === r.leadSessionId && active(a)) || r.operations.some((o) => pending(o) && (o.payload.claim === true || o.payload.lead === true))) return;
    const mail = r.mailbox.filter((m) => m.deliveredAt === undefined).sort((a, b) => priority[a.kind] - priority[b.kind] || a.createdAt - b.createdAt);
    if (!mail.length) return;
    // Baseline blockers permit read-only dialogue, not implementation. Other capability blockers
    // are still enforced by the live exact-preset probe immediately before every send.
    const opId = identity('op', id, 'mail', mail.map((m) => m.id));
    this.background(opId, () => this.sendLead(id, opId, mail));
  }

  private async sendLead(id: string, opId: string, mail: MissionMailboxItem[]): Promise<void> {
    let lease: CapacityLease | undefined;
    const initial = this.record(id);
    if (initial.operations.some((o) => o.id === opId)) return;
    try {
      await this.change(id, `${opId}-intent`, (r) => {
        if (r.status !== 'running' || this.fenced.has(id)) throw new Error('Lead dispatch is paused.');
        if (r.operations.some((o) => pending(o) && (o.payload.lead === true || o.payload.claim === true))) throw new Error('The principal engineer already owns a pending dispatch.');
        // Read-only planning may inspect dirty input; blockers remain present and authoritative
        // for every implementation operation. No implementation grant is fabricated here.
        r.operations.push({ id: opId, idempotencyKey: opId, kind: 'dispatch', actor: 'host', expectedRevision: r.revision, state: 'intent_recorded', payload: { lead: true, generation: r.leadGeneration, sessionId: r.leadSessionId, mailboxIds: mail.map((m) => m.id) } });
        return r;
      });
      this.config(initial, initial.leadPreset, 'read_only', '');
      const settings = this.deps.settings(initial.projectRoot);
      const revoked = checkMissionPresetRevocation(initial.leadPreset, settings.config, settings.project);
      if (revoked.revoked) throw new Error(revoked.reasons.join(' '));
      lease = await this.deps.scheduler.acquire({ missionId: id, ownerId: opId, kind: 'lead', accountId: initial.leadPreset.model.connectionId ?? initial.leadPreset.model.provider });
      this.assertAdmission(id, true);
      await this.ensureLead(id);
      const meta = this.deps.sessions.get(initial.leadSessionId)!;
      const workspace = this.leadWorkspace(this.record(id)), cwd = workspace?.path ?? this.record(id).sourceCwd;
      await this.waitForWorkspace(id, cwd);
      if (meta.mission?.sourceAccess !== 'read_only' || meta.mission.generation !== this.record(id).leadGeneration || meta.cwd !== cwd || meta.worktreeBranch !== workspace?.branch) {
        await this.deps.sessions.stopManaged(meta.id, meta.mission!.generation);
        await this.deps.sessions.updateManaged(meta.id, meta.mission!.generation, { cwd, worktreeBranch: workspace?.branch,
          mission: { generation: this.record(id).leadGeneration, sourceAccess: 'read_only', attemptId: undefined }, config: this.config(this.record(id), initial.leadPreset, 'read_only', missionLeadPolicy(this.record(id))) });
      }
      await this.opState(id, opId, 'in_flight');
      this.turns.set(initial.leadSessionId, { operationId: opId, lease, generation: this.record(id).leadGeneration }); lease = undefined;
      this.yielded.delete(initial.leadSessionId);
      await this.markRuntimeStart(id, opId);
      const images: ImageAttachment[] = [];
      for (const item of mail) for (const attachment of item.attachments ?? []) {
        const image = userImageSchema.parse(JSON.parse((await this.deps.store.readArtifact(id, attachment.ref)).toString('utf8')));
        if (image.mimeType !== attachment.mimeType || image.name !== attachment.name) throw new Error('Retained user attachment metadata does not match its immutable content.');
        images.push(image);
      }
      await this.deps.sessions.sendManaged(initial.leadSessionId, { text: mail.map((m) => `[${m.kind}; ${m.id}]\n${m.text}${m.attachments?.length ? `\nRetained image references: ${m.attachments.map((a) => a.ref).join(', ')}` : ''}${m.userAction && m.userAction.kind !== 'authorization' ? '\nFor a material correction, use mission_plan_update material.source:{kind:"user_instruction"}; the host binds this delivered instruction once. Preserve required criteria. This is not execution or permission approval.' : ''}`).join('\n\n'), ...(images.length ? { images } : {}) }, this.record(id).leadGeneration);
    } catch (e) { lease?.release(true); await this.dispatchFailure(id, opId, initial.leadSessionId, message(e)); }
  }

  private async settleTurn(id: string, sessionId: string, live: LiveTurn): Promise<void> {
    const end = live.terminal!;
    const before = this.record(id);
    const meta = this.deps.sessions.get(sessionId);
    if (live.dispatchFailed || this.turns.get(sessionId) !== live || meta?.mission?.generation !== live.generation || !currentMissionFailureOwner(before, live.operationId, sessionId, live.generation)) return;
    const operation = before.operations.find((op) => op.id === live.operationId)!;
    const attempt = before.attempts.find((a) => a.id === operation.payload.attemptId);
    const requested = attempt?.preset ?? before.leadPreset;
    const adherence = checkMissionPresetAdherence(requested, { model: meta.activeModel, reasoning: meta.activeEffort ? { kind: 'explicit', value: meta.activeEffort } : undefined });
    const failed = end.status !== 'completed' || adherence.status === 'mismatch';
    const diagnosis = classifyMissionTurn(end, live.trouble, attempt?.result?.status === 'failed' || attempt?.result?.status === 'blocked', adherence.status === 'mismatch' ? adherence.mismatches : []);
    let settledCurrent = false;
    await this.change(id, identity('turn', sessionId, live.generation, end.id), (r) => {
      if (live.dispatchFailed || this.turns.get(sessionId) !== live || this.deps.sessions.get(sessionId)?.mission?.generation !== live.generation || !currentMissionFailureOwner(r, live.operationId, sessionId, live.generation)) return r;
      settledCurrent = true;
      r.progress.completedTurns++;
      if (attempt) {
        const saved = r.attempts.find((a) => a.id === attempt.id)!;
        if (meta.activeModel) saved.effectiveModel = { provider: meta.activeModel.provider, model: meta.activeModel.model };
        if (meta.activeEffort) saved.effectiveEffort = meta.activeEffort;
      }
      if (attempt && (failed || attempt.result)) {
        const result = r.attempts.find((a) => a.id === attempt.id)!.result;
        r = reduceMission(r, host, { kind: 'host.attempt.transition', attemptId: attempt.id, expectedStatus: attempt.status, status: 'terminal', at: Date.now(), terminalTurnId: end.id,
          outcome: failed ? (end.status === 'interrupted' ? 'interrupted' : 'failed') : result?.status === 'candidate' ? 'submitted' : result?.status === 'failed' ? 'failed' : 'partial',
          failure: diagnosis });
      }
      const op = r.operations.find((o) => o.id === live.operationId);
      if (op) {
        op.payload.terminalTurnId = end.id;
        if (diagnosis) op.payload.failure = diagnosis;
        if (this.budgetObservations.has(op.id)) op.payload.budgetUsage = this.budgetObservations.get(op.id);
        if (r.progress.completedTurns % r.config.limits.progressCheckpointEveryTurns === 0) {
          const previous = Math.max(0, ...r.operations.map((o) => typeof o.payload.progressCheckpointRevision === 'number' ? o.payload.progressCheckpointRevision : 0));
          r.progress.checkpointsWithoutProgress = r.progress.lastProgressRevision > previous ? 0 : r.progress.checkpointsWithoutProgress + 1;
          op.payload.progressCheckpointRevision = r.revision;
        }
      }
      if (op && pending(op)) r = reduceMission(r, host, { kind: 'host.operation.transition', operationId: op.id, expectedState: op.state, state: failed ? 'failed' : 'succeeded', error: failed ? `Turn ${end.status}; effective preset ${adherence.status}.` : undefined });
      return r;
    });
    if (!settledCurrent || this.turns.get(sessionId) !== live) return;
    this.turns.delete(sessionId); live.lease.release(true);
    if (this.budgetIssue(this.record(id))) {
      // Capture an already-settled submitted result before pausing; this is retained work, not
      // another model dispatch. Every competing admission still rechecks the same budget gate.
      const settled = this.record(id).attempts.find((a) => a.id === attempt?.id);
      if (settled?.outcome === 'submitted' && settled.result?.status === 'candidate') await this.capture(id, settled);
      this.budgetGate(id); return;
    }
    if (attempt) {
      const settled = this.record(id).attempts.find((a) => a.id === attempt.id)!;
      if (settled.status === 'terminal') {
        if (settled.result?.status === 'candidate' && settled.outcome === 'submitted') await this.capture(id, settled);
        const reported = settled.failure && settled.result ? `\nWorker-reported result (not host-verified): ${JSON.stringify({ status: settled.result.status, summary: settled.result.summary, unresolved: settled.result.unresolved })}` : '';
        await this.mail(id, { id: identity('mail', settled.id, 'terminal'), kind: settled.failure?.recovery === 'user_action' ? 'permission' : settled.outcome === 'submitted' ? 'candidate' : 'decision', sessionId, taskId: settled.taskId, text: `Attempt ${settled.id} ended: ${settled.outcome}. ${settled.failure ? missionFailureNotice(settled.failure) : settled.result?.summary ?? 'No valid result.'}${reported}`, artifactIds: settled.result?.artifactIds ?? [], createdAt: Date.now() });
        if (settled.failure?.recovery === 'user_action') { this.pauseForObservedFailure(id, live.operationId); return; }
      } else if (!this.yielded.has(sessionId)) {
        if (settled.repairTurns === 0) await this.repair(id, settled);
        else {
          await this.change(id, `${settled.id}-protocol-failure`, (r) => reduceMission(r, host, { kind: 'host.attempt.transition', attemptId: settled.id, expectedStatus: settled.status, status: 'terminal', at: Date.now(), terminalTurnId: end.id, outcome: 'failed', failure: { kind: 'protocol', message: 'No structured result after one format-repair turn.' } }));
          await this.mail(id, { id: identity('mail', settled.id, 'protocol-failure'), kind: 'decision', sessionId, taskId: settled.taskId,
            text: `Attempt ${settled.id} failed the structured-result protocol after one repair. Diagnose its retained transcript before selecting another attempt.`, artifactIds: [], createdAt: Date.now() });
        }
      }
    } else if (failed) {
      if (diagnosis?.recovery === 'user_action') {
        await this.mail(id, { id: identity('mail', live.operationId, 'failure'), kind: 'permission', sessionId, text: missionFailureNotice(diagnosis), artifactIds: [], createdAt: Date.now() });
        this.pauseForObservedFailure(id, live.operationId); return;
      }
      this.fenced.add(id); this.deps.scheduler.pause(id);
      await this.block(id, diagnosis?.kind ?? 'unknown', `The principal engineer failed. ${diagnosis ? missionFailureNotice(diagnosis) : ''} Pause/reconcile and explicitly resume; no automatic replacement or new worker admission.`, 'lead_dispatch');
      await this.change(id, `${live.operationId}-lead-blocked`, (r) => { r.status = 'blocked'; return r; });
    } else if (!this.yielded.has(sessionId) && this.record(id).status === 'running' && !this.record(id).mailbox.some((m) => m.deliveredAt === undefined)) {
      const r = this.record(id);
      if (!r.operations.some((o) => pending(o) && (o.payload.claim || o.kind === 'deliver'))) {
        await this.mail(id, { id: identity('mail', sessionId, end.id), kind: 'progress', sessionId, text: 'Continue the Mission from the recorded state. Use typed tools to advance a required outcome, ask a planning question, propose execution, or yield for named events. Quiet text and GOAL_COMPLETE are not completion.', artifactIds: [], createdAt: Date.now() });
      }
    }
    const after = this.record(id);
    if (after.progress.checkpointsWithoutProgress >= after.config.limits.maxNoProgressCheckpoints && after.status === 'running') {
      this.fenced.add(id); this.deps.scheduler.pause(id); this.cancelWorkspaceWaiters(id);
      await this.block(id, 'requirements', 'Repeated progress checkpoints produced no new candidate, captured evidence, accepted outcome, or resolved decision. Automation paused for lead diagnosis.');
      await this.change(id, `no-progress-${after.revision}`, (r) => reduceMission(r, host, { kind: 'host.recover' }));
      await this.reconcile(id, false, false);
    }
    this.wake(id);
  }

  /** A credential/denial observation never becomes model approval. Reconcile outside the
   * dispatch/pump job so stopping cannot wait on itself. Explicit Resume rechecks live grants. */
  private pauseForObservedFailure(id: string, operationId: string): void {
    if (this.fenced.has(id) || terminal(this.record(id))) return;
    this.fenced.add(id); this.deps.scheduler.pause(id); this.cancelWorkspaceWaiters(id);
    this.broker.revoke(id); this.deps.verification.cancel(id);
    this.background(`failure-pause:${operationId}`, async () => {
      await this.change(id, `${operationId}-failure-pause`, (r) => { if (!terminal(r) && !['stopping', 'recovering'].includes(r.status)) r.status = 'pausing'; return r; });
      await this.reconcile(id, false);
    });
  }

  private async continueAttempt(id: string, attempt: MissionAttempt, instruction: string, cause: string): Promise<void> {
    if (!this.deps.sessions.activity(attempt.sessionId).quiescent) return; // The next terminal/tool event owns the safe boundary.
    const opId = identity('op', attempt.id, cause);
    if (this.record(id).operations.some((o) => o.id === opId)) return;
    await this.change(id, `${opId}-intent`, (r) => reduceMission(r, host, { kind: 'host.operation.record', operation: { id: opId, idempotencyKey: opId, actor: 'host', kind: 'dispatch', expectedRevision: r.revision, state: 'intent_recorded', payload: { attemptId: attempt.id, sessionId: attempt.sessionId, continuation: cause } } }));
    let lease: CapacityLease | undefined;
    try {
      lease = await this.deps.scheduler.acquire({ missionId: id, ownerId: opId, kind: attempt.profile ? 'worker' : 'lead', accountId: attempt.preset.model.connectionId ?? attempt.preset.model.provider });
      this.assertAdmission(id);
      await this.opState(id, opId, 'in_flight');
      this.yielded.delete(attempt.sessionId);
      this.turns.set(attempt.sessionId, { operationId: opId, lease, generation: attempt.generation }); lease = undefined;
      await this.markRuntimeStart(id, opId);
      await this.deps.sessions.sendManaged(attempt.sessionId, { text: instruction }, attempt.generation);
    } catch (e) { lease?.release(true); await this.dispatchFailure(id, opId, attempt.sessionId, message(e)); }
  }

  private async repair(id: string, attempt: MissionAttempt): Promise<void> {
    await this.change(id, `${attempt.id}-repair`, (r) => reduceMission(r, host, { kind: 'host.attempt.repair', attemptId: attempt.id }));
    const opId = identity('op', attempt.id, 'repair');
    await this.change(id, `${opId}-intent`, (r) => reduceMission(r, host, { kind: 'host.operation.record', operation: { id: opId, idempotencyKey: opId, actor: 'host', kind: 'dispatch', expectedRevision: r.revision, state: 'intent_recorded', payload: { attemptId: attempt.id, sessionId: attempt.sessionId, repair: true } } }));
    this.background(opId, async () => {
      let lease: CapacityLease | undefined;
      try {
        lease = await this.deps.scheduler.acquire({ missionId: id, ownerId: opId, kind: attempt.profile ? 'worker' : 'lead', accountId: attempt.preset.model.connectionId ?? attempt.preset.model.provider });
        this.assertAdmission(id);
        await this.opState(id, opId, 'in_flight');
        this.turns.set(attempt.sessionId, { operationId: opId, lease, generation: attempt.generation }); lease = undefined;
        await this.markRuntimeStart(id, opId);
        await this.deps.sessions.sendManaged(attempt.sessionId, { text: `One result-format repair only: submit mission_report with result bound to task ${attempt.taskId}@${attempt.taskRevision}, attempt ${attempt.id}, specification ${attempt.specificationRevision}. Report candidate, partial, blocked or failed truthfully; do not invent evidence.` }, attempt.generation);
      } catch (e) { lease?.release(true); await this.dispatchFailure(id, opId, attempt.sessionId, message(e)); }
    });
  }

  private async capture(id: string, attempt: MissionAttempt): Promise<void> {
    const opId = identity('op', attempt.id, 'capture');
    await this.change(id, `${opId}-intent`, (r) => reduceMission(r, host, { kind: 'host.operation.record', operation: { id: opId, idempotencyKey: opId, actor: 'host', kind: 'capture', expectedRevision: r.revision, state: 'intent_recorded', payload: { attemptId: attempt.id, workspaceId: attempt.workspaceId, candidateId: identity('c', attempt.id) } } }));
    await this.opState(id, opId, 'in_flight');
    try {
      const candidate = await this.deps.workspaces.captureCandidate(attempt.workspaceId, attempt.id, identity('c', attempt.id));
      await this.change(id, `${opId}-candidate`, (r) => reduceMission(r, host, { kind: 'host.candidate.capture', candidate: {
        id: candidate.id, attemptId: attempt.id, taskId: attempt.taskId, taskRevision: attempt.taskRevision, specificationRevision: attempt.specificationRevision,
        sourceRevision: attempt.sourceRevision, revision: candidate.revision, changedPaths: [...candidate.changedPaths], capturedAt: Date.parse(candidate.createdAt),
      } }));
      await this.opState(id, opId, 'succeeded');
    } catch (e) { await this.opState(id, opId, 'failed', message(e)); await this.block(id, 'integration', `Candidate capture failed for ${attempt.id}: ${message(e)}`); }
  }

  private async requestOperation(binding: MissionToolBinding, name: MissionToolName, request: MissionToolRequest): Promise<unknown> {
    const kind = name === 'mission_verification_request' ? 'verify' : name === 'mission_integration_request' ? 'integrate' : 'deliver';
    if (kind !== 'verify' && binding.actor.kind !== 'lead') throw new Error('Only the principal engineer can integrate or request completion.');
    const payload = kind === 'verify' ? z.strictObject({ checkId: key, candidateId: key.optional() }).parse(request.payload)
      : kind === 'integrate' ? z.union([z.strictObject({ candidateId: key, expectedContentHash: key }), z.strictObject({ target: z.literal('approved'), expectedContentHash: key })]).parse(request.payload)
        : z.strictObject({ commitMessage: text.optional(), report: text.optional() }).parse(request.payload);
    const opId = identity('op', binding.missionId, actorKey(binding.actor), request.idempotencyKey);
    const r = await this.toolTransaction(binding, name, request, (state) => {
      if (kind === 'verify' && binding.actor.kind === 'worker') {
        const attempt = state.attempts.find((a) => binding.actor.kind === 'worker' && a.id === binding.actor.attemptId)!;
        if (!('candidateId' in payload) || !state.candidates.some((c) => c.id === payload.candidateId && (c.attemptId === attempt.id || attempt.profile?.contextRefs.includes(c.id) && sameRevision(c.revision, attempt.sourceRevision)))) throw new Error('Worker verification must reference its own captured candidate or its assigned exact-content review.');
      }
      if (kind === 'verify' && (!state.executionAuthorization || !['executing', 'verifying'].includes(state.phase))) throw new Error('Planning cannot run project scripts. Authorize execution before requesting a check.');
      let checkScope: string | undefined;
      if (kind === 'verify') {
        const check = state.deliveryPolicy.checks.find((c) => 'checkId' in payload && c.id === payload.checkId);
        if (!check) throw new Error('Unknown approved check; register the required check before requesting execution.');
        const candidate = 'candidateId' in payload && payload.candidateId ? state.candidates.find((c) => c.id === payload.candidateId) : undefined;
        if ('candidateId' in payload && payload.candidateId && !candidate) throw new Error('Unknown immutable candidate.');
        const revision = candidate?.revision ?? state.acceptedRevision;
        if (!revision) throw new Error('Verification requires an accepted content revision.');
        checkScope = verificationScope(state.specificationRevision, check, revision);
        const issue = verificationRetryIssue(state, checkScope);
        if (issue) throw new Error(issue.message);
        if (state.operations.some((o) => o.kind === 'verify' && pending(o) && o.payload.verificationScope === checkScope)) throw new Error('This exact check/content already has a pending verification; wait for its retained outcome before requesting another.');
      }
      if (kind === 'integrate' && 'target' in payload) {
        if (!state.executionAuthorization || state.phase === 'planning') throw new Error('Planning cannot fetch or integrate a delivery target.');
        if (state.deliveryPolicy.endpoint === 'local_commit' || !state.deliveryPolicy.remote || !state.deliveryPolicy.targetBranch || state.deliveryPolicy.conflicts.length) throw new Error('No unambiguous approved remote target is configured.');
      }
      if (kind === 'deliver') {
        if (binding.actor.kind !== 'lead') throw new Error('Principal engineer required.');
        if (state.phase !== 'verifying' && state.phase !== 'delivering') state = reduceMission(state, binding.actor, { kind: 'phase.set', phase: 'verifying' });
        if (state.phase !== 'delivering') state = reduceMission(state, binding.actor, { kind: 'phase.set', phase: 'delivering' });
      }
      return reduceMission(state, host, { kind: 'host.operation.record', operation: { id: opId, idempotencyKey: opId, actor: actorKey(binding.actor), kind, expectedRevision: state.revision, state: 'intent_recorded', payload: { ...payload, ...(kind === 'verify' ? { executionKind: 'coordination', verificationScope: checkScope } : {}), requesterAttemptId: binding.actor.kind === 'worker' ? binding.actor.attemptId : undefined, specificationRevision: state.specificationRevision, expectedAccepted: state.acceptedRevision, executionAuthorization: state.executionAuthorization, requestedPermissionMode: state.requestedPermissionMode, targetBranch: state.deliveryPolicy.targetBranch, remote: state.deliveryPolicy.remote } } });
    });
    this.wake(r.id);
    return { operationId: opId, status: 'queued', revision: r.revision };
  }

  private async performOperation(id: string, opId: string): Promise<void> {
    const r = this.record(id), op = r.operations.find((o) => o.id === opId)!;
    try {
      this.assertAdmission(id);
      if (!r.acceptedRevision || op.payload.specificationRevision !== r.specificationRevision || !sameRevision(op.payload.expectedAccepted as MissionCodeRevision, r.acceptedRevision)) throw new Error('Operation inputs are stale; request against the current accepted content.');
      if (op.kind === 'deliver') {
        await this.opState(id, opId, 'in_flight');
        const repositoryPolicy = await this.deps.delivery.resolve(r.projectRoot, { changedPaths: await this.deps.workspaces.acceptedChangedPaths(id),
          ...(r.publicationRestrictions?.at(-1)?.endpoint === 'local_commit' ? { localOnly: true } : {}) });
        await this.change(id, `${opId}-policy`, (state) => {
          const previous = state.deliveryPolicy;
          const resolved = restrictPublication(repositoryPolicy, state.publicationRestrictions?.at(-1)?.endpoint);
          if (resolved.endpoint !== previous.endpoint || resolved.targetBranch !== previous.targetBranch || resolved.remote !== previous.remote || resolved.endpoint !== 'local_commit' && resolved.targetHead !== previous.targetHead || resolved.mergeMethod !== previous.mergeMethod) throw new Error('Delivery policy target changed. If only its head advanced, request mission_integration_request with target:"approved" and the current expectedContentHash, then re-review and reverify; other target changes require user reconciliation.');
          const checks = [...previous.checks];
          for (const check of resolved.checks) {
            const prior = checks.find((c) => c.id === check.id);
            if (prior && !isDeepStrictEqual(prior, check)) throw new Error('A required check contract changed. Register a new check identity and verify it; prior evidence cannot be relabeled.');
            if (!prior) checks.push(check);
          }
          for (const criterionId of new Set(checks.flatMap((check) => check.criterionIds))) {
            if (!state.plan.criteria.some((criterion) => criterion.id === criterionId) && !state.tasks.some((task) => task.criteria.some((criterion) => criterion.id === criterionId))) {
              state.plan.criteria.push({ id: criterionId, description: `Required project verification: ${criterionId}`, required: true,
                evidenceKinds: [...new Set(checks.filter((check) => check.criterionIds.includes(criterionId)).map((check) => check.kind))] });
            }
          }
          if (checks.length !== previous.checks.length) { state.planRevision++; delete state.pendingProposal; }
          state.deliveryPolicy = { ...previous, checks, allowPush: previous.allowPush && resolved.allowPush, allowMerge: previous.allowMerge && resolved.allowMerge,
            requireIndependentReview: previous.requireIndependentReview || resolved.requireIndependentReview,
            holdConditions: [...new Set([...previous.holdConditions, ...resolved.holdConditions])],
            holdIsEndpoint: previous.holdIsEndpoint || resolved.holdIsEndpoint && resolved.holdConditions.length > 0,
            conflicts: [...new Set([...previous.conflicts, ...resolved.conflicts])],
            provenance: [...previous.provenance, ...resolved.provenance.filter((p) => !previous.provenance.some((old) => isDeepStrictEqual(old, p)))] };
          return state;
        });
        const current = this.record(id);
        const blockers = implementationBlockers(current, { quiescent: this.isQuiescent(current), deliveryOperationId: opId });
        if (current.mailbox.some((m) => m.kind === 'user' && m.deliveredAt === undefined)) blockers.push('Unconsumed user instructions remain.');
        if (blockers.length) throw new Error(blockers.join(' '));
        const integration = r.workspaces.find((w) => w.role === 'integration');
        if (!integration) throw new Error('Integration workspace is missing.');
        const workspace = await this.deps.workspaces.workspace(integration.id);
        const materialized = await this.deps.workspaces.materializeAccepted(workspace.id, workspace.fingerprint);
        if (!sameRevision(materialized.baseRevision, r.acceptedRevision)) throw new Error('Accepted workspace content diverged before delivery.');
        this.assertAdmission(id);
        await this.change(id, `${opId}-delivery-boundary`, (state) => {
          this.assertAdmission(id);
          const blockers = implementationBlockers(state, { quiescent: this.isQuiescent(state), deliveryOperationId: opId });
          if (state.mailbox.some((item) => item.kind === 'user' && item.deliveredAt === undefined)) blockers.push('Unconsumed user instructions remain.');
          if (blockers.length) throw new Error(blockers.join(' '));
          const operation = state.operations.find((o) => o.id === opId)!;
          operation.payload.deliveryPolicy = structuredClone(state.deliveryPolicy);
          this.receiptInputs(state, operation, 'deliveryPolicy');
          operation.payload.deliveryRequestedAt = Date.now();
          return state;
        });
        const delivery = await this.deps.delivery.deliver({ mission: this.record(id), operationId: opId, commitMessage: op.payload.commitMessage as string | undefined, report: op.payload.report as string | undefined });
        if (delivery.operationId !== opId) throw new Error('Delivery receipt belongs to a different operation.');
        await this.change(id, `${opId}-receipt`, (state) => {
          this.receiptInputs(state, state.operations.find((o) => o.id === opId)!, 'deliveryPolicy');
          return reduceMission(state, host, { kind: 'host.delivery.record', delivery });
        });
        await this.opState(id, opId, delivery.status === 'delivered' || delivery.status === 'held' ? 'succeeded' : 'failed', delivery.reason ?? 'Delivery did not succeed.');
        await this.change(id, `${opId}-complete`, (state) => reduceMission(state, host, { kind: 'host.complete', quiescent: this.isQuiescent(state) }));
        this.broker.revoke(id); this.fenced.add(id); this.deps.scheduler.unregister(id);
        return;
      }
      if (op.kind === 'integrate' && op.payload.target === 'approved') {
        await this.integrateTarget(id, opId);
      } else if (op.kind === 'integrate') {
        const candidate = r.candidates.find((c) => c.id === op.payload.candidateId);
        if (!candidate || op.payload.expectedContentHash !== r.acceptedRevision.contentHash || r.tasks.find((t) => t.id === candidate.taskId)?.status !== 'accepted') throw new Error('Integration requires an accepted current candidate and matching accepted revision.');
        await this.opState(id, opId, 'in_flight');
        await this.integrationBoundary(id, opId, r);
        const result = await this.deps.workspaces.integrate({ missionId: id, candidateId: candidate.id, expectedAccepted: r.acceptedRevision, check: async (check) => {
          this.assertAdmission(id);
          await this.change(id, `${opId}-workspace`, (state) => reduceMission(state, host, { kind: 'host.workspace.register', workspace: this.workspace(check.workspace) }));
          for (const configured of r.deliveryPolicy.checks.filter((c) => c.required)) {
            const evidence = await this.runCheck(id, opId, { missionId: id, operationId: identity('check', opId, configured.id), specificationRevision: r.specificationRevision, revision: check.revision, cwd: check.workspace.cwd, check: configured });
            if (evidence.result !== 'passed') return false;
          }
          // Evaluate reducer gates BEFORE the workspace's own CAS, not after blindly applying.
          this.receiptInputs(this.record(id), this.record(id).operations.find((o) => o.id === opId)!, 'integrationPolicy');
          reduceMission(this.record(id), host, { kind: 'host.integration.promote', candidateId: candidate.id, expectedAcceptedRevision: r.acceptedRevision!, revision: check.revision });
          return !this.fenced.has(id);
        } });
        await this.change(id, `${opId}-retained-workspace`, (state) => {
          if (result.workspace) state = reduceMission(state, host, { kind: 'host.workspace.register', workspace: this.workspace(result.workspace) });
          state.operations.find((o) => o.id === opId)!.payload.integrationOutcome = result.status;
          return state;
        });
        if (result.status !== 'accepted') throw new Error(`Integration ${result.status}: ${'message' in result ? result.message : 'accepted revision changed; reconcile before retrying'}. The isolated integration workspace is retained for inspection; replan the affected task and repair in a fresh assigned workspace instead of resetting or reapplying it.`);
        await this.change(id, `${opId}-promotion`, (state) => {
          this.receiptInputs(state, state.operations.find((o) => o.id === opId)!, 'integrationPolicy');
          state = reduceMission(state, host, { kind: 'host.integration.promote', candidateId: candidate.id, expectedAcceptedRevision: r.acceptedRevision!, revision: result.revision });
          state.operations.find((o) => o.id === opId)!.payload.integrationReceipt = { workspaceId: result.workspace.id, revision: result.revision };
          return state;
        });
        await this.opState(id, opId, 'succeeded');
        await this.mail(id, { id: identity('mail', opId, 'integrated'), kind: 'verification', sessionId: r.leadSessionId,
          text: `Candidate ${candidate.id} integrated with captured checks on content ${result.revision.contentHash}.`, artifactIds: [], createdAt: Date.now() });
      } else {
        const candidate = op.payload.candidateId ? r.candidates.find((c) => c.id === op.payload.candidateId) : undefined;
        if (op.payload.candidateId && !candidate) throw new Error('Unknown immutable candidate.');
        const revision = candidate?.revision ?? r.acceptedRevision;
        const check = r.deliveryPolicy.checks.find((c) => c.id === op.payload.checkId);
        if (!check) throw new Error('Unknown approved verification check.');
        await this.opState(id, opId, 'in_flight');
        const workspace = await this.deps.workspaces.provisionVerification({ missionId: id, revision, operationId: opId });
        await this.change(id, `${opId}-workspace`, (state) => reduceMission(state, host, { kind: 'host.workspace.register', workspace: this.workspace(workspace) }));
        this.assertAdmission(id);
        const attempt = r.attempts.find((a) => a.id === (op.payload.requesterAttemptId ?? candidate?.attemptId));
        const evidence = await this.runCheck(id, opId, { missionId: id, operationId: identity('check', opId, check.id), specificationRevision: r.specificationRevision,
          taskId: attempt?.taskId, taskRevision: attempt?.taskRevision, attemptId: attempt?.id, revision, cwd: workspace.cwd, check });
        await this.opState(id, opId, evidence.result === 'passed' ? 'succeeded' : 'failed', `Check ${evidence.result}.`);
        await this.mail(id, { id: identity('mail', opId, 'evidence'), kind: 'verification', sessionId: r.leadSessionId,
          text: `Check ${check.id}: ${evidence.result}; evidence ${evidence.id}; content ${revision.contentHash}.`, artifactIds: evidence.artifactIds, createdAt: Date.now() });
      }
    } catch (e) {
      await this.opState(id, opId, 'failed', message(e));
      await this.mail(id, { id: identity('mail', opId, 'failed'), kind: 'verification', sessionId: r.leadSessionId, text: `${op.kind} blocked: ${message(e)}`, artifactIds: [], createdAt: Date.now() });
    }
    this.wake(id);
  }
  /** The tool chooses only "approved", never a SHA, remote URL or branch. Every fetch/check
   * follows its own durable intent and ordinary user permission gate. */
  private async integrateTarget(id: string, opId: string): Promise<void> {
    const r = this.record(id), op = r.operations.find((o) => o.id === opId)!;
    if (!r.acceptedRevision || op.payload.expectedContentHash !== r.acceptedRevision.contentHash || !r.executionAuthorization || r.phase === 'planning' || r.attempts.some(active)) throw new Error('Target refresh requires settled attempts, execution authorization and current accepted content.');
    if (!r.deliveryPolicy.remote || !r.deliveryPolicy.targetBranch || r.deliveryPolicy.endpoint === 'local_commit' || !this.deps.delivery.authorizeTargetFetch) throw new Error('Approved target fetch is unavailable; no remote was inferred.');
    await this.opState(id, opId, 'in_flight');
    const observation = await this.deps.workspaces.observeApprovedTarget({ missionId: id, operationId: opId, remote: r.deliveryPolicy.remote, targetBranch: r.deliveryPolicy.targetBranch, authorize: (request) => this.deps.delivery.authorizeTargetFetch!(request) });
    await this.change(id, `${opId}-observation`, (state) => {
      const operation = state.operations.find((o) => o.id === opId)!;
      operation.payload.observationId = observation.id; operation.payload.targetObservation = structuredClone(observation);
      return state;
    });
    await this.integrationBoundary(id, opId, r);
    const promote = (state: MissionRecord, revision: MissionCodeRevision) => {
      this.receiptInputs(state, state.operations.find((o) => o.id === opId)!, 'integrationPolicy');
      return reduceMission(state, host, { kind: 'host.target.promote', operationId: opId, observationId: observation.id, targetHead: observation.commitSha, expectedAcceptedRevision: r.acceptedRevision!, revision });
    };
    const result = await this.deps.workspaces.integrateObservedTarget({ missionId: id, observationId: observation.id, expectedAccepted: r.acceptedRevision, check: async (check) => {
      this.assertAdmission(id);
      await this.change(id, `${opId}-workspace`, (state) => reduceMission(state, host, { kind: 'host.workspace.register', workspace: this.workspace(check.workspace) }));
      for (const configured of r.deliveryPolicy.checks.filter((c) => c.required)) {
        const evidence = await this.runCheck(id, opId, { missionId: id, operationId: identity('check', opId, configured.id), specificationRevision: r.specificationRevision, revision: check.revision, cwd: check.workspace.cwd, check: configured });
        if (evidence.result !== 'passed') return false;
      }
      promote(this.record(id), check.revision);
      return !this.fenced.has(id);
    } });
    await this.change(id, `${opId}-retained-workspace`, (state) => {
      if (result.workspace) state = reduceMission(state, host, { kind: 'host.workspace.register', workspace: this.workspace(result.workspace) });
      state.operations.find((o) => o.id === opId)!.payload.integrationOutcome = result.status;
      return state;
    });
    if (result.status !== 'accepted') throw new Error(`Approved target integration ${result.status}: ${'message' in result ? result.message : 'accepted revision changed'}. The isolated attempt is retained; do not reapply blindly.`);
    await this.change(id, `${opId}-promotion`, (state) => {
      state = promote(state, result.revision);
      state.operations.find((o) => o.id === opId)!.payload.integrationReceipt = { workspaceId: result.workspace.id, revision: result.revision, observationId: observation.id, targetHead: observation.commitSha };
      return state;
    });
    await this.opState(id, opId, 'succeeded');
    await this.mail(id, { id: identity('mail', opId, 'target-integrated'), kind: 'verification', sessionId: r.leadSessionId, text: `Approved target ${observation.targetBranch} at ${observation.commitSha} integrated with captured checks on ${result.revision.contentHash}. Any old-content review/evidence does not certify this revision; complete independent review and final gates before requesting delivery again.`, artifactIds: [], createdAt: Date.now() });
  }

  /** Bind the original authorization/check contract before the first integration effect. */
  private async integrationBoundary(id: string, opId: string, expected: MissionRecord): Promise<void> {
    await this.change(id, `${opId}-integration-boundary`, (state) => {
      this.assertAdmission(id);
      const op = state.operations.find((o) => o.id === opId)!;
      if (op.state !== 'in_flight' || op.payload.integrationRequestedAt !== undefined || !isDeepStrictEqual(state.deliveryPolicy, expected.deliveryPolicy)) throw new Error('Integration intent or policy changed before execution.');
      op.payload.integrationPolicy = structuredClone(state.deliveryPolicy);
      this.receiptInputs(state, op, 'integrationPolicy');
      op.payload.integrationRequestedAt = Date.now();
      return state;
    });
  }

  /** A completed effect is not authority to adopt a different specification, base or policy. */
  private receiptInputs(record: MissionRecord, operation: MissionOperation, policyKey: 'integrationPolicy' | 'deliveryPolicy', accepted = record.acceptedRevision): void {
    const expected = operation.payload.expectedAccepted as MissionCodeRevision | undefined;
    if (!accepted || !expected || !sameRevision(expected, accepted) || operation.payload.specificationRevision !== record.specificationRevision
      || !record.executionAuthorization || !isDeepStrictEqual(operation.payload.executionAuthorization, record.executionAuthorization)
      || operation.payload.requestedPermissionMode !== record.requestedPermissionMode || !operation.actor.startsWith(`lead:${record.leadSessionId}:`)
      || !isDeepStrictEqual(operation.payload[policyKey], record.deliveryPolicy)) throw new Error('Retained operation no longer matches its exact accepted revision, specification, authorization and policy.');
  }

  private async runCheck(id: string, parentOp: string, request: VerificationRequest) {
    const scope = verificationScope(request.specificationRevision, request.check, request.revision);
    await this.change(id, `${request.operationId}-intent`, (r) => {
      this.assertAdmission(id);
      const issue = verificationRetryIssue(r, scope);
      if (issue) throw new Error(issue.message);
      if (r.operations.some((o) => o.id !== parentOp && o.kind === 'verify' && pending(o) && o.payload.verificationScope === scope)) throw new Error('This exact check/content already has a pending verification.');
      return reduceMission(r, host, { kind: 'host.operation.record', operation: { id: request.operationId, idempotencyKey: request.operationId, actor: 'host', kind: 'verify', expectedRevision: r.revision, state: 'intent_recorded', payload: { executionKind: 'process', parentOperationId: parentOp, checkId: request.check.id, revision: request.revision, verificationScope: scope } } });
    });
    await this.opState(id, request.operationId, 'in_flight');
    const evidence = await this.deps.verification.run(request);
    const captured = await this.change(id, `${request.operationId}-evidence`, (r) => {
      r = reduceMission(r, host, { kind: 'host.evidence.capture', evidence });
      const operation = r.operations.find((o) => o.id === request.operationId)!;
      operation.resultRef = evidence.id;
      if (evidence.failure) operation.payload.failure = evidence.failure;
      const checkpoint = verificationRetryIssue(r, scope);
      if (checkpoint) operation.payload.verificationFailureCheckpoint = checkpoint;
      return r;
    });
    const issue = verificationRetryIssue(captured, scope);
    // Fence before any further await: neither a fresh key nor another approval card can race
    // the failure checkpoint. Reconciliation runs outside this check's parent job.
    if (evidence.failure?.recovery === 'user_action' || issue) this.pauseForObservedFailure(id, request.operationId);
    await this.opState(id, request.operationId, evidence.result === 'passed' ? 'succeeded' : 'failed', `Check ${evidence.result}.`);
    if (issue || evidence.failure?.recovery === 'user_action') await this.mail(id, { id: identity('mail', request.operationId, 'diagnosis'), kind: evidence.failure ? 'permission' : 'verification', sessionId: captured.leadSessionId,
      text: evidence.failure ? missionFailureNotice(evidence.failure) : issue!.message, artifactIds: evidence.artifactIds, createdAt: Date.now() });
    return evidence;
  }

  private observedBudgets() { return [...this.budgetObservations].map(([operationId, usage]) => ({ operationId, usage })); }
  private budgetIssue(r: MissionRecord): string | undefined { return missionBudgetIssue(r, this.deps.sessions.list(), this.observedBudgets()); }
  private budgetGate(id: string): string | undefined {
    const issue = this.budgetIssue(this.record(id));
    if (issue && this.record(id).status === 'completed') void this.endQuestion(id, issue).catch((error) => this.deps.log?.(message(error)));
    else if (issue) this.pauseForBudget(id, issue);
    return issue;
  }
  private pauseForBudget(id: string, reason: string): void {
    if (this.closed || this.fenced.has(id) || terminal(this.record(id))) return;
    // Fence synchronously: an already-queued capability probe cannot race the journal write.
    this.fenced.add(id); this.deps.scheduler.pause(id); this.cancelWorkspaceWaiters(id);
    this.broker.revoke(id); this.deps.verification.cancel(id);
    this.background(`budget-pause:${id}`, async () => {
      await this.block(id, 'requirements', reason, 'budget');
      await this.change(id, `budget-pause-${this.record(id).revision}`, (r) => {
        if (!terminal(r) && !['paused', 'pausing', 'stopping', 'recovering'].includes(r.status)) r.status = 'pausing';
        return r;
      });
      await this.reconcile(id, false);
    });
  }

  private assertAdmission(id: string, planning = false): void {
    const r = this.record(id);
    const budget = this.budgetGate(id);
    if (budget) throw new Error(budget);
    if (this.closed || this.fenced.has(id) || r.status !== 'running' || this.deps.store.isBlocked(id) || !planning && r.blockers.some((b) => b.resolvedAt === undefined)) throw new Error('Mission admission is paused or blocked; resolve the recorded blocker before dispatch.');
  }
  /** Shared with the host's verification/delivery ports; no trust in a model-provided idle flag. */
  isQuiescent(r: MissionRecord): boolean {
    return this.deps.sessions.list().filter((s) => s.mission?.missionId === r.id).every((s) => this.deps.sessions.activity(s.id).quiescent)
      && !this.externalUncertainty.has(r.id) && !this.deps.additionalActivity?.(r) && this.deps.verification.active(r.id).length === 0 && ![...this.turns.keys()].some((id) => this.deps.sessions.get(id)?.mission?.missionId === r.id);
  }

  private reconcile(id: string, recovering: boolean, drainPump = true): Promise<void> {
    const existing = this.reconciliations.get(id);
    if (existing) return existing;
    const promise = this.performReconciliation(id, recovering, drainPump);
    this.reconciliations.set(id, promise);
    void promise.finally(() => { if (this.reconciliations.get(id) === promise) this.reconciliations.delete(id); }).catch(() => undefined);
    return promise;
  }

  private async performReconciliation(id: string, recovering: boolean, drainPump: boolean): Promise<void> {
    if (drainPump) await this.pumpRuns.get(id);
    const old = this.record(id);
    if (!['pausing', 'stopping', 'recovering'].includes(old.status)) return;
    if (this.externalUncertainty.has(id)) {
      let observation: Awaited<ReturnType<NonNullable<MissionServiceDeps['reconcileExternalActivity']>>> | undefined;
      try { observation = await this.deps.reconcileExternalActivity?.(old); }
      catch (error) { observation = { quiescent: false, detail: message(error) }; }
      if (!observation?.quiescent || !observation.receipt?.trim()) {
        await this.block(id, 'environment', `External ownership is uncertain after restart. A prior harness/tool may still be alive; Resume and cleanup require exact durable bounded-owner receipts, not an empty session map. ${observation?.detail ?? ''}`.trim(), 'external');
        return;
      }
      await this.change(id, `external-reconciled-${old.revision}`, (r) => {
        for (const op of r.operations.filter((o) => o.kind === 'dispatch' || o.kind === 'verify')) op.payload.externalQuiescenceReceipt = observation!.receipt;
        for (const blocker of r.blockers.filter((b) => b.id.startsWith('external_') && b.resolvedAt === undefined)) blocker.resolvedAt = Date.now();
        return r;
      });
      this.externalUncertainty.delete(id);
    }
    const interruptId = identity('op', id, 'interrupt', old.revision);
    await this.change(id, `${interruptId}-intent`, (r) => reduceMission(r, host, { kind: 'host.operation.record', operation: { id: interruptId, idempotencyKey: interruptId, actor: 'host', kind: 'interrupt', expectedRevision: r.revision, state: 'intent_recorded', payload: { recovering } } }));
    await this.opState(id, interruptId, 'in_flight');
    let terminalsUncertain = false;
    try {
      await this.deps.stopOwnedTerminals?.(this.record(id));
      if (this.deps.additionalActivity?.(this.record(id))) throw new Error('Owned terminal activity remains live, closing or uncertain.');
    } catch (e) { terminalsUncertain = true; await this.block(id, 'environment', `Owned terminals did not stop: ${message(e)}`); }
    // A slow or unsupported actor must not delay interruption of the other owned writers.
    // Each keeps its lease until its own positive teardown; any uncertainty prevents pause.
    const stopped = await Promise.all(this.deps.sessions.list().filter((s) => s.mission?.missionId === id).map(async (meta) => {
      try {
        if (!recovering && this.deps.sessions.activity(meta.id).active) await this.deps.sessions.interruptManaged(meta.id, meta.mission!.generation);
        await this.deps.sessions.stopManaged(meta.id, meta.mission!.generation);
        if (!this.deps.sessions.activity(meta.id).quiescent) throw new Error('Owned runtime did not establish quiescence.');
        const live = this.turns.get(meta.id); if (live && !terminalsUncertain) { live.lease.release(true); this.turns.delete(meta.id); }
        return true;
      } catch (e) { await this.block(id, 'environment', `Owned session ${meta.id} did not stop: ${message(e)}`); return false; }
    }));
    if (terminalsUncertain || stopped.includes(false)) return;
    for (const operation of this.record(id).operations.filter(pending)) if (this.jobs.has(operation.id)) await this.jobs.get(operation.id);
    if (this.deps.verification.active(id).length) { await this.block(id, 'environment', 'Verification still owns an active or uncertain process; Mission remains pausing/stopping.'); return; }
    if (recovering) await this.reconcileResources(id);
    // A job already executing an external effect cannot be declared canceled from its promise
    // acceptance. Wait for its own result; controls never hold the state lock while doing so.
    const operations = this.record(id).operations.filter((o) => pending(o) && o.id !== interruptId);
    for (const op of operations) {
      if (!recovering && this.jobs.has(op.id)) await this.jobs.get(op.id);
      const current = this.record(id).operations.find((o) => o.id === op.id)!;
      if (!pending(current)) continue;
      if (recovering && (op.kind === 'deliver' && op.payload.deliveryRequestedAt !== undefined || ['integrate', 'capture'].includes(op.kind))) await this.block(id, 'stale_state', `Interrupted ${op.kind} operation ${op.id} needs receipt/artifact reconciliation. It was not replayed.`);
      if (recovering && current.payload.dispatchStartedAt !== undefined) await this.change(id, `${op.id}-retain-dispatch`, (r) => {
        for (const item of r.mailbox) if ((current.payload.mailboxIds as string[] | undefined)?.includes(item.id)) item.deliveredAt ??= Number(current.payload.dispatchStartedAt);
        return r;
      });
      await this.opState(id, op.id, 'failed', recovering ? 'Interrupted by host restart; reconcile retained effects before retry.' : 'Canceled at a quiescent user-control boundary.');
    }
    await this.change(id, `${interruptId}-attempts`, (r) => {
      for (const a of r.attempts.filter(active)) r = reduceMission(r, host, { kind: 'host.attempt.transition', attemptId: a.id, expectedStatus: a.status, status: 'terminal', outcome: r.status === 'stopping' ? 'canceled' : 'interrupted', at: Date.now() });
      return r;
    });
    await this.opState(id, interruptId, 'succeeded');
    await this.change(id, `${interruptId}-quiet`, (r) => reduceMission(r, host, { kind: 'host.quiesce', quiescent: this.isQuiescent(r) }));
    this.deps.scheduler.unregister(id);
  }

  /** Reconcile only identities the journal already owns. This never repeats a model turn or
   * recaptures a mutable directory as though it were the original submitted candidate. */
  private async reconcileResources(id: string): Promise<void> {
    const r = this.record(id);
    const ids = new Map(r.workspaces.filter((w) => !w.cleanedAt).map((w) => [w.id, w.ownerSessionId]));
    for (const op of r.operations) {
      if (op.payload.infrastructure === 'baseline') {
        ids.set(String(op.payload.leadWorkspaceId), String(op.payload.leadSessionId));
        ids.set(String(op.payload.integrationWorkspaceId), undefined);
      } else if (op.kind === 'dispatch' && typeof op.payload.workspaceId === 'string') ids.set(op.payload.workspaceId, String(op.payload.sessionId));
    }
    for (const [workspaceId, ownerSessionId] of ids) {
      try {
        const workspace = await this.deps.workspaces.recoverWorkspace(workspaceId);
        if (workspace.missionId !== id) throw new Error('Workspace receipt belongs to another Mission.');
        await this.change(id, `recover-workspace-${workspaceId}`, (state) => {
          const saved = state.workspaces.find((w) => w.id === workspaceId);
          const observed = this.workspace(workspace, ownerSessionId);
          if (saved && (saved.path !== observed.path || saved.branch !== observed.branch || saved.ownerSessionId !== observed.ownerSessionId)) throw new Error('Workspace ownership differs from the retained intent.');
          if (!saved) state.workspaces.push(observed);
          return state;
        });
      } catch (e) {
        // An intent with no workspace metadata never spawned a writer. Do not provision one on
        // restart. Previously registered resources, however, must remain explicit blockers.
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || r.workspaces.some((w) => w.id === workspaceId)) await this.block(id, 'stale_state', `Workspace ${workspaceId} needs reconciliation: ${message(e)}`);
      }
    }
    const baselineOp = r.operations.find((op) => op.payload.infrastructure === 'baseline');
    if (baselineOp && !r.baseline && this.record(id).workspaces.some((w) => w.role === 'integration') && this.record(id).workspaces.some((w) => w.role === 'lead')) {
      try {
        const baseline = await this.deps.workspaces.baseline(id);
        if (!isDeepStrictEqual(baseline, baselineOp.payload.baseline)) throw new Error('Retained baseline differs from the original intent.');
        await this.change(id, `${baselineOp.id}-recover-baseline`, (state) => {
          state = reduceMission(state, host, { kind: 'host.baseline.set', revision: baseline.revision });
          state.operations.find((op) => op.id === baselineOp.id)!.state = 'succeeded';
          return state;
        });
      } catch (e) { await this.block(id, 'stale_state', `Baseline needs reconciliation: ${message(e)}`); }
    }
    for (const attempt of r.attempts.filter((a) => a.status === 'terminal' && a.outcome === 'submitted' && !r.candidates.some((c) => c.attemptId === a.id))) {
      try {
        const receipts = await this.deps.workspaces.candidatesForAttempt(id, attempt.id);
        const candidate = receipts.find((c) => c.id === identity('c', attempt.id));
        if (!candidate || candidate.workspaceId !== attempt.workspaceId || !sameRevision(candidate.baseRevision, attempt.sourceRevision)) throw new Error('No exact immutable candidate receipt is available; the mutable worktree was not recaptured.');
        await this.change(id, `${candidate.id}-recover-receipt`, (state) => {
          state = reduceMission(state, host, { kind: 'host.candidate.capture', candidate: { id: candidate.id, attemptId: attempt.id, taskId: attempt.taskId,
            taskRevision: attempt.taskRevision, specificationRevision: attempt.specificationRevision, sourceRevision: attempt.sourceRevision,
            revision: candidate.revision, changedPaths: [...candidate.changedPaths], capturedAt: Date.parse(candidate.createdAt) } });
          const op = state.operations.find((o) => o.kind === 'capture' && o.payload.candidateId === candidate.id);
          if (op) { op.state = 'succeeded'; delete op.error; op.payload.reconciledFromReceipt = candidate.id; }
          for (const blocker of state.blockers) if (blocker.resolvedAt === undefined && blocker.message.startsWith(`Candidate capture failed for ${attempt.id}:`)) blocker.resolvedAt = Date.now();
          return state;
        });
      } catch (e) { await this.block(id, 'stale_state', `Candidate ${attempt.id} needs reconciliation: ${message(e)}`); }
    }
    // A durably rejected check is not an unknown apply. Keep the immutable failed attempt,
    // but allow an explicit replan/fresh candidate instead of manufacturing restart uncertainty.
    for (const operation of this.record(id).operations.filter((op) => op.kind === 'integrate' && pending(op)
      && ['conflict', 'rejected', 'changed', 'stale'].includes(String(op.payload.integrationOutcome)))) {
      await this.opState(id, operation.id, 'failed', `Integration ${operation.payload.integrationOutcome}; the isolated attempt is retained. Repair in a fresh assigned workspace.`);
    }
    for (const operation of this.record(id).operations.filter((op) => op.kind === 'integrate' && op.state !== 'succeeded' && op.payload.integrationRequestedAt !== undefined
      && !['conflict', 'rejected', 'changed', 'stale'].includes(String(op.payload.integrationOutcome)))) {
      try {
        const expected = operation.payload.expectedAccepted as MissionCodeRevision | undefined;
        if (!expected || operation.payload.expectedContentHash !== expected.contentHash) throw new Error('Integration has no exact retained accepted-revision intent.');
        const target = operation.payload.target === 'approved';
        const artifactId = target ? operation.payload.observationId : operation.payload.candidateId;
        if (typeof artifactId !== 'string') throw new Error('Integration has no retained candidate/observation identity.');
        const receipt = target
          ? await this.deps.workspaces.inspectTargetIntegration({ missionId: id, observationId: artifactId, expectedAccepted: expected })
          : await this.deps.workspaces.inspectIntegration({ missionId: id, candidateId: artifactId, expectedAccepted: expected });
        if (!receipt) throw new Error('No exact atomic promotion receipt is available; apply and checks were not replayed.');
        const observation = operation.payload.targetObservation as Awaited<ReturnType<MissionWorkspaces['targetObservation']>> | undefined;
        if (target && (!observation || observation.id !== artifactId || observation.missionId !== id || observation.operationId !== operation.id
          || observation.remote !== operation.payload.remote || observation.targetBranch !== operation.payload.targetBranch)) throw new Error('Target observation differs from the retained approved intent.');
        const recorded = { workspaceId: receipt.workspace.id, revision: receipt.revision, ...(target ? { observationId: artifactId, targetHead: observation!.commitSha } : {}) };
        await this.change(id, `${operation.id}-recover-integration`, (state) => {
          if (!['recovering', 'paused'].includes(state.status) || this.externalUncertainty.has(id)) throw new Error('Integration receipt cannot establish process quiescence or reopen admission.');
          const op = state.operations.find((entry) => entry.id === operation.id)!;
          const alreadyRecorded = op.payload.integrationReceipt !== undefined;
          const policy = op.payload.integrationPolicy as MissionDeliveryPolicy;
          this.receiptInputs(alreadyRecorded && target ? { ...state, deliveryPolicy: { ...state.deliveryPolicy, targetHead: policy?.targetHead } } : state, op, 'integrationPolicy', alreadyRecorded ? expected : state.acceptedRevision);
          if (alreadyRecorded && (!isDeepStrictEqual(op.payload.integrationReceipt, recorded) || !state.acceptedRevision || !sameRevision(state.acceptedRevision, receipt.revision)
            || target && state.deliveryPolicy.targetHead !== observation!.commitSha
            || !target && !state.candidates.some((candidate) => candidate.id === artifactId && candidate.integratedRevision && sameRevision(candidate.integratedRevision, receipt.revision)))) throw new Error('Recorded promotion differs from its exact workspace receipt.');
          for (const blocker of state.blockers) if (blocker.resolvedAt === undefined && (blocker.message.startsWith(`Integration ${operation.id} `) || blocker.message.startsWith(`Interrupted integrate operation ${operation.id} `))) blocker.resolvedAt = Date.now();
          if (!alreadyRecorded) {
            // Re-evaluate the ordinary pure reducer gates (including current captured checks,
            // review and scope) without persisting an admitted lifecycle or starting an effect.
            // Only the old operation's lifecycle is projected; authority/content are unchanged.
            const status = state.status;
            const admitted = { ...state, status: 'running' as const, operations: state.operations.map((entry) => entry.id === op.id ? { ...entry, state: 'in_flight' as const } : entry) };
            state = reduceMission(admitted, host, target
              ? { kind: 'host.target.promote', operationId: op.id, observationId: artifactId, targetHead: observation!.commitSha, expectedAcceptedRevision: expected, revision: receipt.revision }
              : { kind: 'host.integration.promote', candidateId: artifactId, expectedAcceptedRevision: expected, revision: receipt.revision });
            state.status = status;
          }
          const confirmed = state.operations.find((entry) => entry.id === op.id)!;
          confirmed.state = 'succeeded'; delete confirmed.error;
          confirmed.payload.integrationReceipt = recorded; confirmed.payload.reconciledReceipt = true;
          const workspace = this.workspace(receipt.workspace), saved = state.workspaces.find((entry) => entry.id === workspace.id);
          if (saved && !isDeepStrictEqual(saved, workspace) || state.workspaces.some((entry) => entry.id !== workspace.id && entry.path === workspace.path)) throw new Error('Integration workspace differs from its retained ownership.');
          if (!saved) state.workspaces.push(workspace);
          return state;
        });
      } catch (e) { await this.block(id, 'stale_state', `Integration ${operation.id} needs reconciliation: ${message(e)}`); }
    }
    for (const operation of this.record(id).operations.filter((op) => op.kind === 'deliver' && (op.payload.deliveryRequestedAt !== undefined || op.state === 'succeeded'))) {
      if (!this.deps.delivery.inspect) {
        await this.block(id, 'stale_state', `Delivery ${operation.id} needs read-only receipt inspection before resuming; no external action was replayed.`);
        continue;
      }
      try {
        const current = this.record(id);
        this.receiptInputs(current, operation, 'deliveryPolicy');
        if (current.phase !== 'delivering' || operation.payload.deliveryRequestedAt === undefined) throw new Error('Delivery has no retained final delivery boundary.');
        const receipt = await this.deps.delivery.inspect({ mission: current, operationId: operation.id, commitMessage: operation.payload.commitMessage as string | undefined, report: operation.payload.report as string | undefined });
        if (!receipt || !['delivered', 'held'].includes(receipt.status) || receipt.operationId !== operation.id || !current.acceptedRevision || !sameRevision(receipt.revision, current.acceptedRevision)
          || receipt.endpoint !== current.deliveryPolicy.endpoint || receipt.expectedTargetHead !== current.deliveryPolicy.targetHead) throw new Error('No confirmed receipt matches the original delivery intent.');
        await this.change(id, `${operation.id}-recover-receipt`, (state) => {
          const op = state.operations.find((entry) => entry.id === operation.id)!;
          this.receiptInputs(state, op, 'deliveryPolicy');
          if (state.phase !== 'delivering' || !['recovering', 'paused'].includes(state.status) || this.externalUncertainty.has(id)) throw new Error('Delivery receipt cannot establish process quiescence or reopen admission.');
          if (state.delivery && ['delivered', 'held'].includes(state.delivery.status)) {
            const { completedAt: _oldTime, ...saved } = state.delivery, { completedAt: _newTime, ...observed } = receipt;
            if ((Object.keys({ ...saved, ...observed }) as Array<keyof typeof saved>).some((key) => !isDeepStrictEqual(saved[key], observed[key]))) throw new Error('Confirmed delivery differs from its retained receipt.');
          } else state.delivery = receipt;
          op.state = 'succeeded'; delete op.error; op.payload.reconciledReceipt = true;
          for (const blocker of state.blockers) if (blocker.resolvedAt === undefined && (blocker.message.startsWith(`Delivery ${operation.id} `) || blocker.message.startsWith(`Interrupted deliver operation ${operation.id} `))) blocker.resolvedAt = Date.now();
          return state;
        });
      } catch (e) { await this.block(id, 'stale_state', `Delivery ${operation.id} needs reconciliation: ${message(e)}`); }
    }
    const current = this.record(id);
    if (current.acceptedRevision) {
      try {
        const accepted = await this.deps.workspaces.acceptedRevision(id);
        if (!sameRevision(accepted, current.acceptedRevision)) throw new Error('Workspace promotion advanced without a recorded integration receipt; checks were not replayed.');
      } catch (e) { await this.block(id, 'stale_state', `Accepted content needs reconciliation: ${message(e)}`); }
    }
  }

  private async dispatchFailure(id: string, opId: string, sessionId: string, reason: string): Promise<void> {
    const before = this.record(id), op = before.operations.find((o) => o.id === opId);
    const live = this.turns.get(sessionId), meta = this.deps.sessions.get(sessionId);
    const attempt = before.attempts.find((a) => a.id === op?.payload.attemptId);
    if (!op || !pending(op) || op.payload.sessionId !== sessionId || live && live.operationId !== opId) return;
    // A pre-runtime rejection may have no session/attempt yet. Once one exists, never stop or
    // classify a newer generation in response to an older rejected send promise.
    const generation = attempt?.generation ?? (typeof op.payload.generation === 'number' ? op.payload.generation : undefined);
    if (meta?.mission && (meta.mission.missionId !== id || generation !== meta.mission.generation || meta.mission.role === 'lead' && sessionId !== before.leadSessionId)
      || generation !== undefined && sessionId === before.leadSessionId && generation !== before.leadGeneration
      || attempt && !active(attempt)) return;
    const diagnosis = classifyMissionDispatch(reason, live?.trouble);
    if (live) live.dispatchFailed = true; // Teardown/late terminal events cannot produce a second outcome.
    if (meta?.mission) {
      try { await this.deps.sessions.stopManaged(sessionId, meta.mission.generation); }
      catch { await this.block(id, 'environment', `Dispatch failed with uncertain owned runtime: ${diagnosis.message}`); return; }
    }
    let settledCurrent = false;
    await this.change(id, `${opId}-failure`, (r) => {
      const operation = r.operations.find((o) => o.id === opId)!;
      const current = this.deps.sessions.get(sessionId);
      if (!pending(operation) || current?.mission && (current.mission.generation !== generation || current.mission.role === 'lead' && sessionId !== r.leadSessionId)
        || sessionId === r.leadSessionId && generation !== r.leadGeneration) return r;
      const saved = r.attempts.find((a) => a.id === attempt?.id);
      if (saved && (!active(saved) || saved.generation !== generation)) return r;
      operation.payload.failure = diagnosis;
      r = reduceMission(r, host, { kind: 'host.operation.transition', operationId: opId, expectedState: operation.state, state: 'failed', error: diagnosis.message });
      if (saved) r = reduceMission(r, host, { kind: 'host.attempt.transition', attemptId: saved.id, expectedStatus: saved.status, status: 'terminal', outcome: 'failed', at: Date.now(), failure: diagnosis });
      settledCurrent = true; return r;
    });
    if (!settledCurrent) return;
    if (live && this.turns.get(sessionId) === live && this.deps.sessions.activity(sessionId).quiescent) { live.lease.release(true); this.turns.delete(sessionId); }
    if (!this.fenced.has(id)) {
      const r = this.record(id);
      await this.mail(id, { id: identity('mail', opId, 'dispatch-failure'), kind: diagnosis.recovery === 'user_action' ? 'permission' : 'decision', sessionId,
        taskId: typeof op.payload.taskId === 'string' ? op.payload.taskId : attempt?.taskId,
        text: `Dispatch ${opId} failed. ${missionFailureNotice(diagnosis)}`, artifactIds: [], createdAt: Date.now() });
      if (diagnosis.recovery === 'user_action') { this.pauseForObservedFailure(id, opId); return; }
      if (sessionId === r.leadSessionId) {
        await this.block(id, diagnosis.kind, missionFailureNotice(diagnosis), 'lead_dispatch');
        await this.change(id, `${opId}-lead-blocked`, (state) => { state.status = 'blocked'; return state; });
        this.fenced.add(id); this.deps.scheduler.pause(id); this.broker.revoke(id); this.cancelWorkspaceWaiters(id);
      } else this.wake(id);
    }
  }
  private background(key: string, run: () => Promise<void>): void {
    if (this.jobs.has(key) || this.closed) return;
    const promise = Promise.resolve().then(run).catch((e) => { this.deps.log?.(message(e)); });
    this.jobs.set(key, promise);
    void promise.finally(() => { if (this.jobs.get(key) === promise) this.jobs.delete(key); });
  }
  private async markRuntimeStart(id: string, operationId: string): Promise<void> {
    const initial = this.record(id).operations.find((op) => op.id === operationId);
    const meta = typeof initial?.payload.sessionId === 'string' ? this.deps.sessions.get(initial.payload.sessionId) : undefined;
    if (!meta?.mission || meta.mission.missionId !== id) throw new Error('Runtime startup requires an exact managed session.');
    // Production binding requires a fresh runtime: a capability probe or an earlier turn can
    // leave Pi parked between sends. Stop before the new marker so an old receipt cannot certify
    // this gap. Legacy injected ports keep their API, but receive no recoverable launch identity.
    if (this.deps.prepareRuntimeStart) await this.deps.sessions.stopManaged(meta.id, meta.mission.generation);
    const nonce = randomUUID();
    await this.change(id, `${operationId}-runtime-start`, (r) => {
      if (initial && isMissionQuestionOperation(initial)) this.assertQuestionAdmission(r, operationId);
      else this.assertAdmission(id, true);
      const op = r.operations.find((o) => o.id === operationId);
      if (!op || op.state !== 'in_flight' || op.payload.runtimeStartRequestedAt !== undefined) throw new Error('Runtime startup requires an unused durable dispatch intent.');
      if (this.deps.prepareRuntimeStart) op.payload.runtimeLaunch = { nonce, sessionId: meta.id, generation: meta.mission!.generation, harnessId: meta.config.harness };
      op.payload.runtimeStartRequestedAt = Date.now(); op.payload.dispatchStage = 'starting_runtime'; return r;
    });
    const record = this.record(id);
    await this.deps.prepareRuntimeStart?.(record, record.operations.find((op) => op.id === operationId)!);
  }
  private async opState(id: string, operationId: string, state: 'in_flight' | 'succeeded' | 'failed', error?: string): Promise<void> {
    if (!this.record(id).operations.some((o) => o.id === operationId && pending(o))) return;
    await this.change(id, `${operationId}-${state}`, (r) => {
      const op = r.operations.find((o) => o.id === operationId);
      if (!op || !pending(op) || op.state === state) return r;
      if (op.kind === 'dispatch' && state === 'in_flight' && op.payload.dispatchStage === undefined) op.payload.dispatchStage = 'preparing';
      if (isMissionQuestionOperation(op)) { op.state = state; if (error) op.error = error; return r; }
      return reduceMission(r, host, { kind: 'host.operation.transition', operationId, expectedState: op.state, state, error: state === 'failed' ? error ?? 'Operation failed.' : undefined });
    });
  }
  private mail(id: string, item: MissionMailboxItem): Promise<MissionRecord> {
    return this.change(id, `${item.id}-mail`, (r) => {
      const existing = r.mailbox.find((m) => m.id === item.id);
      if (existing) {
        const { createdAt: _oldTime, deliveredAt: _oldDelivery, ...prior } = existing;
        const { createdAt: _newTime, deliveredAt: _newDelivery, ...next } = item;
        if (!isDeepStrictEqual(prior, next)) throw new Error('Mailbox identity was reused for a different observation.');
        return r;
      }
      return reduceMission(r, host, { kind: 'host.mailbox.append', item });
    });
  }
  private async block(id: string, kind: MissionRecord['blockers'][number]['kind'], reason: string, prefix = 'block'): Promise<void> {
    try {
      const r = this.record(id);
      if (terminal(r) || r.blockers.some((b) => b.message === reason && b.resolvedAt === undefined)) return;
      const blockerId = identity(prefix, id, reason, r.blockers.filter((b) => b.message === reason).length);
      await this.change(id, `${blockerId}-add`, (state) => reduceMission(state, host, { kind: 'host.blocker.add', blocker: { id: blockerId, kind, message: reason } }));
      this.deps.sessions.note(r.leadSessionId, `Mission blocked: ${reason}`, 'warn');
    } catch (e) { this.fenced.add(id); this.deps.scheduler.pause(id); this.deps.log?.(`Mission persistence/admission blocked: ${message(e)}`); }
  }
  /** CAS retries only for host observations with a stable identity, never stale model/user writes. */
  private async change(id: string, key: string, apply: (r: MissionRecord) => MissionRecord, observation = false): Promise<MissionRecord> {
    for (;;) {
      const current = this.record(id);
      try {
        const next = await this.deps.store.transact(id, { idempotencyKey: `${key}:${current.revision}`, actor: 'host', kind: key, expectedRevision: current.revision, ...(observation ? { observation: true as const } : {}), request: { key } }, (r) => {
          const progress = missionProgressSnapshot(r);
          const next = apply(r); next.updatedAt = Date.now();
          if (current.status !== 'completed' && missionMadeProgress(progress, next)) next.progress.lastProgressRevision = current.revision;
          return next;
        });
        this.publish(id); return next;
      } catch (e) {
        if (e instanceof MissionStoreError && e.code === 'REVISION_CONFLICT') continue;
        throw e;
      }
    }
  }

  /** Shutdown stops only positively owned participants. It does not delete retained worktrees. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const records = this.deps.store.list();
    // Fence every Mission before the first await; another lead cannot dispatch while shutdown
    // waits for a slow owned process. An uncertain teardown keeps its durable nonquiet state.
    for (const r of records) {
      this.fenced.add(r.id); this.deps.scheduler.pause(r.id); this.deps.verification.cancel(r.id); this.broker.revoke(r.id); this.cancelWorkspaceWaiters(r.id);
    }
    const errors: unknown[] = [];
    try {
      for (const r of records) {
        try {
          await this.pumpRuns.get(r.id);
          for (const operation of this.record(r.id).operations.filter((op) => pending(op) && (op.kind === 'cleanup' || op.payload.infrastructure === 'lead_handover'))) if (this.jobs.has(operation.id)) await this.jobs.get(operation.id);
          if (!terminal(r)) {
            if (!['paused', 'pausing', 'stopping', 'recovering'].includes(r.status)) await this.change(r.id, `shutdown-${r.revision}`, (state) => reduceMission(state, host, { kind: 'host.recover' }));
            if (this.record(r.id).status !== 'paused') await this.reconcile(r.id, false);
          } else {
            if (r.status === 'completed') await this.endQuestion(r.id, 'Read-only answer interrupted by host shutdown; no prompt will be replayed.');
            await this.deps.stopOwnedTerminals?.(r);
            if (this.deps.additionalActivity?.(r)) throw new Error('Owned terminal shutdown is uncertain.');
            for (const meta of this.deps.sessions.list().filter((s) => s.mission?.missionId === r.id)) await this.deps.sessions.stopManaged(meta.id, meta.mission!.generation);
          }
        } catch (e) { errors.push(e); this.deps.log?.(`Mission ${r.id} shutdown requires reconciliation: ${message(e)}`); }
      }
    } finally {
      for (const detach of this.detach) detach();
      await this.broker.close();
    }
    if (errors.length) throw new AggregateError(errors, 'Mission shutdown left retained reconciliation blockers.');
  }
}
