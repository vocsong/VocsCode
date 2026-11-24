/**
 * Where a Mission Builder's permission request goes: to its Lead, or past the Lead to the user.
 *
 * The Lead may answer anything confined to the mission's folders, dangerous commands included
 * (`rm -rf build`, `git reset --hard` in a mission worktree). Publishing, elevation, piped downloads,
 * machine-level changes and anything that reaches outside EVERY mission root always go to the user.
 * Outside checks follow symlinks and junctions (`requiresPathApproval`). Fails closed: a request it
 * cannot place goes to the user. Reads the file system for real paths only; never writes.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { isBuiltinReadOnlyMcpName } from '../../shared/builtin-tools';
import { missionToolOf } from '../../shared/mission-mode';
import type { ApprovalRequest } from '../../shared/types';
import { requiresPathApproval } from '../harness/permissions';
import { isDangerousCommand, isMissionUserCommand } from '../harness/types';

export type BuilderRoute = { route: 'lead' } | { route: 'user'; reason: string };

/** The reasons a request skips the Lead, as the user reads them on the approval card. */
export const ROUTE_REASONS = {
  publish: 'pushes or publishes',
  elevation: 'needs elevation',
  download: 'pipes a download into a shell',
  power: 'could stop or restart the machine',
  disk: 'formats or overwrites a disk',
  encoded: 'runs an encoded command',
  machine: "changes the machine outside the mission's folders",
  wipe: 'deletes a system or home folder',
  outside: "reaches outside the mission's folders",
  secret: 'asks for a secret',
  opaque: 'uses a tool the app cannot inspect',
  unknown: 'could not be classified'
} as const;

export interface ClassifyOptions {
  /** The Builder's working folder, for relative paths in a request that carries no `cwd`. */
  cwd?: string;
}

const LEAD: BuilderRoute = { route: 'lead' };
const user = (reason: string): BuilderRoute => ({ route: 'user', reason });

export async function classifyBuilderRequest(request: ApprovalRequest, missionRoots: string[], opts: ClassifyOptions = {}): Promise<BuilderRoute> {
  try {
    return await classify(request, missionRoots, opts);
  } catch {
    return user(ROUTE_REASONS.unknown);
  }
}

async function classify(request: ApprovalRequest, missionRoots: string[], opts: ClassifyOptions): Promise<BuilderRoute> {
  if (request.kind === 'question') {
    // The Lead cannot know a password or token; only the user can type one.
    return request.questions?.some((q) => q.secret) ? user(ROUTE_REASONS.secret) : LEAD;
  }
  if (request.kind === 'command') {
    const command = request.command;
    if (typeof command !== 'string' || !command.trim() || command.length > MAX_COMMAND_CHARS) return user(ROUTE_REASONS.unknown);
    const fixed = commandClass(command);
    if (fixed) return user(fixed);
  }
  const scope = await Scope.open(missionRoots, request.cwd ?? opts.cwd);
  if (!scope) return user(ROUTE_REASONS.unknown);
  // Relative words of a command need the folder it runs in.
  if (request.kind === 'command' && !scope.base) return user(ROUTE_REASONS.unknown);

  // Paths every kind may carry: the folder it runs in and its file changes.
  if (scope.base && !(await scope.containsAbsolute(scope.base))) return user(ROUTE_REASONS.outside);
  const changePaths = (request.changes ?? []).flatMap((c) => [c.path, c.oldPath]).filter((p): p is string => p !== undefined);
  for (const p of changePaths) {
    if (typeof p !== 'string' || !p.trim()) return user(ROUTE_REASONS.unknown);
    const verdict = await scope.check(p);
    if (verdict !== 'inside') return user(verdict === 'unknown' ? ROUTE_REASONS.unknown : ROUTE_REASONS.outside);
  }

  switch (request.kind) {
    case 'command':
      return classifyCommand(request.command!, request.input, scope);
    case 'file_change':
      return changePaths.length ? LEAD : user(ROUTE_REASONS.unknown);
    case 'tool':
      return classifyTool(request, scope, changePaths.length > 0);
    default:
      // Generic confirmations and elicitations name no action the app can check.
      return user(ROUTE_REASONS.unknown);
  }
}

