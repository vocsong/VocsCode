/**
 * The Processes panel's contract: every OS process Vocs Code started — directly, or through a
 * harness, a tool or a terminal — as the main process last sampled it, plus the pure helpers the
 * panel uses to name and group them. No Node/Electron/DOM imports.
 */

/** Who a tracked process works for. No session means the app itself (or nothing claimed it). */
export interface ProcessOwner {
  /** The session whose harness, tool or terminal started it. */
  sessionId?: string;
  /** Set when it runs in (or is) one of that session's terminal tabs. */
  terminalId?: string;
  /** A name for a root the app started: a terminal title, "GitNexus server". */
  label?: string;
}

export interface TrackedProcess {
  pid: number;
  /** The parent the OS recorded. For an orphan that parent has already exited. */
  ppid: number;
  /** Creation time (epoch ms); 0 when the OS would not say. With `pid` it names one process, since PIDs are reused. */
  startedAt: number;
  /** Executable name, e.g. `node.exe`. */
  name: string;
  /** Full command line, when this user may read it. */
  command?: string;
  /** Share of the whole machine's CPU since the previous sample (0–100); absent on the first sample. */
  cpu?: number;
  /** Resident memory (working set) in bytes. */
  memory?: number;
  owner: ProcessOwner;
  /**
   * Its Vocs Code parent has exited, so nothing in the app will ever stop it. Set on the whole
   * subtree. A session's process can be detached on purpose (`Start-Process` of a server window).
   */
  orphaned?: boolean;
  /** Started by an earlier run of Vocs Code that has since quit or crashed. Implies `orphaned`. */
  previousRun?: boolean;
}

export interface ProcessList {
  /** Why the process table could not be read this time; `processes` is then empty. */
  error?: string;
  sampledAt: number;
  processes: TrackedProcess[];
}

/** One process, named so that a reused PID can never stand in for it. */
export interface ProcessTarget {
  pid: number;
  startedAt: number;
}

export interface ProcessEndResult {
  /** Processes signalled, the targets' descendants included. */
  ended: number;
  failed: { pid: number; error: string }[];
}

/** One notable non-infrastructure OS process running for a session (desktop-only). */
export interface SessionOngoingProcess {
  pid: number;
  startedAt: number;
  name: string;
  /** Human-readable process title from `describeProcess`. */
  label: string;
  /** Full command line, when readable, for tooltips. */
  command?: string;
  /** True when its launcher exited (kept attributable via Windows session Job Object). */
  detached?: boolean;
  /** Set when running inside one of the session's terminal tabs. */
  terminalId?: string;
  cpu?: number;
  memory?: number;
}

/** The tab badge and per-session ongoing OS processes, pushed with every sample. Desktop only. */
export interface ProcessSummary {
  count: number;
  orphaned: number;
  /** Notable non-infrastructure processes keyed by sessionId; omitted when empty. */
  bySession?: Record<string, SessionOngoingProcess[]>;
}

export function processKey(p: ProcessTarget): string {
  return `${p.pid}:${p.startedAt}`;
}

/** Splits a command line the way CommandLineToArgvW does; plain space splitting for POSIX `ps` output. */
export function splitCommandLine(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      let slashes = 0;
      while (line[i] === '\\') {
        slashes++;
        i++;
      }
      if (line[i] === '"') {
        current += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) current += '"';
        else quoted = !quoted;
      } else {
        current += '\\'.repeat(slashes);
        i--;
      }
      started = true;
    } else if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else quoted = !quoted;
      started = true;
    } else if ((ch === ' ' || ch === '\t') && !quoted) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

function baseName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

function stem(file: string): string {
  return baseName(file).replace(/\.(exe|cmd|bat|com|ps1|js|mjs|cjs)$/i, '');
}

const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'pythonw', 'ruby', 'perl']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash']);
const MAX_TITLE = 120;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TITLE ? `${flat.slice(0, MAX_TITLE - 1)}…` : flat;
}

/** Arguments after the script, with long ones (inline JSON, base64) cut short. */
function tail(args: string[]): string {
  return args.map((a) => (a.length > 60 ? `${a.slice(0, 57)}…` : /\s/.test(a) ? `"${a}"` : a)).join(' ');
}

