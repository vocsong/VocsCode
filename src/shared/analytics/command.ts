/**
 * Structural analysis of shell command lines: which shell ran them, what executables they name and
 * what the agent was trying to do. Deterministic and free of any output inspection, so the same
 * command always yields the same shape. Nothing here decides whether a command failed.
 */
import type { HarnessId } from '../harness-types';
import type { LogicalOperation, ShellDialect } from './taxonomy';

export type CommandComplexity = 'simple' | 'pipeline' | 'compound' | 'script';

export interface CommandSegment {
  /** Normalized executable: basename, lowercased, without `.exe`; `(script)` for a relative script path. */
  exe: string;
  /** Arguments after the executable and any wrapper prefixes (`sudo`, `env`, `time`, `npx`). */
  args: string[];
  /** Operator that joined this segment to the previous one. */
  joinedBy?: '|' | '&&' | '||' | ';' | '\n' | '&';
}

export interface CommandShape {
  /** The command as the shell saw it, with any harness wrapper removed. */
  inner: string;
  shell: ShellDialect;
  /** Set when the harness launched the command through an explicit shell wrapper (`powershell -Command …`). */
  wrapper?: string;
  segments: CommandSegment[];
  /** Executables of every segment in order, prefix commands (`cd`, `echo`) excluded. */
  executables: string[];
  /** The executable that names the intent of the command line, or undefined when only prefixes remain. */
  primary?: string;
  /**
   * The executable most likely to own the line's exit code: the last stage of the last pipeline that
   * is not a pure filter (`head`, `tail`, `Select-Object` …), since a filter rarely fails.
   */
  last?: string;
  pipes: number;
  ands: number;
  ors: number;
  semicolons: number;
  multiline: boolean;
  subshell: boolean;
  redirection: boolean;
  heredoc: boolean;
  background: boolean;
  elevated: boolean;
  complexity: CommandComplexity;
  /**
   * True when the line uses idioms of a different shell than the one it ran in: bash utilities under
   * PowerShell, cmdlets under bash, `2>/dev/null` under PowerShell, and so on.
   */
  shellMismatch: boolean;
  /** PowerShell passes `*` to native programs verbatim; `rg pattern src/*.ts` then names a literal file. */
  globUnderPowershell: boolean;
  /** The line anticipates failure: `2>/dev/null`, `|| true`, `-ErrorAction SilentlyContinue` and the like. */
  tolerant: boolean;
  operation: LogicalOperation;
}

export interface UnwrappedCommand {
  inner: string;
  shell?: ShellDialect;
  wrapper?: string;
}

const POWERSHELL_WRAPPER = /^\s*"?(?:[A-Za-z]:\\|\/)?[^"\s]*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-\w+(?:\s+\w+)?\s+)*?-(?:Command|c|EncodedCommand)\s+/i;
const BASH_WRAPPER = /^\s*"?(?:[A-Za-z]:\\|\/)?[^"\s]*?\b(bash|sh|zsh|fish)(?:\.exe)?"?\s+(?:-[a-zA-Z]*\s+)*?-[a-zA-Z]*c[a-zA-Z]*\s+/;
const CMD_WRAPPER = /^\s*"?(?:[A-Za-z]:\\|\/)?[^"\s]*?\bcmd(?:\.exe)?"?\s+(?:\/[dsq]\s+)*\/c\s+/i;

/** Removes one quoting layer around a wrapped script, unescaping the quote character used. */
function unquote(script: string): string {
  const s = script.trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    const q = s[0];
    const body = s.slice(1, -1);
    return q === '"' ? body.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : body.replace(/'"'"'/g, "'").replace(/''/g, "'");
  }
  // A shell-quoted script whose closing quote was lost to truncation: still strip the opening one.
  if (s.length >= 1 && (s[0] === '"' || s[0] === "'")) return s.slice(1).replace(/\\"/g, '"');
  return s;
}

/** Strips a harness's explicit shell launcher, reporting which shell it named. */
export function unwrapCommand(command: string): UnwrappedCommand {
  let m = POWERSHELL_WRAPPER.exec(command);
  if (m) return { inner: unquote(command.slice(m[0].length)), shell: 'powershell', wrapper: 'powershell' };
  m = CMD_WRAPPER.exec(command);
  if (m) return { inner: unquote(command.slice(m[0].length)), shell: 'cmd', wrapper: 'cmd' };
  m = BASH_WRAPPER.exec(command);
  if (m) {
    const shell = m[1] as ShellDialect;
    return { inner: unquote(command.slice(m[0].length)), shell, wrapper: shell };
  }
  return { inner: command };
}

/**
 * The shell a tool call ran in when the harness did not name one: Claude's `PowerShell` tool and
 * pi's `powershell` tool are PowerShell; every other shell tool is bash (git-bash on Windows) except
 * Codex's `shell`, which follows the platform default.
 */
export function defaultShell(harness: HarnessId | string, toolKey: string, platform: string): ShellDialect {
  if (toolKey === 'powershell') return 'powershell';
  if (toolKey === 'bash') return 'bash';
  if (harness === 'codex' || harness === 'codex-exec') return platform === 'win32' ? 'powershell' : 'bash';
  if (harness === 'native') return platform === 'win32' ? 'powershell' : 'bash';
  return platform === 'win32' ? 'unknown' : 'bash';
}

const PREFIX_COMMANDS = new Set(['cd', 'pushd', 'popd', 'set-location', 'sl', 'echo', 'write-output', 'write-host', 'printf', 'export', 'set', 'unset', 'source', '.', 'true', ':', 'exit', 'sleep', 'start-sleep', 'clear', 'cls', 'wait']);
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'foreach', 'do', 'done', 'while', 'until', 'case', 'esac', 'select', 'function', 'try', 'catch', 'finally', 'switch', 'begin', 'process', 'end', 'param', 'return', 'break', 'continue', 'throw', 'trap', '{', '}']);
const RUNNER_PREFIXES = new Set(['sudo', 'doas', 'env', 'time', 'nohup', 'command', 'exec', 'builtin', 'nice', 'stdbuf', 'xargs', 'timeout', 'gtimeout', 'caffeinate', 'winpty', 'chronic']);

