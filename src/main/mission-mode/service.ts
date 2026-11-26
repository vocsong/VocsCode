/**
 * MissionService: the engine of Mission mode. It turns a session into a mission's Lead, runs the
 * Mission tools the gateway dispatches, routes Builder permission requests, and keeps one durable
 * record per mission at `<sessionDir(leadId)>/mission.json`.
 *
 * Rules it keeps:
 * - Host messages reach a Lead or Builder only between turns: one combined message per idle
 *   boundary, after a short debounce, never as steering. A busy target gets them at its next idle.
 * - Tools answer at once. Slow git work (landing, push, PR) finishes in the background and reports
 *   back as a host message.
 * - Every state change is written to the record first; a failed write leaves memory unchanged and
 *   the tool call reports it.
 * - A request only the user may answer stays with the user; the Lead can only recommend or deny.
 * - Nothing resumes after a restart until the user clicks Resume. Nothing force-pushes or merges.
 *
 * No Electron imports.
 */
import path from 'node:path';
import { branchNameFromText } from '../../shared/branch-prefix';
import { HARNESS_BY_ID } from '../../shared/harness-meta';
import {
  MISSION_LIMITS,
  missionSupport,
  type ApprovalMissionRoute,
  type MissionRole,
  type MissionToolArgs,
  type MissionView
} from '../../shared/mission-mode';
import type {
  ApprovalDecision,
  ApprovalRequest,
  AppSettings,
  CreateSessionRequest,
  SessionEventEnvelope,
  SessionMeta,
  TranscriptItem,
  UserInput
} from '../../shared/types';
import { gitRoot, type BranchGitState } from '../git';
import type { SessionManager } from '../session-manager';
import { errorMessage, shortId } from '../util/async';
import { readJson, writeJson } from '../util/fs';
import { classifyBuilderRequest } from './approvals';
import type { MissionGatewayPort, MissionSessionIdentity, MissionToolCall, MissionToolHandler, MissionToolResult } from './contracts';
import { MissionDeliveryQueue } from './delivery';
import {
  approvalPromptText,
  beforeRecap,
  clip,
  DELIVERING,
  DISPATCHING,
  findBuilder,
  inboxOf,
  isActive,
  leadMissionContext,
  makeInboxEntry,
  missionRoster,
  missionView,
  ok,
  OVER,
  parseMissionRecord,
  RECORD_FILE,
  RecordWriteError,
  refuse,
  Refusal,
  resolveBuilderSpec,
  who,
  type DeliveryTarget
} from './format';
import { cleanMissionBuilders, inspectBuilderGitView, landBuilderOnLead, publishMission, type MissionGitActionsDeps } from './git-actions';
import { createBuilderWorktree, currentHead, isLanded, MISSION_BRANCH_PREFIX, statusPorcelain } from './git-ops';
import type { MissionHooks } from './hooks';
import { adoptLeadSession, forkLeadSession, removeMissionWorktree, type LeadSetupDeps } from './lead-setup';
import { composeMissionInstructions, kickoffMessage, resumeMessage, type MissionPromptContext } from './prompts';
import type { BuilderRecord, InboxEntry, MissionRecord } from './record';
import { renderReport } from './report';
import { cleanBuilderWorktree, cleanLeadWorktree, orphanMissionWorktrees } from './sweep';

export type { BuilderRecord, InboxEntry, MissionRecord };

/** What the service needs of the session manager. */
export type MissionSessions = Pick<
  SessionManager,
  | 'get' | 'list' | 'transcript' | 'send' | 'sendHost' | 'emitHostItem' | 'setMission' | 'createMissionSession' | 'adoptMissionSession'
  | 'resolveApproval' | 'updateApprovalRoute' | 'activity' | 'subscribe' | 'stop' | 'moveTo' | 'refreshGitState' | 'note' | 'create' | 'delete'
>;

export interface MissionServiceDeps {
  sessions: MissionSessions;
  /** A session's data folder (SessionStore.sessionDir); the Lead's holds the mission record. */
  sessionDir: (sessionId: string) => string;
  settings: () => AppSettings;
  /** The user's `lead.md` / `builder.md` add-on (AppInstructions.mission). */
  appInstructions?: { mission(role: MissionRole): Promise<string | undefined> };
  /** The loopback gateway; its tokens are revoked when a session leaves the mission. */
  gateway?: () => MissionGatewayPort | undefined;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Test seam: the debounce before a host message goes out (default 1.5 s). */
  deliveryDelayMs?: number;
  /** Test seam: how long land_on_lead waits before finishing in the background (default 20 s). */
  landWaitMs?: number;
}

interface PendingApproval {
  missionId: string;
  builderId: string;
  sessionId: string;
  request: ApprovalRequest;
  /** A card of it sits in the Lead's transcript. */
  mirrored?: boolean;
  /** Who is answering it right now, for the mirror's `decidedBy`. */
  resolvingBy?: 'lead' | 'user';
}

interface SessionRef {
  missionId: string;
  role: MissionRole;
  builderId?: string;
}

