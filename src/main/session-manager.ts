/** Owns sessions: transcripts, approvals, goals, worktrees, and resuming a session after a restart. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { MissionOwnership } from '../shared/mission';
import type { ResolvedServer } from './mcp/effective';
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
import { autoCompactionThresholdLabel, autoCompactionTokenThreshold, hasReachedAutoCompactionThreshold } from '../shared/compaction';
import { nativeGoalCommand } from '../shared/goal-driver';
import { HARNESS_BY_ID } from '../shared/harness-meta';
import { modelName } from '../shared/model-names';
import { skillInstalled } from './skills';
import { createAdapter } from './harness/registry';
import { renderForkContext } from './fork-context';
import { builtinServerIds, resolveForSession } from './mcp';
import type { ApprovalDraft, HarnessAdapter, HarnessContext } from './harness/types';
import { branchGitState, createForkWorktree, createWorktree, gitRoot, gitWorktrees, removeWorktree, restoreWorktree, slugify, worktreeAddForBranch, worktreeInfo, type BranchGitState, type PrRef, type SessionPrQuery } from './git';
import { tokensPerSecond, turnSpeed } from './analytics';
import { isValidRunId, listSubagentRuns, readSubagentRun } from './subagents';
import { subagentSupport, type AgentTypeInfo, type SubagentRun, type SubagentRunSummary } from '../shared/subagents';
import { emptyUsage, enrichModelsFromProviders } from './models/static-models';
import { applyModelOverrides } from '../shared/model-overrides';
import type { RuntimeResolver } from './runtime';
import type { SettingsStore } from './settings';
import type { SessionStore } from './store';
import type { AnalyticsStore } from './analytics';
import { deferred, errorMessage, shortId, type Deferred } from './util/async';
import { exists, readJson, writeJson } from './util/fs';
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
  /** The shared GitNexus MCP endpoint, started lazily. */
  sharedGitnexus?: () => Promise<string | null>;
  /** Path to the scope proxy the harness spawns in place of the GitNexus binary. */
  gitnexusProxyPath?: string;
  /** Path to resources/mcp/vocs-memory.mjs, the Layer 2 wiki server. */
  memoryServerPath?: string;
  /** userData path, so the memory server can recall session history (search.db). */
  memoryUserData?: string;
  /** Layer 2 digest for priming a new session's system prompt; absent disables priming. */
  knowledgeDigest?: (scope: { projectRoot: string; cwd: string; branch?: string }) => Promise<string | null>;
  /** Held Mission leases defer ordinary writers; reserve admission across async guards/startup.
   * Ordinary sessions go through it only while ordinary process ownership is enabled. */
  withWorkspaceDispatch?: (meta: SessionMeta, dispatch: () => Promise<void>) => Promise<void>;
  /** Ordinary (non-Mission) process ownership: Windows, Missions configured and a working Job
   * helper. Absent/false keeps ordinary sessions as they always were: no writer claims, no
   * Mission admission, and disposal never needs a proof. */
  ordinaryProcessOwnership?: () => boolean;
  /** Test seam: how long an ordinary Stop waits for its adapter's disposal before releasing the session. */
  disposeWaitMs?: number;
}

/** An ordinary Stop gives a disposing adapter this long (above every adapter's own shutdown
 * deadline) before the session is released anyway; the disposal itself carries on regardless. */
const ORDINARY_DISPOSE_WAIT_MS = 20_000;

export interface MissionSessionHooks {
  beforeDispatch(meta: SessionMeta, input: UserInput): Promise<void>;
  mcpServers(meta: SessionMeta, existing: ResolvedServer[]): Promise<ResolvedServer[]>;
  onEvent?(env: SessionEventEnvelope): void;
}

export interface ManagedSessionDescriptor {
  id: string;
  cwd: string;
  worktreeBranch?: string;
  ownership: MissionOwnership;
}

export interface ManagedSessionUpdate {
  config?: Partial<SessionMeta['config']>;
  mission?: Partial<MissionOwnership>;
  cwd?: string;
  worktreeBranch?: string;
}

export interface SessionActivity {
  /** An owned runtime still exists, including during disposal or an uncertain stop. */
  active: boolean;
  starting: boolean;
  turn: boolean;
  tools: number;
  /** Native children outlive the root turn and its delegation tool result. */
  nativeChildren?: number;
  /** An ordinary runtime still owns possible process writers/autonomous follow-ups. */
  processes?: boolean;
  approvals: number;
  compacting: boolean;
  queued: number;
  tearingDown: boolean;
  uncertain: boolean;
  quiescent: boolean;
}

interface ActiveSession {
  adapter: HarnessAdapter;
  /** Input acceptance is not a terminal turn observation (including ordinary source writers). */
  turnPending: boolean;
  startupDispatched: boolean;
  tearingDown: boolean;
  uncertain: boolean;
  disposal: Promise<void> | null;
  nativeChildren: Map<string, { startedAt: number; running: boolean }>;
  /** Persisted ordinary writer claim owned by this exact runtime, not earlier launches. */
  workspaceWriterClaim?: string;
  workspaceWriterClaimPersisted?: Promise<void>;
  approvals: Map<string, Deferred<ApprovalDecision>>;
  liveItems: Map<string, TranscriptItem>;
  /** Model active when each running tool call began, retained until its terminal upsert. */
  toolModels: Map<string, ModelRef>;
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
  /** Window last handed to an engine that compacts itself; undefined means it still has its own. */
  autoCompactionWindow: number | undefined;
  /** Pending or waiting goal auto-continuation, so a newer turn can replace it instead of racing it. */
  goalContinuationTimer: NodeJS.Timeout | null;
  /** A goal set during another turn must first reach the harness, even when auto-continue is off. */
  pendingGoalKickoff: { goal: GoalState; resume: boolean } | null;
  /** Last on-disk copy of each still-streaming assistant item: when it was written and how big it was. */
  checkpoints: Map<string, StreamCheckpoint>;
  /** Wakes the checkpointer when an item has grown enough but was written too recently. */
  checkpointTimer: NodeJS.Timeout | null;
}

interface StreamCheckpoint {
  at: number;
  size: number;
}

const GOAL_COMPLETE_TOKEN = 'GOAL_COMPLETE';
/**
 * A streaming answer lives in memory until it settles, so a crash would lose all of it. It is
 * checkpointed to the transcript no more often than this, and only once its text and thinking have
 * grown by STREAM_CHECKPOINT_GROWTH of the last copy: every checkpoint appends the whole item, and
 * geometric growth keeps the bytes written under (1 + 1/growth)× the final size however long it
 * streams. A crash loses at most the last interval of text or its last fifth, whichever is more.
 */
const STREAM_CHECKPOINT_MS = 2_000;
const STREAM_CHECKPOINT_GROWTH = 0.25;
const AUTO_COMPACTION_RETRY_MS = 30_000;
/** A goal continuation lands on the first free moment; a compaction can hold the session for minutes. */
const GOAL_CONTINUATION_RETRY_MS = 5_000;
const GOAL_CONTINUATION_MAX_ATTEMPTS = 60;
/** Handoff text written into a cross-harness fork's session dir, consumed by its first message. */
const FORK_CONTEXT_FILE = 'fork-context.md';

/** Title calls per session per run: one on the first message, one more if that one came back empty. */
const MAX_TITLE_ATTEMPTS = 2;

/**
 * Whether the session is still waiting to be named. Sessions written before `titleIsPlaceholder`
 * existed carry no flag, so the old marker — the untouched default title — still counts.
 */
function isPlaceholderTitle(meta: SessionMeta): boolean {
  return meta.titleIsPlaceholder === true || meta.title === 'New session';
}

export class SessionManager {
  /** How often a session parked on 'pr' re-checks whether its branch was merged. */
  private static readonly GIT_STATE_RECHECK_MS = 120_000;

  private active = new Map<string, ActiveSession>();
  /** Last runtime created per session. An ordinary runtime is fenced only once a newer one exists. */
  private runtimeSeq = new Map<string, number>();
  /** Ordinary runtimes still disposing after Stop released their session. Mission admission only:
   * they never block the session itself. */
  private retiring = new Map<string, Set<ActiveSession>>();
  private missionHooks: MissionSessionHooks | undefined;
  private listeners = new Set<(env: SessionEventEnvelope) => void>();
  /** Includes input waiting for startup, compaction or the Mission's dispatch authorization. */
  private managedDispatches = new Map<string, { canceled: boolean }>();
  private persistTimers = new Map<string, NodeJS.Timeout>();
  private gitStateTimers = new Map<string, NodeJS.Timeout>();
  /** Sessions whose restored git state was re-checked once after boot. */
  private gitStateChecked = new Set<string>();
  /**
   * Title calls made for a session this run. A failed call leaves the placeholder, so the next
   * message retries with more context — but an unattended goal session sends many messages, and
   * none of them should pay for a title model that is not answering.
   */
  private titleAttempts = new Map<string, number>();
  /** Sessions with a title call out right now, so two quick messages cannot fire two of them. */
  private titleInFlight = new Set<string>();
  /** Event sequence, monotonic for the lifetime of this manager; see `publish`. */
  private seq = 0;

  constructor(private readonly deps: SessionManagerDeps) {}

  list(): SessionMeta[] {
    const list = this.deps.store.list();
    // Sessions restored while parked on a PR resume polling for their merge. A harness that
    // died while the app was closed ('stopped') gets its git-derived status re-checked once,
    // so a quit that killed the harness does not erase a parked pr/merged badge for good.
    // Stagger the checks: they each probe git and gh, and dozens at the same instant freeze
    // startup (the probe storm that used to stall the event loop for seconds).
    let stagger = 0;
    for (const s of list) {
      if ((s.status === 'pr' || s.status === 'stopped') && !this.gitStateChecked.has(s.id)) {
        this.gitStateChecked.add(s.id);
        this.scheduleGitStateCheck(s.id, 4_000 + Math.min(stagger++, 50) * 400);
      }
    }
    return list;
  }

  get(id: string): SessionMeta | undefined {
    return this.deps.store.get(id);
  }

  /** One host owns Mission dispatch. Detaching it fails closed, including already-waiting sends. */
  attachMissionHooks(hooks: MissionSessionHooks): () => void {
    if (this.missionHooks) throw new Error('Mission hooks are already attached');
    const attachment: MissionSessionHooks = {
      beforeDispatch: hooks.beforeDispatch.bind(hooks),
      mcpServers: hooks.mcpServers.bind(hooks),
      onEvent: hooks.onEvent?.bind(hooks),
    };
    this.missionHooks = attachment;
    return () => { if (this.missionHooks === attachment) this.missionHooks = undefined; };
  }

