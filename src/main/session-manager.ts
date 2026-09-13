/** Owns sessions: transcripts, approvals, goals, worktrees, and resuming a session after a restart. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ApprovalDecision,
  ApprovalRequest,
  AppSettings,
  AutoCompactionThreshold,
  CreateSessionRequest,
  EffortLevel,
  GoalState,
  HarnessId,
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
import { autoCompactionThresholdLabel, hasReachedAutoCompactionThreshold } from '../shared/compaction';
import { HARNESS_BY_ID } from '../shared/harness-meta';
import { createAdapter } from './harness/registry';
import type { ApprovalDraft, HarnessAdapter, HarnessContext } from './harness/types';
import { branchGitState, createWorktree, gitRoot, gitWorktrees, removeWorktree, restoreWorktree, slugify, worktreeAddForBranch, worktreeInfo, type BranchGitState, type PrRef, type SessionPrQuery } from './git';
import { tokensPerSecond, turnSpeed } from './analytics';
import { emptyUsage, enrichModelContextWindows } from './models/static-models';
import { applyModelOverrides } from '../shared/model-overrides';
import type { RuntimeResolver } from './runtime';
import type { SettingsStore } from './settings';
import type { SessionStore } from './store';
import type { AnalyticsStore } from './analytics';
import { deferred, errorMessage, shortId, type Deferred } from './util/async';
import { readJson, writeJson } from './util/fs';
import { generateSessionTitle, titleFromPrompt } from './session-title';

export { titleFromPrompt };

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
  /** Last list the harness reported, before app metadata and user overrides, so it can be re-published. */
  models: ModelInfo[] | null;
  /** Prevent repeated automatic requests until reported context falls below the threshold. */
  autoCompactionThreshold: AutoCompactionThreshold | undefined;
  autoCompactionLatched: boolean;
  autoCompactionRetryAt: number;
  autoCompactionRetryTimer: NodeJS.Timeout | null;
  compactionInFlight: Promise<boolean | void> | null;
}

