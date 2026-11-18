/** Unit tests for the in-app update state machine (issue #198): transitions, error/timeout paths,
 *  and the idle-gating of the restart prompt. Drives the real UpdateService against a fake
 *  UpdaterFacade — no electron, keychain or settings coupling. */
import { describe, expect, it, vi } from 'vitest';
import type { UpdateProgress, UpdateState } from '../src/shared/types';
import { UpdateService, type UpdaterDeps, type UpdaterFacade } from '../src/main/updater';

type Handlers = {
  checking: Array<() => void>;
  available: Array<(version: string) => void>;
  notAvailable: Array<() => void>;
  progress: Array<(p: UpdateProgress) => void>;
  downloaded: Array<(version: string) => void>;
  error: Array<(message: string) => void>;
};

interface Fake {
  facade: UpdaterFacade;
  handlers: Handlers;
  checkForUpdates: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
  /** Fires a facade event. */
  emit(name: keyof Handlers, arg?: unknown): void;
}

function makeFacade(): Fake {
  const handlers: Handlers = { checking: [], available: [], notAvailable: [], progress: [], downloaded: [], error: [] };
  const checkForUpdates = vi.fn((): Promise<{ version?: string } | null> => Promise.resolve(null));
  const downloadUpdate = vi.fn((): Promise<void> => Promise.resolve());
  const quitAndInstall = vi.fn();
  const facade: UpdaterFacade = {
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    onChecking: (cb) => handlers.checking.push(cb),
    onAvailable: (cb) => handlers.available.push(cb),
    onNotAvailable: (cb) => handlers.notAvailable.push(cb),
    onProgress: (cb) => handlers.progress.push(cb),
    onDownloaded: (cb) => handlers.downloaded.push(cb),
    onError: (cb) => handlers.error.push(cb)
  };
  return {
    facade,
    handlers,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    emit(name, arg) {
      for (const cb of handlers[name]) (cb as (a?: unknown) => void)(arg);
    }
  };
}

function makeService(fake: Fake, opts?: { packaged?: boolean; live?: boolean; checkTimeoutMs?: number; downloadTimeoutMs?: number }) {
  const pushes: UpdateState[] = [];
  const logs: Array<[string, string]> = [];
  let live = opts?.live ?? false;
  const deps: UpdaterDeps = {
    facade: fake.facade,
    isPackaged: opts?.packaged ?? true,
    isAnySessionLive: () => live,
    push: (s) => pushes.push(s),
    log: (level, message) => logs.push([level, message]),
    checkTimeoutMs: opts?.checkTimeoutMs,
    downloadTimeoutMs: opts?.downloadTimeoutMs
  };
  return {
    service: new UpdateService(deps),
    pushes,
    logs,
    setLive(next: boolean) {
      live = next;
    }
  };
}

const PROGRESS: UpdateProgress = { percent: 42, bytesPerSecond: 1000, transferred: 420, total: 1000 };

