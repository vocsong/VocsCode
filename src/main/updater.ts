/** In-app auto-update state machine (issue #198). Packaged builds check GitHub Releases through
 * electron-updater. This module owns the schedule and transitions, so tests drive it against a fake
 * facade with no electron, keychain or settings coupling. The electron-updater adapter lives in
 * ./updater-electron and is wired up in index.ts. */
import type { UpdateProgress, UpdateState } from '../shared/types';
import type { Logger } from './log';

const STARTUP_CHECK_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 60 * 60_000;
/** A check that produces neither terminal event within this window is treated as an error. */
const CHECK_TIMEOUT_MS = 30_000;
/** A download with no progress event for this long is treated as stuck (real feeds emit frequent ticks). */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** Low-level updater surface: electron-updater's autoUpdater in production, a fake in tests. */
export interface UpdaterFacade {
  /** Resolves when the check finishes; the events below carry the outcome. */
  checkForUpdates(): Promise<{ version?: string } | null>;
  downloadUpdate(): Promise<void>;
  /** Installs the downloaded update (spawning the installer) and quits the app. */
  quitAndInstall(): void;
  onChecking(cb: () => void): void;
  onAvailable(cb: (version: string) => void): void;
  onNotAvailable(cb: () => void): void;
  onProgress(cb: (progress: UpdateProgress) => void): void;
  onDownloaded(cb: (version: string) => void): void;
  onError(cb: (message: string) => void): void;
}

export interface UpdaterDeps {
  facade: UpdaterFacade;
  /** Packaged only; the facade is never wired up in dev. */
  isPackaged: boolean;
  /** A restart prompt waits until every session is out of a live turn. */
  isAnySessionLive: () => boolean;
  /** Publishes every state transition to the renderer. */
  push: (state: UpdateState) => void;
  log: Logger;
  checkTimeoutMs?: number;
  downloadTimeoutMs?: number;
}

export class UpdateService {
  private state: UpdateState = { status: 'idle' };
  /** Which awaitable the state machine is inside of; events are only honored in-phase. */
  private phase: 'none' | 'checking' | 'downloading' = 'none';
  /** Bumped on every phase change so late resolutions (a stale promise rejection) cannot clobber
   *  the state a newer phase already produced. */
  private epoch = 0;
  private timer: NodeJS.Timeout | null = null;
  private nextCheck: NodeJS.Timeout | undefined;
  private shuttingDown = false;

  constructor(private readonly deps: UpdaterDeps) {
    if (!deps.isPackaged) return;
    deps.facade.onChecking(() => {
      if (this.phase !== 'checking') return;
      this.setState({ ...this.state, status: 'checking' });
    });
    deps.facade.onAvailable((version) => {
      if (this.phase !== 'checking') return;
      this.endPhase();
      this.deps.log('info', `update available: ${version}`);
      this.setState({ status: 'available', version, progress: undefined, error: undefined, deferred: undefined });
      this.download();
    });
    deps.facade.onNotAvailable(() => {
      if (this.phase !== 'checking') return;
      this.endPhase();
      this.deps.log('info', 'no update available');
      this.setState({ status: 'up-to-date', version: undefined, progress: undefined, error: undefined, deferred: undefined, checkedAt: Date.now() });
    });
    deps.facade.onProgress((progress) => {
      if (this.phase !== 'downloading') return;
      // Progress ticks reset the stall timer.
      this.resetTimer();
      this.setState({ ...this.state, status: 'downloading', progress });
    });
    deps.facade.onDownloaded((version) => {
      if (this.phase !== 'downloading') return;
      this.endPhase();
      const deferred = this.deps.isAnySessionLive();
      this.deps.log('info', `update ${version} downloaded${deferred ? '; restart prompt deferred while a session is live' : ''}`);
      this.setState({ status: 'restart-pending', version, progress: undefined, error: undefined, deferred: deferred || undefined });
    });
    deps.facade.onError((m) => this.fail(m));
  }

  get(): UpdateState {
    return this.state;
  }

  startChecking(): void {
    if (!this.deps.isPackaged || this.nextCheck || this.shuttingDown) return;
    this.scheduleCheck(STARTUP_CHECK_DELAY_MS);
  }

