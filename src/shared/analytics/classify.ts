/**
 * Outcome classification of one tool execution. Two steps, kept apart on purpose:
 *
 *  1. `extractFacts` turns a finished tool transcript item into raw, redacted facts — what ran,
 *     where, how it ended, what it printed (an excerpt) — with no judgement attached.
 *  2. `deriveOutcome` reads only those facts and names the outcome, its category, its likely source,
 *     a low-cardinality signature, and how confidently the rules got there.
 *
 * Because step 2 needs nothing but stored facts, every record can be reclassified when the rules
 * change (OUTCOME_CLASSIFIER_VERSION) without touching the history it was derived from.
 */
import type { HarnessId } from '../harness-types';
import type { ToolKindHint } from '../transcript-types';
import { analyzeCommand, FILTER_EXES, isKnownToolchain, isOtherShellVocabulary, normalizeExecutable, type CommandComplexity, type CommandShape } from './command';
import { classifyProcessOutcome, isTerminationCode } from './exit-semantics';
import {
  CATEGORY_CLASS,
  CATEGORY_SOURCE,
  OUTCOME_CLASSIFIER_VERSION,
  type ClassificationConfidence,
  type ClassificationMethod,
  type ErrorCategory,
  type ErrorSource,
  type LogicalOperation,
  type OutcomeClass,
  type PhysicalTool,
  type ShellDialect
} from './taxonomy';
import { commandPreview, errorExcerpt, extractExitCode, isContentLine, normalizeForSignature } from './text';

/** What the classifier is given: the terminal state of a tool call plus where it ran. */
export interface ExecutionInput {
  harness: HarnessId | string;
  tool: string;
  hint?: ToolKindHint;
  status: 'done' | 'error' | 'declined';
  /** Exit code as the harness reported it structurally, when it did. */
  exitCode?: number | null;
  output?: string;
  input?: unknown;
  durationMs?: number;
  /** `process.platform` of the app; the shell defaults and path rules depend on it. */
  platform: string;
}

/** Structural facts of a shell command line, stored for every shell execution. */
export interface CommandFacts {
  /** Executable naming the intent, normalized. */
  exe?: string;
  /** Executable whose exit code the shell returned. */
  last?: string;
  exes: string[];
  pipes: number;
  ands: number;
  ors: number;
  semicolons: number;
  multiline: boolean;
  subshell: boolean;
  redirection: boolean;
  heredoc: boolean;
  elevated: boolean;
  complexity: CommandComplexity;
  shellMismatch: boolean;
  glob: boolean;
  /** The line anticipated failure (`2>/dev/null`, `|| true`, `-ErrorAction SilentlyContinue`). */
  tolerant: boolean;
  /** Set when the harness launched the command through an explicit shell (`powershell -Command`). */
  wrapper?: string;
}

/** Raw facts of one execution; nothing here is an interpretation. */
export interface ExecutionFacts {
  tool: string;
  toolKey: string;
  physical: PhysicalTool;
  operation: LogicalOperation;
  status: 'done' | 'error' | 'declined';
  /** Effective exit code and where it came from. */
  exitCode?: number | null;
  exitSource: 'harness' | 'output' | 'none';
  /**
   * True when the reported exit code is a shell wrapper's rather than the program's: Codex on Windows
   * runs `powershell -Command …`, whose status is 0 or 1 whatever the program returned.
   */
  exitCollapsed?: boolean;
  shell?: ShellDialect;
  cmd?: CommandFacts;
  /** Redacted, bounded command line for drill-down rows. */
  preview?: string;
  outputBytes: number;
  /** Redacted, bounded lines of the output that identify the failure. */
  excerpt?: string;
  durationMs?: number;
  /** Harness-level control signals recognized at ingest. */
  timedOut?: boolean;
  cancelled?: boolean;
  spawnFailed?: boolean;
}

export interface ExecutionDerived {
  outcome: OutcomeClass;
  category?: ErrorCategory;
  source: ErrorSource;
  /** Low-cardinality failure signature, empty for successes. */
  signature: string;
  method: ClassificationMethod;
  confidence: ClassificationConfidence;
  classifier: number;
  note?: string;
}

const SHELL_TOOLS = new Set(['bash', 'shell', 'powershell', 'execute', 'execute_command', 'run_command', 'run_terminal_cmd', 'terminal', 'cmd', 'command', 'exec', 'run_shell_command', 'shell_command', 'computer_use_bash']);
const READ_TOOLS = new Set(['read', 'read_file', 'view', 'view_file', 'cat', 'readfile', 'open_file', 'notebookread', 'read_many_files']);
const EDIT_TOOLS = new Set(['edit', 'edit_file', 'multiedit', 'str_replace', 'str_replace_editor', 'replace', 'notebookedit', 'search_replace']);
const WRITE_TOOLS = new Set(['write', 'write_file', 'create_file', 'create', 'save_file', 'writefile']);
const SEARCH_TOOLS = new Set(['grep', 'glob', 'find', 'ls', 'list_dir', 'list_directory', 'search', 'codebase_search', 'grep_search', 'file_search', 'search_files', 'toolsearch']);
const PATCH_TOOLS = new Set(['apply_patch', 'apply-patch', 'patch']);
const FETCH_TOOLS = new Set(['webfetch', 'web_fetch', 'fetch', 'web_search', 'websearch', 'browse', 'read_url', 'url_fetch']);
const AGENT_TOOLS = new Set(['agent', 'task', 'subagent', 'get_subagent_result', 'steer_subagent', 'subagentworkflow', 'spawn_agent', 'delegate']);
const PLAN_TOOLS = new Set(['todowrite', 'todoread', 'taskcreate', 'taskupdate', 'taskstop', 'taskoutput', 'tasklist', 'update_plan', 'plan', 'exitplanmode', 'enterplanmode', 'todo_list']);
const ASK_TOOLS = new Set(['askuserquestion', 'ask_user', 'request_user_input']);