const BASH_ONLY_EXES = new Set(['head', 'tail', 'grep', 'egrep', 'fgrep', 'sed', 'awk', 'gawk', 'xargs', 'wc', 'tee', 'touch', 'which', 'tr', 'cut', 'uniq', 'export', 'source', 'chmod', 'chown', 'ln', 'basename', 'dirname', 'readlink', 'realpath', 'printf', 'seq', 'yes', 'true', 'false', 'test', '[', '[[', 'if', 'then', 'fi', 'for', 'do', 'done', 'while', 'case', 'esac', 'function', 'local', 'declare', 'read', 'shift', 'getopts', 'stat', 'du', 'df', 'nl', 'tac', 'rev', 'column', 'paste', 'join', 'comm', 'diff', 'cmp', 'file', 'strings', 'od', 'xxd', 'md5sum', 'sha256sum', 'sha1sum', 'base64', 'mktemp', 'uname', 'whoami', 'id', 'groups', 'ps', 'kill', 'pgrep', 'pkill', 'top', 'free', 'uptime', 'mount', 'umount', 'apt', 'apt-get', 'dpkg', 'yum', 'dnf', 'pacman', 'brew']);
const POWERSHELL_ONLY_EXES = /^(?:get|set|select|test|write|foreach|format|join|new|remove|copy|move|rename|invoke|out|where|measure|sort|group|start|stop|add|clear|convert|convertfrom|convertto|export|import|read|resolve|split|compare|wait|restart|register|update|push|pop|enter|exit|show|find|install|uninstall|save|publish|send|receive|enable|disable|expand|compress|split)-[a-z]+$/i;
const POWERSHELL_ALIASES = new Set(['gci', 'gc', 'sls', 'gcm', 'gi', 'ni', 'ri', 'rni', 'iwr', 'irm', 'iex', 'ft', 'fl', 'fw', 'select', 'where', 'foreach', 'measure', 'sort', 'group', 'tee-object', 'oh', 'gm', 'gv', 'sv', 'gps', 'spps', 'sajb', 'gjb', 'rjb', 'gsv', 'sasv', 'spsv']);

/** Pipeline stages that transform their input and almost never decide a line's exit status. */
export const FILTER_EXES = new Set(['head', 'tail', 'cat', 'tee', 'less', 'more', 'sort', 'uniq', 'wc', 'cut', 'tr', 'awk', 'gawk', 'sed', 'column', 'nl', 'tac', 'rev', 'jq', 'yq', 'xargs', 'fold', 'fmt', 'paste', 'strings', 'select-object', 'select', 'where-object', 'where', 'format-table', 'ft', 'format-list', 'fl', 'format-wide', 'fw', 'out-string', 'out-host', 'oh', 'out-null', 'measure-object', 'measure', 'sort-object', 'foreach-object', 'foreach', 'tee-object', 'group-object', 'group', 'convertto-json', 'convertfrom-json', 'out-file', 'set-content', 'add-content', 'tail-object']);