function describeArgs(args: string[]): string {
  const [first, ...rest] = args;
  if (!first) return '';
  const exe = stem(first).toLowerCase();
  if (exe === 'claude') return 'Claude Code';
  if (exe === 'codex') return `Codex ${rest.find((a) => !a.startsWith('-')) ?? ''}`.trim();
  if (SHELLS.has(exe)) {
    const at = rest.indexOf('-c');
    if (at >= 0 && rest[at + 1]) {
      const script = rest[at + 1];
      // Claude Code's Bash tool wraps the command in `… && eval '<command>' …`.
      const evaluated = /\beval '((?:[^']|'\\'')*)'/.exec(script);
      return evaluated ? evaluated[1].replace(/'\\''/g, "'") : script;
    }
    const scriptArg = rest.find((a) => !a.startsWith('-'));
    if (scriptArg) return `${baseName(scriptArg)} ${tail(rest.slice(rest.indexOf(scriptArg) + 1))}`;
  }
  if (exe === 'powershell' || exe === 'pwsh') {
    const lower = rest.map((a) => a.toLowerCase());
    const file = lower.indexOf('-file');
    if (file >= 0 && rest[file + 1]) return `${baseName(rest[file + 1])} ${tail(rest.slice(file + 2))}`;
    const command = lower.findIndex((a) => a === '-command' || a === '-c');
    if (command >= 0 && rest[command + 1]) {
      const script = rest.slice(command + 1).join(' ');
      return script.includes('CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT') ? 'PowerShell (Claude Code tool)' : script;
    }
    return 'PowerShell';
  }
  if (INTERPRETERS.has(exe)) {
    const at = rest.findIndex((a) => !a.startsWith('-'));
    // `node -e <code>` runs inline code, not a script: name the interpreter with it.
    const inline = rest.findIndex((a) => /^(-e|-p|-c|--eval|--print)$/.test(a));
    if (at >= 0 && !(inline >= 0 && inline < at)) {
      const script = rest[at];
      const after = rest.slice(at + 1);
      const normalized = script.replace(/\\/g, '/');
      if (/\/npm\/bin\/npm-cli\.js$/.test(normalized)) return `npm ${tail(after)}`;
      if (/\/npm\/bin\/npx-cli\.js$/.test(normalized)) return `npx ${tail(after)}`;
      if (/pi-coding-agent\//.test(normalized)) return 'Pi';
      const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)\/(?:bin|dist|lib|cli)/.exec(normalized);
      if (pkg && pkg[1] !== 'npm') return `${pkg[1]} ${tail(after)}`;
      return `${baseName(script)} ${tail(after)}`;
    }
  }
  return `${stem(first)} ${tail(rest)}`;
}

/**
 * A short, human name for a process: what it is running rather than which interpreter runs it
 * (`npm run dev`, `vocs-memory.mjs`, `Claude Code`), falling back to the executable name.
 */
export function describeProcess(p: Pick<TrackedProcess, 'name' | 'command'>): string {
  const described = p.command ? clip(describeCommand(p.command)) : '';
  return described || stem(p.name) || p.name;
}

function describeCommand(command: string): string {
  if (command.includes('CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT')) return 'PowerShell (Claude Code tool)';
  // `cmd /s /c "<line>"` runs <line> with one pair of outer quotes removed; argv splitting would
  // mangle it, so the inner line is taken from the raw command.
  const cmd = /^\s*"?[^"\s]*?cmd(?:\.exe)?"?\s.*?\/[ck]\s+(.*)$/i.exec(command);
  if (cmd) {
    let inner = cmd[1].trim();
    if (inner.length > 1 && inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
    return describeCommand(inner);
  }
  const args = splitCommandLine(command);
  return args.length ? describeArgs(args) : '';
}

export type ProcessGroupKind = 'orphaned' | 'session' | 'app';

export interface ProcessRow {
  process: TrackedProcess;
  /** Nesting under the row's parent within its group; 0 for a group's roots. */
  depth: number;
}

export interface ProcessGroup {
  key: string;
  kind: ProcessGroupKind;
  sessionId?: string;
  rows: ProcessRow[];
  cpu: number;
  memory: number;
}

function groupOf(p: TrackedProcess): { key: string; kind: ProcessGroupKind; sessionId?: string } {
  // A session's detached process stays with the session that started it; only what an earlier run
  // left, or what no session can claim, is left behind.
  if (p.previousRun || (p.orphaned && !p.owner.sessionId)) return { key: 'orphaned', kind: 'orphaned' };
  if (p.owner.sessionId) return { key: `session:${p.owner.sessionId}`, kind: 'session', sessionId: p.owner.sessionId };
  return { key: 'app', kind: 'app' };
}

/**
 * Groups processes for the panel: left-behind processes first (they are the ones to act on), then
 * the active session, then other sessions, then the app's own services. A session's detached
 * processes stay in its group, flagged `orphaned`. Each group is a forest in
 * start order, every child directly under its parent.
 */