  /** Observers see normalized events only after the manager has updated its own bookkeeping. */
  subscribe(listener: (env: SessionEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  activity(id: string): SessionActivity {
    const active = this.active.get(id);
    // A Stopped ordinary runtime may still be disposing; it can still write, so admission sees it.
    const retiring = !!this.retiring.get(id)?.size;
    const writers = active?.adapter.workspaceWriterState?.();
    const unprovenClaims = this.get(id)?.workspaceWriterClaims?.some((claim) => claim !== active?.workspaceWriterClaim) ?? false;
    const state = {
      active: !!active || retiring,
      starting: !!active?.starting && active.startupDispatched,
      turn: !!(active?.turnPending || (active?.adapter.busy && !active.compactionInFlight)),
      tools: active ? [...active.liveItems.values()].filter((item) => item.kind === 'tool' && item.status === 'running').length : 0,
      nativeChildren: active ? [...active.nativeChildren.values()].filter((child) => child.running).length : 0,
      processes: writers === 'active' || !!active?.workspaceWriterClaim,
      approvals: active?.approvals.size ?? 0,
      compacting: !!active?.compactionInFlight,
      queued: (this.get(id)?.queued ?? 0) + (this.managedDispatches.has(id) ? 1 : 0),
      tearingDown: !!active?.tearingDown || retiring,
      uncertain: !!active?.uncertain || writers === 'unknown' || unprovenClaims,
    };
    return { ...state, quiescent: !state.starting && !state.turn && !state.tools && !state.nativeChildren && !state.processes && !state.approvals && !state.compacting && !state.queued && !state.tearingDown && !state.uncertain };
  }

  private assertUnmanaged(id: string): void {
    if (this.get(id)?.mission) throw new Error('Mission sessions must be controlled through Mission orchestration');
  }

  private managedMeta(id: string, generation: number): SessionMeta & { mission: MissionOwnership } {
    const meta = this.get(id);
    if (!meta?.mission) throw new Error('Mission session not found');
    if (meta.mission.generation !== generation) throw new Error('Stale Mission session generation');
    return meta as SessionMeta & { mission: MissionOwnership };
  }

  private requireMissionHooks(): MissionSessionHooks {
    if (!this.missionHooks) throw new Error('Mission dispatch hooks are not attached');
    return this.missionHooks;
  }

  private settings(): AppSettings {
    return this.deps.settings.get();
  }

  private ordinaryOwnership(): boolean {
    return this.deps.ordinaryProcessOwnership?.() ?? false;
  }

  /** Mission admission reserves managed dispatch always, ordinary dispatch only while ordinary
   * process ownership is on: otherwise an ordinary send behaves exactly as it always did. */
  private admits(meta: SessionMeta): boolean {
    return !!this.deps.withWorkspaceDispatch && (!!meta.mission || this.ordinaryOwnership());
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
    // The transcript can be tens of MB and every parked-pr/stopped session is scanned once at
    // boot; stat first and reuse the result until the file actually changes.
    let file: string;
    try {
      file = path.join(this.deps.store.sessionDir(id), 'transcript.jsonl');
    } catch {
      return [];
    }
    const st = await fs.stat(file).catch(() => undefined);
    if (!st) return [];
    const stamp = `${st.mtimeMs}:${st.size}`;
    const cached = this.prRefsCache.get(id);
    if (cached && cached.stamp === stamp) return cached.refs;
    let raw = '';
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      return [];
    }
    const out: PrRef[] = [];
    for (const m of raw.matchAll(/github\.com[/:]([\w.-]+)\/([\w.-]+?)\/pull\/(\d+)/g)) {
      const ref: PrRef = { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
      if (!out.some((p) => p.repo === ref.repo && p.number === ref.number)) out.push(ref);
    }
    this.prRefsCache.set(id, { stamp, refs: out });
    return out;
  }

  /** transcript stamp → PR refs, so repeated git-state checks do not re-read every transcript. */
  private prRefsCache = new Map<string, { stamp: string; refs: PrRef[] }>();

  /** Git roots of other sessions' repos (cached per cwd), for resolving transcript PRs from a foreign repo.
   *
   * Every parked-pr/stopped session runs one of these at boot, all at the same moment. Without
   * sharing, each caller walks the same uncached list and spawns one `git rev-parse` per session
   * cwd per caller — hundreds of concurrent git processes right as the window opens. Two guards:
   * in-flight promises are shared per cwd, and a cwd that no longer exists is answered by one
   * stat instead of a doomed git spawn. */
  async knownRepoRoots(excludeId: string): Promise<string[]> {
    const roots = new Set<string>();
    await Promise.all(
      this.deps.store.list().map(async (s) => {
        if (s.id === excludeId || s.archived) return;
        const root = await this.repoRoot(s.cwd);
        if (root) roots.add(root);
      })
    );
    return [...roots];
  }

  private repoRootCache = new Map<string, string>();
  private repoRootPending = new Map<string, Promise<string>>();

  /** One resolution per cwd at a time; the first resolution is cached for the manager's lifetime. */
  private repoRoot(cwd: string): Promise<string> {
    const cached = this.repoRootCache.get(cwd);
    if (cached !== undefined) return Promise.resolve(cached);
    let pending = this.repoRootPending.get(cwd);
    if (!pending) {
      pending = (async () => {
        if (!(await exists(cwd))) return '';
        return (await gitRoot(cwd).catch(() => null)) ?? '';
      })().then((root) => {
        this.repoRootCache.set(cwd, root);
        this.repoRootPending.delete(cwd);
        return root;
      });
      this.repoRootPending.set(cwd, pending);
    }
    return pending;
  }

  /** Persists every debounced meta update immediately (used on quit so trailing edits are not lost). */
  async flushPendingPersists(): Promise<void> {
    const entries = [...this.persistTimers];
    this.persistTimers.clear();
    await Promise.all(
      entries.map(([id, t]) => {
        clearTimeout(t);
        const meta = this.deps.store.get(id);
        return meta ? this.deps.store.upsert(meta).catch((e) => this.deps.log('warn', `[${id}] meta persist during shutdown failed: ${errorMessage(e)}`)) : Promise.resolve();
      })
    );
  }

  async create(req: CreateSessionRequest): Promise<SessionMeta> {
    const id = shortId('s_');
    let cfg = req.config;
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
      // A folder with no repository cannot host a worktree. The request loses its isolation rather
      // than the session: the dialog disables the toggle, but a remembered default (quick session)
      // or a spawned agent's `use_worktree` can still ask for it on a plain folder.
      if (await gitRoot(cfg.projectRoot)) {
        const wt = await createWorktree(cfg.projectRoot, slugify(req.title || req.initialPrompt || id));
        cwd = wt.path;
        worktreeBranch = wt.branch;
      } else {
        cfg = { ...cfg, useWorktree: false };
        this.deps.log('warn', `[${id}] worktree isolation skipped: ${cfg.projectRoot} is not a git repository`);
      }
    }
    const s = this.settings();
    const objective = req.goal?.trim() ?? '';
    // A session created with a goal on a harness that owns `/goal` belongs to the harness: the
    // objective is sent to it as a command and the app sets no goal state (see shared/goal-driver.ts).
    const nativeGoal = objective ? await this.harnessGoal(cfg.harness) : null;
    // The objective names the session whoever runs the goal: on a harness without its own /goal the
    // first message is the app's kickoff prompt, and a title cut from that boilerplate names nothing.
    const titleSeed = req.initialPrompt ?? objective;
    // Only a title the caller chose is the session's real name. A title derived here is a stand-in
    // for one nobody has written yet, so flag it: the first message replaces it with a model's.
    const title = req.title?.trim() || (titleSeed ? titleFromPrompt(titleSeed) : 'New session');
    const meta: SessionMeta = {
      id,
      title,
      titleIsPlaceholder: req.title?.trim() ? undefined : true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      config: { ...cfg, model: cfg.model ?? s.defaultModelByHarness[cfg.harness] },
      cwd,
      worktreeBranch,
      status: 'idle',
      harnessRef: {},
      usage: emptyUsage(),
      activeModel: cfg.model ?? s.defaultModelByHarness[cfg.harness],
      activeEffort: cfg.effort ?? undefined,
      queued: 0
    };
    // Layer 2: prime the session with the project's curated knowledge digest. The digest names
    // pages rather than pasting them, and never outranks the project's own instruction files.
    if (this.deps.knowledgeDigest && this.settings().knowledge?.prime !== false) {
      try {
        const digest = (await this.deps.knowledgeDigest({ projectRoot: cfg.projectRoot, cwd, branch: worktreeBranch }))?.trim();
        if (digest) {
          meta.knowledgeDigest = digest;
          // A harness with no system prompt of its own is primed through its first message instead,
          // the same way a cross-harness fork hands over a transcript.
          if (!HARNESS_BY_ID[cfg.harness].capabilities.systemPrompt) meta.pendingKnowledgeDigest = true;
        }
      } catch (e) {
        this.deps.log('debug', `[${id}] knowledge digest unavailable: ${errorMessage(e)}`);
      }
    }
    if (nativeGoal) {
      meta.nativeGoal = nativeGoal;
    } else if (objective) {
      meta.goal = {
        objective,
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        iterations: 0,
        maxIterations: s.goalDefaults.maxIterations,
        autoContinue: s.goalDefaults.autoContinue
      };
    }
    await this.deps.store.upsert(meta);
    this.deps.log('info', `[${id}] session created: harness=${cfg.harness} model=${describeModel(meta.activeModel)} permissions=${cfg.permissionMode} cwd=${cwd}${worktreeBranch ? ` worktree=${worktreeBranch}` : ''}${meta.goal ? ' goal=yes' : ''}${meta.nativeGoal ? ` native-goal=${meta.nativeGoal}` : ''}`);
    this.deps.analytics.touchSession(meta);
    const recent = [cfg.projectRoot, ...s.recentProjects.filter((p) => p !== cfg.projectRoot)].slice(0, 12);
    // The folder keeps its sidebar entry even after its last session is archived or deleted.
    const folders = s.folders.includes(cfg.projectRoot) ? s.folders : [...s.folders, cfg.projectRoot];
    await this.deps.settings.update({ recentProjects: recent, folders });
    this.pushSessions();
    const promptText = req.initialPrompt?.trim() ?? '';
    const initialImages = req.initialImages?.length ? req.initialImages : undefined;
    if (meta.nativeGoal) {
      // A slash command has to open its message, so the objective rides along as its argument. The
      // harness's own goal takes it from there — no kickoff prompt, no app-side continuation.
      if (!req.title?.trim()) this.scheduleLlmTitle(id, title, promptText || objective);
      void this.send(id, { text: `/${meta.nativeGoal} ${objective}` }).catch((e) => this.emit(id, { type: 'error', message: errorMessage(e) }));
      if (promptText || initialImages) {
        void this.send(id, { text: promptText, images: initialImages }).catch((e) => this.emit(id, { type: 'error', message: errorMessage(e) }));
      }
    } else if (promptText || initialImages) {
      // A user-supplied title stands; otherwise the prompt-derived one is only a placeholder
      // until the one-shot LLM title call lands.
      if (!req.title?.trim() && promptText) this.scheduleLlmTitle(id, title, promptText);
      const prompt = meta.goal && promptText ? `${promptText}\n\nActive goal: ${meta.goal.objective}` : promptText;
      void this.send(id, { text: prompt, images: initialImages }).catch((e) => this.emit(id, { type: 'error', message: errorMessage(e) }));
    } else if (meta.goal) {
      void this.sendAs(id, { text: this.goalKickoffPrompt(meta.goal) }, 'goal').catch((e) => this.emit(id, { type: 'error', message: errorMessage(e) }));
    }
    return meta;
  }

  /** Host-only creation: the Mission already selected the identity, preset and workspace. */
  async createManaged(req: CreateSessionRequest, managed: ManagedSessionDescriptor): Promise<SessionMeta> {
    this.deps.store.sessionDir(managed.id); // Validate the preallocated id before any write.
    if (!path.isAbsolute(managed.cwd)) throw new Error('Mission workspace path must be absolute');
    if (!Number.isSafeInteger(managed.ownership.generation) || managed.ownership.generation < 0) throw new Error('Invalid Mission generation');
    const descriptor = {
      title: req.title?.trim() || 'New session', config: req.config, cwd: managed.cwd,
      worktreeBranch: managed.worktreeBranch, mission: managed.ownership,
    };
    const existing = this.get(managed.id);
    if (existing) {
      // JSON normalization makes optional undefined fields identical before and after restart.
      const prior = { title: existing.title, config: existing.config, cwd: existing.cwd, worktreeBranch: existing.worktreeBranch, mission: existing.mission };
      if (!isDeepStrictEqual(JSON.parse(JSON.stringify(prior)), JSON.parse(JSON.stringify(descriptor)))) throw new Error('Mission session descriptor does not match the existing id');
      await this.deps.store.upsert(existing);
      return existing;
    }
    const meta: SessionMeta = {
      ...structuredClone(descriptor), id: managed.id, createdAt: Date.now(), updatedAt: Date.now(),
      status: 'idle', harnessRef: {}, usage: emptyUsage(), activeModel: req.config.model,
      activeEffort: req.config.effort ?? undefined, queued: 0,
    };
    await this.deps.store.upsert(meta);
    this.deps.analytics.touchSession(meta);
    this.pushSessions();
    return meta;
  }

  /** Reconfiguration never silently resets a live runtime, even one parked between turns. */
  async updateManaged(id: string, generation: number, patch: ManagedSessionUpdate): Promise<SessionMeta> {
    const meta = this.managedMeta(id, generation);
    if (!this.activity(id).quiescent) throw new Error('Mission session is not quiescent');
    if (this.active.has(id)) throw new Error('Stop the Mission runtime before reconfiguring it');
    const mission = { ...meta.mission, ...patch.mission };
    if (mission.missionId !== meta.mission.missionId || mission.role !== meta.mission.role) throw new Error('Mission ownership cannot be transferred');
    if (!Number.isSafeInteger(mission.generation) || mission.generation < generation) throw new Error('Invalid Mission generation');
    if (patch.cwd !== undefined && !path.isAbsolute(patch.cwd)) throw new Error('Mission workspace path must be absolute');
    meta.mission = structuredClone(mission);
    if (patch.config) {
      meta.config = { ...meta.config, ...structuredClone(patch.config) };
      meta.activeModel = meta.config.model;
      meta.activeEffort = meta.config.effort ?? undefined;
    }
    if (patch.cwd !== undefined) meta.cwd = patch.cwd;
    if (Object.hasOwn(patch, 'worktreeBranch')) meta.worktreeBranch = patch.worktreeBranch;
    meta.goal = undefined;
    meta.nativeGoal = undefined;
    meta.updatedAt = Date.now();
    await this.deps.store.upsert(meta);
    this.deps.analytics.touchSession(meta);
    this.pushSessions();
    return meta;
  }

  /** Archive is retention only. The service must first stop every owned child/runtime. */
  async archiveManaged(id: string, generation: number, archived = true): Promise<SessionMeta> {
    const meta = this.managedMeta(id, generation);
    const owned = this.deps.store.list().filter((session) => session.mission?.missionId === meta.mission.missionId);
    if (owned.some((session) => this.active.has(session.id) || !this.activity(session.id).quiescent)) throw new Error('Stop all Mission sessions before archiving');
    meta.archived = archived;
    meta.updatedAt = Date.now();
    await this.deps.store.upsert(meta);
    this.pushSessions();
    return meta;
  }

  private goalKickoffPrompt(goal: GoalState): string {
    return `You have a persistent goal for this session:\n\n${goal.objective}\n\nWork toward it autonomously. When you believe it is fully achieved and verified, run a completion audit (restate deliverables, map each requirement to concrete evidence, note gaps) and end your reply with the exact token ${GOAL_COMPLETE_TOKEN} on its own line. If anything is missing, keep working instead of declaring completion.`;
  }

  async delete(id: string, removeWt = false): Promise<void> {
    if (await this.deleteOne(id, removeWt)) this.pushSessions();
  }

  /**
   * Deletes several sessions as one operation — removing a project folder from the app takes its
   * whole session list with it. The list is pushed once, at the end, so the renderer sees a single
   * departure and picks one replacement selection instead of hopping through the doomed rows.
   */
  async deleteMany(ids: string[]): Promise<number> {
    for (const id of ids) this.assertUnmanaged(id);
    let removed = 0;
    for (const id of ids) {
      const removeWt = !!this.get(id)?.worktreeBranch;
      if (await this.deleteOne(id, removeWt)) removed++;
    }
    if (removed) this.pushSessions();
    return removed;
  }

  /** The delete itself, without the list push; resolves false when the id is already gone. */
  private async deleteOne(id: string, removeWt: boolean): Promise<boolean> {
    this.assertUnmanaged(id);
    const meta = this.get(id);
    if (!meta) return false;
    const t0 = Date.now();
    await this.stop(id);
    this.cancelPersist(id);
    this.titleAttempts.delete(id);
    const tStop = Date.now();
    if (meta.worktreeBranch && removeWt) {
      try {
        await removeWorktree(meta.config.projectRoot, meta.cwd);
      } catch (e) {
        this.deps.log('warn', `[${id}] worktree removal failed: ${errorMessage(e)}`);
      }
    }
    const tWorktree = Date.now();
    await this.deps.store.remove(id);
    const tStore = Date.now();
    this.deps.log('info', `[${id}] session deleted (${meta.config.harness}, "${meta.title.slice(0, 60)}")${meta.worktreeBranch ? `; worktree ${meta.worktreeBranch} ${removeWt ? 'removed' : 'kept'}` : ''}`);
    if (tStore - t0 >= 1000) this.deps.log('warn', `slow session delete ${id}: stop ${tStop - t0}ms, worktree ${tWorktree - tStop}ms, store ${tStore - tWorktree}ms`);
    return true;
  }

  async patch(id: string, patch: Partial<SessionMeta>): Promise<SessionMeta> {
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    if ('mission' in patch || (meta.mission && Object.keys(patch).some((key) => !['title', 'titleIsPlaceholder', 'pinned', 'pinnedAt'].includes(key)))) {
      throw new Error('Mission ownership and execution state cannot be changed through session patch');
    }
    // A rename is the user naming the session: no title model may overwrite it afterwards.
    const named = patch.title !== undefined && patch.titleIsPlaceholder === undefined ? { titleIsPlaceholder: undefined } : {};
    Object.assign(meta, patch, named, { updatedAt: Date.now() });
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
    this.assertUnmanaged(id);
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    if (archived) {
      // An archived session leaves the sidebar, so nothing of it may keep running: stop the harness
      // (and everything it spawned) whether or not the worktree is being removed. Unarchiving starts
      // it again on the next send.
      await this.stop(id);
      if (removeWt && meta.worktreeBranch) {
        // Non-force by default: a worktree with uncommitted changes is refused (WorktreeDirtyError);
        // the renderer confirms discarding and retries with forceWorktree.
        await removeWorktree(meta.config.projectRoot, meta.cwd, { force: forceWt });
      }
    }
    if (!archived && meta.worktreeBranch) {
      // The worktree may have been removed while archived; recreate it so the session can start again.
      try {
        await restoreWorktree(meta.config.projectRoot, meta.cwd, meta.worktreeBranch);
      } catch (e) {
        this.deps.log('warn', `[${id}] worktree restore failed: ${errorMessage(e)}`);
      }
    }
    this.deps.log('info', `[${id}] session ${archived ? 'archived' : 'unarchived'}${archived && removeWt && meta.worktreeBranch ? ` (worktree removed${forceWt ? ', forced' : ''})` : ''}`);
    return this.patch(id, { archived });
  }

  /**
   * Subagent runs recorded for a session, newest first. Detail never enters the parent transcript,
   * so the panel reads the run files instead; a missing session or directory is simply "none".
   */
  async subagentRuns(id: string): Promise<SubagentRunSummary[]> {
    const meta = this.get(id);
    if (!meta) return [];
    // The panel is often opened after a restart, when nothing is running: runs whose process is gone
    // are reported as interrupted instead of spinning forever.
    return listSubagentRuns(this.deps.store.sessionDir(id), meta.config.harness, { live: this.active.has(id) });
  }

  /** One subagent run with its transcript and per-call rows, or null when it is gone. */
  async subagentRun(id: string, runId: string): Promise<SubagentRun | null> {
    const meta = this.get(id);
    if (!meta) return null;
    return readSubagentRun(this.deps.store.sessionDir(id), meta.config.harness, runId, { live: this.active.has(id) });
  }

  /**
   * The subagent types a running session's engine can delegate to. Only a live process can name
   * them, so an idle session answers with none rather than starting one to ask.
   */
  async subagentTypes(id: string): Promise<AgentTypeInfo[]> {
    const adapter = this.active.get(id)?.adapter;
    if (!adapter?.listAgents) return [];
    return adapter.listAgents().catch(() => []);
  }

  /**
   * Stops or steers one subagent run by sending the extension command straight to the harness.
   * The command is not a user message: it must not appear in the transcript or start a turn, so it
   * bypasses `send` and talks to the live adapter. Only harnesses with per-run control accept it —
   * the Claude SDK can interrupt a turn but not one child, so it must refuse rather than no-op.
   */
  async subagentCommand(id: string, runId: string, kind: 'stop' | 'steer', message?: string): Promise<{ ok: boolean; error?: string }> {
    this.assertUnmanaged(id);
    const meta = this.get(id);
    if (!meta) return { ok: false, error: 'Session not found' };
    if (!subagentSupport(meta.config.harness).control) return { ok: false, error: `Subagent stop/steer is not available for the ${meta.config.harness} harness` };
    if (!isValidRunId(runId)) return { ok: false, error: 'Invalid run id' };
    if (kind === 'steer' && !message?.trim()) return { ok: false, error: 'Message cannot be empty' };
    const active = this.active.get(id);
    if (!active) return { ok: false, error: 'Session is not running' };
    const text = kind === 'stop' ? `/vocs-subagent-stop ${runId}` : `/vocs-subagent-steer ${runId} ${message!.trim()}`;
    try {
      await active.adapter.send({ text });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  transcript(id: string): Promise<TranscriptItem[]> {
    return this.transcriptSnapshot(id).then((snapshot) => snapshot.items);
  }

  /** The transcript plus the event-sequence floor its live overlay reflects. A remote client keeps
   *  the floor beside the snapshot and applies only later events, so the stream that follows can
   *  neither double the text the snapshot already has nor lose an event the snapshot missed. */
  async transcriptSnapshot(id: string): Promise<{ items: TranscriptItem[]; seq: number }> {
    if (!this.get(id)) throw new Error('Session not found');
    const beforeActive = this.active.get(id);
    const beforeSeq = this.seq;
    const stored = await this.deps.store.readTranscript(id);
    const active = this.active.get(id);
    // A persisted answer still marked streaming is a checkpoint from a run that ended before it
    // finished (a crash, or an older build); only the live copy can still be streaming.
    const live = active?.liveItems;
    const items = stored.map((i) => (i.kind === 'assistant' && i.streaming && !live?.has(i.id) ? { ...i, streaming: false } : i));
    if (!active || active !== beforeActive) {
      // No live overlay to vouch for the window, or the session was replaced mid-read: fall back
      // to the counter from before the read, so every event during it is replayed rather than
      // dropped. Replaying an item the snapshot already holds replaces it in place.
      return { items, seq: beforeSeq };
    }
    // Overlay in-memory streaming state. The live item is copied, not aliased: a snapshot's items
    // must stay frozen at `seq`, while later deltas keep mutating the live map in place. Copying
    // it and reading the counter happen in one synchronous block, so everything at or before `seq`
    // is in `items` and nothing after it is.
    const map = new Map(items.map((i) => [i.id, i]));
    for (const [k, v] of live!) map.set(k, { ...v });
    const persistedIds = new Set(items.map((i) => i.id));
    const order = [...persistedIds, ...[...live!.keys()].filter((k) => !persistedIds.has(k))];
    return { items: order.map((k) => map.get(k) as TranscriptItem), seq: this.seq };
  }

  private buildContext(meta: SessionMeta, id: string, current = () => true): HarnessContext {
    const store = this.deps.store;
    const sessionDir = store.sessionDir(id);
    const managed = !!meta.mission;
    const snapshot = structuredClone(meta);
    // A retired managed runtime reads its launch snapshot. An ordinary runtime always reads the
    // live session, as it always did: a permission mode tightened after start must still govern the
    // approvals it raises while it shuts down.
    const session = () => managed && !current() ? snapshot : this.get(id) ?? meta;
    return {
      sessionId: id,
      session,
      settings: () => this.settings(),
      runtime: this.deps.runtime,
      sessionDir,
      permissionMode: () => session().config.permissionMode,
      ordinaryProcessOwnership: () => !managed && this.ordinaryOwnership(),
      effort: () => {
        const m = session();
        // An explicit omission must not borrow the preference retained for effort-capable models.
        // A later deliberate effort switch still wins, as it does for an explicit level. A Mission
        // preset that keeps the runtime's reasoning default never inherits the app default either.
        if (m.activeEffort) return m.activeEffort;
        if (m.config.effort === null) return undefined;
        return m.config.effort ?? (m.mission?.reasoningDefault ? undefined : this.settings().defaultEffort);
      },
      getApiKey: (providerId) => this.deps.getSecret(providerId),
      mcpServers: async () => {
        if (!current()) throw new Error('Session runtime is no longer current');
        const m = session();
        const hooks = m.mission ? this.requireMissionHooks() : undefined;
        const servers = await resolveForSession(
          { settings: this.settings(), cwd: m.cwd, projectRoot: m.config.projectRoot, harness: m.config.harness, branch: m.worktreeBranch },
          {
            getSecret: this.deps.getSecret,
            sharedGitnexus: this.deps.sharedGitnexus,
            gitnexusProxyPath: this.deps.gitnexusProxyPath,
            memoryServerPath: this.deps.memoryServerPath,
            memoryUserData: this.deps.memoryUserData,
            log: (level, message) => this.deps.log(level, `[${id}] ${message}`)
          }
        );
        if (!current() || (hooks && this.missionHooks !== hooks)) throw new Error('Session runtime is no longer current');
        const resolved = hooks ? await hooks.mcpServers(m, servers) : servers;
        if (!current() || (hooks && this.missionHooks !== hooks)) throw new Error('Session runtime is no longer current');
        return resolved;
      },
      ownedMcpIds: () => builtinServerIds(),
      emit: (event) => { if (current()) this.emit(id, event); },
      requestApproval: (draft) => current() ? this.requestApproval(id, draft) : Promise.resolve({ optionId: 'deny', note: 'Session runtime is no longer current' }),
      updateRef: (patch: Partial<HarnessRef>) => {
        if (!current()) return;
        const m = this.get(id);
        if (!m) return;
        m.harnessRef = { ...m.harnessRef, ...patch };
        this.schedulePersist(m);
      },
      updateMeta: (patch) => {
        if (!current()) return;
        const m = this.get(id);
        if (!m) return;
        Object.assign(m, patch);
        // A harness may discover its actual model only after startup. Refresh the analytics
        // snapshot immediately so tool calls before the first usage update are not unattributed.
        if ('activeModel' in patch) this.deps.analytics.touchSession(m);
        // The harness just reported the commands it accepts: `/goal` may have changed hands.
        if ('harnessCommands' in patch) {
          void this.applyGoalDriver(m, current)
            .then((changed) => {
              if (!changed) return;
              this.schedulePersist(m);
              this.pushSessions();
            })
            .catch((e) => this.deps.log('warn', `[${id}] goal driver update failed: ${errorMessage(e)}`));
        }
        this.schedulePersist(m);
        this.pushSessions();
        if (m.mission) this.publish(id, { type: 'meta', patch });
      },
      log: (level, message) => this.deps.log(level, `[${id}] ${message}`),
      readJson: (name) => readJson(path.join(sessionDir, name), null),
      writeJson: (name, data) => current() ? writeJson(path.join(sessionDir, name), data) : Promise.resolve()
    };
  }

  private async ensureActive(id: string): Promise<ActiveSession> {
    const existing = this.active.get(id);
    if (existing) {
      if (existing.tearingDown || existing.uncertain) throw new Error('Session runtime is stopping or uncertain');
      if (existing.starting) await existing.starting;
      return existing;
    }
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    // The previous run's advertised commands say nothing about this one: the harness re-reports them
    // once it starts. Recompute the driver before the first send, so a `/goal` opening a resumed
    // session is not handed to a command this harness no longer has.
    if (meta.mission) {
      meta.harnessCommands = undefined;
      meta.goal = undefined;
      meta.nativeGoal = undefined;
    } else if (meta.harnessCommands?.length) {
      meta.harnessCommands = undefined;
      await this.applyGoalDriver(meta);
      this.schedulePersist(meta);
    }
    const generation = meta.mission?.generation;
    const managed = !!meta.mission;
    const seq = (this.runtimeSeq.get(id) ?? 0) + 1;
    this.runtimeSeq.set(id, seq);
    let active: ActiveSession;
    // A managed runtime is fenced as soon as its teardown starts. An ordinary runtime keeps
    // recording its own events and writes while it disposes (its interrupted turn, final usage,
    // history), as it always did, and is fenced only once a newer runtime supersedes it.
    const current = managed
      ? () => !!active && this.active.get(id) === active && !active.tearingDown && this.get(id)?.mission?.generation === generation
      : () => this.runtimeSeq.get(id) === seq && this.get(id)?.mission?.generation === generation;
    const live = () => current() && !active.tearingDown;
    const ctx = this.buildContext(meta, id, current);
    const adapter = createAdapter(meta.config.harness, ctx);
    active = {
      adapter,
      turnPending: false,
      startupDispatched: false,
      tearingDown: false,
      uncertain: false,
      disposal: null,
      nativeChildren: new Map(),
      approvals: new Map(),
      liveItems: new Map(),
      toolModels: new Map(),
      dirty: new Set(),
      lastAssistantText: '',
      starting: null,
      models: null,
      autoCompactionThreshold: undefined,
      autoCompactionLatched: false,
      autoCompactionRetryAt: 0,
      autoCompactionRetryTimer: null,
      compactionInFlight: null,
      autoCompactionWindow: undefined,
      goalContinuationTimer: null,
      pendingGoalKickoff: null,
      checkpoints: new Map(),
      checkpointTimer: null
    };
    this.active.set(id, active);
    meta.status = 'starting';
    meta.statusDetail = `Starting ${HARNESS_BY_ID[meta.config.harness].name}…`;
    this.pushSessions();
    const resume = describeResume(meta.harnessRef);
    this.deps.log('info', `[${id}] starting ${meta.config.harness} (model=${describeModel(meta.activeModel)} permissions=${meta.config.permissionMode} cwd=${meta.cwd}${resume ? ` resume=${resume}` : ''})`);
    const t0 = Date.now();
    const start = async () => {
      if (!live()) throw new Error('Session stopped before its runtime could start.');
      active.startupDispatched = true;
      if (meta.config.permissionMode !== 'plan') await this.claimWorkspaceWriter(meta, active);
      if (!live()) throw new Error('Session stopped before its runtime could start.');
      await adapter.start();
    };
    active.starting = (this.admits(meta) ? this.deps.withWorkspaceDispatch!(meta, start) : start())
      .then(() => {
        active.starting = null;
        this.deps.log('info', `[${id}] ${meta.config.harness} started in ${Date.now() - t0}ms`);
        // An ordinary Stop does not wait for startup. A start that completed after it must not
        // leave its process running, so dispose again (managed teardown awaits startup instead).
        if (!managed && active.tearingDown) {
          void Promise.resolve().then(() => adapter.dispose()).catch((e) => this.deps.log('warn', `[${id}] dispose after a start that outlived Stop failed: ${errorMessage(e)}`));
          return;
        }
        // An owned launch that fell back to a plain one tracks nothing, so it holds no claim.
        const claim = active.workspaceWriterClaim;
        if (claim && adapter.workspaceWriterState?.() === undefined) {
          active.workspaceWriterClaim = undefined;
          void this.dropWriterClaim(id, claim).catch((e) => this.deps.log('warn', `[${id}] writer claim bookkeeping failed: ${errorMessage(e)}`));
        }
        const m = this.get(id);
        if (live() && m && m.status === 'starting') {
          m.status = 'idle';
          m.statusDetail = undefined;
          this.pushSessions();
        }
      })
      .catch((e) => {
        active.starting = null;
        if (this.active.get(id) !== active) throw e;
        // The transcript card below is what the user sees; this line is what a bug report needs.
        this.deps.log('error', `[${id}] ${meta.config.harness} failed to start after ${Date.now() - t0}ms: ${e instanceof Error ? e.stack ?? e.message : errorMessage(e)}`);
        // Start failed after spawn: dispose the adapter so no harness child process is orphaned
        // (pi/acp start() have no self-cleaning handshake either).
        const disposal = this.disposeRuntime(id, active, 'error');
        disposal.catch((de) => this.deps.log('warn', `[${id}] dispose after failed start: ${errorMessage(de)}`));
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
    return this.sendAs(id, input, 'user');
  }

  /** Starts only the pinned managed runtime and observes its handshake; never sends a prompt.
   * Kept off generic IPC: configuration/catalog entries are not runtime Mission certification. */
  async prepareManaged(id: string, generation: number) {
    const meta = this.managedMeta(id, generation);
    const hooks = this.requireMissionHooks();
    if (meta.archived) throw new Error('Mission session is archived');
    const before = this.activity(id);
    if (before.turn || before.tools || before.approvals || before.compacting || before.tearingDown || before.uncertain) throw new Error('Mission runtime is not idle for capability inspection');
    const active = await this.ensureActive(id);
    const readiness = await active.adapter.missionReadiness?.() ?? { ready: false, tools: [], reason: 'This adapter has not certified the Mission control protocol.' };
    const models = await active.adapter.listModels?.() ?? [];
    this.managedMeta(id, generation);
    if (this.active.get(id) !== active || this.missionHooks !== hooks || active.tearingDown || active.uncertain) throw new Error('Mission capability observation became stale');
    return { readiness, models };
  }

  /** Host verification/delivery uses the same user-visible approval channel as harness tools.
   * Starting an idle lead here connects its runtime only; it never sends model input. */
  async requestManagedApproval(id: string, generation: number, draft: ApprovalDraft): Promise<ApprovalDecision> {
    const meta = this.managedMeta(id, generation);
    const hooks = this.requireMissionHooks();
    if (meta.mission!.questionId) throw new Error('Completed Mission answers cannot request execution approvals.');
    if (meta.mission!.role !== 'lead' || meta.archived) throw new Error('Host operation approvals belong to the active Mission lead');
    const active = await this.ensureActive(id);
    this.managedMeta(id, generation);
    if (this.active.get(id) !== active || this.missionHooks !== hooks || active.tearingDown || active.uncertain) throw new Error('Mission approval owner changed');
    const decision = await this.requestApproval(id, draft);
    this.managedMeta(id, generation);
    if (this.active.get(id) !== active || this.missionHooks !== hooks || active.tearingDown || active.uncertain) throw new Error('Mission approval owner changed');
    return decision;
  }

  async sendManaged(id: string, input: UserInput, generation: number): Promise<void> {
    const meta = this.managedMeta(id, generation);
    this.requireMissionHooks();
    if (meta.archived) throw new Error('Mission session is archived');
    if (meta.mission.questionId && (meta.mission.role !== 'lead' || meta.mission.sourceAccess !== 'read_only' || meta.config.permissionMode !== 'plan' || meta.mission.attemptId)) throw new Error('Completed Mission answers require the read-only lead scope.');
    if (/^\/goal(?:\s|$)/i.test(input.text.trimStart())) throw new Error('Mission owns continuation; native goals are not allowed');
    const activity = this.activity(id);
    // Compaction alone can be waited out by dispatchInput; no other activity admits another send.
    if (activity.starting || activity.turn || activity.tools || activity.approvals || activity.queued || activity.tearingDown || activity.uncertain) throw new Error('Mission session is not ready for dispatch');
    this.managedDispatches.set(id, { canceled: false });
    try {
      await this.sendAs(id, input, 'mission', generation);
    } finally {
      this.managedDispatches.delete(id);
      this.publish(id, { type: 'meta', patch: { queued: this.get(id)?.queued ?? 0 } });
    }
  }

  /**
   * `source` is host provenance, never supplied by a renderer or model. Goal and Mission dispatch
   * are not user actions: they confer no new authority and must not affect user recency.
   */
  private async sendAs(id: string, input: UserInput, source: 'user' | 'goal' | 'mission', generation?: number): Promise<void> {
    const meta = source === 'mission' ? this.managedMeta(id, generation!) : this.get(id);
    if (!meta) throw new Error('Session not found');
    if (source !== 'mission') this.assertUnmanaged(id);
    // Size and shape only: the prompt itself belongs to the transcript, not the log.
    this.deps.log('debug', `[${id}] ${source === 'mission' ? 'mission' : 'user'} input: ${input.text.length} chars${input.images?.length ? `, ${input.images.length} image(s)` : ''}${input.mode ? `, mode=${input.mode}` : ''}`);
    const userItem: TranscriptItem = { id: shortId('u_'), kind: 'user', ts: Date.now(), text: input.text, images: input.images, queuedAs: input.mode };
    this.emit(id, { type: 'item.upsert', item: userItem });
    // The sidebar orders rows by the user's own last message: stamp it before the harness even
    // starts, so the row moves up on the send rather than on whatever the turn does next.
    if (source === 'user') meta.lastUserMessageAt = userItem.ts;
    // A session named from a dialog prompt or a goal is already carrying a placeholder, and that
    // placeholder is the better one: it was cut from what the user wrote, not from a `/goal …`
    // command the app composed. Keep it on screen and let the model replace it.
    if (source !== 'mission' && isPlaceholderTitle(meta) && input.text.trim()) {
      const placeholder = meta.title === 'New session' ? titleFromPrompt(input.text) : meta.title;
      // A goal kickoff is the app's own prompt; the objective behind it is what names the session.
      const seed = (source === 'goal' && meta.goal?.objective?.trim()) || input.text;
      meta.title = placeholder;
      meta.titleIsPlaceholder = true;
      this.scheduleLlmTitle(id, placeholder, seed);
    }
    this.schedulePersist(meta);
    this.pushSessions();
    await this.dispatchInput(id, { ...input, transcriptItemId: userItem.id }, generation);
  }

  /** Replaces a sent prompt only when its adapter can restore a durable pre-message checkpoint. */
  async editAndResend(id: string, userItemId: string, input: UserInput): Promise<TranscriptItem[]> {
    this.assertUnmanaged(id);
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
    this.deps.log('info', `[${id}] rewound to message ${userItemId} for edit-and-resend; ${items.length - index - 1} later item(s) dropped from the transcript`);

    const revised: TranscriptItem = {
      ...previous,
      text: input.text,
      images: input.images ?? previous.images,
      queuedAs: 'now'
    };
    // Context is now safely at the same boundary, so the persistence rewrite cannot diverge.
    active.liveItems.clear();
    active.dirty.clear();
    this.resetCheckpoints(active);
    active.lastAssistantText = '';
    await this.deps.store.rewriteTranscript(id, [...items.slice(0, index), revised]);
    // A re-sent prompt is a user message too, so the sidebar treats this as its latest one.
    meta.lastUserMessageAt = Date.now();
    this.schedulePersist(meta);
    this.pushSessions();
    await this.dispatchInput(id, { text: revised.text, images: revised.images, mode: 'now', transcriptItemId: userItemId });
    return this.transcript(id);
  }

  private async dispatchInput(id: string, input: UserInput, generation?: number): Promise<void> {
    const assertGeneration = () => {
      if (generation === undefined) return;
      this.managedMeta(id, generation);
      if (this.managedDispatches.get(id)?.canceled) throw new Error('Session stopped before the message could be sent.');
    };
    assertGeneration();
    const hooks = generation !== undefined ? this.requireMissionHooks() : undefined;
    const active = await this.ensureActive(id);
    // Compaction can run without marking an adapter busy. Keep a new turn from reading or
    // mutating its context until that operation has settled.
    if (active.compactionInFlight) await active.compactionInFlight.catch(() => undefined);
    const assertCurrent = () => {
      assertGeneration();
      if (this.active.get(id) !== active || active.tearingDown || active.uncertain) throw new Error('Session stopped before the message could be sent.');
      if (hooks && this.requireMissionHooks() !== hooks) throw new Error('Mission dispatch hooks changed');
    };
    assertCurrent();
    const prepared = await this.withSessionPreamble(id, input);
    assertCurrent();
    const dispatch = async () => {
      if (hooks) {
        await hooks.beforeDispatch(this.managedMeta(id, generation!), prepared);
        assertCurrent();
      }
      assertCurrent();
      active.turnPending = true;
      try {
        await active.adapter.send(prepared);
      } catch (e) {
        if (hooks) active.uncertain = true; // A rejected transport request need not mean no work ran.
        throw e;
      }
    };
    const meta = this.get(id);
    if (meta && this.admits(meta)) await this.deps.withWorkspaceDispatch!(meta, dispatch);
    else await dispatch();
    if (hooks) assertCurrent();
    await this.clearSessionPreamble(id);
  }

  /**
   * Prefixes the first message of a session with the context its harness could not be given up
   * front: the transcript of a cross-harness fork, and the knowledge digest for a harness with no
   * system prompt of its own. Prefixing the user's message — rather than sending a turn of our own —
   * keeps the transcript showing only what the user typed.
   */
  private async withSessionPreamble(id: string, input: UserInput): Promise<UserInput> {
    const meta = this.get(id);
    if (!meta) return input;
    const parts: string[] = [];
    if (meta.pendingForkContext) {
      try {
        const context = await this.deps.store.readBlob(id, FORK_CONTEXT_FILE);
        if (context) parts.push(context);
      } catch {
        // The blob is written before the flag is set; a read failure only means we have no context.
      }
    }
    if (meta.pendingKnowledgeDigest && meta.knowledgeDigest) parts.push(meta.knowledgeDigest);
    return parts.length ? { ...input, text: `${parts.join('\n\n')}\n\n${input.text}` } : input;
  }

  /** Cleared only after the harness accepted the seeded message, so a failed start retries with it. */
  private async clearSessionPreamble(id: string): Promise<void> {
    const meta = this.get(id);
    if (!meta?.pendingForkContext && !meta?.pendingKnowledgeDigest) return;
    meta.pendingForkContext = undefined;
    meta.pendingKnowledgeDigest = undefined;
    await this.deps.store.upsert(meta);
  }

  /**
   * Replaces a prompt-derived placeholder title with an LLM-generated one, as long as the
   * user has not renamed (or deleted) the session while the call was in flight.
   */
  private scheduleLlmTitle(id: string, placeholder: string, prompt: string): void {
    const attempts = this.titleAttempts.get(id) ?? 0;
    if (attempts >= MAX_TITLE_ATTEMPTS || this.titleInFlight.has(id)) return;
    this.titleAttempts.set(id, attempts + 1);
    this.titleInFlight.add(id);
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
        // The session has a real name now; a later message must not re-title it.
        meta.titleIsPlaceholder = undefined;
        this.schedulePersist(meta);
        this.pushSessions();
      })
      .catch(() => undefined)
      .finally(() => this.titleInFlight.delete(id));
  }

  /** Denies every pending approval and records the decision on its transcript card. */
  private cancelApprovals(id: string, active: ActiveSession, note: string): void {
    if (active.approvals.size) this.deps.log('info', `[${id}] denying ${active.approvals.size} pending approval(s): ${note}`);
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

  async interruptManaged(id: string, generation: number): Promise<void> {
    this.managedMeta(id, generation);
    const pending = this.managedDispatches.get(id);
    if (pending) pending.canceled = true;
    const active = this.active.get(id);
    if (!active) return;
    if (active.tearingDown) throw new Error('Mission session is stopping');
    this.cancelApprovals(id, active, 'Interrupted');
    try {
      await active.adapter.interrupt();
    } catch (e) {
      active.uncertain = true;
      throw e;
    }
  }

  async stopManaged(id: string, generation: number): Promise<void> {
    this.managedMeta(id, generation);
    const pending = this.managedDispatches.get(id);
    if (pending) pending.canceled = true;
    const active = this.active.get(id);
    if (active) await this.disposeRuntime(id, active);
  }

  /** Only a runtime that tracks its writers (ordinary Pi while ordinary process ownership is on)
   * persists a claim; `undefined` from `workspaceWriterState` means untracked, like Claude/Codex. */
  private async claimWorkspaceWriter(meta: SessionMeta, active: ActiveSession): Promise<void> {
    if (meta.mission || active.adapter.workspaceWriterState?.() === undefined) return;
    if (active.workspaceWriterClaim) return active.workspaceWriterClaimPersisted;
    active.workspaceWriterClaim = shortId('writer_');
    meta.workspaceWriterClaims = [...(meta.workspaceWriterClaims ?? []), active.workspaceWriterClaim];
    // A crash after this write is unknown, not an empty runtime map proving settlement. A later
    // launch remains usable but owns only its new claim; it cannot erase an earlier process tree.
    // Bookkeeping never fails the ordinary start itself: the claim stays in memory either way.
    active.workspaceWriterClaimPersisted = Promise.resolve(this.deps.store.upsert(meta)).then(
      () => undefined,
      (e) => this.deps.log('warn', `[${meta.id}] workspace writer claim persist failed: ${errorMessage(e)}`),
    );
    await active.workspaceWriterClaimPersisted;
  }

  private disposeRuntime(id: string, active: ActiveSession, status: 'idle' | 'stopped' | 'error' = 'stopped'): Promise<void> {
    return this.get(id)?.mission ? this.disposeManaged(id, active, status) : this.retireOrdinary(id, active, status === 'idle');
  }

  /** Keep the process owned until disposal succeeds; a timeout is not evidence of quiescence. */
  private disposeManaged(id: string, active: ActiveSession, status: 'idle' | 'stopped' | 'error'): Promise<void> {
    if (active.disposal) return active.disposal;
    active.tearingDown = true;
    if (active.autoCompactionRetryTimer) clearTimeout(active.autoCompactionRetryTimer);
    if (active.goalContinuationTimer) clearTimeout(active.goalContinuationTimer);
    active.pendingGoalKickoff = null;
    const operation = Promise.resolve().then(async () => {
      // Install the disposal promise before notifying observers, which may themselves request stop.
      this.cancelApprovals(id, active, 'Mission session stopped');
      // A delayed start must not spawn after we disposed its adapter.
      if (active.starting) await active.starting.catch(() => undefined);
      try {
        await active.adapter.dispose();
        const writers = active.adapter.workspaceWriterState?.();
        if (writers && writers !== 'quiescent') throw new Error('Session process-tree disposal is unproven. Workspace writer ownership is retained.');
        await this.flushLive(id, active, true);
        const meta = this.get(id);
        if (meta) {
          meta.status = status;
          meta.statusDetail = undefined;
          meta.queued = 0;
          await this.deps.store.upsert(meta);
        }
        if (this.active.get(id) === active) this.active.delete(id);
        this.pushSessions();
        this.publish(id, { type: 'status', status });
      } catch (e) {
        active.uncertain = true;
        const meta = this.get(id);
        if (meta) {
          meta.status = 'error';
          meta.lastError = `Mission runtime disposal uncertain: ${errorMessage(e)}`;
          meta.statusDetail = meta.lastError;
          this.schedulePersist(meta);
          this.pushSessions();
        }
        throw e;
      } finally {
        active.disposal = null;
      }
    });
    active.disposal = operation;
    return operation;
  }

  /**
   * Ordinary teardown, as it always was: the session is released at once (a new send starts a new
   * runtime), live items are saved, disposal errors are logged, and nothing waits unboundedly:
   * neither a pending startup nor a hung dispose. Ownership bookkeeping never fails it. A writer
   * claim is dropped only on positive proof; an unproven one stays as Mission admission information.
   * `explicit` is a user Stop (the status returns to idle); otherwise the harness ended itself and
   * its own status stays.
   */
  private retireOrdinary(id: string, active: ActiveSession, explicit: boolean): Promise<void> {
    if (active.disposal) return active.disposal;
    active.tearingDown = true;
    if (active.autoCompactionRetryTimer) clearTimeout(active.autoCompactionRetryTimer);
    if (active.goalContinuationTimer) clearTimeout(active.goalContinuationTimer);
    active.pendingGoalKickoff = null;
    if (this.active.get(id) === active) this.active.delete(id);
    const retiring = this.retiring.get(id) ?? new Set<ActiveSession>();
    retiring.add(active);
    this.retiring.set(id, retiring);
    const operation = Promise.resolve().then(async () => {
      // Install the disposal promise before notifying observers, which may themselves request stop.
      this.cancelApprovals(id, active, 'Session stopped');
      await this.flushLive(id, active, true).catch((e) => this.deps.log('warn', `[${id}] live flush on stop failed: ${errorMessage(e)}`));
      const settled = Promise.resolve()
        .then(() => active.adapter.dispose())
        .then(() => {
          const writers = active.adapter.workspaceWriterState?.();
          return writers === undefined || writers === 'quiescent';
        }, (e) => {
          this.deps.log('warn', `[${id}] dispose failed: ${errorMessage(e)}`);
          return false;
        })
        .then((proven) => this.settleWriterClaim(id, active, proven))
        .catch((e) => this.deps.log('warn', `[${id}] writer claim bookkeeping failed: ${errorMessage(e)}`))
        .finally(() => {
          retiring.delete(active);
          if (!retiring.size && this.retiring.get(id) === retiring) this.retiring.delete(id);
        });
      let timer: NodeJS.Timeout | undefined;
      const finished = await Promise.race([
        settled.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), this.deps.disposeWaitMs ?? ORDINARY_DISPOSE_WAIT_MS); timer.unref?.(); }),
      ]);
      clearTimeout(timer);
      if (!finished) this.deps.log('warn', `[${id}] ${active.adapter.id} is still shutting down after ${this.deps.disposeWaitMs ?? ORDINARY_DISPOSE_WAIT_MS}ms; the session is available again`);
      const meta = this.get(id);
      if (meta && explicit) {
        // Stopping the harness does not change the branch's git state either.
        if (meta.status !== 'pr' && meta.status !== 'merged') {
          meta.status = 'idle';
          meta.statusDetail = undefined;
        }
        meta.queued = 0;
        await Promise.resolve(this.deps.store.upsert(meta)).catch((e) => this.deps.log('warn', `[${id}] meta persist on stop failed: ${errorMessage(e)}`));
      }
      this.pushSessions();
    }).finally(() => {
      active.disposal = null;
    });
    active.disposal = operation;
    return operation;
  }

