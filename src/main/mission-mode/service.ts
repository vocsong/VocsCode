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
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { branchNameFromText, branchSlug } from '../../shared/branch-prefix';
import { HARNESS_BY_ID, closestPermissionMode } from '../../shared/harness-meta';
import {
  DEFAULT_MISSION_DEFAULTS,
  MISSION_LIMITS,
  missionSupport,
  type ApprovalMissionRoute,
  type BuilderState,
  type MissionMessageKind,
  type MissionMessageMeta,
  type MissionRole,
  type MissionState,
  type MissionToolArgs,
  type MissionView
} from '../../shared/mission-mode';
import type {
  ApprovalDecision,
  ApprovalRequest,
  AppSettings,
  CreateSessionRequest,
  EffortLevel,
  HarnessId,
  ModelRef,
  PermissionMode,
  SessionConfig,
  SessionEventEnvelope,
  SessionMeta,
  TranscriptItem,
  UserInput
} from '../../shared/types';
import { createWorktree, gitRoot, type BranchGitState } from '../git';
import type { SessionManager } from '../session-manager';
import { titleFromPrompt } from '../session-title';
import { errorMessage, shortId } from '../util/async';
import { readJson, writeJson } from '../util/fs';
import { classifyBuilderRequest } from './approvals';
import type { MissionGatewayPort, MissionSessionIdentity, MissionToolCall, MissionToolHandler, MissionToolResult } from './contracts';
import {
  builderDiff,
  builderLog,
  cleanupWorktree,
  createBuilderWorktree,
  currentHead,
  editPrBody,
  ensureLeadWorktree,
  isLanded,
  landOnLead,
  mergeBase,
  MISSION_BRANCH_PREFIX,
  openPr,
  pushBranch,
  statusPorcelain
} from './git-ops';
import type { MissionHooks } from './hooks';
import { composeMissionInstructions, resumeMessage, roleReminder, kickoffMessage, type MissionPromptContext } from './prompts';
import { renderReport, reportTitle, type FinalReport } from './report';
import { cleanBuilderWorktree, cleanLeadWorktree, orphanMissionWorktrees } from './sweep';

// ---------------------------------------------------------------------------------------------
// The record

/** One undelivered host message for a Lead or a Builder. */
export interface InboxEntry {
  id: string;
  kind: MissionMessageKind;
  text: string;
  builderId?: string;
  requestId?: string;
  ts: number;
}

export interface BuilderRecord {
  /** `b<n>`, what the Lead's tools name it by. */
  id: string;
  sessionId: string;
  index: number;
  title: string;
  task: string;
  state: BuilderState;
  harness: HarnessId;
  /** The folder it works in: its own worktree, the Lead's, or the project folder without git. */
  cwd: string;
  /** Where its own changes start (shared Builders; own worktrees diff from the merge base). */
  startSha?: string;
  worktree?: { path: string; branch: string };
  landed?: boolean;
  accepted?: boolean;
  /** Its worktree was removed. */
  cleaned?: boolean;
  failedChecks: number;
  lastReport?: { summary: string; verification: string[]; files?: string[]; uncommitted?: string[]; at: number };
  pendingQuestion?: string;
  /** What it was doing when the app restarted; the Resume message says so. */
  interruptedFrom?: BuilderState;
  startedAt: number;
  endedAt?: number;
}

export interface MissionRecord {
  v: 1;
  id: string;
  leadId: string;
  createdAt: number;
  updatedAt: number;
  state: MissionState;
  projectRoot: string;
  git: boolean;
  baseBranch?: string;
  leadBranch?: string;
  /** The Lead's folder: its worktree, or the project folder without git. */
  leadWorktree: string;
  /** The mission (or the Lead session) owns the worktree and may remove it when the mission ends. */
  leadWorktreeOwned: boolean;
  leadWorktreeCleaned?: boolean;
  startSha?: string;
  uncommittedAtStart?: boolean;
  pr?: { url: string; number?: number; lastPushedSha?: string };
  builders: BuilderRecord[];
  inbox: { lead: InboxEntry[]; builders: Record<string, InboxEntry[]> };
  /** Builders at the failed-check limit: message_builder is refused until the user next writes. */
  checksBlockedUntilUser?: string[];
  /** The last finish report, as the PR body reads. */
  report?: string;
}

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

const RECORD_FILE = 'mission.json';
const DELIVERY_DELAY_MS = 1_500;
/** A target that is busy without a fresh event (a runtime still disposing) is looked at again. */
const BUSY_POLL_MS = 5_000;
const LAND_WAIT_MS = 20_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/** States in which host messages go out; the rest hold them (interrupted until Resume). */
const DELIVERING: ReadonlySet<MissionState> = new Set<MissionState>(['running', 'waiting_user', 'pr_open', 'done_local']);
/** States in which the Lead may hand out or change work. */
const DISPATCHING: ReadonlySet<MissionState> = new Set<MissionState>(['running', 'waiting_user', 'pr_open', 'done_local']);
const OVER: ReadonlySet<MissionState> = new Set<MissionState>(['ended', 'stopped']);

/** A refusal the model reads as the tool's error; never logged as a fault. */
class Refusal extends Error {}
/** The record could not be written; the in-memory state was not changed. */
class RecordWriteError extends Error {}

const ok = (text: string): MissionToolResult => ({ text });
const refuse = (text: string): never => {
  throw new Refusal(text);
};
const who = (b: Pick<BuilderRecord, 'index' | 'id'>): string => `Builder ${b.index} (${b.id})`;
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);
const isActive = (b: BuilderRecord): boolean => !b.accepted && (b.state === 'working' || b.state === 'waiting_lead');
const STATE_WORDS: Record<BuilderState, string> = { working: 'working', waiting_lead: 'waiting for your answer', done: 'reported done', failed: 'failed or blocked', stopped: 'stopped' };
const samePath = (a: string, b: string): boolean => {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
};

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

type Target = 'lead' | string;

interface LeadPlan {
  cwd: string;
  branch?: string;
  baseBranch?: string;
  startSha?: string;
  uncommittedAtStart: boolean;
  owned: boolean;
  /** A worktree this call created, removed again when the start fails. */
  created?: { path: string; branch: string };
}

