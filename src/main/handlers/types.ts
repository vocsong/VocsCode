/**
 * Shared types for the transport-agnostic IPC handler registry and its domain registrars.
 * Keep this file Electron-free so the registry stays testable in plain Node.
 */
import type { IpcChannel, IpcRequest, IpcResponse } from '../../shared/ipc';
import type { CreateMissionRequest, MissionControlRequest, MissionRecord } from '../../shared/mission';
import type { SessionMeta, UserInput } from '../../shared/types';
import type { AnalyticsStore } from '../analytics';
import type { AppInstructions } from '../app-instructions';
import type { DesktopFocusTracker } from '../desktop-focus';
import type { DictationService } from '../dictation/service';
import type { IntelligenceService } from '../intelligence/service';
import type { KnowledgeService } from '../knowledge/service';
import type { GitnexusIndexer, GitnexusIndexReason } from '../mcp';
import type { ModelCatalogCache } from '../model-catalog-cache';
import type { PiConfigStore } from '../pi-config';
import type { ProcessTracker } from '../process-tracker';
import type { RemoteHost } from '../remote/host';
import type { RuntimeResolver } from '../runtime';
import type { SearchIndex } from '../search';
import type { SecretStore } from '../secrets';
import type { SessionManager } from '../session-manager';
import type { SettingsStore } from '../settings';
import type { TerminalManager } from '../terminal';
import type { UpdateService } from '../updater';
import type { VocsAccountBroker } from '../vocs-account';

export type { HandlerRegistry } from './registry-types';

export type MissionReadScope = {
  cwd: string;
  session: SessionMeta;
  mission?: MissionRecord;
  workspace?: MissionRecord['workspaces'][number];
};

export interface MissionBoundaryGuard {
  missionService(): MissionHandlerService;
  sessionFor(id: unknown): SessionMeta;
  missionFor(session: SessionMeta): MissionRecord | undefined;
  requireLead(session: SessionMeta, mission: MissionRecord): void;
  pathKey(p: string): string;
  realResource(p: string): Promise<string>;
  assertOrdinaryWorkspace(target: string, includeDescendants?: boolean): Promise<void>;
  assertOrdinarySession(id: unknown): Promise<SessionMeta>;
  assertOrdinaryBranch(session: SessionMeta, branches: unknown[], repositoryWide?: boolean): Promise<Set<string>>;
  missionOwnershipPossible(): boolean;
  recordTerminalVerdict(terminal: { id: string; cwd: string }, allowed: boolean): void;
  guardMissionBoundary(channel: string, input: unknown, actor: 'user' | 'agent'): Promise<void> | undefined;
  missionReadScope(sessionId: string, workspaceId?: string): Promise<MissionReadScope>;
  assertPreviewWriteScope(scope: MissionReadScope): void;
  assertPreviewWriteTarget(scope: MissionReadScope, target: string): Promise<void>;
  missionDiff(sessionId: string, workspaceId?: string, file?: string, staged?: boolean): Promise<{ diff: string; error?: string }>;
}

/** Structural dialog options (Electron shapes are cast in ipc.ts, keeping this file Electron-free). */
export interface OpenDialogOptions {
  properties?: string[];
  defaultPath?: string;
}

