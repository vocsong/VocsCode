/**
 * Terminals for the side panel. Each tab is a real PTY (node-pty: ConPTY on Windows, forkpty
 * elsewhere) that lives in the main process, so a shell survives panel switches and renderer
 * reloads. A headless xterm mirrors every PTY: a renderer that (re)attaches gets an exact snapshot
 * of the screen and scrollback, and title / cwd changes are tracked even while no tab is shown.
 * Snapshots are written to disk on quit and come back as lazy tabs on the next launch.
 */
import { spawn as spawnProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
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

/** Kills the shell and everything it started (a hung `npm run dev`, a stuck pager). */
function killProcessTree(p: IPty): void {
  try {
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
  push: (channel: 'push:terminalData' | 'push:terminalsChanged', payload: unknown) => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Test seam: replaces node-pty's spawn. */
  spawn?: PtySpawn;
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
  disposables: { dispose(): void }[];
}

export class TerminalManager {
  private terms = new Map<string, Term>();
  private listTimer: NodeJS.Timeout | null = null;

  constructor(private deps: TerminalManagerDeps) {}

  list(): TerminalInfo[] {
    return [...this.terms.values()].map((t) => ({ ...t.info }));
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
    this.spawnInto(t, shell);
    this.terms.set(id, t);
    this.pushList();
    return { ...info };
  }

  /**
   * A renderer starts showing a terminal: returns the screen as it is right now plus the seq of the
   * last chunk in it. Restored tabs get their shell here, on first sight.
   */
  async attach(id: string, cols: number, rows: number): Promise<{ snapshot: string; seq: number; info: TerminalInfo }> {
    const t = this.must(id);
    if (cols > 0 && rows > 0) this.resize(id, cols, rows);
    if (!t.pty && t.info.restored) {
      this.feed(t, '\r\n\x1b[2m─── restored from the previous session ───\x1b[0m\r\n');
      try {
        this.spawnInto(t, resolveShell(this.deps.settings(), t.info.shell));
      } catch (e) {
        this.feed(t, `\x1b[31m${errorMessage(e)}\x1b[0m\r\n`);
        t.info.exit = { code: -1 };
      }
      this.pushList();
    }
    // Nothing may reach the screen between the drain and the snapshot, or the renderer would see it twice.
    t.attached = false;
    t.pty?.pause();
    await new Promise<void>((r) => t.screen.write('', r));
    const snapshot = t.serializer.serialize({ scrollback: this.deps.settings().scrollback });
    const seq = t.seq;
    t.attached = true;
    t.unacked = 0;
    t.paused = false;
    t.pty?.resume();
    return { snapshot, seq, info: { ...t.info } };
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
    this.must(id).pty?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.must(id);
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

  /** Force-kills the shell and its children; the tab stays so the output can still be read. */
  kill(id: string): void {
    const t = this.must(id);
    if (t.pty) killProcessTree(t.pty);
  }

  /** Starts a fresh shell in the same tab, in the directory the old one reported last. */
  restart(id: string): TerminalInfo {
    const t = this.must(id);
    if (t.pty) {
      const old = t.pty;
      t.gen++; // the old exit handler must not close or annotate the tab
      t.pty = null;
      killProcessTree(old);
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
    t.attached = false;
    t.gen++;
    if (t.pty) killProcessTree(t.pty);
    for (const d of t.disposables) d.dispose();
    t.screen.dispose();
    this.pushList();
    await fs.rm(this.file(id), { force: true }).catch(() => undefined);
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

  /** Closes a session's terminals and waits briefly for the shells to exit, so a worktree can be removed afterwards. */
  async closeForSession(sessionId: string): Promise<void> {
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

  async closeAll(): Promise<void> {
    await Promise.all([...this.terms.keys()].map((id) => this.close(id)));
  }

  updateSettings(ts: TerminalSettings): void {
    for (const t of this.terms.values()) t.screen.options.scrollback = ts.scrollback;
  }

  /** Writes every screen to disk so the tabs come back after a restart. */
  async persist(): Promise<void> {
    if (!this.deps.settings().restoreOnStartup) return;
    await ensureDir(this.deps.dir);
    for (const t of this.terms.values()) {
      await new Promise<void>((r) => t.screen.write('', r)); // output still queued in the parser must make it in
      const snapshot = t.serializer.serialize({ scrollback: this.deps.settings().scrollback });
      const data: Persisted = { info: { ...t.info, pid: undefined, exit: undefined, restored: true }, cols: t.cols, rows: t.rows, snapshot };
      await writeJson(this.file(t.info.id), data).catch((e) => this.deps.log('warn', `terminal snapshot failed: ${errorMessage(e)}`));
    }
  }

  /** Reads persisted screens into lazy tabs; screens of deleted sessions are dropped. */
  async load(): Promise<void> {
    let files: string[] = [];
    try {
      files = (await fs.readdir(this.deps.dir)).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    const restore = this.deps.settings().restoreOnStartup;
    for (const f of files) {
      const full = path.join(this.deps.dir, f);
      const data = await readJson<Persisted | undefined>(full, undefined);
      if (!restore || !data?.info?.id || !this.deps.cwdOf(data.info.sessionId)) {
        await fs.rm(full, { force: true }).catch(() => undefined);
        continue;
      }
      const t = this.newTerm({ ...data.info, pid: undefined, exit: undefined, restored: true }, data.cols || 80, data.rows || 24);
      t.screen.write(data.snapshot ?? '');
      t.seq = 1;
      this.terms.set(t.info.id, t);
    }
  }

  /** App quit: persist, then take the shells down with us. */
  async shutdown(): Promise<void> {
    await this.persist();
    for (const t of this.terms.values()) {
      t.attached = false;
      t.gen++;
      if (t.pty) killProcessTree(t.pty);
    }
  }

  private newTerm(info: TerminalInfo, cols: number, rows: number): Term {
    const screen = new HeadlessTerminal({ cols, rows, scrollback: this.deps.settings().scrollback, allowProposedApi: true });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer);
    const t: Term = { info, pty: null, shellFile: '', gen: 0, screen, serializer, cols, rows, seq: 0, attached: false, unacked: 0, paused: false, disposables: [] };
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
      this.pushListSoon();
    }
    return true;
  }

  private spawnInto(t: Term, shell: ResolvedShell): void {
    const spawn = this.deps.spawn ?? loadPty().spawn;
    let proc: IPty;
    try {
      proc = spawn(shell.file, shell.args, { name: 'xterm-256color', cols: t.cols, rows: t.rows, cwd: t.info.cwd, env: terminalEnv(process.env, this.deps.version) });
    } catch (e) {
      throw new Error(`Could not start ${shell.name} (${shell.file}) in ${t.info.cwd}: ${errorMessage(e)}`);
    }
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
    proc.onExit(({ exitCode, signal }) => {
      if (t.gen !== gen) return;
      t.pty = null;
      t.info.pid = undefined;
      t.info.exit = { code: exitCode, signal: signal || undefined };
      if (exitCode === 0 && !signal) {
        // A typed `exit` closes the tab, as in any terminal app; failures stay readable.
        void this.close(t.info.id);
        return;
      }
      this.feed(t, `\r\n\x1b[2m[process exited with code ${exitCode}${signal ? `, signal ${signal}` : ''}]\x1b[0m\r\n`);
      this.pushList();
    });
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
