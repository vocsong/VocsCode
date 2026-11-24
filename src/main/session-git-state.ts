/**
 * Git PR/merge status polling, transcript PR-reference caching, and concurrent repo-root lookup
 * for SessionManager.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SessionMeta, SessionStatus } from '../shared/types';
import { branchGitState, gitRoot, type BranchGitState, type PrRef, type SessionPrQuery } from './git';
import type { MissionHooks } from './mission-mode/hooks';
import type { ActiveSession } from './session-types';
import { errorMessage } from './util/async';
import { exists } from './util/fs';

export interface SessionGitStateHost {
  listSessions(): SessionMeta[];
  getSession(id: string): SessionMeta | undefined;
  getActive(id: string): ActiveSession | undefined;
  sessionDir(id: string): string;
  sessionPrRefs(id: string, opts?: { latestOnly?: boolean }): Promise<PrRef[]>;
  mission(): MissionHooks | undefined;
  schedulePersist(meta: SessionMeta): void;
  pushSessions(): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

export class SessionGitStateController {
  /** How often a session parked on 'pr' re-checks whether its branch was merged. */
  static readonly RECHECK_MS = 120_000;

  /** The timer is also the refresh generation: keep it registered until the lookup settles. */
  private timers = new Map<string, NodeJS.Timeout>();
  /** Sessions whose restored git state was re-checked once after boot. */
  readonly checked = new Set<string>();
  /** transcript stamp → PR refs, so repeated git-state checks do not re-read every transcript. */
  private prRefsCache = new Map<string, { stamp: string; refs: PrRef[]; latest: PrRef[] }>();
  private repoRootCache = new Map<string, string>();
  private repoRootPending = new Map<string, Promise<string>>();

  constructor(private readonly host: SessionGitStateHost) {}

  /**
   * Stagger boot-time git/gh probes for sessions restored while parked on 'pr' or 'stopped', so
   * dozens of sessions never spawn git/gh at the exact same instant.
   */
  scheduleRestoredChecks(list: SessionMeta[]): void {
    let stagger = 0;
    for (const s of list) {
      if ((s.status === 'pr' || s.status === 'stopped') && !this.checked.has(s.id)) {
        this.schedule(s.id, 4_000 + Math.min(stagger++, 50) * 400);
      }
    }
  }

  cancel(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  /** Schedules a PR/merge status check shortly after a turn ends in an isolated worktree. */
  schedule(id: string, delayMs = 4_000): void {
    this.cancel(id);
    this.checked.add(id);
    const timer = setTimeout(() => {
      void this.check(id, timer);
    }, delayMs);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  /** Re-runs the PR/merge state check after a local /pr or /merge completes outside a turn. */
  refresh(id: string): void {
    this.schedule(id, 1_000);
  }

  /**
   * PRs this session itself referenced (the agent's report links the PR) — the strongest
   * session→PR signal, since agents may push their own branch instead of the session
   * worktree branch, and may even work in a different repo than the session's cwd.
   */
  async sessionPrRefs(id: string, { latestOnly = false } = {}): Promise<PrRef[]> {
    // The transcript can be tens of MB and every parked-pr/stopped session is scanned once at
    // boot; stat first and reuse the result until the file actually changes.
    let file: string;
    try {
      file = path.join(this.host.sessionDir(id), 'transcript.jsonl');
    } catch {
      return [];
    }
    const st = await fs.stat(file).catch(() => undefined);
    if (!st) return [];
    const stamp = `${st.mtimeMs}:${st.size}`;
    const cached = this.prRefsCache.get(id);
    if (cached && cached.stamp === stamp) return latestOnly ? cached.latest : cached.refs;
    let raw = '';
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      return [];
    }
    const refs: PrRef[] = [];
    let last: PrRef | undefined;
    for (const m of raw.matchAll(/github\.com[/:]([\w.-]+)\/([\w.-]+?)\/pull\/(\d+)/g)) {
      last = { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
      if (!refs.some((p) => p.repo === last!.repo && p.number === last!.number)) refs.push(last);
    }
    // Keep /merge's full, first-mention order; the sidebar needs the last mention, even a repeat.
    const latest = last ? [last] : [];
    this.prRefsCache.set(id, { stamp, refs, latest });
    return latestOnly ? latest : refs;
  }

  /**
   * Git roots of other sessions' repos (cached per cwd), for resolving transcript PRs from a
   * foreign repo without spawning duplicate concurrent `git rev-parse` calls.
   */
  async knownRepoRoots(excludeId: string): Promise<string[]> {
    const roots = new Set<string>();
    await Promise.all(
      this.host.listSessions().map(async (s) => {
        if (s.id === excludeId || s.archived) return;
        const root = await this.repoRoot(s.cwd);
        if (root) roots.add(root);
      })
    );
    return [...roots];
  }

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

  /** Reflects the session branch's PR/merge state in the sidebar status label. */
  private async check(id: string, timer: NodeJS.Timeout): Promise<void> {
    if (this.timers.get(id) !== timer) return;
    const meta = this.host.getSession(id);
    if (!meta?.worktreeBranch || !this.checkable(meta)) {
      this.timers.delete(id);
      return;
    }
    const { cwd, worktreeBranch } = meta;
    const current = () =>
      this.timers.get(id) === timer &&
      this.host.getSession(id) === meta &&
      meta.cwd === cwd &&
      meta.worktreeBranch === worktreeBranch &&
      this.checkable(meta);
    try {
      const prRefs = await this.host.sessionPrRefs(id, { latestOnly: true });
      if (!current()) return;
      const q: SessionPrQuery = prRefs.length
        ? { prRefs }
        : {
            excludeBranches: this.host
              .listSessions()
              .filter((s) => s.id !== id && s.worktreeBranch)
              .map((s) => s.worktreeBranch!),
            createdAfter: meta.createdAt,
            updatedBefore: meta.updatedAt
          };
      const state: BranchGitState = await branchGitState(cwd, worktreeBranch, q);
      if (!current() || state.unknown) return;
      // A mission Lead's PR merged or closed ends the mission and frees its worktrees.
      if (meta.mission) this.host.mission()?.gitState(meta, state);
      const next: SessionStatus = state.merged ? 'merged' : state.pr ? 'pr' : 'idle';
      // Git evidence can upgrade a stopped harness, but never downgrade it to idle.
      if (meta.status === next || (meta.status === 'stopped' && next === 'idle')) return;
      meta.status = next;
      meta.statusDetail = undefined;
      this.host.schedulePersist(meta);
      this.host.pushSessions();
    } catch (e) {
      if (current()) this.host.log('warn', `pr/merge status check failed: ${errorMessage(e)}`);
    } finally {
      // Poll a parked PR even after an unchanged result or a failed probe. An old
      // completion must not clear or rearm a newer refresh's timer.
      if (meta.status === 'pr' && current()) this.schedule(id, SessionGitStateController.RECHECK_MS);
      else if (this.timers.get(id) === timer) this.timers.delete(id);
    }
  }

  /** Git labels must not replace the status that drives Interrupt, even when that status lags. */
  private checkable(meta: SessionMeta): boolean {
    if (meta.status !== 'idle' && meta.status !== 'pr' && meta.status !== 'stopped') return false;
    const active = this.host.getActive(meta.id);
    return !active || !(active.adapter.busy || active.turnPending || active.approvals.size);
  }
}