const GOAL_COMPLETE_TOKEN = 'GOAL_COMPLETE';
const AUTO_COMPACTION_RETRY_MS = 30_000;

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
    // Sessions restored while parked on a PR resume polling for their merge. A harness that
    // died while the app was closed ('stopped') gets its git-derived status re-checked once,
    // so a quit that killed the harness does not erase a parked pr/merged badge for good.
    for (const s of list) {
      if ((s.status === 'pr' || s.status === 'stopped') && !this.gitStateChecked.has(s.id)) {
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
        // Fire-and-forget: a failed index write must not become an unhandled rejection.
        if (this.deps.store.get(meta.id)) Promise.resolve(this.deps.store.upsert(meta)).catch((e) => this.deps.log('warn', `meta persist failed: ${errorMessage(e)}`));
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
      const others = this.deps.store.list().filter((s) => s.id !== id && s.worktreeBranch).map((s) => s.worktreeBranch!);
      const q: SessionPrQuery = {
        prRefs: await this.sessionPrRefs(id),
        excludeBranches: others,
        extraRoots: await this.knownRepoRoots(id),
        createdAfter: meta.createdAt,
        updatedBefore: meta.updatedAt
      };
      state = await branchGitState(meta.cwd, meta.worktreeBranch, q);
    } catch (e) {
      this.deps.log('warn', `pr/merge status check failed: ${errorMessage(e)}`);
      return;
    }
    // The check can take seconds over the network; the session may have moved on.
    if (!this.gitStateCheckable(meta.status)) return;
    const next: SessionStatus = state.merged ? 'merged' : state.pr ? 'pr' : 'idle';
    if (meta.status === next || meta.status === 'merged' || meta.status === 'error') return;
    // A stopped harness stays stopped unless the branch is actually pr/merged: git evidence
    // may upgrade the status, never downgrade it back to idle.
    if (meta.status === 'stopped' && next === 'idle') return;
    meta.status = next;
    meta.statusDetail = undefined;
    this.schedulePersist(meta);
    this.pushSessions();
    // Parked on 'pr': keep polling so the label flips to 'merged' once it lands.
    if (next === 'pr' && recheck) this.scheduleGitStateCheck(id, SessionManager.GIT_STATE_RECHECK_MS);
  }

  /** Only idle/pr/stopped sessions take a label update; live or already-final statuses are left alone. */
  private gitStateCheckable(status: SessionStatus): boolean {
    return status === 'idle' || status === 'pr' || status === 'merged' || status === 'stopped';
  }

  /**
   * PRs this session itself referenced (the agent's report links the PR) — the strongest
   * session→PR signal, since agents may push their own branch instead of the session
   * worktree branch, and may even work in a different repo than the session's cwd.
   */
  async sessionPrRefs(id: string): Promise<PrRef[]> {
    let raw = '';
    try {
      raw = await fs.readFile(path.join(this.deps.store.sessionDir(id), 'transcript.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const out: PrRef[] = [];
    for (const m of raw.matchAll(/github\.com[/:]([\w.-]+)\/([\w.-]+?)\/pull\/(\d+)/g)) {
      const ref: PrRef = { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
      if (!out.some((p) => p.repo === ref.repo && p.number === ref.number)) out.push(ref);
    }
    return out;
  }

  /** Git roots of other sessions' repos (cached per cwd), for resolving transcript PRs from a foreign repo. */
  async knownRepoRoots(excludeId: string): Promise<string[]> {
    const roots = new Set<string>();
    for (const s of this.deps.store.list()) {
      if (s.id === excludeId || s.archived) continue;
      let root = this.repoRootCache.get(s.cwd);
      if (root === undefined) {
        root = (await gitRoot(s.cwd).catch(() => null)) ?? '';
        this.repoRootCache.set(s.cwd, root);
      }
      if (root) roots.add(root);
    }
    return [...roots];
  }

  private repoRootCache = new Map<string, string>();

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
    const title = req.title?.trim() || (req.initialPrompt ? titleFromPrompt(req.initialPrompt) : 'New session');
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
    const promptText = req.initialPrompt?.trim() ?? '';
    const initialImages = req.initialImages?.length ? req.initialImages : undefined;
    if (promptText || initialImages) {
      // A user-supplied title stands; otherwise the prompt-derived one is only a placeholder
      // until the one-shot LLM title call lands.
      if (!req.title?.trim() && promptText) this.scheduleLlmTitle(id, title, promptText);
      const prompt = meta.goal && promptText ? `${promptText}\n\nActive goal: ${meta.goal.objective}` : promptText;
      void this.send(id, { text: prompt, images: initialImages }).catch((e) => this.emit(id, { type: 'error', message: errorMessage(e) }));
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
    if (!meta) return;
    const t0 = Date.now();
    await this.stop(id);
    this.cancelPersist(id);
    const tStop = Date.now();
    if (meta.worktreeBranch && removeWt) {
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

  /**
   * Pins a session to the top of its folder; the first pin sits on top, later pins below it.
   * Pin state must not bump updatedAt: the unpinned section orders by it, and pinning or
   * reordering pins must not reshuffle the rest of the list.
   */
  async setPinned(id: string, pinned: boolean): Promise<SessionMeta> {
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    if (pinned) {
      meta.pinned = true;
      meta.pinnedAt = Date.now();
    } else {
      meta.pinned = undefined;
      delete meta.pinnedAt;
    }
    await this.deps.store.upsert(meta);
    this.pushSessions();
    return meta;
  }

  /** Persists a pinned-section drag reorder: ids in display order get ascending pin stamps. */
  async setPinOrder(ids: string[]): Promise<void> {
    let changed = false;
    for (let i = 0; i < ids.length; i++) {
      const meta = this.get(ids[i]);
      if (!meta || !meta.pinned) continue;
      // Small ordinals keep future pins (stamped with Date.now()) below the reordered section.
      const pinnedAt = i + 1;
      if (meta.pinnedAt === pinnedAt) continue;
      meta.pinnedAt = pinnedAt;
      await this.deps.store.upsert(meta);
      changed = true;
    }
    if (changed) this.pushSessions();
  }

  /** Archives a session; with `removeWt` it also deletes the worktree (the branch is kept so unarchive can restore it). */
  async setArchived(id: string, archived: boolean, removeWt = false, forceWt = false): Promise<SessionMeta> {
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    if (archived && removeWt && meta.worktreeBranch) {
      await this.stop(id);
      // Non-force by default: a worktree with uncommitted changes is refused (WorktreeDirtyError);
      // the renderer confirms discarding and retries with forceWorktree.
      await removeWorktree(meta.config.projectRoot, meta.cwd, { force: forceWt });
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
    if (!this.get(id)) return Promise.reject(new Error('Session not found'));
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
    const active: ActiveSession = {
      adapter,
      approvals: new Map(),
      liveItems: new Map(),
      dirty: new Set(),
      lastAssistantText: '',
      starting: null,
      models: null,
      autoCompactionThreshold: undefined,
      autoCompactionLatched: false,
      autoCompactionRetryAt: 0,
      autoCompactionRetryTimer: null,
      compactionInFlight: null
    };
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
      const placeholder = titleFromPrompt(input.text);
      meta.title = placeholder;
      this.schedulePersist(meta);
      this.pushSessions();
      this.scheduleLlmTitle(id, placeholder, input.text);
    }
    await this.dispatchInput(id, { ...input, transcriptItemId: userItem.id });
  }

  /** Replaces a sent prompt only when its adapter can restore a durable pre-message checkpoint. */
  async editAndResend(id: string, userItemId: string, input: UserInput): Promise<TranscriptItem[]> {
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    if (!input.text.trim() && !input.images?.length) throw new Error('Message cannot be empty');
    if (meta.status === 'running' || meta.status === 'starting' || meta.status === 'awaiting') throw new Error('Wait for the current turn to finish before editing a message');

    const items = await this.deps.store.readTranscript(id);
    const index = items.findIndex((item) => item.id === userItemId && item.kind === 'user');
    if (index < 0) throw new Error('Message no longer exists in this transcript');
    const previous = items[index] as Extract<TranscriptItem, { kind: 'user' }>;
    const active = await this.ensureActive(id);
    if (active.compactionInFlight || active.approvals.size || active.adapter.busy) throw new Error('Wait for the current session activity to finish before editing a message');
    if (!active.adapter.rewindToUserMessage) throw new Error('This harness does not support editing past messages yet');
    if (!(await active.adapter.rewindToUserMessage(userItemId))) throw new Error('This message can no longer be rewound');

    const revised: TranscriptItem = {
      ...previous,
      text: input.text,
      images: input.images ?? previous.images,
      queuedAs: 'now'
    };
    // Context is now safely at the same boundary, so the persistence rewrite cannot diverge.
    active.liveItems.clear();
    active.dirty.clear();
    active.lastAssistantText = '';
    await this.deps.store.rewriteTranscript(id, [...items.slice(0, index), revised]);
    await this.dispatchInput(id, { text: revised.text, images: revised.images, mode: 'now', transcriptItemId: userItemId });
    return this.transcript(id);
  }

  private async dispatchInput(id: string, input: UserInput): Promise<void> {
    const active = await this.ensureActive(id);
    // Compaction can run without marking an adapter busy. Keep a new turn from reading or
    // mutating its context until that operation has settled.
    if (active.compactionInFlight) await active.compactionInFlight.catch(() => undefined);
    if (this.active.get(id) !== active) throw new Error('Session stopped before the message could be sent.');
    await active.adapter.send(input);
  }

  /**
   * Replaces a prompt-derived placeholder title with an LLM-generated one, as long as the
   * user has not renamed (or deleted) the session while the call was in flight.
   */
  private scheduleLlmTitle(id: string, placeholder: string, prompt: string): void {
    // The cheap utility model is for background chores like this; the session's own model is
    // the fallback so titling still works before the user picks a utility model.
    const meta = this.get(id);
    const preferred = this.settings().utilityModel ?? meta?.activeModel;
    void generateSessionTitle(prompt, this.settings().providers, this.deps.getSecret, preferred, this.deps.log)
      .then((title) => {
        if (!title || title === placeholder) return;
        const meta = this.get(id);
        if (!meta || meta.title !== placeholder) return;
        meta.title = title;
        this.schedulePersist(meta);
        this.pushSessions();
      })
      .catch(() => undefined);
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
    if (active.autoCompactionRetryTimer) clearTimeout(active.autoCompactionRetryTimer);
    this.active.delete(id);
    await this.flushLive(id, active);
    try {
      await active.adapter.dispose();
    } catch (e) {
      this.deps.log('warn', `dispose failed: ${errorMessage(e)}`);
    }
    const meta = this.get(id);
    if (meta) {
      // Stopping the harness does not change the branch's git state either.
      if (meta.status !== 'pr' && meta.status !== 'merged') {
        meta.status = 'idle';
        meta.statusDetail = undefined;
      }
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
    if (active.compactionInFlight) return { ok: false, detail: 'Context compaction is already in progress.' };
    const threshold = this.settings().autoCompactionThreshold;
    const meta = this.get(id);
    active.autoCompactionThreshold = threshold;
    if (threshold && meta && hasReachedAutoCompactionThreshold(threshold, meta.usage)) active.autoCompactionLatched = true;
    const operation = active.adapter.compact();
    active.compactionInFlight = operation;
    try {
      const compacted = await operation;
      if (compacted === false) {
        active.autoCompactionLatched = false;
        active.autoCompactionRetryAt = Date.now() + AUTO_COMPACTION_RETRY_MS;
        this.scheduleAutoCompactionRetry(id, active);
        return { ok: false, detail: 'There is not enough conversation history to compact yet.' };
      }
      return { ok: true };
    } catch (e) {
      active.autoCompactionLatched = false;
      active.autoCompactionRetryAt = Date.now() + AUTO_COMPACTION_RETRY_MS;
      this.scheduleAutoCompactionRetry(id, active);
      throw e;
    } finally {
      if (active.compactionInFlight === operation) active.compactionInFlight = null;
    }
  }

  /** Wait until adapter queue bookkeeping has settled, then compact once at a safe idle boundary. */
  private scheduleAutoCompaction(id: string): void {
    if (!this.settings().autoCompactionThreshold) return;
    queueMicrotask(() => void this.maybeAutoCompact(id));
  }

  private scheduleAutoCompactionRetry(id: string, active: ActiveSession): void {
    if (!this.settings().autoCompactionThreshold || active.autoCompactionRetryTimer) return;
    const delay = Math.max(0, active.autoCompactionRetryAt - Date.now());
    active.autoCompactionRetryTimer = setTimeout(() => {
      active.autoCompactionRetryTimer = null;
      if (this.active.get(id) === active) void this.maybeAutoCompact(id);
    }, delay);
    active.autoCompactionRetryTimer.unref?.();
  }

  private clearAutoCompactionRetry(active: ActiveSession): void {
    if (active.autoCompactionRetryTimer) clearTimeout(active.autoCompactionRetryTimer);
    active.autoCompactionRetryTimer = null;
    active.autoCompactionRetryAt = 0;
  }

  private async maybeAutoCompact(id: string): Promise<void> {
    const active = this.active.get(id);
    const meta = this.get(id);
    const threshold = this.settings().autoCompactionThreshold;
    if (!active || !meta || !threshold) return;
    if (active.autoCompactionThreshold !== threshold) {
      active.autoCompactionThreshold = threshold;
      active.autoCompactionLatched = false;
      this.clearAutoCompactionRetry(active);
    }
    if (!hasReachedAutoCompactionThreshold(threshold, meta.usage)) {
      active.autoCompactionLatched = false;
      this.clearAutoCompactionRetry(active);
      return;
    }
    if (
      !active.adapter.compact ||
      active.autoCompactionLatched ||
      active.compactionInFlight ||
      active.starting ||
      active.adapter.busy ||
      meta.status !== 'idle' ||
      (meta.queued ?? 0) > 0
    ) {
      return;
    }
    if (Date.now() < active.autoCompactionRetryAt) {
      this.scheduleAutoCompactionRetry(id, active);
      return;
    }
    active.autoCompactionLatched = true;
    this.note(id, `Automatic context compaction requested at ${autoCompactionThresholdLabel(threshold)}.`);
    const operation = active.adapter.compact();
    active.compactionInFlight = operation;
    try {
      const compacted = await operation;
      if (compacted === false) {
        active.autoCompactionLatched = false;
        active.autoCompactionRetryAt = Date.now() + AUTO_COMPACTION_RETRY_MS;
        this.scheduleAutoCompactionRetry(id, active);
        this.note(id, 'Automatic context compaction is waiting for more conversation history.');
      }
    } catch (e) {
      active.autoCompactionLatched = false;
      active.autoCompactionRetryAt = Date.now() + AUTO_COMPACTION_RETRY_MS;
      this.scheduleAutoCompactionRetry(id, active);
      const message = errorMessage(e);
      this.deps.log('warn', `[${id}] automatic compaction failed: ${message}`);
      this.note(id, `Automatic context compaction failed: ${message}`, 'warn');
    } finally {
      if (active.compactionInFlight === operation) active.compactionInFlight = null;
    }
  }

  async clearTranscript(id: string): Promise<void> {
    if (!this.get(id)) throw new Error('Session not found');
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
    // Harness-reported catalogs gain only known provider metadata, then pass through user corrections.
    if (event.type === 'models') {
      const live = this.active.get(sessionId);
      if (live) live.models = event.models;
      const settings = this.deps.settings.get();
      const models = enrichModelContextWindows(event.models, settings.providers);
      event = { ...event, models: applyModelOverrides(models, settings.modelOverrides) };
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
          // The harness process exiting says nothing about the branch's git state: a session
          // parked on pr/merged keeps its git-derived status instead of flipping to stopped.
          const gitParked = event.status === 'stopped' && (meta.status === 'pr' || meta.status === 'merged');
          if (!gitParked) {
            meta.status = event.status;
            meta.statusDetail = event.detail;
          }
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
          if (event.status === 'idle') {
            this.scheduleAutoCompaction(meta.id);
            this.scheduleGitStateCheck(meta.id);
          }
        }
        break;
      }
      case 'usage':
        if (meta) {
          meta.usage = event.totals;
          this.deps.analytics.recordUsage(meta, event.totals);
          const threshold = this.settings().autoCompactionThreshold;
          if (active) {
            if (active.autoCompactionThreshold !== threshold) {
              active.autoCompactionThreshold = threshold;
              active.autoCompactionLatched = false;
              this.clearAutoCompactionRetry(active);
            }
            if (!threshold || !hasReachedAutoCompactionThreshold(threshold, event.totals)) {
              active.autoCompactionLatched = false;
              this.clearAutoCompactionRetry(active);
            }
          }
          this.schedulePersist(meta);
          this.pushSessions();
          if (meta.status === 'idle') this.scheduleAutoCompaction(meta.id);
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
    this.deps.analytics.recordTurn(meta, turn);
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

  async fork(id: string, harness?: HarnessId): Promise<SessionMeta | null> {
    const src = this.get(id);
    if (!src) return null;
    const items = await this.transcript(id);
    const nid = shortId('s_');
    const cross = !!harness && harness !== src.config.harness;
    const target = cross ? harness! : src.config.harness;
    const meta: SessionMeta = {
      ...structuredClone(src),
      id: nid,
      title: cross ? `${src.title} (fork → ${HARNESS_BY_ID[target].name})` : `${src.title} (fork)`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'idle',
      statusDetail: undefined,
      queued: 0,
      harnessRef: {},
      goal: undefined,
      // A fresh fork starts unpinned and active, never in the archive.
      pinned: undefined,
      pinnedAt: undefined,
      archived: undefined
    };
    if (cross) {
      // A different harness cannot resume the source's provider session: it starts fresh in the
      // same directory/worktree. The copied transcript is carried over for reference only.
      const s = this.settings();
      meta.config = {
        ...src.config,
        harness: target,
        model: s.defaultModelByHarness[target],
        acpAgent: undefined,
        codexModelProvider: undefined,
        // Already living in the source's directory; no new worktree for the fork.
        useWorktree: false
      };
      meta.activeModel = meta.config.model;
      meta.activeEffort = undefined;
      // The fork keeps the same worktree/branch as the session it was forked from.
      meta.worktreeBranch = src.worktreeBranch;
    } else {
      // The fork shares the directory but does not own the original's worktree (deleting it must not remove that).
      meta.worktreeBranch = undefined;
      // Carry harness state where the harness supports it.
      if (src.config.harness === 'claude' && src.harnessRef.claudeSessionId) meta.harnessRef = { claudeSessionId: src.harnessRef.claudeSessionId, forkOnResume: true } as HarnessRef;
      if (src.config.harness === 'native') {
        const hist = await this.deps.store.readNativeHistory(id);
        if (hist) await this.deps.store.writeNativeHistory(nid, hist);
        meta.harnessRef = { nativeHistory: true };
      }
    }
    await this.deps.store.upsert(meta);
    const keep = items.filter((i) => !(i.kind === 'approval' && !i.decision));
    if (cross) {
      keep.push({
        id: shortId('i_'),
        kind: 'info',
        ts: Date.now(),
        level: 'info',
        text: `Forked from ${HARNESS_BY_ID[src.config.harness].name} into ${HARNESS_BY_ID[target].name} in the same directory${meta.worktreeBranch ? ` (branch ${meta.worktreeBranch})` : ''}. The new harness starts with a fresh context — the transcript above is carried over for reference.`
      });
    }
    await this.deps.store.rewriteTranscript(nid, keep);
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
          lines.push(`---`, `_Turn ${it.status}${it.durationMs ? ` in ${(it.durationMs / 1000).toFixed(1)}s` : ''}${speedLabel(it)}${it.costUsd ? `, $${it.costUsd.toFixed(4)}` : ''}_`, '');
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

/** `, 12.3 tok/s` for the markdown export, or '' when the turn has no speed sample. */
function speedLabel(turn: Extract<TranscriptItem, { kind: 'turn' }>): string {
  const tps = tokensPerSecond(turnSpeed(turn) ?? undefined);
  return tps ? `, ${tps.toFixed(1)} tok/s` : '';
}
