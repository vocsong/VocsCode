/**
 * Offline-mirror HTTP publication and clear-retry state machine for RemoteHost.
 *
 * Guarantees that no upload lands alongside blobs a clear should have removed, coalesces
 * concurrent clear retries, and schedules a single delayed repeat clear if an upload failed
 * in transit without an HTTP answer.
 */
import type { SealedBlob } from '../../shared/crypto';
import type { RemoteAudit } from './audit';

/** A mirror clear the relay did not confirm is retried after this, doubling up to the cap. */
const MIRROR_CLEAR_RETRY_MS = 15_000;
const MIRROR_CLEAR_RETRY_MAX_MS = 5 * 60_000;
/** After a mirror upload failed in transit, a clear is repeated once after this delay, in case
 *  the request still reaches the relay after the first clear. */
const MIRROR_LATE_WRITE_MS = 5_000;

/** A mirror upload whose publication went stale (mirroring off, re-keyed, host gone) before its
 *  request left: it is dropped, not sent. */
export class MirrorWriteSuperseded extends Error {
  constructor() {
    super('mirror upload superseded');
  }
}

export interface RemoteMirrorTransportDeps {
  enrolled: () => boolean;
  isOff: () => boolean;
  relayFetch: (path: string, init?: RequestInit, proceed?: () => boolean) => Promise<Response>;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  audit?: RemoteAudit;
  retryMs?: number;
  lateWriteMs?: number;
}

export class RemoteMirrorTransport {
  /** Mirror uploads between their fence check and the relay's answer; a clear waits for them so
   *  it always lands after them. */
  private readonly writes = new Set<Promise<unknown>>();
  /** A mirror upload ended without an HTTP answer: its request may still reach the relay later,
   *  so the next successful clear is repeated once after a short delay. */
  private writeUncertain = false;
  /** Mirror clears asked for, and the newest one the relay confirmed. While they differ the relay
   *  may still hold blobs that should be gone: uploads wait for the clear first, and a timer
   *  retries it in the meantime. */
  private clearsRequested = 0;
  private clearedThrough = 0;
  /** The one clear run in progress, if any: every retry and every waiting upload joins it rather
   *  than sending a DELETE of its own. */
  private clearing: Promise<boolean> | null = null;
  /** A repeat clear for an upload that failed in transit is not sent before this time. */
  private clearNotBefore = 0;
  private clearFailing = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 0;

  constructor(private readonly deps: RemoteMirrorTransportDeps) {}

