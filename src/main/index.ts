/** Electron entry point: app lifecycle, window creation, logging, and the headless debug hooks documented in the README. */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BrowserWindow, Menu, Notification, app, nativeTheme, shell } from 'electron';
import { PUSH_CHANNELS } from '../shared/ipc';
import type { SessionEventEnvelope, SessionMeta } from '../shared/types';
import { chromeFor, themeSourceFor, type ThemeId } from '../shared/themes';
import { registerIpc, pushToRenderer } from './ipc';
import { RuntimeResolver } from './runtime';
import { SecretStore } from './secrets';
import { SessionManager } from './session-manager';
import { SettingsStore } from './settings';
import { SessionStore } from './store';
import { TerminalManager } from './terminal';

const here = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL;

let mainWindow: BrowserWindow | null = null;
let sessions: SessionManager | null = null;
let terminals: TerminalManager | null = null;

function log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  if (level === 'debug' && !isDev && !process.env.VOCS_CODE_DEBUG) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

if (!app.requestSingleInstanceLock()) {
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
  // Test hooks: isolate user data and optionally quit after a delay.
  if (process.env.VOCS_CODE_USER_DATA) app.setPath('userData', process.env.VOCS_CODE_USER_DATA);
  if (process.env.VOCS_CODE_AUTOQUIT) setTimeout(() => app.quit(), Number(process.env.VOCS_CODE_AUTOQUIT));
  const userData = app.getPath('userData');
  const settings = new SettingsStore(userData);
  await settings.load();
  const secrets = new SecretStore(userData);
  await secrets.load();
  const store = new SessionStore(userData);
  await store.load();

  // out/main/index.js → two levels up is the app root both in development and inside app.asar.
  // (app.getAppPath() returns out/main when launched as `electron out/main/index.js`.)
  const appRoot = path.resolve(here, '..', '..');
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
    getSecret: (id) => secrets.get(id),
    pushEvent: (env: SessionEventEnvelope) => pushToRenderer(mainWindow, PUSH_CHANNELS.sessionEvent, env),
    pushSessions: (list: SessionMeta[]) => pushToRenderer(mainWindow, PUSH_CHANNELS.sessionsChanged, list),
    notify: (sessionId, title, body) => {
      if (!settings.get().notifications) return;
      if (mainWindow?.isFocused()) return;
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body: body.slice(0, 200), silent: !settings.get().soundOnApproval });
      n.on('click', () => {
        mainWindow?.show();
        mainWindow?.focus();
        pushToRenderer(mainWindow, PUSH_CHANNELS.focusSession, { sessionId });
      });
      n.show();
    },
    log
  });

  const sessionsRef = sessions;
  terminals = new TerminalManager({
    dir: path.join(userData, 'terminals'),
    settings: () => settings.get().terminal,
    version: app.getVersion(),
    cwdOf: (id) => sessionsRef.get(id)?.cwd,
    push: (channel, payload) => pushToRenderer(mainWindow, channel, payload),
    log
  });
  await terminals.load();

  registerIpc({ settings, secrets, sessions, terminals, runtime, getWindow: () => mainWindow, log });

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

  createWindow(settings);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(settings);
  });
  app.on('window-all-closed', () => {
    app.quit();
  });
  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    Promise.race([Promise.all([sessions?.stopAll(), terminals?.shutdown()]), new Promise((r) => setTimeout(r, 4000))]).finally(() => app.exit(0));
  });
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

function createWindow(settings: SettingsStore): void {
  const s = settings.get();
  const bounds = s.windowBounds ?? { width: 1440, height: 900 };
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 600,
    title: 'Vocs Code',
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