export function groupProcesses(list: TrackedProcess[], activeSessionId?: string): ProcessGroup[] {
  const groups = new Map<string, ProcessGroup>();
  const members = new Map<string, TrackedProcess[]>();
  for (const p of list) {
    const g = groupOf(p);
    if (!groups.has(g.key)) {
      groups.set(g.key, { ...g, rows: [], cpu: 0, memory: 0 });
      members.set(g.key, []);
    }
    members.get(g.key)!.push(p);
  }
  for (const [key, group] of groups) {
    const procs = [...members.get(key)!].sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid);
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const isParent = (parent: TrackedProcess | undefined, child: TrackedProcess) =>
      !!parent && parent !== child && (!parent.startedAt || !child.startedAt || parent.startedAt <= child.startedAt);
    const kids = new Map<number, TrackedProcess[]>();
    const roots: TrackedProcess[] = [];
    for (const p of procs) {
      const parent = byPid.get(p.ppid);
      if (isParent(parent, p)) {
        if (!kids.has(parent!.pid)) kids.set(parent!.pid, []);
        kids.get(parent!.pid)!.push(p);
      } else roots.push(p);
    }
    const visit = (p: TrackedProcess, depth: number) => {
      group.rows.push({ process: p, depth });
      group.cpu += p.cpu ?? 0;
      group.memory += p.memory ?? 0;
      for (const child of kids.get(p.pid) ?? []) visit(child, depth + 1);
    };
    for (const root of roots) visit(root, 0);
  }
  const rank = (g: ProcessGroup) => (g.kind === 'orphaned' ? 0 : g.kind === 'session' ? (g.sessionId === activeSessionId ? 1 : 2) : 3);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || b.memory - a.memory);
}

/** A group's top-level processes: ending them (each with its subtree) ends the whole group. */
export function rootsOf(rows: ProcessRow[]): TrackedProcess[] {
  return rows.filter((row) => row.depth === 0).map((row) => row.process);
}

const HARNESS_BINARIES = new Set(['claude', 'codex', 'agy', 'dsh', 'gemini', 'cursor-agent']);
const HARNESS_SCRIPT_PATTERN = /(?:pi-coding-agent|@anthropic-ai\/claude-agent-sdk|@cursor\/sdk|@deepseek-ai\/dsh)/i;
const HARNESS_WRAPPED_PATTERN = /(?:pi-coding-agent|claude(?:\.exe|\b)|codex(?:\.exe|\b)|@cursor\/sdk|\bagy\b|\bdsh\b|\bgemini\b|@anthropic-ai\/claude-agent-sdk)/i;
const MCP_INFRA_PATTERN = /(?:vocs-memory|gitnexus-scope|cua-driver|@modelcontextprotocol|mcp[-_.]?(?:server|proxy|bridge)|--mcp\b|\bmcp\b)/i;

/** True when the process itself is a harness CLI/runtime (e.g. spawned under a Windows cmd.exe shim). */
function isHarnessRuntime(p: TrackedProcess): boolean {
  const exe = stem(p.name).toLowerCase();
  if (HARNESS_BINARIES.has(exe)) return true;
  if (INTERPRETERS.has(exe) && p.command) {
    const args = splitCommandLine(p.command);
    const script = args.slice(1).find((a) => !a.startsWith('-'));
    if (script && HARNESS_SCRIPT_PATTERN.test(script.replace(/\\/g, '/'))) return true;
  }
  return false;
}

function isMcpInfrastructure(p: TrackedProcess): boolean {
  if (p.owner.label && /^MCP\b/i.test(p.owner.label)) return true;
  const hay = `${p.name} ${p.command ?? ''}`;
  return MCP_INFRA_PATTERN.test(hay);
}

/** True when a shell process is running an explicit script/command rather than sitting idle at a prompt. */
function isShellWithCommand(p: TrackedProcess): boolean {
  const exe = stem(p.name).toLowerCase();
  const cmd = p.command ?? '';
  if (!cmd) return false;
  if (cmd.includes('CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT')) return false;
  if (exe === 'cmd') {
    if (!/\s\/[ck]\s+/i.test(cmd)) return false;
    return !HARNESS_WRAPPED_PATTERN.test(cmd);
  }
  if (exe === 'powershell' || exe === 'pwsh') {
    if (!/\s-(?:c|command|file|encodedcommand|enc)\b/i.test(cmd)) return false;
    return !HARNESS_WRAPPED_PATTERN.test(cmd);
  }
  if (SHELLS.has(exe)) {
    if (!/\s-c\s+/i.test(cmd)) return false;
    return !HARNESS_WRAPPED_PATTERN.test(cmd);
  }
  return false;
}

