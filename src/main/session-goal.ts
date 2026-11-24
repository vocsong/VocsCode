/**
 * Goal automation engine and `/goal` driver routing for SessionManager.
 *
 * Manages app-driven goal kickoff/continuation loops (including mid-turn kickoffs, iteration guard,
 * completion detection, and deferred continuation while background work runs) as well as resolving
 * whether `/goal` belongs to the harness or the app.
 */
import type { AppSettings, GoalState, HarnessId, SessionEvent, SessionMeta, UserInput } from '../shared/types';
import { nativeGoalCommand } from '../shared/goal-driver';
import { hasOngoingWork } from '../shared/ongoing';
import type { ActiveSession } from './session-types';
import { skillInstalled } from './skills';
import { errorMessage, shortId } from './util/async';

export const GOAL_COMPLETE_TOKEN = 'GOAL_COMPLETE';
/** A goal continuation lands on the first free moment; a compaction can hold the session for minutes. */
const GOAL_CONTINUATION_RETRY_MS = 5_000;
const GOAL_CONTINUATION_MAX_ATTEMPTS = 60;

export type GoalAction = 'set' | 'pause' | 'resume' | 'clear' | 'complete' | 'update';

export interface GoalActionOpts {
  objective?: string;
  autoContinue?: boolean;
  maxIterations?: number;
}

export interface SessionGoalHost {
  listSessions(): SessionMeta[];
  getSession(id: string): SessionMeta | undefined;
  getActive(id: string): ActiveSession | undefined;
  isControlled(id: string): boolean;
  settings(): AppSettings;
  upsertSession(meta: SessionMeta): Promise<void>;
  schedulePersist(meta: SessionMeta): void;
  pushSessions(): void;
  emit(sessionId: string, event: SessionEvent): void;
  sendGoalPrompt(sessionId: string, input: UserInput): Promise<void>;
  notify(sessionId: string, title: string, body: string): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

export class SessionGoalController {
  constructor(private readonly host: SessionGoalHost) {}

  kickoffPrompt(goal: GoalState): string {
    return `You have a persistent goal for this session:\n\n<goal>\n${goal.objective}\n</goal>\n\n<execution_instructions>\nWork toward the goal above autonomously. When you believe it is fully achieved and verified, run a completion audit (restate deliverables, map each requirement to concrete evidence, note gaps) and end your reply with the exact token ${GOAL_COMPLETE_TOKEN} on its own line. If anything is missing, keep working instead of declaring completion.\n</execution_instructions>`;
  }

  resumePrompt(goal: GoalState): string {
    return `Resuming the goal: ${goal.objective}\nContinue where you left off.`;
  }

  /** Evaluates goal completion or continuation when a non-controlled turn finishes. */
  onTurnCompleted(meta: SessionMeta, active: ActiveSession, assistantText: string, ongoingActive: boolean): void {
    const goal = meta.goal;
    if (!goal || goal.status !== 'active') return;
    // This reply began before the new goal was submitted. Its token (or lack of one) says
    // nothing about that goal; the idle transition will deliver the kickoff separately.
    if (active.pendingGoalKickoff?.goal === goal) return;
    if (assistantText.includes(GOAL_COMPLETE_TOKEN)) {
      goal.status = 'complete';
      goal.updatedAt = Date.now();
      this.host.log('info', `[${meta.id}] goal complete after ${goal.iterations} continuation(s)`);
      this.host.schedulePersist(meta);
      this.host.pushSessions();
      this.host.emit(meta.id, {
        type: 'item.upsert',
        item: {
          id: shortId('i_'),
          kind: 'info',
          ts: Date.now(),
          level: 'info',
          text: `Goal marked complete after ${goal.iterations} continuation${goal.iterations === 1 ? '' : 's'}.`
        }
      });
      this.host.notify(meta.id, meta.title, 'Goal complete');
      return;
    }
    if (!goal.autoContinue) return;
    // While autonomous background subagents/tasks are still running, wait for them to report back
    // rather than burning a goal iteration with a redundant check-in.
    if (ongoingActive) {
      active.deferredGoalContinuation = { goal };
      this.host.log('info', `[${meta.id}] goal continuation deferred while ${meta.ongoing!.length} background item(s) are running`);
      return;
    }
    this.advanceContinuation(meta, active);
  }

