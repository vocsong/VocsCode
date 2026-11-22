/**
 * Disk-backed cache of each harness's discovered model catalog (`harness:models`). Discovery
 * spawns the harness CLI or calls a vendor API, so opening the New Session dialog re-ran it on
 * every harness click. A successful catalog is reused for `MODEL_CATALOG_TTL_MS` and survives a
 * restart; the user's "Recheck models" passes `refresh` and bypasses it.
 *
 * An entry only answers a request with the same fingerprint: the settings and runtime the
 * discovery read. A changed endpoint, binary or override therefore misses instead of serving
 * the old catalog. Keys never reach the fingerprint; callers `clear()` when a secret changes.
 * Failed or empty discoveries are never stored, so a sign-in problem is retried on next open.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { HarnessId, ModelInfo } from '../shared/types';
import { writeJson } from './util/fs';

export const MODEL_CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FILE = 'model-catalog-cache.json';
const VERSION = 1;

interface Entry {
  at: number;
  fingerprint: string;
  models: ModelInfo[];
}
interface CacheFile {
  version: number;
  entries: Partial<Record<HarnessId, Entry>>;
}

export type ModelDiscovery = { models: ModelInfo[]; error?: string };

export class ModelCatalogCache {
  private entries: Partial<Record<HarnessId, Entry>> | undefined;
  private loading: Promise<void> | undefined;
  private readonly inflight = new Map<string, Promise<ModelDiscovery>>();
  /** Bumped by clear(): a discovery that started before it must not write its result back. */
  private generation = 0;

  constructor(
    private readonly dir: string | undefined,
    private readonly opts: { now?: () => number; ttlMs?: number; log?: (level: 'warn', message: string) => void } = {}
  ) {}

  private get file(): string | undefined {
    return this.dir ? path.join(this.dir, FILE) : undefined;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private async load(): Promise<Partial<Record<HarnessId, Entry>>> {
    if (this.entries) return this.entries;
    this.loading ??= (async () => {
      let entries: Partial<Record<HarnessId, Entry>> = {};
      const file = this.file;
      if (file) {
        try {
          const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as CacheFile;
          if (parsed?.version === VERSION && parsed.entries && typeof parsed.entries === 'object') entries = parsed.entries;
        } catch {
          // Missing or unreadable: start empty, discovery fills it again.
        }
      }
      this.entries ??= entries;
    })();
    await this.loading;
    return this.entries!;
  }

  private async persist(): Promise<void> {
    const file = this.file;
    if (!file || !this.entries) return;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await writeJson(file, { version: VERSION, entries: this.entries } satisfies CacheFile);
    } catch (e) {
      this.opts.log?.('warn', `model catalog cache: could not save (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  /**
   * The cached catalog when it is fresh and was discovered under `fingerprint`; otherwise runs
   * `discover` once (concurrent callers share it) and stores a clean, non-empty result.
   */
  async get(harness: HarnessId, fingerprintSource: string, discover: () => Promise<ModelDiscovery>, opts: { refresh?: boolean } = {}): Promise<ModelDiscovery> {
    const fingerprint = createHash('sha256').update(fingerprintSource).digest('hex');
    const entries = await this.load();
    const hit = entries[harness];
    const ttl = this.opts.ttlMs ?? MODEL_CATALOG_TTL_MS;
    if (!opts.refresh && hit && hit.fingerprint === fingerprint && Array.isArray(hit.models) && this.now() - hit.at < ttl && this.now() >= hit.at) {
      return { models: hit.models };
    }
    const key = `${harness}\0${fingerprint}\0${opts.refresh ? 'refresh' : ''}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const generation = this.generation;
    const run = (async () => {
      const result = await discover();
      if (!result.error && result.models.length && generation === this.generation) {
        entries[harness] = { at: this.now(), fingerprint, models: result.models };
        await this.persist();
      }
      return result;
    })();
    this.inflight.set(key, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Forgets one harness, or every harness: after a sign-in, an install or a key change. */
  async clear(harness?: HarnessId): Promise<void> {
    const entries = await this.load();
    this.generation++;
    const ids = harness ? [harness] : (Object.keys(entries) as HarnessId[]);
    const removed = ids.filter((id) => entries[id]);
    for (const id of removed) delete entries[id];
    // Nothing cached means nothing to rewrite: a key change must not create the file.
    if (removed.length) await this.persist();
  }
}