/** True for a bare interactive shell (or Claude's persistent shell launcher) with no inline command. */
function isIdleShellWrapper(p: TrackedProcess): boolean {
  const exe = stem(p.name).toLowerCase();
  if (p.command?.includes('CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT')) return true;
  if (exe === 'cmd' || exe === 'powershell' || exe === 'pwsh' || SHELLS.has(exe)) {
    return !isShellWithCommand(p);
  }
  return false;
}

/**
 * Classifies live session-owned OS processes into notable ongoing work per session, excluding
 * persistent idle session infrastructure (the harness CLI root, MCP stdio server trees, and idle
 * interactive terminal shells).
 *
 * Included as notable:
 * - Detached session processes (`orphaned` && `!previousRun`, e.g. Start-Process via session Job).
 * - Running commands inside a session's terminal tab (children of a terminal shell root).
 * - Non-MCP child commands executing under a harness root, or direct non-harness tool shells
 *   (e.g. Native harness `runBash`).
 *
 * Each entry names the top-level notable root so multi-process commands (e.g. `npm run dev` +
 * worker children) surface once rather than flooding the session UI.
 */
export function classifySessionOngoingProcesses(list: readonly TrackedProcess[]): Record<string, SessionOngoingProcess[]> {
  const bySessionProcs = new Map<string, TrackedProcess[]>();
  for (const p of list) {
    if (!p.owner.sessionId || p.previousRun) continue;
    let bucket = bySessionProcs.get(p.owner.sessionId);
    if (!bucket) {
      bucket = [];
      bySessionProcs.set(p.owner.sessionId, bucket);
    }
    bucket.push(p);
  }

  const out: Record<string, SessionOngoingProcess[]> = {};
  for (const [sessionId, rawProcs] of bySessionProcs) {
    const procs = [...rawProcs].sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid);
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const isParent = (parent: TrackedProcess | undefined, child: TrackedProcess) =>
      !!parent && parent !== child && (!parent.startedAt || !child.startedAt || parent.startedAt <= child.startedAt);
    const kids = new Map<number, TrackedProcess[]>();
    const roots: TrackedProcess[] = [];
    for (const p of procs) {
      const parent = byPid.get(p.ppid);
      if (isParent(parent, p)) {
        let listForParent = kids.get(parent!.pid);
        if (!listForParent) {
          listForParent = [];
          kids.set(parent!.pid, listForParent);
        }
        listForParent.push(p);
      } else {
        roots.push(p);
      }
    }

    const notable: SessionOngoingProcess[] = [];
    const record = (p: TrackedProcess, detached: boolean) => {
      notable.push({
        pid: p.pid,
        startedAt: p.startedAt,
        name: p.name,
        label: describeProcess(p),
        ...(p.command ? { command: p.command } : {}),
        ...(detached ? { detached: true } : {}),
        ...(p.owner.terminalId ? { terminalId: p.owner.terminalId } : {}),
        ...(p.cpu !== undefined ? { cpu: p.cpu } : {}),
        ...(p.memory !== undefined ? { memory: p.memory } : {})
      });
    };

    const inspectChildren = (parent: TrackedProcess) => {
      for (const child of kids.get(parent.pid) ?? []) {
        if (isMcpInfrastructure(child)) continue;
        if (isIdleShellWrapper(child) || isHarnessRuntime(child)) {
          // A persistent shell wrapper (e.g. Claude's shell launcher or an idle nested shell) or
          // a harness CLI running under a Windows cmd.exe shim is only interesting if it is
          // currently hosting a real child command.
          inspectChildren(child);
          continue;
        }
        record(child, !!child.orphaned);
      }
    };

    for (const root of roots) {
      if (root.orphaned) {
        // Detached from its launcher (kept attributable by the session's Job Object).
        if (!isMcpInfrastructure(root)) record(root, true);
        continue;
      }
      if (root.owner.terminalId) {
        // The terminal tab's own shell is idle infrastructure; any child command running in it is notable.
        inspectChildren(root);
        continue;
      }
      if (isMcpInfrastructure(root)) continue;
      if (isShellWithCommand(root)) {
        // Direct tool shell spawned by main (e.g. Native harness runBash).
        record(root, false);
        continue;
      }
      // Persistent harness runtime root (claude, pi, codex, cursor, agy/dsh/ACP): inspect its children.
      inspectChildren(root);
    }

    if (notable.length > 0) out[sessionId] = notable;
  }
  return out;
}
