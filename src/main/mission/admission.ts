/** Exclusive resource leases shared by Mission Git operations, model dispatch, and PTY startup.
 * These coordinate app-owned writers; they do not sandbox external editors/processes. */
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import type { SessionMeta } from '../../shared/types';
import type { TerminalActivity } from '../terminal';
import type { SessionActivity } from '../session-manager';
import type { WorkspaceQuiescenceLease } from './workspaces';

export interface WorkspaceAdmissionDeps {
  sessions(): SessionMeta[];
  activity(id: string): SessionActivity;
  terminals(): TerminalActivity[];
  released?(cwd: string): void;
}
const key = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const contains = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const overlaps = (a: string, b: string) => contains(a, b) || contains(b, a);
/** Provisioning must reserve its future directory before git creates it. Resolve the nearest
 * existing ancestor so nonexistent destinations still collide with canonical parent aliases. */
async function canonicalPath(value: string): Promise<string> {
  let current = path.resolve(value);
  const missing: string[] = [];
  for (;;) {
    try { return key(path.join(await fs.realpath(current), ...missing)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(current) === current) throw error;
      missing.unshift(path.basename(current)); current = path.dirname(current);
    }
  }
}
const writer = (activity: SessionActivity) => activity.starting || activity.turn || activity.tools > 0 || (activity.nativeChildren ?? 0) > 0 || activity.processes || activity.approvals > 0 || activity.compacting || activity.tearingDown || activity.uncertain;

export class MissionWorkspaceAdmission {
  private readonly leases = new Map<string, symbol>();
  private readonly dispatches = new Map<symbol, string>();
  private readonly waiters = new Set<() => void>();
  private closed = false;
  constructor(private readonly deps: WorkspaceAdmissionDeps) {}

  private held(cwd: string): boolean { return [...this.leases.keys()].some((root) => overlaps(root, cwd)); }

  /** Used by synchronous PTY startup, immediately before spawn; restored tabs also pass here. */
  assertAvailableSync(cwd: string): void {
    if (this.closed) throw new Error('Workspace admission has closed.');
    if (this.held(key(realpathSync(cwd)))) throw new Error('Mission is capturing or reconciling this workspace. Wait for the operation to settle before opening a shell.');
  }

  async assertAvailable(cwd: string): Promise<void> {
    if (this.closed) throw new Error('Workspace admission has closed.');
    const canonical = await canonicalPath(cwd);
    if (this.closed || this.held(canonical)) throw new Error('Workspace is reserved by a Mission operation.');
  }

  /** Ordinary source sessions wait without being interrupted; release, not a timer, wakes them. */
  async wait(cwd: string): Promise<void> {
    const canonical = await canonicalPath(cwd);
    for (;;) {
      if (this.closed) throw new Error('Workspace admission has closed.');
      if (!this.held(canonical)) return;
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
  }

  /** Reserve the await gap between admission and the first runtime write. A mere idle check or
   * resolved wait promise is insufficient: a capture could otherwise acquire before send(). */
  async dispatch(cwd: string, run: () => Promise<void>): Promise<void> {
    for (;;) {
      await this.wait(cwd);
      const canonical = key(realpathSync(cwd));
      if (this.closed) throw new Error('Workspace admission has closed.');
      if (this.held(canonical)) continue;
      const token = Symbol('workspace dispatch');
      this.dispatches.set(token, canonical);
      try { await run(); } finally { this.dispatches.delete(token); }
      return;
    }
  }

  async acquire(cwd: string): Promise<WorkspaceQuiescenceLease | undefined> {
    if (this.closed) return undefined;
    const canonical = await canonicalPath(cwd);
    if (this.closed || this.held(canonical) || [...this.dispatches.values()].some((value) => overlaps(canonical, value))) return undefined;
    const token = Symbol('workspace lease');
    this.leases.set(canonical, token);
    const release = () => {
      if (this.leases.get(canonical) !== token) return;
      this.leases.delete(canonical);
      const waiting = [...this.waiters]; this.waiters.clear();
      for (const wake of waiting) wake();
      this.deps.released?.(cwd);
    };
    const assertQuiescent = async () => {
      if (this.closed || this.leases.get(canonical) !== token) throw new Error('Workspace lease is no longer held.');
      if ([...this.dispatches.values()].some((value) => overlaps(canonical, value))) throw new Error('A runtime dispatch still owns this workspace.');
      if (await canonicalPath(cwd) !== canonical) throw new Error('Workspace location changed while its lease was held.');
      await this.assertNoWriter(canonical);
      if (this.closed || this.leases.get(canonical) !== token) throw new Error('Workspace lease changed during inspection.');
    };
    try { await assertQuiescent(); } catch { release(); return undefined; }
    return { assertQuiescent, release };
  }

  private async assertNoWriter(cwd: string): Promise<void> {
    const sessions = this.deps.sessions();
    for (const session of sessions) {
      const activity = this.deps.activity(session.id);
      if (!writer(activity) && !(activity.queued > 0 && !session.mission)) continue;
      // Planning may continue to read its source discussion. The harness owns enforcement of
      // that read-only ceiling; no writable session receives this exemption.
      if (session.mission?.sourceAccess === 'read_only' || !session.mission && session.config.permissionMode === 'plan'
        && !(activity.nativeChildren ?? 0) && !activity.processes && !activity.uncertain) continue;
      if (overlaps(cwd, await canonicalPath(session.cwd))) throw new Error('An app-owned session may still write this workspace.');
    }
    for (const terminal of this.deps.terminals()) {
      const owner = sessions.find((s) => s.id === terminal.sessionId);
      // Activity includes retired tabs, lost supervisors and restored uncertainty. No PID/root
      // exit filter: only the terminal owner can prove all descendant writers have ended.
      const locations = new Set([terminal.cwd, terminal.reportedCwd, ...(owner ? [owner.cwd] : [])]);
      for (const location of locations) if (overlaps(cwd, await canonicalPath(location))) throw new Error('Close the app-owned shell before capturing this workspace.');
    }
  }

  close(): void {
    this.closed = true;
    const waiting = [...this.waiters]; this.waiters.clear();
    for (const wake of waiting) wake();
    // Existing leases remain identifiable; closing never falsely declares their writers settled.
  }
}
