/** Binds the transport-agnostic handler registry (handlers.ts) to Electron's ipcMain and pushes events to the renderer window. */
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import { createHandlerRegistry, type DesktopBridge } from './handlers';
import type { AnalyticsStore } from './analytics';
import type { RuntimeResolver } from './runtime';
import type { SecretStore } from './secrets';
import type { SessionManager } from './session-manager';
import type { SettingsStore } from './settings';
import type { TerminalManager } from './terminal';

export interface IpcDeps {
  settings: SettingsStore;
  secrets: SecretStore;
  sessions: SessionManager;
  terminals: TerminalManager;
  runtime: RuntimeResolver;
  analytics: AnalyticsStore;
  getWindow: () => BrowserWindow | null;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export function pushToRenderer(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

/** Electron affordances for the registry, keeping handlers.ts Electron-free (and testable in plain Node). */
function desktopBridge(deps: IpcDeps): DesktopBridge {
  return {
    appVersion: () => app.getVersion(),
    isPackaged: () => app.isPackaged,
    userDataPath: () => app.getPath('userData'),
    documentsPath: () => app.getPath('documents'),
    electronVersion: () => process.versions.electron ?? 'unknown',
    openExternal: (url) => shell.openExternal(url),
    openPath: async (p) => {
      await shell.openPath(p);
    },
    showOpenDialog: (opts) => dialog.showOpenDialog(deps.getWindow() ?? (undefined as unknown as BrowserWindow), opts as unknown as Electron.OpenDialogOptions),
    showSaveDialog: (opts) => dialog.showSaveDialog(deps.getWindow() ?? (undefined as unknown as BrowserWindow), opts as unknown as Electron.SaveDialogOptions),
    notify: async (title, body) => {
      const { Notification } = await import('electron');
      if (Notification.isSupported()) new Notification({ title, body }).show();
    },
    toggleFullScreen: () => {
      const win = deps.getWindow();
      win?.setFullScreen(!win.isFullScreen());
    },
    reload: () => deps.getWindow()?.webContents.reload(),
    toggleDevTools: () => deps.getWindow()?.webContents.toggleDevTools(),
    zoom: (direction) => {
      const wc = deps.getWindow()?.webContents;
      if (!wc) return null;
      const next = direction === 'reset' ? 1 : Math.min(2, Math.max(0.6, wc.getZoomFactor() + (direction === 'in' ? 0.1 : -0.1)));
      wc.setZoomFactor(next);
      return wc.getZoomFactor();
    },
    edit: (command) => {
      // The renderer has no native menu on Windows/Linux, so the Edit menu drives WebContents directly.
      const wc = deps.getWindow()?.webContents;
      if (!wc) return;
      if (command === 'selectAll') wc.selectAll();
      else wc[command]();
    }
  };
}

export function registerIpc(deps: IpcDeps): void {
  const registry = createHandlerRegistry({
    settings: deps.settings,
    secrets: deps.secrets,
    sessions: deps.sessions,
    terminals: deps.terminals,
    runtime: deps.runtime,
    analytics: deps.analytics,
    log: deps.log,
    push: (channel, payload) => pushToRenderer(deps.getWindow(), channel, payload),
    desktop: desktopBridge(deps)
  });
  for (const channel of registry.channels()) ipcMain.handle(channel, (_e, req: unknown) => registry.invoke(channel, req));
}