  /** Delivers a mid-turn goal kickoff once the session reaches its next idle boundary. */
  onIdle(sessionId: string, meta: SessionMeta, active: ActiveSession | undefined): void {
    const pending = active?.pendingGoalKickoff;
    if (pending && meta.goal === pending.goal && meta.goal.status === 'active') {
      const prompt = pending.resume ? this.resumePrompt(pending.goal) : this.kickoffPrompt(pending.goal);
      this.scheduleContinuation(sessionId, prompt, 0, pending);
    }
  }

  advanceContinuation(meta: SessionMeta, active: ActiveSession): void {
    const goal = meta.goal;
    if (!goal || goal.status !== 'active' || !goal.autoContinue) return;
    if (goal.iterations >= goal.maxIterations) {
      goal.status = 'paused';
      goal.updatedAt = Date.now();
      this.host.log('info', `[${meta.id}] goal paused at the ${goal.maxIterations}-iteration guard`);
      this.host.schedulePersist(meta);
      this.host.pushSessions();
      this.host.emit(meta.id, {
        type: 'item.upsert',
        item: {
          id: shortId('i_'),
          kind: 'info',
          ts: Date.now(),
          level: 'warn',
          text: `Goal paused: reached the ${goal.maxIterations}-iteration guard. Resume it from the Goal panel.`
        }
      });
      return;
    }
    goal.iterations += 1;
    goal.updatedAt = Date.now();
    this.host.log('info', `[${meta.id}] goal continuation ${goal.iterations}/${goal.maxIterations} scheduled`);
    this.host.schedulePersist(meta);
    const prompt = `Goal check-in ${goal.iterations}/${goal.maxIterations}.\n\n<goal>\n${goal.objective}\n</goal>\n\n<execution_instructions>\nContinue executing the goal above. Use prior results as context and avoid repeating completed work; prioritize concrete progress.\nOnly when the goal is fully achieved and verified, provide a brief completion audit and end your reply with the exact token ${GOAL_COMPLETE_TOKEN} on its own line. Otherwise keep working without asking for permission to continue.\n</execution_instructions>`;
    void active;
    this.scheduleContinuation(meta.id, prompt);
  }

  /**
   * Deliver a goal's auto-continuation on the first free moment. A compaction started by the turn
   * that just ended holds the session for minutes; dropping the continuation there ended autonomous
   * runs silently, so a busy session is waited out instead. Each attempt re-reads the session, and
   * a newer turn's continuation replaces this one rather than racing it.
   */
  scheduleContinuation(
    id: string,
    prompt: string,
    attempt = 0,
    pending?: ActiveSession['pendingGoalKickoff']
  ): void {
    const active = this.host.getActive(id);
    if (!active || this.host.isControlled(id)) return;
    const expectedGoal = pending?.goal ?? this.host.getSession(id)?.goal;
    if (attempt === 0 && active.goalContinuationTimer) {
      clearTimeout(active.goalContinuationTimer);
      active.goalContinuationTimer = null;
    }
    const timer = setTimeout(() => {
      active.goalContinuationTimer = null;
      if (this.host.getActive(id) !== active) return;
      const meta = this.host.getSession(id);
      if (!meta || meta.goal !== expectedGoal || meta.goal?.status !== 'active') return;
      if (pending && active.pendingGoalKickoff !== pending) return;
      // A normal continuation belongs to the turn behind an approval. A new goal's kickoff,
      // however, must survive that turn, even if it pauses for approval in the meantime.
      if (meta.status === 'awaiting' && !pending) return;
      if (!pending && hasOngoingWork(meta)) {
        // Active background work can legitimately run longer than the busy retry window; wait
        // without burning attempts.
        this.scheduleContinuation(id, prompt, Math.max(1, attempt), pending);
        return;
      }
      if (meta.status === 'running' || meta.status === 'starting' || meta.status === 'awaiting' || active.adapter.busy) {
        if (attempt + 1 >= GOAL_CONTINUATION_MAX_ATTEMPTS) {
          this.host.log('warn', `[${id}] goal continuation gave up after ${attempt + 1} attempts with the session busy`);
          return;
        }
        this.scheduleContinuation(id, prompt, attempt + 1, pending);
        return;
      }
      if (pending) active.pendingGoalKickoff = null;
      void this.host.sendGoalPrompt(id, { text: prompt }).catch((e) => this.host.log('warn', `[${id}] goal continue failed: ${errorMessage(e)}`));
    }, attempt === 0 ? 1500 : GOAL_CONTINUATION_RETRY_MS);
    timer.unref?.();
    active.goalContinuationTimer = timer;
  }