  /** A retired runtime's own claim goes only with positive proof (or when it never tracked writers). */
  private async settleWriterClaim(id: string, active: ActiveSession, proven: boolean): Promise<void> {
    const claim = active.workspaceWriterClaim;
    if (!claim || !this.get(id)?.workspaceWriterClaims?.includes(claim)) return;
    if (!proven) {
      this.deps.log('warn', `[${id}] process-tree disposal is unproven; its workspace writer claim is kept for Mission admission only`);
      return;
    }
    await this.dropWriterClaim(id, claim);
  }

  private async dropWriterClaim(id: string, claim: string): Promise<void> {
    const meta = this.get(id);
    if (!meta?.workspaceWriterClaims?.includes(claim)) return;
    const kept = meta.workspaceWriterClaims.filter((entry) => entry !== claim);
    meta.workspaceWriterClaims = kept.length ? kept : undefined;
    await this.deps.store.upsert(meta);
  }

  /** An explicit user Stop, Archive, Delete or Move is the acknowledgment for writer claims that no
   * runtime of this process still holds: ones left by an earlier app run (crash, kill, quit timeout)
   * or by a disposal that could not prove itself. Claims of live or disposing runtimes stay. */
  private async releaseStaleWriterClaims(id: string): Promise<void> {
    const meta = this.get(id);
    if (!meta?.workspaceWriterClaims?.length) return;
    const held = new Set([this.active.get(id), ...(this.retiring.get(id) ?? [])].flatMap((runtime) => runtime?.workspaceWriterClaim ? [runtime.workspaceWriterClaim] : []));
    const stale = meta.workspaceWriterClaims.filter((claim) => !held.has(claim));
    if (!stale.length) return;
    const kept = meta.workspaceWriterClaims.filter((claim) => held.has(claim));
    meta.workspaceWriterClaims = kept.length ? kept : undefined;
    this.deps.log('warn', `[${id}] released ${stale.length} unproven workspace writer claim(s) no runtime of this app run holds, on an explicit stop`);
    await Promise.resolve(this.deps.store.upsert(meta)).catch((e) => this.deps.log('warn', `[${id}] meta persist on stop failed: ${errorMessage(e)}`));
  }

