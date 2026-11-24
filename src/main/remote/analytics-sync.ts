/**
 * Uploads this computer's analytics snapshot to the relay for the code.vocs.io dashboard
 * (docs/WEB-DASHBOARD.md §5). On by default for a computer connected through Connect with Vocs;
 * turning sharing off deletes the relay copy.
 *
 * One sync at a time: read the relay's manifest once (so a restart does not re-upload unchanged
 * parts), upload the parts whose hash changed, then commit the manifest that lists them. The
 * manifest is committed even when nothing changed, as the heartbeat behind "synced 4 min ago".
 */
import { encodeSnapshot } from '../../shared/analytics/snapshot-codec';
import type { AnalyticsSnapshot } from '../../shared/analytics/snapshot';
import type { AnalyticsSnapshotManifest, SnapshotPartRef } from '../../shared/analytics/snapshot-wire';

/** Coalesces bursts of activity: a sync at most every two minutes while work is going on. */
export const ANALYTICS_DEBOUNCE_MS = 2 * 60_000;
/** Keeps "last synced" fresh while the computer is idle. */
export const ANALYTICS_HEARTBEAT_MS = 60 * 60_000;
/** The first sync after start or connect, once startup work has settled. */
export const ANALYTICS_FIRST_SYNC_MS = 15_000;

export interface AnalyticsSyncDeps {
  /** The projected snapshot (AnalyticsStore.snapshot). */
  snapshot: () => AnalyticsSnapshot;
  /** An authenticated relay call as this desktop, or null while it is not connected and registered. */
  request: (path: string, init?: RequestInit) => Promise<Response | null>;
  /** Whether sharing is on (the setting, default true). */
  sharing: () => boolean;
  log: (level: 'debug' | 'info' | 'warn', message: string) => void;
  /** Test hooks. */
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; setInterval: typeof setInterval; clearInterval: typeof clearInterval };
}

export type SyncOutcome = 'uploaded' | 'cleared' | 'skipped' | 'failed';

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export class AnalyticsSync {
  /** The parts the relay holds under the committed manifest, by id; null until read back. */
  private uploaded: Map<string, SnapshotPartRef> | null = null;
  private running: Promise<SyncOutcome> | null = null;
  private again = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** A clear the relay has not confirmed; retried until it is. */
  private clearOwed = false;
  private readonly timers: NonNullable<AnalyticsSyncDeps['timers']>;

  constructor(private readonly deps: AnalyticsSyncDeps) {
    this.timers = deps.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
  }

  /** Starts the heartbeat and schedules a first sync (or, with sharing off, a clear). */
  start(): void {
    if (!this.heartbeat) this.heartbeat = this.timers.setInterval(() => void this.sync(), ANALYTICS_HEARTBEAT_MS);
    // With sharing off at start, a copy left by an earlier run (or a clear that never landed) goes.
    if (!this.deps.sharing()) this.clearOwed = true;
    this.schedule(ANALYTICS_FIRST_SYNC_MS);
  }

  stop(): void {
    if (this.heartbeat) this.timers.clearInterval(this.heartbeat);
    if (this.debounce) this.timers.clearTimeout(this.debounce);
    this.heartbeat = null;
    this.debounce = null;
  }

  /** Something the dashboard counts changed; sync within the debounce window. */
  notify(): void {
    if (!this.debounce) this.schedule(ANALYTICS_DEBOUNCE_MS);
  }

  /** The connection to the relay came (back) up: the relay may have lost or gained state. */
  connected(): void {
    this.uploaded = null;
    this.schedule(ANALYTICS_FIRST_SYNC_MS);
  }

  /** Sharing was turned on or off. Off deletes the relay copy now. */
  async sharingChanged(): Promise<SyncOutcome> {
    if (!this.deps.sharing()) this.clearOwed = true;
    return this.sync();
  }

  private schedule(ms: number): void {
    if (this.debounce) this.timers.clearTimeout(this.debounce);
    this.debounce = this.timers.setTimeout(() => {
      this.debounce = null;
      void this.sync();
    }, ms);
  }

  /** Runs one sync, or queues one more behind the sync in flight. */
  sync(): Promise<SyncOutcome> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.sync();
      }
    });
    return this.running;
  }

  private async run(): Promise<SyncOutcome> {
    try {
      if (!this.deps.sharing()) return await this.clear();
      return await this.upload(true);
    } catch (e) {
      this.deps.log('warn', `analytics sync failed: ${e instanceof Error ? e.message : String(e)}`);
      return 'failed';
    }
  }

  private async clear(): Promise<SyncOutcome> {
    if (!this.clearOwed) return 'skipped';
    const res = await this.deps.request('/v1/analytics', { method: 'DELETE' });
    if (!res) return 'skipped';
    if (!res.ok) throw new Error(`relay refused the clear (${res.status})`);
    this.clearOwed = false;
    this.uploaded = new Map();
    this.deps.log('info', 'analytics: stopped sharing; the relay copy was deleted');
    return 'cleared';
  }

  private async readUploaded(): Promise<Map<string, SnapshotPartRef> | null> {
    if (this.uploaded) return this.uploaded;
    const res = await this.deps.request('/v1/analytics');
    if (!res) return null;
    if (!res.ok) throw new Error(`relay manifest read failed (${res.status})`);
    const body = (await res.json()) as { manifest?: AnalyticsSnapshotManifest | null };
    this.uploaded = new Map((body.manifest?.parts ?? []).map((p) => [p.id, p]));
    return this.uploaded;
  }

  private async upload(retry: boolean): Promise<SyncOutcome> {
    const uploaded = await this.readUploaded();
    if (!uploaded) return 'skipped';
    const { manifest, changed } = await encodeSnapshot(this.deps.snapshot(), uploaded);
    for (const part of changed) {
      const res = await this.deps.request(`/v1/analytics/part?id=${encodeURIComponent(part.id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hash: part.hash, data: toBase64(part.body) })
      });
      if (!res) return 'skipped';
      if (!res.ok) throw new Error(`relay refused part ${part.id} (${res.status})`);
    }
    const res = await this.deps.request('/v1/analytics/manifest', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(manifest) });
    if (!res) return 'skipped';
    if (res.status === 409 && retry) {
      // The relay lost parts this desktop thought it held (cleared, revoked and re-added): resend all.
      this.uploaded = new Map();
      return this.upload(false);
    }
    if (!res.ok) throw new Error(`relay refused the manifest (${res.status})`);
    this.uploaded = new Map(manifest.parts.map((p) => [p.id, p]));
    this.deps.log('debug', `analytics: synced ${changed.length} of ${manifest.parts.length} part(s)`);
    return 'uploaded';
  }
}