  async applyAction(id: string, action: GoalAction, opts: GoalActionOpts): Promise<SessionMeta> {
    const meta = this.host.getSession(id);
    if (!meta) throw new Error('Session not found');
    if (meta.config.harness === 'antigravity') throw new Error('Antigravity sessions are driven by direct user prompts.');
    // Mission mode drives its own continuation: a goal loop beside the Lead would bypass it.
    if (meta.mission && action !== 'clear') throw new Error('Mission sessions cannot run a goal; the Lead drives the work.');
    const s = this.host.settings();
    const active = this.host.getActive(id);
    if (action !== 'update' && active) {
      // Replacing, pausing or clearing a goal invalidates its pending kickoff/continuation.
      if (active.goalContinuationTimer) clearTimeout(active.goalContinuationTimer);
      active.goalContinuationTimer = null;
      active.pendingGoalKickoff = null;
      active.deferredGoalContinuation = null;
    }
    this.host.log(
      'info',
      `[${id}] goal ${action}${opts.maxIterations !== undefined ? ` maxIterations=${opts.maxIterations}` : ''}${opts.autoContinue !== undefined ? ` autoContinue=${opts.autoContinue}` : ''}`
    );
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
        this.host.emit(id, {
          type: 'item.upsert',
          item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level: 'info', text: `Goal set: ${meta.goal.objective}` }
        });
        this.start(id, meta, false);
        break;
      }
      case 'pause':
        if (meta.goal) meta.goal.status = 'paused';
        break;
      case 'resume':
        if (meta.goal) {
          meta.goal.status = 'active';
          this.start(id, meta, true);
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
    await this.host.upsertSession(meta);
    this.host.pushSessions();
    return meta;
  }

  /** Kick off now if free; otherwise reserve the first idle boundary after the current turn. */
  private start(id: string, meta: SessionMeta, resume: boolean): void {
    const goal = meta.goal!;
    const prompt = resume ? this.resumePrompt(goal) : this.kickoffPrompt(goal);
    const active = this.host.getActive(id);
    if (active && (meta.status === 'running' || meta.status === 'awaiting' || meta.status === 'starting' || active.adapter.busy)) {
      active.pendingGoalKickoff = { goal, resume };
      // A busy adapter can be compacting while metadata is idle, without another status event.
      if (meta.status === 'idle') this.scheduleContinuation(id, prompt, 0, active.pendingGoalKickoff);
    } else {
      void this.host.sendGoalPrompt(id, { text: prompt }).catch((e) => this.host.emit(id, { type: 'error', message: errorMessage(e) }));
    }
  }

  /**
   * `/goal` belongs to the harness when it has a goal command of its own. The list the adapter reports
   * is authoritative; before a harness has started (it starts on the first send, so a brand-new session
   * has no list yet) a `goal` skill on disk stands in for it — Claude only, and only when the CLI is
   * configured to load `~/.claude` at all.
   */
  resolveNativeGoal(meta: SessionMeta): Promise<string | null> {
    return this.harnessGoal(meta.config.harness, meta.harnessCommands);
  }

  /** The same rule keyed by harness alone, for a session that does not exist yet (`create()`). */
  async harnessGoal(harness: HarnessId, advertised?: string[]): Promise<string | null> {
    const preferHarness = this.host.settings().goalDefaults.preferHarness;
    const installed = preferHarness && !advertised?.length ? await this.harnessGoalInstalled(harness) : false;
    return nativeGoalCommand({ preferHarness, advertised, installed });
  }

  private async harnessGoalInstalled(harness: HarnessId): Promise<boolean> {
    if (harness !== 'claude') return false;
    // Without 'user' in settingSources the CLI never reads ~/.claude, so its skills cannot answer /goal.
    if (!this.host.settings().claude.settingSources.includes('user')) return false;
    return skillInstalled('claude', 'goal');
  }

  /** Applies the driver to one session; true when it changed. */
  async applyDriver(meta: SessionMeta, current = () => true): Promise<boolean> {
    const next = await this.resolveNativeGoal(meta);
    if (!current()) return false;
    if (next ? meta.nativeGoal === next : meta.nativeGoal === undefined) return false;
    if (next) meta.nativeGoal = next;
    else delete meta.nativeGoal;
    return true;
  }

  /** Recomputes `/goal` ownership everywhere: the preference is app-wide and the advertised lists are per harness. */
  async refreshDrivers(): Promise<void> {
    let changed = false;
    for (const meta of this.host.listSessions()) {
      if (await this.applyDriver(meta)) {
        this.host.schedulePersist(meta);
        changed = true;
      }
    }
    if (changed) this.host.pushSessions();
  }
}
