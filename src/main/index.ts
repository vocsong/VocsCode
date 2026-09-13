/** Electron entry point: app lifecycle, window creation, logging, and the headless debug hooks documented in the README. */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BrowserWindow, Menu, Notification, app, nativeTheme, shell } from 'electron';
import { PUSH_CHANNELS } from '../shared/ipc';
import type { SessionEventEnvelope, SessionMeta } from '../shared/types';
import { chromeFor, themeSourceFor, type ThemeId } from '../shared/themes';
import { AnalyticsStore } from './analytics';
import { watchEventLoop } from './diag';
import { setGitLog } from './git';
import { registerIpc, pushToRenderer } from './ipc';
import { createLogger, describeError, type Logger } from './log';
import { RendererRecovery } from './renderer-recovery';
import { RuntimeResolver } from './runtime';
import { SearchIndex } from './search';
import { SecretStore } from './secrets';
import { SessionManager } from './session-manager';
import { SettingsStore } from './settings';
import { SessionStore } from './store';
import { TerminalManager } from './terminal';
import { RemoteHost } from './remote/host';
import { WebServer } from './web-server';

const here = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL;
const APP_NAME = 'Vocs Code';
const APP_ID = 'dev.vocs.vocscode';

// Electron uses its own name and AppUserModelId in development unless the host sets them explicitly.
// Set both before acquiring the single-instance lock so the taskbar uses the packaged identity too.
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
// Isolate user data before the lock: the lock is keyed on userData, so an isolated run
// (tests, a second checkout) must not collide with an instance using the default directory.
if (process.env.VOCS_CODE_USER_DATA) app.setPath('userData', process.env.VOCS_CODE_USER_DATA);

