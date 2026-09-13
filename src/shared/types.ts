/**
 * Shared domain types used by the main process, preload, and renderer.
 * Keep this file free of Node/Electron/DOM imports.
 */
import type { TerminalSettings } from './terminal';
import type { ThemeId } from './themes';
import type { ShortcutCommand } from './shortcuts';

export type HarnessId = 'claude' | 'codex' | 'codex-exec' | 'cursor' | 'pi' | 'acp' | 'native';

/** App-level permission modes, mapped per harness (see harness-meta.ts). */
export type PermissionMode = 'ask' | 'accept-edits' | 'plan' | 'auto' | 'full-auto';

export type EffortLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type AutoCompactionThreshold = '50%' | '75%' | '90%' | '100k' | '250k' | '500k' | '750k' | '1m';

export type SessionStatus = 'idle' | 'starting' | 'running' | 'awaiting' | 'error' | 'stopped' | 'pr' | 'merged';

export interface ModelInfo {
  /** Provider-scoped identifier used in API calls. */
  id: string;
  /** Provider id (e.g. anthropic, openai, deepseek, ollama, openrouter, custom). */
  provider: string;
  displayName: string;
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  supportedEfforts?: EffortLevel[];
  defaultEffort?: EffortLevel;
  /** USD per 1M tokens, when known. */
  pricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  isDefault?: boolean;
  /** Set when a user override in settings replaced what the harness reported. */
  overridden?: boolean;
}

/** A user correction to one model's advertised capabilities (see shared/model-overrides.ts). */
export interface ModelOverride {
  supportsImages?: boolean;
}

export interface ModelRef {
  provider: string;
  model: string;
}

export type ProviderKind =
  | 'anthropic'
  | 'openai'
  | 'openai-compatible'
  | 'cursor'
  | 'deepseek'
  | 'openrouter'
  | 'ollama'
  | 'lmstudio'
  | 'groq'
  | 'xai'
  | 'mistral'
  | 'gemini-openai';

export interface SecretStatus {
  /** Whether the OS-backed safeStorage provider is available. */
  encryptionAvailable: boolean;
  /** Whether one or more stored values use the reversible fallback encoding. */
  hasFallback: boolean;
  /** Provider ids whose stored values use the reversible fallback encoding. */
  fallbackProviderIds: string[];
}

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl?: string;
  /** Whether an API key is stored in the encrypted secret store for this provider. */
  hasApiKey: boolean;
  /** Env var name that can supply the key when no stored key exists. */
  envKey?: string;
  /** Cached model list (refreshable). */
  models: ModelInfo[];
  modelsUpdatedAt?: number;
  /** Optional extra headers for OpenAI-compatible endpoints. */
  headers?: Record<string, string>;
  builtin?: boolean;
  enabled: boolean;
}

export interface AcpAgentPreset {
  id: string;
  name: string;
  description: string;
  /** Command + args to launch the ACP agent (stdio). */
  command: string;
  args: string[];
  /** Env additions. */
  env?: Record<string, string>;
  builtin?: boolean;
}

export interface SessionConfig {
  harness: HarnessId;
  /** Project root chosen by the user (the git repo or folder). */
  projectRoot: string;
  model?: ModelRef;
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  /** Run in an isolated git worktree under .vocs-code/worktrees. */
  useWorktree?: boolean;
  /** ACP agent preset id (for harness 'acp'). */
  acpAgent?: string;
  /** Free-form system prompt addition where supported. */
  appendSystemPrompt?: string;
  /** Soft spend ceiling in USD, enforced where the harness supports it. */
  maxBudgetUsd?: number;
  /** Optional Codex custom model provider (OpenAI-compatible) definition. */
  codexModelProvider?: { id: string; name: string; baseUrl: string; envKey?: string; wireApi?: 'chat' | 'responses' };
}

/** Harnesses that load a global skills directory (see main/skills.ts). */
export type SkillHarness = 'claude' | 'codex' | 'pi';

/** One installed skill: a directory with a SKILL.md carrying name/description frontmatter. */
export interface SkillInfo {
  /** Frontmatter name; falls back to the folder name. */
  name: string;
  description: string;
  /** Absolute path of the skill directory. */
  path: string;
  /** Absolute path of SKILL.md; null when the folder has none. */
  file: string | null;
  /** Last modification of SKILL.md; 0 when missing. */
  mtimeMs: number;
  /** Set when the folder has no readable SKILL.md, with the reason. */
  broken?: string;
}

