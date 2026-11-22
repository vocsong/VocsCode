/**
 * Shared harness, model, provider, and capability domain types.
 * Keep this file free of Node/Electron/DOM imports and other shared domain modules.
 */

export type HarnessId = 'claude' | 'codex' | 'codex-exec' | 'cursor' | 'pi' | 'acp' | 'antigravity' | 'native';

/** App-level permission modes, mapped per harness (see harness-meta.ts). */
export type PermissionMode = 'ask' | 'accept-edits' | 'plan' | 'auto' | 'full-auto';

export type EffortLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Provider-observed speed, distinct from the user's requested preference. */
export interface FastModeStatus {
  state: 'off' | 'requested' | 'on' | 'unavailable' | 'cooldown';
  detail?: string;
}

export type AutoCompactionThreshold = '50%' | '75%' | '90%' | '100k' | '250k' | '500k' | '750k' | '1m';

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
  | 'opencode-go'
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

/** How a harness takes MCP servers: nothing, injected by us, run by us, or its own store. */
export type McpSupport = 'none' | 'inject' | 'client' | 'inherit';

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

/** Where a harness CLI was resolved from: an explicit path, PATH, the app's runtime dir, or bundled. */
export type HarnessBinarySource = 'settings' | 'system' | 'app-runtime' | 'bundled';

export interface HarnessAvailability {
  available: boolean;
  version?: string;
  binaryPath?: string;
  detail?: string;
  /** Whether the runtime reports a sign-in / has credentials; not a paid model-access check. */
  authenticated?: boolean | 'unknown';
  /** Reported login method or configured app API credentials; not proof of billing or key validity. */
  authMethod?: 'subscription' | 'api-key' | 'other';
  installHint?: string;
  /** Set when a binary resolved; `bundled` and `settings` are the sources an app install cannot replace. */
  source?: HarnessBinarySource;
}

/** One harness CLI's installed-vs-published state, from an on-demand npm registry check. */
export interface HarnessUpdate {
  /** npm package the check compared against. */
  package: string;
  /** Version the resolved binary reports; absent when it reported nothing readable. */
  current?: string;
  /** Newest version the package publishes; absent when the check failed. */
  latest?: string;
  /** True when `latest` is strictly newer than `current`. */
  newer: boolean;
  /**
   * True when installing `latest` into the app runtime dir changes what the harness runs. False for
   * a runtime Vocs Code bundles and for a path the user pinned: both win over the runtime dir, so
   * the card explains instead of offering a button that would do nothing.
   */
  updatable: boolean;
  /** Why the update is not offered here, when `newer` and not `updatable`. */
  reason?: string;
  /** Why the check could not run (offline, registry error). */
  error?: string;
}

export interface HarnessCapabilities {
  streaming: boolean;
  approvals: boolean;
  steer: boolean;
  queue: boolean;
  interrupt: boolean;
  liveModelSwitch: boolean;
  effort: boolean;
  /** The levels to offer while a model's own `supportedEfforts` is unknown; every level when unset. */
  effortLevels?: readonly EffortLevel[];
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
  /**
   * How MCP servers reach this harness. `inject`: we pass the effective set through its SDK or
   * protocol. `client`: we run the MCP client ourselves and merge the tools in. `inherit`: the
   * harness reads its own store and we only import/export. `none`: no way in.
   */
  mcp: McpSupport;
  /**
   * Whether we can add to the harness's own system prompt for the whole session
   * (`SessionConfig.appendSystemPrompt`). A harness without it is not unprimable: session context
   * that is not the user's words is prefixed to the first message instead.
   */
  systemPrompt: boolean;
  /** Which app-level permission modes are meaningful. */
  permissionModes: PermissionMode[];
  /**
   * Where this harness can only approximate a tier, what differs from the tier's Vocs Code meaning.
   * Shown beside the tier wherever it is picked.
   */
  permissionModeNotes?: Partial<Record<PermissionMode, string>>;
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