let mainWindow: BrowserWindow | null = null;
let sessions: SessionManager | null = null;
let terminals: TerminalManager | null = null;
let webServer: WebServer | null = null;
let remoteHost: RemoteHost | null = null;
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
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
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
  const secrets = new SecretStore(userData, logTo);
  await secrets.load();
  const store = new SessionStore(userData, logTo);
  await store.load();
  const analytics = new AnalyticsStore(userData, { log: logTo });
  await analytics.load(store.list(), (id) => store.readTranscript(id));

  // Deep search index: derived from transcripts, so it lives beside them and rebuilds itself.
  const search = new SearchIndex(userData, { store, log });
  await search.init();
  store.hooks = {
    onAppend: (id, item) => search.indexItem(id, item),
    onRewrite: (id) => search.resyncSession(id),
    onRemove: (id) => search.dropSession(id)
  };

  // out/main/index.js → two levels up is the app root both in development and inside app.asar.
  // (app.getAppPath() returns out/main when launched as `electron out/main/index.js`.)
  const appRoot = path.resolve(here, '..', '..');
  registerAppUserModelId(appRoot);
  const runtime = new RuntimeResolver(
    {
      appRuntimeDir: path.join(userData, 'runtime'),
      resourcesDir: app.isPackaged ? process.resourcesPath : path.join(appRoot, 'resources'),
      appRoot
    },
    () => settings.get()
  );

  sessions = new SessionManager({
    store,
    settings,
    runtime,
    analytics,
    getSecret: (id) => secrets.get(id),
    pushEvent: (env: SessionEventEnvelope) => pushAll(PUSH_CHANNELS.sessionEvent, env),
    pushSessions: (list: SessionMeta[]) => {
      search.syncMeta(list);
      pushAll(PUSH_CHANNELS.sessionsChanged, list);
    },
    notify: (sessionId, title, body) => {
      if (!settings.get().notifications) return;
      if (mainWindow?.isFocused()) return;
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body: body.slice(0, 200), silent: !settings.get().soundOnApproval });
      n.on('click', () => {
        mainWindow?.show();
        mainWindow?.focus();
        pushAll(PUSH_CHANNELS.focusSession, { sessionId });
      });
      n.show();
    },
    log
  });

  const sessionsRef = sessions;
  // One push fan-out for the window and web clients alike.
  const pushAll = (channel: string, payload: unknown) => {
    pushToRenderer(mainWindow, channel, payload);
    webServer?.broadcast(channel, payload);
    void remoteHost?.broadcastPush(channel, payload);
  };
  terminals = new TerminalManager({
    dir: path.join(userData, 'terminals'),
    settings: () => settings.get().terminal,
    version: app.getVersion(),
    cwdOf: (id) => sessionsRef.get(id)?.cwd,
    push: pushAll,
    log
  });
  await terminals.load();

  // Remote access (docs/REMOTE-ACCESS.md): the host needs the registry lazily, since
  // registerIpc itself consumes the host to bind the remote:* channels.
  let registryRef: import('./handlers').HandlerRegistry | null = null;
  remoteHost = new RemoteHost({
    registry: () => registryRef!,
    secrets: { get: (key) => secrets.get(key), set: (key, value) => secrets.set(key, value) },
    pushState: () => pushAll(PUSH_CHANNELS.remoteState, remoteHost!.state()),
    log,
    broadcast: (channel, payload) => void remoteHost?.broadcastPush(channel, payload)
  });

  const registry = registerIpc({
    settings,
    secrets,
    sessions,
    terminals,
    runtime,
    analytics,
    search,
    remote: remoteHost,
    broadcast: (channel, payload) => {
      webServer?.broadcast(channel, payload);
    },
    getWindow: () => mainWindow,
    log
  });
  registryRef = registry;

  // Resume remote access across restarts when it was left enabled.
  const remoteConfig = settings.get().remote;
  if (remoteConfig?.enabled && remoteConfig.relayUrl) {
    const enrollToken = await secrets.get('remote-enroll');
    if (enrollToken) await remoteHost.enable(remoteConfig.relayUrl, enrollToken);
  }

  // Localhost web client (P1 dogfood, docs/REMOTE-ACCESS.md): explicit opt-in, dev-oriented.
  // Serves the built renderer (npm run build first) and bridges the same handler registry to a browser tab.
  if (process.env.VOCS_CODE_WEB === '1') {
    webServer = new WebServer({
      registry,
      staticDir: path.join(appRoot, 'out', 'renderer'),
      port: Number(process.env.VOCS_CODE_WEB_PORT) || 5177,
      log
    });
    await webServer.start();
  }

  settings.onChange((s) => {
    currentTheme = s.theme;
    nativeTheme.themeSource = themeSourceFor(s.theme);
    // Two themes can share one themeSource (Midnight and Abyss are both 'dark'), so nativeTheme
    // may stay silent on a switch — repaint the caption from the theme id directly.
    applyChrome();
    terminals?.updateSettings(s.terminal);
  });
  currentTheme = settings.get().theme;
  nativeTheme.themeSource = themeSourceFor(currentTheme);

  // The window is frameless with an in-app title bar; on Windows/Linux the OS still paints the caption
  // buttons over it, so their colors have to follow the theme.
  nativeTheme.on('updated', applyChrome);

  // GPU and utility processes share the window's fate; a dead one explains a blank or malformed
  // window, and without a line here it is invisible. Normal exits are not news.
  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    log('error', `child process gone: ${details.type} ${details.reason} (exit ${details.exitCode})`);
  });

  // No native menu bar: File/Edit/View/Help live in the custom title bar. macOS keeps its
  // application menu because the system requires one for the app menu and standard shortcuts.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

  createWindow(settings, appRoot);

  log('info', `ready in ${Math.round(process.uptime() * 1000)}ms: ${store.list().length} session(s), ${terminals.list().length} terminal tab(s)`);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(settings, appRoot);
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
    const t0 = Date.now();
    log('info', `quitting: ${sessions?.list().filter((s) => s.status === 'running' || s.status === 'awaiting' || s.status === 'starting').length ?? 0} live session(s), ${terminals?.list().length ?? 0} terminal tab(s)`);
    // Drain debounced session-meta persists after the sessions themselves are stopped. Restored
    // terminal snapshots are written first, and the cap ensures a large terminal set cannot hold
    // Electron open indefinitely.
    const deadline = Date.now() + 4000;
    const safe = async (label: string, task: Promise<unknown> | void | undefined): Promise<void> => {
      try {
        await task;
      } catch (error) {
        log('warn', `${label} during shutdown failed: ${describeError(error)}`);
      }
    };
    const drainSessions = sessions
      ? sessions.stopAll().then(() => sessions?.flushPendingPersists()).then(() => analytics.flush())
      : Promise.resolve();
    const shutdown = Promise.all([
      safe('session drain', drainSessions),
      safe('terminal shutdown', terminals?.shutdown(deadline)),
      safe('search close', search?.close()),
      safe('web server stop', webServer?.stop())
    ]);
    const cap = new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 4000));
    void Promise.race([shutdown.then(() => false), cap]).then((timedOut) => {
      if (timedOut) log('warn', 'shutdown exceeded the 4s cap; exiting with any remaining state left for the next launch');
      else log('info', `shutdown complete in ${Date.now() - t0}ms`);
      app.exit(0);
    });
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
    if (contents === mainWindow?.webContents) return;
    log('error', `a renderer process is gone: ${details.reason} (exit code ${details.exitCode})`);
  });
}

