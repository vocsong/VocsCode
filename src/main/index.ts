/** Electron entry point: app lifecycle, service composition, logging, and graceful shutdown. */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BrowserWindow, Menu, Notification, app, nativeTheme, net, powerSaveBlocker, shell } from 'electron';
import { PUSH_CHANNELS } from '../shared/ipc';
import { hasOngoingWork } from '../shared/ongoing';
import { sessionTitleText } from '../shared/session-title';
import type { SessionEventEnvelope, SessionMeta } from '../shared/types';
import { AnalyticsStore } from './analytics';
import { reconcileForkInheritance, repriceClaudeFallbackTranscripts } from './analytics-migrations';
import { DesktopFocusTracker, forgetVisibleOnRendererReset } from './desktop-focus';
import { watchEventLoop } from './diag';
import { gitIdentityFacts, gitResolveCommit, setGitLog } from './git';
import { resolveAppIdentity } from './identity';
import { registerIpc, pushToRenderer } from './ipc';
import { KeepAwake } from './keep-awake';
import { KnowledgeService } from './knowledge/service';
import { createKnowledgeCompleter } from './knowledge/llm';
import { createGitnexusAnchorResolver } from './knowledge/anchors';
import { IntelligenceGateway, callIntelligenceTool } from './intelligence/gateway';
import { GraphifyProvider, TESTED_GRAPHIFY_VERSION } from './intelligence/graphify';
import { GraphScheduler } from './intelligence/graph-scheduler';
import { graphHead, graphHeadStamp, snapshotCommittedCode } from './intelligence/graph-snapshot';
import { MemoryStore } from './intelligence/memory-store';
import { PassiveLearning } from './intelligence/passive-learning';
import { normalizeRoot, ProjectRegistry } from './intelligence/registry';
import { IntelligenceService } from './intelligence/service';
import { KnowledgeUsage } from './intelligence/usage';
import { resolveIntelligenceSettings } from '../shared/intelligence';
import { GITNEXUS_SERVER_ID, gitnexusSharedRoots, isGitnexusIndexed, readGitnexusRegistry, realGitnexusHome, visibleGitnexusEntries } from './mcp/gitnexus';
import { GitnexusIndexer } from './mcp/indexer';
import { createLogger, describeError, type Logger } from './log';
import { SharedGitnexusServer } from './mcp/shared-server';
import { RuntimeResolver, which } from './runtime';
import { SearchIndex } from './search';
import { SecretStore } from './secrets';
import { providerSecrets } from './secret-ids';
import { createVocsAccount, VOCS_ACCOUNT_VAULT_IDS, vocsAccountRealm } from './vocs-account';
import { createVocsHub, VOCS_HUB_VAULT_IDS } from './vocs-hub';
import { SessionManager } from './session-manager';
import { retireLegacyMissionData } from './legacy-mission';
import { MissionGateway } from './mission-mode/gateway';
import { MissionService } from './mission-mode/service';
import { createProcessSource } from './process-snapshot';
import { ProcessTracker } from './process-tracker';
import { SettingsStore } from './settings';
import { AppInstructions } from './app-instructions';
import { runGracefulShutdown } from './shutdown';
import { SessionStore } from './store';
import { TerminalManager } from './terminal';
import { UpdateService } from './updater';
import { errorMessage } from './util/async';
import { electronUpdaterFacade } from './updater-electron';
import { RemoteHost } from './remote/host';
import { ControlJournal } from './control/journal';
import { LocalControl } from './control/local';
import { ControlService } from './control/service';
import { windowsLocalPipe } from './control/windows-pipe';
import type { ControlResourceGuard } from './control/workspace';
import { AnalyticsSync } from './remote/analytics-sync';
import { relayUrl } from './remote/relay-url';
import { MainWindowController, resolvePreloadPath } from './window';
import { registerAppUserModelId } from './windows-shell-identity';

const here = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL;
const rendererFile = path.join(here, '../renderer/index.html');
const rendererEntry = new URL(isDev ? process.env.ELECTRON_RENDERER_URL! : pathToFileURL(rendererFile));
const rendererDocument = rendererEntry.href.split('#', 1)[0];
const localControlDocument = !isDev || (rendererEntry.protocol === 'http:' && !rendererEntry.username && !rendererEntry.password &&
  ['localhost', '127.0.0.1', '[::1]'].includes(rendererEntry.hostname)) ? rendererDocument : undefined;
const APP_NAME = 'Vocs Code';