// ---------------------------------------------------------------------------------------------
// Command classes that always reach the user, whatever their paths

const MAX_COMMAND_CHARS = 32_000;
const MAX_CANDIDATES = 400;

const ELEVATION = [
  /\b(?:sudo|doas|pkexec|runas)\b/i,
  /(?:^|[|;&]\s*)\bsu(?:\s+(?!--?(?:help|version|h)\b)\S+|\s*$)/i,
  /-verb\s+runas\b/i
];
const DOWNLOAD = [
  /\b(?:curl|wget|base64)\b[^|;&\r\n]*\|\s*(?:ba|z)?sh\b/i,
  /\b(?:iex|invoke-expression)\s*(?:\(\s*)?(?:iwr|invoke-webrequest|irm|invoke-restmethod)\b/i,
  /\b(?:iwr|invoke-webrequest|irm|invoke-restmethod|curl|wget)\b[^|;&\r\n]*\|\s*(?:iex|invoke-expression)\b/i
];
/** PowerShell accepts any unambiguous prefix of -EncodedCommand, and -ec. */
const ENCODED = /\b(?:powershell|pwsh)(?:\.exe)?\b[^|;&\r\n]*?\s[-/](?:ec|e(?:n(?:c(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)?)?)(?=\s|:|$)/i;
const MACHINE_CLASSES: [RegExp, string][] = [
  [/\b(?:shutdown|reboot|halt|poweroff|stop-computer|restart-computer)\b|:\(\)\s*\{\s*:\|:&\s*\};:/i, ROUTE_REASONS.power],
  [/\bformat(?:\.com)?\s+[a-z]:|\bmkfs(?:\.\w+)?\b|\bdd\s+(?:\S+\s+)*(?:if|of)=\/dev\/|\bdiskpart\b|\b(?:format|clear|initialize)-(?:volume|disk)\b/i, ROUTE_REASONS.disk],
  [ENCODED, ROUTE_REASONS.encoded],
  // Installs and settings that live outside any project folder.
  [/\b(?:npm|pnpm|bun)\s+(?:i|install|add|uninstall|un|remove|rm|r|update|up|upgrade|link|ln)\b[^|;&\r\n]*\s(?:-g|--global)\b/i, ROUTE_REASONS.machine],
  [/\b(?:npm|pnpm|bun)\s+(?:-g|--global)\s+(?:i|install|add|uninstall|un|remove|rm|r|update|up|upgrade|link|ln)\b/i, ROUTE_REASONS.machine],
  [/\byarn\s+global\s+(?:add|remove|upgrade)\b|\b(?:cargo|go)\s+install\b/i, ROUTE_REASONS.machine],
  [/\bdotnet\s+tool\s+(?:install|uninstall|update)\b[^|;&\r\n]*\s(?:-g|--global)\b/i, ROUTE_REASONS.machine],
  [/\b(?:winget|choco|scoop|brew|apt|apt-get|dnf|yum|zypper|apk)\s+(?:install|uninstall|upgrade|remove|purge)\b|\bpacman\s+-S/i, ROUTE_REASONS.machine],
  [/\bgit(?:\s+-{1,2}\S+(?:\s+"[^"]*"|\s+\S+)?)*\s+config\b[^|;&\r\n]*\s--(?:global|system)\b/i, ROUTE_REASONS.machine],
  [/\bsetx\b|\breg(?:\.exe)?\s+(?:add|delete|import|load|unload|restore|copy)\b|\bset-executionpolicy\b|\[(?:system\.)?environment\]::setenvironmentvariable\b/i, ROUTE_REASONS.machine],
  [/\b(?:set|new|remove)-itemproperty\b[^|;&\r\n]*\bhk(?:lm|cu|cr|u|cc):/i, ROUTE_REASONS.machine],
  [/\bschtasks(?:\.exe)?\s+\/(?:create|delete|change)\b|\bcrontab\b/i, ROUTE_REASONS.machine],
  [/\b(?:systemctl|launchctl)\s+(?:enable|disable|start|stop|restart|mask|load|unload|bootstrap|bootout)\b|\bsc(?:\.exe)?\s+(?:config|create|delete|start|stop)\b/i, ROUTE_REASONS.machine]
];

/** The always-user class of a command, decided from its text alone. */
function commandClass(command: string): string | undefined {
  if (isMissionUserCommand(command)) {
    if (ELEVATION.some((re) => re.test(command))) return ROUTE_REASONS.elevation;
    if (DOWNLOAD.some((re) => re.test(command))) return ROUTE_REASONS.download;
    return ROUTE_REASONS.publish;
  }
  for (const [re, reason] of MACHINE_CLASSES) if (re.test(command)) return reason;
  return undefined;
}

async function classifyCommand(command: string, input: unknown, scope: Scope): Promise<BuilderRoute> {
  const dangerous = isDangerousCommand(command);
  const parsed = parseCommand(command);
  // A dangerous command whose quoting cannot be followed cannot be shown to stay inside.
  if (!parsed.balanced && dangerous) return user(ROUTE_REASONS.unknown);
  const candidates = commandCandidates(parsed.segments, 0);
  for (const key of ['cwd', 'workdir', 'working_directory', 'workingDirectory', 'dir']) {
    const value = (input as Record<string, unknown> | null | undefined)?.[key];
    if (typeof value === 'string' && value) candidates.push({ text: value, deleting: false, literal: true });
  }
  if (candidates.length > MAX_CANDIDATES) return user(ROUTE_REASONS.unknown);
  const resolved: { abs: string; deleting: boolean }[] = [];
  for (const c of candidates) {
    const r: Resolved = c.literal ? { kind: 'path', abs: path.resolve(scope.base ?? '', c.text) } : resolveWord(c.text, scope.base);
    if (r.kind === 'skip') continue;
    if (r.kind === 'unresolved') {
      if (dangerous) return user(ROUTE_REASONS.unknown);
      continue;
    }
    if (r.kind === 'outside') return user(ROUTE_REASONS.outside);
    resolved.push({ abs: r.abs, deleting: c.deleting });
  }
  if (resolved.some((r) => r.deleting && isRootOrHome(r.abs))) return user(ROUTE_REASONS.wipe);
  for (const r of resolved) if (!(await scope.containsAbsolute(r.abs))) return user(ROUTE_REASONS.outside);
  return LEAD;
}

// ---------------------------------------------------------------------------------------------
// Tool requests

/** Harness tools whose effect is local and whose targets are named in their input. */
const LOCAL_TOOLS = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'write_file', 'edit_file', 'edit', 'write',
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'read_file', 'list_dir', 'glob', 'grep', 'read', 'ls', 'find',
  'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'KillShell', 'KillBash', 'BashOutput'
]);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'write_file', 'edit_file', 'edit', 'write']);
const PATH_KEY = /^(?:file_?path|notebook_?path|path|paths|file|files|filename|dir|directory|cwd|workdir|working_?directory|root|target|destination|dest|output|out|source|src|old_?path|new_?path)$/i;

