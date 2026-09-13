/**
 * Bounded auto-reload for a dead renderer.
 *
 * Electron does not bring a crashed renderer back: the window keeps its frame and shows a blank
 * page forever, and unless the app listens for `render-process-gone` nothing is written anywhere.
 * This policy decides when to reload. Electron-free so the decision is unit-testable; index.ts
 * wires the window events to it.
 */
import type { Logger } from './log';

export interface RendererRecoveryOptions {
  log: Logger;
  /** Reload the window that lost its renderer. */
  reload: () => void;
  /** Reloads allowed within the window before giving up; default 3. */
  limit?: number;
  /** Crashes older than this no longer count toward the limit; default 5 minutes. */
  windowMs?: number;
  now?: () => number;
}

/** Reasons that mean the process died while its window is still open. A window being closed emits
 *  `clean-exit` or `killed`, which must not trigger a reload. */
const DEAD_LIKE = new Set(['crashed', 'oom', 'abnormal-exit', 'launch-failed', 'integrity-failure']);

export class RendererRecovery {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly reload: () => void;
  private crashes: number[] = [];

  constructor(opts: RendererRecoveryOptions) {
    this.limit = opts.limit ?? 3;
    this.windowMs = opts.windowMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
    this.reload = opts.reload;
  }

  /**
   * Record a `render-process-gone` reason. Reloads while the recent crash count is at or under the
   * limit, so a one-off crash self-heals and a crash loop is reported instead of spinning. Returns
   * whether a reload was triggered.
   */
  gone(reason: string, exitCode: number): boolean {
    if (!DEAD_LIKE.has(reason)) {
      this.log('info', `renderer process gone: ${reason} (exit ${exitCode})`);
      return false;
    }
    const now = this.now();
    this.crashes = this.crashes.filter((at) => now - at < this.windowMs);
    this.crashes.push(now);
    const recent = this.crashes.length;
    if (recent > this.limit) {
      this.log('error', `renderer process gone: ${reason} (exit ${exitCode}); ${recent} crashes within ${Math.round(this.windowMs / 60_000)} minutes, not reloading — restart the app`);
      return false;
    }
    this.log('error', `renderer process gone: ${reason} (exit ${exitCode}); reloading (${recent}/${this.limit})`);
    this.reload();
    return true;
  }
}