  async interrupt(id: string): Promise<void> {
    this.assertUnmanaged(id);
    const active = this.active.get(id);
    if (!active) return;
    this.deps.log('info', `[${id}] interrupt requested`);
    this.cancelApprovals(id, active, 'Interrupted');
    await active.adapter.interrupt();
  }

  /** User Stop (also Archive, Delete and Move): never fails or wedges an ordinary session. */
  async stop(id: string): Promise<void> {
    this.assertUnmanaged(id);
    await this.releaseStaleWriterClaims(id);
    await this.stopOrdinary(id);
  }

  private async stopOrdinary(id: string): Promise<void> {
    const active = this.active.get(id);
    if (!active) return;
    this.deps.log('info', `[${id}] stopping ${active.adapter.id}${active.adapter.busy ? ' (turn in progress)' : ''}`);
    await this.disposeRuntime(id, active, 'idle');
  }

  /** App quit. Never rejects, so the caller still flushes persistence and analytics afterwards. */
  async stopAll(): Promise<void> {
    const ids = [...new Set([...this.active.keys(), ...this.managedDispatches.keys()])];
    if (ids.length) this.deps.log('info', `stopping ${ids.length} running session(s)`);
    const results = await Promise.allSettled(ids.map((id) => {
      const mission = this.get(id)?.mission;
      // Quitting is not a user acknowledgment: unproven claims survive for the next run.
      return mission ? this.stopManaged(id, mission.generation) : this.stopOrdinary(id);
    }));
    results.forEach((result, index) => {
      if (result.status === 'rejected') this.deps.log('warn', `[${ids[index]}] stop during shutdown failed: ${errorMessage(result.reason)}`);
    });
  }

