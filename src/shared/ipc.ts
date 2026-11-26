import type { VocsAccountSignInRequest, VocsAccountState, VocsHubConnectionRequest } from './vocs-account';
/** The IPC contract shared by main, preload and renderer. Single source of truth for channels, payloads and the exposed API shape. */
import type { ControlGrantInput, ControlOwnerState } from './control';
import type { LocalControlOwnerState } from './local-control';
import type { HousekeepInventory, HousekeepOutcome, HousekeepPreview } from './housekeep';
import type { HarnessSetupStatus, LoginHarnessId } from './harness-setup';
import type { InlineSubscriptionProvider, ObservedSubscriptionWindow, OpenSubscriptionUsageResult, SubscriptionLimits, SubscriptionProvider } from './subscription-usage';
import type {
  AnalyticsSummary,
  AppInstructionFile,
  AppInstructionScope,
  ApprovalDecision,
  AppSettings,
  CreateSessionRequest,
  CuaInstallResult,
  CuaPreviewResult,
  CuaStatus,
  DesktopFocus,
  DoctorReport,
  EffortLevel,
  FsEntry,
  GitBranchInfo,
  GitBranchOverview,
  GitCommentList,
  GitIssueList,
  GitPullRequestDetail,
  GitPullRequestList,
  GitSetupStatus,
  GitSummary,
  GitWorktreeInfo,
  HarnessAvailability,
  HarnessId,
  HarnessUpdate,
  ImageAttachment,
  McpInspectResult,
  McpProjectInfo,
  McpProjectState,
  McpServerDef,
  McpStoreInfo,
  ModelInfo,
  ModelOverride,
  ModelRef,
  PermissionMode,
  PiCommandResult,
  PiPreferencesPatch,
  PiPromptName,
  PiResourceType,
  PiSetup,
  PiSubagentsPatch,
  ProviderConfig,
  RemoteConfig,
  RemoteDeviceInfo,
  RemoteState,
  SearchFilters,
  SecretStatus,
  SearchResponse,
  SearchResult,
  SessionEventEnvelope,
  SessionMeta,
  SkillHarness,
  SkillRootInfo,
  TranscriptItem,
  UpdateState,
  UserInput
} from './types';
import type { AgentClientContext, AgentState } from './agent';
import type { ChatImportPreview, ChatImportSource } from './chat-import';
import type { ExecutionRecord } from './analytics/records';
import type { KnowledgeGraph, KnowledgePageDetail, KnowledgeSearchResult, KnowledgeView } from './knowledge';
import type { CollectionMember, ContextPacket, IntelligenceSearchResponse, IntelligenceView, MemoryExportBundle, MemoryState, MemoryType } from './intelligence';
import type { KnowledgeUsageDays, KnowledgeUsageReport, KnowledgeUsageVote } from './knowledge-usage';
import type { AgentTypeInfo, SubagentRun, SubagentRunSummary } from './subagents';
import type { AgentFileFields, ParsedAgentFile } from './agent-files';
import type { ProjectAgentInfo } from './agent-info';
import type { ClaudeAgentFileInfo } from './claude-agent-files';
import type { ShellKind, ShellOption, TerminalInfo } from './terminal';
import type { DictationLocalStatus, DictationResult, LocalModelId } from './dictation';
import type { WorkspaceImage } from './image-files';
import type { MissionView } from './mission-mode';
import type { ProcessEndResult, ProcessList, ProcessSummary, ProcessTarget } from './processes';

/** Paths are session/workspace-relative, with forward slashes. Incomplete scans cannot pick a file. */
export type WorkspaceFileResolution =
  | { status: 'resolved'; path: string }
  | { status: 'ambiguous'; paths: string[] }
  | { status: 'missing' }
  | { status: 'incomplete' };

/** Text previews and their desktop Save action share this UTF-8 byte limit. */
export const FILE_PREVIEW_MAX_BYTES = 200_000;

/** Readable text exports fail explicitly rather than silently truncating a saved artifact. */
export const TEXT_EXPORT_MAX_BYTES = 1024 * 1024;

/**
 * What the Claude subagent rows are built from: the types the engine names, the project's own
 * definitions, and the model this session's subagents fall back to.
 *
 * `types` is empty for a session that is not running — only a live engine can name its agent types —
 * while `files` is readable at any time. `forced` says whether the session's model is being applied
 * to every delegated agent, which is what a project pin turns off.
 */
export interface ClaudeAgentTypesInfo {
  types: AgentTypeInfo[];
  files: ClaudeAgentFileInfo[];
  /** The model a subagent runs on when nothing overrides it; null when the session has none yet. */
  sessionModel: string | null;
  forced: boolean;
}

/**
 * Request/response contract for ipcRenderer.invoke channels.
 * Each key is a channel; value is [request, response].
 */