/** A harness's global skills directory and the skills found in it. */
export interface SkillRootInfo {
  harness: SkillHarness;
  /** Human label; the Codex directory also serves the codex-exec harness. */
  label: string;
  /** Absolute path of the skills directory. */
  path: string;
  /** Same path with the home directory shortened to `~`, for display. */
  display: string;
  /** False when the directory does not exist yet. */
  exists: boolean;
  skills: SkillInfo[];
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  turns: number;
  contextWindow?: number;
  /** Tokens currently in the context window, when the harness reports it. */
  contextTokens?: number;
}

/** The numeric usage counters shared by day buckets and their per-dimension slices. */
export interface UsageCounters {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  turns: number;
  /** Cumulative completed-turn wall time in ms. */
  durationMs: number;
  /** Completed tool calls recorded. */
  toolCalls: number;
  /**
   * Output tokens and wall time of completed turns that reported both, paired so that
   * `speedTokens / speedMs` is a true average output speed (tokens per ms).
   */
  speedTokens: number;
  speedMs: number;
}

/** Usage attributed to one harness, model or project within a day, plus the sessions that produced it. */
export interface UsageSlice extends UsageCounters {
  label: string;
  sessions: string[];
}

/** Per-dimension attribution of one day's usage; the bounded ranges of the dashboard are built from it. */
export interface UsageDayDimensions {
  /** Set when the slices were estimated from session totals for a day recorded before slice tracking. */
  estimated?: boolean;
  harness: Record<string, UsageSlice>;
  /** Keyed `provider/model`, attributed to the model active when the usage was reported. */
  model: Record<string, UsageSlice>;
  project: Record<string, UsageSlice>;
  tool: Record<string, ToolUsage>;
  /** Per-tool call counts keyed by model (`provider/model`), attributed to the model active when the call ran. */
  modelTool: Record<string, Record<string, ToolUsage>>;
  file: Record<string, FileUsage>;
}

/** Aggregated usage for one UTC day, as accumulated by the analytics store. */
export interface UsageDay extends UsageCounters {
  /** Absent on days recorded before per-dimension tracking existed: their usage is in the totals only. */
  by?: UsageDayDimensions;
}

/** Output tokens and wall time of the turns that reported both; `tokens / ms * 1000` is tok/s. */
export interface UsageSpeed {
  tokens: number;
  ms: number;
}

/** Tool-call rollup per tool name. */
export interface ToolUsage {
  calls: number;
  errors: number;
  declined: number;
  durationMs: number;
}

export interface ToolUsageRow extends ToolUsage {
  name: string;
}

/** Tool-call rollup for one tool under one model. */
export interface ModelToolRow extends ToolUsage {
  /** `provider/model` of the session that made the call. */
  key: string;
  /** The model name alone. */
  label: string;
  /** Tool name. */
  name: string;
}

/** File-change counts by change kind, aggregated across tool calls. */
export interface FileUsage {
  adds: number;
  updates: number;
  deletes: number;
  renames: number;
}

export interface FileUsageRow extends FileUsage {
  path: string;
  total: number;
}

/** Per-session usage snapshot; kept in the analytics store even after the session is deleted. */
export interface UsageSessionRecord {
  id: string;
  title: string;
  harness: HarnessId;
  provider?: string;
  model?: string;
  projectRoot: string;
  createdAt: number;
  updatedAt: number;
  usage: UsageTotals;
  /** Completed tool calls recorded for this session. */
  toolCalls: number;
  /** Cumulative completed-turn wall time in ms; absent in records written before it was tracked. */
  durationMs?: number;
  /** Output speed sample for this session; absent in records written before speed was tracked. */
  speed?: UsageSpeed;
}

/** Usage rollup for one dimension (harness, model, project). */
export interface UsageBucket {
  key: string;
  label: string;
  usage: UsageTotals;
  toolCalls: number;
  /** Cumulative completed-turn wall time in ms, so `durationMs / turns` is the average turn. */
  durationMs: number;
  sessions: number;
  speed: UsageSpeed;
}