const SEARCH_EXES = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'fd', 'fdfind', 'findstr', 'select-string', 'sls', 'ugrep', 'git-grep']);
const INSPECT_EXES = new Set(['ls', 'dir', 'tree', 'find', 'wc', 'stat', 'file', 'du', 'df', 'get-childitem', 'gci', 'get-item', 'gi', 'test-path', 'realpath', 'readlink', 'exa', 'eza', 'lsd', 'pwd', 'get-location', 'gl', 'glob', 'md5sum', 'sha256sum', 'sha1sum', 'diff', 'cmp', 'comm', 'compare-object', 'measure-object', 'measure']);
const READ_EXES = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'batcat', 'type', 'get-content', 'gc', 'sed', 'awk', 'gawk', 'cut', 'sort', 'sort-object', 'uniq', 'tr', 'jq', 'yq', 'strings', 'od', 'xxd', 'hexdump', 'nl', 'column', 'tac', 'rev', 'paste', 'select-object', 'select', 'format-table', 'ft', 'format-list', 'fl', 'out-string', 'convertfrom-json', 'convertto-json', 'base64', 'iconv']);
const WRITE_EXES = new Set(['tee', 'touch', 'set-content', 'sc', 'out-file', 'add-content', 'ac', 'tee-object', 'new-item', 'ni']);
const EDIT_EXES = new Set(['patch']);
const TEST_EXES = new Set(['vitest', 'jest', 'mocha', 'pytest', 'py.test', 'nose2', 'phpunit', 'rspec', 'ctest', 'ava', 'tap', 'playwright', 'cypress', 'karma', 'jasmine', 'uvu', 'tape', 'behave', 'busted', 'minitest', 'testthat', 'ginkgo', 'gotestsum']);
const CHECK_EXES = new Set(['tsc', 'eslint', 'prettier', 'ruff', 'flake8', 'mypy', 'pyright', 'pylint', 'black', 'isort', 'golangci-lint', 'stylelint', 'biome', 'oxlint', 'shellcheck', 'markdownlint', 'hadolint', 'vue-tsc', 'svelte-check', 'clippy', 'rubocop', 'phpstan', 'psalm', 'checkstyle', 'spotless', 'ktlint', 'detekt', 'swiftlint', 'clang-tidy', 'cppcheck', 'luacheck', 'yamllint', 'actionlint', 'knip', 'depcheck', 'madge', 'tsd', 'attw', 'publint']);
const BUILD_EXES = new Set(['vite', 'webpack', 'esbuild', 'rollup', 'parcel', 'turbo', 'nx', 'make', 'cmake', 'ninja', 'gradle', 'gradlew', 'mvn', 'mvnw', 'msbuild', 'electron-builder', 'electron-vite', 'electron-forge', 'gcc', 'g++', 'clang', 'clang++', 'cc', 'javac', 'rustc', 'zig', 'swift', 'swiftc', 'tsup', 'unbuild', 'ncc', 'pkg', 'nexe', 'wasm-pack', 'trunk', 'meson', 'bazel', 'buck2', 'lerna', 'rush', 'pnpm-workspace']);
const INSTALL_EXES = new Set(['pip', 'pip3', 'pipx', 'poetry', 'uv', 'conda', 'mamba', 'gem', 'bundle', 'bundler', 'composer', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'apk', 'brew', 'choco', 'winget', 'scoop', 'nvm', 'fnm', 'volta', 'corepack', 'rustup', 'nix', 'nix-env', 'snap', 'flatpak']);
const GIT_EXES = new Set(['git', 'gh', 'hub', 'glab', 'svn', 'hg', 'git-lfs', 'jj', 'sapling', 'sl', 'pre-commit', 'lefthook', 'husky']);
const FS_EXES = new Set(['mkdir', 'rmdir', 'rm', 'cp', 'mv', 'ln', 'chmod', 'chown', 'chgrp', 'del', 'erase', 'rd', 'md', 'copy', 'move', 'ren', 'rename', 'xcopy', 'robocopy', 'remove-item', 'ri', 'copy-item', 'cpi', 'move-item', 'mi', 'rename-item', 'rni', 'unzip', 'zip', 'tar', 'gzip', 'gunzip', 'bzip2', 'xz', '7z', '7za', 'mktemp', 'truncate', 'shred', 'rsync', 'install', 'expand-archive', 'compress-archive', 'attrib', 'icacls', 'takeown', 'mklink', 'fsutil', 'sync', 'dd']);
const NETWORK_EXES = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'ssh', 'scp', 'sftp', 'ping', 'nc', 'ncat', 'netcat', 'netstat', 'ss', 'dig', 'nslookup', 'host', 'telnet', 'http', 'https', 'httpie', 'aria2c', 'traceroute', 'tracert', 'ipconfig', 'ifconfig', 'ip', 'lsof', 'test-netconnection', 'tnc', 'resolve-dnsname', 'openssl']);
const PROBE_EXES = new Set(['which', 'where', 'where.exe', 'command', 'whoami', 'uname', 'hostname', 'id', 'env', 'printenv', 'get-command', 'gcm', 'get-host', 'get-variable', 'gv', 'get-process', 'gps', 'ps', 'pgrep', 'tasklist', 'get-cimInstance', 'get-ciminstance', 'get-wmiobject', 'systeminfo', 'sw_vers', 'lsb_release', 'nproc', 'free', 'uptime', 'date', 'get-date', 'locale', 'chcp', 'ver', 'set', 'getconf', 'ulimit', 'pwsh', 'powershell']);
const RUNTIME_EXES = new Set(['node', 'nodejs', 'python', 'python3', 'py', 'deno', 'bun', 'tsx', 'ts-node', 'ruby', 'perl', 'php', 'java', 'kotlin', 'scala', 'lua', 'luajit', 'rscript', 'julia', 'elixir', 'erl', 'dotnet', 'mono', 'electron', 'osascript', 'wscript', 'cscript']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx', 'pnpx', 'cargo', 'go', 'dotnet', 'deno', 'uv', 'poetry', 'pipenv', 'mix', 'stack', 'cabal', 'swift', 'gradle', 'gradlew', 'mvn']);
const ELEVATION = new Set(['sudo', 'doas', 'runas', 'pkexec', 'gsudo']);

/** Normalizes one executable token: quotes, paths, `.exe`/`.cmd` suffixes and casing. */
export function normalizeExecutable(token: string): string {
  let t = token.trim().replace(/^["']+|["']+$/g, '');
  if (!t) return '';
  if (t.startsWith('&')) t = t.slice(1).replace(/^["']+|["']+$/g, '');
  const parts = t.split(/[\\/]+/).filter(Boolean);
  const base = (parts[parts.length - 1] ?? t).toLowerCase();
  // A script invoked by path (`./scripts/run.sh`, `tools/x.py`) is one identity: its contents are unknown.
  if (parts.length > 1 && /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|mts|rb|pl|ps1|bat|cmd)$/i.test(base)) return '(script)';
  return base.replace(/\.(exe|cmd|bat|com|ps1|sh)$/i, '');
}

/** Splits a command line into segments at unquoted operators, tracking quotes and grouping. */
export function splitSegments(inner: string, shell: ShellDialect): { text: string; joinedBy?: CommandSegment['joinedBy'] }[] {
  const out: { text: string; joinedBy?: CommandSegment['joinedBy'] }[] = [];
  let cur = '';
  let quote: '"' | "'" | '`' | null = null;
  let depth = 0;
  let joinedBy: CommandSegment['joinedBy'] | undefined;
  const heredoc = /<<-?\s*['"]?(\w+)['"]?/.exec(inner);
  let inHeredoc = false;
  const push = (op?: CommandSegment['joinedBy']) => {
    const t = cur.trim();
    if (t) out.push({ text: t, joinedBy });
    cur = '';
    joinedBy = op;
  };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    const next = inner[i + 1];
    if (inHeredoc) {
      cur += ch;
      if (ch === '\n') {
        const rest = inner.slice(i + 1);
        const line = rest.split('\n')[0]?.trim();
        if (heredoc && line === heredoc[1]) inHeredoc = false;
      }
      continue;
    }
    if (quote) {
      cur += ch;
      if (shell !== 'powershell' && ch === '\\' && quote === '"' && next !== undefined) {
        cur += next;
        i++;
        continue;
      }
      if (shell === 'powershell' && ch === '`' && next !== undefined) {
        cur += next;
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || (ch === '`' && shell !== 'powershell')) {
      quote = ch;
      cur += ch;
      continue;
    }
    if (shell !== 'powershell' && ch === '\\' && next !== undefined) {
      cur += ch + next;
      i++;
      continue;
    }
    if (ch === '(' || ch === '{') depth++;
    else if ((ch === ')' || ch === '}') && depth > 0) depth--;
    if (depth === 0) {
      if (ch === '<' && next === '<' && heredoc && inner.indexOf(heredoc[0], i) === i) {
        cur += heredoc[0];
        i += heredoc[0].length - 1;
        inHeredoc = true;
        continue;
      }
      if (ch === '|' && next === '|') {
        push('||');
        i++;
        continue;
      }
      if (ch === '&' && next === '&') {
        push('&&');
        i++;
        continue;
      }
      if (ch === '|') {
        push('|');
        continue;
      }
      if (ch === ';') {
        push(';');
        continue;
      }
      if (ch === '\n') {
        push('\n');
        continue;
      }
      if (ch === '&' && (next === undefined || /\s/.test(next)) && shell !== 'powershell') {
        push('&');
        continue;
      }
    }
    cur += ch;
  }
  push();
  return out;
}

/** Tokenizes one segment on whitespace, keeping quoted runs together and dropping empty tokens. */
export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) tokens.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || /^\$[A-Za-z_][A-Za-z0-9_:]*\s*=/.test(token);
}

/** The executable and arguments of one segment, skipping env assignments, elevation and runner prefixes. */
export function parseSegment(text: string): { exe: string; args: string[]; elevated: boolean } {
  const tokens = tokenize(text.replace(/^\s*\(+|\)+\s*$/g, '').trim());
  let i = 0;
  let elevated = false;
  while (i < tokens.length && isEnvAssignment(tokens[i])) i++;
  while (i < tokens.length) {
    const exe = normalizeExecutable(tokens[i]);
    if (ELEVATION.has(exe)) {
      elevated = true;
      i++;
      // sudo -u user cmd
      while (i < tokens.length && tokens[i].startsWith('-')) i += tokens[i] === '-u' || tokens[i] === '-g' ? 2 : 1;
      continue;
    }
    if (RUNNER_PREFIXES.has(exe)) {
      i++;
      if (exe === 'timeout' || exe === 'gtimeout') {
        while (i < tokens.length && tokens[i].startsWith('-')) i++;
        if (i < tokens.length) i++; // the duration
      } else if (exe === 'env') {
        while (i < tokens.length && (tokens[i].startsWith('-') || isEnvAssignment(tokens[i]))) i++;
      } else if (exe === 'xargs') {
        while (i < tokens.length && tokens[i].startsWith('-')) i += /^-(?:I|n|P|d|L|s)$/.test(tokens[i]) ? 2 : 1;
      } else {
        while (i < tokens.length && tokens[i].startsWith('-')) i++;
      }
      continue;
    }
    // A PowerShell variable assignment `$x = 1` has no executable.
    if (exe.startsWith('$') && tokens[i + 1] === '=') return { exe: '', args: [], elevated };
    // Control-flow keywords mean the segment is a script fragment, not a program.
    if (SHELL_KEYWORDS.has(exe)) return { exe: '(script)', args: tokens.slice(i + 1), elevated };
    return { exe, args: tokens.slice(i + 1), elevated };
  }
  return { exe: '', args: [], elevated };
}

function scriptName(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith('-'));
}

/** The logical operation of one executable with its arguments. */
export function operationOf(exe: string, args: string[], redirection: boolean): LogicalOperation {
  if (!exe) return 'other';
  const first = args.find((a) => !a.startsWith('-'))?.toLowerCase();
  const argText = args.join(' ').toLowerCase();
  if (args.length === 1 && /^(?:--version|-v|-version|--v|version|-h|--help)$/i.test(args[0])) return 'environment_probe';
  if (SEARCH_EXES.has(exe)) return 'search';
  if (exe === 'git') {
    if (first === 'grep') return 'search';
    return 'git_operation';
  }
  if (GIT_EXES.has(exe)) return 'git_operation';
  if (exe === 'npm' || exe === 'pnpm' || exe === 'yarn' || exe === 'bun') {
    if (!first) return exe === 'yarn' ? 'install_dependency' : 'other';
    if (/^(?:i|install|ci|add|remove|rm|uninstall|un|update|up|upgrade|link|dedupe|prune|rebuild|audit)$/.test(first)) return 'install_dependency';
    if (first === 'test' || first === 't' || first === 'tst') return 'run_tests';
    if (first === 'run' || first === 'run-script' || exe !== 'npm') {
      const script = first === 'run' || first === 'run-script' ? args.filter((a) => !a.startsWith('-'))[1]?.toLowerCase() : first;
      if (!script) return 'execute_program';
      if (/test|spec|e2e|smoke/.test(script)) return 'run_tests';
      if (/typecheck|lint|check|format|fmt|prettier|tsc|verify|validate/.test(script)) return 'check';
      if (/build|dist|compile|bundle|pack|package|make/.test(script)) return 'build';
      return 'execute_program';
    }
    if (first === 'ls' || first === 'list' || first === 'view' || first === 'info' || first === 'outdated' || first === 'why' || first === 'explain' || first === 'ping' || first === 'config' || first === 'root' || first === 'prefix' || first === 'bin') return 'environment_probe';
    if (first === 'exec' || first === 'x' || first === 'dlx' || first === 'create' || first === 'init' || first === 'start') return 'execute_program';
    if (first === 'publish' || first === 'pack' || first === 'version') return 'build';
    return 'execute_program';
  }
  if (exe === 'npx' || exe === 'bunx' || exe === 'pnpx') {
    const target = args.filter((a) => !a.startsWith('-') || a === '-y')[0];
    const inner = target && !target.startsWith('-') ? normalizeExecutable(target.replace(/@[^/]*$/, '')) : undefined;
    if (!inner) return 'execute_program';
    return operationOf(inner, args.slice(args.indexOf(target!) + 1), redirection);
  }
  if (exe === 'cargo' || exe === 'go' || exe === 'dotnet' || exe === 'mix' || exe === 'swift' || exe === 'gradle' || exe === 'gradlew' || exe === 'mvn' || exe === 'mvnw' || exe === 'stack' || exe === 'cabal') {
    if (!first) return 'execute_program';
    if (/^(?:test|tests|t|vet)$/.test(first)) return exe === 'go' && first === 'vet' ? 'check' : 'run_tests';
    if (/^(?:check|clippy|fmt|lint|verify|validate)$/.test(first)) return 'check';
    if (/^(?:build|b|compile|package|assemble|publish|install|release|dist|bundle|jar|war|c)$/.test(first)) return exe === 'go' && first === 'install' ? 'install_dependency' : first === 'install' && (exe === 'cargo' || exe === 'mvn' || exe === 'mvnw') ? (exe === 'cargo' ? 'install_dependency' : 'build') : 'build';
    if (/^(?:add|get|mod|remove|update|restore|deps|tool)$/.test(first)) return 'install_dependency';
    if (/^(?:run|r|exec|start|watch|serve)$/.test(first)) return 'execute_program';
    if (/^(?:version|env|list|tree|metadata|doc|help|--version)$/.test(first)) return 'environment_probe';
    return 'execute_program';
  }
  if (exe === 'python' || exe === 'python3' || exe === 'py' || exe === 'node' || exe === 'deno' || exe === 'bun' || exe === 'ruby' || exe === 'perl' || exe === 'php' || exe === 'java' || exe === 'tsx' || exe === 'ts-node') {
    if (/(?:^|\s)-m\s+(?:pytest|unittest|nose2|behave)\b/.test(argText) || /(?:^|\s)--test\b/.test(argText)) return 'run_tests';
    if (/(?:^|\s)-m\s+(?:pip|pipx|poetry|uv|ensurepip)\b/.test(argText)) return 'install_dependency';
    if (/(?:^|\s)-m\s+(?:mypy|pyright|flake8|ruff|pylint|black|isort)\b/.test(argText)) return 'check';
    if (/(?:^|\s)-m\s+(?:build|compileall|py_compile)\b/.test(argText)) return 'build';
    if (/(?:^|\s)-m\s+(?:http\.server|json\.tool)\b/.test(argText)) return 'execute_program';
    const script = scriptName(args);
    if (script && /(?:^|[\\/])(?:[^\\/]*[._-])?(?:test|spec)s?(?:[._-][^\\/]*)?\.(?:[cm]?[jt]sx?|py|rb)$/i.test(script)) return 'run_tests';
    return 'execute_program';
  }
  if (INSTALL_EXES.has(exe)) return 'install_dependency';
  if (TEST_EXES.has(exe)) return 'run_tests';
  if (CHECK_EXES.has(exe)) return 'check';
  if (BUILD_EXES.has(exe)) return 'build';
  if (exe === 'make' || exe === 'ninja') return 'build';
  if (PROBE_EXES.has(exe)) return 'environment_probe';
  if (exe === 'test' || exe === '[' || exe === '[[') return 'environment_probe';
  if (INSPECT_EXES.has(exe)) return 'inspect_repository';
  if (exe === 'sed' || exe === 'perl') {
    if (/(?:^|\s)-[a-zA-Z]*i/.test(argText)) return 'edit_file';
    return 'read_file';
  }
  if (EDIT_EXES.has(exe)) return 'edit_file';
  if (exe === 'apply_patch' || exe === 'apply-patch') return 'apply_patch';
  if (WRITE_EXES.has(exe)) return 'write_file';
  if (READ_EXES.has(exe)) return redirection && (exe === 'cat' || exe === 'echo' || exe === 'printf') ? 'write_file' : 'read_file';
  if (exe === 'echo' || exe === 'printf' || exe === 'write-output') return redirection ? 'write_file' : 'other';
  if (FS_EXES.has(exe)) return 'filesystem_operation';
  if (NETWORK_EXES.has(exe)) return 'network_operation';
  if (exe === 'docker' || exe === 'podman' || exe === 'docker-compose') {
    if (first === 'build') return 'build';
    if (first === 'pull' || first === 'push' || first === 'login') return 'network_operation';
    return 'execute_program';
  }
  if (exe === 'code' || exe === 'cursor' || exe === 'open' || exe === 'xdg-open' || exe === 'start' || exe === 'explorer') return 'other';
  if (RUNTIME_EXES.has(exe) || PACKAGE_MANAGERS.has(exe) || exe === '(script)' || exe === 'bash' || exe === 'sh' || exe === 'zsh' || exe === 'cmd') return 'execute_program';
  if (POWERSHELL_ONLY_EXES.test(exe) || POWERSHELL_ALIASES.has(exe)) {
    if (/^(?:get-content|gc|select-object|select|format-|out-string|convertfrom|convertto)/.test(exe)) return 'read_file';
    if (/^(?:get-childitem|gci|get-item|gi|test-path|resolve-path|get-location|measure)/.test(exe)) return 'inspect_repository';
    if (/^(?:set-content|sc|out-file|add-content|ac|new-item|ni)/.test(exe)) return 'write_file';
    if (/^(?:remove-item|ri|copy-item|cpi|move-item|mi|rename-item|rni|expand-archive|compress-archive)/.test(exe)) return 'filesystem_operation';
    if (/^(?:invoke-webrequest|iwr|invoke-restmethod|irm|test-netconnection|tnc|resolve-dnsname)/.test(exe)) return 'network_operation';
    if (/^(?:get-command|gcm|get-process|gps|get-ciminstance|get-wmiobject|get-host|get-variable|gv|get-date)/.test(exe)) return 'environment_probe';
    if (/^(?:select-string|sls)/.test(exe)) return 'search';
    if (/^(?:start-process|invoke-expression|iex|invoke-command)/.test(exe)) return 'execute_program';
    return 'other';
  }
  // A bare executable the tables do not know is most likely a program of the project or the user's toolchain.
  return 'execute_program';
}

/** Operation of a whole line: the first non-prefix segment's, ranked so a probe never outranks real work. */
function operationOfSegments(segments: CommandSegment[], redirection: boolean): LogicalOperation {
  const candidates = segments.filter((s) => s.exe && !PREFIX_COMMANDS.has(s.exe)).map((s) => operationOf(s.exe, s.args, redirection));
  if (candidates.length === 0) return segments.some((s) => s.exe === 'echo' || s.exe === 'printf') && redirection ? 'write_file' : 'other';
  const rank: LogicalOperation[] = ['run_tests', 'build', 'check', 'install_dependency', 'apply_patch', 'edit_file', 'write_file', 'git_operation', 'execute_program', 'network_operation', 'filesystem_operation', 'search', 'read_file', 'inspect_repository', 'mcp_call', 'delegate', 'environment_probe', 'other'];
  // Pipelines read as their first stage (`rg … | head`), chains as their most consequential stage.
  const first = candidates[0];
  if (segments.filter((s) => s.exe && !PREFIX_COMMANDS.has(s.exe)).every((s, i) => i === 0 || s.joinedBy === '|')) return first;
  return candidates.slice().sort((a, b) => rank.indexOf(a) - rank.indexOf(b))[0];
}

function detectMismatch(shell: ShellDialect, inner: string, segments: CommandSegment[]): boolean {
  if (shell === 'powershell') {
    if (segments.some((s) => BASH_ONLY_EXES.has(s.exe))) return true;
    if (/(?:^|\s)2>\s*\/dev\/null|(?:^|\s)>\s*\/dev\/null|<<-?\s*['"]?\w+|\$\(\s*[a-z]|\bexport\s+\w+=|\bfi\b|\bdone\b|\besac\b|\|\s*head\b|\|\s*tail\b|\|\s*grep\b|\|\s*xargs\b|\|\s*wc\b|\|\s*sed\b|\|\s*awk\b|\|\s*tr\b|\|\s*sort\s|\|\s*cut\b/.test(inner)) return true;
    return false;
  }
  if (shell === 'bash' || shell === 'sh' || shell === 'zsh') {
    if (segments.some((s) => POWERSHELL_ONLY_EXES.test(s.exe) || (POWERSHELL_ALIASES.has(s.exe) && s.exe.includes('-')))) return true;
    if (/\$env:[A-Za-z_]|\|\s*Select-Object\b|\|\s*Where-Object\b|\|\s*ForEach-Object\b|-ErrorAction\s|\bWrite-Host\b/.test(inner)) return true;
    return false;
  }
  if (shell === 'cmd') {
    if (segments.some((s) => BASH_ONLY_EXES.has(s.exe) || POWERSHELL_ONLY_EXES.test(s.exe))) return true;
    return /2>\/dev\/null|\$\(|\$env:/.test(inner);
  }
  return false;
}

function detectGlobUnderPowershell(shell: ShellDialect, segments: CommandSegment[]): boolean {
  if (shell !== 'powershell') return false;
  const natives = segments.filter((s) => SEARCH_EXES.has(s.exe) || s.exe === 'git' || s.exe === 'cat' || s.exe === 'wc');
  return natives.some((s) => s.args.some((a) => !a.startsWith('-') && /[*?]/.test(a) && !/^['"]/.test(a) && !/^!/.test(a) && !/^-g$|^--glob$/.test(a)));
}

/**
 * Analyzes one shell command line as run by `harness` through tool `toolKey`. `platform` selects the
 * default shell when the harness names none.
 */
export function analyzeCommand(command: string, harness: HarnessId | string, toolKey: string, platform: string): CommandShape {
  const unwrapped = unwrapCommand(command);
  const shell = unwrapped.shell ?? defaultShell(harness, toolKey, platform);
  const inner = unwrapped.inner;
  const raw = splitSegments(inner, shell);
  const segments: CommandSegment[] = [];
  let elevated = false;
  for (const r of raw) {
    const p = parseSegment(r.text);
    if (p.elevated) elevated = true;
    segments.push({ exe: p.exe, args: p.args, joinedBy: r.joinedBy });
  }
  const pipes = segments.filter((s) => s.joinedBy === '|').length;
  const ands = segments.filter((s) => s.joinedBy === '&&').length;
  const ors = segments.filter((s) => s.joinedBy === '||').length;
  const semicolons = segments.filter((s) => s.joinedBy === ';' || s.joinedBy === '\n').length;
  const background = segments.some((s) => s.joinedBy === '&');
  const multiline = inner.includes('\n');
  const heredoc = /<<-?\s*['"]?\w+/.test(inner);
  const subshell = shell === 'powershell' ? /\$\(|&\s*\{|\bInvoke-Expression\b|\biex\b/.test(inner) : /\$\(|`[^`]+`|(?:^|[\s;&|])\([^)]*\)/.test(inner);
  const redirection = /(?:^|[^<>])(?:\d?>>?|<)(?!<)\s*(?!&\d)[^\s|&;]/.test(inner.replace(/<<-?\s*['"]?\w+['"]?[\s\S]*$/, ''));
  const executables = segments.filter((s) => s.exe && !PREFIX_COMMANDS.has(s.exe)).map((s) => s.exe);
  const tolerant = /2>\s*(?:\/dev\/null|nul|\$null)|\|\|\s*(?:true|:|echo|exit 0)|;\s*true\s*$|-ErrorAction\s+(?:SilentlyContinue|Ignore)|--no-messages|\|\|\s*\$false|2>&1\s*\|\s*(?:true|:)/i.test(inner);
  const complexity: CommandComplexity = multiline || heredoc || subshell ? 'script' : ands + ors + semicolons > 0 ? 'compound' : pipes > 0 ? 'pipeline' : 'simple';
  return {
    inner,
    shell,
    wrapper: unwrapped.wrapper,
    segments,
    executables,
    primary: executables[0],
    last: exitOwner(segments),
    pipes,
    ands,
    ors,
    semicolons,
    multiline,
    subshell,
    redirection,
    heredoc,
    background,
    elevated,
    complexity,
    shellMismatch: detectMismatch(shell, inner, segments),
    globUnderPowershell: detectGlobUnderPowershell(shell, segments),
    tolerant,
    operation: operationOfSegments(segments, redirection)
  };
}

/**
 * The stage most likely to have produced the line's exit status: within the last pipeline (the part
 * after the final `&&`, `||`, `;` or newline), the last stage that is not a pure filter. A chain's
 * earlier commands may have failed instead; callers lower their confidence for chains.
 */
export function exitOwner(segments: CommandSegment[]): string | undefined {
  let start = 0;
  segments.forEach((s, i) => {
    if (i > 0 && s.joinedBy && s.joinedBy !== '|') start = i;
  });
  const real = (s: CommandSegment) => s.exe && !PREFIX_COMMANDS.has(s.exe);
  const pipeline = segments.slice(start).filter(real);
  for (let i = pipeline.length - 1; i >= 0; i--) if (!FILTER_EXES.has(pipeline[i].exe)) return pipeline[i].exe;
  // `npm test > log; result=$?; tail log; exit $result`: the last pipeline is only a filter, so the
  // status belongs to the last real program anywhere on the line.
  const all = segments.filter(real);
  for (let i = all.length - 1; i >= 0; i--) if (!FILTER_EXES.has(all[i].exe)) return all[i].exe;
  return all.length ? all[all.length - 1].exe : undefined;
}

/** Whether an executable belongs to the toolchain the environment must supply (so its absence is not a typo). */
export function isKnownToolchain(exe: string): boolean {
  return RUNTIME_EXES.has(exe) || PACKAGE_MANAGERS.has(exe) || INSTALL_EXES.has(exe) || TEST_EXES.has(exe) || CHECK_EXES.has(exe) || BUILD_EXES.has(exe) || GIT_EXES.has(exe) || SEARCH_EXES.has(exe) || NETWORK_EXES.has(exe) || ['jq', 'yq', 'docker', 'podman', 'kubectl', 'helm', 'terraform', 'aws', 'az', 'gcloud', 'code', 'make', 'cmake', 'gcc', 'clang', 'wsl', 'bat', 'fd', 'eza', 'exa', 'tree', 'zip', 'unzip', '7z', 'tar', 'rsync', 'ffmpeg', 'convert', 'magick', 'pandoc', 'latex', 'pdflatex', 'dot', 'graphviz', 'sqlite3', 'psql', 'mysql', 'redis-cli', 'mongosh'].includes(exe);
}

/** Whether a missing command name is a utility of another shell (bash under PowerShell or the reverse). */
export function isOtherShellVocabulary(exe: string, shell: ShellDialect): boolean {
  if (shell === 'powershell' || shell === 'cmd') return BASH_ONLY_EXES.has(exe);
  return POWERSHELL_ONLY_EXES.test(exe) || (POWERSHELL_ALIASES.has(exe) && exe.includes('-'));
}
