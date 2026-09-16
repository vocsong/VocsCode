/** The IPC contract shared by main, preload and renderer. Single source of truth for channels, payloads and the exposed API shape. */
import type {
  AnalyticsSummary,
  ApprovalDecision,
  AppSettings,
  CreateSessionRequest,
  DoctorReport,
  EffortLevel,
  FsEntry,
  GitBranchInfo,
  GitBranchOverview,
  GitIssueList,
  GitPullRequestList,
  GitSetupStatus,
  GitSummary,
  GitWorktreeInfo,
  HarnessAvailability,
  HarnessId,
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
  RemoteAuditEntry,
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
import type { ExecutionRecord } from './analytics/records';
import type { KnowledgeGraph, KnowledgePageDetail, KnowledgeSearchResult, KnowledgeView } from './knowledge';
import type { AgentTypeInfo, SubagentRun, SubagentRunSummary } from './subagents';
import type { AgentFileFields, ParsedAgentFile } from './agent-files';
import type { ProjectAgentInfo } from './agent-info';
import type { ClaudeAgentFileInfo } from './claude-agent-files';
import type { ShellKind, ShellOption, TerminalInfo } from './terminal';

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
  'app:openInEditor': [{ path: string; sessionId: string; line?: number }, { ok: boolean; error?: string }];
  'app:openTerminal': [{ cwd: string }, { ok: boolean; error?: string }];
  'app:pickFolder': [{ defaultPath?: string }, { path: string | null }];
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

  'harness:availability': [{ id?: HarnessId } | void, Partial<Record<HarnessId, HarnessAvailability>>];
  'harness:models': [
    { harness: HarnessId; acpAgent?: string; projectRoot?: string },
    { models: ModelInfo[]; error?: string }
  ];
  'harness:install': [{ id: 'pi' | 'dsh' | 'codex' | 'claude' }, { ok: boolean; log: string }];

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

  'sessions:list': [void, SessionMeta[]];
  'sessions:create': [CreateSessionRequest, SessionMeta];
  'sessions:get': [{ id: string }, SessionMeta | null];
  'sessions:transcript': [{ id: string }, TranscriptItem[]];
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
  'sessions:pin': [{ id: string; pinned: boolean }, SessionMeta];
  /** Persists a pinned-section drag reorder: ids in their new display order. */
  'sessions:pinOrder': [{ ids: string[] }, void];
  'sessions:send': [{ id: string; input: UserInput }, void];
  /** Replaces a sent message, discards its later transcript items, and runs it again. */
  'sessions:editAndResend': [{ id: string; userItemId: string; input: UserInput }, TranscriptItem[]];
  'sessions:interrupt': [{ id: string }, void];
  'sessions:stop': [{ id: string }, void];
  'sessions:setModel': [{ id: string; model: ModelRef }, SessionMeta];
  'sessions:setEffort': [{ id: string; effort: EffortLevel }, SessionMeta];
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

  /** Remote access (docs/REMOTE-ACCESS.md). Enrollment + device tokens live in the secret store. */
  'remote:get': [void, { config: RemoteConfig; state: RemoteState; devices: RemoteDeviceInfo[]; audit: RemoteAuditEntry[] }];
  'remote:enable': [{ relayUrl: string; enrollToken: string }, RemoteState];
  'remote:disable': [void, RemoteState];
  'remote:pairStart': [{ hostName?: string }, { code: string; expiresAt: number }];
  'remote:pairRespond': [{ decision: 'approve' | 'deny' }, void];
  'remote:revoke': [{ deviceId: string }, void];
  /** P4: view-only mode is a desktop policy, persisted in settings and pushed to paired browsers. */
  'remote:setViewOnly': [{ viewOnly: boolean }, RemoteState];
  /** P4: the offline mirror is opt-in; enabling it syncs the existing sessions, disabling clears it. */
  'remote:setMirror': [{ mirror: boolean }, RemoteState];
  'remote:clearAudit': [void, void];

  'git:folderBranch': [{ projectRoot: string }, { branch?: string; detached?: boolean }];
  /** Pre-session probe for a folder the dialog is configuring: worktree isolation needs a git repository. */
  'git:folderIsRepo': [{ projectRoot: string }, { isRepo: boolean }];
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
  /** Pulls the repo's issues (all states) from GitHub through gh, for the Git panel's Issues view. */
  'git:issues': [{ sessionId: string }, GitIssueList];

  'fs:list': [{ sessionId: string; relPath?: string }, FsEntry[]];
  'fs:search': [{ sessionId: string; query: string; limit?: number }, string[]];
  'fs:read': [{ sessionId: string; path: string; maxBytes?: number }, { content: string; truncated: boolean }];

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

  'terminal:list': [void, TerminalInfo[]];
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
  updateState: 'push:updateState'
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
  'push:updateState': UpdateState;
};

export type PushChannel = keyof PushPayloads;

/** The API exposed on window.harness by the preload script — the shared Transport shape (see ./transport). */
export type { Transport as VocsCodeApi } from './transport';