export interface IpcContract {
  'app:info': [void, { version: string; platform: string; userData: string; isPackaged: boolean }];
  'app:doctor': [void, DoctorReport];
  'app:openExternal': [{ url: string }, void];
  'app:openPath': [{ path: string; sessionId: string }, void];
  /** Desktop only: shows a local file in the system file manager, even outside the session; never opens it. */
  'app:showInFolder': [{ path: string; sessionId: string }, { ok: boolean; error?: string }];
  'app:openInEditor': [{ path: string; sessionId: string; line?: number }, { ok: boolean; error?: string }];
  'app:openTerminal': [{ cwd: string }, { ok: boolean; error?: string }];
  'app:pickFolder': [{ defaultPath?: string }, { path: string | null }];
  /** Desktop user chooser only: no caller-selected path, model tool, or remote writer. */
  'app:fileSaveAs': [{ content: string; suggestedName: string }, { path: string | null }];
  'app:notify': [{ title: string; body: string }, void];
  /** In-app auto-update (issue #198). Present only in packaged builds; other builds stay idle. */
  'update:state': [void, UpdateState];
  'update:check': [void, UpdateState];
  'update:download': [void, UpdateState];
  /** Restarts the app to install a downloaded update; runs the session drain first. */
  'update:install': [void, void];
  /** A renderer stall (long task, delayed input, timer drift) recorded in the main log. */
  'app:diag': [{ kind: 'longtask' | 'input-delay' | 'loop-lag'; ms: number; detail?: string }, void];
  /** A renderer exception (React render error or an uncaught error/rejection), recorded in the main log. */
  'app:rendererError': [{ message: string; stack?: string; source?: string }, void];
  /** Opens a validated SKILL.md in the configured editor. */
  'skills:openInEditor': [{ path: string; line?: number }, { ok: boolean; error?: string }];