/** Effective per-model pricing rates, blended from measured usage. */
export interface ModelRateRow {
  key: string;
  label: string;
  /** Effective blended cost per 1,000,000 tokens (input + output + cache), or undefined when no tokens were measured. */
  usdPerMTok?: number;
  /** Effective cost per model call (one turn), or undefined when no turns were measured. */
  usdPerCall?: number;
  /** All-time spend attributed to the model. */
  costUsd: number;
  /** All-time tokens (input + output + cache) attributed to the model. */
  tokens: number;
  /** All-time model calls (turns) attributed to the model. */
  calls: number;
}

export interface AnalyticsDayPoint {
  date: string;
  usage: UsageDay;
}

export interface AnalyticsSummary {
  /** All-time totals across every recorded session, including deleted ones. */
  totals: UsageTotals;
  /** All-time output speed sample (completed turns that reported tokens and duration). */
  speed: UsageSpeed;
  /** UTC days, ascending, filtered to the requested range. */
  days: AnalyticsDayPoint[];
  /** Totals of the window of equal length just before the requested range; absent for all time. */
  previous?: UsageCounters;
  byHarness: UsageBucket[];
  byModel: UsageBucket[];
  byProject: UsageBucket[];
  /** Effective $/M tokens and $/call per model, sorted by spend. */
  modelRates: ModelRateRow[];
  /** All-time tool-call totals and per-tool/per-file breakdowns, sorted by volume. */
  toolTotals: ToolUsage;
  tools: ToolUsageRow[];
  /** Per-tool call counts per model, sorted by volume. */
  modelTools: ModelToolRow[];
  files: FileUsageRow[];
  /** Sessions sorted by spend, highest first. */
  sessions: UsageSessionRecord[];
  sessionCount: number;
  activeDays: number;
  firstDay?: string;
}

export interface HarnessRef {
  /** Claude Agent SDK session id (resume). */
  claudeSessionId?: string;
  /** Codex thread id (thread/resume). */
  codexThreadId?: string;
  /** Cursor agent id (Agent.resume); bc- prefixed ids are cloud agents. */
  cursorAgentId?: string;
  /** Pi session file path. */
  piSessionFile?: string;
  /** ACP session id. */
  acpSessionId?: string;
  /** Native harness message history is stored in the session dir. */
  nativeHistory?: boolean;
  /** When resuming, fork into a fresh harness session instead of continuing (Claude). */
  forkOnResume?: boolean;
}

export interface GoalState {
  objective: string;
  status: 'active' | 'paused' | 'complete' | 'cleared';
  createdAt: number;
  updatedAt: number;
  iterations: number;
  maxIterations: number;
  autoContinue: boolean;
  tokenBudget?: number;
  notes?: string;
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  config: SessionConfig;
  /** Effective working directory (worktree path if isolated). */
  cwd: string;
  worktreeBranch?: string;
  status: SessionStatus;
  statusDetail?: string;
  /** User-picked display label for the status badge; shown instead of the status name until cleared. */
  statusLabel?: string;
  harnessRef: HarnessRef;
  usage: UsageTotals;
  lastError?: string;
  /** Current model as reported by the harness (may differ from config after live switch). */
  activeModel?: ModelRef;
  activeEffort?: EffortLevel;
  goal?: GoalState;
  pinned?: boolean;
  /** Epoch ms when pinned; pinned rows sort by it ascending (first pin on top). Rewritten on drag-reorder. */
  pinnedAt?: number;
  archived?: boolean;
  /** Number of queued (steer/follow-up) messages waiting. */
  queued?: number;
}

export interface ImageAttachment {
  mimeType: string;
  /** Base64 data without the data: prefix. */
  data: string;
  name?: string;
}

export type SendMode = 'now' | 'steer' | 'queue';

export interface UserInput {
  text: string;
  images?: ImageAttachment[];
  mode?: SendMode;
}

export interface FileChange {
  path: string;
  kind: 'add' | 'delete' | 'update' | 'rename';
  diff?: string;
  oldPath?: string;
}

export type ToolKindHint = 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'think' | 'mcp' | 'agent' | 'other';

