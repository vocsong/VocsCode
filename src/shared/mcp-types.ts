/**
 * Shared MCP server and project MCP state types.
 * Keep this file free of Node/Electron/DOM imports.
 */
import type { HarnessId, McpSupport } from './harness-types';

/** Transport an MCP server speaks. */
export type McpTransport = 'stdio' | 'http' | 'sse';

/**
 * One MCP server, in the single shape both scopes use (see docs/MCP.md §4). Values in `env` and
 * `headers` may carry `${VAR}` references; they are resolved at injection time from the process
 * environment or the encrypted secret store under `mcp:<VAR>`, never stored resolved.
 */
export interface McpServerDef {
  /** Stable key, and the name the harness sees (`mcp__<id>__<tool>`). */
  id: string;
  transport: McpTransport;
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http / sse */
  url?: string;
  headers?: Record<string, string>;
  /** Restrict to some harnesses; absent means every harness that can take it. */
  harnesses?: HarnessId[];
  /** Per-call timeout hint, passed through where the harness supports it. */
  timeoutMs?: number;
  description?: string;
  /** A master switch independent of the per-repo ones. Built-ins use it for opt-in (Cua). */
  disabled?: boolean;
  /**
   * Provenance: which of the app's own servers this definition is. Set only where the app builds
   * its built-in definitions; every reader of a user or repository definition constructs a fresh
   * object and never copies it, so no id, label or tool annotation can supply it. Trust that only a
   * built-in may have (the memory server's read-only tools) keys on this, never on `id`.
   */
  builtin?: string;
}

/** Per-user switches for one project root. Repo-defined servers stay off until enabled here. */
export interface McpProjectState {
  /** Global server ids switched off for this repo. */
  disabledGlobal?: string[];
  /** Repo-file server ids the user has trusted here. */
  enabledRepo?: string[];
  /** Built-in server ids switched off for this repo. */
  disabledBuiltin?: string[];
  /**
   * Built-in GitNexus only: share this repo's knowledge graph with sessions in other repos.
   * Off (the default) keeps a session strictly scoped to its own repo's index.
   */
  gitnexusGlobal?: boolean;
}

export type McpScope = 'global' | 'repo' | 'builtin';

/** Why a defined server is not part of a session's effective set. */
/** `reserved`: the name folds onto a built-in's. `duplicate`: it folds onto another server's in the same scope. */
export type McpSkipReason = 'disabled' | 'not-enabled' | 'shadowed' | 'harness-filtered' | 'not-injected' | 'reserved' | 'duplicate';

/** One row of the effective set for a session. */
export interface McpEffectiveEntry {
  def: McpServerDef;
  scope: McpScope;
  enabled: boolean;
  reason?: McpSkipReason;
}

/** A harness-native MCP store on disk, read for the MCP page's tabs and the panel's Detected list. */
export interface McpStoreInfo {
  id: string;
  label: string;
  path: string;
  /** `path` with the home directory shortened to `~`, for display. */
  display: string;
  exists: boolean;
  servers: McpServerDef[];
  error?: string;
}

/** State of one built-in server (GitNexus) for a repo. */
export interface McpBuiltinInfo {
  def: McpServerDef;
  /** Whether it will be handed to this session's harness. */
  enabled: boolean;
  /** Whether the app-wide switch on the MCP page keeps it off; the repo toggle cannot override that. */
  disabledGlobally?: boolean;
  /** Whether this repo's index is shared with sessions in other repos. */
  shared: boolean;
  /** GitNexus: this repo has an index it can see. Project knowledge: this repo has a wiki. */
  indexed: boolean;
  /**
   * Whether this app also switches the name off in the harness's own MCP config, so only the one
   * shared server can run. False for a harness whose config this app does not write.
   */
  claimed: boolean;
  /** One line the row shows under the toggle; built-in specific. */
  note?: string;
}

/** Everything the right-panel MCP tab needs for one session. */
export interface McpProjectInfo {
  projectRoot: string;
  /** Absolute path of the repo file, whether or not it exists yet. */
  file: string;
  display: string;
  exists: boolean;
  repo: McpServerDef[];
  /** Set when the repo file could not be parsed; `repo` is then empty. */
  error?: string;
  global: McpServerDef[];
  state: McpProjectState;
  /** Always-present servers the app ships with, headed by GitNexus. */
  builtin: McpBuiltinInfo[];
  detected: McpStoreInfo[];
  effective: McpEffectiveEntry[];
  /** User and repository servers that are never loaded because of their name, with the reason to show. */
  rejected: McpRejectedServer[];
  harness: HarnessId;
  support: McpSupport;
}

/** A defined server refused for its name: it folds onto a built-in's, or onto another server's. */
export interface McpRejectedServer {
  id: string;
  scope: 'global' | 'repo';
  reason: string;
}

/** Result of probing one server with the app's own MCP client ("Test connection"). */
export interface McpInspectResult {
  ok: boolean;
  error?: string;
  serverInfo?: { name: string; version?: string };
  tools: { name: string; description?: string }[];
  durationMs: number;
}
