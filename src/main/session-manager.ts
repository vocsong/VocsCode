/** Owns sessions: transcripts, approvals, goals, worktrees, and resuming a session after a restart. */
import path from 'node:path';
import type {
  ApprovalDecision,
  ApprovalRequest,
  AppSettings,
  CreateSessionRequest,
  EffortLevel,
  GoalState,
  HarnessRef,
  ModelInfo,
  ModelRef,
  PermissionMode,
  SessionEvent,
  SessionEventEnvelope,
  SessionMeta,
  SessionStatus,
  TranscriptItem,
  UserInput
} from '../shared/types';
import { HARNESS_BY_ID } from '../shared/harness-meta';
import { createAdapter } from './harness/registry';
import type { ApprovalDraft, HarnessAdapter, HarnessContext } from './harness/types';
import { branchGitState, createWorktree, gitRoot, gitWorktrees, removeWorktree, restoreWorktree, slugify, worktreeAddForBranch, worktreeInfo, type BranchGitState } from './git';
import { emptyUsage } from './models/static-models';
import { applyModelOverrides } from '../shared/model-overrides';
import type { RuntimeResolver } from './runtime';
import type { SettingsStore } from './settings';
import type { SessionStore } from './store';
import type { AnalyticsStore } from './analytics';
import { deferred, errorMessage, shortId, type Deferred } from './util/async';
import { readJson, writeJson } from './util/fs';

export interface SessionManagerDeps {
  store: SessionStore;
  settings: SettingsStore;
  runtime: RuntimeResolver;
  analytics: AnalyticsStore;
  getSecret: (providerId: string) => Promise<string | undefined>;
  pushEvent: (env: SessionEventEnvelope) => void;
  pushSessions: (sessions: SessionMeta[]) => void;
  notify: (sessionId: string, title: string, body: string) => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

interface ActiveSession {
  adapter: HarnessAdapter;
  approvals: Map<string, Deferred<ApprovalDecision>>;
  liveItems: Map<string, TranscriptItem>;
  dirty: Set<string>;
  lastAssistantText: string;
  starting: Promise<void> | null;
  /** Last list the harness reported, before user overrides, so it can be re-published. */
  models: ModelInfo[] | null;
}

const GOAL_COMPLETE_TOKEN = 'GOAL_COMPLETE';

export class SessionManager {
  /** How often a session parked on 'pr' re-checks whether its branch was merged. */
  private static readonly GIT_STATE_RECHECK_MS = 120_000;

  private active = new Map<string, ActiveSession>();
  private persistTimers = new Map<string, NodeJS.Timeout>();
  private gitStateTimers = new Map<string, NodeJS.Timeout>();
  /** Sessions whose restored git state was re-checked once after boot. */
  private gitStateChecked = new Set<string>();

  constructor(private readonly deps: SessionManagerDeps) {}

  list(): SessionMeta[] {
    const list = this.deps.store.list();
    // Sessions restored while parked on a PR resume polling for their merge.
    for (const s of list) {
      if (s.status === 'pr' && !this.gitStateChecked.has(s.id)) {
        this.gitStateChecked.add(s.id);
        this.scheduleGitStateCheck(s.id);
      }
    }
    return list;
  }

  get(id: string): SessionMeta | undefined {
    return this.deps.store.get(id);
  }

  private settings(): AppSettings {
    return this.deps.settings.get();
  }

  private pushSessions(): void {
    this.deps.pushSessions(this.list());
  }

  /** Debounced per session; a persist never resurrects a session deleted in the meantime. */
  private schedulePersist(meta: SessionMeta): void {
    meta.updatedAt = Date.now();
    const prev = this.persistTimers.get(meta.id);
    if (prev) clearTimeout(prev);
    this.persistTimers.set(
      meta.id,
      setTimeout(() => {
        this.persistTimers.delete(meta.id);
        if (this.deps.store.get(meta.id)) void this.deps.store.upsert(meta);
      }, 300)
    );
  }

  private cancelPersist(id: string): void {
    const t = this.persistTimers.get(id);
    if (t) clearTimeout(t);
    this.persistTimers.delete(id);
  }