/** Case-insensitive tool identity shared with the legacy rollups. */
export function toolKeyOf(name: string): string {
  return name.trim().toLowerCase();
}

/** Maps a harness's tool vocabulary onto the physical tool it stands for. */
export function physicalToolOf(name: string, hint?: ToolKindHint, args?: unknown): PhysicalTool {
  const key = toolKeyOf(name);
  if (SHELL_TOOLS.has(key)) return 'shell';
  if (key.startsWith('mcp__') || key.includes('.') && !key.startsWith('.') || hint === 'mcp') return key.startsWith('agent.') ? 'agent' : 'mcp';
  if (READ_TOOLS.has(key)) return 'read';
  if (EDIT_TOOLS.has(key)) return 'edit';
  if (WRITE_TOOLS.has(key)) return 'write';
  if (SEARCH_TOOLS.has(key)) return 'search';
  if (PATCH_TOOLS.has(key)) return 'patch';
  if (FETCH_TOOLS.has(key)) return 'fetch';
  if (AGENT_TOOLS.has(key) || hint === 'agent') return 'agent';
  if (PLAN_TOOLS.has(key) || hint === 'think') return 'plan';
  if (ASK_TOOLS.has(key)) return 'ask';
  if (hint === 'execute' && args && typeof args === 'object' && typeof (args as Record<string, unknown>).command === 'string') return 'shell';
  if (hint === 'read') return 'read';
  if (hint === 'edit') return 'edit';
  if (hint === 'search') return 'search';
  if (hint === 'fetch') return 'fetch';
  return 'other';
}

function operationOfPhysical(physical: PhysicalTool): LogicalOperation {
  switch (physical) {
    case 'read':
      return 'read_file';
    case 'edit':
      return 'edit_file';
    case 'write':
      return 'write_file';
    case 'search':
      return 'search';
    case 'patch':
      return 'apply_patch';
    case 'fetch':
      return 'network_operation';
    case 'agent':
      return 'delegate';
    case 'mcp':
      return 'mcp_call';
    default:
      return 'other';
  }
}

function commandOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ['command', 'cmd', 'script', 'commandLine']) if (typeof o[k] === 'string' && (o[k] as string).trim()) return o[k] as string;
  if (Array.isArray(o.command) && o.command.every((x) => typeof x === 'string')) return (o.command as string[]).join(' ');
  return undefined;
}

function commandFacts(shape: CommandShape): CommandFacts {
  return {
    exe: shape.primary,
    last: shape.last,
    exes: [...new Set(shape.executables)].slice(0, 8),
    pipes: shape.pipes,
    ands: shape.ands,
    ors: shape.ors,
    semicolons: shape.semicolons,
    multiline: shape.multiline,
    subshell: shape.subshell,
    redirection: shape.redirection,
    heredoc: shape.heredoc,
    elevated: shape.elevated,
    complexity: shape.complexity,
    shellMismatch: shape.shellMismatch,
    glob: shape.globUnderPowershell,
    tolerant: shape.tolerant,
    wrapper: shape.wrapper
  };
}