describe('update state machine (packaged)', () => {
  it('never wires the facade or checks when unpackaged', () => {
    const fake = makeFacade();
    const { service } = makeService(fake, { packaged: false });
    expect(service.check()).toEqual({ status: 'idle' });
    expect(fake.checkForUpdates).not.toHaveBeenCalled();
    expect(Object.values(fake.handlers).every((list) => list.length === 0)).toBe(true);
  });

  it('downloads a newly found update once without a download request from the user', () => {
    const fake = makeFacade();
    const { service, pushes } = makeService(fake);
    expect(service.get()).toEqual({ status: 'idle' });

    // The check resolution arrives after the event; the machine keeps the event's state.
    fake.checkForUpdates.mockReturnValue(new Promise(() => undefined));
    expect(service.check()).toMatchObject({ status: 'checking' });
    fake.emit('checking');
    expect(service.get()).toMatchObject({ status: 'checking' });

    fake.emit('available', '0.3.0');
    expect(service.get()).toEqual({ status: 'downloading', version: '0.3.0' });
    expect(fake.downloadUpdate).toHaveBeenCalledTimes(1);

    fake.emit('progress', PROGRESS);
    expect(service.get()).toMatchObject({ status: 'downloading', progress: PROGRESS });

    fake.emit('downloaded', '0.3.0');
    expect(service.get()).toEqual({ status: 'restart-pending', version: '0.3.0' });
    // Nothing was held back: no session was live.
    expect(pushes.at(-1)).not.toHaveProperty('deferred', true);
  });

  it('checks at startup and once an hour while open, then stops on shutdown', () => {
    vi.useFakeTimers();
    try {
      const fake = makeFacade();
      const { service } = makeService(fake);
      fake.checkForUpdates.mockImplementation(async () => {
        fake.emit('notAvailable');
        return null;
      });

      service.startChecking();
      service.startChecking();
      vi.advanceTimersByTime(4_999);
      expect(fake.checkForUpdates).toHaveBeenCalledTimes(0);
      vi.advanceTimersByTime(1);
      expect(service.get().status).toBe('up-to-date');
      expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60 * 60_000);
      expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);

      service.stopChecking();
      vi.advanceTimersByTime(60 * 60_000);
      expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a downloaded update ready across later background and manual checks', () => {
    vi.useFakeTimers();
    try {
      const fake = makeFacade();
      const { service, pushes } = makeService(fake, { live: true });
      service.startChecking();
      vi.advanceTimersByTime(5_000);
      fake.emit('available', '0.3.0');
      fake.emit('downloaded', '0.3.0');
      const ready = { status: 'restart-pending', version: '0.3.0', deferred: true };
      expect(service.get()).toEqual(ready);
      const lastPush = pushes.length;

      vi.advanceTimersByTime(60 * 60_000);
      expect(service.check()).toEqual(ready);
      expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
      expect(fake.downloadUpdate).toHaveBeenCalledTimes(1);
      expect(pushes).toHaveLength(lastPush);
      expect(fake.quitAndInstall).toHaveBeenCalledTimes(0);
      service.stopChecking();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start a download from a check that finishes during shutdown', () => {
    const fake = makeFacade();
    const { service } = makeService(fake);
    service.check();
    service.stopChecking();
    fake.emit('available', '0.3.0');
    service.check();

    expect(fake.downloadUpdate).toHaveBeenCalledTimes(0);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('returns to up-to-date with a checkedAt when the feed has nothing newer', () => {
    const fake = makeFacade();
    const { service } = makeService(fake);
    fake.checkForUpdates.mockReturnValue(Promise.resolve(null));
    service.check();
    fake.emit('notAvailable');
    const state = service.get();
    expect(state.status).toBe('up-to-date');
    expect(state.checkedAt).toBeGreaterThan(0);
  });

  it('defers the restart prompt while a session is live and re-offers once idle', () => {
    const fake = makeFacade();
    const { service, pushes, setLive } = makeService(fake, { live: true });
    service.check();
    fake.emit('available', '0.3.0');
    fake.emit('downloaded', '0.3.0');
    expect(service.get()).toMatchObject({ status: 'restart-pending', deferred: true });

    // Still live: the fan-out keeps the prompt held, without re-pushing a copy.
    const before = pushes.length;
    service.notifySessionsChanged();
    expect(pushes.length).toBe(before);

    setLive(false);
    service.notifySessionsChanged();
    expect(service.get()).toEqual({ status: 'restart-pending', version: '0.3.0' });
    expect(pushes.at(-1)).toEqual({ status: 'restart-pending', version: '0.3.0' });
  });

  it('ignores events that arrive out of phase', () => {
    const fake = makeFacade();
    const { service } = makeService(fake);
    service.check();
    // A stray downloaded event before any download started must not move the machine.
    fake.emit('downloaded', '0.3.0');
    expect(service.get()).toMatchObject({ status: 'checking' });
    fake.emit('available', '0.3.0');
    expect(service.get()).toEqual({ status: 'downloading', version: '0.3.0' });
  });

  it('surfaces a facade error as the error status', () => {
    const fake = makeFacade();
    const { service, pushes } = makeService(fake);
    service.check();
    fake.emit('error', 'network unreachable');
    expect(service.get()).toEqual({ status: 'error', error: 'network unreachable' });
    expect(pushes.at(-1)).toEqual({ status: 'error', error: 'network unreachable' });
  });

  it('surfaces a rejected check promise as the error status', async () => {
    const fake = makeFacade();
    const { service, logs } = makeService(fake);
    fake.checkForUpdates.mockReturnValue(Promise.reject(new Error('feed offline')));
    service.check();
    await vi.waitFor(() => expect(service.get()).toEqual({ status: 'error', error: 'feed offline' }));
    expect(logs.some(([level, message]) => level === 'warn' && message.includes('feed offline'))).toBe(true);
  });

  it('times a check out when neither terminal event arrives', () => {
    vi.useFakeTimers();
    try {
      const fake = makeFacade();
      const { service } = makeService(fake, { checkTimeoutMs: 25 });
      fake.checkForUpdates.mockReturnValue(new Promise(() => undefined));
      service.check();
      vi.advanceTimersByTime(30);
      expect(service.get()).toEqual({ status: 'error', error: 'check timed out after 0s' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('times a download out when progress stops arriving', () => {
    vi.useFakeTimers();
    try {
      const fake = makeFacade();
      const { service } = makeService(fake, { downloadTimeoutMs: 500 });
      service.check();
      fake.emit('available', '0.3.0');
      vi.advanceTimersByTime(600);
      expect(service.get()).toEqual({ status: 'error', error: 'download stalled for over 1s' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('progress ticks re-arm the download stall timer', () => {
    vi.useFakeTimers();
    try {
      const fake = makeFacade();
      const { service } = makeService(fake, { downloadTimeoutMs: 500 });
      service.check();
      fake.emit('available', '0.3.0');
      vi.advanceTimersByTime(400);
      fake.emit('progress', PROGRESS);
      vi.advanceTimersByTime(400);
      expect(service.get()).toMatchObject({ status: 'downloading' });
      vi.advanceTimersByTime(200);
      expect(service.get()).toEqual({ status: 'error', error: 'download stalled for over 1s' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a rejected download promise as the error status', async () => {
    const fake = makeFacade();
    const { service } = makeService(fake);
    fake.downloadUpdate.mockImplementation(async () => { throw new Error('disk full'); });
    service.check();
    fake.emit('available', '0.3.0');
    await vi.waitFor(() => expect(service.get()).toEqual({ status: 'error', error: 'disk full' }));
  });

  it('does not stack a second check or download while one is running', () => {
    const fake = makeFacade();
    const { service } = makeService(fake);
    fake.checkForUpdates.mockReturnValue(new Promise(() => undefined));
    fake.downloadUpdate.mockReturnValue(new Promise(() => undefined));
    service.check();
    service.check();
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
    fake.emit('available', '0.3.0');
    fake.emit('available', '0.3.0');
    service.download();
    service.download();
    expect(fake.downloadUpdate).toHaveBeenCalledTimes(1);
    // A check while downloading is also a no-op.
    service.check();
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('download is only offered for an available update', () => {
    const fake = makeFacade();
    const { service } = makeService(fake);
    service.download();
    expect(fake.downloadUpdate).not.toHaveBeenCalled();
    expect(service.get()).toEqual({ status: 'idle' });
  });

  it('install only acts on a downloaded update', () => {
    const fake = makeFacade();
    const { service } = makeService(fake);
    service.install();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
    service.check();
    fake.emit('available', '0.3.0');
    service.install();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
    fake.emit('downloaded', '0.3.0');
    service.install();
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});