export interface SaveDialogOptions {
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

/** The Electron affordances handlers need, provided by the host (ipc.ts supplies real ones). */
export interface DesktopBridge {
  appVersion(): string;
  isPackaged(): boolean;
  userDataPath(): string;
  documentsPath(): string;
  electronVersion(): string;
  openExternal(url: string): Promise<void>;
  openPath(p: string): Promise<void>;
  /** Opens the system file manager at `p`'s folder with `p` selected; never opens `p` itself. */
  showItemInFolder(p: string): void;
  /** Optional trusted desktop operation; no permanent-delete fallback. */
  trashItem?(p: string): Promise<void>;
  showOpenDialog(opts: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog(opts: SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }>;
  notify(title: string, body: string): Promise<void>;
  toggleFullScreen(): void;
  reload(): void;
  toggleDevTools(): void;
  /** Returns the resulting zoom factor, or null when there is no window. */
  zoom(direction: 'in' | 'out' | 'reset'): number | null;
  edit(command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'): void;
}

/** The registry consumes the public coordination port, never the model-facing tool broker. */
export interface MissionHandlerService {
  create(request: CreateMissionRequest): Promise<MissionRecord>;
  get(id: string): MissionRecord | undefined;
  list(): MissionRecord[];
  control(request: MissionControlRequest & { submittedCommand?: string }): Promise<MissionRecord>;
  sendUser(leadSessionId: string, input: UserInput, idempotencyKey?: string): Promise<void | MissionRecord>;
  /** Stops the owned group and archives its sessions without removing any worktrees. */
  archive?(missionId: string, archived: boolean): Promise<unknown>;
}

export interface HandlerDeps {
  vocsAccount?: VocsAccountBroker;
  settings: SettingsStore;
  secrets: SecretStore;
  sessions: SessionManager;
  missions?: MissionHandlerService;
  /** Reserves desktop preview saves against Mission workspace capture/reconciliation. */
  withWorkspaceWrite?: (cwd: string, write: () => Promise<void>) => Promise<void>;
  terminals: TerminalManager;
  runtime: RuntimeResolver;
  analytics: AnalyticsStore;
  /** Deep session search (FTS5); derived state, safe to rebuild. */
  search: SearchIndex;
  /** Layer 2 project knowledge (wiki store + jobs); present when wired up in index.ts. */
  knowledge?: KnowledgeService;
  /** Memory lifecycle, collections and scoped retrieval; present when wired up in index.ts. */
  intelligence?: IntelligenceService;
  revokeMemoryGrants?: () => void;
  /** Best-effort GitNexus freshness queue; absent in tests/hosts that do not run the built-in. */
  gitnexusIndexer?: Pick<GitnexusIndexer, 'schedule' | 'index'>;
  /** Remote access host (docs/REMOTE-ACCESS.md); present when wired up in index.ts. */
  remote?: RemoteHost;
  /** Local owner configuration, never exposed through browser/agent invocation origins. */
  control?: import('../control/service').ControlService;
  /** Which session the desktop window is on, mirrored to paired browsers; absent in tests. */
  desktopFocus?: DesktopFocusTracker;
  /** P4 offline mirror: synced/cleared when the desktop's mirror policy changes. */
  remoteMirror?: { sync(): void; disable(): void };
  /** Base-pi global config (Settings → Pi); a default store is created when absent. */
  piConfig?: PiConfigStore;
  /** The app's own instruction layer (Settings → Instructions); created from userData when absent. */
  appInstructions?: AppInstructions;
  /** In-app auto-update (issue #198); absent in dev and other unpackaged runs. */
  updater?: UpdateService;
  /** Every process the app started (the Processes panel); absent in tests that do not sample. */
  processes?: Pick<ProcessTracker, 'list' | 'end'>;
  /** Composer dictation; built from userData on first use when absent. */
  dictation?: DictationService;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Push an async event to the connected client (the window today, remote clients later). */
  push: (channel: string, payload: unknown) => void;
  desktop: DesktopBridge;
}

export type RegisterHandle = <K extends IpcChannel>(
  channel: K,
  fn: (req: IpcRequest<K>) => Promise<IpcResponse<K>> | IpcResponse<K>
) => void;

export interface KnowledgeScope {
  projectRoot: string;
  cwd: string;
  branch?: string;
}

/** Shared context passed to each domain handler registrar. */
export interface HandlerContext {
  deps: HandlerDeps;
  handle: RegisterHandle;
  invokeChannel: (channel: string, req: unknown, actor?: 'user' | 'agent' | 'desktop') => Promise<unknown>;
  missionGuard: MissionBoundaryGuard;
  /** Register a cleanup hook invoked during `registry.shutdown()`. */
  onShutdown: (fn: () => Promise<void> | void) => void;
  pickedFolders: Set<string>;
  knownFolder: (projectRoot: string) => boolean;
  launchEditor: (p: string, line?: number) => Promise<{ ok: boolean; error?: string }>;
  scheduleGitnexus: (session: SessionMeta, reason: GitnexusIndexReason) => void;
  knowledgeScopeOf: (sessionId: string) => KnowledgeScope;
  modelCatalog: () => ModelCatalogCache;
  housekeepWriteGuard: {
    isSavingRecentDays: () => boolean;
    track: <T>(active: boolean, fn: () => Promise<T>) => Promise<T>;
  };
  slowHandlerMs: number;
}