const TIMEOUT_TEXT = /command timed out after|\btimed out after\b|\[timed out|timeout of \d+ ?m?s exceeded|execution timed out|timed out waiting/i;
const ABORT_TEXT = /^command aborted\b|\[interrupted|request interrupted by user|interrupted by user|operation was aborted|the operation was canceled|command was cancelled|aborted by user|user cancelled/im;
const DECLINED_TEXT = /user doesn't want to proceed|user rejected|permission denied by user|denied by the user|not approved by the user|the user declined|user declined|refused by the user/i;
const SPAWN_TEXT = /failed to start shell|spawn \S+ ENOENT|could not start (?:the )?shell|failed to spawn|shell not found|no shell available/i;

/** Step 1: raw, redacted facts of a finished tool call. */
export function extractFacts(input: ExecutionInput): ExecutionFacts {
  const toolKey = toolKeyOf(input.tool);
  const physical = physicalToolOf(input.tool, input.hint, input.input);
  const output = input.output ?? '';
  const facts: ExecutionFacts = {
    tool: input.tool,
    toolKey,
    physical,
    operation: operationOfPhysical(physical),
    status: input.status,
    exitSource: 'none',
    outputBytes: output.length,
    durationMs: typeof input.durationMs === 'number' && input.durationMs >= 0 ? Math.round(input.durationMs) : undefined
  };
  if (typeof input.exitCode === 'number') {
    facts.exitCode = input.exitCode;
    facts.exitSource = 'harness';
  } else {
    const fromText = extractExitCode(output);
    if (fromText !== undefined) {
      facts.exitCode = fromText;
      facts.exitSource = 'output';
    }
  }
  const command = physical === 'shell' ? commandOf(input.input) : undefined;
  if (command !== undefined) {
    const shape = analyzeCommand(command, input.harness, toolKey, input.platform);
    facts.shell = shape.shell;
    facts.cmd = commandFacts(shape);
    facts.operation = shape.operation;
    facts.preview = commandPreview(command);
    if (shape.wrapper === 'powershell' && facts.exitSource === 'harness') facts.exitCollapsed = true;
  } else if (physical === 'shell') {
    facts.shell = 'unknown';
  } else if (physical === 'agent' || physical === 'mcp' || physical === 'other') {
    const summary = input.input && typeof input.input === 'object' ? JSON.stringify(input.input) : undefined;
    if (summary) facts.preview = commandPreview(summary, 120);
  } else {
    const o = input.input && typeof input.input === 'object' ? (input.input as Record<string, unknown>) : undefined;
    const target = o && ['path', 'file_path', 'pattern', 'query', 'url'].map((k) => o[k]).find((v) => typeof v === 'string');
    if (typeof target === 'string') facts.preview = commandPreview(target, 120);
  }
  if (input.status !== 'done' || (facts.exitCode !== undefined && facts.exitCode !== null && facts.exitCode !== 0)) {
    facts.excerpt = errorExcerpt(output);
    const head = output.slice(0, 2000);
    const tail = output.slice(-600);
    if (TIMEOUT_TEXT.test(tail) || TIMEOUT_TEXT.test(head)) facts.timedOut = true;
    if (ABORT_TEXT.test(tail) || ABORT_TEXT.test(head)) facts.cancelled = true;
    if (SPAWN_TEXT.test(head)) facts.spawnFailed = true;
  }
  return facts;
}

interface TextRule {
  re: RegExp;
  category: ErrorCategory;
  confidence: ClassificationConfidence;
  source?: ErrorSource;
  /** Extra low-cardinality detail for the signature, taken from the match. */
  detail?: (m: RegExpExecArray) => string | undefined;
  /** Restricts the rule to some physical tools. */
  only?: PhysicalTool[];
}

const NAME = (m: RegExpExecArray) => (m[1] ? normalizeExecutable(m[1]).slice(0, 40) : undefined);
/** The first captured group of a match, normalized as an option or flag token. */
const OPTION = (m: RegExpExecArray) => {
  const g = m.slice(1).find((x) => typeof x === 'string' && x.length > 0);
  return g ? g.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30) || undefined : undefined;
};

/** Ordered: the first matching rule wins, so specific messages sit above generic ones. */
const TEXT_RULES: TextRule[] = [
  // tool-level protocol failures reported by the harness itself
  { re: /tool-call arguments failed to parse|failed to parse (?:tool )?arguments|invalid json in (?:tool )?arguments|arguments? (?:is|are) not valid json/i, category: 'invalid_tool_arguments', confidence: 'high' },
  { re: /^validation failed for tool|invalid_type|must be (?:object|string|array|number)|required property|is required but was not provided|missing required (?:parameter|argument|field)|input validation error|schema validation/im, category: 'invalid_tool_arguments', confidence: 'high' },
  { re: /^(?:unknown tool|tool\s+\S*\s*not found|no such tool|tool (?:'|")?[\w.-]*(?:'|")? (?:is )?not (?:found|available|registered))/im, category: 'unknown_tool_called', confidence: 'high' },
  { re: /no indexed repositories|not indexed|run:? gitnexus analyze|server (?:is )?not (?:running|connected|available)|mcp server .* (?:failed|unavailable)/i, category: 'tool_unavailable', confidence: 'medium', source: 'environment', only: ['mcp'] },
  { re: /transport closed|connection closed|econnreset|socket hang up|mcp error -?\d+|request timed out|jsonrpc/i, category: 'tool_transport_failure', confidence: 'medium', only: ['mcp'] },
  // file tools
  { re: /could not find (?:edits\[\d+\]|the (?:exact )?text|old_?string|the string)|string to replace not found|oldtext (?:was )?not found|failed to find expected lines|no match found for|did not match|text not found in|original_?text not found|search (?:block|string) not found/i, category: 'edit_target_not_found', confidence: 'high', only: ['edit', 'patch', 'shell'] },
  { re: /found \d+ (?:occurrences|matches) of|must be unique|is not unique|ambiguous match|multiple matches/i, category: 'incorrect_tool_usage', confidence: 'high', only: ['edit', 'patch'] },
  { re: /no changes made|replacement produced identical content|identical to the original|old_?string and new_?string (?:are|must be) (?:the same|different)/i, category: 'incorrect_tool_usage', confidence: 'high', only: ['edit', 'patch'] },
  { re: /edits\[\d+\] and edits\[\d+\] overlap|overlapping edits/i, category: 'invalid_tool_arguments', confidence: 'high', only: ['edit'] },
  { re: /has not been read|must read the file|read the file first|read it first|before editing|has been modified since|file was modified|stale (?:read|content)|version (?:mismatch|changed)/i, category: 'incorrect_tool_usage', confidence: 'high', only: ['edit', 'write', 'patch'] },
  { re: /invalid patch|\*\*\* end patch|requires a utf-8 patch argument|malformed patch|patch (?:does not|doesn't) apply|corrupt patch|patch failed/i, category: 'malformed_patch', confidence: 'high' },
  { re: /offset \d+ is beyond|beyond end of file|line \d+ (?:is )?out of range|invalid (?:offset|line range)/i, category: 'invalid_argument', confidence: 'high', only: ['read'] },
  { re: /file (?:is )?too large|exceeds (?:the )?maximum|too many (?:lines|bytes)|output (?:is )?too large|pattern is too long/i, category: 'invalid_argument', confidence: 'high', only: ['read', 'search', 'shell'] },
  { re: /is a directory\b|eisdir/i, category: 'invalid_argument', confidence: 'high' },
  // shell: command names and syntax
  { re: /(?:^|\n|: )(?:line \d+: )?([^\s:'"`]+): command not found/im, category: 'command_not_found', confidence: 'high', detail: NAME },
  { re: /'([^']+)' is not recognized as an internal or external command/i, category: 'command_not_found', confidence: 'high', detail: NAME },
  { re: /the term '([^']+)' is not recognized as (?:the|a) name of a cmdlet/i, category: 'command_not_found', confidence: 'high', detail: NAME },
  { re: /(?:^|\n)(?:\S+: )?([^\s:'"`]+): (?:No such file or directory|not found)\s*$/im, category: 'command_not_found', confidence: 'low', detail: NAME },
  { re: /syntax error near unexpected token|unexpected eof while looking for|unterminated quoted string|parsererror|unexpected token .* in expression or statement|missing file specification after redirection operator|the string is missing the terminator|was unexpected at this time|missing closing '\)'|missing '\)' in|syntax error: /i, category: 'malformed_syntax', confidence: 'high' },
  { re: /the filename, directory name, or volume label syntax is incorrect/i, category: 'wrong_shell_syntax', confidence: 'high', detail: () => 'unexpanded-glob' },
  { re: /cannot overwrite variable \w+ because it is read-only|variablenotwritable|the variable .* cannot be retrieved because it has not been set/i, category: 'invalid_argument', confidence: 'high' },
  // a test runner that found nothing to run was pointed at the wrong place
  { re: /no test files? found|no tests? (?:found|collected|matched|were found)|could not find (?:any )?tests?|test file .* (?:not found|does not exist)|cannot find (?:any )?tests?|no test suites? found|did not match any test/i, category: 'invalid_path', confidence: 'medium', only: ['shell'] },
  // paths
  { re: /cannot find module '(?:[A-Za-z]:[\\/]|\.{0,2}\/|\/)|no such file or directory|cannot find path|does not exist|enoent|could not find (?:file|directory|path)|path (?:not found|does not exist)|cannot find the (?:file|path) specified|the system cannot find the (?:file|path)|not a directory\b|os error 2\b|os error 3\b|file not found|directory not found|no such directory|couldn't find|does not appear to be a git repository|not found in path/i, category: 'invalid_path', confidence: 'medium' },
  // permissions
  { re: /permission denied|eacces|eperm\b|access is denied|unauthorizedaccess|operation not permitted|insufficient permissions|access denied|requires elevation|run as administrator/i, category: 'permission_denied', confidence: 'high' },
  // credentials
  { re: /authentication failed|not authenticated|\b401\b|unauthorized|please tell me who you are|unable to auto-detect email|invalid api key|api key (?:is )?(?:missing|invalid|required)|no api key|gh auth login|not logged in|login required|credentials? (?:not found|missing|invalid|expired)|token (?:expired|invalid|is required)|could not read username|authentication required/i, category: 'missing_credentials', confidence: 'high' },
  // network
  { re: /econnrefused|enotfound|etimedout|econnreset|ehostunreach|enetunreach|getaddrinfo|could not resolve host|connection refused|network is unreachable|name or service not known|temporary failure in name resolution|fetch failed|failed to connect|unable to connect|connection timed out|\b(?:502|503|504) (?:bad gateway|service unavailable|gateway time-?out)|ssl (?:certificate|error|routines)|certificate verify failed|tls handshake|socket (?:hang up|timeout)|proxy (?:error|refused)|rate limit|too many requests|\b429\b/i, category: 'network_failure', confidence: 'high' },
  // dependencies / runtimes
  { re: /cannot find module '(?![A-Za-z]:[\\/])([^'\\/.][^']*)'|cannot find package '([^']+)'|module not found: (?:error: )?can't resolve '([^']+)'|err_module_not_found/i, category: 'missing_dependency', confidence: 'medium', detail: (m) => (m[1] ?? m[2] ?? m[3])?.split('/').slice(0, 2).join('/').slice(0, 40) },
  { re: /modulenotfounderror|no module named '?([\w.]+)'?|importerror: cannot import|could not find a version that satisfies|no matching distribution|package '?([\w@/.-]+)'? (?:is )?not (?:found|installed)|is not in (?:the|this) registry|e404|could not resolve dependency|unable to resolve dependency|missing (?:peer )?dependency|command failed: .*(?:is not installed|not installed)|is not installed|not available in your current environment|python(?:3)? was not found|no python|no java|no such runtime|runtime not found|unsupported engine|requires node(?:js)? version|node version .* (?:is )?not supported|electron failed to install|binary (?:not found|missing)|rustup could not choose|toolchain .* is not installed/i, category: 'missing_dependency', confidence: 'medium', detail: (m) => (m[1] ?? m[2])?.slice(0, 40) },
  // resources
  { re: /enospc|no space left on device|enomem|out of memory|heap out of memory|javascript heap|emfile|too many open files|cannot allocate memory|disk quota exceeded|killed process|oom-?kill/i, category: 'resource_exhaustion', confidence: 'high' },
  { re: /ebusy|resource busy or locked|being used by another process|device or resource busy|text file busy|file is locked|lock file (?:exists|is held)|unable to (?:obtain|acquire) lock|another (?:process|git process) seems to be running|index\.lock|eexist|already exists/i, category: 'filesystem_failure', confidence: 'medium' },
  // repository state (git)
  { re: /is already (?:used by|checked out at) worktree|already checked out|conflict \(content\)|automatic merge failed|merge conflict|needs merge|you have unmerged (?:paths|files)|your local changes .* would be overwritten|nothing to commit|nothing added to commit|no changes added to commit|did not match any file\(s\) known to git|pathspec .* did not match|no upstream branch|has no upstream|non-fast-forward|\[rejected\]|failed to push some refs|not something we can merge|not a git repository|detached head|cannot rebase|cannot pull with rebase|you need to resolve your current index|a branch named .* already exists|not a valid object name|unknown revision or path|bad revision|ambiguous argument|no merge base|refusing to merge unrelated histories|worktree .* (?:already exists|is locked)|is not a working tree|fatal: this operation must be run in a work tree|cannot lock ref|reference already exists|stash entry is kept|no stash entries|the following untracked working tree files would be overwritten|please commit your changes or stash them|is not a commit and a branch|no tracked branch|branch .* not found|remote .* already exists|does not appear to be a git repository|could not read from remote repository/i, category: 'vcs_state_conflict', confidence: 'high' },
  { re: /pull request .* (?:already exists|is not mergeable)|no pull requests found|could not find any pull request|no commits between|graphql: |http 4\d\d|http 5\d\d|api rate limit/i, category: 'vcs_state_conflict', confidence: 'medium', source: 'external_service' },
  // program-level usage errors
  { re: /unrecognized (?:option|argument|command|subcommand|file type|flag)s?[:\s]*['"]?(-{0,2}[\w-]+)?|unknown (?:option|argument|command|subcommand|flag|switch)s?[:\s]*['"]?(-{0,2}[\w-]+)?|invalid (?:option|argument|choice|value|flag|switch)s?[:\s]*['"]?(-{0,2}[\w-]+)?|illegal option|option .* requires an argument|requires an argument|missing (?:argument|operand|required argument)|too (?:many|few) arguments|error: unexpected argument|unexpected argument|expected \d+ arguments?|usage: |a parameter cannot be found that matches parameter name '?([\w-]+)'?|missing an argument for parameter|cannot bind (?:argument|parameter)|cannot validate argument|parameter set cannot be resolved|positional parameter cannot be found|is not a git command|is not an npm command|unknown command:? |no such (?:option|command|subcommand)|regex parse error|invalid regex|error parsing (?:regex|glob|pattern)|unclosed group|unmatched (?:\(|\[)|bad option|not a valid (?:identifier|option|number|integer)|invalid (?:number|integer|date|url)|expected (?:a |an )?(?:number|string|integer|boolean)|type error: expected|conflicting options|must be a positive number|cannot be used together/i, category: 'invalid_argument', confidence: 'high', detail: OPTION },
  // program errors (an exception surfaced by a runtime)
  { re: /^\s*(?:uncaught )?(?:type|reference|syntax|range|eval|uri|assertion)error\b|^\s*traceback \(most recent call last\)|^\s*error: |^\s*\w+error: |^\s*\w*exception:|^\s*panic(?:ked at)?:|^\s*thread '.*' panicked|^\s*fatal error:|^\s*unhandled (?:promise )?rejection|^\s*exception in thread|^\s*at .*\(.*:\d+:\d+\)$|\bexit status \d|process exited with code|node:internal\/|^\s*Error \[ERR_|^\s*\[error\]/im, category: 'program_error', confidence: 'medium', only: ['shell'] }
];

const PS_STDERR_ARTIFACT = /^\S+(?:\.exe)? : [^\n]*\n(?:[^\n]*\n)?\s*at line:\d+ char:\d+|nativecommanderror|remoteexception|categoryinfo\s*: notspecified/im;
const DIAGNOSTIC_TEXT: Record<'run_tests' | 'check' | 'build', RegExp> = {
  run_tests: /tests?\s+\d+\s+failed|\b\d+ failed\b|\bfail(?:ed|ing)\b|✗|×|assertionerror|expected .* (?:to|but)|test files?\s+\d+ failed|failures?:|not ok\b|\d+ (?:tests? )?failing|failed tests|error tests?|tests? failed/i,
  check: /error ts\d+|\d+ errors?\b|\d+ problems?\b|\d+ warnings?\b|✖|error: |lint(?:ing)? (?:failed|errors)|type ?check(?:ing)? (?:failed|errors)|mypy: error|found \d+ errors?/i,
  build: /build failed|compilation failed|error(?:s)? (?:during|in) (?:build|compilation)|failed to compile|could not compile|error ts\d+|\berror\[e\d+\]|\d+ errors? generated|build error|failed with exit|make: \*\*\*|error: linker|ninja: build stopped|msbuild error|\berror\b/i
};

function stripOutcome(category: ErrorCategory, source: ErrorSource, method: ClassificationMethod, confidence: ClassificationConfidence, signature: string, note?: string): ExecutionDerived {
  return { outcome: CATEGORY_CLASS[category], category, source, signature, method, confidence, classifier: OUTCOME_CLASSIFIER_VERSION, note };
}

function surfaceOf(facts: ExecutionFacts): string {
  return facts.physical === 'shell' ? facts.shell ?? 'shell' : facts.physical;
}

function subjectOf(facts: ExecutionFacts): string {
  if (facts.physical === 'shell') return facts.cmd?.last ?? facts.cmd?.exe ?? 'shell';
  return facts.toolKey || '(unnamed)';
}

/** `surface | category | subject [| detail]`, every part low-cardinality by construction. */
export function signatureOf(facts: ExecutionFacts, category: ErrorCategory, detail?: string): string {
  const subject = subjectOf(facts);
  const parts = [surfaceOf(facts), category, subject];
  if (detail && detail !== subject) parts.push(detail);
  return parts.join(' | ');
}

/** Refines "command not found" by what was missing: another shell's utility, a toolchain program, or something else. */
function commandNotFound(facts: ExecutionFacts, name: string | undefined): ExecutionDerived {
  const shell = facts.shell ?? 'unknown';
  if (name && isOtherShellVocabulary(name, shell)) return stripOutcome('wrong_shell_syntax', 'model', 'stderr_signature', 'high', signatureOf(facts, 'wrong_shell_syntax', name), `${name} is not a ${shell} command`);
  if (name && isKnownToolchain(name)) return stripOutcome('missing_dependency', 'environment', 'stderr_signature', 'medium', signatureOf(facts, 'missing_dependency', name), `${name} is not installed or not on PATH`);
  if (name && facts.cmd?.shellMismatch) return stripOutcome('wrong_shell_syntax', 'model', 'stderr_signature', 'medium', signatureOf(facts, 'wrong_shell_syntax', name));
  return stripOutcome('command_not_found', 'ambiguous', 'stderr_signature', 'medium', signatureOf(facts, 'command_not_found', name));
}

/** The excerpt without program-output lines, so a matched source line never reads as a complaint. */
function signalText(facts: ExecutionFacts): string {
  return (facts.excerpt ?? '')
    .split('\n')
    .filter((l) => !isContentLine(l.trim()))
    .join('\n');
}

function applyTextRules(facts: ExecutionFacts): ExecutionDerived | null {
  const excerpt = signalText(facts);
  if (!excerpt) return null;
  for (const rule of TEXT_RULES) {
    if (rule.only && !rule.only.includes(facts.physical)) continue;
    const m = rule.re.exec(excerpt);
    if (!m) continue;
    const detail = rule.detail?.(m);
    if (rule.category === 'command_not_found') return commandNotFound(facts, detail);
    let category = rule.category;
    let confidence = rule.confidence;
    let note: string | undefined;
    // A path the wrong shell could not expand is a shell-dialect problem, not a wrong path.
    if (category === 'invalid_path' && facts.cmd?.glob) {
      category = 'wrong_shell_syntax';
      confidence = 'medium';
      note = 'glob passed literally by PowerShell';
    }
    if (category === 'malformed_syntax' && facts.cmd?.shellMismatch) {
      category = 'wrong_shell_syntax';
      note = `${facts.shell} parsed a command written for another shell`;
    }
    const source = rule.source ?? CATEGORY_SOURCE[category];
    return stripOutcome(category, source, 'stderr_signature', confidence, signatureOf(facts, category, detail), note);
  }
  return null;
}

function diagnosticByOperation(facts: ExecutionFacts): ExecutionDerived | null {
  const op = facts.operation;
  if (op !== 'run_tests' && op !== 'check' && op !== 'build') return null;
  // A run that was terminated or crashed never reported on the code under test, so it is not a result.
  if (typeof facts.exitCode === 'number' && isTerminationCode(facts.exitCode)) return null;
  const category: ErrorCategory = op === 'run_tests' ? 'test_failures_reported' : op === 'check' ? 'check_failures_reported' : 'build_failed';
  const confirms = facts.excerpt ? DIAGNOSTIC_TEXT[op].test(facts.excerpt) : false;
  return stripOutcome(category, CATEGORY_SOURCE[category], confirms ? 'stderr_signature' : 'exit_semantics', confirms ? 'high' : 'medium', signatureOf(facts, category));
}

/** Step 2: names the outcome of an execution from its stored facts only. */
export function deriveOutcome(facts: ExecutionFacts): ExecutionDerived {
  const ok = (): ExecutionDerived => ({ outcome: 'success', source: 'unknown', signature: '', method: 'harness_signal', confidence: 'high', classifier: OUTCOME_CLASSIFIER_VERSION });
  if (facts.status === 'declined') return stripOutcome('declined', 'user', 'harness_signal', 'high', signatureOf(facts, 'declined'));
  const nonZero = typeof facts.exitCode === 'number' && facts.exitCode !== 0;
  if (facts.status === 'done' && !nonZero) return ok();

  // Control flow recognized from harness status lines beats every other reading.
  if (facts.spawnFailed) return stripOutcome('tool_spawn_failure', 'harness', 'harness_signal', 'high', signatureOf(facts, 'tool_spawn_failure'));
  if (facts.timedOut) return stripOutcome('timeout', 'ambiguous', 'harness_signal', 'high', signatureOf(facts, 'timeout'));
  if (facts.cancelled) return stripOutcome('cancelled', 'user', 'harness_signal', 'high', signatureOf(facts, 'cancelled'));
  if (facts.excerpt && DECLINED_TEXT.test(facts.excerpt)) return stripOutcome('declined', 'user', 'harness_signal', 'high', signatureOf(facts, 'declined'));

  if (facts.physical === 'agent') {
    const text = applyTextRules(facts);
    if (text && text.category === 'invalid_tool_arguments') return text;
    return stripOutcome('subagent_failed', 'ambiguous', 'harness_signal', 'low', signatureOf(facts, 'subagent_failed'));
  }

  if (facts.physical !== 'shell') {
    const text = applyTextRules(facts);
    if (text) return text;
    if (facts.excerpt) return stripOutcome('unknown_failure', 'unknown', 'harness_signal', 'low', signatureOf(facts, 'unknown_failure'), 'no rule matched the tool error');
    return stripOutcome('legacy_unclassified', 'unknown', 'unknown', 'low', signatureOf(facts, 'legacy_unclassified'), 'no output retained');
  }

  // Shell executions.
  const exe = facts.cmd?.last;
  const exes = facts.cmd?.exes ?? [];
  const statusOnly = /^(?:exit code \d+|command exited with code \d+|\(no output\))$/i;
  const hasErrorText = /\b(error|fatal|failed|cannot|invalid|denied|refused|not found|no such|exception|traceback|panic|not recognized)\b/i.test(
    signalText(facts)
      .split('\n')
      .filter((l) => !statusOnly.test(l.trim()))
      .join('\n')
  );
  const outputEmpty = facts.outputBytes === 0 || (!!facts.excerpt && facts.excerpt.split('\n').every((l) => statusOnly.test(l.trim())));
  const exitKnown = typeof facts.exitCode === 'number' && facts.exitCode !== 0;
  const chained = (facts.cmd?.ands ?? 0) + (facts.cmd?.ors ?? 0) + (facts.cmd?.semicolons ?? 0) > 0 && new Set(exes).size > 1;
  const registry = (): ExecutionDerived | null => {
    if (!exitKnown || facts.exitCollapsed) return null;
    const verdict = classifyProcessOutcome({ exe: exe ?? '', args: exe ? argsOf(facts, exe) : [], exitCode: facts.exitCode as number, operation: facts.operation, outputHasErrorText: hasErrorText, outputEmpty });
    if (!verdict) return null;
    // A chain's exit code belongs to whichever segment failed; we only know the likeliest one.
    const confidence: ClassificationConfidence = chained && verdict.confidence === 'high' ? 'medium' : verdict.confidence;
    return stripOutcome(verdict.category, verdict.source ?? CATEGORY_SOURCE[verdict.category], 'exit_semantics', confidence, signatureOf(facts, verdict.category), chained ? `exit code attributed to the last of ${new Set(exes).size} commands` : verdict.note);
  };
  // A documented exit meaning of the owning program comes first: `grep` exit 1 is "no match" even
  // when the matched lines happen to contain the word "error". A forcible termination is the
  // exception: it names only how the process ended, so the output gets to name the cause first.
  const documented = registry();
  if (documented && documented.confidence === 'high' && documented.outcome !== 'failure' && documented.category !== 'process_terminated') return documented;

  // The stderr text names most failures independent of exit code and shell.
  const text = applyTextRules(facts);
  if (text && text.category !== 'program_error') return tolerate(facts, text);

  if (facts.exitCollapsed && typeof facts.exitCode === 'number') {
    // Codex on Windows: only the wrapper's 0/1 is known, so infer from what ran and what it printed.
    const SEARCHERS = ['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'findstr', 'select-string', 'sls', 'fd', 'ugrep'];
    const searchOnly = exes.some((e) => SEARCHERS.includes(e)) && exes.every((e) => SEARCHERS.includes(e) || FILTER_EXES.has(e));
    if (searchOnly && !hasErrorText) return tolerate(facts, stripOutcome('search_no_match', 'model', 'exit_semantics', outputEmpty ? 'high' : 'medium', signatureOf(facts, 'search_no_match'), 'wrapper exit 1, search program, no error text'));
    if (exe === 'git' && /\bgit\s+diff(?:-index|-files)?\b[^|;&]*--(?:quiet|exit-code)/.test(facts.preview ?? '')) return stripOutcome('differences_detected', 'model', 'exit_semantics', 'medium', signatureOf(facts, 'differences_detected'));
    if (exe === 'gh' && /\bgh\s+pr\s+checks\b/.test(facts.preview ?? '') && !hasErrorText) return stripOutcome('probe_negative', 'model', 'exit_semantics', 'medium', signatureOf(facts, 'probe_negative'), 'gh pr checks exits non-zero for pending or failed checks');
    const diag = diagnosticByOperation(facts);
    if (diag) return diag;
    if (facts.excerpt && PS_STDERR_ARTIFACT.test(facts.excerpt)) return stripOutcome('shell_stderr_artifact', 'harness', 'stderr_signature', 'medium', signatureOf(facts, 'shell_stderr_artifact'), 'PowerShell turned native stderr into an error record');
    if (text) return text; // program_error
    return tolerate(facts, stripOutcome('process_nonzero_unknown', 'unknown', 'exit_semantics', 'low', signatureOf(facts, 'process_nonzero_unknown'), 'wrapper collapsed the exit code'));
  }

  if (documented && documented.category !== 'process_terminated') return tolerate(facts, documented.outcome === 'diagnostic' ? diagnosticByOperation(facts) ?? documented : documented);
  const diag = diagnosticByOperation(facts);
  if (diag) return diag;
  if (text) return text; // program_error
  // A forcible termination with no printed cause is control flow, never a failure.
  if (documented) return tolerate(facts, documented);
  if (exitKnown) return tolerate(facts, stripOutcome('process_nonzero_unknown', 'unknown', 'exit_semantics', 'low', signatureOf(facts, 'process_nonzero_unknown')));
  if (facts.excerpt) return stripOutcome('unknown_failure', 'unknown', 'harness_signal', 'low', signatureOf(facts, 'unknown_failure'));
  return stripOutcome('legacy_unclassified', 'unknown', 'unknown', 'low', signatureOf(facts, 'legacy_unclassified'), 'no exit code and no output retained');
}

/**
 * A line written to tolerate failure (`ls x 2>/dev/null`, `cmd || true`) was probing, so a failure it
 * would otherwise be charged with reads as a negative probe. Only weakly-attributed categories flip;
 * a test run or a program crash stays what it is.
 */
function tolerate(facts: ExecutionFacts, derived: ExecutionDerived): ExecutionDerived {
  if (!facts.cmd?.tolerant) return derived;
  const flips: ErrorCategory[] = ['invalid_path', 'process_nonzero_unknown', 'search_no_match', 'unknown_failure', 'vcs_failure', 'command_not_found', 'missing_dependency', 'probe_negative'];
  if (!derived.category || !flips.includes(derived.category)) return derived;
  if (derived.category === 'search_no_match' || derived.category === 'probe_negative') return derived;
  return stripOutcome('probe_negative', 'model', 'heuristic', 'medium', signatureOf(facts, 'probe_negative', derived.category), `failure tolerated by the command line; would otherwise be ${derived.category}`);
}

/** Arguments of the last command in the stored preview, for exit rules that read flags (`git diff --quiet`). */
function argsOf(facts: ExecutionFacts, exe: string): string[] {
  const preview = facts.preview;
  if (!preview) return [];
  const idx = preview.toLowerCase().lastIndexOf(exe);
  if (idx === -1) return [];
  return preview
    .slice(idx + exe.length)
    .split(/\s+/)
    .filter((t) => t && !/^[|;&]/.test(t))
    .slice(0, 12)
    .map((t) => t.replace(/^["']|["']$/g, ''));
}

/** Facts and outcome of a finished tool call in one step, for ingest. */
export function classifyExecution(input: ExecutionInput): { facts: ExecutionFacts; derived: ExecutionDerived } {
  const facts = extractFacts(input);
  return { facts, derived: deriveOutcome(facts) };
}

/** A human-readable form of a signature's detail-free parts, for tables. */
export function describeSignature(signature: string): { surface: string; category: string; subject: string; detail?: string } {
  const [surface = '', category = '', subject = '', detail] = signature.split(' | ');
  return { surface, category, subject, detail };
}

export { normalizeForSignature };
