/**
 * Tracks every OS process Vocs Code started, however it was started: the process tree under the
 * main process, sampled in the background, with each process attributed to the session (or
 * terminal, or app service) it works for. Electron-free so it is unit-tested in Node.
 *
 * - Attribution: a ChildProcess started inside a session's owner context is claimed for that
 *   session (process-context.ts); a terminal's root comes from the terminal manager; everything
 *   below a claimed process inherits its owner.
 * - Orphans: Windows never re-parents, so a process whose Vocs Code parent exited keeps pointing at
 *   a dead PID. A process tracked in the previous sample that the walk no longer reaches, or a new
 *   child of a tracked process that has just died, is kept as orphaned with its whole subtree.
 * - Earlier runs: the tracked set is saved to disk, so a process still alive from a run that quit
 *   or crashed is found again on the next launch.
 *
 * A PID alone is never trusted: every comparison also matches the creation time.
 */
import type { ProcessEndResult, ProcessList, ProcessOwner, ProcessSummary, ProcessTarget, TrackedProcess } from '../shared/processes';
import { processKey } from '../shared/processes';
import { readJson, writeJson } from './util/fs';
import type { ProcessSource, RawProcess } from './process-snapshot';
import { observeOwnedSpawns } from './process-context';

export interface TerminalRoot {
  pid?: number;
  sessionId: string;
  terminalId: string;
  title?: string;
}

export interface ProcessTrackerOptions {
  source: ProcessSource;
  /** The app's main process: the root every tracked process descends from. */
  rootPid: number;
  /** Chromium's own processes (renderer, GPU, utility): part of the app, never listed or ended. */
  internalPids?: () => number[];
  /** Terminal tabs' roots, which the PTY layer starts outside child_process. */
  terminalRoots?: () => TerminalRoot[];
  /** Where the tracked set is saved for the next run. */
  registryFile?: string;
  cpuCount?: number;
  /** Background sampling interval; the panel's own polling samples faster while it is open. */
  intervalMs?: number;
  now?: () => number;
  onSummary?: (summary: ProcessSummary) => void;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Injected for tests; process.kill otherwise. */
  signal?: (pid: number, signal: NodeJS.Signals | 0) => void;
  platform?: NodeJS.Platform;
  /** Whether to observe ChildProcess spawns (tests drive `claim` directly). */
  observeSpawns?: boolean;
}

interface Claim {
  owner: ProcessOwner;
  at: number;
  startedAt?: number;
}

interface SavedProcess {
  pid: number;
  ppid: number;
  startedAt: number;
  name: string;
  command?: string;
  owner: ProcessOwner;
}

interface Registry {
  version: 1;
  savedAt: number;
  processes: SavedProcess[];
}

/** Windows console hosts: one per console program, gone with it. Tracked, never listed. */
const CONSOLE_HOSTS = new Set(['conhost.exe', 'openconsole.exe']);
/** A list answered this recently is current enough for a polling panel. */
const FRESH_MS = 1_500;
/** An unbound claim whose process never showed up is dropped after this. */
const CLAIM_TTL_MS = 60_000;
/** Slack between the clock that stamps creation times and the one that stamps samples. */
const CLOCK_SLACK_MS = 1_000;
const POSIX_GRACE_MS = 1_500;

export class ProcessTracker {
  private readonly claims = new Map<number, Claim>();
  /** The previous sample's tracked set (with console hosts), keyed by pid:startedAt. */
  private known = new Map<string, TrackedProcess>();
  private knownAt = 0;
  private readonly cpu = new Map<string, { cpuMs: number; at: number }>();
  private readonly commands = new Map<string, string>();
  private latest: { list: ProcessList; tracked: Map<string, TrackedProcess>; raw: RawProcess[] } | null = null;
  private inflight: Promise<ProcessList> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopObserving: (() => void) | null = null;
  private savedSignature = '';
  private loaded: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly opts: ProcessTrackerOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  start(): void {
    if (this.opts.observeSpawns !== false && !this.stopObserving) this.stopObserving = observeOwnedSpawns((pid, owner) => this.claim(pid, owner));
    void this.load();
    if (!this.timer) {
      this.timer = setInterval(() => void this.refresh().catch(() => undefined), this.opts.intervalMs ?? 10_000);
      this.timer.unref?.();
    }
    setTimeout(() => void this.refresh().catch(() => undefined), 2_000).unref?.();
  }

