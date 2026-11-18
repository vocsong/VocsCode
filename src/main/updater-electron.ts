/** The electron-updater side of the update service: adapts autoUpdater's events and calls to the
 *  UpdaterFacade interface, keeping src/main/updater.ts free of electron imports (and unit-testable).
 *  GitHub Releases is the feed; `app-update.yml` written by electron-builder points at it. */
import electronUpdater from 'electron-updater';
import type { UpdateInfo } from 'electron-updater';
import type { UpdateProgress } from '../shared/types';
import type { UpdaterFacade } from './updater';
import type { Logger } from './log';

// electron-updater is CommonJS; the named export must be picked off the default import or the ESM
// main bundle fails to load at startup.
const { autoUpdater } = electronUpdater;

export function electronUpdaterFacade(log: Logger): UpdaterFacade {
  // UpdateService starts the download so it can track progress and timeouts. Keep the
  // library's install-on-quit behavior for downloaded updates.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m) => log('debug', `[updater] ${String(m)}`),
    warn: (m) => log('warn', `[updater] ${String(m)}`),
    error: (m) => log('warn', `[updater] ${String(m)}`),
    debug: (m) => log('debug', `[updater] ${String(m)}`)
  };
  const versionOf = (info: UpdateInfo): string => info.version;
  return {
    checkForUpdates: () =>
      autoUpdater.checkForUpdates().then((r) => (r ? { version: versionOf(r.updateInfo) } : null)),
    downloadUpdate: () =>
      new Promise<void>((resolve, reject) => {
        const p = autoUpdater.downloadUpdate();
        if (!p) {
          reject(new Error('no update available to download'));
          return;
        }
        p.then(() => resolve(), reject);
      }),
    quitAndInstall: () => autoUpdater.quitAndInstall(false, true),
    onChecking: (cb) => autoUpdater.on('checking-for-update', () => cb()),
    onAvailable: (cb) => autoUpdater.on('update-available', (info) => cb(versionOf(info as UpdateInfo))),
    onNotAvailable: (cb) => autoUpdater.on('update-not-available', () => cb()),
    onProgress: (cb) =>
      autoUpdater.on('download-progress', (p) =>
        cb({
          percent: p.percent,
          bytesPerSecond: p.bytesPerSecond,
          transferred: p.transferred,
          total: p.total
        } satisfies UpdateProgress)
      ),
    onDownloaded: (cb) =>
      autoUpdater.on('update-downloaded', (info) => {
        cb(versionOf(info as UpdateInfo));
      }),
    onError: (cb) => autoUpdater.on('error', (e) => cb(e instanceof Error ? e.message : String(e)))
  };
}
