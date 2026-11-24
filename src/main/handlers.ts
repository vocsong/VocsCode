import { createVocsAccount, vocsAccountRealm, type VocsAccountBroker } from './vocs-account';
/** Transport-agnostic handler registry: every invoke channel, bound once, Electron-free.
 *  ipc.ts binds it to Electron's ipcMain; the remote host (docs/REMOTE-ACCESS.md) binds
 *  the same registry to its WebSocket transport. Electron affordances arrive via
 *  DesktopBridge, push delivery via deps.push. */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { controlGrantInputSchema } from '../shared/control';
import { VOCS_HUB_CONNECTION_IDS, type VocsHubConnectionId } from '../shared/vocs-account';
import type { IpcChannel, IpcRequest, IpcResponse } from '../shared/ipc';
import { FILE_PREVIEW_MAX_BYTES, PUSH_CHANNELS, TEXT_EXPORT_MAX_BYTES } from '../shared/ipc';
import { Vesta } from './agents';
import { deleteProjectAgent, listProjectAgents, readProjectAgent, saveProjectAgent, setProjectAgentTracked } from './agent-files';
import { createClaudeAgent, isPinnedModel, listClaudeAgents, setClaudeAgentModel } from './claude-agents';
import type { AppSettings, DoctorReport, HarnessAvailability, HarnessId, ImageAttachment, RemoteConfig, SessionMeta, UserInput } from '../shared/types';
import { HARNESSES } from '../shared/harness-meta';
import { applyModelOverrides, modelOverrideKey } from '../shared/model-overrides';
import { gitBranches, gitBranchesOverview, gitCheckout, gitCommit, gitCreateGitHubRepo, gitCreatePr, gitDeleteBranch, gitDiff, gitFetchPrune, gitFolderBranch, gitGithubIdentity, gitInit, gitInitialCommit, gitIssueComments, gitIssues, gitMergePr, gitPruneWorktrees, gitPullRequest, gitPullRequestComments, gitPullRequests, gitPush, gitRangeEvidence, gitRevertFile, gitRoot, gitSetIdentity, gitSetRemote, gitSetupStatus, gitStageAll, gitSummary, gitUpdateBranch, gitWorktrees, removeWorktree, type SessionPrQuery } from './git';
import type { AnalyticsStore } from './analytics';
import type { KnowledgeService } from './knowledge/service';
import type { IntelligenceContext, IntelligenceService } from './intelligence/service';
import { isIntelligenceOwnerRequest, isMemoryState, isMemoryType } from '../shared/intelligence';
import type { UpdateState } from '../shared/types';
import type { UpdateService } from './updater';
import { isOutsideWorkspace } from './harness/permissions';
import { globalStoreInfo, inspectServer, mergeById, normalizeStdio, projectInfo, readProjectMcp, readStore, resolveVars, secretKeyFor, toMcpJsonTable, writeProjectMcp, CuaPreviewSession, clearCuaVersionCache, cuaBaseDef, cuaDefState, cuaInstallCommand, cuaStatus, type GitnexusIndexer, type GitnexusIndexReason } from './mcp';
import { listHarnessModels } from './harness/registry';
import { readCodexSubscriptionQuota } from './harness/codex-quota';
import { INLINE_SUBSCRIPTION_PROVIDERS, SUBSCRIPTION_PROVIDERS, type SubscriptionLimits } from '../shared/subscription-usage';
import { ModelCatalogCache } from './model-catalog-cache';
import { assertProviderEndpoint, fallbackModels, fetchProviderModels, resolveProviderApiKey, testProvider } from './models/providers';
import { assertEndpointUrl } from '../shared/endpoint-policy';
import { enrichModelsFromProviders } from './models/static-models';
import type { RuntimeResolver, ToolName } from './runtime';
import type { SearchIndex } from './search';
import { clearWhichCache, clearRuntimeProbeCache, HARNESS_PACKAGES, runCapture, which } from './runtime';
import { assertHarnessId, openAntigravityUsage, openHarnessLogin, readHarnessSetup, withAppCredentials } from './harness-setup';
import type { SecretStore } from './secrets';
import type { SessionManager } from './session-manager';
import { mcpServersSaveError, normalizeMcpProjectState, normalizeMcpServers, type SettingsStore } from './settings';
import { copySkill, createSkill, deleteSkill, listSkills, locateSkillPath, readSkillDoc } from './skills';
import { PiConfigStore, runPiCommand } from './pi-config';
import { AppInstructions } from './app-instructions';
import type { TerminalManager } from './terminal';
import type { RemoteHost } from './remote/host';
import type { DesktopFocusTracker } from './desktop-focus';
import type { ProcessTracker } from './process-tracker';
import { relayUrl, signInAvailable } from './remote/relay-url';
import { transcriptPage } from '../shared/transcript-page';
import { listWorkspaceFiles, readWorkspaceFile, readWorkspaceImage, resolveWorkspaceFile, validateWorkspaceFileTarget, writeWorkspaceText } from './workspace-files';
import { errorMessage } from './util/async';
import { spawnTool } from './harness/spawn';
import { DictationService } from './dictation/service';
import { localModel } from '../shared/dictation';
import { discoverChatImports } from './chat-import';
import { MAX_HOUSEKEEP_RECENT_DAYS } from '../shared/housekeep';
import { configuredHousekeepReviewer, HousekeepService } from './housekeep';
import { scanHousekeepInventory } from './housekeep-inventory';
import { representsChatImport } from './chat-import-identity';
import { isReservedSecretId, providerSecrets } from './secret-ids';

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
  revokeMemoryGrants?: () => void;
  /** Best-effort GitNexus freshness queue; absent in tests/hosts that do not run the built-in. */
  gitnexusIndexer?: Pick<GitnexusIndexer, 'schedule' | 'index'>;
  /** Remote access host (docs/REMOTE-ACCESS.md); present when wired up in index.ts. */
  remote?: RemoteHost;
  /** Local owner configuration, never exposed through browser/agent invocation origins. */
  control?: import('./control/service').ControlService;
  localControl?: Pick<import('./control/local').LocalControl, 'ownerState' | 'enable' | 'disable'>;
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

export interface HandlerRegistry {
  /** Every channel this registry serves — the host binds each to its transport. */
  channels(): IpcChannel[];
  invoke(channel: string, req: unknown, actor?: 'user' | 'agent' | 'desktop'): Promise<unknown>;
  /** Shared ordinary-resource guard for typed control operations, not generic IPC dispatch. */
  assertControlResource?(resource: { sessionId?: string; projectRoot?: string }): Promise<void>;
  /** Stops background children the registry owns (Vesta's pi process). */
  shutdown(): Promise<void>;
}

/** A handler holding the host process this long has already frozen the UI; say so. */
const SLOW_HANDLER_MS = 1000;

/** The CLI whose catalog `harness:models` reads, so a switched runtime misses the model cache. */
const HARNESS_BINARY: Partial<Record<HarnessId, ToolName>> = { claude: 'claude', codex: 'codex', 'codex-exec': 'codex', pi: 'pi', antigravity: 'agy' };

const sessionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/, 'Invalid session identifier');