async function classifyTool(request: ApprovalRequest, scope: Scope, hasChanges: boolean): Promise<BuilderRoute> {
  const name = request.toolName;
  if (!name) return user(ROUTE_REASONS.unknown);
  // The Builder's own Mission tools and the app's read-only built-ins touch no workspace.
  if (missionToolOf(name) || isBuiltinReadOnlyMcpName(name)) return LEAD;
  if (!LOCAL_TOOLS.has(name)) return user(ROUTE_REASONS.opaque);
  const targets: string[] = [];
  const input = request.input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (!PATH_KEY.test(key)) continue;
      if (typeof value === 'string') targets.push(value);
      else if (Array.isArray(value)) for (const v of value) if (typeof v === 'string') targets.push(v);
    }
  }
  if (EDIT_TOOLS.has(name) && !targets.length && !hasChanges) return user(ROUTE_REASONS.unknown);
  if (targets.length > MAX_CANDIDATES) return user(ROUTE_REASONS.unknown);
  for (const t of targets) {
    if (!t.trim()) return user(ROUTE_REASONS.unknown);
    const verdict = await scope.check(t);
    if (verdict !== 'inside') return user(verdict === 'unknown' ? ROUTE_REASONS.unknown : ROUTE_REASONS.outside);
  }
  return LEAD;
}

