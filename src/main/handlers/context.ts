/** Shared context, types, and boundary helpers for modular IPC handler registration. */
import path from 'node:path';
import { z } from 'zod';
import type { IpcChannel, IpcRequest, IpcResponse } from '../../shared/ipc';
import type { HarnessAvailability, HarnessId, ImageAttachment, SessionMeta } from '../../shared/types';
import type { AnalyticsStore } from '../analytics';
import type { AppInstructions } from '../app-instructions';
import type { DesktopFocusTracker } from '../desktop-focus';
import type { DictationService } from '../dictation/service';
import type { IntelligenceService } from '../intelligence/service';
import type { KnowledgeUsage } from '../intelligence/usage';
import type { KnowledgeService } from '../knowledge/service';
import type { GitnexusIndexer, GitnexusIndexReason } from '../mcp';
import type { MissionService } from '../mission-mode/service';
import type { ModelCatalogCache } from '../model-catalog-cache';
import type { PiConfigStore } from '../pi-config';
import type { ProcessTracker } from '../process-tracker';
import type { RemoteHostPort } from '../remote/types';
import type { RuntimeResolver } from '../runtime';
import type { SearchIndex } from '../search';
import type { SecretStore } from '../secrets';
import type { SessionManager } from '../session-manager';
import type { SharedSkillsStore } from '../shared-skills';
import type { SettingsStore } from '../settings';
import type { TerminalManager } from '../terminal';
import type { UpdateService } from '../updater';
import type { VocsAccountBroker } from '../vocs-account';

/** Structural dialog options (Electron shapes are cast in ipc.ts, keeping handlers Electron-free). */
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

export interface HandlerDeps {
  vocsAccount?: VocsAccountBroker;
  settings: SettingsStore;
  secrets: SecretStore;
  sessions: SessionManager;
  terminals: TerminalManager;
  runtime: RuntimeResolver;
  analytics: AnalyticsStore;
  /** Deep session search (FTS5); derived state, safe to rebuild. */
  search: SearchIndex;
  /** Layer 2 project knowledge (wiki store + jobs); present when wired up in index.ts. */
  knowledge?: KnowledgeService;
  /** Memory lifecycle, collections and scoped retrieval; present when wired up in index.ts. */
  intelligence?: IntelligenceService;
  knowledgeUsage?: KnowledgeUsage;
  revokeMemoryGrants?: () => void;
  /** Best-effort GitNexus freshness queue; absent in tests/hosts that do not run the built-in. */
  gitnexusIndexer?: Pick<GitnexusIndexer, 'schedule' | 'index'>;
  /** Remote access host (docs/REMOTE-ACCESS.md); present when wired up in index.ts. */
  remote?: RemoteHostPort;
  /** Local owner configuration, never exposed through browser/agent invocation origins. */
  control?: import('../control/service').ControlService;
  localControl?: Pick<import('../control/local').LocalControl, 'ownerState' | 'enable' | 'disable'>;
  /** Which session the desktop window is on, mirrored to paired browsers; absent in tests. */
  desktopFocus?: DesktopFocusTracker;
  /** P4 offline mirror: synced/cleared when the desktop's mirror policy changes. */
  remoteMirror?: { sync(): void; disable(): void };
  /** The code.vocs.io dashboard's analytics uploader (src/main/remote/analytics-sync.ts). */
  analyticsSync?: { sharingChanged(): Promise<unknown> };
  /** Base-pi global config (Settings → Pi); a default store is created when absent. */
  piConfig?: PiConfigStore;
  /** The app's own instruction layer (Settings → Instructions); created from userData when absent. */
  appInstructions?: AppInstructions;
  /** Owner-only catalog; otherwise constructed lazily from the desktop profile. */
  sharedSkills?: SharedSkillsStore;
  /** In-app auto-update (issue #198); absent in dev and other unpackaged runs. */
  updater?: UpdateService;
  /** Every process the app started (the Processes panel); absent in tests that do not sample. */
  processes?: Pick<ProcessTracker, 'list' | 'end'>;
  /** Composer dictation; built from userData on first use when absent. */
  dictation?: DictationService;
  /** Mission mode (desktop owner only); absent in hosts that do not run it. */
  mission?: Pick<MissionService, 'start' | 'createLead' | 'get' | 'stop' | 'resume'>;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Push an async event to the connected client (the window today, remote clients later). */
  push: (channel: string, payload: unknown) => void;
  desktop: DesktopBridge;
}