  /**
   * Re-sends each running session's cached model list so a capability override applies without
   * restarting the harness. Cheap: no harness round-trip, only the overrides are re-evaluated.
   */
  republishModels(): void {
    for (const [id, active] of this.active) if (active.models) this.emit(id, { type: 'models', models: active.models });
  }

  async setModel(id: string, model: ModelRef): Promise<SessionMeta> {
    this.assertUnmanaged(id);
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    const active = this.active.get(id);
    // Do not publish or persist the requested model until the harness accepts the switch.
    if (active) await active.adapter.setModel(model);
    this.deps.log('info', `[${id}] model ${describeModel(meta.activeModel)} → ${describeModel(model)}${active ? '' : ' (applies at next start)'}`);
    meta.config.model = model;
    meta.activeModel = model;
    this.deps.analytics.touchSession(meta);
    await this.deps.store.upsert(meta);
    this.pushSessions();
    return meta;
  }

  async setEffort(id: string, effort: EffortLevel): Promise<SessionMeta> {
    this.assertUnmanaged(id);
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    this.deps.log('info', `[${id}] effort ${meta.activeEffort ?? 'default'} → ${effort}`);
    meta.config.effort = effort;
    meta.activeEffort = effort;
    const active = this.active.get(id);
    if (active) await active.adapter.setEffort(effort);
    await this.deps.store.upsert(meta);
    this.pushSessions();
    return meta;
  }