  /** Attributes a process the app just started; bound to its creation time on the next sample. */
  claim(pid: number, owner: ProcessOwner): void {
    if (pid > 0) this.claims.set(pid, { owner, at: this.now() });
  }

  /** The latest list, sampling again unless the last sample is still fresh. */
  async list(): Promise<ProcessList> {
    if (this.latest && this.now() - this.latest.list.sampledAt < FRESH_MS) return this.latest.list;
    return this.refresh();
  }

  refresh(): Promise<ProcessList> {
    if (this.inflight) return this.inflight;
    this.inflight = this.sample().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * Ends each target and everything under it, parents first so nothing respawns a child already
   * ended. Only processes in a fresh sample's tracked set can be named; the app itself never is.
   */
  async end(targets: ProcessTarget[]): Promise<ProcessEndResult> {
    const fresh = await this.refresh();
    const latest = this.latest;
    const failed: ProcessEndResult['failed'] = [];
    // Never act on an older sample: by now its PIDs may name other processes.
    if (fresh.error || !latest || latest.list !== fresh) return { ended: 0, failed: targets.map((t) => ({ pid: t.pid, error: fresh.error ?? 'Processes could not be read.' })) };
    const children = childMap(latest.raw);
    const victims: RawProcess[] = [];
    const seen = new Set<string>();
    for (const target of targets) {
      const tracked = latest.tracked.get(processKey(target));
      if (!tracked) {
        failed.push({ pid: target.pid, error: 'Not a running Vocs Code process.' });
        continue;
      }
      const queue = [latest.raw.find((p) => p.pid === tracked.pid && p.startedAt === tracked.startedAt)!];
      while (queue.length) {
        const p = queue.shift()!;
        const key = processKey(p);
        if (seen.has(key) || !latest.tracked.has(key)) continue;
        seen.add(key);
        victims.push(p);
        for (const child of children.get(p.pid) ?? []) if (startedUnder(child, p)) queue.push(child);
      }
    }
    const signal = this.opts.signal ?? ((pid: number, sig: NodeJS.Signals | 0) => void process.kill(pid, sig));
    const windows = (this.opts.platform ?? process.platform) === 'win32';
    let ended = 0;
    for (const v of victims) {
      try {
        // On Windows every signal is TerminateProcess; POSIX gets a chance to exit cleanly first.
        signal(v.pid, windows ? 'SIGKILL' : 'SIGTERM');
        ended++;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') ended++;
        else failed.push({ pid: v.pid, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (!windows && victims.length) {
      await new Promise((r) => setTimeout(r, POSIX_GRACE_MS));
      for (const v of victims) {
        try {
          signal(v.pid, 0);
          signal(v.pid, 'SIGKILL');
        } catch {
          /* exited */
        }
      }
    }
    this.opts.log?.('info', `processes: ended ${ended} process(es)${failed.length ? `, ${failed.length} failed` : ''}`);
    if (this.latest) this.latest = { ...this.latest, list: { ...this.latest.list, sampledAt: 0 } };
    return { ended, failed };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // One last sample saves what is alive now, so the next launch can find what outlives this run.
    // Skipped when nothing was ever sampled: starting the Windows reader during quit would only delay it.
    if (this.latest) {
      try {
        await this.refresh();
      } catch {
        /* best effort */
      }
    }
    this.closed = true;
    this.stopObserving?.();
    this.stopObserving = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.opts.source.close();
  }

  private load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        if (!this.opts.registryFile) return;
        // A corrupt file is quarantined and reported by readJson; tracking starts from the live tree.
        const saved = await readJson<Registry | null>(this.opts.registryFile, null, { log: this.opts.log });
        if (!saved || saved.version !== 1 || !Array.isArray(saved.processes)) return;
        for (const p of saved.processes) {
          if (!p || typeof p.pid !== 'number' || typeof p.startedAt !== 'number' || !p.startedAt) continue;
          const record: TrackedProcess = { pid: p.pid, ppid: p.ppid, startedAt: p.startedAt, name: p.name, command: p.command, owner: p.owner ?? {}, orphaned: true, previousRun: true };
          this.known.set(processKey(record), record);
        }
      })().catch((e) => this.opts.log?.('warn', `processes: could not read the saved process list (${e instanceof Error ? e.message : String(e)})`));
    }
    return this.loaded;
  }

  private async sample(): Promise<ProcessList> {
    await this.load();
    const at = this.now();
    let raw: RawProcess[];
    try {
      raw = await this.opts.source.snapshot();
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), sampledAt: at, processes: [] };
    }
    const tracked = this.classify(raw, at);
    await this.fillCommands(tracked);
    // Chromium helpers that getAppMetrics did not name (crashpad) carry the app's own image and a --type switch.
    const root = raw.find((p) => p.pid === this.opts.rootPid);
    for (const [key, p] of tracked) {
      if (root && p.ppid === root.pid && p.name === root.name && / --type=/.test(p.command ?? '')) tracked.delete(key);
    }
    const byKey = new Map(raw.map((p) => [processKey(p), p]));
    for (const [key, p] of tracked) {
      const cpuMs = byKey.get(key)?.cpuMs ?? 0;
      const prev = this.cpu.get(key);
      if (prev && at > prev.at) p.cpu = Math.max(0, Math.min(100, ((cpuMs - prev.cpuMs) / (at - prev.at) / (this.opts.cpuCount || 1)) * 100));
      this.cpu.set(key, { cpuMs, at });
    }
    for (const key of [...this.cpu.keys()]) if (!tracked.has(key)) this.cpu.delete(key);
    for (const key of [...this.commands.keys()]) if (!tracked.has(key)) this.commands.delete(key);

