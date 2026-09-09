import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, Notification, app, nativeTheme, shell } from 'electron';
import { PUSH_CHANNELS } from '../shared/ipc';
import type { SessionEventEnvelope, SessionMeta } from '../shared/types';
import { registerIpc, pushToRenderer } from './ipc';
import { RuntimeResolver } from './runtime';
import { SecretStore } from './secrets';
import { SessionManager } from './session-manager';
import { SettingsStore } from './settings';
import { SessionStore } from './store';

const here = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL;

let mainWindow: BrowserWindow | null = null;
let sessions: SessionManager | null = null;

function log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  if (level === 'debug' && !isDev && !process.env.VOCS_DESK_DEBUG) return;
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
  if (process.env.VOCS_DESK_USER_DATA) app.setPath('userData', process.env.VOCS_DESK_USER_DATA);
  if (process.env.VOCS_DESK_AUTOQUIT) setTimeout(() => app.quit(), Number(process.env.VOCS_DESK_AUTOQUIT));
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

  registerIpc({ settings, secrets, sessions, runtime, getWindow: () => mainWindow, log });

  settings.onChange((s) => {
    nativeTheme.themeSource = s.theme;
  });
  nativeTheme.themeSource = settings.get().theme;

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
    Promise.race([sessions?.stopAll(), new Promise((r) => setTimeout(r, 4000))]).finally(() => app.exit(0));
  });
}

function createWindow(settings: SettingsStore): void {
  const s = settings.get();
  const bounds = s.windowBounds ?? { width: 1440, height: 900 };
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 600,
    title: 'Vocs-Desk',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111318' : '#f7f7f8',
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
    void settings.update({ windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height } });
  };
  win.on('resize', debounce(saveBounds, 500));
  win.on('move', debounce(saveBounds, 500));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'http://localhost')) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });

  if (isDev || process.env.VOCS_DESK_DEBUG) {
    win.webContents.on('console-message', (event) => {
      const { level, message, lineNumber, sourceId } = event as unknown as { level: string | number; message: string; lineNumber: number; sourceId: string };
      const lvl = level === 'error' || level === 3 ? 'error' : level === 'warning' || level === 2 ? 'warn' : 'debug';
      log(lvl, `[renderer] ${message} (${sourceId}:${lineNumber})`);
    });
  }
  if (process.env.VOCS_DESK_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          await import('node:fs/promises').then((fs) => fs.writeFile(process.env.VOCS_DESK_SCREENSHOT as string, img.toPNG()));
          log('info', `screenshot written to ${process.env.VOCS_DESK_SCREENSHOT}`);
        } catch (e) {
          log('error', `screenshot failed: ${String(e)}`);
        }
      }, Number(process.env.VOCS_DESK_SCREENSHOT_DELAY ?? 2500));
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
