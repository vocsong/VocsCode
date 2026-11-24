/**
 * Ordered, error-isolated graceful shutdown for main-process services.
 *
 * Kept Electron-free so teardown ordering, failure isolation, and the bounded timeout cap are
 * unit-tested directly without spinning up Electron.
 */
import { describeError, type Logger } from './log';

export const DEFAULT_SHUTDOWN_CAP_MS = 4000;

export interface ShutdownTargets {
  localControl: { shutdown(): void };
  keepAwake: { quit(): void };
  mission: { dispose(): void };
  updater?: { stopChecking(): void } | null;
  remoteMirror?: { stop(): void } | null;
  analyticsSync?: { stop(): void } | null;
  remoteHost?: { close(): void } | null;
  sessions?: {
    list(): Array<{ status: string }>;
    stopAll(): Promise<void>;
    flushPendingPersists(): Promise<void>;
  } | null;
  analytics: { flush(): Promise<void> };
  terminals?: {
    list(): unknown[];
    shutdown(deadline: number): Promise<void>;
  } | null;
  search?: { close(): Promise<void> | void } | null;
  intelligenceGateway?: { close(): Promise<void> | void } | null;
  missionGateway: { close(): Promise<void> | void };
  graphScheduler: { close(): Promise<void> | void };
  graphify: { cancel(): Promise<void> | void };
  passiveLearning?: { close(): Promise<void> | void } | null;
  memoryStore: { close(): Promise<void> | void };
  knowledgeUsage: { close(): Promise<void> | void };
  webServer?: { stop(): Promise<void> | void } | null;
  registry: { shutdown(): Promise<void> };
  sharedGitnexus: { stop(): void };
  processes: { close(): Promise<void> | void };
  log: Logger;
  capMs?: number;
}

export interface ShutdownResult {
  timedOut: boolean;
  durationMs: number;
}

/**
 * Stops every background service and flushes pending state before exit.
 *
 * Ordering guarantees:
 * 1. Synchronous stop hooks run before `sessions.stopAll()` so quitting is never mistaken for a
 *    Mission Builder finishing its turn and no background timers/sockets fire mid-teardown.
 * 2. `sessions.stopAll()` completes before `sessions.flushPendingPersists()` and `analytics.flush()`,
 *    with each step isolated so a failed stop never skips the persistence flushes after it.
 * 3. `passiveLearning.close()` settles before `memoryStore.close()`.
 * 4. The whole pass is bounded by `capMs` (default 4s) so a hung child cannot trap Electron open.
 */
export async function runGracefulShutdown(targets: ShutdownTargets): Promise<ShutdownResult> {
  const { log } = targets;
  const capMs = targets.capMs ?? DEFAULT_SHUTDOWN_CAP_MS;
  const safeSync = (label: string, fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      log('warn', `${label} during shutdown failed: ${describeError(error)}`);
    }
  };
  const safe = async (label: string, task: Promise<unknown> | void | undefined): Promise<void> => {
    try {
      await task;
    } catch (error) {
      log('warn', `${label} during shutdown failed: ${describeError(error)}`);
    }
  };
  const safeInvoke = (label: string, fn: () => Promise<unknown> | void | undefined): Promise<void> => {
    try {
      return safe(label, fn());
    } catch (error) {
      log('warn', `${label} during shutdown failed: ${describeError(error)}`);
      return Promise.resolve();
    }
  };

  safeSync('local control shutdown', () => targets.localControl.shutdown());
  safeSync('keep awake quit', () => targets.keepAwake.quit());
  // Before the sessions stop: quitting is not a Builder ending its turn, and the next launch
  // finds running missions interrupted from their records as they are now.
  safeSync('mission dispose', () => targets.mission.dispose());
  safeSync('updater stop', () => targets.updater?.stopChecking());
  safeSync('remote mirror stop', () => targets.remoteMirror?.stop());
  safeSync('analytics sync stop', () => targets.analyticsSync?.stop());
  safeSync('remote host close', () => targets.remoteHost?.close());

  const t0 = Date.now();
  const liveCount = targets.sessions?.list().filter((s) => s.status === 'running' || s.status === 'awaiting' || s.status === 'starting').length ?? 0;
  log('info', `quitting: ${liveCount} live session(s), ${targets.terminals?.list().length ?? 0} terminal tab(s)`);

  // Drain debounced session-meta persists after the sessions themselves are stopped. Restored
  // terminal snapshots are written first, and the cap ensures a large terminal set cannot hold
  // Electron open indefinitely.
  const deadline = t0 + capMs;
  const drainSessions = safeInvoke('session stop', () => targets.sessions?.stopAll()).then(async () => {
    await safeInvoke('session persist flush', () => targets.sessions?.flushPendingPersists());
    await safeInvoke('analytics flush', () => targets.analytics.flush());
  });

  const shutdown = Promise.all([
    safe('session drain', drainSessions),
    safeInvoke('terminal shutdown', () => targets.terminals?.shutdown(deadline)),
    safeInvoke('search close', () => targets.search?.close()),
    safeInvoke('intelligence gateway close', () => targets.intelligenceGateway?.close()),
    safeInvoke('mission gateway close', () => targets.missionGateway.close()),
    safe('Graphify shutdown', Promise.all([
      safeInvoke('graph scheduler close', () => targets.graphScheduler.close()),
      safeInvoke('graphify cancel', () => targets.graphify.cancel())
    ])),
    safeInvoke('passive learning close', () => targets.passiveLearning?.close()).finally(() =>
      safeInvoke('memory ledger close', () => targets.memoryStore.close())
    ),
    safeInvoke('knowledge usage flush', () => targets.knowledgeUsage.close()),
    safeInvoke('web server stop', () => targets.webServer?.stop()),
    safeInvoke('registry shutdown', () => targets.registry.shutdown()),
    safeInvoke('gitnexus shared stop', () => targets.sharedGitnexus.stop()),
    safeInvoke('process tracker close', () => targets.processes.close())
  ]);

  let capTimer: ReturnType<typeof setTimeout> | null = null;
  const cap = new Promise<boolean>((resolve) => {
    capTimer = setTimeout(() => resolve(true), capMs);
  });
  const timedOut = await Promise.race([
    shutdown.then(() => {
      if (capTimer) clearTimeout(capTimer);
      return false;
    }),
    cap
  ]);
  const durationMs = Date.now() - t0;
  if (timedOut) {
    log('warn', `shutdown exceeded the ${capMs}ms cap; exiting with any remaining state left for the next launch`);
  } else {
    log('info', `shutdown complete in ${durationMs}ms`);
  }
  return { timedOut, durationMs };
}