/** Resolve the same icon in development and in the packaged app's extra resources. */
function appIconPath(appRoot: string): string {
  const iconName = process.platform === 'win32' ? 'vocs-code.ico' : 'vocs-code.png';
  const iconRoot = app.isPackaged ? path.join(process.resourcesPath, 'icons') : path.join(appRoot, 'resources', 'icons');
  return path.join(iconRoot, iconName);
}

/** Write the AUMID's DisplayName/IconUri so the Windows taskbar menu shows the product name, not 'Electron'. */
function registerAppUserModelId(appRoot: string): void {
  if (process.platform !== 'win32') return;
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`;
  const values: Array<[string, string]> = [
    ['DisplayName', APP_NAME],
    ['IconUri', appIconPath(appRoot)]
  ];
  for (const [name, data] of values) {
    const child = spawn('reg', ['add', key, '/f', '/v', name, '/t', 'REG_SZ', '/d', data], {
      stdio: 'ignore',
      windowsHide: true
    });
    // Best effort: a missing or blocked reg.exe only costs the menu title, nothing else.
    child.on('error', () => {});
  }
  reconcileDevShortcut(appRoot);
}

/** The shell resolves an AUMID's display name from a matching Start Menu shortcut before the registry,
 *  so in development we keep a correctly named 'Vocs Code' shortcut and drop stale ones (e.g. a leftover
 *  'Electron.lnk' from an earlier dev run) that would make the taskbar menu say 'Electron'. NSIS owns the
 *  shortcut once packaged, so this only runs unpackaged. */
function reconcileDevShortcut(appRoot: string): void {
  if (app.isPackaged) return;
  const menu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const exe = process.execPath.toLowerCase();
  try {
    for (const entry of readdirSync(menu)) {
      if (!entry.toLowerCase().endsWith('.lnk') || entry === `${APP_NAME}.lnk`) continue;
      const file = path.join(menu, entry);
      try {
        const lnk = shell.readShortcutLink(file);
        if (lnk.appUserModelId === APP_ID && lnk.target.toLowerCase() === exe) rmSync(file, { force: true });
      } catch {
        // Not one of our shortcuts (or unreadable); leave it alone.
      }
    }
  } catch {
    // No Start Menu directory; nothing to reconcile.
  }
  try {
    // iconIndex is required: writeShortcutLink silently drops `icon` without it, and a shortcut
    // without an icon leaves the taskbar (which resolves the window's AUMID to this shortcut)
    // showing a blank page icon.
    const options = {
      target: process.execPath,
      cwd: appRoot,
      description: APP_NAME,
      icon: appIconPath(appRoot),
      iconIndex: 0,
      appUserModelId: APP_ID
    };
    const lnk = path.join(menu, `${APP_NAME}.lnk`);
    // 'replace' only overwrites an existing shortcut; fall back to 'create' on the first run.
    if (!shell.writeShortcutLink(lnk, existsSync(lnk) ? 'replace' : 'create', options)) {
      log('warn', 'could not write the dev Start Menu shortcut; taskbar icon may fall back to Electron\'s');
    }
  } catch {
    // Best effort: without the shortcut the registry DisplayName above still names the taskbar menu.
  }
}

/** Title bar height in CSS pixels; must match --titlebar in styles.css. */
const TITLEBAR_HEIGHT = 36;

/** The active theme id, so the native caption can follow themes the OS knows nothing about. */
let currentTheme: ThemeId = 'system';

/** Caption colors for the frameless title bar, matching the renderer's --bg-elev / --fg tokens. */
function chrome(): { color: string; symbolColor: string; height: number } {
  return { ...chromeFor(currentTheme, nativeTheme.shouldUseDarkColors), height: TITLEBAR_HEIGHT };
}

/** Repaints the window background and the OS-drawn caption buttons for the active theme. */
function applyChrome(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBackgroundColor(chrome().color);
  if (process.platform === 'darwin') return;
  try {
    mainWindow.setTitleBarOverlay(chrome());
  } catch {
    // Older/unsupported platforms simply keep the colors they were created with.
  }
}

function createWindow(settings: SettingsStore, appRoot: string): void {
  const s = settings.get();
  const bounds = s.windowBounds ?? { width: 1440, height: 900 };
  const icon = appIconPath(appRoot);
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    icon,
    backgroundColor: chrome().color,
    // Frameless with an in-app title bar (sidebar toggle, history, menu bar). On Windows/Linux the
    // overlay keeps the native caption buttons — and with them snap layouts and double-click maximize.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: (TITLEBAR_HEIGHT - 14) / 2 } }
      : { titleBarOverlay: chrome() }),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true
    }
  });
  if (process.platform === 'win32') {
    win.setAppDetails({ appId: APP_ID, appIconPath: icon });
  }
  mainWindow = win;
  log('debug', `window created ${bounds.width}x${bounds.height}${'x' in bounds && bounds.x !== undefined ? ` at ${bounds.x},${bounds.y}` : ''}`);
  win.once('ready-to-show', () => {
    log('info', `window shown ${Math.round(process.uptime() * 1000)}ms after launch`);
    win.show();
  });
  win.on('closed', () => {
    log('debug', 'window closed');
    mainWindow = null;
  });
  // A preload failure leaves the renderer with no IPC bridge; the crash, stall and load-failure
  // handlers live with the recovery wiring below.
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    log('error', `preload script ${preloadPath} failed; the renderer has no IPC bridge: ${describeError(error)}`);
  });
  const saveBounds = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    const b = win.getBounds();
    settings
      .update({ windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height } })
      .catch((e) => log('warn', `could not save window bounds: ${describeError(e)}`));
  };
  win.on('resize', debounce(saveBounds, 500));
  win.on('move', debounce(saveBounds, 500));

  // A renderer that dies leaves a blank window and, without this, no record of why. Reload it
  // (bounded) so a one-off crash self-heals and a crash loop says so in the log instead of
  // reloading forever.
  const recovery = new RendererRecovery({
    log,
    reload: () => {
      if (!win.isDestroyed()) win.webContents.reload();
    }
  });
  win.webContents.on('render-process-gone', (_event, details) => recovery.gone(details.reason, details.exitCode));
  win.webContents.on('unresponsive', () => log('warn', 'renderer unresponsive — the window is not painting or taking input'));
  win.webContents.on('responsive', () => log('info', 'renderer responsive again'));
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED: an in-page navigation (hash, redirect) that is not a failure.
    if (isMainFrame && errorCode !== -3) log('error', `renderer failed to load ${validatedURL}: ${errorDescription} (${errorCode})`);
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => log('error', `preload script failed (${preloadPath}): ${error.stack ?? error.message}`));

  // A reload drops every xterm instance; stop streaming to it and let paused shells run until it re-attaches.
  win.webContents.on('did-start-loading', () => terminals?.detachAll());

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // The renderer is a single page: any navigation away from it (including relative file links
  // from rendered markdown) would leave the app unusable, so block everything but the page itself.
  const indexUrl = pathToFileURL(path.join(here, '../renderer/index.html')).href;
  win.webContents.on('will-navigate', (e, url) => {
    const target = url.split('#')[0];
    const allowed = isDev ? url.startsWith(process.env.ELECTRON_RENDERER_URL as string) : target === indexUrl;
    if (allowed) return;
    e.preventDefault();
    log('debug', `blocked in-app navigation to ${url.slice(0, 200)}${/^https?:\/\//i.test(url) ? ' (opened externally)' : ''}`);
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });

  // Renderer console output. Errors and warnings always reach the main log — a packaged build has no
  // DevTools open, so a React render error or a failed fetch would otherwise vanish. Info/debug chatter
  // only with the debug flag. (Uncaught exceptions also arrive structured via app:log; the console
  // copy carries the source location Chromium attaches.)
  const forwardDebug = isDev || !!process.env.VOCS_CODE_DEBUG;
  win.webContents.on('console-message', (event) => {
    const { level, message, lineNumber, sourceId } = event as unknown as { level: string | number; message: string; lineNumber: number; sourceId: string };
    const lvl = level === 'error' || level === 3 ? 'error' : level === 'warning' || level === 2 ? 'warn' : 'debug';
    if (lvl === 'debug' && !forwardDebug) return;
    log(lvl, `[renderer console] ${message.slice(0, 4000)} (${sourceId}:${lineNumber})`);
  });
  if (process.env.VOCS_CODE_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          await import('node:fs/promises').then((fs) => fs.writeFile(process.env.VOCS_CODE_SCREENSHOT as string, img.toPNG()));
          log('info', `screenshot written to ${process.env.VOCS_CODE_SCREENSHOT}`);
        } catch (e) {
          log('error', `screenshot failed: ${String(e)}`);
        }
      }, Number(process.env.VOCS_CODE_SCREENSHOT_DELAY ?? 2500));
    });
  }

  if (isDev) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL as string);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(path.join(here, '../renderer/index.html'));
  }
}

function debounce<T extends (...a: never[]) => void>(fn: T, ms: number): T {
  let t: NodeJS.Timeout | null = null;
  return ((...args: never[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}