  async setPermissionMode(id: string, mode: PermissionMode): Promise<SessionMeta> {
    this.assertUnmanaged(id);
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    const active = this.active.get(id);
    const apply = async () => {
      if (active && (this.active.get(id) !== active || active.tearingDown)) throw new Error('Session runtime changed before permission update.');
      // Persist ownership before making a previously read-only runtime writable. The workspace
      // lease also holds this transition, including native-child completion's automatic follow-up.
      if (active && mode !== 'plan') await this.claimWorkspaceWriter(meta, active);
      if (active && (this.active.get(id) !== active || active.tearingDown)) throw new Error('Session runtime changed before permission update.');
      // Permission changes are the one setting worth an audit trail: they decide what runs unasked.
      this.deps.log('info', `[${id}] permission mode ${meta.config.permissionMode} → ${mode}`);
      meta.config.permissionMode = mode;
      if (active) await active.adapter.setPermissionMode(mode);
      await this.deps.store.upsert(meta);
    };
    if (active?.adapter.workspaceWriterState?.() !== undefined && mode !== 'plan' && this.admits(meta)) await this.deps.withWorkspaceDispatch!(meta, apply);
    else await apply();
    this.pushSessions();
    this.emit(id, { type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level: 'info', text: `Permission mode set to ${mode}.` } });
    return meta;
  }

  async compact(id: string): Promise<{ ok: boolean; detail?: string }> {
    const active = this.active.get(id);
    if (!active) return { ok: false, detail: 'Session is not running.' };
    if (active.tearingDown || active.uncertain) return { ok: false, detail: 'Session runtime is stopping or uncertain.' };
    if (!active.adapter.compact) return { ok: false, detail: 'This harness does not support compaction.' };
    if (active.compactionInFlight) return { ok: false, detail: 'Context compaction is already in progress.' };
    const threshold = this.settings().autoCompactionThreshold;
    const meta = this.get(id);
    active.autoCompactionThreshold = threshold;
    if (threshold && meta && hasReachedAutoCompactionThreshold(threshold, meta.usage)) active.autoCompactionLatched = true;
    this.deps.log('info', `[${id}] manual context compaction requested (context ${meta?.usage.contextTokens ?? '?'} tokens)`);
    const operation = active.adapter.compact();
    active.compactionInFlight = operation;
    try {
      const compacted = await operation;
      if (compacted === false) {
        active.autoCompactionLatched = false;
        active.autoCompactionRetryAt = Date.now() + AUTO_COMPACTION_RETRY_MS;
        this.scheduleAutoCompactionRetry(id, active);
        this.deps.log('info', `[${id}] compaction skipped: not enough history yet`);
        return { ok: false, detail: 'There is not enough conversation history to compact yet.' };
      }
      this.deps.log('info', `[${id}] compaction completed`);
      return { ok: true };
    } catch (e) {
      active.autoCompactionLatched = false;
      active.autoCompactionRetryAt = Date.now() + AUTO_COMPACTION_RETRY_MS;
      this.scheduleAutoCompactionRetry(id, active);
      this.deps.log('warn', `[${id}] compaction failed: ${errorMessage(e)}`);
      throw e;
    } finally {
      if (active.compactionInFlight === operation) active.compactionInFlight = null;
    }
  }

  /** Wait until adapter queue bookkeeping has settled, then compact once at a safe idle boundary. */
  private scheduleAutoCompaction(id: string): void {
    const active = this.active.get(id);
    // An engine that compacts itself still needs the window kept in step with the setting, and it
    // has to be told when the user clears the setting, so this cannot be gated on a threshold alone.
    if (!active) return;
    if (!this.settings().autoCompactionThreshold && !active.adapter.setAutoCompactionWindow) return;
    queueMicrotask(() => void this.maybeAutoCompact(id));
  }

  /**
   * Hand the token window to an engine that compacts itself, and keep the engine's own default when
   * the user has not chosen a threshold. A threshold whose percentage cannot be resolved yet (no
   * reported context window) is not pushed as a clear, which would disable the engine's default.
   * The window is recorded before the call and rolled back if the engine rejects it, so usage
   * reports arriving while it is in flight cannot queue the same setting up twice.
   */
  private async syncNativeAutoCompaction(id: string, active: ActiveSession, tokens: number | undefined): Promise<void> {
    const pushed = active.autoCompactionWindow;
    if (tokens === undefined && pushed === undefined) return;
    if (tokens === pushed) return;
    active.autoCompactionWindow = tokens;
    try {
      await active.adapter.setAutoCompactionWindow?.(tokens);
      this.deps.log('info', `[${id}] auto-compaction window ${pushed ?? 'harness default'} → ${tokens ?? 'harness default'}`);
    } catch (e) {
      // Unremembered, so the next usage report tries again rather than settling for a window the
      // engine never took.
      active.autoCompactionWindow = pushed;
      this.deps.log('warn', `[${id}] auto-compaction window rejected: ${errorMessage(e)}`);
    }
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
    // A cleared threshold is not a no-op: an engine that was handed a window has to be told.
    if (!active || !meta || active.tearingDown || active.uncertain) return;
    if (meta.mission && (active.turnPending || active.approvals.size || this.managedDispatches.has(id))) return;
    if (active.autoCompactionThreshold !== threshold) {
      active.autoCompactionThreshold = threshold;
      active.autoCompactionLatched = false;
      this.clearAutoCompactionRetry(active);
    }
    // Engines that compact themselves are configured, not asked. Requesting compaction from here
    // would also be the wrong moment for them: this runs at an idle boundary, and an idle engine has
    // nothing to compact, while the CLI reduces context from inside the turn that needs it.
    if (active.adapter.setAutoCompactionWindow) {
      const window = threshold ? autoCompactionTokenThreshold(threshold, meta.usage) : undefined;
      // A percentage whose context window is still unknown is not a clear: wait for the number.
      if (threshold && window === undefined) return;
      await this.syncNativeAutoCompaction(id, active, window);
      return;
    }
    if (!threshold) {
      active.autoCompactionLatched = false;
      this.clearAutoCompactionRetry(active);
      return;
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
      if (this.active.get(id) !== active || active.tearingDown) return;
      if (compacted === false) {
        active.autoCompactionLatched = false;
        active.autoCompactionRetryAt = Date.now() + AUTO_COMPACTION_RETRY_MS;
        this.scheduleAutoCompactionRetry(id, active);
        this.note(id, 'Automatic context compaction is waiting for more conversation history.');
      }
    } catch (e) {
      if (this.active.get(id) !== active || active.tearingDown) return;
      active.autoCompactionLatched = false;
      active.autoCompactionRetryAt = Date.now() + AUTO_COMPACTION_RETRY_MS;
      this.scheduleAutoCompactionRetry(id, active);
      const message = errorMessage(e);
      this.deps.log('warn', `[${id}] automatic compaction failed: ${message}`);
      this.note(id, `Automatic context compaction failed: ${message}`, 'warn');
    } finally {
      if (active.compactionInFlight === operation) {
        active.compactionInFlight = null;
        // Compaction-end info may precede RPC settlement. Notify through the same normalized
        // stream only after activity changes, or Mission's event-driven admission can strand.
        // A retired runtime must never wake or rewrite its replacement's status.
        if (meta.mission && this.active.get(id) === active && !active.tearingDown && !active.uncertain) this.emit(id, { type: 'status', status: meta.status });
      }
    }
  }

  async clearTranscript(id: string): Promise<void> {
    this.assertUnmanaged(id);
    if (!this.get(id)) throw new Error('Session not found');
    const active = this.active.get(id);
    if (active) {
      active.liveItems.clear();
      this.resetCheckpoints(active);
    }
    await this.deps.store.rewriteTranscript(id, []);
    this.deps.log('info', `[${id}] transcript cleared`);
  }

  async respondApproval(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    const active = this.active.get(sessionId);
    const d = active?.approvals.get(requestId);
    if (!active || !d) {
      // A stale card (the harness moved on, or the session stopped) is not an error, but it is worth knowing.
      this.deps.log('debug', `[${sessionId}] approval ${requestId} answered "${decision.optionId}" but is no longer pending`);
      return;
    }
    active.approvals.delete(requestId);
    d.resolve(decision);
    const item = active.liveItems.get(requestId);
    // Audit trail for what the user allowed the agent to do; the command itself is on the transcript card.
    this.deps.log('info', `[${sessionId}] approval ${requestId} → ${decision.optionId}${item && item.kind === 'approval' ? ` (${item.request.title.slice(0, 120)})` : ''}`);
    if (item && item.kind === 'approval') {
      item.decision = decision;
      item.decidedAt = Date.now();
      this.emit(sessionId, { type: 'item.upsert', item: { ...item } });
    }
    const meta = this.get(sessionId);
    if (meta && active.approvals.size === 0 && meta.status === 'awaiting') {
      meta.status = 'running';
      meta.statusDetail = undefined;
      this.pushSessions();
    }
    this.emit(sessionId, { type: 'approval.resolved', requestId, decision });
  }

  private requestApproval(sessionId: string, draft: ApprovalDraft): Promise<ApprovalDecision> {
    const active = this.active.get(sessionId);
    const meta = this.get(sessionId);
    if (!active || !meta || active.tearingDown) return Promise.resolve({ optionId: 'deny', note: 'Session gone' });
    const request: ApprovalRequest = { ...draft, id: shortId('ap_'), sessionId, harness: meta.config.harness, createdAt: Date.now() };
    const d = deferred<ApprovalDecision>();
    active.approvals.set(request.id, d);
    this.deps.log('info', `[${sessionId}] approval ${request.id} requested (${meta.config.permissionMode}): ${request.title.slice(0, 120)}`);
    meta.status = 'awaiting';
    meta.statusDetail = request.title;
    this.emit(sessionId, { type: 'item.upsert', item: { id: request.id, kind: 'approval', ts: Date.now(), request } });
    this.emit(sessionId, { type: 'approval.request', request });
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
      const models = enrichModelsFromProviders(event.models, settings.providers);
      event = { ...event, models: applyModelOverrides(models, settings.modelOverrides) };
    }
    const meta = this.get(sessionId);
    const active = this.active.get(sessionId);
    // Ownership/configuration are host-owned even if an adapter emits the broad normalized meta shape.
    if (meta?.mission && event.type === 'meta') {
      const patch = event.patch;
      const { activeModel, activeEffort, title, queued, statusDetail, harnessCommands } = patch;
      const allowed = { activeModel, activeEffort, title, queued, statusDetail, harnessCommands };
      event = { ...event, patch: Object.fromEntries(Object.entries(allowed).filter(([key]) => key in patch)) };
    }
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
        if (active && item.kind === 'assistant') {
          if (streaming) this.checkpointStream(sessionId, active, item);
          else active.checkpoints?.delete(item.id);
        }
        if (item.kind === 'turn' && active) active.turnPending = false;
        if (item.kind === 'turn' && meta) this.onTurnFinished(meta, item);
        if (item.kind === 'user' && meta && !meta.mission) this.deps.analytics.recordUserMessage(meta, item);
        if (item.kind === 'tool') {
          // Keep the model from the start of the call: a model switch before its terminal upsert
          // must not move the call to the newly selected model.
          const toolModels = active ? (active.toolModels ??= new Map()) : undefined;
          if (item.status === 'running' && meta?.activeModel && toolModels && !toolModels.has(item.id)) toolModels.set(item.id, meta.activeModel);
          if (item.status !== 'running') {
            const model = toolModels?.get(item.id);
            toolModels?.delete(item.id);
            this.deps.analytics.recordToolCall(sessionId, item, undefined, model);
          }
        }
        break;
      }
      case 'item.delta': {
        const item = active?.liveItems.get(event.id);
        if (item) {
          if (item.kind === 'assistant') {
            if (event.textDelta) item.text += event.textDelta;
            if (event.thinkingDelta) item.thinking = (item.thinking ?? '') + event.thinkingDelta;
            if (item.streaming) this.checkpointStream(sessionId, active!, item);
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
          // Only the transitions that end a harness get a line: idle/running flip every turn.
          if (event.status === 'stopped') this.deps.log('info', `[${sessionId}] harness stopped${event.detail ? `: ${event.detail}` : ''}`);
          else if (event.status === 'error') this.deps.log('warn', `[${sessionId}] harness reported an error status${event.detail ? `: ${event.detail}` : ''}`);
          if (event.status === 'idle' || event.status === 'stopped' || event.status === 'error') {
            if (active) {
              // A harness that exited will never finish its streaming answer; save what it said.
              void this.flushLive(sessionId, active, event.status === 'stopped').catch((e) => this.deps.log('warn', `[${sessionId}] live flush failed: ${errorMessage(e)}`));
              if (event.status === 'stopped') {
                // The harness exited on its own: pending approvals would hang forever and the
                // adapter must be disposed, mirroring the fatal-error path.
                void this.disposeRuntime(sessionId, active).catch((e) => this.deps.log('warn', `[${sessionId}] dispose after harness stop failed: ${errorMessage(e)}`));
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
            // A goal installed while another turn was in flight belongs to the next turn, not
            // the old reply. Wait for this idle boundary even if that turn was interrupted.
            const pending = active?.pendingGoalKickoff;
            if (!meta.mission && pending && meta.goal === pending.goal && meta.goal.status === 'active') {
              const prompt = pending.resume
                ? `Resuming the goal: ${pending.goal.objective}\nContinue where you left off.`
                : this.goalKickoffPrompt(pending.goal);
              this.scheduleGoalContinuation(sessionId, prompt, 0, pending);
            }
          }
        }
        break;
      }
      case 'usage':
        if (meta) {
          meta.usage = event.totals;
          this.deps.analytics.recordUsage(meta, event.totals, undefined, event.subagentCostByModel);
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
          // An engine that compacts itself needs its window before the turn grows, not after it ends.
          if (meta.status === 'idle' || active?.adapter.setAutoCompactionWindow) this.scheduleAutoCompaction(meta.id);
        }
        break;
      case 'subagent.run': {
        const previous = active?.nativeChildren.get(event.run.runId);
        if (active && (!previous || previous.startedAt === event.run.startedAt && previous.running)) {
          active.nativeChildren.set(event.run.runId, { startedAt: event.run.startedAt, running: event.run.status === 'running' });
        }
        break;
      }
      case 'subagent':
        if (meta) this.deps.analytics.recordSubagent(meta, event.completion);
        break;
      case 'meta':
        if (meta) {
          Object.assign(meta, event.patch);
          this.schedulePersist(meta);
          this.pushSessions();
        }
        break;
      case 'error':
        // The transcript card is the user's copy; this is the support copy, with the harness named.
        this.deps.log(event.fatal ? 'error' : 'warn', `[${sessionId}] ${meta?.config.harness ?? 'harness'} ${event.fatal ? 'fatal error' : 'error'}: ${event.message}`);
        if (meta) {
          meta.lastError = event.message;
          if (event.fatal) {
            meta.status = 'error';
            meta.statusDetail = event.message;
            meta.queued = 0;
            if (active) {
              // Tear the adapter down cleanly so no approval waits forever and streamed items are saved.
              void this.disposeRuntime(sessionId, active, 'error').catch((e) => this.deps.log('warn', `[${sessionId}] dispose after fatal error failed: ${errorMessage(e)}`));
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
    this.publish(sessionId, event);
  }

  /** Stamps a monotonic sequence onto every event this manager pushes and hands the same
   *  timestamped envelope to observers. `transcriptSnapshot` reports the counter these events
   *  count against, which is what makes a snapshot plus a live stream reconcilable for a remote
   *  client; the Mission hook needs the envelope for every event either way. */
  private publish(sessionId: string, event: SessionEvent): void {
    const env: SessionEventEnvelope = { sessionId, event, ts: Date.now(), seq: ++this.seq };
    this.deps.pushEvent(env);
    const listeners = [...this.listeners];
    if (this.get(sessionId)?.mission && this.missionHooks?.onEvent) listeners.push(this.missionHooks.onEvent);
    for (const listener of listeners) {
      try { listener(env); }
      catch (e) { this.deps.log('warn', `session event observer failed: ${errorMessage(e)}`); }
    }
  }

  /** Transcript appends must never reject into the void; log a warning instead. */
  private appendTranscript(sessionId: string, item: TranscriptItem): void {
    this.deps.store.appendTranscript(sessionId, item).catch((e) => this.deps.log('warn', `[${sessionId}] transcript append failed (${item.kind} ${item.id}): ${errorMessage(e)}`));
  }

  /**
   * Persists every live item changed since its last write. A streaming answer is skipped while its
   * harness may still finish it; with `settle` the harness is gone, so the partial answer is saved
   * as final and the renderer is told it stopped streaming.
   */
  private async flushLive(sessionId: string, active: ActiveSession, settle = false): Promise<void> {
    if (settle) this.resetCheckpoints(active);
    for (const id of [...active.dirty]) {
      const item = active.liveItems.get(id);
      if (!item) continue;
      const streaming = item.kind === 'assistant' && item.streaming;
      if (streaming && !settle) continue;
      const saved: TranscriptItem = streaming ? { ...item, streaming: false } : item;
      await this.deps.store.appendTranscript(sessionId, saved);
      active.dirty.delete(id);
      if (streaming) {
        active.liveItems.set(id, saved);
        this.publish(sessionId, { type: 'item.upsert', item: saved });
      }
    }
  }

  /**
   * Appends a copy of a streaming answer once it is due under STREAM_CHECKPOINT_MS and
   * STREAM_CHECKPOINT_GROWTH, so a crash mid-response leaves the partial text on disk. An item
   * that has grown enough but was written too recently is picked up by a timer, so a stream that
   * goes quiet is still saved; one that has not grown enough waits for its next delta.
   */
  private checkpointStream(sessionId: string, active: ActiveSession, item: Extract<TranscriptItem, { kind: 'assistant' }>): void {
    const checkpoints = (active.checkpoints ??= new Map());
    const now = Date.now();
    const size = item.text.length + (item.thinking?.length ?? 0);
    const last = checkpoints.get(item.id);
    // The first sighting starts the clock; nothing is worth saving before the first interval.
    if (!last) {
      checkpoints.set(item.id, { at: now, size: 0 });
      if (size > 0) this.scheduleCheckpoint(sessionId, active, STREAM_CHECKPOINT_MS);
      return;
    }
    if (size - last.size < Math.max(1, Math.ceil(last.size * STREAM_CHECKPOINT_GROWTH))) return;
    const wait = last.at + STREAM_CHECKPOINT_MS - now;
    if (wait > 0) {
      this.scheduleCheckpoint(sessionId, active, wait);
      return;
    }
    checkpoints.set(item.id, { at: now, size });
    // Copied: the live item keeps mutating while the append waits its turn in the write queue.
    this.appendTranscript(sessionId, { ...item });
  }

  private scheduleCheckpoint(sessionId: string, active: ActiveSession, wait: number): void {
    if (active.checkpointTimer) return;
    active.checkpointTimer = setTimeout(() => {
      active.checkpointTimer = null;
      if (this.active.get(sessionId) !== active) return;
      for (const id of [...(active.checkpoints?.keys() ?? [])]) {
        const item = active.liveItems.get(id);
        if (item?.kind === 'assistant' && item.streaming) this.checkpointStream(sessionId, active, item);
        else active.checkpoints.delete(id);
      }
    }, wait);
    active.checkpointTimer.unref?.();
  }

  private resetCheckpoints(active: ActiveSession): void {
    if (active.checkpointTimer) clearTimeout(active.checkpointTimer);
    active.checkpointTimer = null;
    active.checkpoints?.clear();
  }

  private onTurnFinished(meta: SessionMeta, turn: Extract<TranscriptItem, { kind: 'turn' }>): void {
    this.deps.analytics.recordTurn(meta, turn);
    // One line per turn is the timeline a slow or expensive session is diagnosed from.
    this.deps.log(
      turn.status === 'failed' ? 'warn' : 'info',
      `[${meta.id}] turn ${turn.status}${turn.durationMs !== undefined ? ` in ${(turn.durationMs / 1000).toFixed(1)}s` : ''}${turn.usage ? ` (${turn.usage.inputTokens} in / ${turn.usage.outputTokens} out)` : ''}${turn.costUsd ? ` $${turn.costUsd.toFixed(4)}` : ''}${turn.error ? `: ${turn.error}` : ''}`
    );
    const active = this.active.get(meta.id);
    if (this.settings().notifications && turn.status !== 'interrupted' && (!meta.mission || turn.status !== 'completed')) {
      this.deps.notify(meta.id, meta.title, turn.status === 'completed' ? 'Turn finished' : `Turn ${turn.status}${turn.error ? `: ${turn.error}` : ''}`);
    }
    // An answer belongs to one turn only. In particular, a pre-goal answer must not be
    // mistaken for the next kickoff's answer if that turn produces no assistant text.
    const text = active?.lastAssistantText ?? '';
    if (active) active.lastAssistantText = '';
    if (meta.mission) return;
    const goal = meta.goal;
    if (!goal || goal.status !== 'active' || !active) return;
    // This reply began before the new goal was submitted. Its token (or lack of one) says
    // nothing about that goal; the idle transition will deliver the kickoff separately.
    if (active.pendingGoalKickoff?.goal === goal) return;
    if (turn.status !== 'completed') return;
    if (text.includes(GOAL_COMPLETE_TOKEN)) {
      goal.status = 'complete';
      goal.updatedAt = Date.now();
      this.deps.log('info', `[${meta.id}] goal complete after ${goal.iterations} continuation(s)`);
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
      this.deps.log('info', `[${meta.id}] goal paused at the ${goal.maxIterations}-iteration guard`);
      this.schedulePersist(meta);
      this.pushSessions();
      this.emit(meta.id, { type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level: 'warn', text: `Goal paused: reached the ${goal.maxIterations}-iteration guard. Resume it from the Goal panel.` } });
      return;
    }
    goal.iterations += 1;
    goal.updatedAt = Date.now();
    this.deps.log('info', `[${meta.id}] goal continuation ${goal.iterations}/${goal.maxIterations} scheduled`);
    this.schedulePersist(meta);
    const prompt = `Goal check-in ${goal.iterations}/${goal.maxIterations}. The active goal is:\n\n${goal.objective}\n\nReview what has been done so far, verify against real evidence, and continue working toward the goal. If it is now fully achieved, end your reply with the exact token ${GOAL_COMPLETE_TOKEN} on its own line after a brief completion audit. Otherwise keep going without asking for permission to continue.`;
    this.scheduleGoalContinuation(meta.id, prompt);
  }

  /**
   * Deliver a goal's auto-continuation on the first free moment. A compaction started by the turn
   * that just ended holds the session for minutes; dropping the continuation there ended autonomous
   * runs silently, so a busy session is waited out instead. Each attempt re-reads the session, and
   * a newer turn's continuation replaces this one rather than racing it.
   */
  private scheduleGoalContinuation(id: string, prompt: string, attempt = 0, pending?: ActiveSession['pendingGoalKickoff']): void {
    const active = this.active.get(id);
    if (!active || this.get(id)?.mission) return;
    const expectedGoal = pending?.goal ?? this.get(id)?.goal;
    if (attempt === 0 && active.goalContinuationTimer) {
      clearTimeout(active.goalContinuationTimer);
      active.goalContinuationTimer = null;
    }
    const timer = setTimeout(() => {
      active.goalContinuationTimer = null;
      if (this.active.get(id) !== active) return;
      const meta = this.get(id);
      if (!meta || meta.mission || meta.goal !== expectedGoal || meta.goal?.status !== 'active') return;
      if (pending && active.pendingGoalKickoff !== pending) return;
      // A normal continuation belongs to the turn behind an approval. A new goal's kickoff,
      // however, must survive that turn, even if it pauses for approval in the meantime.
      if (meta.status === 'awaiting' && !pending) return;
      if (meta.status === 'running' || meta.status === 'starting' || meta.status === 'awaiting' || active.adapter.busy) {
        if (attempt + 1 >= GOAL_CONTINUATION_MAX_ATTEMPTS) {
          this.deps.log('warn', `[${id}] goal continuation gave up after ${attempt + 1} attempts with the session busy`);
          return;
        }
        this.scheduleGoalContinuation(id, prompt, attempt + 1, pending);
        return;
      }
      if (pending) active.pendingGoalKickoff = null;
      void this.sendAs(id, { text: prompt }, 'goal').catch((e) => this.deps.log('warn', `[${id}] goal continue failed: ${errorMessage(e)}`));
    }, attempt === 0 ? 1500 : GOAL_CONTINUATION_RETRY_MS);
    timer.unref?.();
    active.goalContinuationTimer = timer;
  }

  async goal(id: string, action: 'set' | 'pause' | 'resume' | 'clear' | 'complete' | 'update', opts: { objective?: string; autoContinue?: boolean; maxIterations?: number }): Promise<SessionMeta> {
    this.assertUnmanaged(id);
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    const s = this.settings();
    const active = this.active.get(id);
    if (action !== 'update' && active) {
      // Replacing, pausing or clearing a goal invalidates its pending kickoff/continuation.
      if (active.goalContinuationTimer) clearTimeout(active.goalContinuationTimer);
      active.goalContinuationTimer = null;
      active.pendingGoalKickoff = null;
    }
    this.deps.log('info', `[${id}] goal ${action}${opts.maxIterations !== undefined ? ` maxIterations=${opts.maxIterations}` : ''}${opts.autoContinue !== undefined ? ` autoContinue=${opts.autoContinue}` : ''}`);
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
        this.startGoal(id, meta, false);

        break;
      }
      case 'pause':
        if (meta.goal) meta.goal.status = 'paused';
        break;
      case 'resume':
        if (meta.goal) {
          meta.goal.status = 'active';
          this.startGoal(id, meta, true);
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

  /** Kick off now if free; otherwise reserve the first idle boundary after the current turn. */
  private startGoal(id: string, meta: SessionMeta, resume: boolean): void {
    if (meta.mission) return;
    const goal = meta.goal!;
    const prompt = resume ? `Resuming the goal: ${goal.objective}\nContinue where you left off.` : this.goalKickoffPrompt(goal);
    const active = this.active.get(id);
    if (active && (meta.status === 'running' || meta.status === 'awaiting' || meta.status === 'starting' || active.adapter.busy)) {
      active.pendingGoalKickoff = { goal, resume };
      // A busy adapter can be compacting while metadata is idle, without another status event.
      if (meta.status === 'idle') this.scheduleGoalContinuation(id, prompt, 0, active.pendingGoalKickoff);
    } else {
      void this.sendAs(id, { text: prompt }, 'goal').catch((e) => this.emit(id, { type: 'error', message: errorMessage(e) }));
    }
  }

  /**
   * `/goal` belongs to the harness when it has a goal command of its own. The list the adapter reports
   * is authoritative; before a harness has started (it starts on the first send, so a brand-new session
   * has no list yet) a `goal` skill on disk stands in for it — Claude only, and only when the CLI is
   * configured to load `~/.claude` at all.
   */
  private async resolveNativeGoal(meta: SessionMeta): Promise<string | null> {
    if (meta.mission) return null;
    return this.harnessGoal(meta.config.harness, meta.harnessCommands);
  }

  /** The same rule keyed by harness alone, for a session that does not exist yet (`create()`). */
  private async harnessGoal(harness: HarnessId, advertised?: string[]): Promise<string | null> {
    const preferHarness = this.settings().goalDefaults.preferHarness;
    const installed = preferHarness && !advertised?.length ? await this.harnessGoalInstalled(harness) : false;
    return nativeGoalCommand({ preferHarness, advertised, installed });
  }

  private async harnessGoalInstalled(harness: HarnessId): Promise<boolean> {
    if (harness !== 'claude') return false;
    // Without 'user' in settingSources the CLI never reads ~/.claude, so its skills cannot answer /goal.
    if (!this.settings().claude.settingSources.includes('user')) return false;
    return skillInstalled('claude', 'goal');
  }

  /** Applies the driver to one session; true when it changed. */
  private async applyGoalDriver(meta: SessionMeta, current = () => true): Promise<boolean> {
    if (meta.mission) {
      if (!current()) return false;
      const changed = !!(meta.nativeGoal || meta.goal);
      meta.nativeGoal = undefined;
      meta.goal = undefined;
      const active = this.active.get(meta.id);
      if (active?.goalContinuationTimer) clearTimeout(active.goalContinuationTimer);
      if (active) { active.goalContinuationTimer = null; active.pendingGoalKickoff = null; }
      return changed;
    }
    const next = await this.resolveNativeGoal(meta);
    if (!current()) return false;
    if (next ? meta.nativeGoal === next : meta.nativeGoal === undefined) return false;
    if (next) meta.nativeGoal = next;
    else delete meta.nativeGoal;
    return true;
  }

  /** Recomputes `/goal` ownership everywhere: the preference is app-wide and the advertised lists are per harness. */
  async refreshGoalDrivers(): Promise<void> {
    let changed = false;
    for (const meta of this.deps.store.list()) {
      if (await this.applyGoalDriver(meta)) {
        this.schedulePersist(meta);
        changed = true;
      }
    }
    if (changed) this.pushSessions();
  }

  /**
   * Relocates a session to another directory (worktree switch). A running harness is stopped;
   * provider resume state is tied to the old directory, so it is dropped (the app transcript stays).
   */
  async moveTo(id: string, cwd: string): Promise<SessionMeta> {
    this.assertUnmanaged(id);
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    if (!path.isAbsolute(cwd)) throw new Error('Worktree path must be absolute');
    if (path.resolve(meta.cwd) === path.resolve(cwd)) return meta;
    const wasRunning = !!this.active.get(id);
    if (wasRunning || meta.workspaceWriterClaims?.length) await this.stop(id);
    this.deps.log('info', `[${id}] session moved ${meta.cwd} → ${cwd}${wasRunning ? ' (harness was running; provider resume state dropped)' : ''}`);
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
    this.assertUnmanaged(id);
    const src = this.get(id);
    if (!src) return null;
    const items = await this.transcript(id);
    const nid = shortId('s_');
    const cross = !!harness && harness !== src.config.harness;
    const target = cross ? harness! : src.config.harness;
    const title = cross ? `${src.title} (fork → ${HARNESS_BY_ID[target].name})` : `${src.title} (fork)`;
    // A fork of a worktree session gets a worktree — and a branch — of its own. Sharing the source's
    // directory used to be the whole fork: archiving the source with its worktree removed deleted the
    // folder the fork was running in. The new branch starts at the source checkout's HEAD, so
    // committed work carries over; uncommitted changes stay in the source worktree.
    const own = await this.forkWorktree(src, title);
    const meta: SessionMeta = {
      ...structuredClone(src),
      id: nid,
      title,
      // The fork suffix names which session this came from; a title model would drop that.
      titleIsPlaceholder: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'idle',
      statusDetail: undefined,
      queued: 0,
      // A fork carries the conversation, not the ledger. The source's totals describe work this
      // session did not do, and inheriting them charges the same dollars to two sessions — which
      // the dashboard then adds up twice. Its own counters start at zero; the copied rows below
      // keep their text and tokens for context but are worth nothing.
      usage: emptyUsage(),
      forkedFrom: src.id,
      harnessRef: {},
      pendingForkContext: undefined,
      pendingKnowledgeDigest: undefined,
      goal: undefined,
      // A fresh fork starts unpinned and active, never in the archive.
      pinned: undefined,
      pinnedAt: undefined,
      archived: undefined,
      // Writer claims belong to the source's runtimes; a fork has run nothing yet.
      workspaceWriterClaims: undefined,
      cwd: own?.path ?? src.cwd,
      // Only a worktree this fork created is the fork's to remove. When it shares the source's
      // directory it owns no worktree: claiming the source's would make archiving the fork delete it.
      worktreeBranch: own?.branch
    };
    if (cross) {
      // A different harness cannot resume the source's provider session: it starts fresh in the
      // fork's own worktree. The copied transcript is carried over for reference only.
      const s = this.settings();
      meta.config = {
        ...src.config,
        harness: target,
        model: s.defaultModelByHarness[target],
        acpAgent: undefined,
        codexModelProvider: undefined,
        useWorktree: !!own
      };
      meta.activeModel = meta.config.model;
      meta.activeEffort = undefined;
    } else {
      // A provider session id belongs to the directory it ran in, so a fork that moved to its own
      // worktree cannot resume the source's session. Same-harness forks that stayed in the source
      // directory keep the provider state.
      if (!own && src.config.harness === 'claude' && src.harnessRef.claudeSessionId) meta.harnessRef = { claudeSessionId: src.harnessRef.claudeSessionId, forkOnResume: true } as HarnessRef;
      if (src.config.harness === 'native') {
        const hist = await this.deps.store.readNativeHistory(id);
        if (hist) await this.deps.store.writeNativeHistory(nid, hist);
        meta.harnessRef = { nativeHistory: true };
      }
    }
    // The fork keeps the project's digest (same project) but hands it over the way
    // its own harness can: in the system prompt, or on the first message.
    if (meta.knowledgeDigest && !HARNESS_BY_ID[meta.config.harness].capabilities.systemPrompt) meta.pendingKnowledgeDigest = true;
    const keep = items.filter((i) => !(i.kind === 'approval' && !i.decision)).map(carriedItem);
    // A same-harness fork that lost the source directory also lost the provider session it would
    // have resumed; both it and a fork into another harness start from the conversation as text.
    const lostResume = !cross && !!own && src.config.harness === 'claude' && !!src.harnessRef.claudeSessionId;
    if (cross || lostResume) {
      // Hand the prior conversation over as plain text: the first message in the fork carries it
      // and then the flag is cleared.
      await this.deps.store.writeBlob(nid, FORK_CONTEXT_FILE, renderForkContext(keep, src.config.harness, target));
      meta.pendingForkContext = true;
      keep.push({
        id: shortId('i_'),
        kind: 'info',
        ts: Date.now(),
        level: 'info',
        text: forkNote(src, target, own, cross)
      });
    }
    await this.deps.store.upsert(meta);
    await this.deps.store.rewriteTranscript(nid, keep);
    this.deps.log('info', `[${nid}] forked from ${id}${cross ? ` (${src.config.harness} → ${target})` : ''}; ${keep.length} transcript item(s) carried over${own ? `; worktree ${own.branch} at ${own.path}` : '; sharing the source directory'}`);
    this.pushSessions();
    return meta;
  }

  /**
   * The worktree a fork runs in, when its source had one. Returns null for a source that was never
   * isolated, and for one whose new worktree could not be created — a fork that runs in the
   * source's directory is better than no fork, and the archive risk is only the old one.
   */
  private async forkWorktree(src: SessionMeta, title: string): Promise<{ path: string; branch: string } | null> {
    if (!src.worktreeBranch) return null;
    try {
      return await createForkWorktree(src.config.projectRoot, slugify(title), { cwd: src.cwd, branch: src.worktreeBranch });
    } catch (e) {
      this.deps.log('warn', `fork: could not create a worktree from ${src.cwd}: ${errorMessage(e)} — the fork shares the source directory`);
      return null;
    }
  }

  async exportMarkdown(id: string): Promise<string> {
    const meta = this.get(id);
    const items = await this.transcript(id);
    const lines: string[] = [`# ${meta?.title ?? 'Session'}`, '', `- Harness: ${meta?.config.harness}`, `- Model: ${describeModel(meta?.activeModel)}`, `- Directory: ${meta?.cwd}`, `- Cost: $${(meta?.usage.costUsd ?? 0).toFixed(4)}`, ''];
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

/**
 * The transcript row that says where a fork landed and why the conversation above is being trusted:
 * a fork with its own worktree gets its own branch, one that stayed behind shares the source's
 * directory and claims no worktree of its own.
 */
function forkNote(src: SessionMeta, target: HarnessId, own: { path: string; branch: string } | null, cross: boolean): string {
  const from = HARNESS_BY_ID[src.config.harness].name;
  const intro = cross ? `Forked from ${from} into ${HARNESS_BY_ID[target].name}` : 'Forked';
  const where = own
    ? `onto a new worktree (branch ${own.branch}, from ${src.worktreeBranch})`
    : `in the same directory${src.worktreeBranch ? ` (branch ${src.worktreeBranch})` : ''}`;
  return `${intro} ${where}. The conversation above is handed over as context on your next message.`;
}

/**
 * One transcript row the source session hands to its fork. The row is the fork's context, not its
 * record: everything it describes happened in the session it came from, under that session's
 * counters. Text, tool calls and tokens stay — they are what the new harness can see — but a turn's
 * dollars do not, because the session that spent them already reports them.
 */
function carriedItem(item: TranscriptItem): TranscriptItem {
  return item.kind === 'turn' ? { ...item, costUsd: 0, carried: true } : item;
}

/** `provider/model` for log lines, or 'default' when the harness picks. */
function describeModel(model: ModelRef | undefined): string {
  return model ? modelName(model.provider, model.model) : 'default';
}

/** Which provider-side session a harness will try to resume, or '' for a fresh start. */
function describeResume(ref: HarnessRef): string {
  if (ref.claudeSessionId) return `claude:${ref.claudeSessionId}${ref.forkOnResume ? ' (fork)' : ''}`;
  if (ref.codexThreadId) return `codex:${ref.codexThreadId}`;
  if (ref.piSessionFile) return `pi:${path.basename(ref.piSessionFile)}`;
  if (ref.acpSessionId) return `acp:${ref.acpSessionId}`;
  if (ref.cursorAgentId) return `cursor:${ref.cursorAgentId}`;
  if (ref.nativeHistory) return 'native:history';
  return '';
}

/** `, 12.3 tok/s` for the markdown export, or '' when the turn has no speed sample. */
function speedLabel(turn: Extract<TranscriptItem, { kind: 'turn' }>): string {
  const tps = tokensPerSecond(turnSpeed(turn) ?? undefined);
  return tps ? `, ${tps.toFixed(1)} tok/s` : '';
}