// ---------------------------------------------------------------------------------------------
// The mission's folders, as real paths

class Scope {
  private cache = new Map<string, boolean>();

  private constructor(private readonly roots: string[], readonly base: string | undefined) {}

  /** Null when no mission root exists any more, or the request's folder cannot be resolved. */
  static async open(missionRoots: string[], cwd: string | undefined): Promise<Scope | null> {
    const roots = (await Promise.all(missionRoots.filter((r) => typeof r === 'string' && path.isAbsolute(r)).map((r) => fs.realpath(r).catch(() => null))))
      .filter((r): r is string => !!r);
    if (!roots.length) return null;
    let base: string | undefined;
    if (cwd !== undefined) {
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
      const real = await fs.realpath(cwd).catch(() => null);
      if (!real) return null;
      base = real;
    }
    return new Scope(roots, base);
  }

  /** A path the request names literally (no shell expansion). */
  async check(target: string): Promise<'inside' | 'outside' | 'unknown'> {
    if (!path.isAbsolute(target) && !this.base) return 'unknown';
    return (await this.containsAbsolute(path.resolve(this.base ?? '', target))) ? 'inside' : 'outside';
  }

  /** True when `abs` stays inside at least one root once links are followed. */
  async containsAbsolute(abs: string): Promise<boolean> {
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const inside = (await Promise.all(this.roots.map((root) => requiresPathApproval(root, abs)))).some((outside) => !outside);
    this.cache.set(key, inside);
    return inside;
  }
}

/** A drive or file-system root, the home folder, or the folder holding every user's home. */
function isRootOrHome(abs: string): boolean {
  const key = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const target = key(abs);
  const home = os.homedir();
  return target === key(path.parse(path.resolve(abs)).root) || target === key(home) || target === key(path.dirname(home));
}

// ---------------------------------------------------------------------------------------------
// Shell words

interface Word { text: string; quoted: boolean }
interface Segment { words: Word[]; redirects: Word[] }
interface Candidate { text: string; deleting: boolean; literal?: boolean }

/**
 * Splits a command line into simple commands and their words, bash-like but forgiving of Windows
 * paths: a backslash only escapes whitespace and quotes. Heredoc bodies and here-strings are data
 * and dropped. `balanced` is false when a quote or substitution never closed.
 */