  stopChecking(): void {
    this.shuttingDown = true;
    clearTimeout(this.nextCheck);
    this.nextCheck = undefined;
    if (this.phase === 'checking') this.endPhase();
  }

  /** Scheduled or user-initiated check. Keep an in-flight or downloaded update in place. */
  check(): UpdateState {
    if (!this.deps.isPackaged || this.shuttingDown || this.phase !== 'none' || this.state.status === 'restart-pending') return this.state;
    const at = ++this.epoch;
    this.phase = 'checking';
    this.setState({ status: 'checking', version: undefined, progress: undefined, error: undefined, deferred: undefined });
    const timeout = this.deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
    this.timer = setTimeout(() => this.fail(`check timed out after ${Math.round(timeout / 1000)}s`, at), timeout);
    this.deps.facade
      .checkForUpdates()
      .then(() => {
        // The terminal event ('update-available' / 'update-not-available') has usually landed by
        // now; the resolution just clears the trigger, so keep whatever state it produced.
        this.clearTrigger(at, 'checking');
      })
      .catch((e: unknown) => {
        this.fail(message(e), at);
      });
    return this.state;
  }

  /** Downloads an available update; the restart prompt is offered separately. */
  download(): UpdateState {
    if (!this.deps.isPackaged || this.phase !== 'none' || this.state.status !== 'available') return this.state;
    const at = ++this.epoch;
    this.phase = 'downloading';
    this.setState({ ...this.state, status: 'downloading', progress: undefined, error: undefined });
    const timeout = this.deps.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
    this.armStallTimer(at, timeout);
    this.deps.facade
      .downloadUpdate()
      .then(() => {
        this.clearTrigger(at, 'downloading');
      })
      .catch((e: unknown) => {
        this.fail(message(e), at);
      });
    return this.state;
  }

  /** Restarts to install: the facade spawns the installer first, then quits, so the app's own
   *  before-quit session drain still runs between the two. */
  install(): void {
    if (this.state.status !== 'restart-pending') return;
    this.deps.log('info', `installing update ${this.state.version ?? ''} and restarting`);
    this.deps.facade.quitAndInstall();
  }

  /** Called on every sessions fan-out: a held restart prompt is re-offered once the app is quiet. */
  notifySessionsChanged(): void {
    if (this.state.status !== 'restart-pending' || !this.state.deferred) return;
    if (this.deps.isAnySessionLive()) return;
    this.setState({ ...this.state, deferred: undefined });
    this.deps.log('info', 'all sessions idle; update prompt re-offered');
  }

  private scheduleCheck(delay: number): void {
    this.nextCheck = setTimeout(() => {
      this.scheduleCheck(CHECK_INTERVAL_MS);
      this.check();
    }, delay);
    this.nextCheck.unref();
  }

  /** A promise resolution whose phase already moved on (event arrived first) is a no-op. */
  private clearTrigger(at: number, phase: 'checking' | 'downloading'): void {
    if (at !== this.epoch || this.phase !== phase) return;
    this.phase = 'none';
    this.clearTimer();
  }

  /** Re-arms the stall watchdog on every progress tick; the epoch keeps a stale timer from
   *  clobbering the state of a newer phase. */
  private armStallTimer(at: number, timeout: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(`download stalled for over ${Math.round(timeout / 1000)}s`, at), timeout);
  }

  /** Errors and timeouts land here; a failure from an older epoch (or after a newer phase already
   *  replaced this one) is dropped so a stale error cannot clobber fresher state. */
  private fail(m: string, at?: number): void {
    if (at !== undefined && at !== this.epoch) return;
    this.phase = 'none';
    this.epoch++;
    this.clearTimer();
    this.setState({ status: 'error', error: m, progress: undefined });
    this.deps.log('warn', `update failed: ${m}`);
  }

  private endPhase(): void {
    this.phase = 'none';
    this.epoch++;
    this.clearTimer();
  }

  private resetTimer(): void {
    this.armStallTimer(this.epoch, this.deps.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private setState(next: UpdateState): void {
    // Drop undefined fields so transitions never leak stale keys into the pushed payload.
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) as UpdateState;
    this.state = clean;
    this.deps.push(clean);
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