export class MissionService implements MissionHooks, MissionToolHandler {
  private readonly records = new Map<string, MissionRecord>();
  private readonly bySession = new Map<string, SessionRef>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly opLocks = new Map<string, Promise<unknown>>();
  private readonly approvals = new Map<string, PendingApproval>();
  /** Requests resolved before their routing finished; they must not reach the Lead afterwards. */
  private readonly resolvedEarly = new Set<string>();
  private readonly timers = new Map<string, { timer: NodeJS.Timeout; at: number }>();
  private readonly delivering = new Set<string>();
  private readonly backoff = new Map<string, { until: number; failures: number }>();
  private readonly lastAssistant = new Map<string, string>();
  private readonly finishing = new Set<string>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly deps: MissionServiceDeps) {
    this.unsubscribe = deps.sessions.subscribe((env) => this.onEvent(env));
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
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
      ? this.adoptLead(source, { missionId, projectRoot, git, slug, input, ...opts })
      : this.forkLead(source, { missionId, projectRoot, git, slug, input });
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
    return record ? this.view(record) : null;
  }

  /** `mission:stop`: stops every runtime, keeps unmerged work, cleans what landed. */
  async stop(leadId: string): Promise<MissionView> {
    const record = this.leadRecord(leadId);
    if (OVER.has(record.state)) return this.view(record);
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
    void this.cleanBuilders(after.id, (b) => !!b.worktree && (!!b.landed || !!b.accepted));
    return this.view(this.records.get(record.id) ?? after);
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
    if (!this.idle(leadId)) {
      // Never steer: a busy Lead gets the Resume message at its next idle boundary.
      await this.mutate(record.id, (d) => {
        d.state = 'running';
        d.inbox.lead = [this.entry('resume', text)];
      });
      this.scheduleDelivery(record.id, 'lead');
      return this.view(this.records.get(record.id)!);
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
    return this.view(this.records.get(record.id)!);
  }

  /**
   * Startup: loads every Lead's record. A mission that was running is now interrupted and its
   * working Builders stopped; nothing is sent to any session.
   */
  async recover(): Promise<void> {
    for (const meta of this.deps.sessions.list({ refreshGit: false })) {
      if (meta.mission?.role !== 'lead') continue;
      const raw = await readJson<unknown>(this.recordFile(meta.id), null, { log: this.deps.log });
      const record = parseRecord(raw, meta);
      if (!record) {
        this.deps.log('warn', `mission: no readable record for Lead ${meta.id}; it no longer runs a mission`);
        if (meta.mission.state !== 'stopped' && meta.mission.state !== 'ended') this.deps.sessions.setMission(meta.id, { state: 'stopped' });
        continue;
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
      let loaded = record;
      if (JSON.stringify(next) !== JSON.stringify(record)) {
        next.updatedAt = Date.now();
        try {
          await this.writeRecord(next);
          loaded = next;
        } catch (e) {
          this.deps.log('warn', `mission ${record.id}: could not save its restart state: ${errorMessage(e)}`);
        }
      }
      this.records.set(loaded.id, loaded);
      this.sync(undefined, loaded);
    }
    if (this.records.size) this.deps.log('info', `mission: loaded ${this.records.size} mission record(s)`);
  }

  /**
   * Startup housekeeping: Builder worktrees of ended or stopped missions are removed once landed or
   * accepted (unmerged work is kept and logged); orphan `mission/*` worktrees are only reported.
   */
  async sweep(): Promise<void> {
    for (const record of [...this.records.values()]) {
      if (!OVER.has(record.state) || !record.git) continue;
      await this.cleanBuilders(record.id, (b) => !!b.worktree && !b.cleaned);
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
    const extra = m.role === 'lead' ? this.leadContext(record) : '';
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
      await this.enqueue(record.id, 'lead', { kind: 'approval', builderId: builder.id, requestId: request.id, text: approvalText(builder, request, route) });
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
        if (wasActive && DELIVERING.has(d.state)) d.inbox.lead.push(this.entry('stopped', `${who(b)} "${b.title}" was removed by the user and no longer runs.`, { builderId: b.id }));
      });
    } catch (e) {
      this.deps.log('warn', `mission ${record.id}: could not save the removal of ${builder.id}: ${errorMessage(e)}`);
    }
    for (const [id, p] of this.approvals) if (p.sessionId === meta.id) this.approvals.delete(id);
    if (wasActive) this.scheduleDelivery(record.id, 'lead');
    if (builder.worktree && !builder.cleaned && (builder.landed || builder.accepted)) void this.cleanBuilders(record.id, (b) => b.id === builder.id);
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
      case 'list_builders': return ok(this.roster(this.records.get(missionId)!, false));
      case 'wait_for_builders': return ok(this.roster(this.records.get(missionId)!, true));
      case 'builder_diff': return this.builderView(missionId, (call.args as MissionToolArgs['builder_diff']).builderId, 'diff', (call.args as MissionToolArgs['builder_diff']).stat);
      case 'builder_log': return this.builderView(missionId, (call.args as MissionToolArgs['builder_log']).builderId, 'log');
      case 'record_check': return this.recordCheck(missionId, call.args as MissionToolArgs['record_check']);
      case 'accept_builder': return this.serialOp(missionId, () => this.acceptBuilder(missionId, (call.args as MissionToolArgs['accept_builder']).builderId));
      case 'stop_builder': return this.serialOp(missionId, () => this.stopBuilder(missionId, (call.args as MissionToolArgs['stop_builder']).builderId));
      case 'finish_mission': return this.serialOp(missionId, () => this.finishMission(missionId, call.args as MissionToolArgs['finish_mission']));
      default: return { text: 'Unknown Mission tool for a Lead.', isError: true };
    }
  }

  private async builderTool(missionId: string, builderId: string, call: MissionToolCall): Promise<MissionToolResult> {
    const builder = this.builder(this.records.get(missionId)!, builderId);
    if (builder.state === 'stopped' || builder.accepted) refuse('The Lead stopped or accepted your task; there is nothing more to report.');
    switch (call.tool) {
      case 'ask_lead': return this.askLead(missionId, builderId, (call.args as MissionToolArgs['ask_lead']).question);
      case 'report_done': return this.reportDone(missionId, builderId, call.args as MissionToolArgs['report_done']);
      case 'report_blocked': return this.reportBlocked(missionId, builderId, (call.args as MissionToolArgs['report_blocked']).reason);
      case 'land_on_lead': return this.land(missionId, builderId);
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
    const spec = this.builderSpec(lead!);
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
      if (worktree) await this.removeWorktree(record, worktree);
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
        d.inbox.builders[id] = [this.entry('kickoff', kickoff, { builderId: id })];
        if (d.state === 'pr_open' || d.state === 'done_local') d.state = 'running';
      });
    } catch (e) {
      await this.deps.sessions.delete(meta.id).catch(() => undefined);
      if (worktree) await this.removeWorktree(record, worktree);
      throw e;
    }
    this.scheduleDelivery(missionId, id);
    const where = worktree ? `in its own worktree ${worktree.path} on ${worktree.branch}` : record.git ? `in your worktree ${record.leadWorktree}` : `in ${record.leadWorktree}`;
    return ok(`Started ${who(builder)} "${builder.title}" (session ${meta.id}) ${where}, on ${HARNESS_BY_ID[spec.config.harness].name}. It works in the background: end your turn, and the app messages you when it reports, asks or fails.`);
  }

  private async messageBuilder(missionId: string, args: MissionToolArgs['message_builder']): Promise<MissionToolResult> {
    const record = this.dispatchable(missionId);
    const builder = this.builder(record, args.builderId);
    if (builder.accepted) refuse(`${who(builder)} was accepted; start a new Builder for more work.`);
    if (record.checksBlockedUntilUser?.includes(builder.id)) {
      refuse(`${who(builder)} failed ${MISSION_LIMITS.failedChecks} checks on its task. Ask the user how to proceed; you can message it again after the user replies.`);
    }
    if (builder.state === 'stopped' && record.builders.filter(isActive).length >= MISSION_LIMITS.builders) {
      refuse(`${who(builder)} is stopped, and ${MISSION_LIMITS.builders} Builders are already running; accept or stop one first.`);
    }
    await this.mutate(missionId, (d) => {
      const b = this.builder(d, builder.id);
      (d.inbox.builders[b.id] ??= []).push(this.entry('from_lead', `Message from the Lead:\n\n${args.text}`, { builderId: b.id }));
      b.state = 'working';
      delete b.pendingQuestion;
      delete b.endedAt;
      if (d.state === 'pr_open' || d.state === 'done_local') d.state = 'running';
    });
    this.scheduleDelivery(missionId, builder.id);
    return ok(`Queued for ${who(builder)}; it gets the message when it is between turns. End your turn: the app messages you when it reports or asks.`);
  }

  private async answerRequest(missionId: string, args: MissionToolArgs['answer_request']): Promise<MissionToolResult> {
    const pending = this.approvals.get(args.requestId);
    if (!pending || pending.missionId !== missionId) {
      refuse(`There is no pending request ${args.requestId} in this mission; it may have been answered already or its Builder stopped.`);
    }
    const p = pending!;
    const record = this.records.get(missionId)!;
    const builder = this.builder(record, p.builderId);
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
    const builder = this.builder(record, args.builderId);
    if (args.passed) return ok(`Recorded: ${who(builder)}'s work passed your check.${builder.worktree && !builder.landed ? ' It still has to land on your branch before accept_builder.' : ' Call accept_builder when you are done with it.'}`);
    const failures = await this.mutate(missionId, (d) => {
      const b = this.builder(d, builder.id);
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

  private async builderView(missionId: string, builderId: string, kind: 'diff' | 'log', stat?: boolean): Promise<MissionToolResult> {
    const record = this.records.get(missionId)!;
    const builder = this.builder(record, builderId);
    if (!record.git) refuse("This mission's folder is not a git repository, so there is no diff or log; ask the Builder what it changed.");
    let cwd: string;
    let from: string;
    let to: string | undefined;
    if (builder.worktree) {
      if (builder.cleaned) refuse(`${who(builder)}'s worktree was removed after its work landed; its commits are on your branch.`);
      cwd = builder.worktree.path;
      const base = await mergeBase(cwd, record.leadBranch ?? 'HEAD', builder.worktree.branch);
      if (!base.ok) refuse(base.error);
      from = (base as Extract<typeof base, { ok: true }>).sha;
    } else {
      cwd = record.leadWorktree;
      if (!builder.startSha) refuse(`${who(builder)} has no recorded start commit.`);
      from = builder.startSha!;
    }
    if (kind === 'diff') {
      const r = await builderDiff(cwd, { from, ...(to ? { to } : {}), stat: stat === true });
      if (!r.ok) refuse(r.error);
      const v = r as Extract<typeof r, { ok: true }>;
      const scope = builder.worktree ? `${who(builder)}'s worktree ${builder.worktree.path}` : `your shared worktree (it may include other Builders' uncommitted changes)`;
      return ok(`Changes in ${scope} since ${from.slice(0, 9)}:\n\n${v.text}`);
    }
    const r = await builderLog(cwd, { from, to: builder.worktree?.branch ?? 'HEAD' });
    if (!r.ok) refuse(r.error);
    const v = r as Extract<typeof r, { ok: true }>;
    return ok(`${v.count} commit(s) on ${builder.worktree?.branch ?? record.leadBranch ?? 'the branch'} since ${from.slice(0, 9)}${builder.worktree ? '' : ' (shared worktree: every Builder’s commits)'}:\n${v.text}`);
  }

  private async acceptBuilder(missionId: string, builderId: string): Promise<MissionToolResult> {
    const record = this.records.get(missionId)!;
    const builder = this.builder(record, builderId);
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
      const b = this.builder(d, builder.id);
      b.accepted = true;
      b.state = 'done';
      if (b.worktree) b.landed = true;
      b.endedAt = Date.now();
      delete d.inbox.builders[b.id];
    });
    await this.deps.sessions.stop(builder.sessionId).catch(() => undefined);
    this.deps.gateway?.()?.revoke(builder.sessionId);
    if (builder.worktree && !builder.cleaned) void this.cleanBuilders(missionId, (b) => b.id === builder.id);
    return ok(`Accepted ${who(builder)}; its session stopped${builder.worktree ? ' and its worktree is being removed' : ''}.${extra}`);
  }

  private async stopBuilder(missionId: string, builderId: string): Promise<MissionToolResult> {
    const record = this.records.get(missionId)!;
    const builder = this.builder(record, builderId);
    if (builder.state === 'stopped') return ok(`${who(builder)} is already stopped.`);
    await this.mutate(missionId, (d) => {
      const b = this.builder(d, builder.id);
      b.state = 'stopped';
      b.endedAt = Date.now();
      delete d.inbox.builders[b.id];
    });
    for (const [id, p] of this.approvals) if (p.sessionId === builder.sessionId) this.approvals.delete(id);
    await this.deps.sessions.stop(builder.sessionId).catch(() => undefined);
    this.deps.gateway?.()?.revoke(builder.sessionId);
    if (builder.worktree && !builder.cleaned && builder.landed) void this.cleanBuilders(missionId, (b) => b.id === builder.id);
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
    void this.publish(missionId, args).finally(() => this.finishing.delete(missionId));
    return ok(record.pr
      ? 'Finishing: pushing the new commits and updating the PR description. End your turn; the app messages you when it is done.'
      : 'Finishing: pushing the branch and opening the PR. End your turn; the app messages you when it is done.');
  }

  /** The background half of finish_mission: one plain push, then the PR (or the local ending). */
  private async publish(missionId: string, report: FinalReport): Promise<void> {
    const record = this.records.get(missionId);
    if (!record?.leadBranch) return;
    const head = record.leadBranch;
    const base = record.baseBranch;
    const tell = (text: string) => this.enqueue(missionId, 'lead', { kind: 'note', text }).catch((e) => this.deps.log('warn', `mission ${missionId}: could not queue the finish result: ${errorMessage(e)}`));
    const local = async (reason: string) => {
      const body = renderReport(report, { kind: 'local', reason, branch: head });
      await this.mutate(missionId, (d) => {
        d.state = 'done_local';
        d.report = body;
      });
      await tell(`No PR was opened: ${reason} The work is on the local branch ${head}. Tell the user, with the report, briefly.`);
    };
    try {
      if (!base) return await local('the project had no branch checked out when the mission started, so there is no base branch for a PR.');
      const tip = await currentHead(record.leadWorktree);
      const sha = tip.ok ? tip.sha : undefined;
      if (record.pr) {
        const pushed = await pushBranch(record.leadWorktree, head);
        if (!pushed.ok) {
          if ('unavailable' in pushed && pushed.unavailable) return await local(pushed.error);
          return await tell(`finish_mission could not push ${head}: ${pushed.error} Fix that (a Builder can), then call finish_mission again.`);
        }
        const body = renderReport(report, { kind: 'pr', head, base, url: record.pr.url });
        const edited = await editPrBody(record.leadWorktree, record.pr.url, body);
        await this.mutate(missionId, (d) => {
          d.state = 'pr_open';
          d.report = body;
          if (d.pr && sha) d.pr.lastPushedSha = sha;
        });
        this.deps.sessions.refreshGitState(record.leadId);
        return await tell(`Pushed the new commits to ${record.pr.url}.${edited.ok ? ' The PR description now carries the new report.' : ` The PR description could not be updated: ${edited.error}`} Tell the user, briefly.`);
      }
      const body = renderReport(report, { kind: 'pr', head, base });
      const pr = await openPr(record.leadWorktree, { base, head, title: reportTitle(report), body });
      if (!pr.ok) {
        if ('unavailable' in pr && pr.unavailable) return await local(pr.error);
        return await tell(`finish_mission could not open the PR: ${pr.error} Fix that, then call finish_mission again.`);
      }
      const opened = pr as Extract<typeof pr, { ok: true }>;
      const url = opened.url ?? '';
      const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]) || undefined;
      await this.mutate(missionId, (d) => {
        d.state = 'pr_open';
        d.report = body;
        if (url) d.pr = { url, ...(number ? { number } : {}), ...(sha ? { lastPushedSha: sha } : {}) };
      });
      this.deps.sessions.refreshGitState(record.leadId);
      await tell(`${opened.existing ? 'A PR for this branch was already open' : 'The PR is open'}: ${url || '(gh printed no link)'} (${head} into ${base}), for the user to review; it is never merged automatically. Tell the user, briefly.`);
    } catch (e) {
      this.deps.log('warn', `mission ${missionId}: finishing failed: ${errorMessage(e)}`);
      await tell(`finish_mission failed: ${errorMessage(e)}. Call it again once the problem is fixed.`);
    }
  }

  private async askLead(missionId: string, builderId: string, question: string): Promise<MissionToolResult> {
    await this.mutate(missionId, (d) => {
      const b = this.builder(d, builderId);
      b.state = 'waiting_lead';
      b.pendingQuestion = question;
      d.inbox.lead.push(this.entry('question', `${who(b)} "${b.title}" asks:\n\n${question}\n\nAnswer with message_builder({ builderId: "${b.id}", text }).`, { builderId: b.id }));
    });
    this.scheduleDelivery(missionId, 'lead');
    return ok('Your question went to the Lead. End your turn now; the answer arrives as a message.');
  }

  private async reportDone(missionId: string, builderId: string, args: MissionToolArgs['report_done']): Promise<MissionToolResult> {
    const record = this.records.get(missionId)!;
    const builder = this.builder(record, builderId);
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
      const b = this.builder(d, builderId);
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
      d.inbox.lead.push(this.entry('report', lines.join('\n'), { builderId: b.id }));
    });
    this.scheduleDelivery(missionId, 'lead');
    return ok('Reported to the Lead. End your turn; the Lead may send follow-up work.');
  }

  private async reportBlocked(missionId: string, builderId: string, reason: string): Promise<MissionToolResult> {
    await this.mutate(missionId, (d) => {
      const b = this.builder(d, builderId);
      b.state = 'failed';
      delete b.pendingQuestion;
      d.inbox.lead.push(this.entry('failed', `${who(b)} "${b.title}" is blocked:\n\n${reason}\n\nAnswer with message_builder, or stop_builder it.`, { builderId: b.id }));
    });
    this.scheduleDelivery(missionId, 'lead');
    return ok('The Lead was told. End your turn.');
  }

  private async land(missionId: string, builderId: string): Promise<MissionToolResult> {
    const record = this.records.get(missionId)!;
    const builder = this.builder(record, builderId);
    if (!record.git || !builder.worktree || !record.leadBranch) refuse("You work in the Lead's folder, so there is nothing to land: commit your work and call report_done.");
    const wt = builder.worktree!;
    const landing = landOnLead({ missionId, leadWorktree: record.leadWorktree, leadBranch: record.leadBranch!, builderWorktree: wt.path, builderBranch: wt.branch }).then(async (r) => {
      if (r.ok && !r.alreadyLanded) {
        await this.mutate(missionId, (d) => {
          const b = this.builder(d, builderId);
          b.landed = true;
          d.inbox.lead.push(this.entry('note', `${who(b)} landed ${r.commits} commit(s) on ${record.leadBranch}; it is now at ${r.sha.slice(0, 9)}.`, { builderId: b.id }));
        }).catch((e) => this.deps.log('warn', `mission ${missionId}: could not record ${builderId}'s land: ${errorMessage(e)}`));
        this.scheduleDelivery(missionId, 'lead');
      } else if (r.ok) {
        await this.mutate(missionId, (d) => { this.builder(d, builderId).landed = true; }).catch(() => undefined);
      }
      return r;
    });
    const wait = this.deps.landWaitMs ?? LAND_WAIT_MS;
    let timer: NodeJS.Timeout | undefined;
    const late = Symbol('late');
    const first = await Promise.race([landing, new Promise<typeof late>((resolve) => { timer = setTimeout(() => resolve(late), wait); timer.unref?.(); })]);
    clearTimeout(timer);
    const answer = (r: Awaited<typeof landing>): string => (r.ok
      ? r.alreadyLanded ? `Your branch is already on ${record.leadBranch}. Call report_done.` : `Landed ${r.commits} commit(s) on ${record.leadBranch}. Call report_done now.`
      : r.error);
    if (first !== late) return first.ok ? ok(answer(first)) : { text: answer(first), isError: true };
    void landing.then((r) => this.enqueue(missionId, builderId, { kind: 'note', text: `land_on_lead finished: ${answer(r)}` })).catch(() => undefined);
    return ok('Landing is taking a while; it carries on in the background. End your turn: the app messages you with the result.');
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
        d.inbox.lead.push(this.entry('failed', `${who(b)} "${b.title}": its turn failed${turn.error ? `: ${clip(turn.error, 600)}` : '.'}\n\nSend it a message to retry, or stop_builder it.`, { builderId: b.id }));
        return true;
      }
      // A message already waiting for it starts its next turn; nothing to report yet.
      if (d.inbox.builders[b.id]?.length) return false;
      b.state = 'waiting_lead';
      d.inbox.lead.push(this.entry('note', `${who(b)} "${b.title}" ended its turn${turn.status === 'interrupted' ? ' (interrupted)' : ''} without report_done, ask_lead or report_blocked.${said ? ` Its last words:\n\n${clip(said, 1_500)}` : ''}\n\nTell it what to do with message_builder.`, { builderId: b.id }));
      return true;
    }).catch((e) => {
      this.deps.log('warn', `mission ${missionId}: could not record ${builderId}'s turn end: ${errorMessage(e)}`);
      return false;
    });
    if (queued) this.scheduleDelivery(missionId, 'lead');
  }

  private async onBuilderFailed(missionId: string, builderId: string, message: string): Promise<void> {
    const queued = await this.mutate(missionId, (d) => {
      const b = d.builders.find((x) => x.id === builderId);
      if (!b || b.accepted || b.state === 'stopped' || b.state === 'failed' || !DELIVERING.has(d.state)) return false;
      b.state = 'failed';
      d.inbox.lead.push(this.entry('failed', `${who(b)} "${b.title}" stopped with an error: ${clip(message, 600)}\n\nSend it a message to retry, or stop_builder it.`, { builderId: b.id }));
      return true;
    }).catch(() => false);
    if (queued) this.scheduleDelivery(missionId, 'lead');
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

  // -------------------------------------------------------------------------------------------
  // Delivery

  private kick(ref: SessionRef): void {
    const record = this.records.get(ref.missionId);
    if (!record) return;
    const target: Target = ref.role === 'lead' ? 'lead' : ref.builderId!;
    if (this.inboxOf(record, target).length) this.scheduleDelivery(ref.missionId, target);
  }

  /** Arms (or brings forward) the delivery of one target's inbox. */
  private scheduleDelivery(missionId: string, target: Target, delay = this.deps.deliveryDelayMs ?? DELIVERY_DELAY_MS): void {
    if (this.disposed) return;
    const key = `${missionId}:${target}`;
    const back = this.backoff.get(key);
    const at = Math.max(Date.now() + delay, back?.until ?? 0);
    const pending = this.timers.get(key);
    if (pending && pending.at <= at) return;
    if (pending) clearTimeout(pending.timer);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.deliver(missionId, target).catch((e) => this.deps.log('warn', `mission ${missionId}: delivery to ${target} failed: ${errorMessage(e)}`));
    }, Math.max(0, at - Date.now()));
    timer.unref?.();
    this.timers.set(key, { timer, at });
  }

  /** One combined host message, only when the target is between turns. */
  private async deliver(missionId: string, target: Target): Promise<void> {
    const key = `${missionId}:${target}`;
    if (this.delivering.has(key) || this.disposed) return;
    const record = this.records.get(missionId);
    if (!record || !DELIVERING.has(record.state)) return;
    const builder = target === 'lead' ? undefined : record.builders.find((b) => b.id === target);
    if (target !== 'lead' && (!builder || builder.state === 'stopped' || builder.accepted)) return;
    const sessionId = builder ? builder.sessionId : record.leadId;
    if (!this.inboxOf(record, target).length) return;
    if (!this.idle(sessionId)) {
      // The next status or turn event brings this forward; the poll covers a runtime still disposing.
      this.scheduleDelivery(missionId, target, BUSY_POLL_MS);
      return;
    }
    this.delivering.add(key);
    let taken: InboxEntry[] = [];
    try {
      taken = await this.mutate(missionId, (d) => {
        const list = this.inboxOf(d, target);
        if (target === 'lead') d.inbox.lead = [];
        else delete d.inbox.builders[target];
        return list;
      });
      if (!taken.length) return;
      // The record write gave the session a moment: never send into a turn that started meanwhile.
      if (!this.idle(sessionId)) {
        await this.putBack(missionId, target, taken);
        taken = [];
        this.scheduleDelivery(missionId, target, BUSY_POLL_MS);
        return;
      }
      // The kickoff rides with the role prompt itself; later messages re-anchor harnesses without one.
      const { text, meta } = combine(taken, !!builder && needsRoleReminder(builder.harness) && taken.some((e) => e.kind !== 'kickoff'));
      await this.deps.sessions.sendHost(sessionId, text, meta);
      this.backoff.delete(key);
    } catch (e) {
      if (e instanceof RecordWriteError) {
        this.deps.log('warn', `mission ${missionId}: could not take ${target}'s messages: ${e.message}`);
      } else {
        this.deps.log('warn', `mission ${missionId}: could not deliver to ${target}: ${errorMessage(e)}`);
        if (taken.length) await this.putBack(missionId, target, taken).catch(() => undefined);
      }
      const failures = (this.backoff.get(key)?.failures ?? 0) + 1;
      this.backoff.set(key, { failures, until: Date.now() + Math.min(MAX_BACKOFF_MS, 15_000 * 2 ** (failures - 1)) });
      if (failures === 3) this.deliveryStalled(missionId, target, errorMessage(e));
    } finally {
      this.delivering.delete(key);
      const now = this.records.get(missionId);
      if (now && this.inboxOf(now, target).length) this.scheduleDelivery(missionId, target);
    }
  }

  private async putBack(missionId: string, target: Target, entries: InboxEntry[]): Promise<void> {
    await this.mutate(missionId, (d) => {
      if (target === 'lead') d.inbox.lead = [...entries, ...d.inbox.lead];
      else d.inbox.builders[target] = [...entries, ...(d.inbox.builders[target] ?? [])];
    });
  }

  private deliveryStalled(missionId: string, target: Target, error: string): void {
    const record = this.records.get(missionId);
    if (!record) return;
    if (target === 'lead') {
      this.deps.sessions.note(record.leadId, `Mission messages could not be delivered to the Lead: ${error}. They are kept and retried.`, 'warn');
      return;
    }
    void this.mutate(missionId, (d) => {
      const b = d.builders.find((x) => x.id === target);
      if (!b || !isActive(b)) return;
      b.state = 'failed';
      d.inbox.lead.push(this.entry('failed', `${who(b)} "${b.title}" could not be reached: ${clip(error, 400)}. Its messages are kept; stop_builder it or try message_builder later.`, { builderId: b.id }));
    }).then(() => this.scheduleDelivery(missionId, 'lead')).catch(() => undefined);
  }

  /** Between turns: no turn or start in flight, no pending approval, nothing queued, not tearing down. */
  private idle(sessionId: string): boolean {
    const meta = this.deps.sessions.get(sessionId);
    if (!meta || meta.archived) return false;
    if (meta.status === 'running' || meta.status === 'starting' || meta.status === 'awaiting') return false;
    const a = this.deps.sessions.activity(sessionId);
    return !a.turn && !a.starting && !a.approvals && !a.queued && !a.tearingDown && !a.compacting && !a.tools;
  }

  private async enqueue(missionId: string, target: Target, entry: Omit<InboxEntry, 'id' | 'ts'>): Promise<void> {
    await this.mutate(missionId, (d) => {
      const e = this.entry(entry.kind, entry.text, { builderId: entry.builderId, requestId: entry.requestId });
      if (target === 'lead') d.inbox.lead.push(e);
      else (d.inbox.builders[target] ??= []).push(e);
    });
    this.scheduleDelivery(missionId, target);
  }

  // -------------------------------------------------------------------------------------------
  // Lead creation

  private async adoptLead(source: SessionMeta, p: { missionId: string; projectRoot: string; git: boolean; slug: string; input: UserInput; uncommittedAtStart?: boolean; baseBranch?: string }): Promise<{ leadId: string }> {
    const { sessions } = this.deps;
    const originalCwd = source.cwd;
    let plan: LeadPlan = { cwd: source.cwd, uncommittedAtStart: false, owned: false };
    if (p.git) {
      plan = await this.planLeadWorktree(source, p.projectRoot, p.slug);
      // A mission session can no longer move, so it moves into its worktree first.
      if (plan.created) {
        try {
          await sessions.moveTo(source.id, plan.created.path);
        } catch (e) {
          await this.removeWorktree({ projectRoot: p.projectRoot, leadBranch: plan.branch, baseBranch: plan.baseBranch }, plan.created);
          throw e;
        }
      }
    }
    const record = this.newRecord(p.missionId, source.id, p.projectRoot, p.git, plan, p);
    const rollback = async () => {
      if (!plan.created) return;
      await sessions.moveTo(source.id, originalCwd).catch(() => undefined);
      await this.removeWorktree({ projectRoot: p.projectRoot, leadBranch: plan.branch, baseBranch: plan.baseBranch }, plan.created);
    };
    try {
      await this.writeRecord(record);
    } catch (e) {
      await rollback();
      throw new Error(`The mission record could not be saved: ${errorMessage(e)}`);
    }
    try {
      await sessions.adoptMissionSession(source.id, { mission: { missionId: p.missionId, role: 'lead', state: 'running' }, permissionMode: 'plan' });
    } catch (e) {
      await fs.rm(this.recordFile(source.id), { force: true }).catch(() => undefined);
      await rollback();
      throw e;
    }
    this.records.set(record.id, record);
    this.index(record);
    this.deps.log('info', `[${source.id}] mission ${record.id} started in this session${record.leadBranch ? ` on ${record.leadBranch}` : ''}`);
    this.sendFirst(source.id, p.input);
    return { leadId: source.id };
  }

  private async forkLead(source: SessionMeta, p: { missionId: string; projectRoot: string; git: boolean; slug: string; input: UserInput }): Promise<{ leadId: string }> {
    const { sessions } = this.deps;
    let plan: LeadPlan = { cwd: p.projectRoot, uncommittedAtStart: false, owned: false };
    if (p.git) {
      const wt = await this.newLeadWorktree(p.projectRoot, source.cwd, p.slug);
      plan = { ...wt, owned: true, created: { path: wt.cwd, branch: wt.branch! } };
    }
    const cfg = source.config;
    const model = source.activeModel ?? cfg.model;
    const config: SessionConfig = {
      harness: cfg.harness,
      projectRoot: p.projectRoot,
      ...(model ? { model } : {}),
      ...(cfg.effort !== undefined ? { effort: cfg.effort } : {}),
      permissionMode: 'plan',
      useWorktree: p.git,
      ...(p.git ? { branchPrefix: MISSION_BRANCH_PREFIX } : cfg.branchPrefix ? { branchPrefix: cfg.branchPrefix } : {}),
      ...(cfg.acpAgent ? { acpAgent: cfg.acpAgent } : {}),
      ...(cfg.appendSystemPrompt ? { appendSystemPrompt: cfg.appendSystemPrompt } : {}),
      ...(cfg.maxBudgetUsd !== undefined ? { maxBudgetUsd: cfg.maxBudgetUsd } : {}),
      ...(cfg.codexModelProvider ? { codexModelProvider: cfg.codexModelProvider } : {})
    };
    let lead: SessionMeta;
    try {
      lead = await sessions.createMissionSession({
        config,
        title: titleFromPrompt(p.input.text),
        cwd: plan.cwd,
        ...(plan.created ? { worktreeBranch: plan.created.branch } : {}),
        mission: { missionId: p.missionId, role: 'lead', state: 'running' },
        forkContextFrom: source.id
      });
    } catch (e) {
      if (plan.created) await this.removeWorktree({ projectRoot: p.projectRoot, leadBranch: plan.branch, baseBranch: plan.baseBranch }, plan.created);
      throw e;
    }
    const record = this.newRecord(p.missionId, lead.id, p.projectRoot, p.git, plan, {});
    try {
      await this.writeRecord(record);
    } catch (e) {
      await sessions.delete(lead.id).catch(() => undefined);
      if (plan.created) await this.removeWorktree({ projectRoot: p.projectRoot, leadBranch: plan.branch, baseBranch: plan.baseBranch }, plan.created);
      throw new Error(`The mission record could not be saved: ${errorMessage(e)}`);
    }
    this.records.set(record.id, record);
    this.index(record);
    this.deps.log('info', `[${lead.id}] mission ${record.id} started from ${source.id}${record.leadBranch ? ` on ${record.leadBranch}` : ''}`);
    this.sendFirst(lead.id, p.input);
    return { leadId: lead.id };
  }

  /** The user's own message, as typed, is the Lead's first turn. */
  private sendFirst(leadId: string, input: UserInput): void {
    void this.deps.sessions.send(leadId, input).catch((e) => this.deps.sessions.note(leadId, `The mission's first message could not be sent: ${errorMessage(e)}`, 'error'));
  }

  /** The empty-session toggle: reuse the worktree the session runs in, or make a new one. */
  private async planLeadWorktree(source: SessionMeta, projectRoot: string, slug: string): Promise<LeadPlan> {
    let reuse: { cwd: string; branch: string; owned: boolean } | undefined;
    if (source.worktreeBranch) reuse = { cwd: source.cwd, branch: source.worktreeBranch, owned: true };
    else {
      const [here, project] = await Promise.all([gitRoot(source.cwd), gitRoot(projectRoot)]);
      if (here && project && !samePath(here, project)) {
        const head = await currentHead(source.cwd);
        if (!head.ok || !head.branch) throw new Error("The session's worktree has no branch checked out; check one out, then start the mission.");
        reuse = { cwd: source.cwd, branch: head.branch, owned: false };
      }
    }
    if (reuse) {
      const wt = await ensureLeadWorktree(projectRoot, slug, { cwd: reuse.cwd, branch: reuse.branch });
      if (!wt.ok) throw new Error(wt.error);
      const w = wt as Extract<typeof wt, { ok: true }>;
      return { cwd: w.path, branch: w.branch, ...(w.baseBranch ? { baseBranch: w.baseBranch } : {}), startSha: w.startSha, uncommittedAtStart: w.uncommittedAtStart, owned: reuse.owned };
    }
    const wt = await this.newLeadWorktree(projectRoot, source.cwd, slug);
    return { ...wt, owned: true, created: { path: wt.cwd, branch: wt.branch! } };
  }

  /** A new `mission/<slug>` worktree at the source checkout's HEAD; its uncommitted changes stay behind. */
  private async newLeadWorktree(projectRoot: string, sourceCwd: string, slug: string): Promise<Omit<LeadPlan, 'owned' | 'created'>> {
    const [here, project] = await Promise.all([gitRoot(sourceCwd), gitRoot(projectRoot)]);
    if (!project) throw new Error('This folder is not a git repository.');
    if (!here || samePath(here, project)) {
      const wt = await ensureLeadWorktree(projectRoot, slug);
      if (!wt.ok) throw new Error(wt.error);
      const w = wt as Extract<typeof wt, { ok: true }>;
      return { cwd: w.path, branch: w.branch, ...(w.baseBranch ? { baseBranch: w.baseBranch } : {}), startSha: w.startSha, uncommittedAtStart: w.uncommittedAtStart };
    }
    // The source runs in a worktree of its own: the mission starts from that checkout.
    const head = await currentHead(sourceCwd);
    if (!head.ok) throw new Error("The session's folder has no commit checked out.");
    const h = head as Extract<typeof head, { ok: true }>;
    const status = await statusPorcelain(sourceCwd);
    const made = await createWorktree(project, branchSlug(slug) || 'mission', { branchPrefix: MISSION_BRANCH_PREFIX, startPoint: h.sha });
    return { cwd: made.path, branch: made.branch, ...(h.branch ? { baseBranch: h.branch } : {}), startSha: h.sha, uncommittedAtStart: status.ok ? !status.clean : false };
  }

  private newRecord(missionId: string, leadId: string, projectRoot: string, git: boolean, plan: LeadPlan, overrides: { uncommittedAtStart?: boolean; baseBranch?: string }): MissionRecord {
    const now = Date.now();
    const baseBranch = overrides.baseBranch ?? plan.baseBranch;
    return {
      v: 1, id: missionId, leadId, createdAt: now, updatedAt: now, state: 'running', projectRoot, git,
      ...(baseBranch ? { baseBranch } : {}),
      ...(plan.branch ? { leadBranch: plan.branch } : {}),
      leadWorktree: plan.cwd,
      leadWorktreeOwned: git && plan.owned,
      ...(plan.startSha ? { startSha: plan.startSha } : {}),
      uncommittedAtStart: overrides.uncommittedAtStart ?? plan.uncommittedAtStart,
      builders: [],
      inbox: { lead: [], builders: {} }
    };
  }

  /** Builders run on Settings → Sessions → Mission mode; "Same as Lead" copies the Lead's harness, model and effort. */
  private builderSpec(lead: SessionMeta): { config: SessionConfig } {
    const d = (this.deps.settings().missionDefaults ?? DEFAULT_MISSION_DEFAULTS).builder;
    let harness: HarnessId;
    let model: ModelRef | undefined;
    let effort: EffortLevel | null | undefined;
    let extra: Partial<SessionConfig> = {};
    if (d.harness === 'same') {
      harness = lead.config.harness;
      model = lead.activeModel ?? lead.config.model;
      effort = lead.activeEffort ?? lead.config.effort;
      if (lead.config.codexModelProvider) extra = { codexModelProvider: lead.config.codexModelProvider };
    } else {
      harness = d.harness;
      model = d.model;
      effort = d.effort;
    }
    const descriptor = HARNESS_BY_ID[harness];
    if (!descriptor || !missionSupport(harness).builder) refuse(`${descriptor?.name ?? harness} cannot run Builders. Choose another Builder harness in Settings → Sessions → Mission mode.`);
    const permissionMode: PermissionMode = closestPermissionMode(harness, d.permissionMode);
    return { config: { harness, projectRoot: '', ...(model ? { model } : {}), ...(effort !== undefined ? { effort } : {}), permissionMode, ...extra } };
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
    await this.cleanBuilders(missionId, (b) => !!b.worktree && !b.cleaned, notes);
    if (after.leadWorktreeOwned && !after.leadWorktreeCleaned) {
      await this.deps.sessions.stop(after.leadId).catch(() => undefined);
      const current = this.records.get(missionId) ?? after;
      const outcome = await cleanLeadWorktree(current, how === 'merged').catch((e: unknown) => ({ removed: false, note: errorMessage(e) }));
      if (outcome.removed) await this.mutate(missionId, (d) => { d.leadWorktreeCleaned = true; }).catch(() => undefined);
      if (outcome.note) notes.push(outcome.note);
    }
    this.deps.sessions.note(after.leadId, `The PR was ${how}, so the mission ended.${notes.length ? ` ${notes.join(' ')}` : ' Its worktrees were cleaned up.'}`);
  }

  /** Removes the matching Builders' worktrees one at a time and records what was removed. */
  private async cleanBuilders(missionId: string, which: (b: BuilderRecord) => boolean, notes: string[] = []): Promise<string[]> {
    const record = this.records.get(missionId);
    if (!record) return notes;
    for (const b of record.builders.filter(which)) {
      const current = this.records.get(missionId);
      const builder = current?.builders.find((x) => x.id === b.id);
      if (!current || !builder || builder.cleaned) continue;
      const outcome = await cleanBuilderWorktree(current, builder).catch((e: unknown) => ({ removed: false, note: errorMessage(e) }));
      if (outcome.removed) await this.mutate(missionId, (d) => { this.builder(d, b.id).cleaned = true; }).catch(() => undefined);
      if (outcome.note) {
        notes.push(outcome.note);
        this.deps.log('info', `mission ${missionId}: ${outcome.note}`);
      }
    }
    return notes;
  }

  private async removeWorktree(record: Pick<MissionRecord, 'projectRoot' | 'leadBranch' | 'baseBranch'>, wt: { path: string; branch: string }): Promise<void> {
    const r = await cleanupWorktree({ projectRoot: record.projectRoot, path: wt.path, branch: wt.branch, mergedInto: [record.leadBranch, record.baseBranch].filter((b): b is string => !!b && b !== wt.branch) }).catch((e: unknown) => ({ ok: false as const, error: errorMessage(e) }));
    if (!r.ok) this.deps.log('warn', `mission: could not remove the worktree ${wt.path}: ${r.error}`);
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
    for (const [key, t] of this.timers) {
      if (!key.startsWith(`${missionId}:`)) continue;
      clearTimeout(t.timer);
      this.timers.delete(key);
    }
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
  // Lookups and text

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

  private builder(record: MissionRecord, builderId: string): BuilderRecord {
    const b = record.builders.find((x) => x.id === builderId || x.sessionId === builderId);
    if (!b) refuse(`There is no Builder ${builderId} in this mission. list_builders shows their ids.`);
    return b!;
  }

  private inboxOf(record: MissionRecord, target: Target): InboxEntry[] {
    return target === 'lead' ? record.inbox.lead : record.inbox.builders[target] ?? [];
  }

  private entry(kind: MissionMessageKind, text: string, extra: { builderId?: string; requestId?: string } = {}): InboxEntry {
    return { id: shortId('mi_'), kind, text, ...(extra.builderId ? { builderId: extra.builderId } : {}), ...(extra.requestId ? { requestId: extra.requestId } : {}), ts: Date.now() };
  }

  private view(record: MissionRecord): MissionView {
    return {
      id: record.id,
      leadId: record.leadId,
      state: record.state,
      git: record.git,
      ...(record.baseBranch ? { baseBranch: record.baseBranch } : {}),
      ...(record.leadBranch ? { leadBranch: record.leadBranch } : {}),
      ...(record.pr?.url ? { prUrl: record.pr.url } : {}),
      builders: record.builders.map((b) => ({ id: b.id, sessionId: b.sessionId, index: b.index, title: b.title, state: b.state, ownWorktree: !!b.worktree, failedChecks: b.failedChecks })),
      blockedOnUser: [...(record.checksBlockedUntilUser ?? [])]
    };
  }

  private roster(record: MissionRecord, waiting: boolean): string {
    const lines = record.builders.length
      ? record.builders.map((b) => {
          const where = b.worktree ? `own worktree on ${b.worktree.branch}${b.landed ? ', landed' : ''}` : 'shares your worktree';
          const blocked = record.checksBlockedUntilUser?.includes(b.id) ? '; blocked until the user replies' : '';
          const asked = b.pendingQuestion ? `; asked: "${clip(b.pendingQuestion, 200)}"` : '';
          return `- ${who(b)} "${b.title}" (session ${b.sessionId}): ${b.accepted ? 'accepted' : STATE_WORDS[b.state]}; ${where}${b.failedChecks ? `; ${b.failedChecks} failed check(s)` : ''}${blocked}${asked}`;
        })
      : ['- No Builders yet. Start one with start_builder.'];
    const active = record.builders.filter(isActive).length;
    const tail = waiting
      ? active ? `\n\n${active} Builder(s) still on their tasks. End your turn now: the app messages you when one reports, asks or fails. Do not poll.` : '\n\nNo Builder is working; there is nothing to wait for.'
      : '';
    return `Mission ${record.id} (${record.state}):\n${lines.join('\n')}${tail}`;
  }

  /** What the role prompt adds about this mission right now (Lead): where it started, who works. */
  private leadContext(record: MissionRecord): string {
    const lines: string[] = [];
    if (record.git && record.uncommittedAtStart) lines.push(record.leadWorktreeOwned ? '- The project checkout had uncommitted changes when the mission started; they are not in your worktree. Tell the user, and ask if the task depends on them.' : '- Your worktree already had uncommitted changes when the mission started; make sure the Builders know what is whose.');
    if (record.builders.length) {
      lines.push('- Builders so far:');
      for (const b of record.builders) lines.push(`  - ${who(b)} "${b.title}": ${b.accepted ? 'accepted' : STATE_WORDS[b.state]}${b.worktree ? `, own worktree on ${b.worktree.branch}` : ', shares your worktree'}`);
    }
    if (record.pr?.url) lines.push(`- The PR is open: ${record.pr.url}`);
    return lines.length ? `## This mission so far\n${lines.join('\n')}` : '';
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers

/** A Builder whose harness took its role prompt only with its first message (ACP) is re-anchored on each one. */
function needsRoleReminder(harness: HarnessId): boolean {
  const d = HARNESS_BY_ID[harness];
  return !!d && !d.capabilities.systemPrompt && harness !== 'codex';
}

/** One host message from several inbox entries; its card kind is theirs when they agree. */
function combine(entries: InboxEntry[], reminder: boolean): { text: string; meta: MissionMessageMeta } {
  const kinds = new Set(entries.map((e) => e.kind));
  const builders = new Set(entries.map((e) => e.builderId));
  const kind: MissionMessageKind = kinds.size === 1 ? entries[0].kind : 'note';
  const builderId = builders.size === 1 ? entries[0].builderId : undefined;
  const requestId = entries.length === 1 ? entries[0].requestId : undefined;
  const body = entries.map((e) => e.text).join('\n\n---\n\n');
  return {
    text: reminder ? `${roleReminder('builder')}\n\n${body}` : body,
    meta: { kind, ...(builderId ? { builderId } : {}), ...(requestId ? { requestId } : {}) }
  };
}

function approvalText(builder: BuilderRecord, request: ApprovalRequest, route: ApprovalMissionRoute): string {
  const lines = [`${who(builder)} "${builder.title}" asks for permission: ${request.title}`];
  if (request.command) lines.push(`Command: ${clip(request.command, 2_000)}`);
  if (request.cwd) lines.push(`Folder: ${request.cwd}`);
  if (request.changes?.length) lines.push(`Files: ${request.changes.slice(0, 20).map((c) => c.path).join(', ')}`);
  if (request.toolName && !request.command) lines.push(`Tool: ${request.toolName}`);
  lines.push(`Request id: ${request.id}`, '');
  lines.push(route.route === 'lead'
    ? `The Builder waits for you. Answer with answer_request({ requestId: "${request.id}", decision: "allow" | "deny", note }).`
    : `Only the user can approve this: it ${route.reason ?? 'needs the user'}, and the user has been asked. Answer allow with answer_request to recommend it to the user, or deny it; you cannot approve it yourself.`);
  return lines.join('\n');
}

/** Puts a block before the Mission rules recap, which must stay last. */
function beforeRecap(text: string, extra: string): string {
  const at = text.lastIndexOf('\n\n## Mission rules');
  return at >= 0 ? `${text.slice(0, at)}\n\n${extra}${text.slice(at)}` : `${extra}\n\n${text}`;
}

function parseRecord(raw: unknown, meta: SessionMeta): MissionRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<MissionRecord>;
  if (r.v !== 1 || typeof r.id !== 'string' || r.id !== meta.mission?.missionId || r.leadId !== meta.id) return null;
  if (typeof r.projectRoot !== 'string' || typeof r.leadWorktree !== 'string' || typeof r.state !== 'string') return null;
  const builders = Array.isArray(r.builders) ? r.builders.filter((b): b is BuilderRecord => !!b && typeof b === 'object' && typeof b.id === 'string' && typeof b.sessionId === 'string') : [];
  const inbox = r.inbox && typeof r.inbox === 'object' ? r.inbox : { lead: [], builders: {} };
  return {
    ...(r as MissionRecord),
    git: r.git === true,
    leadWorktreeOwned: r.leadWorktreeOwned === true,
    builders: builders.map((b) => ({ ...b, failedChecks: typeof b.failedChecks === 'number' ? b.failedChecks : 0 })),
    inbox: { lead: Array.isArray(inbox.lead) ? inbox.lead : [], builders: inbox.builders && typeof inbox.builders === 'object' ? inbox.builders : {} }
  };
}
