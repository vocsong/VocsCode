/** Main BrowserWindow lifecycle: creation, theme chrome, UI zoom, bounds persistence, and crash recovery. */
import path from 'node:path';
import { BrowserWindow, nativeTheme, screen, shell } from 'electron';
import { DEFAULT_PALETTE, chromeFor, themeSourceFor, type PaletteId } from '../shared/themes';
import type { AppSettings } from '../shared/types';
import type { AppIdentity } from './identity';
import { describeError, type Logger } from './log';
import { RendererRecovery } from './renderer-recovery';
import type { SettingsStore } from './settings';
import { appIconPath } from './windows-shell-identity';

/** Title bar height in CSS pixels; must match --titlebar in styles.css. */
const TITLEBAR_HEIGHT = 36;

export interface MainWindowOptions {
  appName: string;
  appRoot: string;
  preloadPath: string;
  rendererFile: string;
  rendererEntry: URL;
  rendererDocument: string;
  isDev: boolean;
  e2eQuiet: boolean;
  identity: AppIdentity;
  settings: SettingsStore;
  log: Logger;
  onWindowFocus: (focused: boolean) => void;
  watchRenderer: (contents: Electron.WebContents) => void;
  onDidStartLoading: () => void;
}

export class MainWindowController {
  private window: BrowserWindow | null = null;
  private currentPalette: PaletteId = DEFAULT_PALETTE;
  private currentUiScale = 1;

  constructor(private readonly opts: MainWindowOptions) {}

  getWindow(): BrowserWindow | null {
    return this.window;
  }

  focus(): void {
    if (!this.window) return;
    if (this.window.isMinimized()) this.window.restore();
    this.window.focus();
  }

  /** Syncs palette, UI scale, native theme source, zoom factor, and window chrome from settings. */
  applySettings(s: AppSettings): void {
    this.currentPalette = s.palette ?? DEFAULT_PALETTE;
    this.currentUiScale = s.typography?.uiScale ?? 1;
    nativeTheme.themeSource = themeSourceFor(s.theme);
    this.applyZoom();
    // Palette and interface size changes don't emit nativeTheme's updated event.
    this.applyChrome();
  }

  /**
   * Applies the interface size. The chrome's type is authored in fixed pixels, so zoom is what scales
   * it without breaking layout; it is reapplied after every load because a reload can reset it.
   */
  applyZoom(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const wc = this.window.webContents;
    if (Math.abs(wc.getZoomFactor() - this.currentUiScale) > 0.001) wc.setZoomFactor(this.currentUiScale);
  }

  /** Repaints the window background and the OS-drawn caption buttons for the active theme. */
  applyChrome(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const colors = this.chrome();
    this.window.setBackgroundColor(colors.color);
    if (process.platform === 'darwin') return;
    try {
      this.window.setTitleBarOverlay(this.titleBarOverlay(colors));
    } catch {
      // Older/unsupported platforms simply keep the colors they were created with.
    }
  }

