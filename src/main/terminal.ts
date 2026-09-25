/**
 * Terminals for the side panel. Each tab is a real PTY (node-pty: ConPTY on Windows, forkpty
 * elsewhere) that lives in the main process, so a shell survives panel switches and renderer
 * reloads. A headless xterm mirrors every PTY: a renderer that (re)attaches gets an exact snapshot
 * of the screen and scrollback, and title / cwd changes are tracked even while no tab is shown.
 * Snapshots are written to disk on quit and come back as lazy tabs on the next launch.
 */
import { spawn as spawnProcess } from 'node:child_process';
import { promises as fs, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { IPty } from '@lydell/node-pty';
import type * as PtyModule from '@lydell/node-pty';
import type * as HeadlessModule from '@xterm/headless';
import type * as SerializeModule from '@xterm/addon-serialize';
import { FLOW_HIGH_WATER, FLOW_LOW_WATER, baseName, cleanTitle, parseOscCwd, type ShellKind, type ShellOption, type TerminalInfo, type TerminalSettings } from '../shared/terminal';
import { which } from './runtime';
import { errorMessage, shortId } from './util/async';
import { ensureDir, readJson, writeJson } from './util/fs';
import { spawnOwnedTerminal, type OwnedTerminalProcess, type OwnedTerminalSpawn } from './terminal-process';
import { createProcessOwnershipIntent, ownershipNonce, processOwnershipIntents, processOwnershipQuiescent, recordUnlaunchedProcessIntent, type ProcessOwnershipIntent } from './mission/process-ownership';

// These packages ship CommonJS only; loading them through require keeps the ESM main bundle honest
// about it (a static named import of the xterm bundles fails at runtime).
const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require('@xterm/headless') as typeof HeadlessModule;
const { SerializeAddon } = require('@xterm/addon-serialize') as typeof SerializeModule;

type PtySpawn = typeof PtyModule.spawn;
let ptyModule: typeof PtyModule | null | undefined;
let ptyLoadError = '';

/** node-pty is loaded on first use so an unsupported platform breaks the terminal, not the app. */
function loadPty(): typeof PtyModule {
  if (ptyModule === undefined) {
    try {
      ptyModule = require('@lydell/node-pty') as typeof PtyModule;
    } catch (e) {
      ptyModule = null;
      ptyLoadError = errorMessage(e);
    }
  }
  if (!ptyModule) throw new Error(`The terminal backend (node-pty) failed to load: ${ptyLoadError}`);
  return ptyModule;
}

const isWin = process.platform === 'win32';

export interface ResolvedShell {
  kind: ShellKind;
  name: string;
  file: string;
  args: string[];
}

/** Git for Windows puts git.exe on PATH but usually not bash.exe; derive bin\bash.exe from it or the default install dirs. */
function findGitBash(): string | null {
  const bash = which('bash');
  if (bash && !/\\System32\\/i.test(bash)) return bash; // System32\bash.exe is the WSL launcher
  const git = which('git');
  const candidates = [
    git ? path.join(path.dirname(git), '..', 'bin', 'bash.exe') : '',
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe')
  ].filter(Boolean);
  for (const c of candidates) if (which(c)) return path.resolve(c);
  return null;
}

/** Shells installed on this machine, in the order 'auto' prefers them. */
export function detectShells(): ShellOption[] {
  const out: ShellOption[] = [];
  const add = (kind: ShellKind, name: string, cmd: string) => {
    const p = which(cmd);
    if (p && !out.some((o) => o.kind === kind)) out.push({ kind, name, path: p });
  };
  if (isWin) {
    add('pwsh', 'PowerShell 7', 'pwsh');
    add('powershell', 'Windows PowerShell', 'powershell');
    add('cmd', 'Command Prompt', process.env.ComSpec || 'cmd.exe');
    const gb = findGitBash();
    if (gb) out.push({ kind: 'gitbash', name: 'Git Bash', path: gb });
    add('wsl', 'WSL', 'wsl');
  } else {
    add('zsh', 'zsh', 'zsh');
    add('bash', 'bash', 'bash');
    add('fish', 'fish', 'fish');
    add('sh', 'sh', 'sh');
  }
  return out;
}

/** Arguments that make the shell interactive with the user's profile loaded, as a terminal app would pass them. */
export function interactiveArgs(kind: ShellKind, platform: string = process.platform): string[] {
  switch (kind) {
    case 'pwsh':
    case 'powershell':
      return ['-NoLogo'];
    case 'gitbash':
      return ['--login', '-i'];
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'sh':
      return platform === 'darwin' ? ['-l'] : [];
    default:
      return [];
  }
}

export function resolveShell(ts: TerminalSettings, override?: ShellKind, shells: ShellOption[] = detectShells()): ResolvedShell {
  const kind = override ?? ts.shell;
  if (kind === 'custom') {
    const file = ts.customShellPath.trim();
    if (file) return { kind, name: baseName(file).replace(/\.exe$/i, ''), file, args: ts.customShellArgs };
  }
  if (kind === 'auto' || kind === 'custom') {
    if (!isWin && process.env.SHELL) {
      const file = process.env.SHELL;
      const name = baseName(file);
      const k = (['bash', 'zsh', 'fish', 'sh'] as const).find((s) => s === name) ?? 'sh';
      return { kind: k, name, file, args: interactiveArgs(k) };
    }
  } else {
    const found = shells.find((s) => s.kind === kind);
    if (found) return { kind: found.kind, name: found.name, file: found.path, args: interactiveArgs(found.kind) };
  }
  const first = shells[0];
  if (first) return { kind: first.kind, name: first.name, file: first.path, args: interactiveArgs(first.kind) };
  return isWin ? { kind: 'cmd', name: 'Command Prompt', file: process.env.ComSpec || 'cmd.exe', args: [] } : { kind: 'sh', name: 'sh', file: '/bin/sh', args: [] };
}

/** The PTY's environment: the app's, minus Electron's node-mode switch, plus what terminals advertise. */
export function terminalEnv(base: NodeJS.ProcessEnv, version: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'ELECTRON_NO_ATTACH_CONSOLE') env[k] = v;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'vocs-code';
  env.TERM_PROGRAM_VERSION = version;
  env.VOCS_CODE = '1';
  return env;
}