  /** Publishes a sealed mirror blob to the relay. False when not enrolled, when a mirror clear the
   *  relay has not confirmed still fails, when `current` reports the upload went stale (asked
   *  after every wait, right before the request leaves), or when the relay refused it. */
  async put(kind: 'index' | 'session', sessionId: string | undefined, blob: SealedBlob, current: () => boolean = () => true): Promise<boolean> {
    if (!this.deps.enrolled()) return false;
    // Nothing new lands next to blobs a clear should have removed: wait until no clear is owed.
    // The write below is registered synchronously after this loop, so any later clear waits for it.
    while (this.clearing || this.clearPending()) {
      if (!(await this.runOwedClear())) return false;
    }
    if (!current()) return false;
    const path = kind === 'index' ? '/v1/mirror' : `/v1/mirror/${encodeURIComponent(sessionId ?? '')}`;
    const write = this.deps.relayFetch(
      path,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(blob) },
      current
    );
    this.writes.add(write);
    let res: Response | null;
    try {
      res = await write;
    } catch (e) {
      if (e instanceof MirrorWriteSuperseded) return false;
      // No HTTP answer: the request may still be delivered, after a clear that follows.
      this.writeUncertain = true;
      res = null;
    } finally {
      this.writes.delete(write);
    }
    if (!res?.ok) this.deps.log('warn', `remote: mirror upload refused (${res?.status ?? 'network error'})`);
    return !!res?.ok;
  }

  /** Drops the whole mirror at the relay (mirroring turned off, or the key rotated). Waits for
   *  uploads already on their way so the clear lands after them. False when the relay did not
   *  confirm it: the failure is logged and audited, and the clear is retried (on a timer, on the
   *  next connect, and before the next upload) until the relay confirms it. */
  async clear(): Promise<boolean> {
    this.clearsRequested++;
    return this.runOwedClear();
  }

  /** Retries an owed clear once the relay connection is back online. */
  flushIfPending(): void {
    if (this.clearPending()) void this.runOwedClear();
  }

  cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearPending(): boolean {
    return this.clearedThrough < this.clearsRequested;
  }

  /** Runs the clear that is owed, or joins the run already in progress: retries never stack
   *  DELETEs. True once nothing is owed; false when the relay did not confirm it. */
  private runOwedClear(fromTimer = false): Promise<boolean> {
    if (!this.clearing) {
      const finish = (ok: boolean) => {
        if (this.clearing === run) this.clearing = null;
        return ok;
      };
      const run: Promise<boolean> = this.runClears(fromTimer).then(finish, (e: unknown) => {
        this.deps.log('warn', `remote: mirror clear failed: ${e instanceof Error ? e.message : String(e)}`);
        this.scheduleRetry(false);
        return finish(false);
      });
      this.clearing = run;
    }
    return this.clearing;
  }

  private async runClears(fromTimer: boolean): Promise<boolean> {
    while (this.clearPending()) {
      if (!(await this.attemptClear(fromTimer))) return false;
      fromTimer = false;
    }
    return true;
  }

  /** One DELETE covering every clear asked for before it is sent. */
  private async attemptClear(fromTimer: boolean): Promise<boolean> {
    this.cancelRetry();
    // Not enrolled: nothing of this desktop's is reachable, and the relay drops a revoked
    // desktop's mirror along with it.
    if (!this.deps.enrolled()) {
      this.clearedThrough = this.clearsRequested;
      this.clearNotBefore = 0;
      this.clearSucceeded();
      return true;
    }
    const repeat = this.clearNotBefore > 0;
    const wait = this.clearNotBefore - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    await Promise.allSettled([...this.writes]);
    const uncertain = this.writeUncertain;
    this.writeUncertain = false;
    const target = this.clearsRequested;
    try {
      const res = await this.deps.relayFetch('/v1/mirror', { method: 'DELETE' });
      if (!res.ok) throw new Error(`relay answered ${res.status}`);
    } catch (e) {
      this.writeUncertain ||= uncertain;
      const why = e instanceof Error ? e.message : String(e);
      this.deps.log('warn', `remote: mirror clear failed, will retry: ${why}`);
      if (!this.clearFailing) this.deps.audit?.record('mirror-clear-failed', { detail: why });
      this.clearFailing = true;
      this.scheduleRetry(fromTimer);
      return false;
    }
    this.clearedThrough = Math.max(this.clearedThrough, target);
    this.clearNotBefore = 0;
    if (uncertain && !repeat) {
      // An upload that failed in transit may still land after this DELETE: owe one more clear,
      // sent after a short delay (once; the repeat does not schedule another).
      this.clearsRequested++;
      this.clearNotBefore = Date.now() + (this.deps.lateWriteMs ?? MIRROR_LATE_WRITE_MS);
    }
    this.clearSucceeded();
    return true;
  }

  private clearSucceeded(): void {
    this.retryDelay = 0;
    if (this.clearFailing) {
      this.clearFailing = false;
      this.deps.log('info', 'remote: mirror clear succeeded on retry');
      this.deps.audit?.record('mirror-clear-recovered');
    }
  }

  /** Arms the retry timer for an owed clear. Only a failed timer attempt lengthens the delay; an
   *  attempt an upload started re-arms it at the current delay. Nothing is armed while remote
   *  access is paused: the next connect or upload retries instead. */
  private scheduleRetry(backoff: boolean): void {
    if (this.retryTimer || this.deps.isOff()) return;
    const first = this.deps.retryMs ?? MIRROR_CLEAR_RETRY_MS;
    if (!this.retryDelay) this.retryDelay = first;
    else if (backoff) this.retryDelay = Math.min(this.retryDelay * 2, Math.max(first, MIRROR_CLEAR_RETRY_MAX_MS));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.clearPending()) void this.runOwedClear(true);
    }, this.retryDelay);
    this.retryTimer.unref?.();
  }
}