function parseCommand(command: string): { segments: Segment[]; balanced: boolean } {
  const segments: Segment[] = [];
  let seg: Segment = { words: [], redirects: [] };
  let text = '';
  let quoted = false;
  let has = false;
  let balanced = true;
  let role: 'word' | 'redirect' | 'heredoc' | 'data' = 'word';
  let heredocStrip = false;
  let heredocs: { delim: string; strip: boolean }[] = [];
  const endWord = () => {
    if (has) {
      if (role === 'heredoc') heredocs.push({ delim: text, strip: heredocStrip });
      else if (role === 'redirect') seg.redirects.push({ text, quoted });
      else if (role === 'word') seg.words.push({ text, quoted });
      role = 'word';
    }
    text = '';
    quoted = false;
    has = false;
  };
  const endSegment = () => {
    endWord();
    if (seg.words.length || seg.redirects.length) segments.push(seg);
    seg = { words: [], redirects: [] };
  };
  const n = command.length;
  let i = 0;
  while (i < n) {
    const c = command[i];
    if (c === "'") {
      const j = command.indexOf("'", i + 1);
      has = quoted = true;
      if (j < 0) {
        balanced = false;
        text += command.slice(i + 1);
        i = n;
        break;
      }
      text += command.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      has = quoted = true;
      i++;
      while (i < n && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < n && '"\\$`'.includes(command[i + 1])) {
          text += command[i + 1];
          i += 2;
          continue;
        }
        text += command[i++];
      }
      if (i >= n) balanced = false;
      i++;
      continue;
    }
    if (c === '\\') {
      const next = command[i + 1];
      if (next === ' ' || next === '\t' || next === '"' || next === "'" || next === '\n') {
        if (next !== '\n') {
          text += next;
          has = true;
        }
        i += 2;
        continue;
      }
      text += c;
      has = true;
      i++;
      continue;
    }
    if (c === '$' && command[i + 1] === '(') {
      // Command substitution stays inside its word, unexpanded.
      let depth = 0;
      let j = i + 1;
      for (; j < n; j++) {
        if (command[j] === '(') depth++;
        else if (command[j] === ')' && --depth === 0) break;
      }
      if (j >= n) balanced = false;
      text += command.slice(i, Math.min(j + 1, n));
      has = true;
      i = j + 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
      continue;
    }
    if (c === '\n') {
      endSegment();
      i++;
      if (heredocs.length) {
        i = skipHeredocs(command, i, heredocs);
        heredocs = [];
      }
      continue;
    }
    if (c === ';' || c === '|' || c === '(' || c === ')') {
      endSegment();
      i++;
      if (c === '|' && (command[i] === '|' || command[i] === '&')) i++;
      continue;
    }
    if (c === '&') {
      if (command[i + 1] === '>') {
        endWord();
        i += command[i + 2] === '>' ? 3 : 2;
        role = 'redirect';
        continue;
      }
      endSegment();
      i++;
      if (command[i] === '&') i++;
      continue;
    }
    if (c === '>' || c === '<') {
      // A bare descriptor number belongs to the operator (2>err.log).
      if (has && !quoted && /^\d+$/.test(text)) {
        text = '';
        has = false;
      } else endWord();
      if (c === '<' && command[i + 1] === '<') {
        if (command[i + 2] === '<') {
          i += 3;
          role = 'data';
          continue;
        }
        i += 2;
        heredocStrip = command[i] === '-';
        if (heredocStrip) i++;
        role = 'heredoc';
        continue;
      }
      i++;
      if (command[i] === '>' || command[i] === '|') i++;
      if (command[i] === '&') {
        i++;
        while (i < n && /[\d-]/.test(command[i])) i++;
        continue;
      }
      role = 'redirect';
      continue;
    }
    text += c;
    has = true;
    i++;
  }
  endSegment();
  return { segments, balanced };
}

function skipHeredocs(s: string, start: number, docs: { delim: string; strip: boolean }[]): number {
  let i = start;
  for (const doc of docs) {
    for (;;) {
      if (i >= s.length) return s.length;
      const end = s.indexOf('\n', i);
      const line = s.slice(i, end < 0 ? s.length : end).replace(/\r$/, '');
      i = end < 0 ? s.length : end + 1;
      if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) break;
    }
  }
  return i;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const KEY_VALUE = /^[A-Za-z_][\w.-]*=([\s\S]*)$/;
const WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice', 'stdbuf', 'timeout', 'xargs', 'npx', 'pnpx', 'bunx', 'call', 'start-process', 'start']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh', 'wsl', 'eval', 'iex', 'invoke-expression']);
/** Shell options that take a value, so the value is not mistaken for the script. */
const PS_VALUE_FLAGS = new Set(['-executionpolicy', '-ep', '-ex', '-workingdirectory', '-wd', '-windowstyle', '-w', '-inputformat', '-outputformat', '-configurationname', '-version']);
const SH_VALUE_FLAGS = new Set(['-o', '+o', '-O', '+O']);
/** Windows commands whose `/x` arguments are switches, not paths. */
const CMD_STYLE = new Set(['cmd', 'rd', 'rmdir', 'del', 'erase', 'copy', 'xcopy', 'robocopy', 'move', 'ren', 'rename', 'attrib', 'icacls', 'takeown', 'findstr', 'dir', 'taskkill', 'schtasks', 'reg', 'where', 'mklink', 'tree', 'fc', 'comp']);
const SWITCH = /^\/[A-Za-z?][A-Za-z0-9?]{0,3}(?::\S*)?$/;
const DELETERS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'rimraf', 'trash']);
const CHDIR = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl']);

/** The program a word names: lowercase, without its folder or a Windows executable extension. */
function programName(word: string): string {
  return path.basename(word.replace(/\\/g, '/')).toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1)$/, '');
}

function commandIndex(words: Word[]): number {
  let i = 0;
  while (i < words.length && !words[i].quoted && ASSIGNMENT.test(words[i].text)) i++;
  while (i < words.length && WRAPPERS.has(programName(words[i].text))) {
    i++;
    while (i < words.length && (/^-/.test(words[i].text) || /^\d+(?:\.\d+)?[smhd]?$/.test(words[i].text) || ASSIGNMENT.test(words[i].text))) i++;
  }
  return i;
}

/** Every word of these commands that could name a file, with nested shell scripts expanded. */
function commandCandidates(segments: Segment[], depth: number): Candidate[] {
  const out: Candidate[] = [];
  for (const seg of segments) {
    const words = seg.words;
    const ci = commandIndex(words);
    const program = ci < words.length ? programName(words[ci].text) : '';
    const cmdStyle = CMD_STYLE.has(program);
    const args = words.slice(ci + 1);
    const deleting = DELETERS.has(program) && args.some((w) => /^-[a-z]*r[a-z]*$/i.test(w.text) || /^--recursive$/i.test(w.text) || /^-recurse$/i.test(w.text) || (cmdStyle && /^\/s$/i.test(w.text)));
    for (const r of seg.redirects) out.push({ text: r.text, deleting: false });
    // Assignment values before the program (FOO=/x cmd, env OUT=/x cmd).
    for (let k = 0; k < Math.min(ci, words.length); k++) {
      const m = KEY_VALUE.exec(words[k].text);
      if (m && ASSIGNMENT.test(words[k].text)) out.push({ text: m[1], deleting: false });
    }
    if (CHDIR.has(program) && !args.some((w) => !w.text.startsWith('-'))) out.push({ text: '~', deleting: false });
    let options = true;
    for (const w of args) {
      if (options && w.text === '--') {
        options = false;
        continue;
      }
      // --out-dir=/x names a path wherever it appears, even after `--` (npm run x -- --out=/x).
      const option = /^-{1,2}[A-Za-z0-9][\w.-]*=([\s\S]*)$/.exec(w.text);
      if (option) {
        out.push({ text: option[1], deleting });
        continue;
      }
      if (options && w.text.startsWith('-')) continue;
      if (cmdStyle && SWITCH.test(w.text)) continue;
      // dd's of=/dev/sda, make's DESTDIR=/x: the value is the path.
      const kv = KEY_VALUE.exec(w.text);
      out.push({ text: kv ? kv[1] : w.text, deleting });
    }
    if (SHELLS.has(program) && depth < 3) {
      // The script a shell or eval runs is itself a command line: either one quoted word or the
      // words that follow the shell's own options.
      const inner = shellScript(program, args);
      if (inner.length > 1) out.push(...commandCandidates([{ words: inner, redirects: [] }], depth + 1));
      for (const w of inner) {
        if (inner.length === 1 || (w.quoted && /\s/.test(w.text))) out.push(...commandCandidates(parseCommand(w.text).segments, depth + 1));
      }
    }
  }
  return out;
}

