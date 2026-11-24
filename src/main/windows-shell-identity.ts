/** Windows taskbar AUMID registration, dev Start Menu shortcut reconciliation, and app icon resolution. */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';
import { PRODUCT_APP_ID, type AppIdentity } from './identity';
import type { Logger } from './log';

/** Resolve the same icon in development and in the packaged app's extra resources. */
export function appIconPath(appRoot: string): string {
  const iconName = process.platform === 'win32' ? 'vocs-code.ico' : 'vocs-code.png';
  const iconRoot = app.isPackaged ? path.join(process.resourcesPath, 'icons') : path.join(appRoot, 'resources', 'icons');
  return path.join(iconRoot, iconName);
}

/** Write the AUMID's DisplayName/IconUri so the Windows taskbar menu shows this run's name, not 'Electron'. */
export function registerAppUserModelId(appRoot: string, identity: AppIdentity, log: Logger): void {
  if (process.platform !== 'win32') return;
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${identity.appUserModelId}`;
  const values: Array<[string, string]> = [
    ['DisplayName', identity.displayName],
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
  reconcileDevShortcut(appRoot, identity, log);
}

/**
 * The shell resolves an AUMID's display name from a matching Start Menu shortcut before the registry,
 * so in development we keep a correctly named 'Vocs Code (Dev)' shortcut and drop stale ones (e.g. a
 * leftover 'Electron.lnk' from an earlier dev run) that would make the taskbar menu say 'Electron'.
 * NSIS owns the installed app's 'Vocs Code' shortcut, so this only runs unpackaged and never writes
 * its name.
 */
function reconcileDevShortcut(appRoot: string, identity: AppIdentity, log: Logger): void {
  if (app.isPackaged) return;
  const menu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const exe = process.execPath.toLowerCase();
  const lnk = path.join(menu, identity.shortcutFile);
  try {
    for (const entry of readdirSync(menu)) {
      const file = path.join(menu, entry);
      if (file === lnk || !entry.toLowerCase().endsWith('.lnk')) continue;
      try {
        const shortcut = shell.readShortcutLink(file);
        // Only remove shortcuts that point at *this* repo's Electron. The installed app's own Start
        // Menu entry targets its install path, so it is never touched; anything else carrying one of
        // our AUMIDs is a leftover dev shortcut — including one an older build wrote over the
        // installed app's 'Vocs Code.lnk'.
        const ours = shortcut.appUserModelId === PRODUCT_APP_ID || shortcut.appUserModelId === identity.appUserModelId;
        if (ours && shortcut.target.toLowerCase() === exe) rmSync(file, { force: true });
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
      description: identity.displayName,
      icon: appIconPath(appRoot),
      iconIndex: 0,
      appUserModelId: identity.appUserModelId
    };
    // 'replace' only overwrites an existing shortcut; fall back to 'create' on the first run.
    if (!shell.writeShortcutLink(lnk, existsSync(lnk) ? 'replace' : 'create', options)) {
      log('warn', "could not write the dev Start Menu shortcut; taskbar icon may fall back to Electron's");
    }
  } catch {
    // Best effort: without the shortcut the registry DisplayName above still names the taskbar menu.
  }
}