export interface HandlerRegistry {
  /** Every channel this registry serves — the host binds each to its transport. */
  channels(): IpcChannel[];
  invoke(channel: string, req: unknown, actor?: 'user' | 'agent' | 'desktop'): Promise<unknown>;
  /** Shared ordinary-resource guard for typed control operations, not generic IPC dispatch. */
  assertControlResource?(resource: { sessionId?: string; projectRoot?: string }): Promise<void>;
  /** Stops background children the registry owns (Vesta's pi process, Cua preview, dictation, Vocs account). */
  shutdown(): Promise<void>;
}

export type RegisterHandler = <K extends IpcChannel>(
  channel: K,
  fn: (req: IpcRequest<K>) => Promise<IpcResponse<K>> | IpcResponse<K>
) => void;

export interface KnowledgeScope {
  projectRoot: string;
  cwd: string;
  branch?: string;
}

export interface HandlerContext {
  deps: HandlerDeps;
  handle: RegisterHandler;
  invokeChannel(channel: string, req: unknown, actor?: 'user' | 'agent' | 'desktop'): Promise<unknown>;
  sessionFor(id: unknown): SessionMeta;
  cwdOf(sessionId: string): string;
  knowledgeScopeOf(sessionId: string): KnowledgeScope;
  pickedFolders: Set<string>;
  launchEditor(p: string, line?: number): Promise<{ ok: boolean; error?: string }>;
  scheduleGitnexus(session: SessionMeta, reason: GitnexusIndexReason): void;
  availabilityCache: Map<HarnessId, { at: number; value: HarnessAvailability }>;
  availabilityGeneration(): number;
  invalidateAvailability(): void;
  modelCatalog(): ModelCatalogCache;
  trackHousekeepWrite<T>(work: () => Promise<T>): Promise<T>;
  isHousekeepWriting(): boolean;
  onShutdown(fn: () => Promise<void> | void): void;
}

/** A handler holding the host process this long has already frozen the UI; say so. */
export const SLOW_HANDLER_MS = 1000;

export const sessionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/, 'Invalid session identifier');

/** A New Session request that starts a Mission Lead; any truthy flag counts, so a forged one is refused too. */
export const isMissionCreate = (channel: string, req: unknown): boolean =>
  channel === 'sessions:create' &&
  !!req &&
  typeof req === 'object' &&
  'mission' in req &&
  (req as { mission?: unknown }).mission !== undefined &&
  (req as { mission?: unknown }).mission !== false;

/** Pasted images crossing IPC: keep only well-formed image attachments, so a malformed payload
 *  cannot reach the harness with, say, a non-image mime type or a missing body. */
export function normalizeAgentImages(raw: unknown): ImageAttachment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ImageAttachment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { mimeType, data, name } = entry as Partial<ImageAttachment>;
    if (typeof mimeType !== 'string' || !/^image\/[a-z0-9.+-]+$/i.test(mimeType)) continue;
    if (typeof data !== 'string' || !data) continue;
    out.push({ mimeType, data, ...(typeof name === 'string' && name ? { name } : {}) });
  }
  return out.length ? out : undefined;
}

/** A local absolute path, normalised, or null. UNC (`\\host\share`), device (`\\?\`, `\\.\`) and
 *  `//host` forms are refused, as are Windows stream suffixes (`file.txt:stream`). */
export function localAbsolutePath(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.length > 4096 || /[\x00-\x1f]/.test(p) || /^[\\/]{2}/.test(p)) return null;
  if (process.platform === 'win32') {
    if (!/^[A-Za-z]:[\\/]/.test(p) || p.slice(2).includes(':')) return null;
  } else if (!p.startsWith('/')) return null;
  return path.resolve(p);
}

export function fuzzyMatch(hay: string, needle: string): boolean {
  if (hay.includes(needle)) return true;
  let i = 0;
  for (const c of hay) {
    if (c === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}