/** The words after a shell's own options. */
function shellScript(program: string, args: Word[]): Word[] {
  if (program === 'eval' || program === 'iex' || program === 'invoke-expression') return args;
  const valueFlags = program === 'powershell' || program === 'pwsh' ? PS_VALUE_FLAGS : SH_VALUE_FLAGS;
  let k = 0;
  while (k < args.length) {
    const t = args[k].text;
    if (t.startsWith('-') || t.startsWith('+') || (program === 'cmd' && SWITCH.test(t))) {
      k += valueFlags.has(program === 'powershell' || program === 'pwsh' ? t.toLowerCase() : t) ? 2 : 1;
      continue;
    }
    break;
  }
  return args.slice(k);
}

type Resolved = { kind: 'path'; abs: string } | { kind: 'outside' } | { kind: 'unresolved' } | { kind: 'skip' };

/** Environment variables that name well-known locations; anything else stays unexpanded. */
const LOCATION_VARS = new Set(['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ALLUSERSPROFILE', 'PUBLIC', 'SYSTEMROOT', 'WINDIR', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'PWD', 'CD']);

function locationValue(name: string, base: string | undefined): string | undefined {
  const upper = name.toUpperCase();
  if (upper === 'PWD' || upper === 'CD') return base;
  if (upper === 'HOME' || upper === 'USERPROFILE') return process.env[upper] || os.homedir();
  if (upper === 'TEMP' || upper === 'TMP' || upper === 'TMPDIR') return process.env[upper] || os.tmpdir();
  const hit = Object.entries(process.env).find(([k]) => k.toUpperCase() === upper)?.[1];
  return hit || undefined;
}

/**
 * Where a shell word points. `skip` for words that cannot be a local path (URLs, remote specs);
 * `unresolved` for shell expansions the app cannot evaluate; `outside` for a well-known location
 * that is unset here. Globs resolve to the folder before their first wildcard.
 */
function resolveWord(word: string, base: string | undefined): Resolved {
  let text = word;
  if (!text) return { kind: 'skip' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^[\w.-]+@[\w.-]+:/.test(text)) return { kind: 'skip' };
  // Null devices and the standard streams are not files a command can damage.
  if (/^(?:\/dev\/(?:null|zero|stdin|stdout|stderr|tty|fd\/\d+)|nul|con|\$null)$/i.test(text)) return { kind: 'skip' };
  if (text === '~' || /^~[\\/]/.test(text)) text = os.homedir() + text.slice(1);
  else if (text.startsWith('~')) return { kind: 'unresolved' };
  const variable = /^(?:\$\{(\w+)\}|\$env:([\w()]+)|\$(\w+)|%([\w()]+)%)([\s\S]*)$/i.exec(text);
  if (variable) {
    const name = variable[1] ?? variable[2] ?? variable[3] ?? variable[4];
    const rest = variable[5];
    if (!LOCATION_VARS.has(name.toUpperCase()) || (rest && !/^[\\/]/.test(rest))) return { kind: 'unresolved' };
    const value = locationValue(name, base);
    if (!value) return { kind: 'outside' };
    text = value + rest;
  }
  if (/[$`]|%[\w()]+%/.test(text)) return { kind: 'unresolved' };
  const glob = text.search(/[*?[]/);
  if (glob >= 0) {
    const prefix = text.slice(0, glob);
    const sep = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
    text = sep >= 0 ? prefix.slice(0, sep + 1) : '';
  }
  if (process.platform === 'win32') {
    // MSYS/Git Bash drive paths (/c/Users/...).
    const msys = /^\/([a-zA-Z])(?=[\\/]|$)/.exec(text);
    if (msys) text = `${msys[1].toUpperCase()}:\\${text.slice(2).replace(/^[\\/]+/, '')}`;
  }
  if (!path.isAbsolute(text) && !base) return { kind: 'unresolved' };
  return { kind: 'path', abs: path.resolve(base ?? '', text || '.') };
}