  open(): void {
    const { opts } = this;
    const s = opts.settings.get();
    const bounds = s.windowBounds ?? { width: 1440, height: 900 };
    const icon = appIconPath(opts.appRoot);
    const colors = this.chrome();
    const win = new BrowserWindow({
      ...bounds,
      minWidth: 960,
      minHeight: 600,
      title: opts.appName,
      icon,
      backgroundColor: colors.color,
      // Frameless with an in-app title bar (sidebar toggle, history, menu bar). On Windows/Linux the
      // overlay keeps the native caption buttons — and with them snap layouts and double-click maximize.
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 12, y: (TITLEBAR_HEIGHT - 14) / 2 } }
        : { titleBarOverlay: this.titleBarOverlay(colors) }),
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: opts.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: true,
        // An off-screen window is never the foreground window, and throttling would stall the renders
        // and timers the suites wait on.
        backgroundThrottling: !opts.e2eQuiet
      }
    });
    if (process.platform === 'win32') {
      win.setAppDetails({ appId: opts.identity.appUserModelId, appIconPath: icon });
    }
    this.window = win;
    opts.log('debug', `window created ${bounds.width}x${bounds.height}${'x' in bounds && bounds.x !== undefined ? ` at ${bounds.x},${bounds.y}` : ''}`);
    win.once('ready-to-show', () => {
      opts.log('info', `window shown ${Math.round(process.uptime() * 1000)}ms after launch`);
      if (!opts.e2eQuiet) {
        win.show();
        return;
      }
      // Playwright can screenshot a shown window but not a hidden one, so this is off-screen rather
      // than hidden. `showInactive` shows it without activation, which is what keeps the focus put.
      const rect = win.getBounds();
      const displays = screen.getAllDisplays();
      const left = Math.min(...displays.map((d) => d.bounds.x));
      const top = Math.min(...displays.map((d) => d.bounds.y));
      win.setPosition(left - rect.width - 100, top + 50);
      win.setSkipTaskbar(true);
      win.showInactive();
    });
    win.on('closed', () => {
      opts.log('debug', 'window closed');
      this.window = null;
      // A closed window shows nothing: a turn that ends now was not seen, whatever the last blur said.
      opts.onWindowFocus(false);
    });
    // Presence for paired browsers: they follow the desktop only while its window is foregrounded.
    win.on('focus', () => opts.onWindowFocus(true));
    win.on('blur', () => opts.onWindowFocus(false));
    opts.watchRenderer(win.webContents);

    const saveBounds = () => {
      // The off-screen test position is not user intent; never write it back to settings.
      if (opts.e2eQuiet) return;
      if (win.isDestroyed() || win.isMinimized()) return;
      const b = win.getBounds();
      opts.settings
        .update({ windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height } })
        .catch((e) => opts.log('warn', `could not save window bounds: ${describeError(e)}`));
    };
    win.on('resize', debounce(saveBounds, 500));
    win.on('move', debounce(saveBounds, 500));

    // A renderer that dies leaves a blank window and, without this, no record of why. Reload it
    // (bounded) so a one-off crash self-heals and a crash loop says so in the log instead of
    // reloading forever.
    const recovery = new RendererRecovery({
      log: opts.log,
      reload: () => {
        if (!win.isDestroyed()) win.webContents.reload();
      }
    });
    win.webContents.on('render-process-gone', (_event, details) => recovery.gone(details.reason, details.exitCode));
    win.webContents.on('unresponsive', () => opts.log('warn', 'renderer unresponsive — the window is not painting or taking input'));
    win.webContents.on('responsive', () => opts.log('info', 'renderer responsive again'));
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // -3 is ERR_ABORTED: an in-page navigation (hash, redirect) that is not a failure.
      if (isMainFrame && errorCode !== -3) opts.log('error', `renderer failed to load ${validatedURL}: ${errorDescription} (${errorCode})`);
    });
    // A preload failure leaves the renderer with no IPC bridge.
    win.webContents.on('preload-error', (_event, preloadPath, error) => {
      opts.log('error', `preload script ${preloadPath} failed; the renderer has no IPC bridge: ${describeError(error)}`);
    });

    // A reload drops every xterm instance; stop streaming to it and let paused shells run until it re-attaches.
    win.webContents.on('did-start-loading', () => opts.onDidStartLoading());
    win.webContents.on('did-finish-load', () => this.applyZoom());

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    // The renderer is a single page: any navigation away from it (including relative file links
    // from rendered markdown) would leave the app unusable, so block everything but the page itself.
    win.webContents.on('will-redirect', (details) => {
      if (details.isMainFrame && details.url.split('#', 1)[0] !== opts.rendererDocument) details.preventDefault();
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (url.split('#', 1)[0] === opts.rendererDocument) return;
      e.preventDefault();
      opts.log('debug', `blocked in-app navigation to ${url.slice(0, 200)}${/^https?:\/\//i.test(url) ? ' (opened externally)' : ''}`);
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    });

    // Renderer console output. Errors and warnings always reach the main log — a packaged build has no
    // DevTools open, so a React render error or a failed fetch would otherwise vanish. Info/debug chatter
    // only with the debug flag. (Uncaught exceptions also arrive structured via app:log; the console
    // copy carries the source location Chromium attaches.)
    const forwardDebug = opts.isDev || !!process.env.VOCS_CODE_DEBUG;
    win.webContents.on('console-message', (event) => {
      const { level, message, lineNumber, sourceId } = event as unknown as { level: string | number; message: string; lineNumber: number; sourceId: string };
      const lvl = level === 'error' || level === 3 ? 'error' : level === 'warning' || level === 2 ? 'warn' : 'debug';
      if (lvl === 'debug' && !forwardDebug) return;
      opts.log(lvl, `[renderer console] ${message.slice(0, 4000)} (${sourceId}:${lineNumber})`);
    });
    if (process.env.VOCS_CODE_SCREENSHOT) {
      win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            const img = await win.webContents.capturePage();
            await import('node:fs/promises').then((fs) => fs.writeFile(process.env.VOCS_CODE_SCREENSHOT as string, img.toPNG()));
            opts.log('info', `screenshot written to ${process.env.VOCS_CODE_SCREENSHOT}`);
          } catch (e) {
            opts.log('error', `screenshot failed: ${String(e)}`);
          }
        }, Number(process.env.VOCS_CODE_SCREENSHOT_DELAY ?? 2500));
      });
    }

    if (opts.isDev) {
      void win.loadURL(opts.rendererEntry.href);
      win.webContents.openDevTools({ mode: 'detach' });
    } else {
      void win.loadFile(opts.rendererFile);
    }
  }

  /** Theme colors for the loading surface and the native caption glyphs. */
  private chrome() {
    return chromeFor(this.currentPalette, nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  }

  private titleBarOverlay({ color, symbolColor }: ReturnType<MainWindowController['chrome']>): Electron.TitleBarOverlay {
    if (process.platform === 'win32') {
      // Let the renderer paint the whole bar, including Zen, animated themes and modal scrims.
      // Electron measures the native hit area in DIPs, while the CSS bar also scales with page zoom.
      return { color: '#00000000', symbolColor, height: Math.round(TITLEBAR_HEIGHT * this.currentUiScale) };
    }
    return { color, symbolColor, height: TITLEBAR_HEIGHT };
  }
}

function debounce<T extends (...a: never[]) => void>(fn: T, ms: number): T {
  let t: NodeJS.Timeout | null = null;
  return ((...args: never[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}

export function resolvePreloadPath(mainDir: string): string {
  return path.join(mainDir, '../preload/index.cjs');
}
