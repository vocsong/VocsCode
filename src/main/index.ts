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
import { registerIpc, pushToRenderer } from './ipc';
import { createLogger, type Logger } from './log';
import { RuntimeResolver } from './runtime';
import { SearchIndex } from './search';
import { SecretStore } from './secrets';
import { SessionManager } from './session-manager';
import { SettingsStore } from './settings';
import { SessionStore } from './store';
import { TerminalManager } from './terminal';
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

/** Console-only until userData is known (see main()), then also a rotating file under logs/. */
let log: Logger = (level, message) => {
  if (level === 'debug' && !isDev && !process.env.VOCS_CODE_DEBUG) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

if (!app.requestSingleInstanceLock()) {
  log('warn', 'another Vocs Code instance is already running for this user-data directory; quitting');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(main).catch((e) => {
    log('error', `startup failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    app.quit();
  });
}

async function main(): Promise<void> {
  // Test hooks: optionally quit after a delay. (The user-data override is applied before the lock above.)
  if (process.env.VOCS_CODE_AUTOQUIT) setTimeout(() => app.quit(), Number(process.env.VOCS_CODE_AUTOQUIT));
  const userData = app.getPath('userData');
  const logger = createLogger(path.join(userData, 'logs'), isDev || !!process.env.VOCS_CODE_DEBUG);
  log = logger.log;
  log('info', `Vocs Code ${app.getVersion()} starting (electron ${process.versions.electron}, ${process.platform} ${process.arch})`);
  // A blocked main process is a window that takes no input; leave a trace when that happens.
  watchEventLoop((level, message) => log(level, message));
  const settings = new SettingsStore(userData);
  await settings.load();
  const secrets = new SecretStore(userData);
  await secrets.load();
  const store = new SessionStore(userData);
  await store.load();
  const analytics = new AnalyticsStore(userData, { log });
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

  const registry = registerIpc({
    settings,
    secrets,
    sessions,
    terminals,
    runtime,
    analytics,
    search,
    broadcast: (channel, payload) => webServer?.broadcast(channel, payload),
    getWindow: () => mainWindow,
    log
  });

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

  // No native menu bar: File/Edit/View/Help live in the custom title bar. macOS keeps its
  // application menu because the system requires one for the app menu and standard shortcuts.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

  createWindow(settings, appRoot);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(settings, appRoot);
  });
  app.on('window-all-closed', () => {
    // macOS convention: stay resident so the 'activate' dock handler can reopen a window.
    if (process.platform !== 'darwin') app.quit();
  });
  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    // Drain debounced session-meta persists after the sessions themselves are stopped.
    const drainSessions = sessions ? sessions.stopAll().then(() => sessions?.flushPendingPersists()).then(() => analytics.flush()) : Promise.resolve();
    Promise.race([Promise.all([drainSessions, terminals?.shutdown(), Promise.resolve(search?.close()), Promise.resolve(webServer?.stop())]), new Promise((r) => setTimeout(r, 4000))]).finally(() => app.exit(0));
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
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    mainWindow = null;
  });
  const saveBounds = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    const b = win.getBounds();
    settings
      .update({ windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height } })
      .catch((e) => log('warn', `could not save window bounds: ${e instanceof Error ? e.message : String(e)}`));
  };
  win.on('resize', debounce(saveBounds, 500));
  win.on('move', debounce(saveBounds, 500));

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
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });

  if (isDev || process.env.VOCS_CODE_DEBUG) {
    win.webContents.on('console-message', (event) => {
      const { level, message, lineNumber, sourceId } = event as unknown as { level: string | number; message: string; lineNumber: number; sourceId: string };
      const lvl = level === 'error' || level === 3 ? 'error' : level === 'warning' || level === 2 ? 'warn' : 'debug';
      log(lvl, `[renderer] ${message} (${sourceId}:${lineNumber})`);
    });
  }
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