    this.known = tracked;
    this.knownAt = at;
    this.pruneClaims(raw, at);
    const processes = [...tracked.values()].filter((p) => !CONSOLE_HOSTS.has(p.name.toLowerCase())).sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid);
    const list: ProcessList = { sampledAt: at, processes };
    this.latest = { list, tracked, raw };
    this.save(processes);
    // Sent every sample, not only on change, so a window that reloaded gets its badge back.
    this.opts.onSummary?.({ count: processes.length, orphaned: processes.filter((p) => p.orphaned).length });
    return list;
  }

  /** The tracked set for one sample: the walk from the app, then orphans and their subtrees. */
  private classify(raw: RawProcess[], at: number): Map<string, TrackedProcess> {
    const byKey = new Map(raw.map((p) => [processKey(p), p]));
    const children = childMap(raw);
    const internal = new Set([this.opts.rootPid, ...(this.opts.internalPids?.() ?? [])]);
    if (this.opts.source.helperPid) internal.add(this.opts.source.helperPid);
    const terminals = new Map<number, ProcessOwner>();
    for (const t of this.opts.terminalRoots?.() ?? []) {
      if (t.pid) terminals.set(t.pid, { sessionId: t.sessionId, terminalId: t.terminalId, label: t.title });
    }
    const tracked = new Map<string, TrackedProcess>();
    const visited = new Set<string>();

    const ownerOf = (p: RawProcess, inherited: ProcessOwner): ProcessOwner => {
      const claim = this.claims.get(p.pid);
      if (claim && (claim.startedAt === undefined ? !p.startedAt || p.startedAt <= claim.at + CLOCK_SLACK_MS : claim.startedAt === p.startedAt)) {
        claim.startedAt = p.startedAt;
        return claim.owner;
      }
      return terminals.get(p.pid) ?? inherited;
    };
    const walk = (start: RawProcess, owner: ProcessOwner, flags: { orphaned?: boolean; previousRun?: boolean }, includeStart: boolean) => {
      const queue: [RawProcess, ProcessOwner][] = [[start, owner]];
      while (queue.length) {
        const [p, inherited] = queue.shift()!;
        const key = processKey(p);
        if (visited.has(key)) continue;
        visited.add(key);
        let own = inherited;
        if (p !== start || includeStart) {
          if (!internal.has(p.pid)) {
            own = ownerOf(p, inherited);
            tracked.set(key, { pid: p.pid, ppid: p.ppid, startedAt: p.startedAt, name: p.name, command: p.command ?? this.commands.get(key), memory: p.memory, owner: own, ...(flags.orphaned ? { orphaned: true } : {}), ...(flags.previousRun ? { previousRun: true } : {}) });
          }
        }
        // Children work for the same session or terminal; a label names only the root that was started.
        const forChildren = own.label === undefined ? own : withoutLabel(own);
        for (const child of children.get(p.pid) ?? []) if (startedUnder(child, p)) queue.push([child, forChildren]);
      }
    };

    const root = raw.find((p) => p.pid === this.opts.rootPid) ?? { pid: this.opts.rootPid, ppid: 0, startedAt: 0, cpuMs: 0, memory: 0, name: '' };
    walk(root, {}, {}, false);
    // A terminal's shell is the app's whatever the pseudo-console made its parent; the terminal
    // manager holds it open right now, so its PID cannot have been reused.
    for (const [pid, owner] of terminals) {
      const live = raw.find((p) => p.pid === pid);
      if (live && !visited.has(processKey(live)) && !internal.has(pid)) walk(live, owner, {}, true);
    }

    // Tracked last time and still alive, but no longer under the app: its parent chain broke.
    for (const [key, prev] of this.known) {
      const live = byKey.get(key);
      if (!live || visited.has(key) || internal.has(live.pid)) continue;
      walk(live, prev.owner, { orphaned: true, previousRun: prev.previousRun }, true);
    }
    // Started since the last sample by a tracked process that has died since: still the app's.
    const dead = new Map<number, TrackedProcess>();
    for (const [key, prev] of this.known) if (!byKey.has(key) && !prev.previousRun) dead.set(prev.pid, prev);
    if (dead.size) {
      for (const p of raw) {
        const parent = dead.get(p.ppid);
        const key = processKey(p);
        if (!parent || visited.has(key) || internal.has(p.pid) || !p.startedAt) continue;
        if (p.startedAt < parent.startedAt || p.startedAt < this.knownAt - CLOCK_SLACK_MS || p.startedAt > at + CLOCK_SLACK_MS) continue;
        walk(p, withoutLabel(parent.owner), { orphaned: true }, true);
      }
    }
    return tracked;
  }

  /** Windows reads command lines separately; each is read once per process and cached. */
  private async fillCommands(tracked: Map<string, TrackedProcess>): Promise<void> {
    const missing = [...tracked.values()].filter((p) => p.command === undefined && !CONSOLE_HOSTS.has(p.name.toLowerCase()));
    if (!missing.length) return;
    try {
      const lines = await this.opts.source.commandLines(missing.map((p) => p.pid));
      for (const p of missing) {
        const line = lines.get(p.pid);
        if (line === undefined) continue;
        p.command = line;
        this.commands.set(processKey(p), line);
      }
    } catch (e) {
      this.opts.log?.('debug', `processes: command lines unavailable (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  private pruneClaims(raw: RawProcess[], at: number): void {
    const alive = new Map(raw.map((p) => [p.pid, p]));
    for (const [pid, claim] of this.claims) {
      const p = alive.get(pid);
      if (claim.startedAt !== undefined ? !p || p.startedAt !== claim.startedAt : at - claim.at > CLAIM_TTL_MS) this.claims.delete(pid);
    }
  }

  private save(processes: TrackedProcess[]): void {
    const file = this.opts.registryFile;
    if (!file) return;
    const signature = processes.map(processKey).join(',');
    if (signature === this.savedSignature) return;
    this.savedSignature = signature;
    const registry: Registry = {
      version: 1,
      savedAt: this.now(),
      processes: processes.filter((p) => p.startedAt).map((p) => ({ pid: p.pid, ppid: p.ppid, startedAt: p.startedAt, name: p.name, command: p.command, owner: p.owner }))
    };
    void writeJson(file, registry).catch((e) => {
      // Forget what was saved, so the next sample writes again instead of trusting a failed write.
      if (this.savedSignature === signature) this.savedSignature = '';
      this.opts.log?.('warn', `processes: could not save the process list (${e instanceof Error ? e.message : String(e)})`);
    });
  }
}

function withoutLabel(owner: ProcessOwner): ProcessOwner {
  const { label: _label, ...rest } = owner;
  return rest;
}

function childMap(raw: RawProcess[]): Map<number, RawProcess[]> {
  const children = new Map<number, RawProcess[]>();
  for (const p of raw) {
    if (p.pid === p.ppid) continue;
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid)!.push(p);
  }
  return children;
}

/** A child cannot predate its parent; one that does names a reused PID, not this parent. */
function startedUnder(child: RawProcess, parent: RawProcess): boolean {
  return child.pid !== parent.pid && (!child.startedAt || !parent.startedAt || child.startedAt >= parent.startedAt);
}