export type TranscriptItem =
  | {
      id: string;
      kind: 'user';
      ts: number;
      text: string;
      images?: ImageAttachment[];
      queuedAs?: SendMode;
    }
  | {
      id: string;
      kind: 'assistant';
      ts: number;
      text: string;
      thinking?: string;
      model?: string;
      streaming?: boolean;
      /** Codex distinguishes commentary from the final answer. */
      phase?: 'commentary' | 'final' | 'plan';
    }
  | {
      id: string;
      kind: 'tool';
      ts: number;
      name: string;
      title?: string;
      hint?: ToolKindHint;
      input?: unknown;
      /** Pretty summary of the input (command line, path...). */
      summary?: string;
      output?: string;
      status: 'running' | 'done' | 'error' | 'declined';
      exitCode?: number | null;
      durationMs?: number;
      changes?: FileChange[];
      /** Parent tool (subagent) id when nested. */
      parentId?: string | null;
    }
  | {
      id: string;
      kind: 'approval';
      ts: number;
      request: ApprovalRequest;
      decision?: ApprovalDecision;
      decidedAt?: number;
    }
  | {
      id: string;
      kind: 'info';
      ts: number;
      level: 'info' | 'warn' | 'error';
      text: string;
      /** Set while a renderer-local operation (e.g. /pr) is still running; shows a spinner. */
      pending?: boolean;
    }
  | {
      id: string;
      kind: 'turn';
      ts: number;
      status: 'completed' | 'interrupted' | 'failed';
      durationMs?: number;
      usage?: Partial<UsageTotals>;
      costUsd?: number;
      error?: string;
    }
  | {
      id: string;
      kind: 'plan';
      ts: number;
      entries: { content: string; status: 'pending' | 'in_progress' | 'completed'; priority?: string }[];
    };

export type ApprovalKind = 'command' | 'file_change' | 'tool' | 'permission' | 'question' | 'elicitation';

export interface ApprovalOption {
  id: string;
  label: string;
  kind: 'allow' | 'allow_session' | 'allow_always' | 'deny' | 'deny_always' | 'cancel';
  description?: string;
}

export interface ApprovalQuestion {
  id: string;
  header?: string;
  question: string;
  options?: { label: string; description?: string }[];
  allowOther?: boolean;
  secret?: boolean;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  harness: HarnessId;
  kind: ApprovalKind;
  title: string;
  description?: string;
  toolName?: string;
  command?: string;
  cwd?: string;
  input?: unknown;
  changes?: FileChange[];
  options: ApprovalOption[];
  questions?: ApprovalQuestion[];
  createdAt: number;
  /** Related transcript tool item id, when known. */
  toolItemId?: string;
}

export interface ApprovalDecision {
  optionId: string;
  note?: string;
  answers?: Record<string, string>;
  /** For 'allow' with edited input (e.g. modified command). */
  updatedInput?: unknown;
}

export type SessionEvent =
  | { type: 'status'; status: SessionStatus; detail?: string }
  | { type: 'item.upsert'; item: TranscriptItem }
  | {
      type: 'item.delta';
      id: string;
      textDelta?: string;
      thinkingDelta?: string;
      outputDelta?: string;
    }
  | { type: 'approval.request'; request: ApprovalRequest }
  | { type: 'approval.resolved'; requestId: string; decision: ApprovalDecision }
  | { type: 'usage'; totals: UsageTotals }
  | { type: 'meta'; patch: Partial<SessionMeta> }
  | { type: 'error'; message: string; fatal?: boolean }
  | { type: 'models'; models: ModelInfo[] }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };

export interface SessionEventEnvelope {
  sessionId: string;
  event: SessionEvent;
  ts: number;
}

export interface HarnessAvailability {
  available: boolean;
  version?: string;
  binaryPath?: string;
  detail?: string;
  /** Whether the harness appears to be authenticated / has credentials. */
  authenticated?: boolean | 'unknown';
  installHint?: string;
}

export interface HarnessCapabilities {
  streaming: boolean;
  approvals: boolean;
  steer: boolean;
  queue: boolean;
  interrupt: boolean;
  liveModelSwitch: boolean;
  effort: boolean;
  images: boolean;
  /**
   * Whether the harness itself strips image attachments when its own catalog says the selected
   * model is text-only. Pi does this silently (it substitutes a placeholder in the prompt), so a
   * capability override in this app cannot make the image reach the model — the harness catalog
   * has to be corrected too. Everywhere else the attachment is passed through and the provider
   * decides.
   */
  dropsUnsupportedImages: boolean;
  resume: boolean;
  fork: boolean;
  plan: boolean;
  costReporting: boolean;
  /** Which app-level permission modes are meaningful. */
  permissionModes: PermissionMode[];
  /** Whether model selection is provider-scoped (native) or harness-provided list. */
  modelSource: 'harness' | 'providers' | 'acp-config';
}