  'window:toggleFullScreen': [void, void];
  'window:reload': [void, void];
  'window:toggleDevTools': [void, void];
  'window:zoom': [{ direction: 'in' | 'out' | 'reset' }, { zoomFactor: number }];
  'window:edit': [{ command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' }, void];

  /** The renderer reports the session it is showing; local only, never on the remote surface. */
  'desktop:setFocus': [{ sessionId: string | null }, void];
  /** The sessions in the panes on screen; local-only, so main can tell whether a finished turn was seen. */
  'desktop:setVisible': [{ sessionIds: string[] }, void];
  /** The session the desktop is on, and whether its window is foregrounded. */
  'desktop:focus': [void, DesktopFocus];

  /** Local desktop owner only; no tokens, URLs or client configuration accepted. */
  'vocsAccount:get': [void, VocsAccountState];
  'vocsAccount:signIn': [VocsAccountSignInRequest | void, VocsAccountState];
  'vocsAccount:cancel': [void, VocsAccountState];
  'vocsAccount:signOut': [void, VocsAccountState];
  'vocsAccount:refresh': [void, VocsAccountState];
  /** Hub connections: the connection id only; main takes resource, issuer and scopes from its own
   *  verified catalog. Connect resolves when the browser flow ends. */
  'vocsAccount:hubConnect': [VocsHubConnectionRequest, VocsAccountState];
  'vocsAccount:hubCancel': [VocsHubConnectionRequest, VocsAccountState];
  'vocsAccount:hubDisconnect': [VocsHubConnectionRequest, VocsAccountState];

  'settings:get': [void, AppSettings];
  'settings:update': [Partial<AppSettings>, AppSettings];

  /**
   * Removes a project folder from the app: every session under that root, and every setting keyed
   * by it. The folder on disk is never touched.
   */
  'folders:remove': [{ root: string }, { removedSessions: number }];

  'secrets:set': [{ providerId: string; apiKey: string }, void];
  'secrets:clear': [{ providerId: string }, void];
  'secrets:has': [{ providerId: string }, boolean];
  'secrets:status': [void, SecretStatus];

  'providers:list': [void, ProviderConfig[]];
  'providers:save': [ProviderConfig, ProviderConfig[]];
  'providers:delete': [{ id: string }, ProviderConfig[]];
  'providers:refreshModels': [{ id: string }, { models: ModelInfo[]; error?: string }];
  'providers:test': [{ id: string }, { ok: boolean; detail: string }];

  /** Corrects one model's advertised capabilities; `null` clears that field's override. */
  'models:setOverride': [{ provider: string; model: string; supportsImages: boolean | null }, Record<string, ModelOverride>];

  /**
   * Dictation, desktop only: `audio` is a base64 16 kHz mono WAV clip, transcribed by the engine in
   * settings. Keys stay in main; the renderer never sees one.
   */
  'dictation:transcribe': [{ audio: string }, DictationResult];
  /** Transcription models a provider offers; OpenRouter's list is fetched live. */
  'dictation:cloudModels': [{ provider: string }, { models: { id: string; label: string }[]; error?: string }];
  'dictation:status': [void, DictationLocalStatus];
  /** Downloads the whisper.cpp build and model the saved local settings need; progress is pushed. */
  'dictation:install': [void, DictationLocalStatus];
  'dictation:cancelInstall': [void, void];
  'dictation:removeModel': [{ model: LocalModelId }, DictationLocalStatus];
  /** Stops the local server now, freeing its GPU memory; the next local clip starts it again. */
  'dictation:stopLocal': [void, DictationLocalStatus];

  'harness:availability': [{ id?: HarnessId; refresh?: boolean } | void, Partial<Record<HarnessId, HarnessAvailability>>];
  /** Fresh selected-runtime and dependency checks; no model request and no credentials returned. */
  'harness:setup': [{ harness: HarnessId }, HarnessSetupStatus];
  /** Desktop-owner action only. Opens the selected runtime's vendor login in a terminal. */
  'harness:login': [{ harness: LoginHarnessId; device?: boolean }, { ok: boolean; error?: string }];
  /** Desktop-owner action only. Reads provider account windows, never credentials or raw output. */
  'subscriptions:read': [{ provider: InlineSubscriptionProvider }, SubscriptionLimits];
  /** Desktop owner only. Reads observations already received from this live Claude session. */
  'subscriptions:claudeObserved': [{ sessionId: string }, ObservedSubscriptionWindow[]];
  /** Desktop-owner action only. Opens a fixed vendor usage page or its interactive CLI. */
  'subscriptions:openUsage': [{ provider: SubscriptionProvider }, OpenSubscriptionUsageResult];
  /** Served from a 7-day disk cache of the last clean discovery; `refresh` rediscovers now. */
  'harness:models': [
    { harness: HarnessId; acpAgent?: string; projectRoot?: string; refresh?: boolean },
    { models: ModelInfo[]; error?: string }
  ];
  'harness:install': [{ id: 'pi' | 'dsh' | 'codex' | 'claude' }, { ok: boolean; log: string }];
  /** On-demand comparison of the installed harness CLIs against what each npm package publishes. */
  'harness:checkUpdates': [{ ids?: HarnessId[] } | void, Partial<Record<HarnessId, HarnessUpdate>>];

  /** Global skills (SKILL.md folders) per harness, for the Skills page. */
  'skills:list': [void, SkillRootInfo[]];
  /** Reads a skill's SKILL.md for the preview pane; `path` must be a known skill folder. */
  'skills:read': [{ path: string }, { content: string; truncated: boolean }];
  /** Opens a skill folder (or a skills root) in the system file manager. */
  'skills:reveal': [{ path: string }, void];
  'skills:create': [{ harness: SkillHarness; name: string; description: string }, { ok: boolean; path?: string; error?: string }];
  /** Copies a skill folder into another harness's skills directory. */
  'skills:copy': [{ path: string; toHarness: SkillHarness }, { ok: boolean; path?: string; error?: string }];
  'skills:delete': [{ path: string }, { ok: boolean; error?: string }];

  /** Base-pi global config for Settings → Pi: agent dir resources, prompt files, curated settings.json keys. */
  'pi:setup': [void, PiSetup];
  'pi:preferences': [PiPreferencesPatch, PiSetup];
  'pi:resource': [{ type: PiResourceType; path: string; enabled: boolean }, PiSetup];
  'pi:prompt:write': [{ name: PiPromptName; content: string }, PiSetup];
  /** Installs a package through the user's pi binary (git clone / npm install happen there). */
  'pi:package:install': [{ source: string }, PiCommandResult];
  'pi:package:remove': [{ source: string }, PiCommandResult];
  /** No source updates every installed package. */
  'pi:package:update': [{ source?: string }, PiCommandResult];
  /** Toggles one package resource with pi's own `+`/`-` package filters. */
  'pi:package:resource': [{ source: string; type: PiResourceType; path: string; enabled: boolean }, PiSetup];
  /** Curated global pi-subagents settings (subagents.json). */
  'pi:subagents': [PiSubagentsPatch, PiSetup];
  /** Opens a pi config file in the configured editor; `path` must resolve inside the agent dir. */
  'pi:openInEditor': [{ path: string; line?: number }, { ok: boolean; error?: string }];
  /** Opens the agent dir (or a file inside it) in the OS file manager. */
  'pi:reveal': [{ path?: string }, void];

  /** The app's own instruction layer (one file per scope), for Settings → Instructions. */
  'instructions:read': [void, AppInstructionFile[]];
  'instructions:write': [{ scope: AppInstructionScope; content: string }, AppInstructionFile[]];

  /** Every harness's own global MCP store, for the MCP page's read-only tabs. */
  'mcp:stores': [void, McpStoreInfo[]];
  /** The repo file, the global list, the per-repo switches and what this session will get. */
  'mcp:project': [{ sessionId: string }, McpProjectInfo];
  /** Rewrites the `mcpServers` table of the session repo's `.mcp.json`. */
  'mcp:project:save': [{ sessionId: string; servers: McpServerDef[] }, { ok: boolean; error?: string }];
  /** Patches this repo's switches (`disabledGlobal` / `enabledRepo`) and returns the fresh view. */
  'mcp:project:state': [{ sessionId: string; patch: McpProjectState }, McpProjectInfo];
  /** Runs GitNexus indexing in the current session repository. */
  'mcp:project:index': [{ sessionId: string }, { ok: boolean; output?: string; error?: string }];
  /** Connects to one server, lists its tools and disconnects ("Test connection"). */
  'mcp:inspect': [{ def: McpServerDef; sessionId?: string }, McpInspectResult];
  /** Copies servers out of a harness-native store into the global list or the repo file. */
  'mcp:import': [{ servers: McpServerDef[]; to: 'global' | 'repo'; sessionId?: string }, { ok: boolean; error?: string }];
  /** Writes the session repo's servers out to `.cursor/mcp.json` for a Cursor session. */
  'mcp:export': [{ sessionId: string; to: 'cursor' }, { ok: boolean; path?: string; error?: string }];
  /** Installed Cua Driver, its mode and whether that mode can start (computer use). */
  'cua:status': [void, CuaStatus];
  /** One screen capture from the driver, for the Desktop preview tab. */
  'cua:preview': [void, CuaPreviewResult];
  /** Connects to the built-in Cua Driver server, lists its tools and disconnects. */
  'cua:test': [void, McpInspectResult];
  /** Runs Cua Driver's official installer after an explicit confirmation. */
  'cua:install': [void, CuaInstallResult];
  /** Every process the app started, through any session, terminal or tool, as last sampled. Desktop only. */
  'processes:list': [void, ProcessList];
  /** Ends each target and its whole subtree; only processes in the tracked set can be named. Desktop only. */
  'processes:end': [{ targets: ProcessTarget[] }, ProcessEndResult];

  'sessions:list': [void, SessionMeta[]];
  /** Desktop-only explicit discovery; the renderer never supplies filesystem paths. */
  'sessions:importList': [{ source: ChatImportSource }, ChatImportPreview];
  'sessions:import': [{ source: ChatImportSource; ids: string[]; repairOnly?: boolean }, { imported: SessionMeta[]; skipped: number }];
  'sessions:create': [CreateSessionRequest, SessionMeta];
  'sessions:get': [{ id: string }, SessionMeta | null];
  /** Mission mode, desktop owner only. Start: an empty session becomes the Lead; a session with
   *  history hands its conversation to a new Lead. Returns the Lead the renderer should open. */
  'mission:start': [{ sessionId: string; input: UserInput }, { leadId: string }];
  /** The mission a Lead or Builder session belongs to, or null. */
  'mission:get': [{ sessionId: string }, MissionView | null];
  'mission:stop': [{ leadId: string }, MissionView];
  /** Interrupted missions only: tells the Lead where each Builder stopped. Never automatic. */
  'mission:resume': [{ leadId: string }, MissionView];
  'sessions:transcript': [{ id: string }, TranscriptItem[]];
  /** Tail-first window of a transcript for remote clients: items [start, end), newest by default.
   *  `seq` is the event floor the window reflects; absent on desktops that predate sequencing. */
  'sessions:transcriptPage': [{ id: string; start?: number; end?: number; limit?: number }, { items: TranscriptItem[]; start: number; total: number; seq?: number }];
  /** Subagent runs recorded for a pi session, newest first. */
  'subagents:list': [{ id: string }, SubagentRunSummary[]];
  /** One run with its transcript items and per-call rows, or null when it is gone. */
  'subagents:get': [{ id: string; runId: string }, SubagentRun | null];
  /** Stops one running subagent without stopping the parent turn. */
  'subagents:stop': [{ id: string; runId: string }, { ok: boolean; error?: string }];
  /** Sends a mid-run instruction to one running subagent. */
  'subagents:steer': [{ id: string; runId: string; message: string }, { ok: boolean; error?: string }];
  /** The project's subagent definitions, the shipped templates, and their git state. */
  'agents:list': [{ id: string }, ProjectAgentInfo];
  /** One definition's file contents, for the editor. */
  'agents:get': [{ id: string; name: string }, ParsedAgentFile | null];
  /** Writes a definition, creating the project's ignore rule when it is the first one. */
  'agents:save': [{ id: string; fields: AgentFileFields; prompt: string }, { ok: boolean; path?: string; error?: string }];
  'agents:delete': [{ id: string; name: string }, { ok: boolean; error?: string }];
  /** Shares one definition with the repo, or keeps it local again. */
  'agents:track': [{ id: string; name: string; tracked: boolean }, { ok: boolean; error?: string }];
  /** The Claude agent types a session can delegate to, and the definitions its project supplies. */
  'claude-agents:list': [{ id: string }, ClaudeAgentTypesInfo];
  /** Pins (or with `null`, unpins) one project definition's model, rewriting only its `model:` line. */
  'claude-agents:setModel': [{ id: string; name: string; model: string | null }, { ok: boolean; error?: string }];
  /** Writes a definition; refuses a built-in name unless `override`, and a name an existing definition owns. */
  'claude-agents:create': [{ id: string; name: string; description: string; prompt: string; model?: string | null; override?: boolean }, { ok: boolean; path?: string; error?: string }];
  /** Deep search: session titles/goals plus full transcript content (FTS5 index in main). */
  'sessions:search': [{ q: string; filters?: SearchFilters; limit?: number }, SearchResponse];
  'sessions:delete': [{ id: string; removeWorktree?: boolean }, void];
  'sessions:rename': [{ id: string; title: string }, SessionMeta];
  'sessions:label': [{ id: string; label?: string }, SessionMeta];
  'sessions:archive': [{ id: string; archived: boolean; removeWorktree?: boolean; forceWorktree?: boolean }, SessionMeta];
  /** Local desktop only; review first, then apply a one-use preview. */
  'housekeep:preview': [{ protectedIds: string[]; recentDaysOverride?: number }, HousekeepPreview];
  'housekeep:assess': [{ previewId: string }, HousekeepPreview];
  'housekeep:apply': [{ previewId: string; ids: string[]; protectedIds: string[] }, HousekeepOutcome[]];
  /** Local desktop only, read-only, with no renderer-supplied scan paths. */
  'housekeep:inventory': [void, HousekeepInventory];
  'sessions:pin': [{ id: string; pinned: boolean }, SessionMeta];
  /** Persists a pinned-section drag reorder: ids in their new display order. */
  'sessions:pinOrder': [{ ids: string[] }, void];
  /** The desktop viewed this session: clears "done · not viewed". Local-only. */
  'sessions:markViewed': [{ id: string }, SessionMeta];
  'sessions:send': [{ id: string; input: UserInput }, void];
  /** Replaces a sent message, discards its later transcript items, and runs it again. */
  'sessions:editAndResend': [{ id: string; userItemId: string; input: UserInput }, TranscriptItem[]];
  'sessions:interrupt': [{ id: string }, void];
  'sessions:stop': [{ id: string }, void];
  'sessions:setModel': [{ id: string; model: ModelRef }, SessionMeta];
  'sessions:setEffort': [{ id: string; effort: EffortLevel }, SessionMeta];
  'sessions:setFastMode': [{ id: string; enabled: boolean }, SessionMeta];
  'sessions:setPermissionMode': [{ id: string; mode: PermissionMode }, SessionMeta];
  'sessions:compact': [{ id: string }, { ok: boolean; detail?: string }];
  'sessions:clearTranscript': [{ id: string }, void];
  'sessions:export': [{ id: string }, { path: string | null }];
  'sessions:fork': [{ id: string; harness?: HarnessId }, SessionMeta | null];
  'sessions:moveTo': [{ id: string; cwd: string }, SessionMeta];
  'sessions:goal': [
    { id: string; action: 'set' | 'pause' | 'resume' | 'clear' | 'complete' | 'update'; objective?: string; autoContinue?: boolean; maxIterations?: number },
    SessionMeta
  ];

  /** Vesta, the in-app assistant. Its reach is the allowlist in shared/agent-manifest.ts, not this contract. */
  'agent:state': [void, AgentState];
  /** Sends a message (with pasted images, when any); the reply streams back over `push:agentState`. */
  'agent:send': [{ text: string; context?: AgentClientContext; images?: ImageAttachment[] }, void];
  'agent:cancel': [void, void];
  /** Applies or declines a pending proposal (a batch of gated capability calls). */
  'agent:resolve': [{ proposalId: string; approve: boolean }, void];
  'agent:reset': [void, void];

  'analytics:summary': [{ days?: number } | void, AnalyticsSummary];
  /** Representative executions for a drill-down: by id, by failure signature or by session; redacted at ingest. */
  'analytics:executions': [{ ids?: string[]; signature?: string; sessionId?: string; days?: number; limit?: number }, ExecutionRecord[]];

  'approvals:respond': [{ sessionId: string; requestId: string; decision: ApprovalDecision }, void];

  /** The relay connection (docs/CONTROL-MCP.md, docs/WEB-DASHBOARD.md). The device credential lives
   *  in the secret store. `relayUrl` is the relay this desktop uses (code.vocs.io unless
   *  VOCS_CODE_RELAY_URL is set); `registered` means this computer has its own relay credential. */
  'remote:get': [void, { config: RemoteConfig; state: RemoteState; devices: RemoteDeviceInfo[]; relayUrl: string; registered: boolean; signInAvailable: boolean }];
  /** Connect with Vocs: opens the relay's page in the browser to add this computer, or reconnects
   *  a computer that is already registered. */
  'remote:signIn': [void, RemoteState];
  'remote:disable': [void, RemoteState];
  'remote:revoke': [{ deviceId: string }, void];
  /** Kill switch: revoke every other device of the account. */
  'remote:revokeAll': [void, RemoteState];
  /** Analytics sharing for the code.vocs.io dashboard: on by default; off deletes the relay copy. */
  'remote:setShareAnalytics': [{ share: boolean }, RemoteState];
  /** Local desktop owner only: never in the agent invocation origin. */
  'control:get': [void, ControlOwnerState];
  'control:enable': [{ enabled: boolean }, ControlOwnerState];
  'control:grant': [ControlGrantInput, ControlOwnerState];
  'control:revoke': [{ grantId: string }, ControlOwnerState];
  'control:local:get': [void, LocalControlOwnerState];
  'control:local:enable': [{ projectIds: string[] }, LocalControlOwnerState];
  'control:local:disable': [void, LocalControlOwnerState];

  'git:folderBranch': [{ projectRoot: string }, { branch?: string; detached?: boolean }];
  /** Pre-session probe for a folder the dialog is configuring: worktree isolation needs a git repository. */
  'git:folderIsRepo': [{ projectRoot: string }, { isRepo: boolean }];
  /** Pre-session probe: the folder's local branches, offered as the new worktree branch's starting point. */
  'git:folderBranches': [{ projectRoot: string }, { current?: string; branches: string[] }];
  /** A worktree branch name for the intent of a first prompt: the background model's, or the offline one. */
  'git:suggestBranchName': [{ prompt: string; model?: ModelRef }, { name: string; source: 'model' | 'prompt' }];
  'git:summary': [{ sessionId: string }, GitSummary];
  'git:diff': [{ sessionId: string; path?: string; staged?: boolean }, { diff: string; error?: string }];
  'git:revert': [{ sessionId: string; path: string }, { ok: boolean; error?: string }];
  'git:stageAll': [{ sessionId: string }, { ok: boolean; error?: string }];
  'git:commit': [{ sessionId: string; message: string }, { ok: boolean; output: string }];
  /** Pushes the session's branch (or `head`, without checking it out) and opens a GitHub PR into `base` (needs gh). */
  'git:pr': [{ sessionId: string; base: string; head?: string }, { ok: boolean; url?: string; output?: string }];
  /** Merges the open PR for the session's branch (or `head`); `base`, when given, must match the PR's target. */
  'git:merge': [{ sessionId: string; base?: string; head?: string }, { ok: boolean; url?: string; output?: string }];
  'git:branches': [{ sessionId: string }, { current?: string; branches: GitBranchInfo[] }];
  'git:worktrees': [{ sessionId: string }, { current: string; worktrees: GitWorktreeInfo[] }];
  'git:checkout': [{ sessionId: string; branch: string }, { ok: boolean; error?: string }];
  /** Branches-panel housekeeping: per-branch age, ahead/behind, merged state and worktree binding. */
  'git:branchesOverview': [{ sessionId: string }, GitBranchOverview];
  /** Guided git setup: whether the folder is a repository and how far the GitHub connection has come. */
  'git:setupStatus': [{ sessionId: string }, GitSetupStatus];
  'git:init': [{ sessionId: string }, { ok: boolean; error?: string }];
  /** Stages everything and commits; an empty folder gets an empty initial commit so it can be pushed. */
  'git:initialCommit': [{ sessionId: string; message: string }, { ok: boolean; output: string }];
  /** Points `origin` at a pasted repository URL, replacing an existing origin. */
  'git:setRemote': [{ sessionId: string; url: string }, { ok: boolean; error?: string }];
  /** Pushes the current branch to origin with `-u`; never prompts for credentials. */
  'git:push': [{ sessionId: string }, { ok: boolean; output: string }];
  /** Creates a GitHub repository with gh, sets origin and pushes (needs an authenticated gh). */
  'git:createGitHubRepo': [{ sessionId: string; name: string; private: boolean }, { ok: boolean; url?: string; output?: string }];
  /** Sets the git author identity so the first commit can be created; `global` writes the machine-wide config. */
  'git:setIdentity': [{ sessionId: string; name: string; email: string; global: boolean }, { ok: boolean; error?: string }];
  /** Reads the signed-in GitHub account's name and email (noreply when private) to prefill the identity. */
  'git:githubIdentity': [{ sessionId: string }, { ok: boolean; login?: string; name?: string; email?: string; error?: string }];
  'git:deleteBranch': [{ sessionId: string; branch: string; force?: boolean }, { ok: boolean; error?: string }];
  /** Fast-forwards a local branch to its upstream, whether or not it is checked out. */
  'git:updateBranch': [{ sessionId: string; branch: string }, { ok: boolean; error?: string }];
  'git:removeWorktree': [{ sessionId: string; path: string }, { ok: boolean; error?: string }];
  'git:pruneWorktrees': [{ sessionId: string }, { ok: boolean; output: string }];
  'git:fetchPrune': [{ sessionId: string }, { ok: boolean; output: string }];
  /** Pulls the repo's pull requests (all states) from GitHub through gh, for the Git panel's PR view. */
  'git:pullRequests': [{ sessionId: string }, GitPullRequestList];
  /** Loads the exact GitHub pull request and conversation named by a desktop transcript link. */
  'git:pullRequest': [{ sessionId: string; url: string }, GitPullRequestDetail];
  /** Pulls the repo's issues (all states) from GitHub through gh, for the Git panel's Issues view. */
  'git:issues': [{ sessionId: string }, GitIssueList];
  /** Pulls one issue's conversation comments through gh, for the Git panel's issue preview. */
  'git:issueComments': [{ sessionId: string; number: number }, GitCommentList];
  /** Pulls one pull request's conversation comments through gh, for the Git panel's PR preview. */
  'git:prComments': [{ sessionId: string; number: number }, GitCommentList];

  'fs:list': [{ sessionId: string; relPath?: string }, FsEntry[]];
  'fs:search': [{ sessionId: string; query: string; limit?: number }, string[]];
  /** Exact file first, then a bounded component-suffix search within the session's workspace. */
  'fs:resolve': [{ sessionId: string; path: string }, WorkspaceFileResolution];
  /** `binary` comes with empty content. `readOnly` excludes placeholders and protected files from editing. */
  'fs:read': [{ sessionId: string; path: string; maxBytes?: number }, { content: string; truncated: boolean; binary?: boolean; readOnly?: boolean }];
  /** Desktop Save: replace only existing workspace text that still matches the original read bytes.
   * Both strings are literal UTF-8 text, including any BOM and line endings. */
  'fs:writeText': [{ sessionId: string; path: string; content: string; expectedContent: string }, void];
  /** An image file as base64 for the Files panel preview; null outside the workspace or for a non-image path. */
  'fs:readImage': [{ sessionId: string; path: string }, WorkspaceImage | null];

  /** Layer 2 project knowledge for one session's project: pages, proposals and review state. */
  'knowledge:view': [{ sessionId: string }, KnowledgeView];
  /** One page with its provenance, related pages and staleness. */
  'knowledge:read': [{ sessionId: string; id: string }, KnowledgePageDetail | null];
  /** Scored search over the project's pages (accepted pages only unless asked otherwise). */
  'knowledge:search': [{ sessionId: string; q: string; limit?: number; includeHistorical?: boolean }, KnowledgeSearchResult[]];
  /** Start an empty wiki for the project, for a project whose docs are too thin to bootstrap from. */
  'knowledge:create': [{ sessionId: string }, KnowledgeView];
  /** Accept or reject one proposal; rejecting remembers the claim. */
  'knowledge:review': [{ sessionId: string; id: string; action: 'accept' | 'reject'; note?: string }, KnowledgeView];
  /** Accept every proposal and draft at once; deprecated and superseded pages are left alone. */
  'knowledge:reviewAll': [{ sessionId: string }, { accepted: number; view: KnowledgeView }];
  /** Run the docs scan (bootstrap), an episode distillation, or a PR reflection with the utility model. */
  'knowledge:generate': [{ sessionId: string; mode: 'bootstrap' | 'distill' | 'reflect' }, { ok: boolean; detail?: string; error?: string }];
  /** Copy reviewed pages into the tracked docs/wiki/ path; committing them stays the user's act. */
  'knowledge:publish': [{ sessionId: string; ids: string[] }, { ok: boolean; dir: string; written: string[]; error?: string }];
  /** The derived relation graph (labels, anchors, links) for a session's project. */
  'knowledge:graph': [{ sessionId: string }, KnowledgeGraph];
  /** Deletes one page without tombstoning it; rejecting is what stops a claim returning. */
  'knowledge:delete': [{ sessionId: string; id: string }, KnowledgeView];

  /** Memory records, collections, the graph provider and the gateway for one session's project. */
  'intelligence:view': [{ sessionId: string }, IntelligenceView];
  /** Federated, permission-scoped evidence search: the planner the agents' tools use, for the panel. */
  'intelligence:search': [{ sessionId: string; query: string; scope?: 'project' | 'collection'; limit?: number; includeHistorical?: boolean }, IntelligenceSearchResponse & { usageReceipt?: string }];
  /** A bounded, cited context packet for one question. */
  'intelligence:compile': [{ sessionId: string; query: string; budgetTokens?: number; scope?: 'project' | 'collection' }, ContextPacket & { usageReceipt?: string }];
  /** Local-only counters and opt-in for the held session's project. */
  'intelligence:usage:view': [{ sessionId: string; days: KnowledgeUsageDays }, KnowledgeUsageReport];
  'intelligence:usage:configure': [{ sessionId: string; days: KnowledgeUsageDays; enabled: boolean }, KnowledgeUsageReport];
  'intelligence:usage:clear': [{ sessionId: string; days: KnowledgeUsageDays }, KnowledgeUsageReport];
  'intelligence:usage:vote': [{ sessionId: string; receipt: string; vote: KnowledgeUsageVote }, boolean];
  /** Adds a record by hand: a lesson for the project, or a preference the user declares. */
  'intelligence:memory:add': [{ sessionId: string; type: MemoryType; title: string; text: string; scope: 'project' | 'personal' }, IntelligenceView];
  /** A person's decision about one record: verify, activate, mark uncertain, reject, expire or revoke. */
  'intelligence:memory:decide': [{ sessionId: string; id: string; to: MemoryState; note?: string }, IntelligenceView];
  /** Deletes a record, its index entry and anything promoted from it; the text is tombstoned. */
  'intelligence:memory:forget': [{ sessionId: string; id: string }, IntelligenceView];
  /** Writes a record into the project wiki as a human-reviewed page. */
  'intelligence:memory:apply': [{ sessionId: string; id: string }, { pageId: string; view: IntelligenceView }];
  /** This project's own records as a portable bundle; collection and personal memory stay behind. */
  'intelligence:memory:export': [{ sessionId: string }, MemoryExportBundle];
  'intelligence:memory:import': [{ sessionId: string; bundle: unknown }, { imported: number; skipped: number; view: IntelligenceView }];
  /** Session-end reflection, on request: one captured episode plus candidate lessons. */
  'intelligence:reflect': [{ sessionId: string }, { ok: boolean; captured: number; candidates: number; detail?: string; error?: string }];
  /** Promotes a wiki page or a record into a collection or personal memory; the caller is the reviewer. */
  'intelligence:promote': [{ sessionId: string; pageId?: string; recordId?: string; to: 'collection' | 'personal'; collectionId?: string }, IntelligenceView];
  /** Approves or rejects a promotion an agent asked for. */
  'intelligence:promotion:decide': [{ sessionId: string; id: string; decision: 'approve' | 'reject' }, IntelligenceView];
  /** Creates a collection, or replaces an existing one's name, description and membership. */
  'intelligence:collection:save': [{ sessionId: string; id?: string; name: string; description?: string; members: CollectionMember[] }, IntelligenceView];
  /** Deletes a collection and revokes everything promoted into it. */
  'intelligence:collection:delete': [{ sessionId: string; id: string }, IntelligenceView];
  /** Builds the optional graph index for a project that opted in; never runs on its own. */
  'intelligence:graph:index': [{ sessionId: string }, IntelligenceView];
  /** Clears the derived graph cache; authoritative records are untouched. */
  'intelligence:graph:clear': [{ sessionId: string }, IntelligenceView];

  'terminal:list': [void, TerminalInfo[]];
  /** Read-only plain-text screen of one terminal: never attaches, pauses or resizes it. */
  'terminal:screen': [{ terminalId: string; lines?: number }, { info: TerminalInfo; lines: string[]; seq: number }];
  'terminal:shells': [void, ShellOption[]];
  'terminal:create': [{ sessionId: string; shell?: ShellKind; cols?: number; rows?: number }, TerminalInfo];
  /** Start showing a terminal: the screen as it is now plus the seq of the last chunk it contains. */
  'terminal:attach': [{ terminalId: string; cols: number; rows: number }, { snapshot: string; seq: number; info: TerminalInfo }];
  'terminal:detach': [{ terminalId: string }, void];
  'terminal:input': [{ terminalId: string; data: string }, void];
  'terminal:resize': [{ terminalId: string; cols: number; rows: number }, void];
  /** Renderer consumed `chars` of output; lets main resume a PTY it paused for flow control. */
  'terminal:ack': [{ terminalId: string; chars: number }, void];
  'terminal:kill': [{ terminalId: string }, void];
  'terminal:restart': [{ terminalId: string }, TerminalInfo];
  'terminal:close': [{ terminalId: string }, void];
  'terminal:clear': [{ terminalId: string }, void];
  'terminal:rename': [{ terminalId: string; title: string }, TerminalInfo];
}

export type IpcChannel = keyof IpcContract;
export type IpcRequest<K extends IpcChannel> = IpcContract[K][0];
export type IpcResponse<K extends IpcChannel> = IpcContract[K][1];

/** Push channels main -> renderer. */
export const PUSH_CHANNELS = {
  sessionEvent: 'push:sessionEvent',
  sessionsChanged: 'push:sessionsChanged',
  settingsChanged: 'push:settingsChanged',
  focusSession: 'push:focusSession',
  terminalData: 'push:terminalData',
  terminalsChanged: 'push:terminalsChanged',
  agentState: 'push:agentState',
  remoteState: 'push:remoteState',
  desktopFocus: 'push:desktopFocus',
  updateState: 'push:updateState',
  processSummary: 'push:processSummary',
  dictationStatus: 'push:dictationStatus',
  projectMemoryChanged: 'push:projectMemoryChanged'
} as const;

export type PushPayloads = {
  'push:sessionEvent': SessionEventEnvelope;
  'push:sessionsChanged': SessionMeta[];
  'push:settingsChanged': AppSettings;
  'push:focusSession': { sessionId: string };
  /** Raw PTY output for one terminal; `seq` orders it against an attach snapshot. */
  'push:terminalData': { terminalId: string; seq: number; data: string };
  'push:terminalsChanged': TerminalInfo[];
  /** Vesta's whole transcript; the list is short, so state is replaced rather than patched. */
  'push:agentState': AgentState;
  'push:remoteState': RemoteState;
  /** Where the desktop's own window is looking. */
  'push:desktopFocus': DesktopFocus;
  'push:updateState': UpdateState;
  /** Tracked process counts for the Processes tab badge, sent with every background sample. */
  'push:processSummary': ProcessSummary;
  /** Local dictation engine: download progress and server state. Desktop only. */
  'push:dictationStatus': DictationLocalStatus;
  /** Desktop-only invalidation after a passive capture; carries no memory content. */
  'push:projectMemoryChanged': { sessionId: string };
};

export type PushChannel = keyof PushPayloads;

/** The renderer bridge to its host process; the preload script binds it to Electron IPC. */
export interface Transport {
  invoke<K extends IpcChannel>(channel: K, request: IpcRequest<K>): Promise<IpcResponse<K>>;
  on<K extends PushChannel>(channel: K, listener: (payload: PushPayloads[K]) => void): () => void;
  platform: string;
  /** Whether this transport can serve a channel. Absent means everything is allowed (desktop IPC). */
  can?<K extends IpcChannel>(channel: K): boolean;
}

/** The API exposed on window.harness by the preload script — the shared Transport shape. */
export type VocsCodeApi = Transport;
