/**
 * Loads every computer's analytics snapshot for the dashboard: the overview names each computer's
 * committed parts by hash, and a part already decoded under that hash is reused, so a refresh only
 * fetches what changed since the last one.
 */
import { assembleSnapshot, type AnalyticsSnapshot } from '@shared/analytics/snapshot';
import { gunzipText } from '@shared/analytics/snapshot-codec';
import type { AnalyticsHost } from '@shared/analytics/snapshot-wire';
import { analyticsOverview, analyticsPart } from '../owner-api';

export interface LoadedComputer {
  host: AnalyticsHost;
  /** Null before the computer shares, or when its snapshot could not be read. */
  snapshot: AnalyticsSnapshot | null;
  error?: string;
}

export interface DashboardData {
  computers: LoadedComputer[];
  loadedAt: number;
}

function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface DashboardLoaderDeps {
  overview?: typeof analyticsOverview;
  part?: typeof analyticsPart;
  now?: () => number;
}

export class DashboardLoader {
  /** `host:part:hash` → the part's JSON text. */
  private readonly parts = new Map<string, string>();

  constructor(private readonly deps: DashboardLoaderDeps = {}) {}

  async load(): Promise<DashboardData> {
    const hosts = await (this.deps.overview ?? analyticsOverview)();
    const computers = await Promise.all(hosts.map((host) => this.loadComputer(host)));
    // Drop parts no manifest names any more, so the cache never outgrows the account's data.
    const live = new Set(hosts.flatMap((h) => (h.manifest?.parts ?? []).map((p) => `${h.hostId}:${p.id}:${p.hash}`)));
    for (const key of this.parts.keys()) if (!live.has(key)) this.parts.delete(key);
    return { computers, loadedAt: (this.deps.now ?? Date.now)() };
  }

  private async loadComputer(host: AnalyticsHost): Promise<LoadedComputer> {
    if (!host.manifest) return { host, snapshot: null };
    try {
      const texts = new Map<string, string>();
      await Promise.all(
        host.manifest.parts.map(async (ref) => {
          const key = `${host.hostId}:${ref.id}:${ref.hash}`;
          let text = this.parts.get(key);
          if (text === undefined) {
            const body = await (this.deps.part ?? analyticsPart)(host.hostId, ref.id);
            // A part re-uploaded since the overview was read: skip it this round rather than mix versions.
            if (body.hash !== ref.hash) throw new Error('the computer synced while loading; refresh to see it');
            text = await gunzipText(fromBase64(body.data));
            this.parts.set(key, text);
          }
          texts.set(ref.id, text);
        })
      );
      return { host, snapshot: assembleSnapshot(host.manifest, texts) };
    } catch (e) {
      return { host, snapshot: null, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
