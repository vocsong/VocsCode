/** Owns sessions: transcripts, approvals, goals, worktrees, and resuming a session after a restart. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  ApprovalDecision,
  ApprovalRequest,
  AppSettings,
  CreateSessionRequest,
  EffortLevel,
  HarnessId,
  HarnessRef,
  ModelRef,
  PermissionMode,
  SessionConfig,
  SessionEvent,
  SessionEventEnvelope,
  SessionMeta,
  TranscriptItem,
  UserInput
} from '../shared/types';
import { branchNameFromText, branchSlug, normalizeBranchPrefix } from '../shared/branch-prefix';
import { fastModeSupport } from '../shared/fast-mode';
import { HARNESS_BY_ID, assertPermissionModeOffered, closestPermissionMode } from '../shared/harness-meta';
import { hasOngoingWork } from '../shared/ongoing';
import { validateQuestionResponse } from '../shared/question-response';
import { isSharedSkillCommand, parseSharedSkillCommand, sharedSkillSupported, type SharedSkillReceipt } from '../shared/shared-skills';
import { createAdapter } from './harness/registry';
import { ownedAdapter } from './process-context';
import { renderForkContext } from './fork-context';
import { promptWithFiles, retainMessageFiles } from './message-files';
import { builtinServerIds, resolveForSession } from './mcp';
import type { ApprovalDraft, HarnessContext } from './harness/types';
import type { ApprovalMissionRoute, MissionMessageMeta, SessionMission } from '../shared/mission-mode';
import { createWorktree, gitRoot, gitWorktrees, removeWorktree, restoreWorktree, slugify, worktreeAddForBranch, worktreeInfo, type PrRef } from './git';
import { isValidRunId, listSubagentRuns, readSubagentRun } from './subagents';
import { subagentSupport, type AgentTypeInfo, type SubagentRun, type SubagentRunSummary } from '../shared/subagents';
import { emptyUsage, enrichModelsFromProviders } from './models/static-models';
import { applyModelOverrides } from '../shared/model-overrides';
import { deferred, errorMessage, shortId } from './util/async';
import { readJson, writeJson } from './util/fs';
import { generateBranchName, generateSessionTitle, titleFromPrompt } from './session-title';
import type { ParsedChatImport } from './chat-import';
import { representsChatImport } from './chat-import-identity';
import { SessionCompactionController } from './session-compaction';
import { carriedItem, exportSessionMarkdown, forkSession } from './session-fork';
import { SessionGitStateController } from './session-git-state';
import { SessionGoalController, type GoalAction, type GoalActionOpts } from './session-goal';
import { SessionStreamController } from './session-stream';
import {
  describeModel,
  describeResume,
  FORK_CONTEXT_FILE,
  isPlaceholderTitle,
  measureUserInput,
  missionLive,
  type ActiveSession,
  type ControlledTurn,
  type ControlledTurnResult,
  type SessionActivity,
  type SessionManagerDeps
} from './session-types';

export { titleFromPrompt };
export type { ControlledTurnResult, SessionActivity, SessionManagerDeps };

/** How stale a session's `lastViewedAt` may get before viewing it again rewrites the stamp. */
const VIEW_STAMP_REFRESH_MS = 5 * 60_000;

/** An ordinary Stop gives a disposing adapter this long (above every adapter's own shutdown
 * deadline) before the session is released anyway; the disposal itself carries on regardless. */
const ORDINARY_DISPOSE_WAIT_MS = 20_000;

/** A controlled turn's authorization was withdrawn before its runtime started: not a harness fault. */
class ControlledStartRefused extends Error {}

const SHARED_SKILL_RUNTIME_ERROR = 'The harness reported an error during the Shared skill turn.';

/** Internal only: never read the payload or authority for a Shared turn from a generic UserInput. */
interface SharedSkillAdmission {
  assertCurrent(): void;
  beforeSend(): Promise<void>;
  record(active: ActiveSession): void;
}

/** Title calls per session per run: one on the first message, one more if that one came back empty. */
const MAX_TITLE_ATTEMPTS = 2;

export class SessionManager {
  private active = new Map<string, ActiveSession>();
  /** Reserved synchronously, including preparation and the terminal persistence barrier. */
  private controlled = new Map<string, ControlledTurn>();
  private controlledCreations = new Map<string, { hash: string; promise: Promise<SessionMeta> }>();
  /** A controlled runtime is never reused: late events cannot become another operation's reply. */
  private fencedRuntimes = new WeakSet<ActiveSession>();
  /** Serialize imports so concurrent requests cannot publish the same source conversation twice. */
  private importQueue: Promise<void> = Promise.resolve();
  /** No turn or second settings change may race a premium-speed transition. */
  private fastModeUpdates = new Set<string>();
  /** Hold turn admission while Antigravity acknowledges and persists a permission change. */
  private antigravityModeUpdates = new Set<string>();
  /** Reserve send-first dispatches before startup/preamble awaits expose an idle gap. */
  private configDispatches = new Map<string, number>();
  /** Occupies ordinary admission even before an idle runtime has been started. */
  private sharedSkillAdmissions = new Map<string, { canceled: boolean }>();
  /** Blocks turn admission and ordinary edits during the checked housekeeping commit. */
  private housekeepArchives = new Set<string>();
  /** Last runtime created per session. An ordinary runtime is fenced only once a newer one exists. */
  private runtimeSeq = new Map<string, number>();
  /** Ordinary runtimes still disposing after Stop released their session. Controlled turns only:
   * they never block the session itself. */
  private retiring = new Map<string, Set<ActiveSession>>();
  private listeners = new Set<(env: SessionEventEnvelope) => void>();
  private persistTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Title calls made for a session this run. A failed call leaves the placeholder, so the next
   * message retries with more context — but an unattended goal session sends many messages, and
   * none of them should pay for a title model that is not answering.
   */
  private titleAttempts = new Map<string, number>();
  /** The latest title request for each session; a newer completed turn supersedes it. */
  private titleInFlight = new Map<string, symbol>();
  /** Event sequence, monotonic for the lifetime of this manager; see `publish`. */
  private seq = 0;

  private readonly gitState: SessionGitStateController;
  private readonly compaction: SessionCompactionController;
  private readonly goals: SessionGoalController;
  private readonly stream: SessionStreamController;

  constructor(private readonly deps: SessionManagerDeps) {
    this.gitState = new SessionGitStateController({
      listSessions: () => this.deps.store.list(),
      getSession: (id) => this.get(id),
      getActive: (id) => this.active.get(id),
      sessionDir: (id) => this.deps.store.sessionDir(id),
      sessionPrRefs: (id, opts) => this.sessionPrRefs(id, opts),
      mission: () => this.deps.mission?.(),
      schedulePersist: (meta) => this.schedulePersist(meta),
      pushSessions: () => this.pushSessions(),
      log: (level, message) => this.deps.log(level, message)
    });
    this.compaction = new SessionCompactionController({
      assertNotControlled: (id) => this.assertNotControlled(id),
      isControlled: (id) => this.controlled.has(id),
      getActive: (id) => this.active.get(id),
      getSession: (id) => this.get(id),
      settings: () => this.settings(),
      note: (id, text, level) => this.note(id, text, level),
      log: (level, message) => this.deps.log(level, message)
    });
    this.goals = new SessionGoalController({
      listSessions: () => this.deps.store.list(),
      getSession: (id) => this.get(id),
      getActive: (id) => this.active.get(id),
      isControlled: (id) => this.controlled.has(id),
      settings: () => this.settings(),
      upsertSession: (meta) => this.deps.store.upsert(meta),
      schedulePersist: (meta) => this.schedulePersist(meta),
      pushSessions: () => this.pushSessions(),
      emit: (sessionId, event) => this.emit(sessionId, event),
      sendGoalPrompt: (sessionId, input) => this.sendAs(sessionId, input, 'goal'),
      notify: (sessionId, title, body) => this.deps.notify(sessionId, title, body),
      log: (level, message) => this.deps.log(level, message)
    });
    this.stream = new SessionStreamController({
      getActive: (id) => this.active.get(id),
      getSession: (id) => this.get(id),
      isControlled: (id) => this.controlled.has(id),
      isViewing: (id) => this.deps.isViewing?.(id) ?? false,
      settings: () => this.settings(),
      appendTranscript: (sessionId, item) => this.appendTranscript(sessionId, item),
      writeTranscriptItem: (sessionId, item) => this.trackControlledWrite(sessionId, this.deps.store.appendTranscript(sessionId, item)),
      publish: (sessionId, event) => this.publish(sessionId, event),
      schedulePersist: (meta) => this.schedulePersist(meta),
      pushSessions: () => this.pushSessions(),
      notify: (sessionId, title, body) => this.deps.notify(sessionId, title, body),
      advanceGoalContinuation: (meta, active) => this.goals.advanceContinuation(meta, active)
    });
  }

  list({ refreshGit = true }: { refreshGit?: boolean } = {}): SessionMeta[] {
    const list = this.deps.store.list();
    if (!refreshGit) return list;
    this.gitState.scheduleRestoredChecks(list);
    return list;
  }

