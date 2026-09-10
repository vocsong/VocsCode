/**
 * Shared domain types used by the main process, preload, and renderer.
 * Keep this file free of Node/Electron/DOM imports.
 */

export type HarnessId = 'claude' | 'codex' | 'codex-exec' | 'pi' | 'acp' | 'native';

/** App-level permission modes, mapped per harness (see harness-meta.ts). */
export type PermissionMode = 'ask' | 'accept-edits' | 'plan' | 'auto' | 'full-auto';

export type EffortLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type SessionStatus = 'idle' | 'starting' | 'running' | 'awaiting' | 'error' | 'stopped';

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
  | 'deepseek'
  | 'openrouter'
  | 'ollama'
  | 'lmstudio'
  | 'groq'
  | 'xai'
  | 'mistral'
  | 'gemini-openai';

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

export interface HarnessRef {
  /** Claude Agent SDK session id (resume). */
  claudeSessionId?: string;
  /** Codex thread id (thread/resume). */
  codexThreadId?: string;
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
  harnessRef: HarnessRef;
  usage: UsageTotals;
  lastError?: string;
  /** Current model as reported by the harness (may differ from config after live switch). */
  activeModel?: ModelRef;
  activeEffort?: EffortLevel;
  goal?: GoalState;
  pinned?: boolean;
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
  | { id: string; kind: 'info'; ts: number; level: 'info' | 'warn' | 'error'; text: string }
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
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'shell.output'; runId: string; chunk: string; done?: boolean; exitCode?: number | null };

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

export interface AppSettings {
  version: 1;
  theme: 'system' | 'light' | 'dark';
  defaultHarness: HarnessId;
  defaultPermissionMode: PermissionMode;
  defaultEffort?: EffortLevel;
  defaultModelByHarness: Partial<Record<HarnessId, ModelRef>>;
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
  goalDefaults: { autoContinue: boolean; maxIterations: number };
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

export interface CreateSessionRequest {
  config: SessionConfig;
  title?: string;
  initialPrompt?: string;
  goal?: string;
}

export interface ShellRunRequest {
  sessionId: string;
  command: string;
}

