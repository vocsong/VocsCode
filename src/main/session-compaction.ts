/**
 * Manual and automatic context compaction controller for SessionManager.
 *
 * Coordinates both app-requested idle-boundary compaction and native token-window sync for
 * harnesses that compact internally (`setAutoCompactionWindow`).
 */
import type { AppSettings, SessionMeta, UsageTotals } from '../shared/types';
import {
  autoCompactionThresholdLabel,
  autoCompactionTokenThreshold,
  hasReachedAutoCompactionThreshold
} from '../shared/compaction';
import type { ActiveSession } from './session-types';
import { errorMessage } from './util/async';

const AUTO_COMPACTION_RETRY_MS = 30_000;

export interface SessionCompactionHost {
  assertNotControlled(id: string): void;
  isControlled(id: string): boolean;
  getActive(id: string): ActiveSession | undefined;
  getSession(id: string): SessionMeta | undefined;
  settings(): AppSettings;
  note(id: string, text: string, level?: 'info' | 'warn' | 'error'): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

export class SessionCompactionController {
  constructor(private readonly host: SessionCompactionHost) {}

  async compact(id: string): Promise<{ ok: boolean; detail?: string }> {
    this.host.assertNotControlled(id);
    const active = this.host.getActive(id);
    if (!active) return { ok: false, detail: 'Session is not running.' };
    if (active.tearingDown || active.uncertain) return { ok: false, detail: 'Session runtime is stopping or uncertain.' };
    if (!active.adapter.compact) return { ok: false, detail: 'This harness does not support compaction.' };
    if (active.compactionInFlight) return { ok: false, detail: 'Context compaction is already in progress.' };
    const threshold = this.host.settings().autoCompactionThreshold;
    const meta = this.host.getSession(id);
    active.autoCompactionThreshold = threshold;
    if (threshold && meta && hasReachedAutoCompactionThreshold(threshold, meta.usage)) active.autoCompactionLatched = true;
    this.host.log('info', `[${id}] manual context compaction requested (context ${meta?.usage.contextTokens ?? '?'} tokens)`);
    const operation = active.adapter.compact();
    active.compactionInFlight = operation;
    try {
      const compacted = await operation;
      if (compacted === false) {
        active.autoCompactionLatched = false;
        active.autoCompactionRetryAt = Date.now() + AUTO_COMPACTION_RETRY_MS;
        this.scheduleRetry(id, active);
        this.host.log('info', `[${id}] compaction skipped: not enough history yet`);
        return { ok: false, detail: 'There is not enough conversation history to compact yet.' };
      }
      this.host.log('info', `[${id}] compaction completed`);
      return { ok: true };
    } catch (e) {
      active.autoCompactionLatched = false;
      active.autoCompactionRetryAt = Date.now() + AUTO_COMPACTION_RETRY_MS;
      this.scheduleRetry(id, active);
      this.host.log('warn', `[${id}] compaction failed: ${errorMessage(e)}`);
      throw e;
    } finally {
      if (active.compactionInFlight === operation) active.compactionInFlight = null;
    }
  }

  /** Wait until adapter queue bookkeeping has settled, then compact once at a safe idle boundary. */
  scheduleAuto(id: string): void {
    const active = this.host.getActive(id);
    // An engine that compacts itself still needs the window kept in step with the setting, and it
    // has to be told when the user clears the setting, so this cannot be gated on a threshold alone.
    if (!active) return;
    if (!this.host.settings().autoCompactionThreshold && !active.adapter.setAutoCompactionWindow) return;
    queueMicrotask(() => void this.maybeAutoCompact(id));
  }

  /** Updates latch/retry state when a usage event arrives and triggers native/idle sync. */
  onUsage(meta: SessionMeta, active: ActiveSession | undefined, totals: UsageTotals): void {
    const threshold = this.host.settings().autoCompactionThreshold;
    if (active) {
      if (active.autoCompactionThreshold !== threshold) {
        active.autoCompactionThreshold = threshold;
        active.autoCompactionLatched = false;
        this.clearRetry(active);
      }
      if (!threshold || !hasReachedAutoCompactionThreshold(threshold, totals)) {
        active.autoCompactionLatched = false;
        this.clearRetry(active);
      }
    }
    // An engine that compacts itself needs its window before the turn grows, not after it ends.
    if (meta.status === 'idle' || active?.adapter.setAutoCompactionWindow) this.scheduleAuto(meta.id);
  }

  clearRetry(active: ActiveSession): void {
    if (active.autoCompactionRetryTimer) clearTimeout(active.autoCompactionRetryTimer);
    active.autoCompactionRetryTimer = null;
    active.autoCompactionRetryAt = 0;
  }

