/**
 * Runtime diagnostics for an unresponsive window.
 *
 * Electron runs the main process on Chromium's UI thread, so a stalled event loop here is exactly a
 * window that stops dispatching input: clicks, typing and dropdowns all go dead until it unblocks.
 * The watchdog below turns that into a log line instead of a guess. The renderer reports its own
 * stalls through `app:diag` (see src/renderer/src/diag.ts), so the log says which side froze.
 */
import type { Logger } from './log';

/** How often the watchdog checks in. */
const TICK_MS = 250;
/** Delay beyond the tick that counts as a stall rather than ordinary scheduling noise. */
const STALL_MS = 1000;

export interface Watchdog {
  stop(): void;
}

export function watchEventLoop(log: Logger, tickMs = TICK_MS, stallMs = STALL_MS): Watchdog {
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - tickMs;
    last = now;
    if (lag >= stallMs) log('warn', `main event loop stalled ${lag}ms — the window accepted no input for that long`);
  }, tickMs);
  timer.unref(); // never keep the app alive for the watchdog
  return { stop: () => clearInterval(timer) };
}

/** Runs `fn`, logging a warning when it takes longer than `thresholdMs`. Errors still propagate. */
export async function timed<T>(log: Logger, label: string, thresholdMs: number, fn: () => Promise<T> | T): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    const ms = Date.now() - t0;
    if (ms >= thresholdMs) log('warn', `slow ${label}: ${ms}ms`);
  }
}