  get(id: string): SessionMeta | undefined {
    return this.deps.store.get(id);
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
    const state = {
      active: !!active || retiring,
      starting: !!active?.starting && active.startupDispatched,
      turn: !!(active?.turnPending || (active?.adapter.busy && !active.compactionInFlight)),
      tools: active ? [...active.liveItems.values()].filter((item) => item.kind === 'tool' && item.status === 'running').length : 0,
      nativeChildren: active ? [...active.nativeChildren.values()].filter((child) => child.running).length : 0,
      processes: writers === 'active',
      approvals: active?.approvals.size ?? 0,
      compacting: !!active?.compactionInFlight,
      queued: (this.get(id)?.queued ?? 0) + (this.controlled.has(id) ? 1 : 0),
      tearingDown: !!active?.tearingDown || retiring,
      uncertain: !!active?.uncertain || writers === 'unknown',
    };
    return { ...state, quiescent: !state.starting && !state.turn && !state.tools && !state.nativeChildren && !state.processes && !state.approvals && !state.compacting && !state.queued && !state.tearingDown && !state.uncertain };
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
        if (this.deps.store.get(meta.id)) this.trackControlledWrite(meta.id, Promise.resolve(this.deps.store.upsert(meta))).catch((e) => this.deps.log('warn', `meta persist failed: ${errorMessage(e)}`));
      }, 300)
    );
  }

  private cancelPersist(id: string): void {
    const t = this.persistTimers.get(id);
    if (t) clearTimeout(t);
    this.persistTimers.delete(id);
  }

  /** Sessions whose restored git state was re-checked once after boot. */
  private get gitStateChecked(): Set<string> {
    return this.gitState.checked;
  }

  /** Re-runs the PR/merge state check after a local /pr or /merge completes outside a turn. */
  refreshGitState(id: string): void {
    this.gitState.refresh(id);
  }

  /** Appends a persistent info line to a session's transcript (renderer-visible, survives restart). */
  note(id: string, text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.emit(id, { type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level, text } });
  }

  /** PRs this session itself referenced in its transcript (stat-cached per file revision). */
  sessionPrRefs(id: string, opts?: { latestOnly?: boolean }): Promise<PrRef[]> {
    return this.gitState.sessionPrRefs(id, opts);
  }

  /** Git roots of other sessions' repos (cached per cwd), for resolving foreign-repo PRs. */
  knownRepoRoots(excludeId: string): Promise<string[]> {
    return this.gitState.knownRepoRoots(excludeId);
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

  async importChats(chats: ParsedChatImport[], options: { repairOnly?: boolean } = {}): Promise<{ imported: SessionMeta[]; skipped: number }> {
    const run = this.importQueue.then(async () => {
      const imported: SessionMeta[] = [];
      const roots = new Set<string>();
      let skipped = 0;
      let importFailed = false;
      try {
        for (const { candidate, items } of chats) {
          const existing = this.deps.store.list().find((session) => representsChatImport(session, candidate));
          if (existing) {
            // A previous batch may have saved the session but failed to register its project.
            if (existing.config?.projectRoot) roots.add(existing.config.projectRoot);
            skipped++;
            continue;
          }
          // Repair must never recreate a chat deleted since its preview was shown.
          if (options.repairOnly) throw new Error('This conversation is no longer in Vocs Code. Scan again before repairing registration.');
          const id = `import_${createHash('sha256').update(`${candidate.source}\0${candidate.sourceSessionId}`).digest('hex').slice(0, 32)}`;
          if (this.deps.store.get(id)) throw new Error('Imported session identifier is already in use');
          const harness = candidate.source;
          const model = this.settings().defaultModelByHarness[harness];
          const meta: SessionMeta = {
            id,
            importedFrom: { source: candidate.source, sessionId: candidate.sourceSessionId },
            title: candidate.title,
            createdAt: candidate.createdAt,
            updatedAt: candidate.updatedAt,
            lastUserMessageAt: items.filter((item) => item.kind === 'user').at(-1)?.ts,
            config: { harness, projectRoot: candidate.projectRoot, permissionMode: 'ask', useWorktree: false, model },
            cwd: candidate.projectRoot,
            status: 'idle',
            queued: 0,
            harnessRef: {},
            usage: emptyUsage(),
            activeModel: model,
            pendingForkContext: true,
            ...(!HARNESS_BY_ID[harness].capabilities.systemPrompt ? { pendingAppInstructions: true } : {})
          };
          await this.deps.store.importSession(meta, items, renderForkContext(items, harness, harness));
          imported.push(meta);
          roots.add(meta.config.projectRoot);
        }
        return { imported, skipped };
      } catch (error) {
        importFailed = true;
        throw error;
      } finally {
        try {
          if (roots.size) {
            const settings = this.settings();
            const folders = [...new Set([...settings.folders, ...roots])];
            const recentProjects = [...new Set([...roots, ...settings.recentProjects])].slice(0, 12);
            if (!isDeepStrictEqual(folders, settings.folders) || !isDeepStrictEqual(recentProjects, settings.recentProjects)) {
              await this.deps.settings.update({ folders, recentProjects });
            }
          }
        } catch (error) {
          // Preserve the original import error; a retry still repairs registration for committed rows.
          if (!importFailed) throw error;
          this.deps.log('warn', `Imported project registration failed: ${errorMessage(error)}`);
        } finally {
          if (imported.length) this.pushSessions();
        }
      }
    });
    this.importQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async create(req: CreateSessionRequest): Promise<SessionMeta> {
    return this.createWithId(req, shortId('s_'));
  }

  /** Host-only identity, allocated before worktree effects. The journal owns crash reconciliation;
   * an absent session after a crash is not permission to replay an uncertain creation. A worktree is
   * created only with every write confined to `confineTo`, the enrolled project. */
  async createControlled(req: CreateSessionRequest, operationId: string, confineTo: string): Promise<SessionMeta> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)) throw new Error('Invalid control operation ID');
    if (req.initialPrompt !== undefined || req.initialImages !== undefined || req.initialFiles !== undefined || req.goal !== undefined) throw new Error('Controlled creation cannot dispatch initial input or goals');
    operationId = operationId.toLowerCase();
    const id = `s_control_${operationId.replaceAll('-', '')}`;
    const request = structuredClone(req);
    const canonical = JSON.stringify(request, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
    const requestHash = createHash('sha256').update(canonical).digest('hex');
    const pending = this.controlledCreations.get(id);
    if (pending && pending.hash !== requestHash) throw new Error('Control creation payload conflicts with this operation');
    const existing = this.get(id);
    if (existing) {
      if (existing.controlCreation?.operationId !== operationId || existing.controlCreation.requestHash !== requestHash) throw new Error('Control creation identity conflicts with an existing session');
      await this.deps.store.upsert(existing);
      return existing;
    }
    if (pending) return pending.promise;
    const promise = Promise.resolve().then(() => this.createWithId(request, id, { operationId, requestHash }, confineTo));
    // Keep a failed attempt too: it may have created a worktree before the session write failed.
    this.controlledCreations.set(id, { hash: requestHash, promise });
    return promise;
  }

  private async createWithId(req: CreateSessionRequest, id: string, controlCreation?: SessionMeta['controlCreation'], confineTo?: string): Promise<SessionMeta> {
    if (req.config.fastMode !== undefined && typeof req.config.fastMode !== 'boolean') throw new Error('Fast mode must be a boolean');
    const settings = this.settings();
    let cfg = { ...req.config, fastMode: req.config.fastMode === true };
    if (!HARNESS_BY_ID[cfg.harness]) throw new Error('Unknown harness');
    assertPermissionModeOffered(cfg.harness, cfg.permissionMode);
    if (cfg.harness === 'antigravity') {
      if (controlCreation || req.goal?.trim()) throw new Error('Antigravity sessions are driven by direct user prompts.');
    }
    if (cfg.fastMode) {
      const support = fastModeSupport(cfg.harness, cfg.model ?? settings.defaultModelByHarness[cfg.harness], settings.providers);
      if (!support.supported || cfg.codexModelProvider) throw new Error(support.reason ?? 'Fast mode is not supported by this custom Codex provider.');
    }
    let cwd = cfg.projectRoot;
    let worktreeBranch: string | undefined;
    if (req.checkoutBranch) {
      if (confineTo) throw new Error('Controlled creation cannot check out a branch');
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
        // The request comes from the renderer or a spawned agent; a prefix git cannot take is refused
        // here rather than surfacing as a `git worktree add` failure.
        const branchPrefix = cfg.branchPrefix === undefined ? undefined : normalizeBranchPrefix(cfg.branchPrefix);
        if (cfg.branchPrefix !== undefined && !branchPrefix) throw new Error(`Invalid branch prefix: ${cfg.branchPrefix}`);
        if (branchPrefix) cfg = { ...cfg, branchPrefix };
        // A leading `-` would reach `git worktree add` as an option, so the base is a plain ref name.
        if (req.worktreeBase !== undefined && !/^[\w][\w./-]*$/.test(req.worktreeBase)) throw new Error('Invalid base branch');
        // A name the dialog sent (typed, or suggested from the prompt) and a title the user wrote are
        // used word for word; a first prompt names the branch by its intent, filler words dropped,
        // rather than by its first characters.
        const typed = req.worktreeName?.trim() || req.title?.trim();
        const prompt = req.initialPrompt?.trim();
        const name = typed ? branchSlug(typed) : prompt ? branchNameFromText(prompt) : slugify(id);
        const wt = await createWorktree(cfg.projectRoot, name, { branchPrefix, startPoint: req.worktreeBase, confineTo });
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
    const nativeGoal = objective ? await this.goals.harnessGoal(cfg.harness) : null;
    // The objective names the session whoever runs the goal: on a harness without its own /goal the
    // first message is the app's kickoff prompt, and a title cut from that boilerplate names nothing.
    const titleSeed = req.initialPrompt ?? objective;
    // Only a title the caller chose is the session's real name. A title derived here is a stand-in
    // for one nobody has written yet, so flag it: the first message replaces it with a model's.
    const chosenTitle = req.title?.trim();
    const title = chosenTitle || (titleSeed ? titleFromPrompt(titleSeed) : 'New session');
    const meta: SessionMeta = {
      id,
      ...(controlCreation ? { controlCreation } : {}),
      title,
      titleIsPlaceholder: chosenTitle ? undefined : true,
      titleIsAutomatic: !chosenTitle,
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
      fastModeStatus: { state: cfg.fastMode ? 'requested' : 'off' },
      queued: 0
    };
    // Without an append-system-prompt API, app and session instructions share the first-message
    // preamble. The flag is cleared only once the harness accepted it, like the digest below.
    if (!HARNESS_BY_ID[cfg.harness].capabilities.systemPrompt) meta.pendingAppInstructions = true;
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
    const initialFiles = req.initialFiles?.length ? req.initialFiles : undefined;
    if (meta.nativeGoal) {
      // A slash command has to open its message, so the objective rides along as its argument. The
      // harness's own goal takes it from there — no kickoff prompt, no app-side continuation.
      if (!chosenTitle) this.scheduleLlmTitle(id, { prompt: promptText || objective });
      void this.sendAs(id, { text: `/${meta.nativeGoal} ${objective}` }, 'user', '').catch((e) => this.emit(id, { type: 'error', message: errorMessage(e) }));
      if (promptText || initialImages || initialFiles) {
        void this.send(id, { text: promptText, images: initialImages, files: initialFiles }).catch((e) => this.emit(id, { type: 'error', message: errorMessage(e) }));
      }
    } else if (promptText || initialImages || initialFiles) {
      // A user-supplied title stands; otherwise the prompt-derived one is only a placeholder
      // until the LLM title call lands.
      if (!chosenTitle && promptText) this.scheduleLlmTitle(id, { prompt: promptText });
      const prompt = meta.goal && promptText ? `${promptText}\n\nActive goal: ${meta.goal.objective}` : promptText;
      void this.sendAs(id, { text: prompt, images: initialImages, files: initialFiles }, 'user', promptText).catch((e) => this.emit(id, { type: 'error', message: errorMessage(e) }));
    } else if (meta.goal) {
      void this.sendAs(id, { text: this.goals.kickoffPrompt(meta.goal) }, 'goal').catch((e) => this.emit(id, { type: 'error', message: errorMessage(e) }));
    }
    return meta;
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
    return this.withoutControlled(id, () => this.deleteUncontrolled(id, removeWt));
  }

  private async deleteUncontrolled(id: string, removeWt: boolean): Promise<boolean> {
    const meta = this.get(id);
    if (!meta) return false;
    if (meta.mission) await this.deps.mission?.()?.sessionRemoved(meta);
    const t0 = Date.now();
    await this.stop(id);
    await this.preserveUserInputs(meta, await this.deps.store.readTranscript(id));
    this.cancelPersist(id);
    this.gitState.cancel(id);
    this.titleAttempts.delete(id);
    this.titleInFlight.delete(id);
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
    return this.withoutControlled(id, () => this.patchUncontrolled(id, patch));
  }

  private async patchUncontrolled(id: string, patch: Partial<SessionMeta>): Promise<SessionMeta> {
    if ('controlCreation' in patch) throw new Error('Control creation identity is host-owned');
    if ('mission' in patch) throw new Error('Mission identity is host-owned');
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    // A rename is the user naming the session: no title model may overwrite it afterwards.
    const named = patch.title !== undefined ? { titleIsPlaceholder: undefined, titleIsAutomatic: false } : {};
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
    this.assertNotHousekeeping(id);
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

  /**
   * The session counted as viewed: clears "done · not viewed" and stamps the view for the activity
   * tray's Recent list. Like pinning, it must not bump updatedAt — viewing must not reorder rows.
   */
  async markViewed(id: string): Promise<SessionMeta> {
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    // Every return to the window re-views what is on screen. With no mark to clear and a fresh
    // stamp, Recent's order would not change: skip rewriting the index and broadcasting the list.
    if (meta.unseenAt === undefined && meta.lastViewedAt !== undefined && Date.now() - meta.lastViewedAt < VIEW_STAMP_REFRESH_MS) return meta;
    const before = { unseenAt: meta.unseenAt, unseenFailed: meta.unseenFailed, lastViewedAt: meta.lastViewedAt };
    delete meta.unseenAt;
    delete meta.unseenFailed;
    meta.lastViewedAt = Date.now();
    try {
      await this.deps.store.upsert(meta);
    } catch (e) {
      // Disk still has the mark; keep memory agreeing with it so the next view retries.
      Object.assign(meta, before);
      throw e;
    }
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

  /** Housekeeping must not stop a harness or acknowledge an unproven workspace writer. */
  canHousekeep(id: string): boolean {
    return !this.housekeepArchives.has(id) && this.housekeepIdle(id);
  }

  private housekeepIdle(id: string): boolean {
    const meta = this.get(id);
    if (!meta || meta.archived || meta.pinned || this.configDispatches.has(id) || this.sharedSkillAdmissions.has(id) || this.persistTimers.has(id) ||
        this.fastModeUpdates.has(id) || this.antigravityModeUpdates.has(id) || missionLive(meta)) return false;
    const activity = this.activity(id);
    return !activity.active && activity.quiescent;
  }

  assertNotHousekeeping(id: string): void {
    if (this.housekeepArchives.has(id)) throw new Error('This session is being archived by Housekeep.');
  }

  /** A reservation covers the async verification and removal. This path never uses legacy worktree
   * fallback cleanup. `prepare` returns whether it verified a worktree removal. */
  async archiveForHousekeep(id: string, prepare: (assertIdle: () => void) => Promise<boolean>): Promise<boolean> {
    const assertIdle = () => {
      if (!this.housekeepIdle(id)) throw new Error('Session is no longer idle or eligible.');
    };
    this.assertNotHousekeeping(id);
    assertIdle();
    this.housekeepArchives.add(id);
    try {
      const removed = await prepare(assertIdle);
      assertIdle();
      const meta = this.get(id)!;
      const before = { archived: meta.archived, updatedAt: meta.updatedAt };
      // Keep the same object: other session bookkeeping can have a reference to the live row.
      Object.assign(meta, { archived: true, updatedAt: Date.now() });
      try {
        await this.deps.store.upsert(meta);
      } catch (error) {
        // upsert sets the in-memory row before writing the index. Restore the visible state on failure.
        Object.assign(meta, before);
        throw new Error(removed ? 'Worktree removed; the session archive could not be saved. Its branch is retained.' : 'The session archive could not be saved.', { cause: error });
      }
      this.deps.log('info', `[${id}] session archived by Housekeep${removed ? ' (worktree removed)' : ''}`);
      this.pushSessions();
      return removed;
    } finally {
      this.housekeepArchives.delete(id);
    }
  }

  /** Archives a session; with `removeWt` it also deletes the worktree (the branch is kept so unarchive can restore it). */
  async setArchived(id: string, archived: boolean, removeWt = false, forceWt = false): Promise<SessionMeta> {
    return this.withoutControlled(id, () => this.archiveUncontrolled(id, archived, removeWt, forceWt));
  }

  private async archiveUncontrolled(id: string, archived: boolean, removeWt: boolean, forceWt: boolean): Promise<SessionMeta> {
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    if (archived && meta.mission) await this.deps.mission?.()?.sessionRemoved(meta);
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

  /** Read only what the live Claude adapter has observed; never start a session to ask. */
  claudeSubscriptionWindows(id: string) {
    const adapter = this.active.get(id)?.adapter;
    return adapter?.id === 'claude' ? adapter.observedSubscriptionWindows?.() ?? [] : [];
  }

  /**
   * Stops or steers one subagent run by sending the extension command straight to the harness.
   * The command is not a user message: it must not appear in the transcript or start a turn, so it
   * bypasses `send` and talks to the live adapter. Only harnesses with per-run control accept it —
   * the Claude SDK can interrupt a turn but not one child, so it must refuse rather than no-op.
   */
  async subagentCommand(id: string, runId: string, kind: 'stop' | 'steer', message?: string): Promise<{ ok: boolean; error?: string }> {
    return this.withoutControlled(id, () => this.subagentCommandUncontrolled(id, runId, kind, message));
  }

  private async subagentCommandUncontrolled(id: string, runId: string, kind: 'stop' | 'steer', message?: string): Promise<{ ok: boolean; error?: string }> {
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

  housekeepTranscript(id: string): Promise<TranscriptItem[]> {
    return this.deps.store.readHousekeepTranscript(id);
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

  private buildContext(meta: SessionMeta, id: string, current = () => true, runtime?: () => ActiveSession): HarnessContext {
    const store = this.deps.store;
    const sessionDir = store.sessionDir(id);
    // A runtime always reads the live session: a permission mode tightened after start must still
    // govern the approvals it raises while it shuts down.
    const session = () => this.get(id) ?? meta;
    return {
      sessionId: id,
      session,
      settings: () => this.settings(),
      runtime: this.deps.runtime,
      sessionDir,
      // A session saved before its harness's tiers were enforced may carry one it does not offer;
      // the adapter runs the closest stricter tier, never a looser one.
      permissionMode: () => closestPermissionMode(session().config.harness, session().config.permissionMode),
      ...(this.deps.appInstructions ? { appInstructions: () => this.deps.appInstructions!(session().config.harness) } : {}),
      missionInstructions: async () => {
        const m = session();
        return m.mission ? this.deps.mission?.()?.instructions(m) : undefined;
      },
      effort: () => {
        const m = session();
        // An explicit omission must not borrow the preference retained for effort-capable models.
        // A later deliberate effort switch still wins, as it does for an explicit level.
        if (m.activeEffort) return m.activeEffort;
        if (m.config.effort === null) return undefined;
        return m.config.effort ?? this.settings().defaultEffort;
      },
      getApiKey: (providerId) => this.deps.getSecret(providerId),
      mcpServers: async () => {
        const available = () => current() && runtime?.()?.tearingDown !== true;
        if (!available()) throw new Error('Session runtime is no longer current');
        const m = session();
        const servers = await resolveForSession(
          { settings: this.settings(), cwd: m.cwd, projectRoot: m.config.projectRoot, harness: m.config.harness, branch: m.worktreeBranch, sessionId: id, readOnly: m.config.permissionMode === 'plan' },
          {
            getSecret: this.deps.getSecret,
            sharedGitnexus: this.deps.sharedGitnexus,
            gitnexusProxyPath: this.deps.gitnexusProxyPath,
            memoryServerPath: this.deps.memoryServerPath,
            memoryUserData: this.deps.memoryUserData,
            memoryGateway: (sessionId) => available() ? this.deps.memoryGateway?.(sessionId) ?? null : null,
            ...(m.mission ? { missionGateway: available() ? this.deps.mission?.()?.gateway() : undefined, missionServerPath: this.deps.missionServerPath } : {}),
            ...(this.deps.hubServers ? { hubServers: this.deps.hubServers } : {}),
            log: (level, message) => this.deps.log(level, `[${id}] ${message}`)
          }
        );
        if (!available()) throw new Error('Session runtime is no longer current');
        return servers;
      },
      ownedMcpIds: () => builtinServerIds(),
      emit: (event) => { if (current()) this.emit(id, event, runtime?.()); },
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
        if (runtime?.()?.sharedSkillTurn) {
          const { title: _title, statusDetail: _detail, ...safe } = patch;
          patch = safe;
        }
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
      },
      // Adapter diagnostics may include reflected provider input. Normal turn telemetry remains.
      log: (level, message) => {
        if (!runtime?.()?.sharedSkillTurn) this.deps.log(level, `[${id}] ${message}`);
      },
      readJson: (name) => readJson(path.join(sessionDir, name), null),
      writeJson: (name, data) => current() ? writeJson(path.join(sessionDir, name), data) : Promise.resolve()
    };
  }

  private async ensureActive(id: string, beforeStart?: () => void): Promise<ActiveSession> {
    if (this.fastModeUpdates.has(id)) throw new Error('Wait for the Fast mode update to finish.');
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
    if (meta.harnessCommands?.length) {
      meta.harnessCommands = undefined;
      await this.applyGoalDriver(meta);
      this.schedulePersist(meta);
    }
    beforeStart?.(); // Stop may have won while restoring the last advertised commands above.
    meta.fastModeStatus = { state: meta.config.fastMode ? 'requested' : 'off' };
    const seq = (this.runtimeSeq.get(id) ?? 0) + 1;
    this.runtimeSeq.set(id, seq);
    let active: ActiveSession;
    // A runtime keeps recording its own events and writes while it disposes (its interrupted turn,
    // final usage, history), and is fenced only once a newer runtime supersedes it.
    const current = () => this.runtimeSeq.get(id) === seq && !this.fencedRuntimes.has(active);
    const live = () => current() && !active.tearingDown;
    const ctx = this.buildContext(meta, id, current, () => active);
    // Every adapter call runs as this session, so whatever the harness spawns (its CLI, MCP servers,
    // tool shells) is attributed to it in the Processes panel.
    const adapter = ownedAdapter(createAdapter(meta.config.harness, ctx), { sessionId: id });
    active = {
      adapter,
      startupDispatched: false,
      tearingDown: false,
      uncertain: false,
      disposal: null,
      nativeChildren: new Map(),
      ongoingBySource: new Map(),
      deferredTurnNotice: null,
      deferredGoalContinuation: null,
      ongoingSettleTimer: null,
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
    const controlled = this.controlled.get(id);
    if (controlled) controlled.runtime = active;
    this.gitState.cancel(id);
    meta.status = 'starting';
    meta.statusDetail = `Starting ${HARNESS_BY_ID[meta.config.harness].name}…`;
    this.pushSessions();
    const resume = describeResume(meta.harnessRef);
    this.deps.log('info', `[${id}] starting ${meta.config.harness} (model=${describeModel(meta.activeModel)} permissions=${meta.config.permissionMode} cwd=${meta.cwd}${resume ? ` resume=${resume}` : ''})`);
    const t0 = Date.now();
    const start = async () => {
      if (!live()) throw new Error('Session stopped before its runtime could start.');
      active.startupDispatched = true;
      // A controlled turn's grant can be revoked or narrowed while the runtime is being prepared.
      const turn = this.controlled.get(id);
      if (turn?.runtime === active) {
        try { turn.startAllowed(); } catch (error) { throw new ControlledStartRefused(errorMessage(error)); }
      }
      await adapter.start();
    };
    active.starting = start()
      .then(() => {
        active.starting = null;
        this.deps.log('info', `[${id}] ${meta.config.harness} started in ${Date.now() - t0}ms`);
        // Stop does not wait for startup. A start that completed after it must not leave its
        // process running, so dispose again.
        if (active.tearingDown) {
          void Promise.resolve().then(() => adapter.dispose()).catch((e) => this.deps.log('warn', `[${id}] dispose after a start that outlived Stop failed: ${errorMessage(e)}`));
          return;
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
        if (e instanceof ControlledStartRefused) {
          // Nothing started and nothing is wrong with the session or its harness: release the
          // unstarted runtime and leave the session as the owner had it. The controller's receipt
          // records the refusal.
          this.deps.log('info', `[${id}] controlled start refused: ${e.message}`);
          this.disposeRuntime(id, active, 'idle').catch((de) => this.deps.log('warn', `[${id}] dispose after refused start: ${errorMessage(de)}`));
          throw e;
        }
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

  /** Explicit desktop-owner invocation. Reserve the turn before any filesystem wait. */
  async sendSharedSkill(
    id: string, text: string, resolve: (name: string) => Promise<{ receipt: SharedSkillReceipt; content: string }>, expected?: string
  ): Promise<void> {
    const command = parseSharedSkillCommand(text);
    if (!command) throw new Error('Use /skill <name> [task].');
    this.assertNotControlled(id);
    const session = this.get(id);
    if (!session) throw new Error('Session not found');
    if (!sharedSkillSupported(session.config.harness)) throw new Error('This harness does not support Shared skills.');
    const identity = (m: SessionMeta) => JSON.stringify([m.cwd, m.config.projectRoot, m.config.harness, m.config.permissionMode]);
    const original = identity(session);
    const assertIdle = () => {
      const active = this.active.get(id);
      if (this.get(id) !== session || identity(session) !== original || this.housekeepArchives.has(id) ||
          session.archived || session.controlCreation || session.mission || session.goal?.status === 'active' || session.nativeGoal ||
          active?.pendingGoalKickoff || active?.goalContinuationTimer || active?.deferredGoalContinuation || active?.sharedSkillTurn ||
          hasOngoingWork(session) || this.antigravityModeUpdates.has(id) || this.fastModeUpdates.has(id) ||
          !this.activity(id).quiescent || ['starting', 'running', 'awaiting'].includes(session.status)) {
        throw new Error('Shared skills require an idle desktop session with no active Goal or Mission.');
      }
    };
    if (this.configDispatches.has(id)) throw new Error('Wait for the current session operation to finish.');
    assertIdle();
    const lease = { canceled: false };
    this.sharedSkillAdmissions.set(id, lease);
    const assertCurrent = () => {
      if (lease.canceled) throw new Error('Shared skill stopped before sending.');
      assertIdle();
    };
    try {
      const { receipt, content } = await resolve(command.name);
      if (expected && receipt.revision !== expected) throw new Error('The selected Shared skill revision changed. Select it again before sending.');
      assertCurrent();
      const itemId = shortId('u_');
      await this.dispatchInput(id, {
        text: `Shared skill instructions (${receipt.name}):\n\n${content}\n\nUser's task:\n${command.args || '(No additional task specified.)'}`,
        mode: 'now', transcriptItemId: itemId
      }, {
        assertCurrent,
        beforeSend: async () => {
          assertCurrent();
          // Recheck review and file identity after startup/preamble, but send the original
          // captured body, not a harness-native lookup (which may be repo-first).
          if ((await resolve(command.name)).receipt.revision !== receipt.revision) {
            throw new Error('Shared skill changed before sending. Review it and send again.');
          }
          assertCurrent();
        },
        record: (active) => {
          active.sharedSkillTurn = true;
          const ts = Date.now();
          this.emit(id, { type: 'item.upsert', item: { id: itemId, kind: 'user', ts, text, queuedAs: 'now', sharedSkill: receipt, userInput: measureUserInput(id, text) } });
          this.recordDirectUserActivity(session, ts);
          this.schedulePersist(session);
          this.pushSessions();
        }
      });
    } finally {
      this.sharedSkillAdmissions.delete(id);
    }
  }

  private assertNotControlled(id: string): void {
    this.assertNotHousekeeping(id);
    if (this.controlled.has(id)) throw new Error('Session is busy with a controlled turn');
    if (this.sharedSkillAdmissions.has(id)) throw new Error('A Shared skill is being sent in this session.');
  }

  /** Covers awaits before ordinary sends and destructive/configuration edits as well as dispatch. */
  private async withoutControlled<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.assertNotControlled(id);
    if (this.antigravityModeUpdates.has(id)) throw new Error('Wait for the Antigravity permission update to finish.');
    this.configDispatches.set(id, (this.configDispatches.get(id) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const count = (this.configDispatches.get(id) ?? 1) - 1;
      if (count) this.configDispatches.set(id, count);
      else this.configDispatches.delete(id);
    }
  }

  /** Internal desktop boundary, not a generic IPC method. Each admission gets a fresh runtime:
   * the normalized protocol has a running transition and terminal turn item, not a provider turn
   * ID on every delta. Reusing an earlier runtime would misattribute its late terminal events. */
  async runControlled(id: string, input: { text: string }, control: { operationId: string; inputId: string; beforeStart: () => Promise<void>; startAllowed: () => void; beforeDispatch: () => Promise<void> }): Promise<ControlledTurnResult> {
    this.assertNotControlled(id);
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    if (meta.config.harness === 'antigravity') throw new Error('Antigravity sessions are driven by direct user prompts.');
    if (!input.text.trim() || /^\s*\//.test(input.text)) throw new Error('Controlled input must be a nonempty text turn, not a harness command');
    if (!control.operationId || !/^[A-Za-z0-9_-]+$/.test(control.inputId)) throw new Error('Invalid control identity');
    const previous = this.active.get(id);
    const activity = this.activity(id);
    if (meta.archived || meta.goal?.status === 'active' || meta.nativeGoal || previous?.goalContinuationTimer || previous?.pendingGoalKickoff ||
        this.configDispatches.has(id) || this.fastModeUpdates.has(id) || previous?.starting || activity.turn || activity.tools || activity.nativeChildren ||
        activity.approvals || activity.queued || activity.tearingDown || activity.uncertain || previous?.adapter.workspaceWriterState?.() === 'active' ||
        meta.status === 'starting' || meta.status === 'awaiting' || meta.status === 'running' && !activity.compacting) {
      throw new Error('Session is busy or its activity is unproven');
    }
    const lease: ControlledTurn = {
      operationId: control.operationId, inputId: control.inputId, runtimeId: shortId('runtime_'),
      dispatched: false, started: false, canceled: false, uncertain: false, outputIds: new Set(),
      ended: deferred<void>(), writes: new Set(), writeFailed: false, startAllowed: control.startAllowed,
    };
    // This reservation precedes the very first await; ordinary send/steer/queue cannot slip in.
    this.controlled.set(id, lease);
    // The configuration a runtime would start with. The reservation refuses desktop edits; this
    // also catches any other path, so the authorization below stays about what actually starts.
    const authorized = (m: SessionMeta | undefined) => m && JSON.stringify([m.cwd, m.config.projectRoot, m.config.harness, m.config.permissionMode]);
    const reserved = authorized(meta);
    // True only between start authorization and runtime construction: the window startAllowed guards.
    let startAuthorized = false;
    const assertCurrent = () => {
      if (lease.canceled || this.controlled.get(id) !== lease) throw new Error('Controlled turn was canceled before dispatch');
      if (lease.uncertain) throw new Error('Controlled runtime activity is unproven');
      if (lease.runtime && (this.active.get(id) !== lease.runtime || lease.runtime.tearingDown || lease.runtime.uncertain)) throw new Error('Controlled runtime is no longer current');
      if (authorized(this.get(id)) !== reserved) throw new Error('Controlled session configuration changed');
      if (startAuthorized) lease.startAllowed();
    };
    try {
      if (previous?.compactionInFlight) await previous.compactionInFlight;
      assertCurrent();
      if (previous) {
        this.fencedRuntimes.add(previous);
        await this.disposeRuntime(id, previous, 'idle');
        if (this.retiring.get(id)?.size || this.activity(id).uncertain) throw new Error('Previous runtime disposal is unproven');
      }
      assertCurrent();
      const existingItems = await this.deps.store.readTranscript(id);
      if (existingItems.some((item) => item.id === control.inputId)) throw new Error('Controlled input identity is already present');
      // Authorize the reserved configuration last before a runtime is constructed. Starting one can
      // spawn CLI and MCP processes, so the dispatch check below cannot be the first gate; the
      // synchronous check repeats immediately before the adapter starts (see ensureActive).
      await control.beforeStart();
      startAuthorized = true;
      assertCurrent();
      const active = await this.ensureActive(id).finally(() => { startAuthorized = false; });
      assertCurrent();
      if (active.compactionInFlight) await active.compactionInFlight;
      assertCurrent();
      if (active.adapter.busy || active.turnPending || active.approvals.size || meta.queued || this.get(id)?.goal?.status === 'active' ||
          [...active.nativeChildren.values()].some((child) => child.running) || active.adapter.workspaceWriterState?.() === 'unknown') throw new Error('Controlled runtime is not idle');
      const prepared = await this.withSessionPreamble(id, { text: input.text, transcriptItemId: control.inputId });
      assertCurrent();
      this.emit(id, { type: 'item.upsert', item: { id: control.inputId, kind: 'user', ts: Date.now(), text: input.text } });
      await this.controlledBarrier(id, lease);
      let accepted = Promise.resolve();
      const dispatch = async () => {
        assertCurrent();
        // Nothing asynchronous belongs between this grant/intent recheck and adapter dispatch.
        await control.beforeDispatch();
        assertCurrent();
        if (active.adapter.busy || active.turnPending || active.approvals.size || meta.queued ||
            [...active.nativeChildren.values()].some((child) => child.running) || active.adapter.workspaceWriterState?.() === 'unknown') throw new Error('Controlled runtime became busy before dispatch');
        lease.dispatched = true;
        active.turnPending = Symbol();
        try {
          accepted = Promise.resolve(active.adapter.send(prepared)).catch(() => {
            if (this.controlled.get(id) !== lease) return;
            lease.uncertain = true;
            this.endControlled(lease, 'unknown');
          });
        } catch {
          lease.uncertain = true;
          this.endControlled(lease, 'unknown');
        }
      };
      await dispatch();
      // Acceptance is deliberately not completion. Only this runtime's normalized events end it.
      await lease.ended.promise;
      // Some adapters save provider history after emitting their terminal event. Do not fence those
      // writes on the normal completion path; an explicit Stop still need not await a hung send.
      if (lease.turnId && !lease.canceled) await accepted;
      await this.clearSessionPreamble(id);
      const state = this.activity(id);
      // Missing writer tracking cannot certify the absence of child work. This is evidence about
      // an ordinary turn, not adapter certification or proof of tests mentioned in assistant prose.
      if (active.adapter.workspaceWriterState?.() !== 'quiescent' || state.nativeChildren || state.tools || state.approvals || meta.queued || state.uncertain) lease.uncertain = true;
      this.fencedRuntimes.add(active);
      await this.disposeRuntime(id, active, 'idle');
      if (this.retiring.get(id)?.size) lease.uncertain = true;
      await this.stream.flushLive(id, active, true);
      await this.controlledBarrier(id, lease);
      return {
        outcome: lease.uncertain ? 'unknown' : lease.terminal ?? 'unknown',
        inputId: lease.inputId, runtimeId: lease.runtimeId, ...(lease.turnId ? { turnId: lease.turnId } : {}), outputIds: [...lease.outputIds],
      };
    } finally {
      if (lease.runtime) {
        this.fencedRuntimes.add(lease.runtime);
        if (this.active.get(id) === lease.runtime) await this.disposeRuntime(id, lease.runtime, 'idle');
      }
      if (this.controlled.get(id) === lease) this.controlled.delete(id);
    }
  }

  /** Never interrupts a later desktop turn, even while this operation's result is being saved. */
  async interruptControlled(id: string, operationId: string): Promise<void> {
    const lease = this.controlled.get(id);
    if (!lease || lease.operationId !== operationId || lease.terminal) throw new Error('Controlled operation is no longer active');
    const active = lease.runtime;
    if (active && this.active.get(id) !== active) throw new Error('Controlled runtime is no longer current');
    lease.canceled = true;
    if (!lease.dispatched || !active) return;
    this.cancelApprovals(id, active, 'Interrupted');
    try {
      await active.adapter.interrupt();
    } finally {
      // An interrupt ACK without a normalized terminal event proves no terminal disposition.
      if (!lease.terminal) { lease.uncertain = true; this.endControlled(lease, 'unknown'); }
    }
  }

  private endControlled(lease: ControlledTurn, outcome: ControlledTurnResult['outcome']): void {
    if (lease.terminal) return;
    lease.terminal = outcome;
    lease.ended.resolve();
  }

  private observeControlled(id: string, runtime: ActiveSession, event: SessionEvent): void {
    const lease = this.controlled.get(id);
    if (!lease || lease.runtime !== runtime) return;
    if (!lease.dispatched) {
      if (event.type === 'status' && event.status === 'running' || event.type === 'subagent.run' ||
          event.type === 'item.upsert' && ['assistant', 'tool', 'turn'].includes(event.item.kind)) lease.uncertain = true;
      return;
    }
    if (event.type === 'status' && event.status === 'running') {
      if (lease.terminal) lease.uncertain = true;
      lease.started = true;
    }
    if (event.type === 'item.upsert') {
      const item = event.item;
      if (item.kind === 'turn') {
        if (!lease.started || lease.turnId && lease.turnId !== item.id) lease.uncertain = true;
        lease.turnId ??= item.id;
        this.endControlled(lease, item.status === 'completed' ? 'succeeded' : item.status);
      } else if (item.kind !== 'user') {
        lease.outputIds.add(item.id);
        // A delegation tool without a matching run lifecycle is untracked, even if its tool card
        // says done. Its parent turn ending says nothing about that child.
        if (item.kind === 'tool' && (item.hint === 'agent' || item.runId) && (!item.runId || !runtime.nativeChildren.has(item.runId))) lease.uncertain = true;
      } else if (item.id !== lease.inputId) lease.uncertain = true;
    }
    if (event.type === 'subagent' && !runtime.nativeChildren.has(event.completion.agentId)) lease.uncertain = true;
    if (event.type === 'subagent.run') {
      const previous = runtime.nativeChildren.get(event.run.runId);
      if (!['running', 'completed', 'error', 'stopped', 'interrupted'].includes(event.run.status) ||
          event.run.status !== 'running' && (!previous || previous.startedAt !== event.run.startedAt)) lease.uncertain = true;
    }
    if (event.type === 'status' && (event.status === 'stopped' || event.status === 'error') || event.type === 'error' && event.fatal) {
      lease.uncertain = true;
      this.endControlled(lease, 'unknown');
    }
  }

  /** Keep rejection evidence even though ordinary UI appends intentionally log and recover. */
  private trackControlledWrite(id: string, write: Promise<void>): Promise<void> {
    const lease = this.controlled.get(id);
    if (lease) {
      const observed = write.then(() => undefined, () => { lease.writeFailed = true; });
      lease.writes.add(observed);
      void observed.then(() => lease.writes.delete(observed));
    }
    return write;
  }

  private async controlledBarrier(id: string, lease: ControlledTurn): Promise<void> {
    this.cancelPersist(id);
    const meta = this.get(id);
    if (!meta) throw new Error('Controlled session disappeared');
    while (lease.writes.size) await Promise.all([...lease.writes]);
    if (lease.writeFailed) throw new Error('Controlled turn persistence failed');
    await this.trackControlledWrite(id, this.deps.store.commitTranscript(id, [...(lease.runtime?.liveItems.values() ?? [])]));
    await this.trackControlledWrite(id, this.deps.store.upsert(meta));
    while (lease.writes.size) await Promise.all([...lease.writes]);
    if (lease.writeFailed) throw new Error('Controlled turn persistence failed');
  }

  /**
   * `source` is host provenance, never supplied by a renderer or model. Goal dispatch is not a user
   * action: it confers no new authority and must not affect user recency.
   */
  private async sendAs(id: string, input: UserInput, source: 'user' | 'goal' | 'mission', originalText = input.text, mission?: MissionMessageMeta): Promise<void> {
    return this.withoutControlled(id, () => this.sendUncontrolled(id, input, source, originalText, mission));
  }

  /**
   * A host-authored message to a mission session (a kickoff, a Lead↔Builder message, a report).
   * It is not the user's: no input receipt, no recency stamp, no title naming. Antigravity refuses it.
   */
  async sendHost(id: string, text: string, mission: MissionMessageMeta): Promise<void> {
    if (!this.get(id)?.mission) throw new Error('Host messages go to mission sessions only');
    return this.sendAs(id, { text }, 'mission', text, mission);
  }

  /** Writes a host item (a note or a mirrored approval card) into a session's transcript. */
  emitHostItem(id: string, item: TranscriptItem): void {
    if (!this.get(id)) return;
    this.emit(id, { type: 'item.upsert', item });
  }

  /** Host-only update of a session's Mission identity (state, Builder state, PR link). */
  setMission(id: string, patch: Partial<SessionMission>): SessionMeta | undefined {
    const meta = this.get(id);
    if (!meta?.mission) return undefined;
    meta.mission = { ...meta.mission, ...patch };
    this.schedulePersist(meta);
    this.pushSessions();
    return meta;
  }

  /**
   * A mission session created by Mission mode itself: the worktree is already resolved (a Builder
   * that shares the Lead's folder passes no `worktreeBranch`, so it never owns or removes it).
   * `forkContextFrom` hands that session's conversation to the new one, as a cross-harness fork does.
   */
  async createMissionSession(spec: { config: SessionConfig; title: string; cwd: string; worktreeBranch?: string; mission: SessionMission; forkContextFrom?: string }): Promise<SessionMeta> {
    const cfg = { ...spec.config, fastMode: false };
    if (!HARNESS_BY_ID[cfg.harness]) throw new Error('Unknown harness');
    assertPermissionModeOffered(cfg.harness, cfg.permissionMode);
    const s = this.settings();
    const id = shortId('s_');
    const model = cfg.model ?? s.defaultModelByHarness[cfg.harness];
    const meta: SessionMeta = {
      id,
      title: spec.title,
      titleIsAutomatic: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      config: { ...cfg, model },
      mission: spec.mission,
      cwd: spec.cwd,
      worktreeBranch: spec.worktreeBranch,
      status: 'idle',
      harnessRef: {},
      usage: emptyUsage(),
      activeModel: model,
      activeEffort: cfg.effort ?? undefined,
      fastModeStatus: { state: 'off' },
      queued: 0
    };
    if (!HARNESS_BY_ID[cfg.harness].capabilities.systemPrompt) meta.pendingAppInstructions = true;
    if (this.deps.knowledgeDigest && s.knowledge?.prime !== false) {
      try {
        const digest = (await this.deps.knowledgeDigest({ projectRoot: cfg.projectRoot, cwd: spec.cwd, branch: spec.worktreeBranch }))?.trim();
        if (digest) {
          meta.knowledgeDigest = digest;
          if (!HARNESS_BY_ID[cfg.harness].capabilities.systemPrompt) meta.pendingKnowledgeDigest = true;
        }
      } catch (e) {
        this.deps.log('debug', `[${id}] knowledge digest unavailable: ${errorMessage(e)}`);
      }
    }
    let carried: TranscriptItem[] = [];
    if (spec.forkContextFrom) {
      const src = this.get(spec.forkContextFrom);
      if (!src) throw new Error('Session not found');
      carried = (await this.transcript(src.id)).filter((i) => !(i.kind === 'approval' && !i.decision)).map(carriedItem);
      if (carried.length) {
        await this.deps.store.writeBlob(id, FORK_CONTEXT_FILE, renderForkContext(carried, src.config.harness, cfg.harness));
        meta.pendingForkContext = true;
        meta.forkedFrom = src.id;
        carried.push({ id: shortId('i_'), kind: 'info', ts: Date.now(), level: 'info', text: `Mission Lead started from “${src.title}”; that conversation is carried over as context.` });
      }
    }
    await this.deps.store.upsert(meta);
    if (carried.length) await this.deps.store.rewriteTranscript(id, carried);
    this.deps.log('info', `[${id}] mission ${spec.mission.role} created: harness=${cfg.harness} model=${describeModel(meta.activeModel)} permissions=${cfg.permissionMode} cwd=${spec.cwd}${spec.worktreeBranch ? ` worktree=${spec.worktreeBranch}` : ''}`);
    this.deps.analytics.touchSession(meta);
    this.pushSessions();
    return meta;
  }

  /** Turns an existing, still-empty session into a mission session (the empty-session toggle). */
  async adoptMissionSession(id: string, patch: { mission: SessionMission; permissionMode: PermissionMode }): Promise<SessionMeta> {
    return this.withoutControlled(id, async () => {
      const meta = this.get(id);
      if (!meta) throw new Error('Session not found');
      if (meta.mission) throw new Error('This session is already part of a mission');
      if (this.active.get(id)?.adapter.busy) throw new Error('Wait for the current turn to finish');
      assertPermissionModeOffered(meta.config.harness, patch.permissionMode);
      // A running runtime started without the Mission tools and prompt; the next send starts fresh.
      const active = this.active.get(id);
      if (active) await this.disposeRuntime(id, active, 'idle');
      meta.mission = patch.mission;
      meta.config = { ...meta.config, permissionMode: patch.permissionMode, fastMode: false };
      meta.goal = undefined;
      meta.nativeGoal = undefined;
      meta.updatedAt = Date.now();
      await this.deps.store.upsert(meta);
      this.pushSessions();
      return meta;
    });
  }


  private async sendUncontrolled(id: string, input: UserInput, source: 'user' | 'goal' | 'mission', originalText = input.text, mission?: MissionMessageMeta): Promise<void> {
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    if (meta.config.harness === 'antigravity' && source !== 'user') throw new Error('Antigravity sessions are driven by direct user prompts.');
    if (this.active.get(id)?.sharedSkillTurn) throw new Error('Wait for the Shared skill turn to end before sending another message.');
    if (this.fastModeUpdates.has(id)) throw new Error('Wait for the Fast mode update to finish.');
    // Keep the no-attachment path synchronous until dispatch: an unnecessary await would move the
    // starting transition a tick later.
    const files = input.files?.length ? await retainMessageFiles(this.deps.store.sessionDir(id), input.files) : [];
    // Size and shape only: the prompt itself belongs to the transcript, not the log.
    this.deps.log('debug', `[${id}] user input: ${input.text.length} chars${input.images?.length ? `, ${input.images.length} image(s)` : ''}${files.length ? `, ${files.length} file(s)` : ''}${input.mode ? `, mode=${input.mode}` : ''}`);
    const userItem: TranscriptItem = {
      id: shortId('u_'), kind: 'user', ts: Date.now(), text: input.text,
      images: input.images, files: files.length ? files : undefined, queuedAs: input.mode,
      userInput: source === 'user' ? measureUserInput(id, originalText) : undefined,
      ...(source === 'mission' ? { origin: 'mission' as const, ...(mission ? { mission } : {}) } : {})
    };
    this.emit(id, { type: 'item.upsert', item: userItem });
    // The sidebar orders rows by the user's own last message: stamp it before the harness even
    // starts, so the row moves up on the send rather than on whatever the turn does next.
    if (source === 'user') this.recordDirectUserActivity(meta, userItem.ts);
    // A session named from a dialog prompt or a goal is already carrying a placeholder, and that
    // placeholder is the better one: it was cut from what the user wrote, not from a `/goal …`
    // command the app composed. Keep it on screen and let the model replace it.
    if (source !== 'mission' && isPlaceholderTitle(meta) && input.text.trim()) {
      const placeholder = meta.title === 'New session' ? titleFromPrompt(input.text) : meta.title;
      // A goal kickoff is the app's own prompt; the objective behind it is what names the session.
      const seed = (source === 'goal' && meta.goal?.objective?.trim()) || input.text;
      meta.title = placeholder;
      meta.titleIsPlaceholder = true;
      this.scheduleLlmTitle(id, { prompt: seed });
    }
    this.schedulePersist(meta);
    this.pushSessions();
    await this.dispatchInput(id, { ...input, files: undefined, text: promptWithFiles(input.text, files), transcriptItemId: userItem.id });
  }

  private recordDirectUserActivity(meta: SessionMeta, ts: number): void {
    meta.lastUserMessageAt = ts;
    // Writing to a session is looking at it.
    delete meta.unseenAt;
    delete meta.unseenFailed;
  }

  /** Replaces a sent prompt only when its adapter can restore a durable pre-message checkpoint. */
  async editAndResend(id: string, userItemId: string, input: UserInput): Promise<TranscriptItem[]> {
    return this.withoutControlled(id, () => this.editUncontrolled(id, userItemId, input));
  }

  private async editUncontrolled(id: string, userItemId: string, input: UserInput): Promise<TranscriptItem[]> {
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    if (!input.text.trim() && !input.images?.length && !input.files?.length) throw new Error('Message cannot be empty');
    if (meta.status === 'running' || meta.status === 'starting' || meta.status === 'awaiting') throw new Error('Wait for the current turn to finish before editing a message');

    const items = await this.deps.store.readTranscript(id);
    const index = items.findIndex((item) => item.id === userItemId && item.kind === 'user');
    if (index < 0) throw new Error('Message no longer exists in this transcript');
    const previous = items[index] as Extract<TranscriptItem, { kind: 'user' }>;
    if (previous.sharedSkill || isSharedSkillCommand(input.text)) {
      throw new Error('Shared skills cannot be edited and resent. Start a new turn from the composer.');
    }
    const active = await this.ensureActive(id);
    if (active.compactionInFlight || active.approvals.size || active.adapter.busy) throw new Error('Wait for the current session activity to finish before editing a message');
    if (!active.adapter.rewindToUserMessage) throw new Error('This harness does not support editing past messages yet');
    // Validate and write before rewinding: a failed upload must not discard later turns.
    const files = input.files ? await retainMessageFiles(this.deps.store.sessionDir(id), input.files) : previous.files ?? [];
    await this.preserveUserInputs(meta, items);
    if (!(await active.adapter.rewindToUserMessage(userItemId))) throw new Error('This message can no longer be rewound');
    this.deps.log('info', `[${id}] rewound to message ${userItemId} for edit-and-resend; ${items.length - index - 1} later item(s) dropped from the transcript`);
    const revised: TranscriptItem = {
      ...previous,
      text: input.text,
      images: input.images ?? previous.images,
      files: files.length ? files : undefined,
      queuedAs: 'now',
      userInput: measureUserInput(id, input.text)
    };
    // Context is now safely at the same boundary, so the persistence rewrite cannot diverge.
    active.liveItems.clear();
    active.dirty.clear();
    this.stream.resetCheckpoints(active);
    active.lastAssistantText = '';
    await this.deps.store.rewriteTranscript(id, [...items.slice(0, index), revised]);
    this.deps.analytics.recordUserInputs(meta, [revised]);
    // A re-sent prompt is a user message too, so the sidebar treats this as its latest one.
    meta.lastUserMessageAt = Date.now();
    this.schedulePersist(meta);
    this.pushSessions();
    await this.dispatchInput(id, { text: promptWithFiles(revised.text, files), images: revised.images, mode: 'now', transcriptItemId: userItemId });
    return this.transcript(id);
  }

  private async dispatchInput(id: string, input: UserInput, shared?: SharedSkillAdmission): Promise<void> {
    if (this.fastModeUpdates.has(id)) throw new Error('Wait for the Fast mode update to finish.');
    this.configDispatches.set(id, (this.configDispatches.get(id) ?? 0) + 1);
    try {
      await this.dispatchReservedInput(id, input, shared);
    } finally {
      const count = (this.configDispatches.get(id) ?? 1) - 1;
      if (count) this.configDispatches.set(id, count);
      else this.configDispatches.delete(id);
    }
  }

  private async dispatchReservedInput(id: string, input: UserInput, shared?: SharedSkillAdmission): Promise<void> {
    const active = await this.ensureActive(id, shared?.assertCurrent);
    // Compaction can run without marking an adapter busy. Keep a new turn from reading or
    // mutating its context until that operation has settled.
    if (active.compactionInFlight) await active.compactionInFlight.catch(() => undefined);
    const assertCurrent = () => {
      if (this.active.get(id) !== active || active.tearingDown || active.uncertain) throw new Error('Session stopped before the message could be sent.');
    };
    assertCurrent();
    const prepared = await this.withSessionPreamble(id, input);
    if (shared) {
      await shared.beforeSend();
      shared.assertCurrent();
    }
    assertCurrent();
    const pending = active.turnPending = Symbol();
    if (shared) {
      // Even if a saved app preamble starts with '/', the prepared text cannot invoke a native command.
      prepared.text = `Vocs Code Shared skill turn\n\n${prepared.text}`;
      shared.record(active);
    }
    try {
      // Normal Pi steering aborts the old run; release its approval waits before handing off.
      // Queued input retains its existing approval lifecycle.
      if (active.adapter.id === 'pi' && active.adapter.busy && input.mode !== 'queue') {
        this.cancelApprovals(id, active, 'Interrupted');
      }
      await active.adapter.send(prepared);
    } catch (e) {
      // A refused send may go idle without a turn item. Retire only its own marker.
      if (active.turnPending === pending && !active.adapter.busy) active.turnPending = undefined;
      if (shared) {
        // Missing acknowledgement may mean it ran. Keep this runtime fenced until explicit Stop
        // instead of letting a second send overwrite the unconfirmed turn's state.
        if (active.sharedSkillTurn && this.active.get(id) === active) active.uncertain = true;
        throw new Error('Could not confirm the Shared skill send. Check the session before trying again; Vocs did not retry.');
      }
      throw e;
    }
    if (shared) {
      // An index write after acceptance cannot turn an already-sent action into a refused send.
      await this.clearSessionPreamble(id).catch(() => this.deps.log('warn', `[${id}] session preamble state could not be saved after Shared skill dispatch`));
    } else await this.clearSessionPreamble(id);
  }

  /**
   * Prefixes the first message of a session with the context its harness could not be given up
   * front: app and session instructions, then knowledge and fork context. Engines without an
   * append-system-prompt API keep their own system prompt; these are first-message instructions.
   * Prefixing the user's message keeps the transcript showing only what the user typed.
   */
  private async withSessionPreamble(id: string, input: UserInput): Promise<UserInput> {
    const meta = this.get(id);
    if (!meta) return input;
    const parts: string[] = [];
    if (meta.pendingAppInstructions) {
      const text = await this.deps.appInstructions?.(meta.config.harness);
      if (text) parts.push(text);
      const sessionInstructions = meta.config.appendSystemPrompt?.trim();
      if (sessionInstructions) parts.push(sessionInstructions);
      // Mission rules come last so they win; Codex app-server takes them as developer instructions.
      if (meta.mission && meta.config.harness !== 'codex') {
        const missionText = await this.deps.mission?.()?.instructions(meta);
        if (missionText) parts.push(missionText);
      }
    }

    if (meta.pendingKnowledgeDigest && meta.knowledgeDigest) parts.push(meta.knowledgeDigest);
    if (meta.pendingForkContext) {
      try {
        const context = await this.deps.store.readBlob(id, FORK_CONTEXT_FILE);
        if (context) parts.push(context);
      } catch {
        // The blob is written before the flag is set; a read failure only means we have no context.
      }
    }
    return parts.length ? { ...input, text: `${parts.join('\n\n')}\n\n${input.text}` } : input;
  }

  /** Cleared only after the harness accepted the seeded message, so a failed start retries with it. */
  private async clearSessionPreamble(id: string): Promise<void> {
    const meta = this.get(id);
    if (!meta?.pendingForkContext && !meta?.pendingKnowledgeDigest && !meta?.pendingAppInstructions) return;
    meta.pendingForkContext = undefined;
    meta.pendingKnowledgeDigest = undefined;
    meta.pendingAppInstructions = undefined;
    await this.deps.store.upsert(meta);
  }

  /** Opening-prompt naming is best-effort. Turn-end refreshes use only the configured utility model. */
  private scheduleLlmTitle(id: string, source: { prompt: string } | { turnReply: string }): void {
    const meta = this.get(id);
    if (!meta || meta.archived || meta.titleIsAutomatic === false) return;
    const { utilityModel, providers } = this.settings();
    const currentTitle = meta.title;
    const turnReply = 'turnReply' in source ? source.turnReply : undefined;
    let candidates = providers;
    if (turnReply !== undefined) {
      if (!utilityModel || (!meta.titleIsAutomatic && !isPlaceholderTitle(meta))) return;
      candidates = providers.filter((p) => p.id === utilityModel.provider);
    } else {
      const attempts = this.titleAttempts.get(id) ?? 0;
      if (attempts >= MAX_TITLE_ATTEMPTS || this.titleInFlight.has(id)) return;
      this.titleAttempts.set(id, attempts + 1);
    }
    const request = Symbol();
    this.titleInFlight.set(id, request);
    const prompt = 'prompt' in source ? source.prompt : currentTitle;
    void generateSessionTitle(prompt, candidates, this.deps.getSecret, utilityModel ?? meta.activeModel, this.deps.log, id, turnReply)
      .then((title) => {
        if (!title || this.titleInFlight.get(id) !== request) return;
        const current = this.get(id);
        if (!current || current.archived || current.titleIsAutomatic === false || current.title !== currentTitle) return;
        if (title === currentTitle && current.titleIsAutomatic && !current.titleIsPlaceholder) return;
        current.title = title;
        current.titleIsPlaceholder = undefined;
        current.titleIsAutomatic = true;
        this.schedulePersist(current);
        this.pushSessions();
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.titleInFlight.get(id) === request) this.titleInFlight.delete(id);
      });
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

  private disposeRuntime(id: string, active: ActiveSession, status: 'idle' | 'stopped' | 'error' = 'stopped'): Promise<void> {
    // A late dispose from a retired runtime must never revoke its replacement's capability.
    if (this.active.get(id) === active) {
      this.deps.revokeMemoryGateway?.(id);
      this.deps.mission?.()?.gateway()?.revoke(id);
    }
    return this.retireOrdinary(id, active, status === 'idle');
  }

  /**
   * Teardown: the session is released at once (a new send starts a new runtime), live items are
   * saved, disposal errors are logged, and nothing waits unboundedly: neither a pending startup nor
   * a hung dispose. `explicit` is a user Stop (the status returns to idle); otherwise the harness ended itself and
   * its own status stays.
   */
  private retireOrdinary(id: string, active: ActiveSession, explicit: boolean): Promise<void> {
    if (active.disposal) return active.disposal;
    active.tearingDown = true;
    if (active.autoCompactionRetryTimer) clearTimeout(active.autoCompactionRetryTimer);
    if (active.goalContinuationTimer) clearTimeout(active.goalContinuationTimer);
    if (active.ongoingSettleTimer) clearTimeout(active.ongoingSettleTimer);
    active.ongoingSettleTimer = null;
    active.pendingGoalKickoff = null;
    active.deferredTurnNotice = null;
    active.deferredGoalContinuation = null;
    active.ongoingBySource?.clear();
    const metaClearing = this.get(id);
    if (metaClearing && this.active.get(id) === active) metaClearing.ongoing = undefined;
    if (this.active.get(id) === active) this.active.delete(id);
    const retiring = this.retiring.get(id) ?? new Set<ActiveSession>();
    retiring.add(active);
    this.retiring.set(id, retiring);
    const operation = Promise.resolve().then(async () => {
      // Install the disposal promise before notifying observers, which may themselves request stop.
      this.cancelApprovals(id, active, 'Session stopped');
      await this.stream.flushLive(id, active, true).catch((e) => this.deps.log('warn', `[${id}] live flush on stop failed: ${errorMessage(e)}`));
      const settled = Promise.resolve()
        .then(() => active.adapter.dispose())
        .catch((e) => this.deps.log('warn', `[${id}] dispose failed: ${errorMessage(e)}`))
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
        await this.trackControlledWrite(id, Promise.resolve(this.deps.store.upsert(meta))).catch((e) => this.deps.log('warn', `[${id}] meta persist on stop failed: ${errorMessage(e)}`));
      }
      this.pushSessions();
    }).finally(() => {
      active.disposal = null;
    });
    active.disposal = operation;
    return operation;
  }

  async interrupt(id: string): Promise<void> {
    const skill = this.sharedSkillAdmissions.get(id);
    if (skill) skill.canceled = true;
    const controlled = this.controlled.get(id);
    if (controlled) {
      if (!controlled.terminal) await this.interruptControlled(id, controlled.operationId);
      return;
    }
    const active = this.active.get(id);
    if (!active) return;
    this.deps.log('info', `[${id}] interrupt requested`);
    this.cancelApprovals(id, active, 'Interrupted');
    await active.adapter.interrupt();
  }

  /** User Stop (also Archive, Delete and Move): never fails or wedges an ordinary session. */
  async stop(id: string): Promise<void> {
    const controlled = this.controlled.get(id);
    if (controlled) controlled.canceled = true;
    await this.stopOrdinary(id);
  }

  private async stopOrdinary(id: string): Promise<void> {
    const skill = this.sharedSkillAdmissions.get(id);
    if (skill) skill.canceled = true;
    const controlled = this.controlled.get(id);
    if (controlled) {
      controlled.canceled = true;
      controlled.uncertain = true;
      this.endControlled(controlled, 'unknown');
    }
    const active = this.active.get(id);
    if (!active) return;
    this.deps.log('info', `[${id}] stopping ${active.adapter.id}${active.adapter.busy ? ' (turn in progress)' : ''}`);
    await this.disposeRuntime(id, active, 'idle');
  }

  /** App quit. Never rejects, so the caller still flushes persistence and analytics afterwards. */
  async stopAll(): Promise<void> {
    const ids = [...new Set([...this.active.keys(), ...this.controlled.keys(), ...this.sharedSkillAdmissions.keys()])];
    if (ids.length) this.deps.log('info', `stopping ${ids.length} running session(s)`);
    const results = await Promise.allSettled(ids.map((id) => this.stopOrdinary(id)));

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
    this.assertNotControlled(id);
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    if (this.fastModeUpdates.has(id)) throw new Error('Wait for the Fast mode update to finish.');
    if (meta.config.fastMode && !fastModeSupport(meta.config.harness, model, this.settings().providers).supported) {
      throw new Error('Turn off Fast mode before switching to this model.');
    }
    if (this.configDispatches.has(id)) throw new Error('Wait for the current message to be accepted before switching models.');
    const active = this.active.get(id);
    this.fastModeUpdates.add(id);
    try {
      // Do not publish or persist the requested model until the harness accepts the switch.
      if (active) await active.adapter.setModel(model);
      if (this.get(id) !== meta || this.active.get(id) !== active) throw new Error('Session runtime changed during the model update.');
      this.deps.log('info', `[${id}] model ${describeModel(meta.activeModel)} → ${describeModel(model)}${active ? '' : ' (applies at next start)'}`);
      meta.config.model = model;
      meta.activeModel = model;
      this.deps.analytics.touchSession(meta);
      await this.deps.store.upsert(meta);
      this.pushSessions();
      return meta;
    } finally {
      this.fastModeUpdates.delete(id);
    }
  }

  async setEffort(id: string, effort: EffortLevel): Promise<SessionMeta> {
    return this.withoutControlled(id, () => this.setEffortUncontrolled(id, effort));
  }

  private async setEffortUncontrolled(id: string, effort: EffortLevel): Promise<SessionMeta> {
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

  async setFastMode(id: string, enabled: boolean): Promise<SessionMeta> {
    this.assertNotControlled(id);
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    if (typeof enabled !== 'boolean') throw new Error('Fast mode must be a boolean');
    if (this.fastModeUpdates.has(id)) throw new Error('Wait for the Fast mode update to finish.');
    const active = this.active.get(id);
    const activity = this.activity(id);
    if (this.configDispatches.has(id) || active?.starting || activity.turn || activity.tools || activity.nativeChildren || activity.approvals || activity.compacting || activity.queued || activity.tearingDown || activity.uncertain) {
      throw new Error('Wait for the session to be idle before changing Fast mode.');
    }
    if (enabled) {
      const support = fastModeSupport(meta.config.harness, meta.activeModel ?? meta.config.model, this.settings().providers);
      if (!support.supported || meta.config.codexModelProvider) throw new Error(support.reason ?? 'Fast mode is not supported by this custom Codex provider.');
      if (active && !active.adapter.setFastMode) throw new Error('This runtime cannot change Fast mode.');
    }
    const previous = meta.config.fastMode;
    const status = meta.fastModeStatus;
    this.fastModeUpdates.add(id);
    let applied = false;
    try {
      if (active?.adapter.setFastMode) {
        await active.adapter.setFastMode(enabled);
        applied = true;
      }
      if (this.get(id) !== meta || this.active.get(id) !== active) throw new Error('Session runtime changed during the Fast mode update.');
      meta.config.fastMode = enabled;
      if (!active || meta.fastModeStatus === status) meta.fastModeStatus = { state: enabled ? 'requested' : 'off' };
      await this.deps.store.upsert(meta);
      this.deps.log('info', `[${id}] Fast mode ${enabled ? 'requested' : 'off'}`);
      this.pushSessions();
      return meta;
    } catch (error) {
      meta.config.fastMode = previous;
      if (applied && this.active.get(id) === active) {
        try {
          await active!.adapter.setFastMode!(previous === true);
        } catch {
          // If rollback cannot prove the old billing preference, stop rather than send another turn.
          await this.stopOrdinary(id);
        }
      }
      // Re-applying the old preference is not evidence that its old tier is active again.
      meta.fastModeStatus = applied ? { state: previous ? 'requested' : 'off' } : status;
      if (this.get(id) === meta) await this.deps.store.upsert(meta).catch(() => undefined);
      this.pushSessions();
      throw error;
    } finally {
      this.fastModeUpdates.delete(id);
    }
  }

  async setPermissionMode(id: string, mode: PermissionMode): Promise<SessionMeta> {
    return this.withoutControlled(id, () => this.setPermissionUncontrolled(id, mode));
  }

  private async setPermissionUncontrolled(id: string, mode: PermissionMode): Promise<SessionMeta> {
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    // The Lead coordinates and never edits: Plan is what makes that true on every harness.
    if (meta.mission?.role === 'lead' && mode !== 'plan') throw new Error('A Mission Lead always runs in Plan.');
    assertPermissionModeOffered(meta.config.harness, mode);
    const antigravity = meta.config.harness === 'antigravity';
    const active = this.active.get(id);
    if (antigravity) {
      if ((this.configDispatches.get(id) ?? 0) > 1 || active?.starting || active?.turnPending || active?.adapter.busy || meta.queued) {
        throw new Error('Wait for the current Antigravity activity before changing permissions.');
      }
      this.antigravityModeUpdates.add(id);
    }
    const apply = async () => {
      if (active && (this.active.get(id) !== active || active.tearingDown)) throw new Error('Session runtime changed before permission update.');
      // Permission changes are the one setting worth an audit trail: they decide what runs unasked.
      if (antigravity) {
        await active?.adapter.setPermissionMode(mode);
        if (this.get(id) !== meta || this.active.get(id) !== active || active?.tearingDown) {
          throw new Error('Session runtime changed before permission update.');
        }
      }
      this.deps.log('info', `[${id}] permission mode ${meta.config.permissionMode} → ${mode}`);
      meta.config.permissionMode = mode;
      if (mode === 'plan') this.deps.restrictMemoryGateway?.(id);
      if (!antigravity) await active?.adapter.setPermissionMode(mode);
      await this.deps.store.upsert(meta);
    };
    try {
      await apply();
    } finally {
      if (antigravity) this.antigravityModeUpdates.delete(id);
    }
    this.pushSessions();
    this.emit(id, { type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level: 'info', text: `Permission mode set to ${mode}.` } });
    return meta;
  }

  compact(id: string): Promise<{ ok: boolean; detail?: string }> {
    return this.compaction.compact(id);
  }

  /** Recover first: the background startup scan may not have reached this transcript yet. */
  private async preserveUserInputs(meta: SessionMeta, items: TranscriptItem[]): Promise<void> {
    if (!items.some((item) => item.kind === 'user' && item.userInput?.sessionId === meta.id)) return;
    this.deps.analytics.recordUserInputs(meta, items);
    // A failed write leaves the recovery source intact so the operation can be retried.
    await this.deps.analytics.flush(true);
  }

  async clearTranscript(id: string): Promise<void> {
    return this.withoutControlled(id, () => this.clearUncontrolled(id));
  }

  private async clearUncontrolled(id: string): Promise<void> {
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    await this.preserveUserInputs(meta, await this.deps.store.readTranscript(id));
    const active = this.active.get(id);
    if (active) {
      active.liveItems.clear();
      this.stream.resetCheckpoints(active);
    }
    await this.deps.store.rewriteTranscript(id, []);
    this.deps.log('info', `[${id}] transcript cleared`);
  }

  async respondApproval(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    return this.resolveApproval(sessionId, requestId, decision, 'user');
  }

  /** The user's answer, or a mission Builder's Lead answering through `answer_request`. */
  async resolveApproval(sessionId: string, requestId: string, decision: ApprovalDecision, by: 'user' | 'lead'): Promise<void> {
    const active = this.active.get(sessionId);
    const d = active?.approvals.get(requestId);
    if (!active || !d) {
      // A stale card (the harness moved on, or the session stopped) is not an error, but it is worth knowing.
      this.deps.log('debug', `[${sessionId}] approval ${requestId} answered "${decision.optionId}" but is no longer pending`);
      return;
    }
    const item = active.liveItems.get(requestId);
    // A rejected response must leave both the pending dialog and its editable audit card intact.
    if (item?.kind === 'approval') validateQuestionResponse(item.request, decision);
    active.approvals.delete(requestId);
    d.resolve(decision);
    // Audit trail for what the user allowed the agent to do; the command itself is on the transcript card.
    this.deps.log('info', `[${sessionId}] approval ${requestId} → ${decision.optionId}${!active.sharedSkillTurn && item?.kind === 'approval' ? ` (${item.request.title.slice(0, 120)})` : ''}`);
    if (item && item.kind === 'approval') {
      item.decision = decision;
      item.decidedAt = Date.now();
      if (item.request.mission) item.decidedBy = by;
      this.emit(sessionId, { type: 'item.upsert', item: { ...item } });
    }
    const meta = this.get(sessionId);
    if (meta && active.approvals.size === 0 && meta.status === 'awaiting') {
      const status = active.adapter.busy || active.turnPending ? 'running' : 'idle';
      this.emit(sessionId, { type: 'status', status });
    }
    this.emit(sessionId, { type: 'approval.resolved', requestId, decision });
  }

  /**
   * A mission Builder's request changed hands: the Lead recommended a verdict on one only the user
   * may answer, so it now waits for the user (who is notified), or the Lead's view is attached.
   */
  updateApprovalRoute(sessionId: string, requestId: string, route: ApprovalMissionRoute): void {
    const active = this.active.get(sessionId);
    const item = active?.liveItems.get(requestId);
    if (!active?.approvals.has(requestId) || item?.kind !== 'approval') return;
    const wasWithUser = item.request.mission?.status === 'with_user';
    item.request = { ...item.request, mission: route };
    this.emit(sessionId, { type: 'item.upsert', item: { ...item } });
    if (route.status === 'with_user' && !wasWithUser) {
      const meta = this.get(sessionId);
      if (meta) this.deps.notify(sessionId, `${meta.title}: approval needed`, item.request.command ?? item.request.title);
    }
  }

  private requestApproval(sessionId: string, draft: ApprovalDraft): Promise<ApprovalDecision> {
    const active = this.active.get(sessionId);
    const meta = this.get(sessionId);
    if (!active || !meta || active.tearingDown) return Promise.resolve({ optionId: 'deny', note: 'Session gone' });
    const request: ApprovalRequest = { ...draft, id: shortId('ap_'), sessionId, harness: meta.config.harness, createdAt: Date.now() };
    const d = deferred<ApprovalDecision>();
    active.approvals.set(request.id, d);
    this.deps.log('info', `[${sessionId}] approval ${request.id} requested (${meta.config.permissionMode})${active.sharedSkillTurn ? '' : `: ${request.title.slice(0, 120)}`}`);
    meta.status = 'awaiting';
    meta.statusDetail = request.title;
    const hooks = meta.mission?.role === 'builder' && draft.kind !== 'question' ? this.deps.mission?.() : undefined;
    const publish = (route?: ApprovalMissionRoute) => {
      // The runtime may have moved on (or the card was answered) while the request was classified.
      if (!active.approvals.has(request.id)) return;
      if (route) request.mission = route;
      this.emit(sessionId, { type: 'item.upsert', item: { id: request.id, kind: 'approval', ts: Date.now(), request } });
      this.emit(sessionId, { type: 'approval.request', request });
      this.pushSessions();
      // A request with the Lead does not need the user yet; the Lead may still hand it on.
      if (route?.status !== 'with_lead') this.deps.notify(sessionId, `${meta.title}: approval needed`, request.command ?? request.title);
    };
    if (!hooks) publish();
    else {
      // A Builder's request goes to its Lead first; an unclassifiable one reaches the user.
      hooks.routeApproval(meta, request).then(publish, (e) => {
        this.deps.log('warn', `[${sessionId}] mission approval routing failed: ${errorMessage(e)}`);
        publish({ route: 'user', reason: 'could not be classified', status: 'with_user' });
      });
    }
    return d.promise;
  }

  /** Central event sink: persists transcript, updates meta, forwards to renderer, drives goals. */
  private emit(sessionId: string, event: SessionEvent, runtime?: ActiveSession): void {
    if (runtime) this.observeControlled(sessionId, runtime, event);
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
    // Harness errors can contain the prompt. Keep normal model/tool output and approval cards,
    // but do not forward arbitrary provider diagnostics into the app's history and logs.
    const shared = (runtime ?? active)?.sharedSkillTurn;
    if (shared) {
      if (event.type === 'error') event = { ...event, message: SHARED_SKILL_RUNTIME_ERROR };
      else if (event.type === 'status' && event.detail && (event.status === 'error' || event.status === 'stopped')) {
        event = { ...event, detail: SHARED_SKILL_RUNTIME_ERROR };
      } else if (event.type === 'item.upsert' && event.item.kind === 'turn' && event.item.error) {
        event = { ...event, item: { ...event.item, error: SHARED_SKILL_RUNTIME_ERROR } };
      } else if (event.type === 'item.upsert' && event.item.kind === 'info' && event.item.level !== 'info') {
        event = { ...event, item: { ...event.item, text: SHARED_SKILL_RUNTIME_ERROR } };
      } else if (event.type === 'meta') {
        const { title: _title, lastError: _lastError, statusDetail: _detail, ...patch } = event.patch;
        event = { ...event, patch };
      }
    }
    // Ownership/configuration are host-owned even if an adapter emits the broad normalized meta shape.
    // Mission identity is host-owned: an adapter's broad meta patch can never set it.
    if (event.type === 'meta' && 'mission' in event.patch) {
      const { mission: _ignored, ...rest } = event.patch;
      event = { ...event, patch: rest };
    }
    if (this.controlled.has(sessionId) && event.type === 'meta') {
      const patch = event.patch;
      const { activeModel, activeEffort, title, queued, statusDetail, harnessCommands, harnessCommandList } = patch;
      const allowed = { activeModel, activeEffort, title, queued, statusDetail, harnessCommands, harnessCommandList };
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
          if (streaming) this.stream.checkpointStream(sessionId, active, item);
          else active.checkpoints?.delete(item.id);
        }
        if (item.kind === 'turn' && active) active.turnPending = undefined;
        if (item.kind === 'turn' && meta) this.onTurnFinished(meta, item);
        if (item.kind === 'user' && meta) this.deps.analytics.recordUserMessage(meta, item);
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
            if (item.streaming) this.stream.checkpointStream(sessionId, active!, item);
          } else if (item.kind === 'tool' && event.outputDelta) item.output = (item.output ?? '') + event.outputDelta;
          active?.dirty.add(event.id);
        }
        break;
      }
      case 'status': {
        if (meta) {
          if (event.status === 'idle' && active && active.approvals.size) break; // still awaiting
          if (event.status === 'starting' || event.status === 'running' || event.status === 'awaiting' || event.status === 'error') {
            this.gitState.cancel(sessionId);
          }
          if (event.status === 'running' && active) {
            if (active.ongoingSettleTimer) {
              clearTimeout(active.ongoingSettleTimer);
              active.ongoingSettleTimer = null;
            }
            active.deferredTurnNotice = null;
            active.deferredGoalContinuation = null;
          }
          if ((event.status === 'stopped' || event.status === 'error') && active) {
            if (active.ongoingSettleTimer) {
              clearTimeout(active.ongoingSettleTimer);
              active.ongoingSettleTimer = null;
            }
            active.deferredTurnNotice = null;
            active.deferredGoalContinuation = null;
            active.ongoingBySource?.clear();
            for (const [childId, child] of active.nativeChildren ?? []) {
              if (child.running) active.nativeChildren.set(childId, { ...child, running: false });
            }
            meta.ongoing = undefined;
          }
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
              if (event.status === 'idle' && !active.turnPending && !active.adapter.busy && !active.uncertain) active.sharedSkillTurn = undefined;
              // A harness that exited will never finish its streaming answer; save what it said.
              void this.stream.flushLive(sessionId, active, event.status === 'stopped').catch((e) => this.deps.log('warn', `[${sessionId}] live flush failed: ${errorMessage(e)}`));
              if (event.status === 'stopped') {
                // The harness exited on its own: pending approvals would hang forever and the
                // adapter must be disposed, mirroring the fatal-error path.
                void this.disposeRuntime(sessionId, active).catch((e) => this.deps.log('warn', `[${sessionId}] dispose after harness stop failed: ${errorMessage(e)}`));
              }
            }
            this.schedulePersist(meta);
          }
          if (event.status === 'stopped' && !gitParked && meta.worktreeBranch) this.gitState.schedule(sessionId);
          // Status events are the live source of truth for the sidebar. Terminal statuses also
          // persist above, but every transition must be published immediately.
          this.pushSessions();
          if (event.status === 'idle') {
            this.compaction.scheduleAuto(meta.id);
            this.gitState.schedule(meta.id);
            // A goal installed while another turn was in flight belongs to the next turn, not
            // the old reply. Wait for this idle boundary even if that turn was interrupted.
            this.goals.onIdle(sessionId, meta, active);
          }
        }
        break;
      }
      case 'usage':
        if (meta) {
          meta.usage = event.totals;
          this.deps.analytics.recordUsage(meta, event.totals, undefined, event.subagentCostByModel);
          this.schedulePersist(meta);
          this.pushSessions();
          this.compaction.onUsage(meta, active, event.totals);
        }
        break;
      case 'subagent.run': {
        const children = active ? (active.nativeChildren ??= new Map()) : undefined;
        const previous = children?.get(event.run.runId);
        if (active && children && (!previous || previous.startedAt === event.run.startedAt && previous.running)) {
          children.set(event.run.runId, {
            startedAt: event.run.startedAt,
            running: event.run.status === 'running',
            agent: event.run.agent,
            description: event.run.description,
            mode: event.run.mode,
            turns: event.run.turns,
            toolUses: event.run.toolUses
          });
          this.stream.syncOngoing(sessionId, active);
        }
        break;
      }
      case 'ongoing': {
        if (active) {
          const sources = (active.ongoingBySource ??= new Map());
          if (event.items.length) sources.set(event.source, event.items);
          else sources.delete(event.source);
          this.stream.syncOngoing(sessionId, active);
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
   *  client. */
  private publish(sessionId: string, event: SessionEvent): void {
    const lease = this.controlled.get(sessionId);
    const control = lease?.dispatched ? { operationId: lease.operationId, inputId: lease.inputId, runtimeId: lease.runtimeId, ...(lease.turnId ? { turnId: lease.turnId } : {}) } : undefined;
    const env: SessionEventEnvelope = { sessionId, event, ts: Date.now(), seq: ++this.seq, ...(control ? { control } : {}) };
    this.deps.pushEvent(env);
    for (const listener of [...this.listeners]) {
      try { listener(env); }
      catch (e) { this.deps.log('warn', `session event observer failed: ${errorMessage(e)}`); }
    }
  }

  /** Transcript appends must never reject into the void; log a warning instead. */
  private appendTranscript(sessionId: string, item: TranscriptItem): void {
    this.trackControlledWrite(sessionId, this.deps.store.appendTranscript(sessionId, item)).catch((e) => this.deps.log('warn', `[${sessionId}] transcript append failed (${item.kind} ${item.id}): ${errorMessage(e)}`));
  }

  private onTurnFinished(meta: SessionMeta, turn: Extract<TranscriptItem, { kind: 'turn' }>): void {
    this.deps.analytics.recordTurn(meta, turn);
    // One line per turn is the timeline a slow or expensive session is diagnosed from.
    this.deps.log(
      turn.status === 'failed' ? 'warn' : 'info',
      `[${meta.id}] turn ${turn.status}${turn.durationMs !== undefined ? ` in ${(turn.durationMs / 1000).toFixed(1)}s` : ''}${turn.usage ? ` (${turn.usage.inputTokens} in / ${turn.usage.outputTokens} out)` : ''}${turn.costUsd ? ` $${turn.costUsd.toFixed(4)}` : ''}${turn.error ? `: ${turn.error}` : ''}`
    );
    const active = this.active.get(meta.id);
    const ongoingActive = !!active && hasOngoingWork(meta);
    // If autonomous background work (subagents, background tasks, hooks) is still running when this
    // parent turn finishes, defer the "done · not viewed" badge and desktop notification until that
    // background work settles (or is superseded by its follow-up parent turn).
    if (turn.status !== 'interrupted' && ongoingActive) {
      active.deferredTurnNotice = { ts: turn.ts, status: turn.status, ...(turn.error ? { error: turn.error } : {}) };
    } else {
      // A turn that ends with nobody looking stays "done · not viewed" until the session is viewed.
      // An interrupt is the user's own doing.
      if (turn.status !== 'interrupted' && !meta.archived && !this.deps.isViewing?.(meta.id)) {
        meta.unseenAt = turn.ts;
        if (turn.status === 'failed') meta.unseenFailed = true;
        else delete meta.unseenFailed;
        this.schedulePersist(meta);
        this.pushSessions();
      }
      if (this.settings().notifications && turn.status !== 'interrupted') {
        this.deps.notify(meta.id, meta.title, turn.status === 'completed' ? 'Turn finished' : `Turn ${turn.status}${turn.error ? `: ${turn.error}` : ''}`);
      }
    }
    // An answer belongs to one turn only. In particular, a pre-goal answer must not be
    // mistaken for the next kickoff's answer if that turn produces no assistant text.
    const text = active?.lastAssistantText ?? '';
    if (active) active.lastAssistantText = '';
    // The selected model may echo skill text. Do not forward its reply to a titling model.
    if (this.controlled.has(meta.id) || active?.sharedSkillTurn) return;
    if (active && turn.status === 'completed') {
      this.scheduleLlmTitle(meta.id, { turnReply: text });
      this.goals.onTurnCompleted(meta, active, text, ongoingActive);
    }
  }

  async goal(id: string, action: GoalAction, opts: GoalActionOpts): Promise<SessionMeta> {
    return this.withoutControlled(id, () => this.goals.applyAction(id, action, opts));
  }

  /** Recomputes `/goal` ownership everywhere: the preference is app-wide and the advertised lists are per harness. */
  refreshGoalDrivers(): Promise<void> {
    return this.goals.refreshDrivers();
  }

  private applyGoalDriver(meta: SessionMeta, current = () => true): Promise<boolean> {
    return this.goals.applyDriver(meta, current);
  }

  /**
   * Relocates a session to another directory (worktree switch). A running harness is stopped;
   * provider resume state is tied to the old directory, so it is dropped (the app transcript stays).
   */
  async moveTo(id: string, cwd: string): Promise<SessionMeta> {
    return this.withoutControlled(id, () => this.moveUncontrolled(id, cwd));
  }

  private async moveUncontrolled(id: string, cwd: string): Promise<SessionMeta> {
    const meta = this.get(id);
    if (!meta) throw new Error('Session not found');
    if (meta.mission) throw new Error('A mission session stays in the mission’s worktree.');
    if (!path.isAbsolute(cwd)) throw new Error('Worktree path must be absolute');
    if (path.resolve(meta.cwd) === path.resolve(cwd)) return meta;
    const wasRunning = !!this.active.get(id);
    if (wasRunning) await this.stop(id);
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

  /**
   * A worktree branch name for what the first prompt asks for. The background model that titles
   * sessions names it when one is usable (the utility model, else the model chosen for the
   * session); otherwise, or when it fails, the prompt's own words with the filler dropped.
   */
  async suggestBranchName(prompt: string, model?: ModelRef): Promise<{ name: string; source: 'model' | 'prompt' }> {
    const text = prompt.trim().slice(0, 4000);
    if (!text) return { name: '', source: 'prompt' };
    const named = await generateBranchName(text, this.settings().providers, this.deps.getSecret, this.settings().utilityModel ?? model, this.deps.log);
    return named ? { name: named, source: 'model' } : { name: branchNameFromText(text), source: 'prompt' };
  }

  fork(id: string, harness?: HarnessId): Promise<SessionMeta | null> {
    return forkSession(
      {
        store: this.deps.store,
        getSession: (sessionId) => this.get(sessionId),
        transcript: (sessionId) => this.transcript(sessionId),
        settings: () => this.settings(),
        pushSessions: () => this.pushSessions(),
        log: (level, message) => this.deps.log(level, message)
      },
      id,
      harness
    );
  }

  async exportMarkdown(id: string): Promise<string> {
    return exportSessionMarkdown(this.get(id), await this.transcript(id));
  }

  async projectRootFor(cwd: string): Promise<string | null> {
    return gitRoot(cwd);
  }
}