// The e2e suites drive real windows. Park them outside every display and never activate them, so a
// test run neither covers the desktop nor takes the focus away from whatever the developer is doing.
// Set VOCS_CODE_E2E_VISIBLE=1 to watch a suite on screen instead.
const e2eQuiet = process.env.VOCS_CODE_E2E_VISIBLE !== '1' && (process.env.VOCS_CODE_E2E_UI === '1' || process.env.HARNESS_E2E === '1');
// Chromium stops compositing a window it believes is occluded, which is what a window parked off
// every display looks like: without this, Playwright's screenshots come back blank.
if (e2eQuiet && !app.commandLine.hasSwitch('disable-features')) {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

// Electron uses its own name and AppUserModelId in development unless the host sets them explicitly.
// Keep the product name for the window and menu, but give an unpackaged run a `(Dev)` Windows
// identity and profile so it never shares the installed app's AppUserModelID, Start Menu shortcut
// or userData (see identity.ts). All of it lands before the single-instance lock, which is keyed on
// userData: an unpackaged run that took the installed profile would hold the lock, so launching the
// installed build while `npm run dev` is open would just focus the dev window and quit.
app.setName(APP_NAME);
const identity = resolveAppIdentity({
  packaged: app.isPackaged,
  appDataDir: app.getPath('appData'),
  userDataOverride: process.env.VOCS_CODE_USER_DATA
});
if (process.platform === 'win32') app.setAppUserModelId(identity.appUserModelId);
// A packaged run already lands on identity.userDataDir by default, so leave the path alone and keep
// honoring Chromium's `--user-data-dir`; unpackaged runs and an explicit override must be forced
// before the lock.
if (!app.isPackaged || process.env.VOCS_CODE_USER_DATA) app.setPath('userData', identity.userDataDir);

let windowController: MainWindowController | null = null;
let sessions: SessionManager | null = null;
let terminals: TerminalManager | null = null;
let remoteHost: RemoteHost | null = null;
let updater: UpdateService | null = null;
let processErrorHandlersInstalled = false;

/** Console-only until userData is known (see main()), then also a rotating file under logs/. */
let log: Logger = (level, message) => {
  if (level === 'debug' && !isDev && !process.env.VOCS_CODE_DEBUG) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

// Install before the async startup chain so failures while loading settings, secrets, or the
// window are captured by the console fallback and then automatically use the file logger.
installProcessErrorHandlers();

if (!app.requestSingleInstanceLock()) {
  log('warn', 'another Vocs Code instance is already running for this user-data directory; quitting');
  app.quit();
} else {
  app.on('second-instance', () => {
    log('info', 'a second launch was redirected to this instance');
    windowController?.focus();
  });
  app.whenReady().then(main).catch((e) => {
    log('error', `startup failed: ${describeError(e)}`);
    app.quit();
  });
}

async function main(): Promise<void> {
  // Test hooks: optionally quit after a delay. (The user-data override is applied before the lock above.)
  if (process.env.VOCS_CODE_AUTOQUIT) setTimeout(() => app.quit(), Number(process.env.VOCS_CODE_AUTOQUIT));
  const userData = app.getPath('userData');
  const logger = createLogger(path.join(userData, 'logs'), isDev || !!process.env.VOCS_CODE_DEBUG);
  log = logger.log;
  // Every subsystem gets a closure, not the function, so nothing keeps the console-only bootstrap logger.
  const logTo: Logger = (level, message) => log(level, message);
  log('info', `Vocs Code ${app.getVersion()} starting (electron ${process.versions.electron}, node ${process.versions.node}, ${process.platform} ${process.arch}${app.isPackaged ? ', packaged' : ', development'})`);
  log('info', `user data: ${userData}`);
  if (logger.file) log('info', `log file: ${logger.file}`);
  else log('warn', 'log file could not be opened; this run is logging to the console only');
  // A blocked main process is a window that takes no input; leave a trace when that happens.
  watchEventLoop(logTo);
  setGitLog(logTo);
  installAppProcessHandlers();
  const settings = new SettingsStore(userData, logTo);
  await settings.load();
  // The relay identity, a Vocs sign-in kept on this computer and a Vocs MCP Hub connection never
  // fall back to obfuscated storage on disk: without a real OS keychain they live for this run only.
  const secrets = new SecretStore(userData, logTo, { sessionOnly: ['remote-host', 'remote-enroll'], keychainOnly: [...VOCS_ACCOUNT_VAULT_IDS, ...VOCS_HUB_VAULT_IDS] });
  await secrets.load();
  // The legacy relay enrollment secret only ever registered a computer through browser pairing,
  // which is gone: drop a stored copy rather than keep a credential nothing reads.
  if (secrets.has('remote-enroll')) await secrets.clear('remote-enroll').catch(() => undefined);
  // Vocs MCP Hub connections: a refresh token in the keychain, access tokens in memory, and a
  // loopback proxy for sessions. Restoring reads the vault only; the first proxied call renews.
  const vocsHub = createVocsHub({ realm: vocsAccountRealm(), openExternal: (url) => shell.openExternal(url), vault: secrets, isOnline: () => net.isOnline(), log: logTo });
  void vocsHub.restore();
  const store = new SessionStore(userData, logTo);
  await store.load();
  // The app's own instruction layer (Settings → Instructions), shared by the session manager and
  // the settings handlers so both read the same files.
  const appInstructions = new AppInstructions(userData, logTo);
  const analytics = new AnalyticsStore(userData, { log: logTo });
  const providers = settings.get().providers;
  await analytics.load(store.list(), (id) => store.readTranscript(id), providers, {
    transcriptStamp: (id) => store.transcriptStamp(id)
  });

  // Spend the Claude adapter recorded at the CLI's fallback rates before it priced third-party
  // models from the app catalog is corrected here, once and before anything reads it.
  if (analytics.repricedSessions.length) {
    await repriceClaudeFallbackTranscripts(analytics.repricedSessions, store, providers, logTo);
  }

  // Deep search index: derived from transcripts, so it lives beside them and rebuilds itself.
  const search = new SearchIndex(userData, { store, log });
  await search.init();
  // Assigned further down; a deleted session takes its capability and its unverified memory with it.
  let intelligence: IntelligenceService | null = null;
  let intelligenceGateway: IntelligenceGateway | null = null;
  let passiveLearning: PassiveLearning | undefined;
  const currentWindow = () => windowController?.getWindow() ?? null;
  store.hooks = {
    prepareAppend: (id, item) => passiveLearning?.prepare(id, item),
    onAppend: (id, item) => search.indexItem(id, item),
    onRewrite: (id, replacement) => {
      passiveLearning?.discard(id);
      search.resyncSession(id);
      if (replacement && intelligence?.onTranscriptRewritten(id, replacement)) {
        pushToRenderer(currentWindow(), PUSH_CHANNELS.projectMemoryChanged, { sessionId: id });
      }
    },
    onRemove: (id) => {
      passiveLearning?.discard(id);
      search.dropSession(id);
      intelligenceGateway?.revoke(id);
      intelligence?.onSessionRemoved(id);
    }
  };

  // out/main/index.js → two levels up is the app root both in development and inside app.asar.
  // (app.getAppPath() returns out/main when launched as `electron out/main/index.js`.)
  const appRoot = path.resolve(here, '..', '..');
  registerAppUserModelId(appRoot, identity, logTo);
  const runtime = new RuntimeResolver(
    {
      appRuntimeDir: path.join(userData, 'runtime'),
      resourcesDir: app.isPackaged ? process.resourcesPath : path.join(appRoot, 'resources'),
      appRoot
    },
    () => settings.get()
  );
  // The retired Mission feature's coordination data goes; its worktrees are only reported.
  void retireLegacyMissionData(userData, log);

  // Prefer an installed `gitnexus`; otherwise run it through npx. Both are resolved, because a bare
  // `npx` on Windows is a `.cmd` shim only the resolved path lets `spawnTool` find.
  const gitnexusBinary = which('gitnexus');
  const npxBinary = gitnexusBinary ? null : which('npx');
  const sharedGitnexus = new SharedGitnexusServer({
    command: gitnexusBinary ?? npxBinary ?? 'npx',
    baseArgs: gitnexusBinary ? ['serve'] : ['-y', 'gitnexus@latest', 'serve'],
    log: logTo
  });
  const gitnexusIndexer = new GitnexusIndexer({
    command: gitnexusBinary ?? npxBinary,
    baseArgs: gitnexusBinary ? [] : ['-y', 'gitnexus@latest'],
    enabled: (projectRoot) => {
      const current = settings.get();
      if ((current.mcpDisabledBuiltins ?? []).includes(GITNEXUS_SERVER_ID)) return false;
      return !(current.mcpProjectState?.[projectRoot]?.disabledBuiltin ?? []).includes(GITNEXUS_SERVER_ID);
    },
    indexed: async ({ cwd, projectRoot }) =>
      isGitnexusIndexed(await readGitnexusRegistry(realGitnexusHome()), { projectRoot, cwd }),
    log: logTo
  });

  // Layer 2 project knowledge: the wiki store, its background jobs, and the digest every new
  // session may be primed with. The MCP server it feeds is a built-in, materialized per session.
  const transcriptLines = async (sessionId: string): Promise<string[]> => {
    const items = await store.readTranscript(sessionId);
    const lines: string[] = [];
    for (const item of items.slice(-60)) {
      if (item.kind === 'user') lines.push(`user: ${item.text.slice(0, 500)}`);
      else if (item.kind === 'assistant' && item.text.trim()) lines.push(`assistant: ${item.text.slice(0, 500)}`);
      else if (item.kind === 'tool') lines.push(`tool ${item.name} [${item.status}] ${(item.summary ?? item.title ?? '').slice(0, 200)}`);
      else if (item.kind === 'turn' && item.error) lines.push(`turn ${item.status}: ${item.error.slice(0, 200)}`);
    }
    return lines;
  };
  const knowledgeCompleter = createKnowledgeCompleter({ settings: () => settings.get(), getSecret: providerSecrets((id) => secrets.get(id)), log });
  const knowledge = new KnowledgeService({
    log,
    settings: () => settings.get(),
    transcript: transcriptLines,
    synth: {
      completer: knowledgeCompleter
    },
    anchors: createGitnexusAnchorResolver({
      // A cold shared server is started lazily; the panel must not wait on it forever.
      url: () => Promise.race([sharedGitnexus.ensure(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000))]),
      repoName: async (scope) => {
        const registry = await readGitnexusRegistry(realGitnexusHome());
        const entry = visibleGitnexusEntries(registry, { projectRoot: scope.projectRoot, cwd: scope.cwd, sharedRoots: gitnexusSharedRoots(settings.get()) })[0];
        return entry?.name ?? null;
      },
      log
    })
  });

  // The intelligence core: stable project identity and collections, the memory ledger, the local
  // Graphify cache, and the gateway. Passive turn capture stays on-device; model-assisted
  // wiki jobs and session reflection are separate paths.
  const intelligenceDir = path.join(userData, 'intelligence');
  const knowledgeUsage = new KnowledgeUsage(intelligenceDir, { log });
  await knowledgeUsage.load();
  const projectRegistry = new ProjectRegistry(intelligenceDir, { log, facts: (root) => gitIdentityFacts(root) });
  const memoryStore = new MemoryStore(intelligenceDir, { log });
  memoryStore.init();
  const graphPayload = app.isPackaged ? runtime.resource('graphify-runtime') : runtime.resource('graphify-runtime', `${process.platform}-${process.arch}`);
  const graphPython = path.join(graphPayload, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  const graphLauncher = path.join(graphPayload, 'launch.py');
  // Never launch a PATH executable or a saved override in an automatic indexer.
  const graphCommand = () => existsSync(graphPython) && existsSync(graphLauncher) ? graphPython : null;
  const graphify = new GraphifyProvider({
    command: graphCommand,
    commandArgs: ['-I', '-S', '-B', graphLauncher],
    requireVersion: TESTED_GRAPHIFY_VERSION,
    cacheRoot: path.join(intelligenceDir, 'graphs'),
    headRevision: graphHead,
    revisionStamp: graphHeadStamp,
    snapshot: snapshotCommittedCode,
    timeoutMs: 180_000,
    log
  });
  intelligence = new IntelligenceService({
    log,
    settings: () => settings.get(),
    knowledge,
    registry: projectRegistry,
    memory: memoryStore,
    graph: graphify,
    sessions: () => store.list().map((s) => ({ id: s.id, title: s.title, projectRoot: s.config.projectRoot, ...(s.archived ? { archived: true } : {}) })),
    history: (query, sessionIds, limit, opts) => search.recall({ q: query, sessionIds, limit, strict: opts?.strict }),
    transcript: transcriptLines,
    completer: knowledgeCompleter,
    git: {
      head: async (cwd) => (await gitIdentityFacts(cwd)).head ?? null,
      resolveCommit: (cwd, revision) => gitResolveCommit(cwd, revision)
    },
    gatewayState: () => intelligenceGateway?.state() ?? { listening: false, sessions: 0 }
  });
  const intelligenceCore = intelligence;
  passiveLearning = new PassiveLearning({
    enabled: () => memoryStore.available && settings.get().intelligence?.reflection === 'local',
    session: (id) => store.get(id),
    capture: async (ctx, observation, current) => {
      if (await intelligenceCore.captureLocalTurn(ctx, observation, current)) {
        pushToRenderer(currentWindow(), PUSH_CHANNELS.projectMemoryChanged, { sessionId: ctx.sessionId });
      }
    },
    failed: () => log('warn', 'intelligence: could not save a local learning note')
  });
  const graphSettings = () => resolveIntelligenceSettings(settings.get().intelligence).graphify;
  const graphSession = (id: string) => {
    const meta = store.get(id);
    return meta && !meta.archived && !meta.controlCreation && meta.cwd && meta.config?.projectRoot ? meta : null;
  };
  const graphScheduler = new GraphScheduler({
    enabled: () => graphSettings().enabled && graphCommand() !== null,
    refresh: async (id, signal) => {
      const meta = graphSession(id);
      if (meta) await intelligenceCore.refreshGraph({ sessionId: id, projectRoot: meta.config.projectRoot, cwd: meta.cwd }, signal);
    },
    onError: (error) => log('debug', `Graphify refresh could not be scheduled: ${describeError(error)}`)
  });
  const selectGraphSession = (id: string | null) => {
    const meta = id ? graphSession(id) : null;
    graphScheduler.select(meta?.id ?? null, meta ? JSON.stringify([normalizeRoot(meta.config.projectRoot), normalizeRoot(meta.cwd)]) : undefined);
  };
  intelligenceGateway = new IntelligenceGateway({
    log,
    enabled: () => resolveIntelligenceSettings(settings.get().intelligence).gateway,
    // Scope comes from live app state. Plans can read but not write, and widening scope only
    // queues a request. Deleting durable memory is a desktop-owner action.
    session: (sessionId) => {
      const meta = store.get(sessionId);
      if (!meta || meta.archived) return null;
      return {
        sessionId,
        projectRoot: meta.config.projectRoot,
        cwd: meta.cwd,
        ...(meta.worktreeBranch ? { branch: meta.worktreeBranch } : {}),
        actions: meta.config.permissionMode === 'plan' ? ['read'] : ['read', 'record', 'promote'],
        allowCollections: resolveIntelligenceSettings(settings.get().intelligence).collections
      };
    },
    beginUsage: (session, tool) => knowledgeUsage.begin(session, 'agent', tool),
    call: (session, tool, args, signal, observe) => callIntelligenceTool({ intelligence: intelligenceCore, knowledge }, session, tool, args, signal, observe)
  });
  await intelligenceGateway.start();
  const memoryGateway = intelligenceGateway;
  // Session-end reflection, when the user chose `auto`: archiving a session or merging its PR is the
  // signal that it is finished. Remembered per session so a restart does not reflect on old ones.
  const reflectedStates = new Map(store.list().map((session) => [session.id, session.archived === true || session.status === 'merged']));

  // Git state can change outside the app (an agent may run `gh` itself). Remember the last state so
  // the existing PR/merge poll becomes a passive indexing hook too, without re-indexing old parked
  // sessions at every app start.
  const indexedGitStates = new Map(store.list().map((session) => [session.id, session.status]));

  // Fan-out hooks that need to run on every sessions change (the update prompt waits for idle).
  const sessionsChangedHooks: Array<() => void> = [];
  const keepAwake = new KeepAwake(powerSaveBlocker, log);
  // Declared before the manager so the push callbacks can reach it; assigned once the relay host
  // exists (the callbacks only fire on real activity, long after boot).
  let analyticsSync: AnalyticsSync | null = null;
  let processesRef: ProcessTracker | null = null;
  // Mission mode needs the manager and the manager reaches it through hooks; assigned right below.
  let missionService: MissionService | undefined;
  sessions = new SessionManager({
    mission: () => missionService,
    missionServerPath: runtime.resource('mcp', 'vocs-mission.mjs'),
    store,
    settings,
    runtime,
    analytics,
    getSecret: providerSecrets((id) => secrets.get(id)),
    // Read on turn end only, long after the tracker below exists.
    isViewing: (id): boolean => desktopFocus.isViewing(id),
    sharedGitnexus: () => sharedGitnexus.ensure(),
    gitnexusProxyPath: runtime.resource('mcp', 'gitnexus-scope.mjs'),
    memoryServerPath: runtime.resource('mcp', 'vocs-memory.mjs'),
    memoryUserData: userData,
    memoryGateway: (sessionId) => memoryGateway.attach(sessionId),
    hubServers: () => vocsHub.servers(),
    revokeMemoryGateway: (sessionId) => memoryGateway.revoke(sessionId),
    restrictMemoryGateway: (sessionId) => memoryGateway.restrictToRead(sessionId),
    appInstructions: (harness) => appInstructions.effective(harness),
    knowledgeDigest: (scope) => knowledge.digest(scope, { seedIfEmpty: true }),
    pushEvent: (env: SessionEventEnvelope) => {
      pushAll(PUSH_CHANNELS.sessionEvent, env);
      if (env.event.type === 'status' && (env.event.status === 'idle' || env.event.status === 'stopped')) {
        processesRef?.soon(300);
      }
    },
    pushSessions: (list: SessionMeta[]) => {
      keepAwake.sync(list);
      search.syncMeta(list);
      const liveIds = new Set(list.map((session) => session.id));
      for (const session of list) {
        const previous = indexedGitStates.get(session.id);
        indexedGitStates.set(session.id, session.status);
        if (previous === session.status) continue;
        if (session.status === 'pr' || session.status === 'merged') {
          gitnexusIndexer.schedule({
            cwd: session.cwd,
            projectRoot: session.config.projectRoot,
            reason: session.status === 'pr' ? 'pull-request' : 'merge'
          });
        }
      }
      for (const id of indexedGitStates.keys()) if (!liveIds.has(id)) indexedGitStates.delete(id);
      for (const session of list) {
        const finished = session.archived === true || session.status === 'merged';
        const before = reflectedStates.get(session.id);
        reflectedStates.set(session.id, finished);
        if (!finished || before !== false || resolveIntelligenceSettings(settings.get().intelligence).reflection !== 'auto') continue;
        void intelligenceCore
          .reflect({ sessionId: session.id, projectRoot: session.config.projectRoot, cwd: session.cwd, ...(session.worktreeBranch ? { branch: session.worktreeBranch } : {}) }, { title: session.title }, 'auto')
          .catch((e) => log('debug', `intelligence: automatic reflection skipped: ${e instanceof Error ? e.message : String(e)}`));
      }
      for (const id of reflectedStates.keys()) if (!liveIds.has(id)) reflectedStates.delete(id);
      for (const hook of sessionsChangedHooks) hook();
      analyticsSync?.notify();
      pushAll(PUSH_CHANNELS.sessionsChanged, list);
    },
    notify: (sessionId, title, body) => {
      // An off-screen test window is never focused, so without this every approval in a live suite
      // would raise a desktop toast on top of whatever the developer is doing.
      if (e2eQuiet) return;
      if (!settings.get().notifications) return;
      const win = currentWindow();
      if (win?.isFocused()) return;
      if (!Notification.isSupported()) return;
      const session = store.get(sessionId);
      const n = new Notification({
        title: session ? sessionTitleText({ title, config: session.config }) : title,
        body: body.slice(0, 200),
        silent: !settings.get().soundOnApproval
      });
      n.on('click', () => {
        const target = currentWindow();
        target?.show();
        target?.focus();
        pushAll(PUSH_CHANNELS.focusSession, { sessionId });
      });
      n.show();
    },
    log
  });

  const sessionsRef = sessions;

  // One push fan-out to the window. Declared before Mission recovery, whose session updates already
  // push the session list through it.
  const pushAll = (channel: string, payload: unknown) => {
    pushToRenderer(currentWindow(), channel, payload);
  };

  // Mission mode: the loopback gateway carries the Mission tools; it opens on the first mission
  // session. A mission that was running when the app closed comes back interrupted, never resumed.
  const missionGateway = new MissionGateway({
    identity: (sessionId) => missionService?.identity(sessionId) ?? null,
    handler: { call: (call) => missionService ? missionService.call(call) : Promise.resolve({ text: 'Mission mode is not available.', isError: true }) },
    log
  });
  missionService = new MissionService({
    sessions: sessionsRef,
    sessionDir: (id) => store.sessionDir(id),
    settings: () => settings.get(),
    appInstructions,
    gateway: () => missionGateway,
    log
  });
  const missionRef = missionService;
  await missionRef.recover().catch((e) => log('warn', `mission: recovery failed: ${errorMessage(e)}`));
  void missionRef.sweep().catch((e) => log('warn', `mission: startup sweep failed: ${errorMessage(e)}`));

  // Which session the desktop window is on (unseen-turn marks, the graph's selected session). The
  // window's focus/blur is wired in `MainWindowController`; the list reconcile forgets a target that
  // was deleted or archived since it was reported.
  const desktopFocus = new DesktopFocusTracker({
    hasSession: (id) => !!sessionsRef.get(id),
    push: (focus) => {
      selectGraphSession(focus.sessionId);
      pushAll(PUSH_CHANNELS.desktopFocus, focus);
    }
  });
  sessionsChangedHooks.push(() => {
    desktopFocus.reconcile();
    selectGraphSession(desktopFocus.state().sessionId);
  });

  // The Processes panel: every process the app starts, through any session, terminal or tool. It
  // observes spawns from here on, before a session, server or shell can start one, and saves what
  // it tracks so the next launch can find anything this run leaves behind.
  const processes = new ProcessTracker({
    source: createProcessSource(runtime.resource('processes', 'windows-process-snapshot.ps1')),
    rootPid: process.pid,
    internalPids: () => app.getAppMetrics().map((metric) => metric.pid),
    terminalRoots: () => {
      const titles = new Map((terminals?.list() ?? []).map((t) => [t.id, t.title]));
      return (terminals?.activity() ?? []).map((a) => ({ pid: a.pid, sessionId: a.sessionId, terminalId: a.terminalId, title: titles.get(a.terminalId) }));
    },
    registryFile: path.join(userData, 'processes.json'),
    cpuCount: os.availableParallelism(),
    onSummary: (summary) => pushAll(PUSH_CHANNELS.processSummary, summary),
    log
  });
  processesRef = processes;
  processes.start();

  // In-app auto-update (issue #198): packaged builds only — never in dev, and opt-out for e2e runs.
  // The startup check is deferred a beat so the first paint and git reads do not share its network.
  if (app.isPackaged && !process.env.VOCS_CODE_UPDATER_DISABLE) {
    updater = new UpdateService({
      facade: electronUpdaterFacade(logTo),
      isPackaged: true,
      isAnySessionLive: () => !!sessionsRef.list().some((s) => s.status === 'starting' || s.status === 'running' || s.status === 'awaiting' || hasOngoingWork(s)),
      push: (state) => pushAll(PUSH_CHANNELS.updateState, state),
      log
    });
    sessionsChangedHooks.push(() => updater?.notifySessionsChanged());
    updater.startChecking();
    log('info', 'in-app updates enabled (GitHub Releases)');
  } else {
    log('debug', 'in-app updates disabled: unpackaged build' + (process.env.VOCS_CODE_UPDATER_DISABLE ? ' or VOCS_CODE_UPDATER_DISABLE' : ''));
  }
  terminals = new TerminalManager({
    dir: path.join(userData, 'terminals'),
    settings: () => settings.get().terminal,
    version: app.getVersion(),
    cwdOf: (id) => sessionsRef.get(id)?.cwd,
    push: (channel, payload) => {
      pushAll(channel, payload);
      // Sample soon when a terminal changes.
      if (channel === PUSH_CHANNELS.terminalsChanged) processes.soon();
    },
    log
  });
  await terminals.load();

  // The audit trail of the retired paired-browser access; nothing reads it any more.
  void rm(path.join(userData, 'remote-audit.jsonl'), { force: true }).catch(() => undefined);
  // The control resource guard needs the registry lazily, since registerIpc consumes the control
  // service and the relay host.
  let registryRef: import('./handlers').HandlerRegistry | null = null;
  const controlJournal = new ControlJournal(userData);
  await controlJournal.load().catch(() => log('warn', 'External control journal unavailable; automation is disabled.'));
  const guardControlResource: ControlResourceGuard = async (resource) => {
    if (!registryRef?.assertControlResource) throw new Error('Control resource guard is unavailable.');
    await registryRef.assertControlResource(resource);
  };
  const control = new ControlService({
    journal: controlJournal, sessions: sessionsRef, settings: () => settings.get(), guard: guardControlResource,
  });
  const localControl = new LocalControl({
    supported: process.platform === 'win32', userData, roots: () => settings.get().folders,
    sessions: sessionsRef, guard: guardControlResource,
    open: windowsLocalPipe(runtime.resource('control', 'windows-pipe.ps1')),
  });
  // The relay connection (docs/CONTROL-MCP.md): external MCP controllers reach this computer over it
  // and the analytics dashboard receives snapshots through it.
  remoteHost = new RemoteHost({
    control,
    secrets: { get: (key) => secrets.get(key), set: (key, value) => secrets.set(key, value) },
    pushState: () => pushAll(PUSH_CHANNELS.remoteState, remoteHost!.state()),
    log,
    onOnline: () => analyticsSync?.connected()
  });

  // The code.vocs.io dashboard (docs/WEB-DASHBOARD.md): a connected computer uploads its analytics
  // snapshot unless sharing is off. Nothing is sent while the relay connection is off or unregistered.
  analyticsSync = new AnalyticsSync({
    snapshot: () => analytics.snapshot({ appVersion: app.getVersion(), platform: `${process.platform} ${process.arch}` }),
    request: (requestPath, init) => remoteHost!.analyticsRequest(requestPath, init),
    sharing: () => settings.get().remote?.shareAnalytics !== false,
    log
  });
  analyticsSync.start();

  // Built here, not in the registry, because it needs the OS vault; restored after the window opens.
  const vocsAccount = createVocsAccount({ realm: vocsAccountRealm(), openExternal: (url) => shell.openExternal(url), vault: secrets, isOnline: () => net.isOnline(), hub: vocsHub });
  const registry = registerIpc({
    vocsAccount,
    settings,
    secrets,
    sessions,
    keepAwake,
    terminals,
    runtime,
    analytics,
    search,
    knowledge,
    intelligence: intelligenceCore,
    knowledgeUsage,
    revokeMemoryGrants: () => memoryGateway.revokeAll(),
    gitnexusIndexer,
    appInstructions,
    remote: remoteHost,
    control,
    localControl,
    localControlDocument,
    desktopFocus,
    analyticsSync,
    updater: updater ?? undefined,
    processes,
    mission: missionRef,
    getWindow: currentWindow,
    log
  });
  registryRef = registry;

  // Resume the relay connection across restarts when it was left on; the relay is always relayUrl().
  if (settings.get().remote?.enabled) await remoteHost.enable(relayUrl());

  const watchRenderer = (contents: Electron.WebContents) => {
    forgetVisibleOnRendererReset(contents, desktopFocus);
    const cancelEnable = () => localControl.cancelPendingEnable();
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) cancelEnable();
    });
    contents.on('render-process-gone', cancelEnable);
    contents.once('destroyed', cancelEnable);
  };
  const winController = new MainWindowController({
    appName: APP_NAME,
    appRoot,
    preloadPath: resolvePreloadPath(here),
    rendererFile,
    rendererEntry,
    rendererDocument,
    isDev,
    e2eQuiet,
    identity,
    settings,
    log: logTo,
    onWindowFocus: (focused) => desktopFocus.setWindowFocused(focused),
    watchRenderer,
    onDidStartLoading: () => terminals?.detachAll()
  });
  windowController = winController;

  let lastGraphSettings = JSON.stringify(graphSettings());
  let lastReflection = settings.get().intelligence?.reflection;
  settings.onChange((s) => {
    if (s.intelligence?.reflection !== lastReflection) {
      lastReflection = s.intelligence?.reflection;
      passiveLearning?.reset();
    }
    localControl.projectsChanged();
    const nextGraphSettings = JSON.stringify(graphSettings());
    if (nextGraphSettings !== lastGraphSettings) {
      lastGraphSettings = nextGraphSettings;
      void graphify.cancel();
      graphScheduler.settingsChanged();
    }
    winController.applySettings(s);
    terminals?.updateSettings(s.terminal);
  });
  winController.applySettings(settings.get());

  // The window is frameless with an in-app title bar; on Windows/Linux the OS still paints the caption
  // buttons over it, so their colors have to follow the theme.
  nativeTheme.on('updated', () => winController.applyChrome());

  // No native menu bar: File/Edit/View/Help live in the custom title bar. macOS keeps its
  // application menu because the system requires one for the app menu and standard shortcuts.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

  winController.open();
  // A sign-in kept on this computer renews in the background; Settings shows "restoring" meanwhile.
  void vocsAccount.restore().catch(() => undefined);

  log('info', `ready in ${Math.round(process.uptime() * 1000)}ms: ${store.list().length} session(s), ${terminals.list().length} terminal tab(s)`);

  // History written before a fork stopped inheriting its source's spend is corrected here rather
  // than in `analytics.load` with the other repairs: this one reads every transcript, so it runs
  // asynchronously once the window is up.
  if (analytics.forkSweepPending) void reconcileForkInheritance(analytics, store, logTo);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) winController.open();
  });
  app.on('window-all-closed', () => {
    // macOS convention: stay resident so the 'activate' dock handler can reopen a window.
    log('debug', 'all windows closed');
    if (process.platform !== 'darwin') app.quit();
  });
  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    void runGracefulShutdown({
      localControl,
      keepAwake,
      mission: missionRef,
      updater,
      analyticsSync,
      remoteHost,
      sessions,
      analytics,
      terminals,
      search,
      intelligenceGateway,
      missionGateway,
      graphScheduler,
      graphify,
      passiveLearning,
      memoryStore,
      knowledgeUsage,
      registry,
      sharedGitnexus,
      processes,
      log: logTo
    }).then(() => app.exit(0));
  });
}