export interface HarnessDescriptor {
  id: HarnessId;
  name: string;
  tagline: string;
  description: string;
  vendor: string;
  capabilities: HarnessCapabilities;
  docsUrl?: string;
}

/** Sidebar appearance override for one project folder. */
export interface FolderStyle {
  /** Hex color (e.g. `#5b9bf8`) tinting the folder icon and title. */
  color?: string;
  /** Icon name from the renderer's icon set (e.g. `folder`, `bolt`). */
  icon?: string;
}

export interface AppSettings {
  version: 1;
  theme: ThemeId;
  defaultHarness: HarnessId;
  defaultPermissionMode: PermissionMode;
  defaultEffort?: EffortLevel;
  /** Ask supported harnesses to compact at an idle boundary after context reaches this usage. */
  autoCompactionThreshold?: AutoCompactionThreshold;
  /** Last chosen worktree isolation decision in the new-session dialog. */
  defaultUseWorktree?: boolean;
  defaultModelByHarness: Partial<Record<HarnessId, ModelRef>>;
  /** Starred models, always listed first in the model pickers. */
  favoriteModels: ModelRef[];
  notifications: boolean;
  soundOnApproval: boolean;
  /** Explicit binary paths (empty = auto-detect). */
  binaries: {
    claude?: string;
    codex?: string;
    pi?: string;
    dsh?: string;
    npx?: string;
    gemini?: string;
    editor?: string;
  };
  claude: {
    /** 'auto' prefers system CLI (uses the user's login), then bundled. */
    runtime: 'auto' | 'system' | 'bundled';
    /** Use the Anthropic API key from the provider store instead of inherited login. */
    useProviderKey: boolean;
    settingSources: ('user' | 'project' | 'local')[];
  };
  codex: {
    runtime: 'auto' | 'system' | 'bundled';
  };
  pi: {
    extraArgs: string[];
  };
  acpAgents: AcpAgentPreset[];
  providers: ProviderConfig[];
  /** Capability corrections keyed by `provider/model`; see shared/model-overrides.ts. */
  modelOverrides: Record<string, ModelOverride>;
  windowBounds?: { x?: number; y?: number; width: number; height: number };
  sidebarWidth: number;
  panelWidth: number;
  recentProjects: string[];
  /** Project folders that stay in the sidebar even when they have no sessions left. */
  folders: string[];
  /** Per-folder sidebar appearance keyed by project root. */
  folderStyles?: Record<string, FolderStyle>;
  /** User-added labels offered in the status-label picker alongside the built-in statuses. */
  customLabels?: string[];
  /** Manual sidebar order for project folders; roots not listed sort alphabetically after. */
  folderOrder?: string[];
  /** Project roots whose sidebar folder block is collapsed. */
  collapsedFolders?: string[];
  /** Extra keyboard shortcuts keyed by canonical accelerator (e.g. 'Ctrl+Alt+A'); see shared/shortcuts.ts. */
  customShortcuts?: Record<string, ShortcutCommand>;
  goalDefaults: { autoContinue: boolean; maxIterations: number };
  terminal: TerminalSettings;
  /** Cheap model for background tasks (session titles, summaries). Unset until the user picks one. */
  utilityModel?: ModelRef;
  /** Set once the first-run setup guide has been completed. */
  onboardingDone?: boolean;
}

export interface GitFileStatus {
  path: string;
  status: 'M' | 'A' | 'D' | 'R' | '?' | 'U' | 'C' | 'T';
  staged: boolean;
  additions?: number;
  deletions?: number;
  oldPath?: string;
}

export interface GitSummary {
  isRepo: boolean;
  root?: string;
  branch?: string;
  files: GitFileStatus[];
  ahead?: number;
  behind?: number;
  /** Set when git could not produce a trustworthy summary (timeout/corrupt repo); the file list may be empty or incomplete. */
  error?: string;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
}

