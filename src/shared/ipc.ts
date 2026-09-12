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
  GitPullRequestList,
  GitSummary,
  GitWorktreeInfo,
  HarnessAvailability,
  HarnessId,
  ModelInfo,
  ModelOverride,
  ModelRef,
  PermissionMode,
  ProviderConfig,
  SessionEventEnvelope,
  SessionMeta,
  SkillHarness,
  SkillRootInfo,
  TranscriptItem,
  UserInput
} from './types';
import type { ShellKind, ShellOption, TerminalInfo } from './terminal';

/**
 * Request/response contract for ipcRenderer.invoke channels.
 * Each key is a channel; value is [request, response].
 */
export interface IpcContract {
  'app:info': [void, { version: string; platform: string; userData: string; isPackaged: boolean }];
  'app:doctor': [void, DoctorReport];
  'app:openExternal': [{ url: string }, void];
  'app:openPath': [{ path: string; sessionId: string }, void];
  'app:openInEditor': [{ path: string; line?: number }, { ok: boolean; error?: string }];
  'app:openTerminal': [{ cwd: string }, { ok: boolean; error?: string }];
  'app:pickFolder': [{ defaultPath?: string }, { path: string | null }];
  'app:notify': [{ title: string; body: string }, void];
  /** A renderer stall (long task, delayed input, timer drift) recorded in the main log. */
  'app:diag': [{ kind: 'longtask' | 'input-delay' | 'loop-lag'; ms: number; detail?: string }, void];

  'window:toggleFullScreen': [void, void];
  'window:reload': [void, void];
  'window:toggleDevTools': [void, void];
  'window:zoom': [{ direction: 'in' | 'out' | 'reset' }, { zoomFactor: number }];
  'window:edit': [{ command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' }, void];

  'settings:get': [void, AppSettings];
  'settings:update': [Partial<AppSettings>, AppSettings];

  'secrets:set': [{ providerId: string; apiKey: string }, void];
  'secrets:clear': [{ providerId: string }, void];
  'secrets:has': [{ providerId: string }, boolean];

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

  'sessions:list': [void, SessionMeta[]];
  'sessions:create': [CreateSessionRequest, SessionMeta];
  'sessions:get': [{ id: string }, SessionMeta | null];
  'sessions:transcript': [{ id: string }, TranscriptItem[]];
  'sessions:delete': [{ id: string; removeWorktree?: boolean }, void];
  'sessions:rename': [{ id: string; title: string }, SessionMeta];
  'sessions:archive': [{ id: string; archived: boolean; removeWorktree?: boolean; forceWorktree?: boolean }, SessionMeta];
  'sessions:pin': [{ id: string; pinned: boolean }, SessionMeta];
  'sessions:send': [{ id: string; input: UserInput }, void];
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

  'analytics:summary': [{ days?: number } | void, AnalyticsSummary];

  'approvals:respond': [{ sessionId: string; requestId: string; decision: ApprovalDecision }, void];

  'git:folderBranch': [{ projectRoot: string }, { branch?: string; detached?: boolean }];
  'git:summary': [{ sessionId: string }, GitSummary];
  'git:diff': [{ sessionId: string; path?: string; staged?: boolean }, { diff: string }];
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
  'git:deleteBranch': [{ sessionId: string; branch: string; force?: boolean }, { ok: boolean; error?: string }];
  /** Fast-forwards a local branch to its upstream, whether or not it is checked out. */
  'git:updateBranch': [{ sessionId: string; branch: string }, { ok: boolean; error?: string }];
  'git:removeWorktree': [{ sessionId: string; path: string }, { ok: boolean; error?: string }];
  'git:pruneWorktrees': [{ sessionId: string }, { ok: boolean; output: string }];
  'git:fetchPrune': [{ sessionId: string }, { ok: boolean; output: string }];
  /** Pulls the repo's pull requests (all states) from GitHub through gh, for the Git panel's PR view. */
  'git:pullRequests': [{ sessionId: string }, GitPullRequestList];

  'fs:list': [{ sessionId: string; relPath?: string }, FsEntry[]];
  'fs:search': [{ sessionId: string; query: string; limit?: number }, string[]];
  'fs:read': [{ sessionId: string; path: string; maxBytes?: number }, { content: string; truncated: boolean }];

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
  terminalsChanged: 'push:terminalsChanged'
} as const;

export type PushPayloads = {
  'push:sessionEvent': SessionEventEnvelope;
  'push:sessionsChanged': SessionMeta[];
  'push:settingsChanged': AppSettings;
  'push:focusSession': { sessionId: string };
  /** Raw PTY output for one terminal; `seq` orders it against an attach snapshot. */
  'push:terminalData': { terminalId: string; seq: number; data: string };
  'push:terminalsChanged': TerminalInfo[];
};

/** The API exposed on window.harness by the preload script. */
export interface VocsCodeApi {
  invoke<K extends IpcChannel>(channel: K, request: IpcRequest<K>): Promise<IpcResponse<K>>;
  on<K extends keyof PushPayloads>(channel: K, listener: (payload: PushPayloads[K]) => void): () => void;
  platform: string;
}