/** Keep process-level failures visible in packaged builds instead of leaving them in a console. */
function installProcessErrorHandlers(): void {
  if (processErrorHandlersInstalled) return;
  processErrorHandlersInstalled = true;
  process.on('unhandledRejection', (reason) => log('warn', `unhandled rejection: ${describeError(reason)}`));
  process.on('uncaughtException', (error) => {
    log('error', `uncaught exception: ${describeError(error)}`);
    if (app.isReady()) app.quit();
    else process.exitCode = 1;
  });
  process.on('warning', (warning) => log('warn', `node warning: ${warning.name}: ${warning.message}`));
}

/** Chromium helper processes (GPU, utility, renderer) dying is otherwise a silent blank window or dead terminal. */
function installAppProcessHandlers(): void {
  app.on('child-process-gone', (_e, details) => {
    const level = details.reason === 'clean-exit' || details.reason === 'killed' ? 'info' : 'error';
    log(level, `${details.type} process gone: ${details.reason}${details.exitCode !== undefined ? ` (exit code ${details.exitCode})` : ''}${details.name ? ` [${details.name}]` : ''}${details.serviceName ? ` service=${details.serviceName}` : ''}`);
  });
  app.on('render-process-gone', (_e, contents, details) => {
    // The main window's renderer is reported (and reloaded) by RendererRecovery; this catches any
    // other webContents.
    if (contents === windowController?.getWindow()?.webContents) return;
    log('error', `a renderer process is gone: ${details.reason} (exit code ${details.exitCode})`);
  });
}