/** Legacy best-effort termination. Neither taskkill nor PTY exit is process-tree proof. */
function killProcessTree(p: IPty): void {
  try {
    if (!Number.isSafeInteger(p.pid) || p.pid <= 0) throw new Error('Shell PID is not yet available');
    if (isWin) spawnProcess('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
    else process.kill(-p.pid, 'SIGKILL'); // node-pty makes the shell a group leader
  } catch {
    /* already gone, or not a group leader */
  }
  try {
    p.kill();
  } catch {
    /* already gone */
  }
}

export interface TerminalManagerDeps {
  /** Directory for persisted screens (userData/terminals). */
  dir: string;
  settings: () => TerminalSettings;
  version: string;
  /** A terminal belongs to a session and starts in its working directory; undefined = no such session. */
  cwdOf: (sessionId: string) => string | undefined;
  /** Main-process resource leases may refuse a new shell before any process is spawned. */
  beforeSpawn?: (cwd: string) => void;
  /** Main owns Mission identity/authorization; a managed shell may never use the legacy spawn. */
  isManaged?: (sessionId: string) => boolean;
  /** Trusted bundled resource, not a project path. Also contains ordinary Windows shells so
   * their retired descendants cannot block a later Mission baseline forever. */
  windowsJobHelper?: string;
  /** Process activity can outlive its tab; wake host coordinators on real ownership changes. */
  onActivity?: (sessionId: string) => void;
  /** Bounded wait is a failure, never evidence that children stopped. */
  managedCloseTimeoutMs?: number;
  /** Test seam for an owned process supervisor; quiescent must prove the entire owned tree. */
  spawnOwned?: OwnedTerminalSpawn;
  /** Test seam: avoids sending OS signals to fake PIDs. */
  killTree?: (pty: IPty) => void;
  push: (channel: 'push:terminalData' | 'push:terminalsChanged', payload: unknown) => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Test seam: replaces node-pty's spawn. */
  spawn?: PtySpawn;
}

export interface TerminalActivity {
  terminalId: string;
  sessionId: string;
  /** Spawn cwd is retained even if OSC output later advertises a different directory. */
  cwd: string;
  reportedCwd: string;
  pid?: number;
  managed: boolean;
  state: 'live' | 'closing' | 'uncertain';
  reason?: string;
  /** Exact retained bounded owner, independent of the disposable tab/screen. */
  ownershipNonce?: string;
}

interface TerminalResource {
  activity: TerminalActivity;
  pty?: IPty;
  /** Written before spawn; a crash cannot erase unresolved process ownership. */
  receiptFile: string;
  owner?: OwnedTerminalProcess;
  intent?: ProcessOwnershipIntent;
  rootExited: boolean;
  treeQuiet: boolean;
  done: Promise<void>;
  finish(): void;
  closing?: Promise<void>;
}

interface Persisted {
  info: TerminalInfo;
  cols: number;
  rows: number;
  snapshot: string;
}

interface Term {
  info: TerminalInfo;
  pty: IPty | null;
  resource?: TerminalResource;
  /** Executable of the running shell, so its self-announced title can be told from a program's. */
  shellFile: string;
  /** Generation of the current PTY; handlers of a killed predecessor must not touch the record. */
  gen: number;
  screen: HeadlessModule.Terminal;
  serializer: SerializeModule.SerializeAddon;
  cols: number;
  rows: number;
  /** Count of chunks fed so far; every push carries its seq so an attaching renderer can skip what its snapshot already has. */
  seq: number;
  attached: boolean;
  unacked: number;
  paused: boolean;
  /** Input that arrived before a restored tab's shell started; flushed into the PTY at spawn. */
  pendingInput: string[];
  disposables: { dispose(): void }[];
}

export class TerminalManager {
  private terms = new Map<string, Term>();
  /** Tabs are disposable UI; process generations outlive close/restart until positively settled. */
  private resources = new Set<TerminalResource>();
  private managedDrains = new Map<string, Promise<void>>();
  /** Renderer reloads can request overlapping attaches; serialize each terminal's snapshot drain. */
  private attachChains = new Map<string, Promise<{ snapshot: string; seq: number; info: TerminalInfo }>>();
  private listTimer: NodeJS.Timeout | null = null;

  constructor(private deps: TerminalManagerDeps) {}

  list(): TerminalInfo[] {
    return [...this.terms.values()].map((t) => ({ ...t.info }));
  }

  /** Positive activity, including closed tabs and superseded shells. Empty means proven quiet. */
  activity(sessionId?: string): TerminalActivity[] {
    return [...this.resources]
      .filter((r) => sessionId === undefined || r.activity.sessionId === sessionId)
      .map((r) => ({ ...r.activity, pid: r.pty?.pid || r.activity.pid }));
  }

  shells(): ShellOption[] {
    return detectShells();
  }

  create(sessionId: string, opts: { shell?: ShellKind; cols?: number; rows?: number } = {}): TerminalInfo {
    const cwd = this.deps.cwdOf(sessionId);
    if (!cwd) throw new Error('Session not found');
    const shell = resolveShell(this.deps.settings(), opts.shell);
    const id = shortId('t_');
    const info: TerminalInfo = { id, sessionId, title: shell.name, shell: shell.kind, shellName: shell.name, cwd, createdAt: Date.now() };
    const t = this.newTerm(info, opts.cols ?? 80, opts.rows ?? 24);
    try {
      this.spawnInto(t, shell);
    } catch (e) {
      // A post-spawn setup failure still owns the process, even though no tab was inserted.
      t.gen++;
      for (const r of this.resources) if (r.activity.terminalId === id) void this.stopResource(r).catch(() => undefined);
      for (const d of t.disposables) d.dispose();
      t.screen.dispose();
      throw e;
    }
    this.terms.set(id, t);
    this.pushList();
    return { ...info };
  }

  /**
   * A renderer starts showing a terminal: returns the screen as it is right now plus the seq of the
   * last chunk in it. Restored tabs get their shell here, on first sight.
   */
  async attach(id: string, cols: number, rows: number): Promise<{ snapshot: string; seq: number; info: TerminalInfo }> {
    const previous = this.attachChains.get(id) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.attachOnce(id, cols, rows));
    this.attachChains.set(id, run);
    try {
      return await run;
    } finally {
      if (this.attachChains.get(id) === run) this.attachChains.delete(id);
    }
  }

  private async attachOnce(id: string, cols: number, rows: number): Promise<{ snapshot: string; seq: number; info: TerminalInfo }> {
    const t = this.must(id);
    if (cols > 0 && rows > 0) this.resize(id, cols, rows);
    if (!t.pty && t.info.restored) {
      this.feed(t, '\r\n\x1b[2m─── restored from the previous session ───\x1b[0m\r\n');
      try {
        this.spawnInto(t, resolveShell(this.deps.settings(), t.info.shell));
      } catch (e) {
        // spawnInto already logged the cause; the tab shows it too so the user is not left with a blank screen.
        this.feed(t, `\x1b[31m${errorMessage(e)}\x1b[0m\r\n`);
        t.info.exit = { code: -1 };
      }
      this.pushList();
    }
    // Nothing may reach the screen between the drain and the snapshot, or the renderer would see it twice.
    t.attached = false;
    t.pty?.pause();
    await new Promise<void>((r) => t.screen.write('', r));
    if (this.terms.get(id) !== t) throw new Error('Terminal not found');
    const snapshot = t.serializer.serialize({ scrollback: this.deps.settings().scrollback });
    const seq = t.seq;
    t.attached = true;
    t.unacked = 0;
    t.paused = false;
    t.pty?.resume();
    return { snapshot, seq, info: { ...t.info } };
  }

  /**
   * A read-only, plain-text view of a terminal for a paired browser (docs/REMOTE-ACCESS.md P3.5,
   * read-only first): the last `maxLines` rows of scrollback and screen once pending output has
   * reached the headless screen. It never attaches, pauses, resizes or spawns, so a remote viewer
   * cannot disturb the desktop's own view, its flow control or a restored tab's lazy shell.
   */
  async screenText(id: string, maxLines = 200): Promise<{ info: TerminalInfo; lines: string[]; seq: number }> {
    const t = this.must(id);
    await new Promise<void>((r) => t.screen.write('', r));
    if (this.terms.get(id) !== t) throw new Error('Terminal not found');
    const buffer = t.screen.buffer.active;
    const lines: string[] = [];
    for (let i = Math.max(0, buffer.length - Math.min(Math.max(1, Math.floor(maxLines)), 1000)); i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    }
    // The blank rows under the prompt are screen, not output.
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return { info: { ...t.info }, lines, seq: t.seq };
  }

  detach(id: string): void {
    const t = this.terms.get(id);
    if (t) this.release(t);
  }

  /** The renderer is reloading or gone: stop pushing and let paused shells run. */
  detachAll(): void {
    for (const t of this.terms.values()) this.release(t);
  }

  input(id: string, data: string): void {
    const t = this.terms.get(id);
    if (!t) return; // the tab closed; a late renderer call must not reject
    if (t.resource?.activity.managed && t.resource.activity.state !== 'live') return;
    if (t.pty) t.pty.write(data);
    else if (t.info.restored) t.pendingInput.push(data); // no shell yet: it starts on first attach
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terms.get(id);
    if (!t) return;
    cols = Math.max(2, Math.floor(cols));
    rows = Math.max(1, Math.floor(rows));
    if (cols === t.cols && rows === t.rows) return;
    t.cols = cols;
    t.rows = rows;
    t.screen.resize(cols, rows);
    try {
      t.pty?.resize(cols, rows);
    } catch {
      /* the process may be exiting */
    }
  }

  ack(id: string, chars: number): void {
    const t = this.terms.get(id);
    if (!t) return;
    t.unacked = Math.max(0, t.unacked - chars);
    if (t.paused && t.unacked < FLOW_LOW_WATER) {
      t.paused = false;
      t.pty?.resume();
    }
  }

  /** Requests shell/tree termination; the tab stays readable and activity stays until proven quiet. */
  kill(id: string): void {
    const t = this.must(id);
    if (!t.pty) return;
    this.deps.log('info', `terminal ${id} (${t.info.shellName}, pid ${t.info.pid ?? '?'}): killing the shell and its process tree`);
    if (t.resource) void this.stopResource(t.resource).catch(() => undefined);
  }

  /** Managed restart cannot admit a replacement while any predecessor may still write. */
  async restart(id: string): Promise<TerminalInfo> {
    const t = this.must(id);
    this.deps.log('info', `terminal ${id} (${t.info.shellName}): restart requested`);
    const managed = this.deps.isManaged?.(t.info.sessionId) || t.resource?.activity.managed;
    const generation = ++t.gen; // the old exit handler must not close or annotate the tab
    t.pty = null;
    const previous = [...this.resources].filter((r) => r.activity.terminalId === id);
    if (managed) {
      await Promise.all(previous.map((r) => this.stopResource(r)));
      if (this.terms.get(id) !== t || t.gen !== generation) throw new Error('Terminal changed while restarting');
    } else {
      for (const r of previous) void this.stopResource(r).catch(() => undefined);
    }
    this.feed(t, '\r\n\x1b[2m─── restarted ───\x1b[0m\r\n');
    try {
      this.spawnInto(t, resolveShell(this.deps.settings(), t.info.shell));
    } catch (e) {
      t.info.exit = { code: -1 };
      this.pushList();
      throw e;
    }
    this.pushList();
    return { ...t.info };
  }

  async close(id: string): Promise<void> {
    const t = this.terms.get(id);
    if (!t) return;
    this.terms.delete(id);
    this.attachChains.delete(id);
    t.attached = false;
    t.gen++;
    for (const r of this.resources) if (r.activity.terminalId === id) void this.stopResource(r).catch(() => undefined);
    for (const d of t.disposables) d.dispose();
    t.screen.dispose();
    this.pushList();
    this.deps.log('debug', `terminal ${id} (${t.info.shellName}) closed`);
    await fs.rm(this.file(id), { force: true }).catch((e) => this.deps.log('debug', `terminal ${id}: could not remove its snapshot file: ${errorMessage(e)}`));
  }

  clear(id: string): void {
    this.must(id).screen.clear();
  }

  rename(id: string, title: string): TerminalInfo {
    const t = this.must(id);
    const v = title.trim();
    t.info.title = v || t.info.shellName;
    t.info.customTitle = !!v;
    this.pushList();
    return { ...t.info };
  }

  /** Legacy bounded UI close. Only the managed branch proves quiescence for workspace cleanup. */
  async closeForSession(sessionId: string): Promise<void> {
    if (this.deps.isManaged?.(sessionId) || this.activity(sessionId).some((r) => r.managed)) return this.closeManagedSession(sessionId);
    const mine = [...this.terms.values()].filter((t) => t.info.sessionId === sessionId);
    if (!mine.length) return;
    const exits = mine.map(
      (t) =>
        new Promise<void>((resolve) => {
          if (!t.pty) return resolve();
          const d = t.pty.onExit(() => {
            d.dispose();
            resolve();
          });
        })
    );
    await Promise.all(mine.map((t) => this.close(t.info.id)));
    await Promise.race([Promise.all(exits), new Promise((r) => setTimeout(r, 1500))]);
  }

  /** Mission pause/cleanup/delivery must await this, never the legacy best-effort timeout. */
  closeManagedSession(sessionId: string): Promise<void> {
    const existing = this.managedDrains.get(sessionId);
    if (existing) return existing;
    const run = Promise.resolve().then(async () => {
      const mine = [...this.terms.values()].filter((t) => t.info.sessionId === sessionId);
      await Promise.all([
        ...mine.map((t) => this.close(t.info.id)),
        ...[...this.resources].filter((r) => r.activity.sessionId === sessionId).map((r) => this.stopResource(r))
      ]);
      if (this.activity(sessionId).length) throw new Error('Terminal process teardown remains uncertain');
    });
    this.managedDrains.set(sessionId, run);
    void run.finally(() => { if (this.managedDrains.get(sessionId) === run) this.managedDrains.delete(sessionId); }).catch(() => undefined);
    return run;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.terms.keys()].map((id) => this.close(id)));
  }

  updateSettings(ts: TerminalSettings): void {
    for (const t of this.terms.values()) t.screen.options.scrollback = ts.scrollback;
  }

  /** Writes every screen to disk so the tabs come back after a restart. Restored tabs go first. */
  async persist(deadline?: number): Promise<void> {
    if (!this.deps.settings().restoreOnStartup) return;
    await ensureDir(this.deps.dir);
    const terms = [...this.terms.values()].sort((a, b) => Number(!!b.info.restored) - Number(!!a.info.restored));
    let warned = false;
    for (const t of terms) {
      if (deadline !== undefined && Date.now() >= deadline) {
        if (!warned) {
          warned = true;
          this.deps.log('warn', `terminal snapshot deadline reached; ${terms.length - terms.indexOf(t)} terminal(s) were not persisted`);
        }
        break;
      }
      await new Promise<void>((r) => t.screen.write('', r)); // output still queued in the parser must make it in
      const snapshot = t.serializer.serialize({ scrollback: this.deps.settings().scrollback });
      const data: Persisted = { info: { ...t.info, pid: undefined, exit: undefined, restored: true }, cols: t.cols, rows: t.rows, snapshot };
      await writeJson(this.file(t.info.id), data).catch((e) => this.deps.log('warn', `terminal snapshot failed for ${t.info.id} (${t.info.title}): ${errorMessage(e)}`));
    }
  }

  /** Reads persisted screens into lazy tabs; screens of deleted sessions are dropped. */
  async load(): Promise<void> {
    let files: string[] = [];
    try {
      files = await fs.readdir(this.deps.dir);
    } catch (e) {
      // No directory yet on a fresh profile; anything else means the snapshots are unreachable.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.deps.log('warn', `could not read persisted terminals from ${this.deps.dir}: ${errorMessage(e)}`);
        throw new Error(`Cannot reconcile terminal process ownership: ${errorMessage(e)}`);
      }
      return;
    }
    await this.reconcileOwnership();
    const restore = this.deps.settings().restoreOnStartup;
    let restored = 0;
    let dropped = 0;
    for (const f of files.filter((f) => f.endsWith('.json'))) {
      const full = path.join(this.deps.dir, f);
      const data = await readJson<Persisted | undefined>(full, undefined, { log: this.deps.log });
      if (!restore || !data?.info?.id || !this.deps.cwdOf(data.info.sessionId)) {
        dropped++;
        await fs.rm(full, { force: true }).catch((err) => this.deps.log('debug', `could not remove stale terminal snapshot ${full}: ${errorMessage(err)}`));
        continue;
      }
      const t = this.newTerm({ ...data.info, pid: undefined, exit: undefined, restored: true }, data.cols || 80, data.rows || 24);
      t.screen.write(data.snapshot ?? '');
      t.seq = 1;
      this.terms.set(t.info.id, t);
      restored++;
    }
    if (restored || dropped) {
      this.deps.log('info', `restored ${restored} terminal tab(s) from the previous run${dropped ? `; dropped ${dropped} snapshot(s) ${restore ? 'whose session no longer exists' : 'because restore on startup is off'}` : ''}`);
    }
  }

  /** Read-only process reconciliation, including lost tabs and intents whose .owner write never
   * finished. Recovery must hold workspace admission before treating the result as a boundary. */
  async reconcileOwnership(sessionIds?: ReadonlySet<string>): Promise<void> {
    const files = await fs.readdir(this.deps.dir).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const file of files.filter((name) => name.endsWith('.owner'))) {
      const receiptFile = path.join(this.deps.dir, file);
      if ([...this.resources].some((resource) => resource.receiptFile === receiptFile)) continue;
      // No corrupt-file quarantine: an unreadable record must remain a blocker on every boot.
      const stat = await fs.lstat(receiptFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error(`Cannot reconcile terminal process ownership: ${receiptFile}`);
      let activity: TerminalActivity;
      try { activity = JSON.parse(await fs.readFile(receiptFile, 'utf8')) as TerminalActivity; }
      catch (error) { throw new Error(`Cannot read terminal process ownership ${receiptFile}: ${errorMessage(error)}`); }
      if (!activity || typeof activity.sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(activity.sessionId) || typeof activity.terminalId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(activity.terminalId)
        || typeof activity.cwd !== 'string' || !path.isAbsolute(activity.cwd) || activity.ownershipNonce !== undefined && !ownershipNonce(activity.ownershipNonce)) throw new Error(`Cannot reconcile terminal process ownership: ${receiptFile}`);
      this.retainRecovered(activity, receiptFile);
    }
    const root = path.join(this.deps.dir, 'process-ownership');
    const rootStat = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) throw new Error('Invalid terminal ownership directory');
    for (const sessionId of rootStat ? await fs.readdir(root) : []) {
      if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Invalid terminal ownership identity');
      for (const intent of await processOwnershipIntents(path.join(root, sessionId))) {
        const record = intent.record;
        if (record.kind !== 'terminal' || record.sessionId !== sessionId) throw new Error('Terminal process intent identity changed');
        const receiptFile = path.join(this.deps.dir, `${record.terminalId}.${record.nonce}.owner`);
        let resource = [...this.resources].find((entry) => entry.receiptFile === receiptFile);
        if (resource && (resource.activity.sessionId !== sessionId || resource.activity.terminalId !== record.terminalId || resource.activity.cwd !== record.cwd || resource.activity.ownershipNonce !== record.nonce)) throw new Error('Terminal owner differs from its launch intent');
        if (!resource) {
          if (await processOwnershipQuiescent(intent)) continue;
          resource = this.retainRecovered({ sessionId, terminalId: record.terminalId, cwd: record.cwd, reportedCwd: record.cwd, managed: this.deps.isManaged?.(sessionId) ?? false, state: 'uncertain', ownershipNonce: record.nonce }, receiptFile);
        }
        resource.intent = intent;
      }
    }
    for (const resource of [...this.resources]) {
      if (sessionIds && !sessionIds.has(resource.activity.sessionId)) continue;
      if (!resource.intent || !await processOwnershipQuiescent(resource.intent)) continue;
      // This old Job has positively emptied; no numeric PID is observed or signaled. In the
      // current process the independently retained PTY callback must still confirm its close.
      resource.treeQuiet = true;
      if (!resource.pty) resource.rootExited = true;
      this.settleResource(resource);
    }
  }

  private retainRecovered(activity: TerminalActivity, receiptFile: string): TerminalResource {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const resource: TerminalResource = { activity: { ...activity, state: 'uncertain', reason: 'Previous app run did not confirm terminal process-tree teardown' }, receiptFile, rootExited: false, treeQuiet: false, done, finish };
    this.resources.add(resource);
    return resource;
  }

  /** App quit: persist, then take the shells down with us. */
  async shutdown(deadline?: number): Promise<void> {
    await this.persist(deadline);
    for (const t of this.terms.values()) {
      t.attached = false;
      t.gen++;
    }
    const managed: Promise<void>[] = [];
    for (const r of this.resources) {
      const stopping = this.stopResource(r);
      if (r.activity.managed) managed.push(stopping);
      else void stopping.catch(() => undefined);
    }
    await Promise.all(managed);
  }

  private newTerm(info: TerminalInfo, cols: number, rows: number): Term {
    const screen = new HeadlessTerminal({ cols, rows, scrollback: this.deps.settings().scrollback, allowProposedApi: true });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer);
    const t: Term = { info, pty: null, shellFile: '', gen: 0, screen, serializer, cols, rows, seq: 0, attached: false, unacked: 0, paused: false, pendingInput: [], disposables: [] };
    t.disposables.push(
      screen.onTitleChange((raw) => {
        if (t.info.customTitle) return;
        const title = cleanTitle(raw, t.shellFile, t.info.shellName);
        if (title === t.info.title) return;
        t.info.title = title;
        this.pushListSoon();
      }),
      screen.parser.registerOscHandler(7, (data) => this.onCwd(t, parseOscCwd(7, data, process.platform))),
      screen.parser.registerOscHandler(9, (data) => this.onCwd(t, parseOscCwd(9, data, process.platform)))
    );
    return t;
  }

  private onCwd(t: Term, cwd: string | undefined): boolean {
    if (!cwd) return false;
    if (cwd !== t.info.cwd) {
      t.info.cwd = cwd;
      if (t.resource) t.resource.activity.reportedCwd = cwd;
      this.pushListSoon();
    }
    return true;
  }

  private spawnInto(t: Term, shell: ResolvedShell): void {
    let spawn: PtySpawn;
    try {
      spawn = this.deps.spawn ?? loadPty().spawn;
    } catch (e) {
      // Every terminal on this machine is broken, not just this tab: that is an error, not a warning.
      this.deps.log('error', errorMessage(e));
      throw e;
    }
    let proc: IPty;
    let owner: OwnedTerminalProcess | undefined;
    let intent: ProcessOwnershipIntent | undefined;
    let launched: IPty | undefined;
    let receiptFile = path.join(this.deps.dir, `${t.info.id}.${shortId('p_')}.owner`);
    const managed = this.deps.isManaged?.(t.info.sessionId) ?? false;
    try {
      if (this.managedDrains.has(t.info.sessionId)) throw new Error('Terminal session is closing');
      if (managed && (shell.kind === 'wsl' || /^wsl(?:\.exe)?$/i.test(baseName(shell.file)))) throw new Error('Managed terminals cannot contain WSL guest processes');
      if (managed && this.activity(t.info.sessionId).some((r) => r.state !== 'live')) throw new Error('A previous terminal process teardown remains uncertain');
      const guardedSpawn: PtySpawn = (file, args, options) => {
        mkdirSync(this.deps.dir, { recursive: true });
        writeFileSync(receiptFile, JSON.stringify({ terminalId: t.info.id, sessionId: t.info.sessionId, cwd: t.info.cwd, reportedCwd: t.info.cwd, managed, state: 'uncertain', ownershipNonce: intent?.record.nonce } satisfies TerminalActivity), { flag: 'wx', flush: true });
        try {
          this.deps.beforeSpawn?.(t.info.cwd);
          launched = spawn(file, args, options);
          return launched;
        } catch (error) {
          // No returned PTY means the backend did not launch. Never delete a live generation.
          try { unlinkSync(receiptFile); } catch { /* a retained record safely blocks recovery */ }
          throw error;
        }
      };
      const options = { name: 'xterm-256color', cols: t.cols, rows: t.rows, cwd: t.info.cwd, env: terminalEnv(process.env, this.deps.version) };
      const nativeWindowsShell = process.platform === 'win32' && shell.kind !== 'wsl' && !/^wsl(?:\.exe)?$/i.test(baseName(shell.file));
      if (managed || nativeWindowsShell && this.deps.windowsJobHelper) {
        if (!this.deps.spawnOwned) {
          if (!/^[A-Za-z0-9_-]+$/.test(t.info.sessionId)) throw new Error('Invalid terminal owner session');
          intent = createProcessOwnershipIntent(path.join(this.deps.dir, 'process-ownership', t.info.sessionId), { kind: 'terminal', terminalId: t.info.id, sessionId: t.info.sessionId, cwd: t.info.cwd });
          receiptFile = path.join(this.deps.dir, `${t.info.id}.${intent.record.nonce}.owner`);
        }
        owner = this.deps.spawnOwned
          ? this.deps.spawnOwned(shell.file, shell.args, options, guardedSpawn)
          : spawnOwnedTerminal(shell.file, shell.args, options, guardedSpawn, this.deps.windowsJobHelper, intent);
        proc = owner.pty;
      } else proc = guardedSpawn(shell.file, shell.args, options);
    } catch (e) {
      if (launched) this.trackResource(t, launched, managed, receiptFile, owner, intent);
      else if (intent) { try { recordUnlaunchedProcessIntent(intent); } catch { /* An incomplete receipt blocks recovery. */ } }
      const message = `Could not start ${shell.name} (${shell.file}) in ${t.info.cwd}: ${errorMessage(e)}`;
      this.deps.log('warn', `terminal ${t.info.id}: ${message}`);
      throw new Error(message);
    }
    const resource = this.trackResource(t, proc, managed, receiptFile, owner, intent);
    t.resource = resource;
    this.deps.log('debug', `terminal ${t.info.id}: started ${shell.name} (${shell.file}) pid ${proc.pid || '?'} in ${t.info.cwd}`);
    const gen = ++t.gen;
    t.pty = proc;
    t.shellFile = shell.file;
    // ConPTY reports the pid only once the pseudo console has connected, so it is re-read with the first output.
    t.info.pid = proc.pid || undefined;
    t.info.exit = undefined;
    t.info.restored = false;
    t.info.shell = shell.kind;
    t.info.shellName = shell.name;
    if (!t.info.customTitle) t.info.title = shell.name;
    proc.onData((data) => {
      if (t.gen !== gen) return;
      if (proc.pid && t.info.pid !== proc.pid) {
        t.info.pid = proc.pid;
        this.pushListSoon();
      }
      this.feed(t, data);
    });
    const showExit = (exitCode: number, signal?: number) => {
      if (t.gen !== gen) return;
      t.pty = null;
      t.info.pid = undefined;
      t.info.exit = { code: exitCode, signal: signal || undefined };
      if (exitCode === 0 && !signal) {
        // A typed `exit` closes the tab, as in any terminal app; failures stay readable.
        void this.close(t.info.id).catch((error) => this.deps.log('warn', `terminal ${t.info.id}: ${errorMessage(error)}`));
        return;
      }
      this.deps.log('info', `terminal ${t.info.id} (${shell.name}) exited with code ${exitCode}${signal ? `, signal ${signal}` : ''}`);
      this.feed(t, `\r\n\x1b[2m[process exited with code ${exitCode}${signal ? `, signal ${signal}` : ''}]\x1b[0m\r\n`);
      this.pushList();
    };
    proc.onExit(({ exitCode, signal }) => {
      // A PowerShell supervisor may exit zero even when its target failed. Use the separately
      // authenticated receipt, which may be delivered just after the PTY's exit callback.
      if (owner) void owner.quiescent.then(() => showExit(owner.exitCode ?? exitCode, signal), () => showExit(-1, signal));
      else showExit(exitCode, signal);
    });
    // Type-ahead: input meant for a restored tab is written as soon as its shell exists.
    if (t.pendingInput.length) {
      const queued = t.pendingInput.join('');
      t.pendingInput.length = 0;
      proc.write(queued);
    }
  }

  private trackResource(t: Term, pty: IPty, managed: boolean, receiptFile: string, owner?: OwnedTerminalProcess, intent?: ProcessOwnershipIntent): TerminalResource {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const r: TerminalResource = {
      activity: { terminalId: t.info.id, sessionId: t.info.sessionId, cwd: t.info.cwd, reportedCwd: t.info.cwd, pid: pty.pid || undefined, managed, state: 'live', ...(intent ? { ownershipNonce: intent.record.nonce } : {}) },
      pty, receiptFile, owner, intent, rootExited: false, treeQuiet: false, done, finish
    };
    this.resources.add(r);
    // This listener is independent of t.gen and survives tab disposal/restart.
    const exit = pty.onExit(() => {
      r.rootExited = true;
      if (!owner) this.markUncertain(r, 'Shell exited without owned process-tree confirmation');
      else if (r.activity.state === 'live') r.activity.state = 'closing';
      this.settleResource(r);
      exit.dispose();
    });
    if (owner) void owner.quiescent.then(() => { r.treeQuiet = true; this.settleResource(r); }, (error) => this.markUncertain(r, errorMessage(error)));
    this.deps.onActivity?.(r.activity.sessionId);
    return r;
  }

  private settleResource(r: TerminalResource): void {
    if (!r.rootExited || !r.treeQuiet) return;
    try { unlinkSync(r.receiptFile); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.markUncertain(r, `Could not retire terminal ownership record: ${errorMessage(error)}`); return; }
    }
    this.resources.delete(r);
    r.finish();
    this.deps.onActivity?.(r.activity.sessionId);
  }

  private markUncertain(r: TerminalResource, reason: string): void {
    if (!this.resources.has(r)) return;
    r.activity.state = 'uncertain';
    r.activity.reason = reason;
    this.deps.onActivity?.(r.activity.sessionId);
    this.deps.log('warn', `terminal ${r.activity.terminalId}: ${reason}`);
  }

  private stopResource(r: TerminalResource): Promise<void> {
    this.settleResource(r);
    if (!this.resources.has(r)) return Promise.resolve();
    if (r.closing) return r.closing;
    r.activity.state = 'closing';
    const run = Promise.resolve().then(async () => {
      if (!this.resources.has(r)) return;
      if (!r.owner) {
        // Never target a PID after observing its exit: it could already belong to another app.
        if (!r.rootExited && r.pty) (this.deps.killTree ?? killProcessTree)(r.pty);
        throw new Error('Terminal was started without process-tree containment; teardown cannot be confirmed');
      }
      r.owner.close();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          r.done,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Terminal process teardown timed out; owned activity remains uncertain')), this.deps.managedCloseTimeoutMs ?? 15_000); })
        ]);
      } finally { clearTimeout(timer); }
    }).catch((error: unknown) => {
      this.markUncertain(r, errorMessage(error));
      throw error;
    });
    r.closing = run;
    void run.finally(() => { if (r.closing === run) r.closing = undefined; }).catch(() => undefined);
    return run;
  }

  private feed(t: Term, data: string): void {
    t.seq++;
    t.screen.write(data);
    if (!t.attached) return;
    this.deps.push('push:terminalData', { terminalId: t.info.id, seq: t.seq, data });
    t.unacked += data.length;
    if (!t.paused && t.unacked > FLOW_HIGH_WATER && t.pty) {
      t.paused = true;
      t.pty.pause();
    }
  }

  private release(t: Term): void {
    t.attached = false;
    t.unacked = 0;
    if (t.paused) {
      t.paused = false;
      t.pty?.resume();
    }
  }

  private file(id: string): string {
    return path.join(this.deps.dir, `${id}.json`);
  }

  private pushList(): void {
    if (this.listTimer) {
      clearTimeout(this.listTimer);
      this.listTimer = null;
    }
    this.deps.push('push:terminalsChanged', this.list());
  }

  /** Title and cwd updates arrive with every prompt; coalesce them. */
  private pushListSoon(): void {
    if (this.listTimer) return;
    this.listTimer = setTimeout(() => {
      this.listTimer = null;
      this.pushList();
    }, 150);
  }

  private must(id: string): Term {
    const t = this.terms.get(id);
    if (!t) throw new Error('Terminal not found');
    return t;
  }
}