  /** Schedules a PR/merge status check shortly after a turn ends in an isolated worktree. */
  private scheduleGitStateCheck(id: string, delayMs = 4_000): void {
    const prev = this.gitStateTimers.get(id);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.gitStateTimers.delete(id);
      void this.checkGitState(id, true);
    }, delayMs);
    timer.unref?.();
    this.gitStateTimers.set(id, timer);
  }

  /** Re-runs the PR/merge state check after a local /pr or /merge completes outside a turn. */
  refreshGitState(id: string): void {
    this.scheduleGitStateCheck(id, 1_000);
  }

  /** Appends a persistent info line to a session's transcript (renderer-visible, survives restart). */
  note(id: string, text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.emit(id, { type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level, text } });
  }

  /** Reflects the session branch's PR/merge state in the sidebar status label. */
  private async checkGitState(id: string, recheck: boolean): Promise<void> {
    const meta = this.get(id);
    if (!meta || !meta.worktreeBranch) return;
    if (!this.gitStateCheckable(meta.status)) return;
    let state: BranchGitState;
    try {
      state = await branchGitState(meta.cwd, meta.worktreeBranch);
    } catch (e) {
      this.deps.log('warn', `pr/merge status check failed: ${errorMessage(e)}`);
      return;
    }
    // The check can take seconds over the network; the session may have moved on.
    if (!this.gitStateCheckable(meta.status)) return;
    const next: SessionStatus = state.merged ? 'merged' : state.pr ? 'pr' : 'idle';
    if (meta.status === next || meta.status === 'merged' || meta.status === 'error' || meta.status === 'stopped') return;
    meta.status = next;
    meta.statusDetail = undefined;
    this.schedulePersist(meta);
    this.pushSessions();
    // Parked on 'pr': keep polling so the label flips to 'merged' once it lands.
    if (next === 'pr' && recheck) this.scheduleGitStateCheck(id, SessionManager.GIT_STATE_RECHECK_MS);
  }

  /** Only idle/pr sessions take a label update; live or already-final statuses are left alone. */
  private gitStateCheckable(status: SessionStatus): boolean {
    return status === 'idle' || status === 'pr' || status === 'merged';
  }

  /** Persists every debounced meta update immediately (used on quit so trailing edits are not lost). */
  async flushPendingPersists(): Promise<void> {
    const entries = [...this.persistTimers];
    this.persistTimers.clear();
    await Promise.all(
      entries.map(([id, t]) => {
        clearTimeout(t);
        const meta = this.deps.store.get(id);
        return meta ? this.deps.store.upsert(meta).catch(() => undefined) : Promise.resolve();
      })
    );
  }

  async create(req: CreateSessionRequest): Promise<SessionMeta> {
    const id = shortId('s_');
    const cfg = req.config;
    let cwd = cfg.projectRoot;
    let worktreeBranch: string | undefined;
    if (req.checkoutBranch) {
      // Reuse an existing worktree on the branch; otherwise create one for it.
      if (!/^[\w][\w./-]*$/.test(req.checkoutBranch)) throw new Error('Invalid branch name');
      const wts = await gitWorktrees(cfg.projectRoot);
      const existing = wts.worktrees.find((w) => w.branch === req.checkoutBranch);
      if (existing) {
        cwd = existing.path;
        worktreeBranch = req.checkoutBranch;
      } else {
        const wt = await worktreeAddForBranch(cfg.projectRoot, req.checkoutBranch);
        cwd = wt.path;
        worktreeBranch = wt.branch;
      }
    } else if (cfg.useWorktree) {
      const wt = await createWorktree(cfg.projectRoot, slugify(req.title || req.initialPrompt || id));
      cwd = wt.path;
      worktreeBranch = wt.branch;
    }
    const s = this.settings();
    const title = req.title?.trim() || (req.initialPrompt ? req.initialPrompt.trim().split('\n')[0].slice(0, 60) : 'New session');
    const meta: SessionMeta = {
      id,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      config: { ...cfg, model: cfg.model ?? s.defaultModelByHarness[cfg.harness] },
      cwd,
      worktreeBranch,
      status: 'idle',
      harnessRef: {},
      usage: emptyUsage(),
      activeModel: cfg.model ?? s.defaultModelByHarness[cfg.harness],
      activeEffort: cfg.effort,
      queued: 0
    };
    if (req.goal?.trim()) {
      meta.goal = {
        objective: req.goal.trim(),
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        iterations: 0,
        maxIterations: s.goalDefaults.maxIterations,
        autoContinue: s.goalDefaults.autoContinue
      };
    }
    await this.deps.store.upsert(meta);
    this.deps.analytics.touchSession(meta);
    const recent = [cfg.projectRoot, ...s.recentProjects.filter((p) => p !== cfg.projectRoot)].slice(0, 12);
    // The folder keeps its sidebar entry even after its last session is archived or deleted.
    const folders = s.folders.includes(cfg.projectRoot) ? s.folders : [...s.folders, cfg.projectRoot];
    await this.deps.settings.update({ recentProjects: recent, folders });
    this.pushSessions();
    if (req.initialPrompt?.trim()) {
      const prompt = meta.goal ? `${req.initialPrompt.trim()}\n\nActive goal: ${meta.goal.objective}` : req.initialPrompt.trim();
      void this.send(id, { text: prompt }).catch((e) => this.emit(id, { type: 'error', message: errorMessage(e) }));
    } else if (meta.goal) {
      void this.send(id, { text: this.goalKickoffPrompt(meta.goal) }).catch((e) => this.emit(id, { type: 'error', message: errorMessage(e) }));
    }
    return meta;
  }

  private goalKickoffPrompt(goal: GoalState): string {
    return `You have a persistent goal for this session:\n\n${goal.objective}\n\nWork toward it autonomously. When you believe it is fully achieved and verified, run a completion audit (restate deliverables, map each requirement to concrete evidence, note gaps) and end your reply with the exact token ${GOAL_COMPLETE_TOKEN} on its own line. If anything is missing, keep working instead of declaring completion.`;
  }

  async delete(id: string, removeWt = false): Promise<void> {
    const meta = this.get(id);
    const t0 = Date.now();
    await this.stop(id);
    this.cancelPersist(id);
    const tStop = Date.now();
    if (meta?.worktreeBranch && removeWt) {
      try {
        await removeWorktree(meta.config.projectRoot, meta.cwd);
      } catch (e) {
        this.deps.log('warn', `worktree removal failed: ${errorMessage(e)}`);
      }
    }
    const tWorktree = Date.now();
    await this.deps.store.remove(id);
    const tStore = Date.now();
    this.pushSessions();
    if (tStore - t0 >= 1000) this.deps.log('warn', `slow session delete ${id}: stop ${tStop - t0}ms, worktree ${tWorktree - tStop}ms, store ${tStore - tWorktree}ms`);
  }

  async patch(id: string, patch: Partial<SessionMeta>): Promise<SessionMeta> {
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    Object.assign(meta, patch, { updatedAt: Date.now() });
    await this.deps.store.upsert(meta);
    this.pushSessions();
    return meta;
  }

  /** Archives a session; with `removeWt` it also deletes the worktree (the branch is kept so unarchive can restore it). */
  async setArchived(id: string, archived: boolean, removeWt = false): Promise<SessionMeta> {
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    if (archived && removeWt && meta.worktreeBranch) {
      await this.stop(id);
      // Non-force: a worktree with uncommitted changes is refused, and the error reaches the renderer's toast.
      await removeWorktree(meta.config.projectRoot, meta.cwd, { force: false });
    }
    if (!archived && meta.worktreeBranch) {
      // The worktree may have been removed while archived; recreate it so the session can start again.
      try {
        await restoreWorktree(meta.config.projectRoot, meta.cwd, meta.worktreeBranch);
      } catch (e) {
        this.deps.log('warn', `worktree restore failed: ${errorMessage(e)}`);
      }
    }
    return this.patch(id, { archived });
  }

  transcript(id: string): Promise<TranscriptItem[]> {
    return this.deps.store.readTranscript(id).then((items) => {
      const live = this.active.get(id)?.liveItems;
      if (!live) return items;
      // Overlay in-memory streaming state.
      const map = new Map(items.map((i) => [i.id, i]));
      for (const [k, v] of live) map.set(k, v);
      const order = [...items.map((i) => i.id), ...[...live.keys()].filter((k) => !items.some((i) => i.id === k))];
      return order.map((k) => map.get(k) as TranscriptItem);
    });
  }

  private buildContext(meta: SessionMeta, id: string): HarnessContext {
    const store = this.deps.store;
    const sessionDir = store.sessionDir(id);
    return {
      sessionId: id,
      session: () => this.get(id) ?? meta,
      settings: () => this.settings(),
      runtime: this.deps.runtime,
      sessionDir,
      permissionMode: () => (this.get(id) ?? meta).config.permissionMode,
      effort: () => (this.get(id) ?? meta).activeEffort ?? (this.get(id) ?? meta).config.effort ?? this.settings().defaultEffort,
      getApiKey: (providerId) => this.deps.getSecret(providerId),
      emit: (event) => this.emit(id, event),
      requestApproval: (draft) => this.requestApproval(id, draft),
      updateRef: (patch: Partial<HarnessRef>) => {
        const m = this.get(id);
        if (!m) return;
        m.harnessRef = { ...m.harnessRef, ...patch };
        this.schedulePersist(m);
      },
      updateMeta: (patch) => {
        const m = this.get(id);
        if (!m) return;
        Object.assign(m, patch);
        this.schedulePersist(m);
        this.pushSessions();
      },
      log: (level, message) => this.deps.log(level, `[${id}] ${message}`),
      readJson: (name) => readJson(path.join(sessionDir, name), null),
      writeJson: (name, data) => writeJson(path.join(sessionDir, name), data)
    };
  }

  private async ensureActive(id: string): Promise<ActiveSession> {
    const existing = this.active.get(id);
    if (existing) {
      if (existing.starting) await existing.starting;
      return existing;
    }
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    const ctx = this.buildContext(meta, id);
    const adapter = createAdapter(meta.config.harness, ctx);
    const active: ActiveSession = { adapter, approvals: new Map(), liveItems: new Map(), dirty: new Set(), lastAssistantText: '', starting: null, models: null };
    this.active.set(id, active);
    meta.status = 'starting';
    meta.statusDetail = `Starting ${HARNESS_BY_ID[meta.config.harness].name}…`;
    this.pushSessions();
    active.starting = adapter
      .start()
      .then(() => {
        active.starting = null;
        const m = this.get(id);
        if (m && m.status === 'starting') {
          m.status = 'idle';
          m.statusDetail = undefined;
          this.pushSessions();
        }
      })
      .catch((e) => {
        active.starting = null;
        this.active.delete(id);
        // Start failed after spawn: dispose the adapter so no harness child process is orphaned
        // (pi/acp start() have no self-cleaning handshake either).
        active.adapter.dispose().catch((de) => this.deps.log('warn', `dispose after failed start: ${errorMessage(de)}`));
        const m = this.get(id);
        if (m) {
          m.status = 'error';
          m.lastError = errorMessage(e);
          m.statusDetail = m.lastError;
          this.schedulePersist(m);
          this.pushSessions();
        }
        this.emit(id, { type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level: 'error', text: `Failed to start harness: ${errorMessage(e)}` } });
        throw e;
      });
    await active.starting;
    return active;
  }

  async send(id: string, input: UserInput): Promise<void> {
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    const userItem: TranscriptItem = { id: shortId('u_'), kind: 'user', ts: Date.now(), text: input.text, images: input.images, queuedAs: input.mode };
    this.emit(id, { type: 'item.upsert', item: userItem });
    if (meta.title === 'New session' && input.text.trim()) {
      meta.title = input.text.trim().split('\n')[0].slice(0, 60);
      this.schedulePersist(meta);
      this.pushSessions();
    }
    const active = await this.ensureActive(id);
    await active.adapter.send(input);
  }

  /** Denies every pending approval and records the decision on its transcript card. */
  private cancelApprovals(id: string, active: ActiveSession, note: string): void {
    for (const [reqId, d] of [...active.approvals]) {
      const decision: ApprovalDecision = { optionId: 'deny', note };
      active.approvals.delete(reqId);
      d.resolve(decision);
      const item = active.liveItems.get(reqId);
      if (item && item.kind === 'approval') {
        item.decision = decision;
        item.decidedAt = Date.now();
        this.emit(id, { type: 'item.upsert', item: { ...item } });
      }
      this.emit(id, { type: 'approval.resolved', requestId: reqId, decision });
    }
  }

  async interrupt(id: string): Promise<void> {
    const active = this.active.get(id);
    if (!active) return;
    this.cancelApprovals(id, active, 'Interrupted');
    await active.adapter.interrupt();
  }

  async stop(id: string): Promise<void> {
    const active = this.active.get(id);
    if (!active) return;
    this.cancelApprovals(id, active, 'Session stopped');
    this.active.delete(id);
    await this.flushLive(id, active);
    try {
      await active.adapter.dispose();
    } catch (e) {
      this.deps.log('warn', `dispose failed: ${errorMessage(e)}`);
    }
    const meta = this.get(id);
    if (meta) {
      meta.status = 'idle';
      meta.statusDetail = undefined;
      meta.queued = 0;
      await this.deps.store.upsert(meta);
      this.pushSessions();
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.stop(id)));
  }

  /**
   * Re-sends each running session's cached model list so a capability override applies without
   * restarting the harness. Cheap: no harness round-trip, only the overrides are re-evaluated.
   */
  republishModels(): void {
    for (const [id, active] of this.active) if (active.models) this.emit(id, { type: 'models', models: active.models });
  }

  async setModel(id: string, model: ModelRef): Promise<SessionMeta> {
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    meta.config.model = model;
    meta.activeModel = model;
    const active = this.active.get(id);
    if (active) await active.adapter.setModel(model);
    await this.deps.store.upsert(meta);
    this.pushSessions();
    return meta;
  }

  async setEffort(id: string, effort: EffortLevel): Promise<SessionMeta> {
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    meta.config.effort = effort;
    meta.activeEffort = effort;
    const active = this.active.get(id);
    if (active) await active.adapter.setEffort(effort);
    await this.deps.store.upsert(meta);
    this.pushSessions();
    return meta;
  }

  async setPermissionMode(id: string, mode: PermissionMode): Promise<SessionMeta> {
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    meta.config.permissionMode = mode;
    const active = this.active.get(id);
    if (active) await active.adapter.setPermissionMode(mode);
    await this.deps.store.upsert(meta);
    this.pushSessions();
    this.emit(id, { type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level: 'info', text: `Permission mode set to ${mode}.` } });
    return meta;
  }

  async compact(id: string): Promise<{ ok: boolean; detail?: string }> {
    const active = this.active.get(id);
    if (!active) return { ok: false, detail: 'Session is not running.' };
    if (!active.adapter.compact) return { ok: false, detail: 'This harness does not support compaction.' };
    await active.adapter.compact();
    return { ok: true };
  }

  async clearTranscript(id: string): Promise<void> {
    const active = this.active.get(id);
    if (active) active.liveItems.clear();
    await this.deps.store.rewriteTranscript(id, []);
  }

  async respondApproval(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    const active = this.active.get(sessionId);
    const d = active?.approvals.get(requestId);
    if (!active || !d) return;
    active.approvals.delete(requestId);
    d.resolve(decision);
    const item = active.liveItems.get(requestId);
    if (item && item.kind === 'approval') {
      item.decision = decision;
      item.decidedAt = Date.now();
      this.emit(sessionId, { type: 'item.upsert', item: { ...item } });
    }
    this.emit(sessionId, { type: 'approval.resolved', requestId, decision });
    const meta = this.get(sessionId);
    if (meta && active.approvals.size === 0 && meta.status === 'awaiting') {
      meta.status = 'running';
      meta.statusDetail = undefined;
      this.pushSessions();
    }
  }

  private requestApproval(sessionId: string, draft: ApprovalDraft): Promise<ApprovalDecision> {
    const active = this.active.get(sessionId);
    const meta = this.get(sessionId);
    if (!active || !meta) return Promise.resolve({ optionId: 'deny', note: 'Session gone' });
    const request: ApprovalRequest = { ...draft, id: shortId('ap_'), sessionId, harness: meta.config.harness, createdAt: Date.now() };
    const d = deferred<ApprovalDecision>();
    active.approvals.set(request.id, d);
    this.emit(sessionId, { type: 'item.upsert', item: { id: request.id, kind: 'approval', ts: Date.now(), request } });
    this.emit(sessionId, { type: 'approval.request', request });
    meta.status = 'awaiting';
    meta.statusDetail = request.title;
    this.pushSessions();
    this.deps.notify(sessionId, `${meta.title}: approval needed`, request.command ?? request.title);
    return d.promise;
  }

  /** Central event sink: persists transcript, updates meta, forwards to renderer, drives goals. */
  private emit(sessionId: string, event: SessionEvent): void {
    // Harness-reported capabilities pass through the user's corrections before anything sees them.
    if (event.type === 'models') {
      const live = this.active.get(sessionId);
      if (live) live.models = event.models;
      event = { ...event, models: applyModelOverrides(event.models, this.deps.settings.get().modelOverrides) };
    }
    const meta = this.get(sessionId);
    const active = this.active.get(sessionId);
    switch (event.type) {
      case 'item.upsert': {
        const item = event.item;
        if (active) {
          active.liveItems.set(item.id, item);
          active.dirty.add(item.id);
          if (item.kind === 'assistant' && item.text) active.lastAssistantText = item.text;
        }
        const streaming = item.kind === 'assistant' && item.streaming;
        if (!streaming || !active) this.appendTranscript(sessionId, item);
        if (item.kind === 'turn' && meta) this.onTurnFinished(meta, item);
        // Tool calls are recorded once, when they leave the running state.
        if (item.kind === 'tool' && item.status !== 'running') this.deps.analytics.recordToolCall(sessionId, item);
        break;
      }
      case 'item.delta': {
        const item = active?.liveItems.get(event.id);
        if (item) {
          if (item.kind === 'assistant') {
            if (event.textDelta) item.text += event.textDelta;
            if (event.thinkingDelta) item.thinking = (item.thinking ?? '') + event.thinkingDelta;
          } else if (item.kind === 'tool' && event.outputDelta) item.output = (item.output ?? '') + event.outputDelta;
          active?.dirty.add(event.id);
        }
        break;
      }
      case 'status': {
        if (meta) {
          if (event.status === 'idle' && active && active.approvals.size) break; // still awaiting
          meta.status = event.status;
          meta.statusDetail = event.detail;
          if (event.status === 'idle' || event.status === 'stopped' || event.status === 'error') {
            if (active) {
              void this.flushLive(sessionId, active).catch((e) => this.deps.log('warn', `live flush failed: ${errorMessage(e)}`));
              if (event.status === 'stopped') {
                // The harness exited on its own: pending approvals would hang forever and the
                // adapter must be disposed, mirroring the fatal-error path.
                this.active.delete(sessionId);
                this.cancelApprovals(sessionId, active, 'Harness stopped');
                active.adapter.dispose().catch((e) => this.deps.log('warn', `dispose after harness stop failed: ${errorMessage(e)}`));
              }
            }
            this.schedulePersist(meta);
          }
          // Status events are the live source of truth for the sidebar. Terminal statuses also
          // persist above, but every transition must be published immediately.
          this.pushSessions();
          if (event.status === 'idle') this.scheduleGitStateCheck(meta.id);
        }
        break;
      }
      case 'usage':
        if (meta) {
          meta.usage = event.totals;
          this.deps.analytics.recordUsage(meta, event.totals);
          this.schedulePersist(meta);
          this.pushSessions();
        }
        break;
      case 'meta':
        if (meta) {
          Object.assign(meta, event.patch);
          this.schedulePersist(meta);
          this.pushSessions();
        }
        break;
      case 'error':
        if (meta) {
          meta.lastError = event.message;
          if (event.fatal) {
            meta.status = 'error';
            meta.statusDetail = event.message;
            meta.queued = 0;
            if (active) {
              // Tear the adapter down cleanly so no approval waits forever and streamed items are saved.
              this.active.delete(sessionId);
              this.cancelApprovals(sessionId, active, 'Harness failed');
              void this.flushLive(sessionId, active).then(() => active.adapter.dispose()).catch((e) => this.deps.log('warn', `dispose after fatal error failed: ${errorMessage(e)}`));
            }
          }
          this.schedulePersist(meta);
          this.pushSessions();
        }
        this.appendTranscript(sessionId, { id: shortId('i_'), kind: 'info', ts: Date.now(), level: 'error', text: event.message });
        break;
      default:
        break;
    }
    this.deps.pushEvent({ sessionId, event, ts: Date.now() });
  }

  /** Transcript appends must never reject into the void; log a warning instead. */
  private appendTranscript(sessionId: string, item: TranscriptItem): void {
    this.deps.store.appendTranscript(sessionId, item).catch((e) => this.deps.log('warn', `transcript append failed: ${errorMessage(e)}`));
  }

  private async flushLive(sessionId: string, active: ActiveSession): Promise<void> {
    for (const id of [...active.dirty]) {
      const item = active.liveItems.get(id);
      if (!item) continue;
      if (item.kind === 'assistant' && item.streaming) continue;
      await this.deps.store.appendTranscript(sessionId, item);
      active.dirty.delete(id);
    }
  }

  private onTurnFinished(meta: SessionMeta, turn: Extract<TranscriptItem, { kind: 'turn' }>): void {
    if (turn.status === 'completed') this.deps.analytics.recordTurn(meta, turn.durationMs ?? 0);
    const active = this.active.get(meta.id);
    if (this.settings().notifications && turn.status !== 'interrupted') {
      this.deps.notify(meta.id, meta.title, turn.status === 'completed' ? 'Turn finished' : `Turn ${turn.status}${turn.error ? `: ${turn.error}` : ''}`);
    }
    const goal = meta.goal;
    if (!goal || goal.status !== 'active' || !active) return;
    if (turn.status !== 'completed') return;
    const text = active.lastAssistantText;
    if (text.includes(GOAL_COMPLETE_TOKEN)) {
      goal.status = 'complete';
      goal.updatedAt = Date.now();
      this.schedulePersist(meta);
      this.pushSessions();
      this.emit(meta.id, { type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level: 'info', text: `Goal marked complete after ${goal.iterations} continuation${goal.iterations === 1 ? '' : 's'}.` } });
      this.deps.notify(meta.id, meta.title, 'Goal complete');
      return;
    }
    if (!goal.autoContinue) return;
    if (goal.iterations >= goal.maxIterations) {
      goal.status = 'paused';
      goal.updatedAt = Date.now();
      this.schedulePersist(meta);
      this.pushSessions();
      this.emit(meta.id, { type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level: 'warn', text: `Goal paused: reached the ${goal.maxIterations}-iteration guard. Resume it from the Goal panel.` } });
      return;
    }
    goal.iterations += 1;
    goal.updatedAt = Date.now();
    this.schedulePersist(meta);
    const prompt = `Goal check-in ${goal.iterations}/${goal.maxIterations}. The active goal is:\n\n${goal.objective}\n\nReview what has been done so far, verify against real evidence, and continue working toward the goal. If it is now fully achieved, end your reply with the exact token ${GOAL_COMPLETE_TOKEN} on its own line after a brief completion audit. Otherwise keep going without asking for permission to continue.`;
    setTimeout(() => {
      const m = this.get(meta.id);
      if (!m || m.goal?.status !== 'active' || m.status === 'running' || m.status === 'awaiting') return;
      void this.send(meta.id, { text: prompt }).catch((e) => this.deps.log('warn', `goal continue failed: ${errorMessage(e)}`));
    }, 1500);
  }

  async goal(id: string, action: 'set' | 'pause' | 'resume' | 'clear' | 'complete' | 'update', opts: { objective?: string; autoContinue?: boolean; maxIterations?: number }): Promise<SessionMeta> {
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    const s = this.settings();
    switch (action) {
      case 'set': {
        meta.goal = {
          objective: opts.objective?.trim() || meta.goal?.objective || '',
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          iterations: 0,
          maxIterations: opts.maxIterations ?? s.goalDefaults.maxIterations,
          autoContinue: opts.autoContinue ?? s.goalDefaults.autoContinue
        };
        this.emit(id, { type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level: 'info', text: `Goal set: ${meta.goal.objective}` } });
        if (meta.status === 'idle') void this.send(id, { text: this.goalKickoffPrompt(meta.goal) }).catch((e) => this.emit(id, { type: 'error', message: errorMessage(e) }));
        break;
      }
      case 'pause':
        if (meta.goal) meta.goal.status = 'paused';
        break;
      case 'resume':
        if (meta.goal) {
          meta.goal.status = 'active';
          if (meta.status === 'idle') void this.send(id, { text: `Resuming the goal: ${meta.goal.objective}\nContinue where you left off.` }).catch((e) => this.emit(id, { type: 'error', message: errorMessage(e) }));
        }
        break;
      case 'clear':
        meta.goal = undefined;
        break;
      case 'complete':
        if (meta.goal) meta.goal.status = 'complete';
        break;
      case 'update':
        if (meta.goal) {
          if (opts.autoContinue !== undefined) meta.goal.autoContinue = opts.autoContinue;
          if (opts.maxIterations !== undefined) meta.goal.maxIterations = opts.maxIterations;
          if (opts.objective !== undefined) meta.goal.objective = opts.objective;
        }
        break;
    }
    if (meta.goal) meta.goal.updatedAt = Date.now();
    await this.deps.store.upsert(meta);
    this.pushSessions();
    return meta;
  }

  /**
   * Relocates a session to another directory (worktree switch). A running harness is stopped;
   * provider resume state is tied to the old directory, so it is dropped (the app transcript stays).
   */
  async moveTo(id: string, cwd: string): Promise<SessionMeta> {
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    if (!path.isAbsolute(cwd)) throw new Error('Worktree path must be absolute');
    if (path.resolve(meta.cwd) === path.resolve(cwd)) return meta;
    const wasRunning = !!this.active.get(id);
    if (wasRunning) await this.stop(id);
    meta.cwd = cwd;
    const info = await worktreeInfo(cwd).catch(() => null);
    const managedBase = meta.config.projectRoot
      ? path.join(path.resolve(meta.config.projectRoot), '.vocs-code', 'worktrees') + path.sep
      : null;
    const managed = !!managedBase && cwd.startsWith(managedBase);
    meta.worktreeBranch = managed ? info?.branch : undefined;
    // Keep `nativeHistory` (stored in the session dir, cwd-independent); drop provider session ids.
    const ref = { ...meta.harnessRef };
    delete ref.claudeSessionId;
    delete ref.codexThreadId;
    delete ref.piSessionFile;
    delete ref.acpSessionId;
    delete ref.forkOnResume;
    meta.harnessRef = ref;
    await this.deps.store.upsert(meta);
    this.pushSessions();
    this.emit(id, {
      type: 'item.upsert',
      item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level: 'info', text: `Session moved to ${cwd}${wasRunning ? ' — the harness restarts on the next message.' : '.'}` }
    });
    return meta;
  }

  async fork(id: string): Promise<SessionMeta | null> {
    const src = this.get(id);
    if (!src) return null;
    const items = await this.transcript(id);
    const nid = shortId('s_');
    const meta: SessionMeta = {
      ...structuredClone(src),
      id: nid,
      title: `${src.title} (fork)`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'idle',
      statusDetail: undefined,
      queued: 0,
      harnessRef: {},
      goal: undefined,
      // The fork shares the directory but does not own the original's worktree (deleting it must not remove that).
      worktreeBranch: undefined
    };
    // Carry harness state where the harness supports it.
    if (src.config.harness === 'claude' && src.harnessRef.claudeSessionId) meta.harnessRef = { claudeSessionId: src.harnessRef.claudeSessionId, forkOnResume: true } as HarnessRef;
    if (src.config.harness === 'native') {
      const hist = await this.deps.store.readNativeHistory(id);
      if (hist) await this.deps.store.writeNativeHistory(nid, hist);
      meta.harnessRef = { nativeHistory: true };
    }
    await this.deps.store.upsert(meta);
    await this.deps.store.rewriteTranscript(nid, items.filter((i) => !(i.kind === 'approval' && !i.decision)));
    this.pushSessions();
    return meta;
  }

  async exportMarkdown(id: string): Promise<string> {
    const meta = this.get(id);
    const items = await this.transcript(id);
    const lines: string[] = [`# ${meta?.title ?? 'Session'}`, '', `- Harness: ${meta?.config.harness}`, `- Model: ${meta?.activeModel ? `${meta.activeModel.provider}/${meta.activeModel.model}` : 'default'}`, `- Directory: ${meta?.cwd}`, `- Cost: $${(meta?.usage.costUsd ?? 0).toFixed(4)}`, ''];
    for (const it of items) {
      switch (it.kind) {
        case 'user':
          lines.push(`## User`, '', it.text, '');
          break;
        case 'assistant':
          if (it.thinking) lines.push(`<details><summary>Thinking</summary>\n\n${it.thinking}\n\n</details>`, '');
          if (it.text) lines.push(`## Assistant${it.model ? ` (${it.model})` : ''}`, '', it.text, '');
          break;
        case 'tool':
          lines.push(`### Tool: ${it.name} — ${it.summary ?? ''}`, '', '```', (it.output ?? '').slice(0, 20_000), '```', '');
          if (it.changes) for (const c of it.changes) if (c.diff) lines.push('```diff', c.diff, '```', '');
          break;
        case 'approval':
          lines.push(`> Approval: ${it.request.title} → ${it.decision?.optionId ?? 'pending'}`, '');
          break;
        case 'info':
          lines.push(`> ${it.level}: ${it.text}`, '');
          break;
        case 'turn':
          lines.push(`---`, `_Turn ${it.status}${it.durationMs ? ` in ${(it.durationMs / 1000).toFixed(1)}s` : ''}${it.costUsd ? `, $${it.costUsd.toFixed(4)}` : ''}_`, '');
          break;
        case 'plan':
          lines.push('### Plan', ...it.entries.map((e) => `- [${e.status === 'completed' ? 'x' : ' '}] ${e.content}`), '');
          break;
      }
    }
    return lines.join('\n');
  }

  async projectRootFor(cwd: string): Promise<string | null> {
    return gitRoot(cwd);
  }
}
