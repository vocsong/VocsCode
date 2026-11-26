/**
 * Shared application settings and per-folder UI defaults.
 * Keep this file free of Node/Electron/DOM imports.
 */
import type { CuaSettings } from './cua-types';
import type { DictationSettings } from './dictation';
import type {
  AcpAgentPreset,
  AutoCompactionThreshold,
  EffortLevel,
  HarnessId,
  ModelOverride,
  ModelRef,
  PermissionMode,
  ProviderConfig
} from './harness-types';
import type { IntelligenceSettings } from './intelligence';
import type { KnowledgeSettings } from './knowledge';
import type { McpProjectState, McpServerDef } from './mcp-types';
import type { MissionDefaults } from './mission-mode';
import type { RemoteConfig } from './remote-types';
import type { ShortcutCommand } from './shortcuts';
import type { TerminalSettings } from './terminal';
import type { PaletteId, ThemeMode } from './themes';
import type { TypographySettings } from './typography';
import type { UiModeId } from './ui-modes';

/** Sidebar appearance override for one project folder. */
export interface FolderStyle {
  /** Hex color (e.g. `#5b9bf8`) tinting the folder icon and title. */
  color?: string;
  /** Icon name from the renderer's icon set (e.g. `folder`, `bolt`). */
  icon?: string;
}

/**
 * The New Session dialog's remembered choices for one project folder, keyed by project root.
 *
 * Worktree isolation is decided per project and is the reason this record exists: a folder that
 * isolates its sessions and a folder that must not are both normal, and one app-wide answer made
 * each new folder inherit the other one's choice. Harness, model, permission mode and the ACP
 * agent are remembered here as well, with the app-wide defaults (Settings) filling any field the
 * folder has no record of — those defaults also read as "what I usually use", while an unasked-for
 * worktree is visible only after the fact (a branch and a checkout appear), so the two are not the
 * same kind of preference.
 */
export interface FolderSessionDefaults {
  harness?: HarnessId;
  /** Model per harness, same shape as `AppSettings.defaultModelByHarness`. */
  modelByHarness?: Partial<Record<HarnessId, ModelRef>>;
  /** Absent means the harness's own default, as in the dialog's "Default" option. */
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  useWorktree?: boolean;
  /** Branch prefix for the folder's worktrees, without the trailing slash. */
  branchPrefix?: string;
  /** ACP agent id, for harness `acp`. */
  acpAgent?: string;
}

/** Sidebar session list layout: `folders` groups rows under project folders; `recent` is one flat list, most recent first. */
export type SidebarView = 'folders' | 'recent';

export interface AppSettings {
  version: 1;
  /**
   * Light/dark mode: System, Light or Dark (shared/themes.ts). Kept under the `theme` key so
   * settings.json stays readable by older builds; a legacy palette id here is migrated on load.
   */
  theme: ThemeMode;
  /** Color palette, applied in the mode above. Absent means Default. */
  palette?: PaletteId;
  /** Text & fonts: interface size, font roles, text sizes, line spacing, transcript width (shared/typography.ts). */
  typography?: TypographySettings;
  /** Interface layout, independent of the color theme (shared/ui-modes.ts). Absent means Standard. */
  uiMode?: UiModeId;
  defaultHarness: HarnessId;
  defaultPermissionMode: PermissionMode;
  /** The relay connection for MCP control and the analytics dashboard: outbound, off by default. */
  remote: RemoteConfig;
  defaultEffort?: EffortLevel;
  /** Ask supported harnesses to compact at an idle boundary after context reaches this usage. */
  autoCompactionThreshold?: AutoCompactionThreshold;
  /** Days of recent-use protection for /housekeep; 0 disables only the age guard. */
  housekeepRecentDays?: number;
  defaultModelByHarness: Partial<Record<HarnessId, ModelRef>>;
  /**
   * New-session choices remembered per project folder; a folder with no record starts on the
   * app-wide defaults above. See FolderSessionDefaults for why worktree isolation lives only here.
   */
  folderSessionDefaults?: Record<string, FolderSessionDefaults>;
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
    agy?: string;
    editor?: string;
    /** Explicit `cua-driver` path (empty = auto-detect on PATH or in Cua's install dirs). */
    cua?: string;
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
  /** Global MCP servers, offered to every harness that can take them. */
  mcpServers: McpServerDef[];
  /** Computer use through Cua Driver; off unless the user turns it on. */
  cua: CuaSettings;
  /** Built-in server ids switched off everywhere, from the MCP page. */
  mcpDisabledBuiltins?: string[];
  /** Per-user MCP switches keyed by project root; see McpProjectState. */
  mcpProjectState?: Record<string, McpProjectState>;
  providers: ProviderConfig[];
  /** Capability corrections keyed by `provider/model`; see shared/model-overrides.ts. */
  modelOverrides: Record<string, ModelOverride>;
  windowBounds?: { x?: number; y?: number; width: number; height: number };
  sidebarWidth: number;
  panelWidth: number;
  /** Share of the panel's height owned by its upper half (0.2–0.8); the lower half takes the rest. */
  panelSplit: number;
  recentProjects: string[];
  /** Project folders that stay in the sidebar even when they have no sessions left. */
  folders: string[];
  /** Per-folder sidebar appearance keyed by project root. */
  folderStyles?: Record<string, FolderStyle>;
  /** User-added labels offered in the status-label picker alongside the built-in statuses. */
  customLabels?: string[];
  /** User-added worktree branch prefixes (no trailing slash), offered in every folder after the built-in ones. */
  customBranchPrefixes?: string[];
  /** Manual sidebar order for project folders; roots not listed sort alphabetically after. */
  folderOrder?: string[];
  /** Project roots whose sidebar folder block is collapsed. */
  collapsedFolders?: string[];
  /** How the sidebar lists sessions: grouped under their folders, or one list across folders by recency. */
  sidebarView?: SidebarView;
  /** Extra keyboard shortcuts keyed by canonical accelerator (e.g. 'Ctrl+Alt+A'); see shared/shortcuts.ts. */
  customShortcuts?: Record<string, ShortcutCommand>;
  /**
   * App goal engine defaults. `preferHarness` hands `/goal` to a harness that has a goal command of
   * its own (see shared/goal-driver.ts); with it off the app's engine answers everywhere.
   */
  goalDefaults: { autoContinue: boolean; maxIterations: number; preferHarness: boolean };
  /** Mission mode: what Builders run on (Settings → Sessions). Absent on older settings means the defaults. */
  missionDefaults?: MissionDefaults;
  terminal: TerminalSettings;
  /** Cheap model for background tasks (session titles, summaries). Unset until the user picks one. */
  utilityModel?: ModelRef;
  /** pi model for Vesta, the in-app assistant (provider/model from pi's catalog); unset uses
   *  pi's own default model. */
  agentModel?: ModelRef;
  /** Vesta's floating panel: where it sits and whether it is collapsed to its avatar. */
  agent?: { enabled?: boolean; x?: number; y?: number; collapsed?: boolean };
  /** Set once the first-run setup guide has been completed. */
  onboardingDone?: boolean;
  /** Project roots where the user dismissed the "publish to GitHub" guide on the Git tab. */
  gitSetupSkipped?: string[];
  /** Layer 2 project knowledge: always-on digest priming and automatic distillation after git events. */
  knowledge?: KnowledgeSettings;
  /** Memory lifecycle, the tool gateway, project collections and the optional graph provider. */
  intelligence?: IntelligenceSettings;
  /** Voice to text in the composer: cloud transcription or whisper.cpp on this machine. */
  dictation?: DictationSettings;
}