export interface GitWorktreeInfo {
  path: string;
  branch?: string;
  detached: boolean;
}

/** One local branch in the Branches panel's GitHub-style overview. */
export interface GitBranchOverviewItem {
  name: string;
  current: boolean;
  /** The branch the panel diffs everything against (develop/master/main). */
  isBase: boolean;
  lastCommitAt?: number;
  lastCommitSubject?: string;
  /** Commits on this branch that the base branch does not have. */
  ahead?: number;
  /** Commits on the base branch that this branch does not have. */
  behind?: number;
  /** Ancestor of the base branch — safe to delete without losing work. */
  merged: boolean;
  upstream?: string;
  upstreamAhead?: number;
  upstreamBehind?: number;
  /** Set when the branch is checked out in a worktree. */
  worktreePath?: string;
  /** GitHub PR attached to this branch, when gh is available. */
  pr?: GitPrInfo;
}

/** A GitHub PR whose head is a local branch. */
export interface GitPrInfo {
  number: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  url: string;
  title?: string;
}

/** One pull request of the session's GitHub repo, as `gh pr list` reports it (PR view of the Git panel). */
export interface GitPullRequest {
  number: number;
  title: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft?: boolean;
  headRefName?: string;
  baseRefName?: string;
  url: string;
  author?: string;
  /** ms since epoch */
  createdAt?: number;
  updatedAt?: number;
  mergedAt?: number;
  /** GitHub's review decision: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or empty. */
  reviewDecision?: string;
  additions?: number;
  deletions?: number;
}

/** The PR list pulled from GitHub; `error` carries gh's own words when the pull failed (not logged in, no remote…). */
export interface GitPullRequestList {
  prs: GitPullRequest[];
  /** When the list was pulled (ms since epoch). */
  fetchedAt: number;
  ghMissing?: boolean;
  error?: string;
}

/** One issue of the session's GitHub repo, as `gh issue list` reports it (Issues view of the Git panel). */
export interface GitIssue {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED';
  url: string;
  author?: string;
  labels?: { name: string; color?: string }[];
  comments?: number;
  /** ms since epoch */
  createdAt?: number;
  updatedAt?: number;
  closedAt?: number;
}

/** The issue list pulled from GitHub; `error` carries gh's own words when the pull failed (not logged in, no remote…). */
export interface GitIssueList {
  issues: GitIssue[];
  /** When the list was pulled (ms since epoch). */
  fetchedAt: number;
  ghMissing?: boolean;
  error?: string;
}

export interface GitBranchOverview {
  isRepo: boolean;
  base?: string;
  branches: GitBranchOverviewItem[];
  worktrees: GitWorktreeInfo[];
  /** True when the GitHub CLI is unavailable; PR actions are hidden in the Branches panel. */
  ghMissing?: boolean;
  /** Set when the branch list could not be read in full (e.g. git timed out). */
  error?: string;
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
}

export interface DoctorReport {
  node: string;
  electron: string;
  platform: string;
  harnesses: Record<HarnessId, HarnessAvailability>;
  providers: { id: string; name: string; hasKey: boolean; envKeyPresent: boolean }[];
  userData: string;
}

/** Filters narrowing a session search to a subset of sessions. */
export interface SearchFilters {
  archived?: boolean;
  harness?: HarnessId;
  projectRoot?: string;
}

/** One deep-search hit: a title/goal match or a match inside a transcript item. */
export interface SearchResult {
  sessionId: string;
  /** Transcript item id for deep hits; absent for title/goal matches (nothing to scroll to). */
  itemId?: string;
  kind: 'meta' | 'user' | 'assistant' | 'tool' | 'info';
  ts: number;
  /** Snippet with \u0001/\u0002 around the matched terms; the renderer turns them into <mark>. */
  snippet: string;
}

export interface SearchResponse {
  /** False when node:sqlite/FTS5 is unavailable in this runtime; deep search is disabled then. */
  available: boolean;
  results: SearchResult[];
}

export interface CreateSessionRequest {
  config: SessionConfig;
  title?: string;
  initialPrompt?: string;
  /** Screenshots attached in the new-session dialog, sent together with the initial prompt. */
  initialImages?: ImageAttachment[];
  goal?: string;
  /** Start the session in a worktree on this existing branch (reusing one when it exists). */
  checkoutBranch?: string;
}