  private scheduleRetry(id: string, active: ActiveSession): void {
    if (!this.host.settings().autoCompactionThreshold || active.autoCompactionRetryTimer) return;
    const delay = Math.max(0, active.autoCompactionRetryAt - Date.now());
    active.autoCompactionRetryTimer = setTimeout(() => {
      active.autoCompactionRetryTimer = null;
      if (this.host.getActive(id) === active) void this.maybeAutoCompact(id);
    }, delay);
    active.autoCompactionRetryTimer.unref?.();
  }

  /**
   * Hand the token window to an engine that compacts itself, and keep the engine's own default when
   * the user has not chosen a threshold. A threshold whose percentage cannot be resolved yet (no
   * reported context window) is not pushed as a clear, which would disable the engine's default.
   * The window is recorded before the call and rolled back if the engine rejects it, so usage
   * reports arriving while it is in flight cannot queue the same setting up twice.
   */
  private async syncNativeAutoCompaction(id: string, active: ActiveSession, tokens: number | undefined): Promise<void> {
    const pushed = active.autoCompactionWindow;
    if (tokens === undefined && pushed === undefined) return;
    if (tokens === pushed) return;
    active.autoCompactionWindow = tokens;
    try {
      await active.adapter.setAutoCompactionWindow?.(tokens);
      this.host.log('info', `[${id}] auto-compaction window ${pushed ?? 'harness default'} → ${tokens ?? 'harness default'}`);
    } catch (e) {
      // Unremembered, so the next usage report tries again rather than settling for a window the
      // engine never took.
      active.autoCompactionWindow = pushed;
      this.host.log('warn', `[${id}] auto-compaction window rejected: ${errorMessage(e)}`);
    }
  }

  private async maybeAutoCompact(id: string): Promise<void> {
    if (this.host.isControlled(id)) return;
    const active = this.host.getActive(id);
    const meta = this.host.getSession(id);
    const threshold = this.host.settings().autoCompactionThreshold;
    // A cleared threshold is not a no-op: an engine that was handed a window has to be told.
    if (!active || !meta || active.tearingDown || active.uncertain) return;
    if (active.autoCompactionThreshold !== threshold) {
      active.autoCompactionThreshold = threshold;
      active.autoCompactionLatched = false;
      this.clearRetry(active);
    }
    // Engines that compact themselves are configured, not asked. Requesting compaction from here
    // would also be the wrong moment for them: this runs at an idle boundary, and an idle engine has
    // nothing to compact, while the CLI reduces context from inside the turn that needs it.
    if (active.adapter.setAutoCompactionWindow) {
      const window = threshold ? autoCompactionTokenThreshold(threshold, meta.usage) : undefined;
      // A percentage whose context window is still unknown is not a clear: wait for the number.
      if (threshold && window === undefined) return;
      await this.syncNativeAutoCompaction(id, active, window);
      return;
    }
    if (!threshold) {
      active.autoCompactionLatched = false;
      this.clearRetry(active);
      return;
    }
    if (!hasReachedAutoCompactionThreshold(threshold, meta.usage)) {
      active.autoCompactionLatched = false;
      this.clearRetry(active);
      return;
    }
    if (
      !active.adapter.compact ||
      active.autoCompactionLatched ||
      active.compactionInFlight ||
      active.starting ||
      active.adapter.busy ||
      meta.status !== 'idle' ||
      (meta.queued ?? 0) > 0
    ) {
      return;
    }
    if (Date.now() < active.autoCompactionRetryAt) {
      this.scheduleRetry(id, active);
      return;
    }
    active.autoCompactionLatched = true;
    this.host.note(id, `Automatic context compaction requested at ${autoCompactionThresholdLabel(threshold)}.`);
    const operation = active.adapter.compact();
    active.compactionInFlight = operation;
    try {
      const compacted = await operation;
      if (this.host.getActive(id) !== active || active.tearingDown) return;
      if (compacted === false) {
        active.autoCompactionLatched = false;
        active.autoCompactionRetryAt = Date.now() + AUTO_COMPACTION_RETRY_MS;
        this.scheduleRetry(id, active);
        this.host.note(id, 'Automatic context compaction is waiting for more conversation history.');
      }
    } catch (e) {
      if (this.host.getActive(id) !== active || active.tearingDown) return;
      active.autoCompactionLatched = false;
      active.autoCompactionRetryAt = Date.now() + AUTO_COMPACTION_RETRY_MS;
      this.scheduleRetry(id, active);
      const message = errorMessage(e);
      this.host.log('warn', `[${id}] automatic compaction failed: ${message}`);
      this.host.note(id, `Automatic context compaction failed: ${message}`, 'warn');
    } finally {
      if (active.compactionInFlight === operation) {
        active.compactionInFlight = null;
      }
    }
  }
}