export class MissionService implements MissionHooks, MissionToolHandler {
  private readonly records = new Map<string, MissionRecord>();
  private readonly bySession = new Map<string, SessionRef>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly opLocks = new Map<string, Promise<unknown>>();
  private readonly approvals = new Map<string, PendingApproval>();
  /** Requests resolved before their routing finished; they must not reach the Lead afterwards. */
  private readonly resolvedEarly = new Set<string>();
  private readonly delivery: MissionDeliveryQueue;
  private readonly lastAssistant = new Map<string, string>();
  private readonly finishing = new Set<string>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly deps: MissionServiceDeps) {
    this.delivery = new MissionDeliveryQueue({
      sessions: deps.sessions,
      getRecord: (id) => this.records.get(id),
      mutate: (id, fn) => this.mutate(id, fn),
      log: deps.log,
      deliveryDelayMs: deps.deliveryDelayMs
    });
    this.unsubscribe = deps.sessions.subscribe((env) => this.onEvent(env));
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.delivery.dispose();
  }

  private gitActionDeps(): MissionGitActionsDeps {
    return {
      getRecord: (id) => this.records.get(id),
      mutate: (id, fn) => this.mutate(id, fn),
      enqueue: (id, target, entry) => this.delivery.enqueue(id, target, entry),
      scheduleDelivery: (id, target) => this.delivery.schedule(id, target),
      refreshGitState: (sessionId) => this.deps.sessions.refreshGitState(sessionId),
      log: this.deps.log,
      landWaitMs: this.deps.landWaitMs
    };
  }

  private leadSetupDeps(): LeadSetupDeps {
    return {
      sessions: this.deps.sessions,
      recordFile: (leadId) => this.recordFile(leadId),
      writeRecord: (record) => this.writeRecord(record),
      registerAndStart: (record, input, logMessage) => {
        this.records.set(record.id, record);
        this.index(record);
        this.deps.log('info', logMessage);
        this.sendFirst(record.leadId, input);
      },
      log: this.deps.log
    };
  }

  // -------------------------------------------------------------------------------------------
  // Public API (IPC)

  /** `mission:start`: the session becomes the Lead (empty) or hands its conversation to a new Lead. */
  async start(req: { sessionId: string; input: UserInput }, opts: { uncommittedAtStart?: boolean; baseBranch?: string } = {}): Promise<{ leadId: string }> {
    const { sessions } = this.deps;
    const source = sessions.get(req.sessionId);
    if (!source) throw new Error('Session not found');
    if (source.mission) throw new Error('This session is already part of a mission.');
    if (source.archived) throw new Error('Unarchive the session before starting a mission in it.');
    const harness = HARNESS_BY_ID[source.config.harness];
    if (!missionSupport(source.config.harness).lead) {
      throw new Error(`${harness?.name ?? source.config.harness} cannot lead a mission. Start it from a Claude, Codex, Pi or native session.`);
    }
    const text = req.input.text?.trim() ?? '';
    if (!text) throw new Error('Mission mode needs a task: write what the mission should do.');
    const items = await sessions.transcript(source.id);
    const empty = !items.some((i) => i.kind === 'user' || i.kind === 'assistant');
    const projectRoot = source.config.projectRoot;
    const git = !!(await gitRoot(projectRoot));
    const missionId = shortId('m_');
    const slug = branchNameFromText(text) || 'mission';
    const input: UserInput = { text: req.input.text, ...(req.input.images?.length ? { images: req.input.images } : {}), ...(req.input.files?.length ? { files: req.input.files } : {}) };
    return empty
      ? adoptLeadSession(this.leadSetupDeps(), source, { missionId, projectRoot, git, slug, input, ...opts })
      : forkLeadSession(this.leadSetupDeps(), source, { missionId, projectRoot, git, slug, input });
  }

  /**
   * `sessions:create` with `mission: true` (New Session with Mission on). The session is created
   * without its prompt, so no runtime starts before it is a Lead; the normal path makes its
   * `mission/<slug>` worktree, which the Lead then owns. The prompt goes out once it leads.
   */
  async createLead(req: CreateSessionRequest): Promise<SessionMeta> {
    const prompt = req.initialPrompt?.trim() ?? '';
    if (!prompt) throw new Error('Mission mode needs a task: write what the mission should do.');
    if (!HARNESS_BY_ID[req.config?.harness]) throw new Error('Unknown harness');
    if (!missionSupport(req.config.harness).lead) throw new Error(`${HARNESS_BY_ID[req.config.harness].name} cannot lead a mission.`);
    if (req.goal?.trim()) throw new Error('A mission cannot run a goal; the Lead drives the work.');
    if (req.checkoutBranch) throw new Error('A mission starts on its own mission branch; it cannot check out an existing one.');
    const root = await gitRoot(req.config.projectRoot);
    const status = root ? await statusPorcelain(root) : undefined;
    const meta = await this.deps.sessions.create({
      config: { ...req.config, permissionMode: 'plan', fastMode: false, useWorktree: !!root, ...(root ? { branchPrefix: MISSION_BRANCH_PREFIX } : {}) },
      ...(req.title?.trim() ? { title: req.title } : {}),
      ...(root ? { worktreeName: req.worktreeName?.trim() || branchNameFromText(prompt) || undefined } : {}),
      ...(root && req.worktreeBase ? { worktreeBase: req.worktreeBase } : {})
    });
    try {
      await this.start(
        { sessionId: meta.id, input: { text: prompt, ...(req.initialImages?.length ? { images: req.initialImages } : {}), ...(req.initialFiles?.length ? { files: req.initialFiles } : {}) } },
        { uncommittedAtStart: status?.ok ? !status.clean : false, ...(req.worktreeBase ? { baseBranch: req.worktreeBase } : {}) }
      );
    } catch (e) {
      await this.deps.sessions.delete(meta.id, !!meta.worktreeBranch).catch(() => undefined);
      throw e;
    }
    return this.deps.sessions.get(meta.id) ?? meta;
  }

  /** `mission:get`: the mission a Lead or Builder session belongs to. */
  get(sessionId: string): MissionView | null {
    const ref = this.refOf(sessionId);
    const record = ref ? this.records.get(ref.missionId) : undefined;
    return record ? missionView(record) : null;
  }

  /** `mission:stop`: stops every runtime, keeps unmerged work, cleans what landed. */
  async stop(leadId: string): Promise<MissionView> {
    const record = this.leadRecord(leadId);
    if (OVER.has(record.state)) return missionView(record);
    const now = Date.now();
    const after = await this.mutate(record.id, (d) => {
      d.state = 'stopped';
      for (const b of d.builders) if (isActive(b)) Object.assign(b, { state: 'stopped' as const, endedAt: now });
      d.inbox = { lead: [], builders: {} };
      d.checksBlockedUntilUser = [];
      return structuredClone(d);
    });
    this.dropMissionApprovals(record.id);
    this.revokeAll(after);
    await Promise.allSettled([after.leadId, ...after.builders.filter((b) => !b.cleaned).map((b) => b.sessionId)].map((id) => this.deps.sessions.stop(id)));
    this.deps.sessions.note(after.leadId, 'Mission stopped. No Builder runs; unmerged work stays on its branch.');
    void cleanMissionBuilders(this.gitActionDeps(), after.id, (b) => !!b.worktree && (!!b.landed || !!b.accepted));
    return missionView(this.records.get(record.id) ?? after);
  }

  /** `mission:resume`: interrupted missions only, by the user. One host message to the Lead. */
  async resume(leadId: string): Promise<MissionView> {
    const record = this.leadRecord(leadId);
    if (record.state !== 'interrupted') throw new Error('Only an interrupted mission can be resumed.');
    const leftovers = record.inbox.lead;
    const text = [
      resumeMessage({
        cause: 'restart',
        builders: record.builders.map((b) => ({ id: b.id, index: b.index, title: b.title, state: b.interruptedFrom ?? b.state, ownWorktree: !!b.worktree, branch: b.worktree?.branch, landed: b.landed, accepted: b.accepted })),
        ...(record.pr?.url ? { prUrl: record.pr.url } : {})
      }),
      ...(leftovers.length ? ['Messages that arrived before the restart:', ...leftovers.map((e) => e.text)] : [])
    ].join('\n\n');
    if (!this.delivery.isIdle(leadId)) {
      // Never steer: a busy Lead gets the Resume message at its next idle boundary.
      await this.mutate(record.id, (d) => {
        d.state = 'running';
        d.inbox.lead = [makeInboxEntry('resume', text)];
      });
      this.delivery.schedule(record.id, 'lead');
      return missionView(this.records.get(record.id)!);
    }
    await this.mutate(record.id, (d) => {
      d.state = 'running';
      d.inbox.lead = [];
    });
    try {
      await this.deps.sessions.sendHost(leadId, text, { kind: 'resume' });
    } catch (e) {
      await this.mutate(record.id, (d) => {
        d.state = 'interrupted';
        d.inbox.lead = leftovers;
      }).catch(() => undefined);
      throw e;
    }
    return missionView(this.records.get(record.id)!);
  }

  /**
   * Startup: loads every Lead's record. A mission that was running is now interrupted and its
   * working Builders stopped; nothing is sent to any session.
   */
  async recover(): Promise<void> {
    for (const meta of this.deps.sessions.list({ refreshGit: false })) {
      if (meta.mission?.role !== 'lead') continue;
      // One unreadable or failing mission must not keep the others from loading.
      try {
        await this.recoverOne(meta as SessionMeta & { mission: NonNullable<SessionMeta['mission']> });
      } catch (e) {
        this.deps.log('warn', `mission: could not recover the mission led by ${meta.id}: ${errorMessage(e)}`);
      }
    }
    if (this.records.size) this.deps.log('info', `mission: loaded ${this.records.size} mission record(s)`);
  }

  private async recoverOne(meta: SessionMeta & { mission: NonNullable<SessionMeta['mission']> }): Promise<void> {
    const raw = await readJson<unknown>(this.recordFile(meta.id), null, { log: this.deps.log });
    const record = parseMissionRecord(raw, meta);
    if (!record) {
      this.deps.log('warn', `mission: no readable record for Lead ${meta.id}; it no longer runs a mission`);
      if (meta.mission.state !== 'stopped' && meta.mission.state !== 'ended') this.deps.sessions.setMission(meta.id, { state: 'stopped' });
      return;
    }
    const next = structuredClone(record);
    if (next.state === 'running' || next.state === 'waiting_user') next.state = 'interrupted';
    for (const b of next.builders) {
      if (isActive(b)) Object.assign(b, { interruptedFrom: b.state, state: 'stopped' as const });
    }
    // The Builders' runtimes are gone; what the Lead had queued for them is the Lead's to redo.
    next.inbox.builders = {};
    // Permission requests died with their runtimes.
    next.inbox.lead = next.inbox.lead.filter((e) => e.kind !== 'approval');
    if (JSON.stringify(next) !== JSON.stringify(record)) {
      next.updatedAt = Date.now();
      try {
        await this.writeRecord(next);
      } catch (e) {
        // Interrupted is the conservative state either way: nothing dispatches until Resume, and
        // the next start turns the stale on-disk `running` into `interrupted` again.
        this.deps.log('warn', `mission ${record.id}: could not save its restart state: ${errorMessage(e)}`);
      }
    }
    this.records.set(next.id, next);
    this.sync(undefined, next);
  }

  /**
   * Startup housekeeping: Builder worktrees of ended or stopped missions are removed once landed or
   * accepted (unmerged work is kept and logged); orphan `mission/*` worktrees are only reported.
   */
  async sweep(): Promise<void> {
    for (const record of [...this.records.values()]) {
      if (!OVER.has(record.state) || !record.git) continue;
      await cleanMissionBuilders(this.gitActionDeps(), record.id, (b) => !!b.worktree && !b.cleaned);
    }
    try {
      for (const orphan of await orphanMissionWorktrees([...this.records.values()])) {
        this.deps.log('info', `mission: worktree ${orphan.path} (${orphan.branch}) belongs to no mission; it was left in place`);
      }
    } catch (e) {
      this.deps.log('debug', `mission: orphan worktree scan failed: ${errorMessage(e)}`);
    }
  }

  /** The gateway's live identity check: sessions of a mission that is not over. */
  identity(sessionId: string): MissionSessionIdentity | null {
    const meta = this.deps.sessions.get(sessionId);
    const m = meta?.mission;
    if (!meta || !m || meta.archived) return null;
    const record = this.records.get(m.missionId);
    if (!record || OVER.has(record.state)) return null;
    if (m.role === 'lead') return record.leadId === sessionId ? { missionId: record.id, role: 'lead' } : null;
    const b = record.builders.find((x) => x.sessionId === sessionId);
    return b && b.state !== 'stopped' && !b.accepted ? { missionId: record.id, role: 'builder' } : null;
  }

  // -------------------------------------------------------------------------------------------
  // MissionHooks

  gateway(): MissionGatewayPort | undefined {
    return this.deps.gateway?.();
  }

  async instructions(meta: SessionMeta): Promise<string | undefined> {
    const m = meta.mission;
    const record = m ? this.records.get(m.missionId) : undefined;
    if (!m || !record) return undefined;
    const builder = m.role === 'builder' ? record.builders.find((b) => b.sessionId === meta.id) : undefined;
    if (m.role === 'builder' && !builder) return undefined;
    const addOn = await this.deps.appInstructions?.mission(m.role).catch(() => undefined);
    const ctx: MissionPromptContext = {
      missionId: record.id,
      git: record.git,
      leadWorktree: record.leadWorktree,
      ...(record.leadBranch ? { leadBranch: record.leadBranch } : {}),
      ...(record.baseBranch ? { baseBranch: record.baseBranch } : {}),
      limits: { builders: MISSION_LIMITS.builders, failedChecks: MISSION_LIMITS.failedChecks },
      ...(builder ? { builder: { index: builder.index, title: builder.title, ownWorktree: !!builder.worktree, worktree: builder.worktree?.path, branch: builder.worktree?.branch } } : {})
    };
    const text = composeMissionInstructions(m.role, addOn, ctx);
    const extra = m.role === 'lead' ? leadMissionContext(record) : '';
    return extra ? beforeRecap(text, extra) : text;
  }

  async routeApproval(meta: SessionMeta, request: ApprovalRequest): Promise<ApprovalMissionRoute> {
    const ref = this.refOf(meta.id);
    const record = ref?.builderId ? this.records.get(ref.missionId) : undefined;
    const builder = record?.builders.find((b) => b.id === ref!.builderId);
    if (!record || !builder || OVER.has(record.state)) return { route: 'user', reason: 'is not part of a running mission', status: 'with_user' };
    const roots = [record.leadWorktree, ...record.builders.filter((b) => b.worktree && !b.cleaned).map((b) => b.worktree!.path)];
    const decided = await classifyBuilderRequest(request, roots, { cwd: builder.cwd || meta.cwd });
    const route: ApprovalMissionRoute = decided.route === 'lead' ? { route: 'lead', status: 'with_lead' } : { route: 'user', reason: decided.reason, status: 'with_user' };
    if (this.resolvedEarly.delete(request.id)) return route;
    this.approvals.set(request.id, { missionId: record.id, builderId: builder.id, sessionId: meta.id, request: { ...request, mission: route } });
    try {
      await this.delivery.enqueue(record.id, 'lead', { kind: 'approval', builderId: builder.id, requestId: request.id, text: approvalPromptText(builder, request, route) });
    } catch (e) {
      // The Lead cannot be told, so the request must not wait on it.
      this.deps.log('warn', `mission ${record.id}: could not queue ${request.id} for the Lead: ${errorMessage(e)}`);
      const fallback: ApprovalMissionRoute = { route: 'user', reason: route.reason ?? 'could not reach the Lead', status: 'with_user' };
      const pending = this.approvals.get(request.id);
      if (pending) pending.request = { ...pending.request, mission: fallback };
      return fallback;
    }
    return route;
  }

  async sessionRemoved(meta: SessionMeta): Promise<void> {
    const ref = this.refOf(meta.id);
    const record = ref ? this.records.get(ref.missionId) : undefined;
    if (!ref || !record) return;
    if (ref.role === 'lead') {
      const now = Date.now();
      let after = record;
      if (!OVER.has(record.state)) {
        try {
          after = await this.mutate(record.id, (d) => {
            d.state = 'stopped';
            for (const b of d.builders) if (isActive(b)) Object.assign(b, { state: 'stopped' as const, endedAt: now });
            d.inbox = { lead: [], builders: {} };
            return structuredClone(d);
          });
        } catch (e) {
          this.deps.log('warn', `mission ${record.id}: could not save the stop of a removed Lead: ${errorMessage(e)}`);
        }
      }
      this.dropMissionApprovals(record.id);
      this.revokeAll(after);
      await Promise.allSettled(after.builders.map((b) => this.deps.sessions.stop(b.sessionId)));
      for (const b of after.builders) if (b.state === 'stopped') this.deps.sessions.setMission(b.sessionId, { builderState: 'stopped' });
      // The record leaves with the Lead's session folder; clean what landed before it goes.
      const snapshot = structuredClone(after);
      this.forget(record.id);
      void (async () => {
        for (const b of snapshot.builders) {
          if (!b.worktree || b.cleaned || !(b.landed || b.accepted)) continue;
          const outcome = await cleanBuilderWorktree(snapshot, b).catch((e: unknown) => ({ removed: false, note: errorMessage(e) }));
          if (outcome.note) this.deps.log('info', `mission ${snapshot.id}: ${outcome.note}`);
        }
      })();
      return;
    }
    const builder = record.builders.find((b) => b.id === ref.builderId);
    if (!builder) return;
    const wasActive = isActive(builder);
    try {
      await this.mutate(record.id, (d) => {
        const b = d.builders.find((x) => x.id === builder.id)!;
        if (isActive(b)) Object.assign(b, { state: 'stopped' as const, endedAt: Date.now() });
        delete d.inbox.builders[b.id];
        if (wasActive && DELIVERING.has(d.state)) d.inbox.lead.push(makeInboxEntry('stopped', `${who(b)} "${b.title}" was removed by the user and no longer runs.`, { builderId: b.id }));
      });
    } catch (e) {
      this.deps.log('warn', `mission ${record.id}: could not save the removal of ${builder.id}: ${errorMessage(e)}`);
    }
    for (const [id, p] of this.approvals) if (p.sessionId === meta.id) this.approvals.delete(id);
    if (wasActive) this.delivery.schedule(record.id, 'lead');
    if (builder.worktree && !builder.cleaned && (builder.landed || builder.accepted)) void cleanMissionBuilders(this.gitActionDeps(), record.id, (b) => b.id === builder.id);
  }

  gitState(meta: SessionMeta, state: BranchGitState): void {
    if (meta.mission?.role !== 'lead' || (!state.merged && !state.closed)) return;
    const record = this.records.get(meta.mission.missionId);
    if (!record || record.leadId !== meta.id || !record.pr || record.state === 'ended') return;
    void this.end(record.id, state.merged ? 'merged' : 'closed').catch((e) => this.deps.log('warn', `mission ${record.id}: ending after the PR closed failed: ${errorMessage(e)}`));
  }

  // -------------------------------------------------------------------------------------------
  // Tools

  async call(call: MissionToolCall): Promise<MissionToolResult> {
    try {
      const record = this.records.get(call.missionId);
      if (!record || OVER.has(record.state)) return { text: 'This mission is over; the Mission tools no longer apply.', isError: true };
      if (call.role === 'lead') {
        if (record.leadId !== call.sessionId) return { text: 'This session does not lead this mission.', isError: true };
        return await this.leadTool(record.id, call);
      }
      const builder = record.builders.find((b) => b.sessionId === call.sessionId);
      if (!builder) return { text: 'This session is not one of this mission’s Builders.', isError: true };
      return await this.builderTool(record.id, builder.id, call);
    } catch (e) {
      if (e instanceof Refusal) return { text: e.message, isError: true };
      if (e instanceof RecordWriteError) return { text: `The mission record could not be saved (${e.message}), so nothing changed. Try again.`, isError: true };
      this.deps.log('warn', `mission ${call.missionId}: ${call.tool} failed: ${errorMessage(e)}`);
      return { text: `${call.tool} failed: ${errorMessage(e)}`, isError: true };
    }
  }

  private async leadTool(missionId: string, call: MissionToolCall): Promise<MissionToolResult> {
    switch (call.tool) {
      case 'start_builder': return this.serialOp(missionId, () => this.startBuilder(missionId, call.args as MissionToolArgs['start_builder']));
      case 'message_builder': return this.serialOp(missionId, () => this.messageBuilder(missionId, call.args as MissionToolArgs['message_builder']));
      case 'answer_request': return this.answerRequest(missionId, call.args as MissionToolArgs['answer_request']);
      case 'list_builders': return ok(missionRoster(this.records.get(missionId)!, false));
      case 'wait_for_builders': return ok(missionRoster(this.records.get(missionId)!, true));
      case 'builder_diff': return inspectBuilderGitView(this.records.get(missionId)!, (call.args as MissionToolArgs['builder_diff']).builderId, 'diff', (call.args as MissionToolArgs['builder_diff']).stat);
      case 'builder_log': return inspectBuilderGitView(this.records.get(missionId)!, (call.args as MissionToolArgs['builder_log']).builderId, 'log');
      case 'record_check': return this.recordCheck(missionId, call.args as MissionToolArgs['record_check']);
      case 'accept_builder': return this.serialOp(missionId, () => this.acceptBuilder(missionId, (call.args as MissionToolArgs['accept_builder']).builderId));
      case 'stop_builder': return this.serialOp(missionId, () => this.stopBuilder(missionId, (call.args as MissionToolArgs['stop_builder']).builderId));
      case 'finish_mission': return this.serialOp(missionId, () => this.finishMission(missionId, call.args as MissionToolArgs['finish_mission']));
      default: return { text: 'Unknown Mission tool for a Lead.', isError: true };
    }
  }

  private async builderTool(missionId: string, builderId: string, call: MissionToolCall): Promise<MissionToolResult> {
    const builder = findBuilder(this.records.get(missionId)!, builderId);
    if (builder.state === 'stopped' || builder.accepted) refuse('The Lead stopped or accepted your task; there is nothing more to report.');
    switch (call.tool) {
      case 'ask_lead': return this.askLead(missionId, builderId, (call.args as MissionToolArgs['ask_lead']).question);
      case 'report_done': return this.reportDone(missionId, builderId, call.args as MissionToolArgs['report_done']);
      case 'report_blocked': return this.reportBlocked(missionId, builderId, (call.args as MissionToolArgs['report_blocked']).reason);
      case 'land_on_lead': return landBuilderOnLead(this.gitActionDeps(), missionId, builderId);
      default: return { text: 'Unknown Mission tool for a Builder.', isError: true };
    }
  }

  private async startBuilder(missionId: string, args: MissionToolArgs['start_builder']): Promise<MissionToolResult> {
    const record = this.dispatchable(missionId);
    const active = record.builders.filter(isActive);
    if (active.length >= MISSION_LIMITS.builders) {
      refuse(`At most ${MISSION_LIMITS.builders} Builders run at once, and ${active.map((b) => who(b)).join(', ')} are still on their tasks. Wait for one to report, then accept or stop it before starting another.`);
    }
    const lead = this.deps.sessions.get(record.leadId);
    if (!lead) refuse('The Lead session is gone.');
    const spec = resolveBuilderSpec(lead!, this.deps.settings());
    const index = record.builders.reduce((n, b) => Math.max(n, b.index), 0) + 1;
    const id = `b${index}`;
    const own = record.git && args.own_worktree === true;
    let cwd = record.leadWorktree;
    let startSha: string | undefined;
    let worktree: BuilderRecord['worktree'];
    if (own) {
      if (!record.leadBranch) refuse('The Lead has no branch to start a Builder worktree from.');
      const wt = await createBuilderWorktree(record.projectRoot, record.leadBranch!, index);
      if (!wt.ok) refuse(wt.error);
      const made = wt as Extract<typeof wt, { ok: true }>;
      cwd = made.path;
      startSha = made.startSha;
      worktree = { path: made.path, branch: made.branch };
    } else if (record.git) {
      const head = await currentHead(record.leadWorktree);
      if (head.ok) startSha = head.sha;
    }
    let meta: SessionMeta;
    try {
      meta = await this.deps.sessions.createMissionSession({
        config: { ...spec.config, projectRoot: record.projectRoot, useWorktree: !!worktree, ...(worktree ? { branchPrefix: MISSION_BRANCH_PREFIX } : {}) },
        title: args.title.trim(),
        cwd,
        ...(worktree ? { worktreeBranch: worktree.branch } : {}),
        mission: { missionId, role: 'builder', leadId: record.leadId, builderIndex: index, builderState: 'working' }
      });
    } catch (e) {
      if (worktree) await removeMissionWorktree(record, worktree, this.deps.log);
      return refuse(`The Builder could not be created: ${errorMessage(e)}`);
    }
    const builder: BuilderRecord = {
      id, sessionId: meta.id, index, title: args.title.trim(), task: args.task, state: 'working', harness: spec.config.harness, cwd,
      ...(startSha ? { startSha } : {}), ...(worktree ? { worktree } : {}), failedChecks: 0, startedAt: Date.now()
    };
    const kickoff = kickoffMessage({ role: 'builder', title: builder.title, task: args.task, git: record.git, ownWorktree: !!worktree, worktree: cwd, ...(worktree ? { branch: worktree.branch } : {}), ...(record.leadBranch ? { leadBranch: record.leadBranch } : {}) });
    try {
      await this.mutate(missionId, (d) => {
        if (!DISPATCHING.has(d.state)) refuse('The mission stopped while the Builder was being created.');
        d.builders.push(builder);
        d.inbox.builders[id] = [makeInboxEntry('kickoff', kickoff, { builderId: id })];
        if (d.state === 'pr_open' || d.state === 'done_local') d.state = 'running';
      });
    } catch (e) {
      await this.deps.sessions.delete(meta.id).catch(() => undefined);
      if (worktree) await removeMissionWorktree(record, worktree, this.deps.log);
      throw e;
    }
    this.delivery.schedule(missionId, id);
    const where = worktree ? `in its own worktree ${worktree.path} on ${worktree.branch}` : record.git ? `in your worktree ${record.leadWorktree}` : `in ${record.leadWorktree}`;
    return ok(`Started ${who(builder)} "${builder.title}" (session ${meta.id}) ${where}, on ${HARNESS_BY_ID[spec.config.harness].name}. It works in the background: end your turn, and the app messages you when it reports, asks or fails.`);
  }

  private async messageBuilder(missionId: string, args: MissionToolArgs['message_builder']): Promise<MissionToolResult> {
    const record = this.dispatchable(missionId);
    const builder = findBuilder(record, args.builderId);
    if (builder.accepted) refuse(`${who(builder)} was accepted; start a new Builder for more work.`);
    if (record.checksBlockedUntilUser?.includes(builder.id)) {
      refuse(`${who(builder)} failed ${MISSION_LIMITS.failedChecks} checks on its task. Ask the user how to proceed; you can message it again after the user replies.`);
    }
    if (builder.state === 'stopped' && record.builders.filter(isActive).length >= MISSION_LIMITS.builders) {
      refuse(`${who(builder)} is stopped, and ${MISSION_LIMITS.builders} Builders are already running; accept or stop one first.`);
    }
    await this.mutate(missionId, (d) => {
      const b = findBuilder(d, builder.id);
      (d.inbox.builders[b.id] ??= []).push(makeInboxEntry('from_lead', `Message from the Lead:\n\n${args.text}`, { builderId: b.id }));
      b.state = 'working';
      delete b.pendingQuestion;
      delete b.endedAt;
      if (d.state === 'pr_open' || d.state === 'done_local') d.state = 'running';
    });
    this.delivery.schedule(missionId, builder.id);
    return ok(`Queued for ${who(builder)}; it gets the message when it is between turns. End your turn: the app messages you when it reports or asks.`);
  }

  private async answerRequest(missionId: string, args: MissionToolArgs['answer_request']): Promise<MissionToolResult> {
    const pending = this.approvals.get(args.requestId);
    if (!pending || pending.missionId !== missionId) {
      refuse(`There is no pending request ${args.requestId} in this mission; it may have been answered already or its Builder stopped.`);
    }
    const p = pending!;
    const record = this.records.get(missionId)!;
    const builder = findBuilder(record, p.builderId);
    const route = p.request.mission ?? { route: 'user' as const, status: 'with_user' as const };
    const note = args.note?.trim() || undefined;
    if (args.decision === 'deny') {
      const option = p.request.options.find((o) => o.kind === 'deny') ?? p.request.options.find((o) => o.kind === 'cancel');
      p.resolvingBy = 'lead';
      await this.deps.sessions.resolveApproval(p.sessionId, p.request.id, { optionId: option?.id ?? 'deny', ...(note ? { note } : {}) }, 'lead');
      return ok(`Denied ${who(builder)}'s request "${p.request.title}". It is told to find another way${note ? ' and gets your note' : ''}.`);
    }
    if (route.route === 'lead') {
      // One-time allow only: the Lead never grants a lasting rule for the Builder.
      const option = p.request.options.find((o) => o.kind === 'allow');
      if (!option) refuse('This request has no one-time allow option; deny it or ask the user.');
      p.resolvingBy = 'lead';
      await this.deps.sessions.resolveApproval(p.sessionId, p.request.id, { optionId: option!.id, ...(note ? { note } : {}) }, 'lead');
      return ok(`Allowed ${who(builder)}'s request "${p.request.title}" once.`);
    }
    // Only the user may answer this one: the Lead's allow becomes its recommendation.
    const recommended: ApprovalMissionRoute = { route: 'user', ...(route.reason ? { reason: route.reason } : {}), status: 'with_user', recommendation: { verdict: 'allow', ...(note ? { note } : {}) } };
    await this.mutate(missionId, (d) => {
      if (d.state === 'running' || d.state === 'pr_open' || d.state === 'done_local') d.state = 'waiting_user';
    });
    this.deps.sessions.updateApprovalRoute(p.sessionId, p.request.id, recommended);
    p.request = { ...p.request, mission: recommended };
    p.mirrored = true;
    this.deps.sessions.emitHostItem(record.leadId, { id: p.request.id, kind: 'approval', ts: Date.now(), request: p.request });
    return ok(`Only the user can approve this request (it ${route.reason ?? 'needs the user'}). Your recommendation to allow it is shown to the user, and ${who(builder)} waits for their answer. End your turn.`);
  }

  private async recordCheck(missionId: string, args: MissionToolArgs['record_check']): Promise<MissionToolResult> {
    const record = this.records.get(missionId)!;
    const builder = findBuilder(record, args.builderId);
    if (args.passed) return ok(`Recorded: ${who(builder)}'s work passed your check.${builder.worktree && !builder.landed ? ' It still has to land on your branch before accept_builder.' : ' Call accept_builder when you are done with it.'}`);
    const failures = await this.mutate(missionId, (d) => {
      const b = findBuilder(d, builder.id);
      b.failedChecks += 1;
      if (b.failedChecks >= MISSION_LIMITS.failedChecks) {
        d.checksBlockedUntilUser = [...new Set([...(d.checksBlockedUntilUser ?? []), b.id])];
        if (d.state === 'running') d.state = 'waiting_user';
      }
      return b.failedChecks;
    });
    if (failures >= MISSION_LIMITS.failedChecks) {
      return ok(`That is failed check ${failures} on ${who(builder)}'s task. Stop and ask the user how to proceed (one question); message_builder is refused for it until the user replies.`);
    }
    return ok(`Recorded failed check ${failures} of ${MISSION_LIMITS.failedChecks} for ${who(builder)}. Send it back with message_builder, saying exactly what is missing.`);
  }

  private async acceptBuilder(missionId: string, builderId: string): Promise<MissionToolResult> {
    const record = this.records.get(missionId)!;
    const builder = findBuilder(record, builderId);
    if (builder.accepted) return ok(`${who(builder)} is already accepted.`);
    let extra = '';
    if (record.git && builder.worktree && !builder.cleaned) {
      const landed = await isLanded(record.leadWorktree, record.leadBranch ?? 'HEAD', builder.worktree.branch);
      if (!landed.ok) refuse(landed.error);
      if (!(landed as Extract<typeof landed, { ok: true }>).landed) refuse(`${who(builder)} has not landed its branch ${builder.worktree.branch} on yours yet; tell it to call land_on_lead first.`);
    } else if (record.git && !builder.worktree) {
      const status = await statusPorcelain(record.leadWorktree);
      if (status.ok && !status.clean) {
        const othersWorking = record.builders.some((b) => b.id !== builder.id && !b.worktree && isActive(b));
        const paths = status.entries.slice(0, 20).map((e) => e.path).join(', ');
        if (!othersWorking) refuse(`Your worktree has uncommitted changes (${paths}). Ask ${who(builder)} to commit its work (or discard what is not wanted) before you accept it.`);
        extra = ` Uncommitted changes remain in your worktree (${paths}); another Builder sharing it is still working.`;
      }
    }
    await this.mutate(missionId, (d) => {
      const b = findBuilder(d, builder.id);
      b.accepted = true;
      b.state = 'done';
      if (b.worktree) b.landed = true;
      b.endedAt = Date.now();
      delete d.inbox.builders[b.id];
    });
    await this.deps.sessions.stop(builder.sessionId).catch(() => undefined);
    this.deps.gateway?.()?.revoke(builder.sessionId);
    if (builder.worktree && !builder.cleaned) void cleanMissionBuilders(this.gitActionDeps(), missionId, (b) => b.id === builder.id);
    return ok(`Accepted ${who(builder)}; its session stopped${builder.worktree ? ' and its worktree is being removed' : ''}.${extra}`);
  }

  private async stopBuilder(missionId: string, builderId: string): Promise<MissionToolResult> {
    const record = this.records.get(missionId)!;
    const builder = findBuilder(record, builderId);
    if (builder.state === 'stopped') return ok(`${who(builder)} is already stopped.`);
    await this.mutate(missionId, (d) => {
      const b = findBuilder(d, builder.id);
      b.state = 'stopped';
      b.endedAt = Date.now();
      delete d.inbox.builders[b.id];
    });
    for (const [id, p] of this.approvals) if (p.sessionId === builder.sessionId) this.approvals.delete(id);
    await this.deps.sessions.stop(builder.sessionId).catch(() => undefined);
    this.deps.gateway?.()?.revoke(builder.sessionId);
    if (builder.worktree && !builder.cleaned && builder.landed) void cleanMissionBuilders(this.gitActionDeps(), missionId, (b) => b.id === builder.id);
    const kept = builder.worktree && !builder.landed ? ` Its unlanded work stays on ${builder.worktree.branch} in ${builder.worktree.path}.` : '';
    return ok(`Stopped ${who(builder)}.${kept}`);
  }

  private async finishMission(missionId: string, args: MissionToolArgs['finish_mission']): Promise<MissionToolResult> {
    const record = this.records.get(missionId)!;
    if (this.finishing.has(missionId)) refuse('The mission is already finishing; the app messages you when the push and PR are done.');
    const active = record.builders.filter(isActive);
    if (active.length) refuse(`These Builders are still on their tasks: ${active.map((b) => who(b)).join(', ')}. Accept or stop each one before finishing.`);
    if (!record.git) {
      const body = renderReport(args, { kind: 'local', reason: 'this folder is not a git repository; the work is in place' });
      await this.mutate(missionId, (d) => {
        d.state = 'done_local';
        d.report = body;
      });
      return ok(`The mission is finished; the work is in ${record.leadWorktree}. Tell the user, briefly.\n\n${body}`);
    }
    const status = await statusPorcelain(record.leadWorktree);
    if (!status.ok) refuse(status.error);
    const s = status as Extract<typeof status, { ok: true }>;
    if (!s.clean) refuse(`Your worktree has uncommitted changes (${s.entries.slice(0, 20).map((e) => e.path).join(', ')}). Have a Builder commit or discard them, then finish again.`);
    this.finishing.add(missionId);
    void publishMission(this.gitActionDeps(), missionId, args).finally(() => this.finishing.delete(missionId));
    return ok(record.pr
      ? 'Finishing: pushing the new commits and updating the PR description. End your turn; the app messages you when it is done.'
      : 'Finishing: pushing the branch and opening the PR. End your turn; the app messages you when it is done.');
  }

  private async askLead(missionId: string, builderId: string, question: string): Promise<MissionToolResult> {
    await this.mutate(missionId, (d) => {
      const b = findBuilder(d, builderId);
      b.state = 'waiting_lead';
      b.pendingQuestion = question;
      d.inbox.lead.push(makeInboxEntry('question', `${who(b)} "${b.title}" asks:\n\n${question}\n\nAnswer with message_builder({ builderId: "${b.id}", text }).`, { builderId: b.id }));
    });
    this.delivery.schedule(missionId, 'lead');
    return ok('Your question went to the Lead. End your turn now; the answer arrives as a message.');
  }

  private async reportDone(missionId: string, builderId: string, args: MissionToolArgs['report_done']): Promise<MissionToolResult> {
    const record = this.records.get(missionId)!;
    const builder = findBuilder(record, builderId);
    let uncommitted: string[] | undefined;
    if (record.git && builder.worktree) {
      const landed = await isLanded(builder.worktree.path, record.leadBranch ?? 'HEAD', builder.worktree.branch);
      if (!landed.ok) refuse(landed.error);
      if (!(landed as Extract<typeof landed, { ok: true }>).landed) refuse('Your work is not on the Lead branch yet: merge it, test, commit, call land_on_lead, then report_done.');
    } else if (record.git) {
      const status = await statusPorcelain(record.leadWorktree);
      if (status.ok && !status.clean) {
        const othersWorking = record.builders.some((b) => b.id !== builder.id && !b.worktree && isActive(b));
        const paths = status.entries.map((e) => e.path);
        if (!othersWorking) refuse(`The worktree has uncommitted changes (${paths.slice(0, 20).join(', ')}). Commit your own files (git add <paths>; git commit), then call report_done again.`);
        uncommitted = paths.slice(0, 50);
      }
    }
    await this.mutate(missionId, (d) => {
      const b = findBuilder(d, builderId);
      b.state = 'done';
      delete b.pendingQuestion;
      b.lastReport = { summary: args.summary, verification: args.verification, ...(args.files ? { files: args.files } : {}), ...(uncommitted ? { uncommitted } : {}), at: Date.now() };
      const lines = [
        `${who(b)} "${b.title}" reports done:`,
        '',
        args.summary,
        '',
        'Verification:',
        ...(args.verification.length ? args.verification.map((v) => `- ${v}`) : ['- (none given)']),
        ...(args.files?.length ? ['', `Files: ${args.files.join(', ')}`] : []),
        ...(uncommitted ? ['', `Uncommitted in the shared worktree when it reported (another Builder is still working there): ${uncommitted.join(', ')}`] : []),
        '',
        `Check it with builder_diff and builder_log, record_check the result, then accept_builder({ builderId: "${b.id}" }) or send it back with message_builder.`
      ];
      d.inbox.lead.push(makeInboxEntry('report', lines.join('\n'), { builderId: b.id }));
    });
    this.delivery.schedule(missionId, 'lead');
    return ok('Reported to the Lead. End your turn; the Lead may send follow-up work.');
  }

  private async reportBlocked(missionId: string, builderId: string, reason: string): Promise<MissionToolResult> {
    await this.mutate(missionId, (d) => {
      const b = findBuilder(d, builderId);
      b.state = 'failed';
      delete b.pendingQuestion;
      d.inbox.lead.push(makeInboxEntry('failed', `${who(b)} "${b.title}" is blocked:\n\n${reason}\n\nAnswer with message_builder, or stop_builder it.`, { builderId: b.id }));
    });
    this.delivery.schedule(missionId, 'lead');
    return ok('The Lead was told. End your turn.');
  }

  // -------------------------------------------------------------------------------------------
  // Events

  private onEvent(env: SessionEventEnvelope): void {
    if (this.disposed) return;
    const ref = this.bySession.get(env.sessionId);
    if (!ref) return;
    const record = this.records.get(ref.missionId);
    if (!record) return;
    const ev = env.event;
    if (ev.type === 'item.upsert') {
      const item = ev.item;
      if (item.kind === 'assistant' && !item.streaming && item.text) this.lastAssistant.set(env.sessionId, item.text);
      else if (item.kind === 'user' && !item.origin && ref.role === 'lead') void this.onLeadUserMessage(ref.missionId);
      else if (item.kind === 'turn') {
        if (ref.role === 'builder') void this.onBuilderTurnEnd(ref.missionId, ref.builderId!, item);
        this.kick(ref);
      }
    } else if (ev.type === 'status') {
      if (ev.status === 'idle' || ev.status === 'stopped' || ev.status === 'error') this.kick(ref);
    } else if (ev.type === 'approval.resolved') {
      this.onApprovalResolved(env.sessionId, ev.requestId, ev.decision);
      this.kick(ref);
    } else if (ev.type === 'error' && ev.fatal && ref.role === 'builder') {
      void this.onBuilderFailed(ref.missionId, ref.builderId!, ev.message);
    }
  }

  /** The user wrote to the Lead: failed-check blocks lift and finished or waiting work resumes. */
  private async onLeadUserMessage(missionId: string): Promise<void> {
    await this.mutate(missionId, (d) => {
      if (d.checksBlockedUntilUser?.length) d.checksBlockedUntilUser = [];
      if (d.state === 'waiting_user' || d.state === 'pr_open' || d.state === 'done_local' || d.state === 'interrupted') d.state = 'running';
    }).catch((e) => this.deps.log('warn', `mission ${missionId}: could not record the user's message: ${errorMessage(e)}`));
  }

  private async onBuilderTurnEnd(missionId: string, builderId: string, turn: Extract<TranscriptItem, { kind: 'turn' }>): Promise<void> {
    const sessionId = this.records.get(missionId)?.builders.find((b) => b.id === builderId)?.sessionId;
    const said = sessionId ? this.lastAssistant.get(sessionId) : undefined;
    const queued = await this.mutate(missionId, (d) => {
      const b = d.builders.find((x) => x.id === builderId);
      if (!b || b.state !== 'working' || b.accepted || !DELIVERING.has(d.state)) return false;
      if (turn.status === 'failed') {
        b.state = 'failed';
        d.inbox.lead.push(makeInboxEntry('failed', `${who(b)} "${b.title}": its turn failed${turn.error ? `: ${clip(turn.error, 600)}` : '.'}\n\nSend it a message to retry, or stop_builder it.`, { builderId: b.id }));
        return true;
      }
      // A message already waiting for it starts its next turn; nothing to report yet.
      if (d.inbox.builders[b.id]?.length) return false;
      b.state = 'waiting_lead';
      d.inbox.lead.push(makeInboxEntry('note', `${who(b)} "${b.title}" ended its turn${turn.status === 'interrupted' ? ' (interrupted)' : ''} without report_done, ask_lead or report_blocked.${said ? ` Its last words:\n\n${clip(said, 1_500)}` : ''}\n\nTell it what to do with message_builder.`, { builderId: b.id }));
      return true;
    }).catch((e) => {
      this.deps.log('warn', `mission ${missionId}: could not record ${builderId}'s turn end: ${errorMessage(e)}`);
      return false;
    });
    if (queued) this.delivery.schedule(missionId, 'lead');
  }

  private async onBuilderFailed(missionId: string, builderId: string, message: string): Promise<void> {
    const queued = await this.mutate(missionId, (d) => {
      const b = d.builders.find((x) => x.id === builderId);
      if (!b || b.accepted || b.state === 'stopped' || b.state === 'failed' || !DELIVERING.has(d.state)) return false;
      b.state = 'failed';
      d.inbox.lead.push(makeInboxEntry('failed', `${who(b)} "${b.title}" stopped with an error: ${clip(message, 600)}\n\nSend it a message to retry, or stop_builder it.`, { builderId: b.id }));
      return true;
    }).catch(() => false);
    if (queued) this.delivery.schedule(missionId, 'lead');
  }

  private onApprovalResolved(sessionId: string, requestId: string, decision: ApprovalDecision): void {
    const pending = this.approvals.get(requestId);
    if (!pending) {
      if (this.bySession.get(sessionId)?.role === 'builder') {
        this.resolvedEarly.add(requestId);
        if (this.resolvedEarly.size > 200) this.resolvedEarly.delete(this.resolvedEarly.values().next().value!);
      }
      return;
    }
    if (pending.sessionId !== sessionId) return;
    this.approvals.delete(requestId);
    const record = this.records.get(pending.missionId);
    if (!record) return;
    if (pending.mirrored) {
      this.deps.sessions.emitHostItem(record.leadId, { id: requestId, kind: 'approval', ts: pending.request.createdAt, request: pending.request, decision, decidedAt: Date.now(), decidedBy: pending.resolvingBy ?? 'user' });
    }
    void this.mutate(pending.missionId, (d) => {
      // Undelivered news of an answered request is stale.
      d.inbox.lead = d.inbox.lead.filter((e) => e.requestId !== requestId);
      if (d.state === 'waiting_user' && !this.waitingOnUser(d)) d.state = 'running';
    }).catch((e) => this.deps.log('warn', `mission ${pending.missionId}: could not record the answer to ${requestId}: ${errorMessage(e)}`));
  }

  private waitingOnUser(d: MissionRecord): boolean {
    if (d.checksBlockedUntilUser?.length) return true;
    for (const p of this.approvals.values()) if (p.missionId === d.id && p.mirrored) return true;
    return false;
  }

  private kick(ref: SessionRef): void {
    const record = this.records.get(ref.missionId);
    if (!record) return;
    const target: DeliveryTarget = ref.role === 'lead' ? 'lead' : ref.builderId!;
    if (inboxOf(record, target).length) this.delivery.schedule(ref.missionId, target);
  }

  /** The user's own message, as typed, is the Lead's first turn. */
  private sendFirst(leadId: string, input: UserInput): void {
    void this.deps.sessions.send(leadId, input).catch((e) => this.deps.sessions.note(leadId, `The mission's first message could not be sent: ${errorMessage(e)}`, 'error'));
  }

  // -------------------------------------------------------------------------------------------
  // Ending

  private async end(missionId: string, how: 'merged' | 'closed'): Promise<void> {
    const record = this.records.get(missionId);
    if (!record || record.state === 'ended') return;
    const now = Date.now();
    const after = await this.mutate(missionId, (d) => {
      d.state = 'ended';
      for (const b of d.builders) if (isActive(b)) Object.assign(b, { state: 'stopped' as const, endedAt: now });
      d.inbox = { lead: [], builders: {} };
      d.checksBlockedUntilUser = [];
      return structuredClone(d);
    });
    this.dropMissionApprovals(missionId);
    this.revokeAll(after);
    await Promise.allSettled(after.builders.filter((b) => !b.cleaned).map((b) => this.deps.sessions.stop(b.sessionId)));
    const notes: string[] = [];
    await cleanMissionBuilders(this.gitActionDeps(), missionId, (b) => !!b.worktree && !b.cleaned, notes);
    if (after.leadWorktreeOwned && !after.leadWorktreeCleaned) {
      await this.deps.sessions.stop(after.leadId).catch(() => undefined);
      const current = this.records.get(missionId) ?? after;
      const outcome = await cleanLeadWorktree(current, how === 'merged').catch((e: unknown) => ({ removed: false, note: errorMessage(e) }));
      if (outcome.removed) await this.mutate(missionId, (d) => { d.leadWorktreeCleaned = true; }).catch(() => undefined);
      if (outcome.note) notes.push(outcome.note);
    }
    this.deps.sessions.note(after.leadId, `The PR was ${how}, so the mission ended.${notes.length ? ` ${notes.join(' ')}` : ' Its worktrees were cleaned up.'}`);
  }

  private revokeAll(record: MissionRecord): void {
    const gateway = this.deps.gateway?.();
    if (!gateway) return;
    gateway.revoke(record.leadId);
    for (const b of record.builders) gateway.revoke(b.sessionId);
  }

  private dropMissionApprovals(missionId: string): void {
    for (const [id, p] of this.approvals) if (p.missionId === missionId) this.approvals.delete(id);
  }

  private forget(missionId: string): void {
    this.records.delete(missionId);
    for (const [id, ref] of this.bySession) if (ref.missionId === missionId) this.bySession.delete(id);
    this.delivery.forgetMission(missionId);
  }

  // -------------------------------------------------------------------------------------------
  // Record I/O

  private recordFile(leadId: string): string {
    return path.join(this.deps.sessionDir(leadId), RECORD_FILE);
  }

  private async writeRecord(record: MissionRecord): Promise<void> {
    try {
      await writeJson(this.recordFile(record.leadId), record);
    } catch (e) {
      throw new RecordWriteError(errorMessage(e));
    }
  }

  /**
   * The one way state changes: `fn` edits a copy, the copy is written, and only then does it
   * replace the live record and update the Lead and Builder rows. Per mission, in order.
   */
  private mutate<T>(missionId: string, fn: (draft: MissionRecord) => T): Promise<T> {
    const run = async (): Promise<T> => {
      const current = this.records.get(missionId);
      if (!current) throw new Refusal('This mission no longer exists.');
      const draft = structuredClone(current);
      const result = fn(draft);
      if (JSON.stringify(draft) !== JSON.stringify(current)) {
        draft.updatedAt = Date.now();
        await this.writeRecord(draft);
        // The mission may have been forgotten (its Lead deleted) while the write ran.
        if (this.records.get(missionId) !== current) return result;
        this.records.set(missionId, draft);
        this.sync(current, draft);
      }
      return result;
    };
    const previous = this.locks.get(missionId) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tail = next.then(() => undefined, () => undefined);
    this.locks.set(missionId, tail);
    void tail.then(() => { if (this.locks.get(missionId) === tail) this.locks.delete(missionId); });
    return next;
  }

  /** Builder lifecycle calls (start, message, accept, stop, finish) of one mission, one at a time. */
  private serialOp<T>(missionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.opLocks.get(missionId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.then(() => undefined, () => undefined);
    this.opLocks.set(missionId, tail);
    void tail.then(() => { if (this.opLocks.get(missionId) === tail) this.opLocks.delete(missionId); });
    return next;
  }

  /** The rows the UI reads (`SessionMeta.mission`) follow the record. */
  private sync(before: MissionRecord | undefined, after: MissionRecord): void {
    const { sessions } = this.deps;
    if (!before || before.state !== after.state || before.pr?.url !== after.pr?.url) {
      sessions.setMission(after.leadId, { state: after.state, ...(after.pr?.url ? { prUrl: after.pr.url } : {}) });
    }
    for (const b of after.builders) {
      const prev = before?.builders.find((x) => x.id === b.id);
      if (!prev || prev.state !== b.state) sessions.setMission(b.sessionId, { builderState: b.state });
    }
    this.index(after);
  }

  private index(record: MissionRecord): void {
    this.bySession.set(record.leadId, { missionId: record.id, role: 'lead' });
    for (const b of record.builders) this.bySession.set(b.sessionId, { missionId: record.id, role: 'builder', builderId: b.id });
  }

  // -------------------------------------------------------------------------------------------
  // Lookups

  private refOf(sessionId: string): SessionRef | undefined {
    const ref = this.bySession.get(sessionId);
    if (ref && this.records.has(ref.missionId)) return ref;
    const m = this.deps.sessions.get(sessionId)?.mission;
    const record = m ? this.records.get(m.missionId) : undefined;
    if (!m || !record) return undefined;
    if (m.role === 'lead') return record.leadId === sessionId ? { missionId: record.id, role: 'lead' } : undefined;
    const b = record.builders.find((x) => x.sessionId === sessionId);
    return b ? { missionId: record.id, role: 'builder', builderId: b.id } : undefined;
  }

  private leadRecord(leadId: string): MissionRecord {
    const ref = this.refOf(leadId);
    const record = ref?.role === 'lead' ? this.records.get(ref.missionId) : undefined;
    if (!record) throw new Error('This session does not lead a mission.');
    return record;
  }

  private dispatchable(missionId: string): MissionRecord {
    const record = this.records.get(missionId)!;
    if (!DISPATCHING.has(record.state)) refuse(record.state === 'interrupted' ? 'The mission is interrupted; the user resumes it.' : 'The mission is over.');
    if (this.finishing.has(missionId)) refuse('The mission is finishing (push and PR); wait for the app’s message.');
    return record;
  }
}
