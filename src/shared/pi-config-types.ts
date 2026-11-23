/**
 * Shared base-pi configuration and app-instruction types.
 * Keep this file free of Node/Electron/DOM imports.
 */

/** Base-pi resources the Settings → Pi page can list and toggle (see main/pi-config.ts). */
export type PiResourceType = 'extensions' | 'skills' | 'prompts' | 'themes';

/** One resource pi would load from its global agent dir. */
export interface PiResourceItem {
  type: PiResourceType;
  /** Frontmatter name, or the filename / folder name when there is none. */
  name: string;
  /** Skill or prompt description from frontmatter, when present. */
  description?: string;
  /** Absolute path of the file pi loads (a skill's SKILL.md, an extension's index.ts, …). */
  path: string;
  /** False when a `-`/`!` pattern in settings.json currently excludes it. */
  enabled: boolean;
  /** True when a `+`/`-` pattern in settings.json pins this path either way. */
  forced: boolean;
}

/** Curated slice of pi's global settings.json that affects sessions Vocs Code starts. */
export interface PiPreferences {
  defaultThinkingLevel?: string;
  transport?: string;
  showCacheMissNotices?: boolean;
  /** Global-only in pi: what an untrusted project's .pi resources do in non-interactive runs. */
  defaultProjectTrust?: string;
  httpProxy?: string;
  enableSkillCommands?: boolean;
  compactionEnabled?: boolean;
  compactionReserveTokens?: number;
  compactionKeepRecentTokens?: number;
  retryEnabled?: boolean;
  retryMaxRetries?: number;
  retryBaseDelayMs?: number;
}

/** A preference patch; `null` deletes the key so pi's own default applies again. */
export type PiPreferencesPatch = { [K in keyof PiPreferences]?: PiPreferences[K] | null };

/** Global pi prompt files, editable from Settings. */
export type PiPromptName = 'SYSTEM.md' | 'APPEND_SYSTEM.md' | 'AGENTS.md';

export interface PiPromptFile {
  name: PiPromptName;
  path: string;
  exists: boolean;
  /** File contents; empty when absent. Capped at 512 KB by the backend. */
  content: string;
  /** True when the file exceeds the cap, so the UI must not offer to save the truncated read. */
  truncated?: boolean;
}

/**
 * The app's own instruction layer, one file per scope. `global` applies to every harness; the
 * rest add to it for the sessions of that harness family. Not to be confused with the harness's
 * own global files (`APPEND_SYSTEM.md`, `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`), which the
 * app never edits and which keep applying through their own engine.
 */
export type AppInstructionScope = 'global' | 'pi' | 'claude' | 'codex' | 'cursor' | 'acp' | 'native';

export interface AppInstructionFile {
  scope: AppInstructionScope;
  path: string;
  exists: boolean;
  /** File contents; empty when absent. Capped at `APP_INSTRUCTION_MAX_CHARS`. */
  content: string;
  /** True when the file exceeds the cap, so the UI must not offer to save the truncated read. */
  truncated?: boolean;
}

/** How a package source is materialized on disk. */
export type PiPackageKind = 'npm' | 'git' | 'local';

/** One package declared in global settings.json.packages. */
export interface PiPackageItem {
  /** The exact source string from settings.json, used for remove/update/toggles. */
  source: string;
  /** package.json `name`, when the package is fetched. */
  name?: string;
  kind: PiPackageKind;
  /** Materialized directory; may not exist when the package has not been fetched. */
  path: string;
  installed: boolean;
  /** False when the package entry is an object with `autoload: false` (only explicit filters load). */
  autoload: boolean;
  /** Resources the package provides, with their user-filter state. */
  resources: PiResourceItem[];
  /** Set when package.json could not be read (missing dir, malformed manifest). */
  error?: string;
}

/** One on-disk pi-subagents custom agent. */
export interface PiAgentInfo {
  name: string;
  description?: string;
  model?: string;
  path: string;
}

/** Curated pi-subagents operational settings (global subagents.json). */
export interface PiSubagentsSettings {
  reportUsage?: boolean;
  showCost?: boolean;
  showModel?: boolean;
  maxSubagentDepth?: number;
  maxConcurrent?: number;
  maxConcurrentForeground?: number;
  defaultMaxTurns?: number;
  backgroundByDefault?: boolean;
  worktreeIsolation?: boolean;
  rememberAgents?: boolean;
  strictAgentFiles?: boolean;
  disableDefaultAgents?: boolean;
  fallbackSubagent?: string;
}

/** `null` deletes the key so pi-subagents' own default applies again. */
export type PiSubagentsPatch = { [K in keyof PiSubagentsSettings]?: PiSubagentsSettings[K] | null };

/** Result of one `pi install/remove/update` run. */
export interface PiCommandResult {
  ok: boolean;
  code: number | null;
  /** Combined stdout/stderr, capped by the backend. */
  log: string;
  error?: string;
}

/** Everything the Settings → Pi page needs in one read. */
export interface PiSetup {
  /** pi's global agent dir (honors PI_CODING_AGENT_DIR). */
  agentDir: string;
  settingsPath: string;
  /** Set when settings.json exists but is not usable JSON; the page must not write until fixed. */
  settingsError?: string;
  preferences: PiPreferences;
  resources: PiResourceItem[];
  promptFiles: PiPromptFile[];
  /** True when the pi binary resolves, so install/remove/update can run. */
  piAvailable: boolean;
  packages: PiPackageItem[];
  agents: PiAgentInfo[];
  subagents: PiSubagentsSettings;
  /** Set when subagents.json exists but is not usable JSON. */
  subagentsError?: string;
}