export function createHandlerRegistry(deps: HandlerDeps): HandlerRegistry {
  const { settings, secrets, sessions, terminals, runtime } = deps;
  const vocsAccount = deps.vocsAccount ?? createVocsAccount({ realm: vocsAccountRealm(), openExternal: url => deps.desktop.openExternal(url) });
  const piConfig =
    deps.piConfig ??
    new PiConfigStore({
      log: deps.log,
      piBinary: () => runtime.resolve('pi')?.path ?? null,
      runPi: (args) => {
        const piPath = runtime.resolve('pi')?.path;
        if (!piPath) return Promise.resolve({ ok: false, code: null, log: '', error: 'pi is not installed — install it from Settings → Harnesses first.' });
        // cwd is the app's userData, never a project: pi install writes global settings, and a
        // repo's .pi/ must not influence the command.
        return runPiCommand(args, { piPath, cwd: deps.desktop.userDataPath(), log: deps.log });
      }
    });
  // Built on first use, like piConfig's runner: hosts and tests wire up only what they exercise,
  // and a registry that never touches the channels must not need a userData path.
  let defaultAppInstructions: AppInstructions | undefined;
  const appInstructions = (): AppInstructions => (defaultAppInstructions ??= deps.appInstructions ?? new AppInstructions(deps.desktop.userDataPath(), deps.log));
  let dictationService: DictationService | undefined = deps.dictation;
  const dictation = (): DictationService =>
    (dictationService ??= new DictationService({
      settings,
      secrets,
      userData: deps.desktop.userDataPath(),
      log: deps.log,
      push: (status) => deps.push(PUSH_CHANNELS.dictationStatus, status)
    }));
  let housekeepSettingsWrites = 0;
  const housekeep = new HousekeepService({
    sessions,
    settings: () => settings.get(),
    savingRecentDays: () => housekeepSettingsWrites > 0,
    // Partial registry hosts may not have a desktop bridge; without Trash, removal fails closed.
    trashDirectory: deps.desktop?.trashItem?.bind(deps.desktop),
    hasTerminalOrView: id => deps.desktopFocus?.state().sessionId === id || !!deps.desktopFocus?.isViewing(id) || terminals.list().some(terminal => terminal.sessionId === id),
    runningOwners: deps.processes && (async () => {
      try {
        const snapshot = await deps.processes!.list();
        return snapshot.error ? null : new Set(snapshot.processes.flatMap(process => process.owner.sessionId ? [process.owner.sessionId] : []));
      } catch { return null; }
    }),
    reviewer: () => configuredHousekeepReviewer(settings.get(), { getSecret: providerSecrets(id => secrets.get(id)), log: deps.log })
  });
  const handlers = new Map<IpcChannel, (req: never) => unknown>();
  const availabilityCache = new Map<HarnessId, { at: number; value: HarnessAvailability }>();
  let availabilityGeneration = 0;
  const invalidateAvailability = () => { availabilityGeneration++; availabilityCache.clear(); clearRuntimeProbeCache(); };
  // Built on first use: a registry that never lists models must not need a userData path.
  let modelCatalogCache: ModelCatalogCache | undefined;
  const modelCatalog = (): ModelCatalogCache => {
    if (modelCatalogCache) return modelCatalogCache;
    let dir: string | undefined;
    try { dir = deps.desktop.userDataPath(); } catch { dir = undefined; }
    return (modelCatalogCache = new ModelCatalogCache(dir, { log: deps.log }));
  };

  function handle<K extends IpcChannel>(channel: K, fn: (req: IpcRequest<K>) => Promise<IpcResponse<K>> | IpcResponse<K>): void {
    handlers.set(channel, fn as (req: never) => unknown);
  }

  for (const [channel, action] of [
    ['vocsAccount:get', () => vocsAccount.get()],
    ['vocsAccount:cancel', () => vocsAccount.cancel()],
    ['vocsAccount:signOut', () => vocsAccount.signOut()],
    ['vocsAccount:refresh', () => vocsAccount.refresh()]
  ] as const) handle(channel, input => {
    if (input !== undefined) throw new Error('Account commands do not accept configuration.');
    return action();
  });
  // The one choice the renderer makes: keep this sign-in or not. Main picks client, issuer and label.
  const signInRequest = z.strictObject({ persist: z.boolean() }).optional();
  handle('vocsAccount:signIn', input => {
    const parsed = signInRequest.safeParse(input);
    if (!parsed.success) throw new Error('Account commands do not accept configuration.');
    return vocsAccount.signIn(parsed.data);
  });
  // A Hub connection is named by its catalog id only; resource, issuer and scopes come from the
  // catalog main verified, never from the renderer.
  const hubRequest = z.strictObject({ connectionId: z.enum(VOCS_HUB_CONNECTION_IDS) });
  for (const [channel, action] of [
    ['vocsAccount:hubConnect', (id: VocsHubConnectionId) => vocsAccount.hubConnect(id)],
    ['vocsAccount:hubCancel', (id: VocsHubConnectionId) => vocsAccount.hubCancel(id)],
    ['vocsAccount:hubDisconnect', (id: VocsHubConnectionId) => vocsAccount.hubDisconnect(id)]
  ] as const) handle(channel, input => {
    const parsed = hubRequest.safeParse(input);
    if (!parsed.success) throw new Error('Account commands do not accept configuration.');
    return action(parsed.data.connectionId);
  });

  if (deps.control) {
    const control = deps.control;
    handle('control:get', () => control.ownerState());
    handle('control:enable', (input) => control.setEnabled(z.strictObject({ enabled: z.boolean() }).parse(input).enabled));
    handle('control:grant', (input) => control.grant(controlGrantInputSchema.parse(input)));
    handle('control:revoke', (input) => control.revoke(z.strictObject({ grantId: z.string().uuid() }).parse(input).grantId));
  }
  if (deps.localControl) {
    const local = deps.localControl;
    handle('control:local:get', () => local.ownerState());
    handle('control:local:enable', (input) => local.enable(input));
    handle('control:local:disable', () => local.disable());
  }

  async function invokeChannel(channel: string, req: unknown, actor: 'user' | 'agent' | 'desktop' = 'user'): Promise<unknown> {
    if (channel.startsWith('vocsAccount:') && actor !== 'desktop') throw new Error('Vocs account sign-in requires the local desktop owner.');
    if (channel.startsWith('control:') && actor !== 'desktop') throw new Error('External control grants require the local desktop owner.');
    if (channel.startsWith('housekeep:') && actor !== 'desktop') throw new Error('Housekeep requires the local desktop owner.');
    if (isIntelligenceOwnerRequest(channel, req) && actor !== 'desktop') throw new Error('Intelligence settings and memory management require the local desktop owner.');
    if (channel === 'harness:login' && actor !== 'desktop') throw new Error('Harness sign-in requires the local desktop owner.');
    if (channel.startsWith('subscriptions:') && actor !== 'desktop') throw new Error('Subscription usage requires the local desktop owner.');
    if (channel === 'fs:writeText' && actor !== 'desktop') throw new Error('Saving workspace text requires the local desktop owner.');
    const fn = handlers.get(channel as IpcChannel);
    if (!fn) {
      deps.log('warn', `ipc: unknown channel ${channel}`);
      throw new Error(`Unknown channel: ${channel}`);
    }
    const t0 = Date.now();
    try {
      if (actor === 'agent') guardAgentBoundary(channel, req);
      return await fn(req as never);
    } catch (e) {
      // The renderer shows the message as a toast, but a toast is gone in seconds; the log line
      // is what a bug report has. Only the channel and the error — never the request, which for
      // secrets:set is the key itself.
      deps.log('warn', `ipc ${channel} failed: ${errorMessage(e)}`);
      throw e;
    } finally {
      const ms = Date.now() - t0;
      if (ms >= SLOW_HANDLER_MS) deps.log('warn', `slow ipc ${channel}: ${ms}ms`);
    }
  }

  const sessionFor = (id: unknown): SessionMeta => {
    const session = sessions.get(sessionIdSchema.parse(id));
    if (!session) throw new Error('Session not found');
    return session;
  };
  /** Agent tools cannot export through the desktop chooser, and Antigravity takes direct user prompts only. */
  function guardAgentBoundary(channel: string, input: unknown): void {
    if (channel === 'app:fileSaveAs') throw new Error('User export cannot originate from an agent tool.');
    const req = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    if (channel === 'sessions:send' && typeof req.id === 'string' && sessions.get(req.id)?.config.harness === 'antigravity') {
      throw new Error('Antigravity sessions are driven by direct user prompts.');
    }
    if (channel === 'sessions:create') {
      const config = req.config && typeof req.config === 'object' ? req.config as Record<string, unknown> : {};
      if (config.harness === 'antigravity') throw new Error('Antigravity sessions are driven by direct user prompts.');
    }
  }

  handle('app:info', () => ({ version: deps.desktop.appVersion(), platform: process.platform, userData: deps.desktop.userDataPath(), isPackaged: deps.desktop.isPackaged() }));
  const idleUpdate: UpdateState = { status: 'idle' };
  handle('update:state', () => deps.updater?.get() ?? idleUpdate);
  handle('update:check', () => deps.updater?.check() ?? idleUpdate);
  handle('update:download', () => deps.updater?.download() ?? idleUpdate);
  handle('update:install', () => {
    deps.updater?.install();
  });
  handle('app:doctor', async (): Promise<DoctorReport> => {
    const harnesses = {} as Record<HarnessId, HarnessAvailability>;
    await Promise.all(HARNESSES.map(async (h) => (harnesses[h.id] = await runtime.availability(h.id))));
    const s = settings.get();
    return {
      node: process.versions.node,
      electron: deps.desktop.electronVersion(),
      platform: `${process.platform} ${process.arch}`,
      harnesses,
      providers: s.providers.map((p) => ({ id: p.id, name: p.name, hasKey: secrets.has(p.id), envKeyPresent: !!(p.envKey && process.env[p.envKey]) })),
      userData: deps.desktop.userDataPath()
    };
  });
  handle('app:openExternal', async ({ url }) => {
    if (/^https?:\/\//i.test(url)) await deps.desktop.openExternal(url);
  });
  // Only open paths scoped to the session: a compromised client must not launch arbitrary files.
  handle('app:openPath', async ({ sessionId, path: p }) => {
    const m = sessions.get(sessionId);
    if (!m) return;
    const target = path.isAbsolute(p) ? p : path.resolve(m.cwd, p);
    if (isOutsideWorkspace(m.cwd, target, path)) return;
    await deps.desktop.openPath(target);
  });
  // Reveal, never launch: a reply can name a file outside the session (a bundle in another repo),
  // and the file manager can point at it without reading or running it. Network and device paths
  // are refused before anything touches the filesystem, so a link cannot make Windows reach out to
  // a remote share.
  handle('app:showInFolder', async ({ sessionId, path: p }) => {
    if (!sessions.get(sessionId)) return { ok: false, error: 'Session not found' };
    const target = localAbsolutePath(p);
    if (!target) return { ok: false, error: 'Only local absolute paths can be shown in their folder' };
    try {
      await fs.stat(target);
    } catch {
      return { ok: false, error: `${target} was not found` };
    }
    deps.desktop.showItemInFolder(target);
    return { ok: true };
  });
  const launchEditor = async (p: string, line?: number): Promise<{ ok: boolean; error?: string }> => {
    const s = settings.get();
    const editor = s.binaries.editor?.trim() || 'code';
    const bin = which(editor);
    if (!bin) return { ok: false, error: `Editor "${editor}" not found on PATH. Set it under Settings → Binaries.` };
    try {
      const args = /code/i.test(editor) ? ['--goto', line ? `${p}:${line}` : p] : [p];
      const child = spawnTool(bin, args, { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  };
  // Editor launches are scoped to the session's project root: a compromised renderer cannot use
  // this channel as an arbitrary process launcher. Global skills use their own exact-file channel.
  handle('app:openInEditor', async ({ path: p, line, sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session) return { ok: false, error: 'Session not found' };
    const target = path.isAbsolute(p) ? p : path.resolve(session.cwd, p);
    if (isOutsideWorkspace(session.config.projectRoot || session.cwd, target, path)) return { ok: false, error: 'Path is outside the session workspace' };
    return launchEditor(target, line);
  });
  handle('skills:openInEditor', async ({ path: p, line }) => {
    const target = path.resolve(p);
    const loc = locateSkillPath(path.dirname(target));
    if (!loc || loc.kind !== 'skill' || path.basename(target) !== 'SKILL.md') return { ok: false, error: 'Path is not a known skill document' };
    return launchEditor(target, line);
  });
  handle('app:openTerminal', async ({ cwd }) => {
    try {
      if (process.platform === 'win32') {
        // cmd.exe parses the `start` command itself; keep cwd as one process argument rather
        // than interpolating it into a command string. Quotes/newlines cannot be represented
        // safely by that built-in command, so reject them at the boundary.
        if (/["%\r\n]/.test(cwd)) return { ok: false, error: 'Terminal path contains an unsupported quote, percent sign, or newline' };
        const wt = which('wt');
        const child = wt
          ? spawnTool(wt, ['-d', cwd], { detached: true, stdio: 'ignore' })
          : spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '', '/D', cwd, 'cmd.exe'], { detached: true, stdio: 'ignore', windowsHide: false });
        child.unref();
      } else if (process.platform === 'darwin') {
        const child = spawnTool('open', ['-a', 'Terminal', cwd], { detached: true, stdio: 'ignore' });
        child.unref();
      } else {
        const term = which('x-terminal-emulator') ?? which('gnome-terminal') ?? which('konsole') ?? which('xterm');
        if (!term) return { ok: false, error: 'No terminal emulator found' };
        const child = spawnTool(term, [], { cwd, detached: true, stdio: 'ignore' });
        child.unref();
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  });
  // Folders the local user picked in this run. A freshly picked folder is in neither settings.folders
  // nor any session yet, so the per-folder git probes below would refuse it; the native dialog is
  // proof enough that the user chose the path, and no remote client can reach app:pickFolder.
  const pickedFolders = new Set<string>();
  handle('app:pickFolder', async ({ defaultPath }) => {
    const res = await deps.desktop.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], defaultPath });
    const picked = res.canceled ? null : res.filePaths[0] ?? null;
    if (picked) pickedFolders.add(picked);
    return { path: picked };
  });
  handle('app:diag', ({ kind, ms, detail }) => {
    deps.log('warn', `renderer ${kind} ${ms}ms${detail ? ` (${detail})` : ''}`);
  });
  // Exceptions are invisible once the renderer window is blank; they belong in the same log as
  // everything else, clipped so one runaway stack cannot fill it.
  handle('app:rendererError', ({ message, stack, source }) => {
    const where = source ? ` at ${source}` : '';
    const trace = stack ? `\n${stack.slice(0, 4000)}` : '';
    deps.log('error', `renderer error${where}: ${message.slice(0, 2000)}${trace}`);
  });
  handle('app:notify', async ({ title, body }) => {
    if (typeof title !== 'string' || typeof body !== 'string') return;
    const s = settings.get();
    if (!s.notifications) return;
    await deps.desktop.notify(title.slice(0, 200), body.slice(0, 200));
  });

  handle('window:toggleFullScreen', () => deps.desktop.toggleFullScreen());
  handle('window:reload', () => deps.desktop.reload());
  handle('window:toggleDevTools', () => deps.desktop.toggleDevTools());
  handle('window:zoom', ({ direction }) => {
    const r = deps.desktop.zoom(direction);
    return { zoomFactor: r ?? 1 };
  });
  handle('window:edit', ({ command }) => deps.desktop.edit(command));

  // The renderer reports where the desktop is; a paired browser reads it and follows the push.
  handle('desktop:setFocus', ({ sessionId }) => deps.desktopFocus?.setSession(sessionId));
  handle('desktop:setVisible', (input) => deps.desktopFocus?.setVisible(z.strictObject({ sessionIds: z.array(z.string()).max(32) }).parse(input).sessionIds));
  handle('desktop:focus', () => deps.desktopFocus?.state() ?? { sessionId: null, at: 0, windowFocused: false });

  handle('settings:get', () => settings.get());
  handle('settings:update', async (patch) => {
    const changesHousekeep = !!patch && typeof patch === 'object' && Object.hasOwn(patch, 'housekeepRecentDays');
    if (changesHousekeep) housekeepSettingsWrites++;
    const next = await settings.update(patch).finally(() => { if (changesHousekeep) housekeepSettingsWrites--; });
    if (patch?.intelligence && next.intelligence?.gateway === false) deps.revokeMemoryGrants?.();
    // Keys only: provider entries carry custom headers, and window bounds change every drag.
    const keys = patch && typeof patch === 'object' ? Object.keys(patch).filter((k) => k !== 'windowBounds') : [];
    if (keys.length) deps.log('debug', `settings updated: ${keys.join(', ')}`);
    // `/goal` ownership follows the goal defaults, so a change there has to reach every open session.
    if (patch && typeof patch === 'object' && 'goalDefaults' in patch) await sessions.refreshGoalDrivers();
    deps.push(PUSH_CHANNELS.settingsChanged, next);
    return next;
  });

  /**
   * Takes a project folder out of the app: its sessions (and their worktrees, exactly as the
   * per-session delete does) plus every setting keyed by that root. Nothing on disk is removed —
   * the project itself stays where it is, and re-adding it starts from a clean slate.
   */
  handle('folders:remove', async ({ root }) => {
    const doomed = sessions.list().filter((s) => s.config.projectRoot === root);
    // Shells hold their cwd open; take them down before any worktree is removed.
    for (const s of doomed) await terminals.closeForSession(s.id);
    const removedSessions = await sessions.deleteMany(doomed.map((s) => s.id));
    const cur = settings.get();
    const patch: Partial<AppSettings> = {};
    const without = (key: 'folders' | 'folderOrder' | 'collapsedFolders' | 'recentProjects' | 'gitSetupSkipped') => {
      const list = cur[key];
      if (list?.includes(root)) patch[key] = list.filter((p) => p !== root);
    };
    without('folders');
    without('folderOrder');
    without('collapsedFolders');
    without('recentProjects');
    without('gitSetupSkipped');
    for (const key of ['folderStyles', 'mcpProjectState', 'folderSessionDefaults'] as const) {
      const map = cur[key];
      if (map && root in map) {
        const next = { ...map };
        delete next[root];
        (patch as Record<string, unknown>)[key] = next;
      }
    }
    if (Object.keys(patch).length) deps.push(PUSH_CHANNELS.settingsChanged, await settings.update(patch));
    deps.log('info', `folder removed from app: ${root} (${removedSessions} session${removedSessions === 1 ? '' : 's'})`);
    return { removedSessions };
  });

  // Identity material shares the store with API keys; provider ids can never name it.
  const assertProviderSecretId = (id: string) => { if (isReservedSecretId(id)) throw new Error('That id is reserved and cannot hold a provider key.'); };
  handle('secrets:set', async ({ providerId, apiKey }) => {
    assertProviderSecretId(providerId);
    await secrets.set(providerId, apiKey);
    await syncProviderKeyFlags();
    await modelCatalog().clear();
  });
  handle('secrets:clear', async ({ providerId }) => {
    assertProviderSecretId(providerId);
    await secrets.clear(providerId);
    await syncProviderKeyFlags();
    await modelCatalog().clear();
  });
  handle('secrets:has', ({ providerId }) => !isReservedSecretId(providerId) && secrets.has(providerId));
  handle('secrets:status', () => secrets.status);

  async function syncProviderKeyFlags(): Promise<AppSettings> {
    const s = settings.get();
    const providers = s.providers.map((p) => ({ ...p, hasApiKey: secrets.has(p.id) }));
    const next = await settings.update({ providers });
    deps.push(PUSH_CHANNELS.settingsChanged, next);
    return next;
  }

  handle('providers:list', () => {
    const s = settings.get();
    return s.providers.map((p) => {
      const models = enrichModelsFromProviders(p.models.length ? p.models : fallbackModels(p), s.providers);
      return { ...p, hasApiKey: secrets.has(p.id), models: applyModelOverrides(models, s.modelOverrides) };
    });
  });
  handle('providers:save', async (provider) => {
    assertProviderSecretId(provider.id);
    if (provider.baseUrl !== undefined && provider.baseUrl !== '') assertEndpointUrl(provider.baseUrl);
    const s = settings.get();
    const idx = s.providers.findIndex((p) => p.id === provider.id);
    const providers = [...s.providers];
    if (idx >= 0) providers[idx] = { ...providers[idx], ...provider, hasApiKey: secrets.has(provider.id) };
    else providers.push({ ...provider, hasApiKey: secrets.has(provider.id), builtin: false });
    const next = await settings.update({ providers });
    deps.push(PUSH_CHANNELS.settingsChanged, next);
    return next.providers;
  });
  handle('providers:delete', async ({ id }) => {
    assertProviderSecretId(id);
    const s = settings.get();
    const next = await settings.update({ providers: s.providers.filter((p) => p.id !== id || p.builtin) });
    await secrets.clear(id);
    deps.push(PUSH_CHANNELS.settingsChanged, next);
    return next.providers;
  });
  handle('providers:refreshModels', async ({ id }) => {
    const s = settings.get();
    const p = s.providers.find((x) => x.id === id);
    if (!p) return { models: [], error: 'Unknown provider' };
    try {
      assertProviderEndpoint(p);
      const key = await resolveProviderApiKey(p, (pid) => secrets.get(pid));
      const models = await fetchProviderModels(p, key);
      const providers = s.providers.map((x) => (x.id === id ? { ...x, models, modelsUpdatedAt: Date.now() } : x));
      const next = await settings.update({ providers });
      deps.push(PUSH_CHANNELS.settingsChanged, next);
      return { models: applyModelOverrides(enrichModelsFromProviders(models, next.providers), next.modelOverrides) };
    } catch (e) {
      deps.log('warn', `model list refresh failed for ${id}: ${errorMessage(e)}`);
      const models = enrichModelsFromProviders(fallbackModels(p), s.providers);
      return { models: applyModelOverrides(models, s.modelOverrides), error: errorMessage(e) };
    }
  });
  handle('providers:test', async ({ id }) => {
    const p = settings.get().providers.find((x) => x.id === id);
    if (!p) return { ok: false, detail: 'Unknown provider' };
    try { assertProviderEndpoint(p); } catch (e) { return { ok: false, detail: errorMessage(e) }; }
    const key = await resolveProviderApiKey(p, (pid) => secrets.get(pid));
    if (!key && !['ollama', 'lmstudio'].includes(p.kind)) return { ok: false, detail: `No API key stored and ${p.envKey ?? 'no env var'} is not set.` };
    return testProvider(p, key);
  });
  handle('models:setOverride', async ({ provider, model, supportsImages }) => {
    const s = settings.get();
    const key = modelOverrideKey(provider, model);
    const modelOverrides = { ...s.modelOverrides };
    if (supportsImages === null) delete modelOverrides[key];
    else modelOverrides[key] = { ...modelOverrides[key], supportsImages };
    const next = await settings.update({ modelOverrides });
    deps.push(PUSH_CHANNELS.settingsChanged, next);
    // Running sessions already have a model list; re-publish it so the change lands without a restart.
    sessions.republishModels();
    return next.modelOverrides;
  });

  handle('dictation:transcribe', ({ audio }) => dictation().transcribe(audio));
  handle('dictation:cloudModels', ({ provider }) => dictation().cloudModels(String(provider ?? '')));
  handle('dictation:status', () => dictation().status());
  handle('dictation:install', () => dictation().install());
  handle('dictation:cancelInstall', () => dictation().cancelInstall());
  handle('dictation:removeModel', ({ model }) => {
    const known = localModel(model);
    if (!known) throw new Error(`Unknown dictation model ${String(model)}`);
    return dictation().removeModel(known.id);
  });
  handle('dictation:stopLocal', () => dictation().stopLocal());

  handle('harness:setup', async ({ harness }) => {
    assertHarnessId(harness);
    invalidateAvailability();
    return readHarnessSetup(runtime, settings.get(), harness);
  });
  handle('harness:login', async (input) => {
    const { harness, device } = z.strictObject({ harness: z.enum(['claude', 'codex', 'pi', 'antigravity']), device: z.boolean().optional() }).parse(input);
    const result = await openHarnessLogin(runtime, harness, device);
    invalidateAvailability();
    await modelCatalog().clear(harness);
    return result;
  });
  let codexQuotaRead: Promise<SubscriptionLimits> | undefined;
  handle('subscriptions:read', (input) => {
    const parsed = z.strictObject({ provider: z.enum(INLINE_SUBSCRIPTION_PROVIDERS) }).safeParse(input);
    if (!parsed.success) throw new Error('Unsupported subscription quota read.');
    // One process per account check, even if the user closes and reopens the panel mid-read.
    return codexQuotaRead ??= readCodexSubscriptionQuota(runtime).finally(() => { codexQuotaRead = undefined; });
  });
  handle('subscriptions:openUsage', async (input) => {
    const parsed = z.strictObject({ provider: z.enum(SUBSCRIPTION_PROVIDERS) }).safeParse(input);
    if (!parsed.success) throw new Error('Unsupported subscription usage action.');
    const { provider } = parsed.data;
    if (provider === 'antigravity') {
      const result = await openAntigravityUsage(runtime);
      if (!result.ok) throw new Error(result.error ?? 'Could not open the Antigravity CLI.');
      return { kind: 'terminal' };
    }
    await deps.desktop.openExternal({
      codex: 'https://chatgpt.com/codex/settings/usage',
      claude: 'https://claude.ai/settings/usage',
      cursor: 'https://cursor.com/dashboard/usage'
    }[provider]);
    return { kind: 'browser' };
  });
  handle('harness:availability', async (req) => {
    if (req?.id !== undefined) assertHarnessId(req.id);
    if (req?.refresh) invalidateAvailability();
    const generation = availabilityGeneration;
    const ids: HarnessId[] = req?.id ? [req.id] : HARNESSES.map((h) => h.id);
    const out: Partial<Record<HarnessId, HarnessAvailability>> = {};
    await Promise.all(
      ids.map(async (id) => {
        const cached = availabilityCache.get(id);
        if (cached && Date.now() - cached.at < 60_000 && !(req && 'id' in req && req.id)) {
          out[id] = cached.value;
          return;
        }
        const value = withAppCredentials(id, await runtime.availability(id), settings.get());
        if (generation === availabilityGeneration) availabilityCache.set(id, { at: Date.now(), value });
        deps.analytics.noteHarnessVersion(id, value.version);
        deps.log('debug', `harness ${id}: ${value.available ? 'available' : 'unavailable'}${value.version ? ` ${value.version}` : ''}${value.binaryPath ? ` at ${value.binaryPath}` : ''}${value.detail ? ` — ${value.detail}` : ''}`);
        out[id] = value;
      })
    );
    return out;
  });
  handle('harness:models', async ({ harness, refresh }) => {
    assertHarnessId(harness);
    const current = settings.get();
    // Discovery spawns the CLI or calls the vendor, so a clean catalog is reused for a week unless
    // the user asks for a recheck. The fingerprint is what discovery reads besides keys (a key
    // change clears the cache): a new endpoint, override or binary misses instead of going stale.
    const binary = HARNESS_BINARY[harness];
    const fingerprint = JSON.stringify([harness, current.modelOverrides, current.providers, current.binaries, current.claude, binary ? runtime.resolve(binary)?.path ?? null : null]);
    const result = await modelCatalog().get(
      harness,
      fingerprint,
      () => listHarnessModels({ harness, settings: current, runtime, getApiKey: providerSecrets((id) => secrets.get(id)) }),
      { refresh: refresh === true }
    );
    return { ...result, models: enrichModelsFromProviders(result.models, current.providers) };
  });
  handle('harness:install', async ({ id }) => {
    if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(HARNESS_PACKAGES, id)) throw new Error('Unsupported harness installer');
    deps.log('info', `installing ${id} into the app runtime directory`);
    const r = await runtime.install(id);
    invalidateAvailability();
    // A new runtime can list models the old one did not.
    await modelCatalog().clear();
    // npm's output is the renderer's to show in full; the log keeps the verdict and the tail of a failure.
    if (r.ok) deps.log('info', `installed ${id}`);
    else deps.log('warn', `install of ${id} failed: ${r.log.trim().split('\n').slice(-5).join(' | ').slice(0, 600)}`);
    return r;
  });
  handle('harness:checkUpdates', async (req) => {
    const ids: HarnessId[] = req && 'ids' in req && req.ids?.length ? req.ids : ['claude', 'codex', 'pi', 'acp'];
    const updates = await runtime.checkUpdates(ids);
    for (const [id, u] of Object.entries(updates)) {
      deps.log(
        'debug',
        `harness ${id}: ${u.current ?? 'unknown'} installed, ${u.latest ?? u.error ?? 'unknown'} published${u.newer ? ' (update available)' : ''}${u.reason ? ` — ${u.reason}` : ''}`
      );
    }
    return updates;
  });

  handle('skills:list', () => listSkills());
  handle('skills:read', ({ path: p }) => readSkillDoc(p));
  // Only paths main itself listed (a skills root or one of its skill folders) may be revealed.
  handle('skills:reveal', async ({ path: p }) => {
    if (locateSkillPath(p)) await deps.desktop.openPath(path.resolve(p));
  });
  handle('skills:create', (req) => createSkill(req));
  handle('skills:copy', (req) => copySkill(req));
  handle('skills:delete', ({ path: p }) => deleteSkill(p));

  // Base-pi global config. Resource toggles and prompt writes are validated inside PiConfigStore
  // (path containment, type/name allowlists), so a tampered renderer cannot touch other files.
  handle('instructions:read', () => appInstructions().read());
  handle('instructions:write', ({ scope, content }) => appInstructions().write(scope, content));
  handle('pi:setup', () => piConfig.read());
  handle('pi:preferences', (patch) => piConfig.updatePreferences(patch));
  handle('pi:resource', ({ type, path: p, enabled }) => piConfig.setResourceEnabled(type, p, enabled));
  handle('pi:prompt:write', ({ name, content }) => piConfig.writePrompt(name, content));
  handle('pi:package:install', ({ source }) => piConfig.installPackage(source));
  handle('pi:package:remove', ({ source }) => piConfig.removePackage(source));
  handle('pi:package:update', ({ source }) => piConfig.updatePackages(source));
  handle('pi:package:resource', ({ source, type, path: p, enabled }) => piConfig.setPackageResourceEnabled(source, type, p, enabled));
  handle('pi:subagents', (patch) => piConfig.updateSubagents(patch));
  handle('pi:openInEditor', async ({ path: p, line }) => {
    const target = piConfig.resolveAgentPath(p);
    if (!target) return { ok: false, error: 'Path is outside the pi agent dir' };
    return launchEditor(target, line);
  });
  handle('pi:reveal', async ({ path: p }) => {
    const target = p ? piConfig.resolveAgentPath(p) : piConfig.paths().agentDir;
    if (target) await deps.desktop.openPath(target);
  });

  // MCP. Every definition coming back from the renderer goes through normalizeMcpServers first,
  // so a malformed (or hostile) entry can never reach a harness or a file on disk.
  const mcpScope = (sessionId: string) => {
    const m = sessions.get(sessionId);
    if (!m) throw new Error('Session not found');
    return { settings: settings.get(), cwd: m.cwd, projectRoot: m.config.projectRoot, harness: m.config.harness, readOnly: m.config.permissionMode === 'plan' };
  };
  handle('mcp:stores', () => globalStoreInfo());
  handle('mcp:project', ({ sessionId }) => projectInfo(mcpScope(sessionId)));
  handle('mcp:project:save', async ({ sessionId, servers }) => {
    const scope = mcpScope(sessionId);
    const next = normalizeMcpServers(servers);
    const refused = mcpServersSaveError(next, (await readProjectMcp(scope.cwd)).servers);
    if (refused) return { ok: false, error: refused };
    const r = await writeProjectMcp(scope.cwd, next);
    if (!r.ok) deps.log('warn', `[${sessionId}] could not write ${r.file}: ${r.error ?? 'unknown error'}`);
    return { ok: r.ok, error: r.error };
  });
  handle('mcp:project:state', async ({ sessionId, patch }) => {
    const scope = mcpScope(sessionId);
    const next = normalizeMcpProjectState({ ...(settings.get().mcpProjectState ?? {}), [scope.projectRoot]: patch });
    await settings.update({ mcpProjectState: next });
    return projectInfo({ ...scope, settings: settings.get() });
  });
  handle('mcp:project:index', async ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session) return { ok: false, error: 'Session not found' };
    if (!deps.gitnexusIndexer) return { ok: false, error: 'GitNexus indexing is unavailable in this run.' };
    return deps.gitnexusIndexer.index({ cwd: session.config.projectRoot || session.cwd, projectRoot: session.config.projectRoot, reason: 'manual' });
  });
  handle('mcp:inspect', async ({ def, sessionId }) => {
    const [checked] = normalizeMcpServers([def]);
    if (!checked) return { ok: false, error: 'Incomplete server definition', tools: [], durationMs: 0 };
    const resolved = await resolveVars(checked, { env: process.env, secret: (name) => secrets.get(secretKeyFor(name)) });
    const cwd = sessionId ? sessions.get(sessionId)?.cwd : undefined;
    const result = await inspectServer(normalizeStdio(resolved.def, { which: (cmd) => which(cmd) }), { cwd });
    if (result.ok) deps.log('debug', `mcp ${checked.id}: inspected in ${result.durationMs}ms, ${result.tools.length} tool(s)`);
    else deps.log('warn', `mcp ${checked.id}: inspect failed after ${result.durationMs}ms: ${result.error ?? 'unknown error'}`);
    return result;
  });
  handle('mcp:import', async ({ servers, to, sessionId }) => {
    const incoming = normalizeMcpServers(servers);
    // Sentence punctuation also avoids electron-vite's ESM shim mistaking this literal for an import.
    if (!incoming.length) return { ok: false, error: 'No MCP servers to import.' };
    if (to === 'global') {
      const current = settings.get().mcpServers ?? [];
      const merged = mergeById(current, incoming);
      const refused = mcpServersSaveError(merged, current);
      if (refused) return { ok: false, error: refused };
      await settings.update({ mcpServers: merged });
      return { ok: true };
    }
    if (!sessionId) return { ok: false, error: 'No session' };
    const scope = mcpScope(sessionId);
    const current = await readProjectMcp(scope.cwd);
    if (current.error) return { ok: false, error: current.error };
    const merged = mergeById(current.servers, incoming);
    const refused = mcpServersSaveError(merged, current.servers);
    if (refused) return { ok: false, error: refused };
    const r = await writeProjectMcp(scope.cwd, merged);
    return { ok: r.ok, error: r.error };
  });
  handle('mcp:export', async ({ sessionId }) => {
    const scope = mcpScope(sessionId);
    const current = await readProjectMcp(scope.cwd);
    if (current.error) return { ok: false, error: current.error };
    const target = path.join(scope.cwd, '.cursor', 'mcp.json');
    const existing = await readStore({ id: 'cursor', label: 'Cursor', path: target, format: 'json' });
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify({ mcpServers: toMcpJsonTable(mergeById(existing.servers, current.servers)) }, null, 2) + '\n', 'utf8');
      return { ok: true, path: target };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  });

  // Computer use. The renderer only ever reads status and screenshots; the mode and opt-in live in
  // settings, and the driver's own authorization is fixed when its runtime starts.
  const cuaPreview = new CuaPreviewSession();
  handle('cua:status', () => cuaStatus(settings.get()));
  handle('cua:preview', () => cuaPreview.capture(settings.get()));

  // The Processes panel. Ending is validated by the tracker against a fresh sample, so a stale row
  // or a reused PID can never end a process the app did not start.
  handle('processes:list', () => deps.processes?.list() ?? { sampledAt: Date.now(), processes: [], error: 'Process tracking is not running.' });
  handle('processes:end', ({ targets }) => {
    if (!deps.processes) return { ended: 0, failed: [] };
    const valid = (Array.isArray(targets) ? targets : []).filter((t) => Number.isInteger(t?.pid) && t.pid > 0 && Number.isFinite(t?.startedAt));
    return deps.processes.end(valid);
  });
  // The built-in's "Test connection": a real MCP handshake against `cua-driver mcp`, the same
  // thing the user-server rows offer, so an install that lies about its tools is visible.
  handle('cua:test', async () => {
    const current = settings.get();
    const def = cuaBaseDef(current);
    if (def.disabled) return { ok: false, error: cuaDefState(current).note, tools: [], durationMs: 0 };
    const resolved = await resolveVars(def, { env: process.env, secret: (name) => secrets.get(secretKeyFor(name)) });
    const result = await inspectServer(normalizeStdio(resolved.def, { which: (cmd) => which(cmd) }), {});
    if (result.ok) deps.log('debug', `cua: ${result.tools.length} tool(s) in ${result.durationMs}ms`);
    else deps.log('warn', `cua: test failed: ${result.error ?? 'unknown error'}`);
    return result;
  });
  // Installs the driver on the user's behalf, but only after the renderer has confirmed (the UI
  // shows the exact command). Nothing here decides on its own to run a remote script.
  handle('cua:install', async () => {
    const command = cuaInstallCommand();
    if (!command) return { ok: false, command: '', error: 'No Cua Driver installer for this platform.' };
    deps.log('info', `cua: running the official installer: ${command.display}`);
    const result = await runCapture(command.file, command.args, { timeoutMs: 300_000 });
    const output = `${result.stdout}\n${result.stderr}`.trim().slice(-4_000);
    // The PATH/install-dir memo and the version cache must not keep reporting the pre-install state.
    clearWhichCache();
    clearCuaVersionCache();
    const ok = result.code === 0;
    if (!ok) deps.log('warn', `cua: installer exited ${result.code ?? 'null'}${result.timedOut ? ' (timed out)' : ''}`);
    return { ok, command: command.display, ...(output ? { output } : {}), ...(ok ? {} : { error: result.timedOut ? 'The installer timed out.' : 'The installer exited with an error; see its output.' }) };
  });

  const scheduleGitnexus = (session: SessionMeta, reason: GitnexusIndexReason): void => {
    deps.gitnexusIndexer?.schedule({ cwd: session.cwd, projectRoot: session.config.projectRoot, reason });
  };

  handle('sessions:list', () => sessions.list());
  const importSourceSchema = z.strictObject({ source: z.enum(['claude', 'codex']) });
  handle('sessions:importList', async (req) => {
    const { source } = importSourceSchema.parse(req);
    const scan = await discoverChatImports(source);
    const existingSessions = sessions.list();
    const folders = deps.settings.get().folders;
    return {
      candidates: scan.sessions.map(({ candidate }) => {
        const existing = existingSessions.find((session) => representsChatImport(session, candidate));
        const root = existing?.config?.projectRoot;
        return {
          ...candidate,
          imported: !!existing,
          // A saved chat is not proof that the separate settings write completed.
          // Use its stored root: an external history may since have moved projects.
          ...(root && !folders.includes(root) ? { registrationPending: true, projectRoot: root } : {})
        };
      }),
      skipped: scan.skippedFiles,
      skippedReasons: scan.skippedReasons,
      scanErrors: scan.scanErrors,
      malformedLines: scan.malformedLines,
      truncated: scan.truncated
    };
  });
  handle('sessions:import', async (req) => {
    const { source, ids, repairOnly } = importSourceSchema.extend({ ids: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).min(1).max(200), repairOnly: z.boolean().optional() }).parse(req);
    const scan = await discoverChatImports(source);
    const wanted = new Set(ids);
    const selected = scan.sessions.filter(({ candidate }) => wanted.has(candidate.id));
    if (selected.length !== wanted.size) throw new Error('Some conversations are no longer available. Scan again before importing.');
    try {
      return await (repairOnly ? sessions.importChats(selected, { repairOnly: true }) : sessions.importChats(selected));
    } finally {
      // Committed imports (including a partial batch) register projects outside settings:update.
      deps.push(PUSH_CHANNELS.settingsChanged, settings.get());
    }
  });
  handle('sessions:create', async (req) => {
    const session = await sessions.create(req);
    scheduleGitnexus(session, 'session-start');
    return session;
  });
  handle('sessions:get', ({ id }) => sessions.get(id) ?? null);
  handle('sessions:transcript', ({ id }) => sessions.transcript(id));
  handle('sessions:transcriptPage', async (req) => {
    const { items, seq } = await sessions.transcriptSnapshot(req.id);
    return { ...transcriptPage(items, req), seq };
  });
  handle('subagents:list', ({ id }) => sessions.subagentRuns(id));
  handle('subagents:get', ({ id, runId }) => sessions.subagentRun(id, runId));
  handle('subagents:stop', ({ id, runId }) => sessions.subagentCommand(id, runId, 'stop'));
  handle('subagents:steer', ({ id, runId, message }) => sessions.subagentCommand(id, runId, 'steer', message));
  // Project subagent definitions. The project root is the session's (its main checkout), and the
  // templates come from the bundled pi resources, so both live with everything else pi loads.
  const projectRootOf = (id: string): string | null => sessions.get(id)?.config.projectRoot ?? null;
  const templateDir = (): string | undefined => {
    try {
      return path.join(runtime.resource('pi', 'agents'));
    } catch {
      return undefined;
    }
  };
  handle('agents:list', async ({ id }) => {
    const root = projectRootOf(id);
    if (!root) return { agents: [], templates: [], git: false, ignored: false };
    return listProjectAgents(root, templateDir());
  });
  handle('agents:get', async ({ id, name }) => {
    const root = projectRootOf(id);
    return root ? readProjectAgent(root, name) : null;
  });
  handle('agents:save', async ({ id, fields, prompt }) => {
    const root = projectRootOf(id);
    if (!root) return { ok: false, error: 'Session not found' };
    return saveProjectAgent(root, fields, prompt);
  });
  handle('agents:delete', async ({ id, name }) => {
    const root = projectRootOf(id);
    if (!root) return { ok: false, error: 'Session not found' };
    return deleteProjectAgent(root, name);
  });
  handle('agents:track', async ({ id, name, tracked }) => {
    const root = projectRootOf(id);
    if (!root) return { ok: false, error: 'Session not found' };
    return setProjectAgentTracked(root, name, tracked);
  });
  // Claude Code's own agent definitions. Same project root, different format and different rules:
  // a definition replaces the built-in it is named after, so the app only ever edits an existing one.
  const claudeSessionModel = (id: string): string | null => {
    const meta = sessions.get(id);
    return meta?.config.model?.model ?? meta?.activeModel?.model ?? null;
  };
  handle('claude-agents:list', async ({ id }) => {
    const root = projectRootOf(id);
    const files = root ? await listClaudeAgents(root) : [];
    return {
      types: await sessions.subagentTypes(id),
      files,
      sessionModel: claudeSessionModel(id),
      forced: !files.some((file) => isPinnedModel(file.model))
    };
  });
  handle('claude-agents:setModel', async ({ id, name, model }) => {
    const root = projectRootOf(id);
    if (!root) return { ok: false, error: 'Session not found' };
    return setClaudeAgentModel(root, name, model ?? undefined);
  });
  handle('claude-agents:create', async ({ id, name, description, prompt, model, override }) => {
    const root = projectRootOf(id);
    if (!root) return { ok: false, error: 'Session not found' };
    // The engine names its own types while it is live; the module covers the built-ins it cannot.
    return createClaudeAgent(root, { name, description, prompt, model: model ?? undefined }, (await sessions.subagentTypes(id)).map((type) => type.name), { override });
  });
  handle('sessions:search', (req) => deps.search.search(req));
  handle('sessions:delete', async ({ id, removeWorktree }) => {
    // Shells hold their cwd open; take them down before the worktree is removed.
    const t0 = Date.now();
    await terminals.closeForSession(id);
    const t1 = Date.now();
    await sessions.delete(id, removeWorktree);
    if (Date.now() - t0 >= SLOW_HANDLER_MS) deps.log('warn', `slow delete ${id}: terminals ${t1 - t0}ms, session ${Date.now() - t1}ms`);
  });
  handle('sessions:rename', ({ id, title }) => sessions.patch(id, { title }));
  handle('sessions:label', ({ id, label }) => sessions.patch(id, { statusLabel: label?.trim() || undefined }));
  handle('sessions:archive', async ({ id, archived, removeWorktree, forceWorktree }) => {
    z.boolean().parse(archived);
    sessionFor(id);
    // Archiving parks the session, so its shells go with it — and a shell holding the worktree's
    // directory open (Windows) must be gone before the worktree is removed.
    if (archived) await terminals.closeForSession(id);
    return sessions.setArchived(id, archived, removeWorktree, forceWorktree);
  });
  const housekeepIds = z.array(sessionIdSchema).max(4096);
  const housekeepPreviewId = z.string().uuid();
  let scanningHousekeepInventory: ReturnType<typeof scanHousekeepInventory> | undefined;
  handle('housekeep:inventory', input => {
    z.undefined().parse(input); // Only the current profile supplies the scope, never the renderer.
    return scanningHousekeepInventory ??= scanHousekeepInventory(settings.get().folders, sessions.list({ refreshGit: false }))
      .finally(() => { scanningHousekeepInventory = undefined; });
  });
  handle('housekeep:preview', input => {
    const { protectedIds, recentDaysOverride } = z.strictObject({
      protectedIds: housekeepIds,
      recentDaysOverride: z.number().int().min(0).max(MAX_HOUSEKEEP_RECENT_DAYS).optional()
    }).parse(input);
    return housekeep.preview(protectedIds, recentDaysOverride);
  });
  handle('housekeep:assess', input => {
    const { previewId } = z.strictObject({ previewId: housekeepPreviewId }).parse(input);
    return housekeep.assess(previewId);
  });
  handle('housekeep:apply', input => {
    const { previewId, ids, protectedIds } = z.strictObject({ previewId: housekeepPreviewId, ids: housekeepIds.min(1), protectedIds: housekeepIds }).parse(input);
    return housekeep.apply(previewId, ids, protectedIds);
  });
  handle('sessions:pin', ({ id, pinned }) => sessions.setPinned(id, pinned));
  handle('sessions:pinOrder', ({ ids }) => sessions.setPinOrder(ids));
  handle('sessions:markViewed', (input) => sessions.markViewed(sessionIdSchema.parse(z.strictObject({ id: z.string() }).parse(input).id)));
  handle('sessions:send', async ({ id, input }) => {
    sessionFor(id);
    await sessions.send(id, input);
  });
  handle('sessions:editAndResend', ({ id, userItemId, input }) => sessions.editAndResend(id, userItemId, input));
  handle('sessions:interrupt', ({ id }) => sessions.interrupt(id));
  handle('sessions:stop', ({ id }) => sessions.stop(id));
  handle('sessions:setModel', ({ id, model }) => sessions.setModel(id, model));
  handle('sessions:setEffort', ({ id, effort }) => sessions.setEffort(id, effort));
  handle('sessions:setFastMode', (input) => {
    const { id, enabled } = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]+$/), enabled: z.boolean() }).parse(input);
    sessionFor(id);
    return sessions.setFastMode(id, enabled);
  });
  handle('sessions:setPermissionMode', ({ id, mode }) => sessions.setPermissionMode(id, mode));
  handle('sessions:compact', ({ id }) => sessions.compact(id));
  handle('sessions:clearTranscript', ({ id }) => sessions.clearTranscript(id));
  handle('app:fileSaveAs', async (input) => {
    const { content, suggestedName } = z.strictObject({
      content: z.string().max(TEXT_EXPORT_MAX_BYTES).refine((text) => Buffer.byteLength(text, 'utf8') <= TEXT_EXPORT_MAX_BYTES, 'Text export exceeds the 1 MiB limit.'),
      suggestedName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.md$/, 'Choose a Markdown filename, not a path.')
    }).parse(input);
    const res = await deps.desktop.showSaveDialog({ defaultPath: path.join(deps.desktop.documentsPath(), suggestedName), filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (res.canceled || !res.filePath) return { path: null };
    if (!path.isAbsolute(res.filePath)) throw new Error('Save As did not return an absolute destination.');
    await fs.writeFile(res.filePath, content, 'utf8');
    return { path: res.filePath };
  });
  handle('sessions:export', async ({ id }) => {
    const md = await sessions.exportMarkdown(id);
    const meta = sessions.get(id);
    const res = await deps.desktop.showSaveDialog({
      defaultPath: path.join(deps.desktop.documentsPath(), `${(meta?.title ?? 'session').replace(/[^\w.-]+/g, '_')}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (res.canceled || !res.filePath) return { path: null };
    await fs.writeFile(res.filePath, md, 'utf8');
    deps.log('info', `[${id}] transcript exported to ${res.filePath}`);
    return { path: res.filePath };
  });
  handle('sessions:fork', async ({ id, harness }) => {
    const session = await sessions.fork(id, harness);
    if (session) scheduleGitnexus(session, 'session-start');
    return session;
  });
  handle('sessions:moveTo', ({ id, cwd }) => sessions.moveTo(id, cwd));
  handle('sessions:goal', ({ id, action, objective, autoContinue, maxIterations }) => sessions.goal(id, action, { objective, autoContinue, maxIterations }));

  handle('approvals:respond', ({ sessionId, requestId, decision }) => sessions.respondApproval(sessionId, requestId, decision));

  // Vesta reaches the app through this same registry, but only via the capability allowlist in
  // shared/agent-manifest.ts — the registry itself serves keychain writes and raw PTY input.
  const vesta = new Vesta({
    getSettings: () => settings.get(),
    listSessions: () => sessions.list(),
    getSession: (id) => sessions.get(id),
    getSecret: providerSecrets((providerId) => secrets.get(providerId)),
    invoke: (channel, req) => invokeChannel(channel, req, 'agent'),
    push: (state) => deps.push(PUSH_CHANNELS.agentState, state),
    log: deps.log,
    // Vesta runs on pi (docs/VESTA.md); it is absent until pi is installed, which the panel says.
    piBinary: () => runtime.resolve('pi')?.path ?? null,
    piExtension: () => runtime.resource('pi', 'vocs-code-vesta.ts'),
    piCwd: () => homedir()
  });
  handle('agent:state', () => vesta.state());
  // A turn streams over push:agentState, so the invoke returns as soon as it is accepted.
  handle('agent:send', ({ text, context, images }) => {
    void vesta.send(String(text ?? ''), context, normalizeAgentImages(images)).catch((e: unknown) => deps.log('warn', `vesta send failed: ${errorMessage(e)}`));
  });
  handle('agent:cancel', () => vesta.cancel());
  handle('agent:resolve', ({ proposalId, approve }) => vesta.resolveProposal(String(proposalId ?? ''), approve === true));
  handle('agent:reset', () => vesta.reset());

  // Remote access (docs/REMOTE-ACCESS.md). The enrollment and device tokens live in the
  // secret store, never in settings; enable() stores them and opens the relay socket.
  if (deps.remote) {
    const remote = deps.remote;
    // Older builds stored a typed-in relay URL here; the relay is fixed now, so drop it.
    const remoteConfig = (): RemoteConfig => {
      const { relayUrl: _legacy, ...config } = (settings.get().remote ?? { enabled: false }) as RemoteConfig & { relayUrl?: unknown };
      return config;
    };
    handle('remote:get', async () => ({
      config: remoteConfig(),
      state: remote.state(),
      devices: settings.get().remote?.enabled ? await remote.listDevices() : [],
      audit: remote.auditEntries(),
      relayUrl: relayUrl(),
      registered: await remote.isRegistered(),
      signInAvailable: signInAvailable(relayUrl())
    }));
    handle('remote:signIn', async () => {
      const relay = relayUrl();
      await settings.update({ remote: { ...remoteConfig(), enabled: true } });
      // The page opens in the default browser; openExternal only ever opens http(s) URLs.
      await remote.signIn(relay, (url) => deps.desktop.openExternal(url));
      deps.push(PUSH_CHANNELS.settingsChanged, settings.get());
      return remote.state();
    });
    handle('remote:enable', async ({ enrollToken }) => {
      const relay = relayUrl();
      // The secret registers this computer once; after that it connects with its own credential,
      // so an empty field reuses whatever secret is stored (possibly none).
      const secret = typeof enrollToken === 'string' ? enrollToken.trim() : '';
      if (secret) await secrets.set('remote-enroll', secret);
      // Keep the view-only policy across a reconnect; enable() only replaces relay fields.
      await settings.update({ remote: { ...remoteConfig(), enabled: true } });
      await remote.enable(relay, secret || ((await secrets.get('remote-enroll')) ?? ''));
      // The renderer's copy of settings drives the toggle/Disconnect UI, so push it like settings:update.
      deps.push(PUSH_CHANNELS.settingsChanged, settings.get());
      return remote.state();
    });
    handle('remote:disable', async () => {
      await settings.update({ remote: { ...remoteConfig(), enabled: false } });
      await remote.disable();
      deps.push(PUSH_CHANNELS.settingsChanged, settings.get());
      return remote.state();
    });
    handle('remote:pairStart', ({ hostName }) => remote.startPairing(hostName || 'This computer'));
    handle('remote:pairRespond', async ({ decision }) => {
      await remote.respondPairing(decision);
      return undefined;
    });
    handle('remote:revoke', async ({ deviceId }) => {
      await remote.revokeDevice(deviceId);
      return undefined;
    });
    handle('remote:revokeAll', async () => {
      await remote.revokeAll();
      return remote.state();
    });
    handle('remote:setViewOnly', async ({ viewOnly }) => {
      await settings.update({ remote: { ...remoteConfig(), viewOnly: viewOnly === true } });
      deps.push(PUSH_CHANNELS.settingsChanged, settings.get());
      // Live policy change: refresh the desktop state and tell paired browsers to hide write controls.
      void remote.broadcastPolicy();
      return remote.state();
    });
    handle('remote:setMirror', ({ mirror }) => {
      remote.auditMirror(mirror === true);
      void (async () => {
        await settings.update({ remote: { ...remoteConfig(), mirror: mirror === true } });
        deps.push(PUSH_CHANNELS.settingsChanged, settings.get());
        if (mirror === true) deps.remoteMirror?.sync();
        else await deps.remoteMirror?.disable();
      })();
      return remote.state();
    });
    handle('remote:setShareAnalytics', async ({ share }) => {
      await settings.update({ remote: { ...remoteConfig(), shareAnalytics: share === true } });
      deps.push(PUSH_CHANNELS.settingsChanged, settings.get());
      // Off deletes the relay copy now; a clear that cannot reach the relay is retried.
      void deps.analyticsSync?.sharingChanged();
      return remote.state();
    });
    handle('remote:clearAudit', () => {
      remote.clearAudit();
      return undefined;
    });
  }

  // `days: 0` is all time; only an absent request falls back to the 30-day default.
  handle('analytics:summary', (req) => deps.analytics.summary(req && typeof req === 'object' && typeof req.days === 'number' ? Math.max(0, req.days) : 30));
  handle('analytics:executions', (req) => {
    const q = req && typeof req === 'object' ? req : {};
    const ids = Array.isArray(q.ids) ? q.ids.filter((x): x is string => typeof x === 'string').slice(0, 200) : undefined;
    return deps.analytics.queryExecutions({
      ids,
      signature: typeof q.signature === 'string' ? q.signature : undefined,
      sessionId: typeof q.sessionId === 'string' ? q.sessionId : undefined,
      days: typeof q.days === 'number' ? Math.max(0, q.days) : undefined,
      limit: typeof q.limit === 'number' ? Math.min(200, Math.max(1, Math.floor(q.limit))) : 50
    });
  });

  const cwdOf = (sessionId: string) => {
    const m = sessions.get(sessionId);
    if (!m) throw new Error('Session not found');
    return m.cwd;
  };
  // Neither probe takes a session id, so both gate on a folder the app already knows about (or one
  // the local user just picked): a paired browser must not be able to walk the host's disk.
  const knownFolder = (projectRoot: string) =>
    pickedFolders.has(projectRoot) || settings.get().folders.includes(projectRoot) || sessions.list().some((s) => s.config.projectRoot === projectRoot);
  handle('git:folderBranch', ({ projectRoot }) => (knownFolder(projectRoot) ? gitFolderBranch(projectRoot) : {}));
  // The new-session dialog disables worktree isolation for a folder that has no repository, because
  // `git worktree add` there fails the whole session creation.
  handle('git:folderIsRepo', async ({ projectRoot }) => ({ isRepo: knownFolder(projectRoot) ? !!(await gitRoot(projectRoot)) : false }));
  handle('git:suggestBranchName', ({ prompt, model }) => sessions.suggestBranchName(typeof prompt === 'string' ? prompt : '', model));
  // What a new worktree branch may start from, chosen in the same dialog.
  handle('git:folderBranches', async ({ projectRoot }) => {
    if (!knownFolder(projectRoot) || !(await gitRoot(projectRoot))) return { branches: [] };
    const { current, branches } = await gitBranches(projectRoot);
    return { ...(current ? { current } : {}), branches: branches.map((b) => b.name) };
  });
  handle('git:summary', ({ sessionId }) => gitSummary(cwdOf(sessionId)));
  handle('git:diff', ({ sessionId, path: p, staged }) => gitDiff(cwdOf(sessionId), p, staged));
  handle('git:revert', ({ sessionId, path: p }) => gitRevertFile(cwdOf(sessionId), p));
  handle('git:stageAll', ({ sessionId }) => gitStageAll(cwdOf(sessionId)));
  handle('git:commit', async ({ sessionId, message }) => {
    const r = await gitCommit(cwdOf(sessionId), message);
    if (r.ok) {
      deps.knowledge?.recordEpisode(knowledgeScopeOf(sessionId), { kind: 'commit', sessionId, summary: message.trim().split('\n')[0].slice(0, 200), detail: r.output.slice(-600), at: new Date().toISOString() });
      const session = sessions.get(sessionId);
      if (session) scheduleGitnexus(session, 'commit');
    }
    return r;
  });
  // Local /pr and /merge run outside a turn, so nothing else triggers the sidebar's PR state check.
  // The outcome is recorded as a persistent transcript note so it survives a restart (local-only
  // info lines from the renderer do not). PRs opened from another session's agent branch must
  // not be attributed to this one; transcript PR references, the other sessions' branch names
  // and the activity window keep the fallback honest.
  const prQueryOf = async (sessionId: string): Promise<SessionPrQuery> => {
    const m = sessions.get(sessionId);
    if (!m) return {};
    return {
      prRefs: await sessions.sessionPrRefs(sessionId),
      branches: m.worktreeBranch ? [m.worktreeBranch] : [],
      excludeBranches: sessions.list().filter((s) => s.id !== sessionId && s.worktreeBranch).map((s) => s.worktreeBranch!),
      extraRoots: await sessions.knownRepoRoots(sessionId),
      createdAfter: m.createdAt,
      updatedBefore: m.updatedAt
    };
  };
  handle('git:pr', async ({ sessionId, base, head }) => {
    const r = await gitCreatePr(cwdOf(sessionId), base, head);
    sessions.note(sessionId, r.ok ? `PR opened${head ? ` for ${head}` : ''}: ${r.url ?? ''}`.trim() : `PR failed: ${r.output ?? 'unknown error'}`, r.ok ? 'info' : 'error');
    if (r.ok) deps.log('info', `[${sessionId}] PR opened${head ? ` for ${head}` : ''}: ${r.url ?? ''}`.trim());
    else deps.log('warn', `[${sessionId}] PR creation failed: ${(r.output ?? 'unknown error').trim().slice(0, 600)}`);
    if (r.ok) sessions.refreshGitState(sessionId);
    if (r.ok) {
      const session = sessions.get(sessionId);
      if (session) scheduleGitnexus(session, 'pull-request');
      // PR reflection: the commits and a bounded patch are reflected over the whole wiki, then
      // ingested automatically. Gathering evidence is best-effort; the PR itself already succeeded.
      const evidence = await gitRangeEvidence(cwdOf(sessionId), base, head).catch(() => ({ commits: [], diff: '' }));
      const detail = [r.url, evidence.commits.length ? `Commits:\n${evidence.commits.join('\n')}` : '', evidence.diff ? `Diff:\n${evidence.diff}` : '']
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 14_000);
      void deps.knowledge?.reflectPr(knowledgeScopeOf(sessionId), { kind: 'pr', sessionId, summary: `PR into ${base}${head ? ` from ${head}` : ''}`, detail, at: new Date().toISOString() });
    }
    return r;
  });
  handle('git:merge', async ({ sessionId, base, head }) => {
    // An explicit head branch pins the PR (Branches panel); otherwise the session's own is resolved.
    const r = await gitMergePr(cwdOf(sessionId), base, head, head ? {} : await prQueryOf(sessionId));
    sessions.note(sessionId, r.ok ? `Merged${head ? ` ${head}` : ''}: ${r.url ?? 'PR merged'}` : r.output ?? 'Failed to merge the PR', r.ok ? 'info' : 'error');
    if (r.ok) deps.log('info', `[${sessionId}] PR merged${head ? ` (${head})` : ''}: ${r.url ?? ''}`.trim());
    else deps.log('warn', `[${sessionId}] PR merge failed: ${(r.output ?? 'unknown error').trim().slice(0, 600)}`);
    if (r.ok) {
      sessions.refreshGitState(sessionId);
      const session = sessions.get(sessionId);
      if (session) scheduleGitnexus(session, 'merge');
      deps.knowledge?.recordEpisode(knowledgeScopeOf(sessionId), { kind: 'merge', sessionId, summary: `Merged${head ? ` ${head}` : ''}${base ? ` into ${base}` : ''}`, detail: r.url, at: new Date().toISOString() });
    }
    return r;
  });
  handle('git:branches', ({ sessionId }) => gitBranches(cwdOf(sessionId)));
  handle('git:worktrees', ({ sessionId }) => gitWorktrees(cwdOf(sessionId)));
  handle('git:checkout', ({ sessionId, branch }) => gitCheckout(cwdOf(sessionId), branch));
  handle('git:branchesOverview', ({ sessionId }) => gitBranchesOverview(cwdOf(sessionId)));
  // Guided setup for a folder that is not a repository yet (or has no GitHub remote).
  handle('git:setupStatus', ({ sessionId }) => gitSetupStatus(cwdOf(sessionId)));
  handle('git:init', ({ sessionId }) => gitInit(cwdOf(sessionId)));
  handle('git:initialCommit', ({ sessionId, message }) => gitInitialCommit(cwdOf(sessionId), message));
  handle('git:setRemote', ({ sessionId, url }) => gitSetRemote(cwdOf(sessionId), url));
  handle('git:push', async ({ sessionId }) => {
    const r = await gitPush(cwdOf(sessionId));
    if (r.ok) sessions.refreshGitState(sessionId);
    return r;
  });
  handle('git:createGitHubRepo', async ({ sessionId, name, private: isPrivate }) => {
    const r = await gitCreateGitHubRepo(cwdOf(sessionId), name, !!isPrivate);
    if (r.ok) sessions.refreshGitState(sessionId);
    return r;
  });
  handle('git:setIdentity', ({ sessionId, name, email, global }) => gitSetIdentity(cwdOf(sessionId), name, email, !!global));
  handle('git:githubIdentity', ({ sessionId }) => gitGithubIdentity(cwdOf(sessionId)));
  handle('git:deleteBranch', ({ sessionId, branch, force }) => gitDeleteBranch(cwdOf(sessionId), branch, !!force));
  handle('git:updateBranch', ({ sessionId, branch }) => gitUpdateBranch(cwdOf(sessionId), branch));
  // Only registered worktrees may be removed; `path` must match one git reports so the
  // client cannot ask for an arbitrary directory deletion.
  handle('git:removeWorktree', async ({ sessionId, path: p }) => {
    const target = path.resolve(p);
    const { worktrees } = await gitWorktrees(cwdOf(sessionId));
    if (!worktrees.some((w) => w.path === target)) return { ok: false, error: 'Not a registered worktree' };
    try {
      await removeWorktree(cwdOf(sessionId), target);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  });
  handle('git:pruneWorktrees', ({ sessionId }) => gitPruneWorktrees(cwdOf(sessionId)));
  handle('git:fetchPrune', ({ sessionId }) => gitFetchPrune(cwdOf(sessionId)));
  handle('git:pullRequests', ({ sessionId }) => gitPullRequests(cwdOf(sessionId)));
  handle('git:pullRequest', (input) => {
    const { sessionId, url } = z.strictObject({ sessionId: z.string(), url: z.string() }).parse(input);
    if (!sessions.get(sessionId)) throw new Error('Session not found');
    return gitPullRequest(url);
  });
  handle('git:issues', ({ sessionId }) => gitIssues(cwdOf(sessionId)));
  handle('git:issueComments', ({ sessionId, number }) => gitIssueComments(cwdOf(sessionId), number));
  handle('git:prComments', ({ sessionId, number }) => gitPullRequestComments(cwdOf(sessionId), number));

  handle('fs:resolve', async (input) => {
    const { sessionId, path: target } = z.strictObject({ sessionId: sessionIdSchema, path: z.string() }).parse(input);
    const relative = validateWorkspaceFileTarget(target);
    return resolveWorkspaceFile(cwdOf(sessionId), relative);
  });
  handle('fs:list', ({ sessionId, relPath }) => listWorkspaceFiles(cwdOf(sessionId), relPath));
  handle('fs:search', async ({ sessionId, query, limit }) => {
    const root = cwdOf(sessionId);
    const q = query.toLowerCase();
    const max = limit ?? 30;
    const out: string[] = [];
    const skip = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.venv', 'venv', 'target', '.vocs-code']);
    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (out.length >= max || depth > 8) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= max) return;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!skip.has(e.name)) await walk(path.join(dir, e.name), r, depth + 1);
        } else if (!q || fuzzyMatch(r.toLowerCase(), q)) out.push(r);
      }
    };
    await walk(root, '', 0);
    return out;
  });
  handle('fs:read', ({ sessionId, path: p, maxBytes }) => readWorkspaceFile(cwdOf(sessionId), p, maxBytes, async () => {
    try {
      validateWorkspaceFileTarget(p);
      return true;
    } catch {
      return false; // Inspection remains available for a target the preview cannot save.
    }
  }));
  handle('fs:readImage', ({ sessionId, path: p }) => readWorkspaceImage(cwdOf(sessionId), p));
  handle('fs:writeText', async (input) => {
    const text = z.string().max(FILE_PREVIEW_MAX_BYTES, 'Text exceeds the preview size limit.');
    const { sessionId, path: target, content, expectedContent } = z.strictObject({
      sessionId: sessionIdSchema, path: z.string(), content: text, expectedContent: text
    }).parse(input);
    const relative = validateWorkspaceFileTarget(target);
    const cwd = cwdOf(sessionId);
    sessions.assertNotHousekeeping?.(sessionId);
    await writeWorkspaceText(cwd, relative, content, expectedContent);
  });

  // Layer 2 project knowledge. Every channel resolves its scope from the session, never from a
  // renderer-supplied path, so a client cannot read or write another project's wiki.
  const knowledgeScopeOf = (sessionId: string) => {
    const m = sessions.get(sessionId);
    if (!m) throw new Error('Session not found');
    return { projectRoot: m.config.projectRoot, cwd: m.cwd, ...(m.worktreeBranch ? { branch: m.worktreeBranch } : {}) };
  };
  const knowledgeOf = () => deps.knowledge ?? null;
  handle('knowledge:view', ({ sessionId }) => {
    const k = knowledgeOf();
    if (!k) throw new Error('Project knowledge is unavailable in this run');
    return k.view(knowledgeScopeOf(sessionId));
  });
  handle('knowledge:create', ({ sessionId }) => {
    const k = knowledgeOf();
    if (!k) throw new Error('Project knowledge is unavailable in this run');
    return k.createWiki(knowledgeScopeOf(sessionId));
  });
  handle('knowledge:read', ({ sessionId, id }) => {
    const k = knowledgeOf();
    if (!k) throw new Error('Project knowledge is unavailable in this run');
    return typeof id === 'string' && id ? k.detail(knowledgeScopeOf(sessionId), id) : null;
  });
  handle('knowledge:search', ({ sessionId, q, limit, includeHistorical }) => {
    const k = knowledgeOf();
    if (!k || typeof q !== 'string' || !q.trim()) return [];
    return k.search(knowledgeScopeOf(sessionId), q, { limit: typeof limit === 'number' ? limit : undefined, includeHistorical: includeHistorical === true });
  });
  handle('knowledge:review', async ({ sessionId, id, action, note }) => {
    const k = knowledgeOf();
    if (!k) throw new Error('Project knowledge is unavailable in this run');
    if (action !== 'accept' && action !== 'reject') throw new Error('Unknown review action');
    const scope = knowledgeScopeOf(sessionId);
    const withdraw = deps.intelligence && action === 'reject' && (await k.store.read(scope, id))?.meta.scope === 'repo';
    await k.review(scope, id, action, { by: 'human', ...(typeof note === 'string' && note.trim() ? { note: note.trim() } : {}) });
    if (withdraw && !(await k.store.read(scope, id))) await deps.intelligence?.retireWikiPromotions({ sessionId, ...scope }, id);
    return k.view(scope);
  });
  handle('knowledge:reviewAll', async ({ sessionId }) => {
    const k = knowledgeOf();
    if (!k) throw new Error('Project knowledge is unavailable in this run');
    const scope = knowledgeScopeOf(sessionId);
    const result = await k.acceptAll(scope, { by: 'human' });
    return { accepted: result.accepted, view: await k.view(scope) };
  });
  handle('knowledge:generate', ({ sessionId, mode }) => {
    const k = knowledgeOf();
    if (!k) throw new Error('Project knowledge is unavailable in this run');
    if (mode !== 'bootstrap' && mode !== 'distill' && mode !== 'reflect') throw new Error('Unknown generation mode');
    return k.generate(knowledgeScopeOf(sessionId), mode);
  });
  handle('knowledge:publish', ({ sessionId, ids }) => {
    const k = knowledgeOf();
    if (!k) throw new Error('Project knowledge is unavailable in this run');
    const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string' && !!x).slice(0, 50) : [];
    return k.publish(knowledgeScopeOf(sessionId), list);
  });
  handle('knowledge:graph', ({ sessionId }) => {
    const k = knowledgeOf();
    if (!k) throw new Error('Project knowledge is unavailable in this run');
    return k.graph(knowledgeScopeOf(sessionId));
  });
  handle('knowledge:delete', async ({ sessionId, id }) => {
    const k = knowledgeOf();
    if (!k) throw new Error('Project knowledge is unavailable in this run');
    if (typeof id !== 'string' || !id) throw new Error('A page id is required');
    const scope = knowledgeScopeOf(sessionId);
    const withdraw = deps.intelligence && (await k.store.read(scope, id))?.meta.scope === 'repo';
    // A delete that found nothing must not report success: the panel would claim a page is gone
    // while it is still served to every agent.
    if (!(await k.remove(scope, id))) throw new Error(`Nothing to delete: ${id} is not in this project's wiki.`);
    if (withdraw) await deps.intelligence?.retireWikiPromotions({ sessionId, ...scope }, id);
    return k.view(scope);
  });

  // The intelligence core. As with knowledge, the project, checkout and branch always come from
  // the session the app holds: a renderer can name a session, never a path or a project id.
  const intelligenceOf = (): IntelligenceService => {
    if (!deps.intelligence) throw new Error('Memory and collections are unavailable in this run');
    return deps.intelligence;
  };
  const intelligenceContextOf = (sessionId: string): IntelligenceContext => {
    const id = sessionIdSchema.parse(sessionId);
    return { sessionId: id, ...knowledgeScopeOf(id) };
  };
  const recordId = (id: unknown): string => {
    if (typeof id !== 'string' || !/^mem_[0-9a-z]{6,40}$/.test(id)) throw new Error('A memory record id is required');
    return id;
  };
  handle('intelligence:view', ({ sessionId }) => intelligenceOf().view(intelligenceContextOf(sessionId)));
  handle('intelligence:search', ({ sessionId, query, scope, limit, includeHistorical }) => {
    if (typeof query !== 'string' || !query.trim()) throw new Error('A question is required');
    return intelligenceOf().search(intelligenceContextOf(sessionId), {
      query: query.slice(0, 500),
      scope: scope === 'collection' ? 'collection' : 'project',
      ...(typeof limit === 'number' ? { limit } : {}),
      includeHistorical: includeHistorical === true
    });
  });
  handle('intelligence:compile', ({ sessionId, query, budgetTokens, scope }) => {
    if (typeof query !== 'string' || !query.trim()) throw new Error('A question is required');
    return intelligenceOf().compile(intelligenceContextOf(sessionId), { query: query.slice(0, 500), ...(typeof budgetTokens === 'number' ? { budgetTokens } : {}), scope: scope === 'collection' ? 'collection' : 'project' });
  });
  handle('intelligence:memory:add', async ({ sessionId, type, title, text, scope }) => {
    if (!isMemoryType(type) || type === 'working') throw new Error('Unknown memory type');
    if (typeof title !== 'string' || !title.trim() || typeof text !== 'string' || !text.trim()) throw new Error('A record needs a title and text');
    if (scope !== 'project' && scope !== 'personal') throw new Error('A record is added to this project or to personal memory');
    const i = intelligenceOf();
    const ctx = intelligenceContextOf(sessionId);
    await i.addRecord(ctx, { type, title, text, scope });
    return i.view(ctx);
  });
  handle('intelligence:memory:decide', async ({ sessionId, id, to, note }) => {
    if (!isMemoryState(to)) throw new Error('Unknown memory state');
    const i = intelligenceOf();
    const ctx = intelligenceContextOf(sessionId);
    await i.decide(ctx, recordId(id), to, typeof note === 'string' && note.trim() ? { note: note.trim() } : {});
    return i.view(ctx);
  });
  handle('intelligence:memory:forget', async ({ sessionId, id }) => {
    const i = intelligenceOf();
    const ctx = intelligenceContextOf(sessionId);
    // A forget that removed nothing must not report success: the panel would show a record as gone
    // while it is still recalled.
    if (!(await i.forget(ctx, recordId(id), 'human')).forgotten) throw new Error('Nothing was forgotten: that record is no longer there.');
    return i.view(ctx);
  });
  handle('intelligence:memory:apply', async ({ sessionId, id }) => {
    const i = intelligenceOf();
    const ctx = intelligenceContextOf(sessionId);
    const { pageId } = await i.applyToWiki(ctx, recordId(id));
    return { pageId, view: await i.view(ctx) };
  });
  handle('intelligence:memory:export', ({ sessionId }) => intelligenceOf().exportMemory(intelligenceContextOf(sessionId)));
  handle('intelligence:memory:import', async ({ sessionId, bundle }) => {
    const i = intelligenceOf();
    const ctx = intelligenceContextOf(sessionId);
    const result = await i.importMemory(ctx, bundle);
    return { ...result, view: await i.view(ctx) };
  });
  handle('intelligence:reflect', ({ sessionId }) => {
    const ctx = intelligenceContextOf(sessionId);
    const m = sessions.get(ctx.sessionId);
    if (!m) throw new Error('Session not found');
    return intelligenceOf().reflect(ctx, { title: m.title }, 'manual');
  });
  handle('intelligence:promote', async ({ sessionId, pageId, recordId: record, to, collectionId }) => {
    if (to !== 'collection' && to !== 'personal') throw new Error('Promote to a collection or to personal memory');
    const i = intelligenceOf();
    const ctx = intelligenceContextOf(sessionId);
    await i.promote(ctx, {
      ...(typeof pageId === 'string' && pageId ? { pageId } : {}),
      ...(typeof record === 'string' && record ? { recordId: recordId(record) } : {}),
      to,
      ...(typeof collectionId === 'string' && collectionId ? { collectionId } : {})
    });
    return i.view(ctx);
  });
  handle('intelligence:promotion:decide', async ({ sessionId, id, decision }) => {
    if (decision !== 'approve' && decision !== 'reject') throw new Error('Unknown decision');
    if (typeof id !== 'string' || !id) throw new Error('A promotion request id is required');
    const i = intelligenceOf();
    const ctx = intelligenceContextOf(sessionId);
    await i.decidePromotion(ctx, id, decision);
    return i.view(ctx);
  });
  handle('intelligence:collection:save', async ({ sessionId, id, name, description, members }) => {
    if (typeof name !== 'string' || !name.trim()) throw new Error('A collection needs a name');
    const list = (Array.isArray(members) ? members : [])
      .filter((m): m is { projectId: string; share: 'promoted' | 'wiki' } => !!m && typeof m.projectId === 'string')
      .map((m) => ({ projectId: m.projectId, share: m.share === 'wiki' ? ('wiki' as const) : ('promoted' as const) }));
    const i = intelligenceOf();
    const ctx = intelligenceContextOf(sessionId);
    await i.saveCollection({ ...(typeof id === 'string' && id ? { id } : {}), name, ...(typeof description === 'string' ? { description } : {}), members: list });
    return i.view(ctx);
  });
  handle('intelligence:collection:delete', async ({ sessionId, id }) => {
    if (typeof id !== 'string' || !id) throw new Error('A collection id is required');
    const i = intelligenceOf();
    const ctx = intelligenceContextOf(sessionId);
    if (!(await i.deleteCollection(id))) throw new Error('That collection no longer exists.');
    return i.view(ctx);
  });
  handle('intelligence:graph:index', async ({ sessionId }) => {
    const i = intelligenceOf();
    const ctx = intelligenceContextOf(sessionId);
    await i.graphIndex(ctx);
    return i.view(ctx);
  });
  handle('intelligence:graph:clear', async ({ sessionId }) => {
    const i = intelligenceOf();
    const ctx = intelligenceContextOf(sessionId);
    await i.graphClear(ctx);
    return i.view(ctx);
  });

  handle('terminal:list', () => terminals.list());
  handle('terminal:screen', ({ terminalId, lines }) => terminals.screenText(String(terminalId ?? ''), typeof lines === 'number' ? lines : undefined));
  handle('terminal:shells', () => terminals.shells());
  handle('terminal:create', ({ sessionId, shell, cols, rows }) => {
    sessions.assertNotHousekeeping?.(sessionId);
    return terminals.create(sessionId, { shell, cols, rows });
  });
  handle('terminal:attach', ({ terminalId, cols, rows }) => terminals.attach(terminalId, cols, rows));
  handle('terminal:detach', ({ terminalId }) => terminals.detach(terminalId));
  handle('terminal:input', ({ terminalId, data }) => terminals.input(terminalId, data));
  handle('terminal:resize', ({ terminalId, cols, rows }) => terminals.resize(terminalId, cols, rows));
  handle('terminal:ack', ({ terminalId, chars }) => terminals.ack(terminalId, chars));
  handle('terminal:kill', ({ terminalId }) => terminals.kill(terminalId));
  handle('terminal:restart', ({ terminalId }) => terminals.restart(terminalId));
  handle('terminal:close', ({ terminalId }) => terminals.close(terminalId));
  handle('terminal:clear', ({ terminalId }) => terminals.clear(terminalId));
  handle('terminal:rename', ({ terminalId, title }) => terminals.rename(terminalId, title));

  return {
    channels: () => Array.from(handlers.keys()),
    invoke: invokeChannel,
    assertControlResource: async ({ sessionId, projectRoot }) => {
      const target = sessionId ? sessionFor(sessionId).cwd : projectRoot;
      if (!target || !path.isAbsolute(target)) throw new Error('Invalid control resource.');
      await fs.realpath(target); // Unlike legacy desktop probes, automation never falls back on a failed canonical read.
    },
    shutdown: async () => {
      await Promise.all([vocsAccount.dispose(), vesta.dispose(), dictationService?.dispose()]);
    }
  };
}

/** Pasted images crossing IPC: keep only well-formed image attachments, so a malformed payload
 *  cannot reach the harness with, say, a non-image mime type or a missing body. */
function normalizeAgentImages(raw: unknown): ImageAttachment[] | undefined {
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
function localAbsolutePath(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.length > 4096 || /[\x00-\x1f]/.test(p) || /^[\\/]{2}/.test(p)) return null;
  if (process.platform === 'win32') {
    if (!/^[A-Za-z]:[\\/]/.test(p) || p.slice(2).includes(':')) return null;
  } else if (!p.startsWith('/')) return null;
  return path.resolve(p);
}

function fuzzyMatch(hay: string, needle: string): boolean {
  if (hay.includes(needle)) return true;
  let i = 0;
  for (const c of hay) {
    if (c === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}
