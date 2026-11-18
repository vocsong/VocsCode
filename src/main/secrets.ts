import path from 'node:path';
import { safeStorage } from 'electron';
import type { SecretStatus } from '../shared/types';
import type { Logger } from './log';
import { readJson, writeJson } from './util/fs';

/**
 * API keys encrypted at rest with Electron's safeStorage (DPAPI on Windows, Keychain on macOS,
 * libsecret on Linux). Falls back to obfuscated storage when OS encryption is unavailable, except
 * for the ids named in `sessionOnly`: long-lived identity material (remote access) is then kept in
 * memory for this run only and never written, so a copied or backed-up file cannot carry it.
 *
 * Log lines here name the provider id only — never a key, encrypted or not.
 */
export class SecretStore {
  private data: Record<string, string> = {};
  private readonly file: string;
  private readonly log: Logger;
  private warnedDecrypt = new Set<string>();
  /** Session-only values, held while OS encryption is unavailable. */
  private memory = new Map<string, string>();
  private warnedSession = new Set<string>();
  private readonly sessionOnly: ReadonlySet<string>;

  constructor(userData: string, log: Logger = () => undefined, opts: { sessionOnly?: readonly string[] } = {}) {
    this.file = path.join(userData, 'secrets.json');
    this.log = log;
    this.sessionOnly = new Set(opts.sessionOnly ?? []);
  }

  /** Whether `id` must stay out of the file right now. */
  private keepInMemory(id: string): boolean {
    return this.sessionOnly.has(id) && !this.secureStorageAvailable;
  }

  /** True when `id` is held for this run only and will be gone after a restart. */
  isMemoryOnly(id: string): boolean {
    return this.keepInMemory(id);
  }

  /**
   * OS encryption backed by a real keychain. On Linux, Chromium falls back to `basic_text` (a
   * hard-coded key) when no secret service is running; that, or an `unknown` backend, protects
   * nothing a copied file would not reveal, so session-only ids treat it as unavailable.
   */
  get secureStorageAvailable(): boolean {
    if (!this.encryptionAvailable) return false;
    if (process.platform !== 'linux') return true;
    try {
      const backend = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.();
      return backend !== 'basic_text' && backend !== 'unknown';
    } catch {
      return false;
    }
  }

  async load(): Promise<void> {
    const loaded = await readJson<Record<string, string>>(this.file, {}, { log: this.log });
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
      this.log('warn', `${this.file} is not a key table; ignoring it`);
      this.data = {};
    } else this.data = loaded;
    // An earlier version wrote these obfuscated (or, on a Linux basic_text backend, under its fixed
    // key). Without a real keychain they move to memory for this run and leave the file, which is
    // rewritten before anything else can copy it again. An `enc:` value moves only when that weak
    // backend can read it: one sealed by a keychain that is merely unavailable now stays put.
    const weakKey = this.encryptionAvailable && !this.secureStorageAvailable;
    const moved = Object.keys(this.data).filter((id) => this.keepInMemory(id) && (this.data[id]?.startsWith('b64:') || (weakKey && this.data[id]?.startsWith('enc:'))));
    if (moved.length) {
      for (const id of moved) {
        const value = await this.get(id);
        if (value !== undefined) this.memory.set(id, value);
        delete this.data[id];
      }
      await this.persist();
      this.log('warn', `OS encryption unavailable: ${moved.join(', ')} removed from disk and kept for this session only`);
    }
    const ids = Object.keys(this.data);
    const fallback = this.fallbackProviderIds;
    this.log('info', `secrets loaded for ${ids.length} provider(s)${fallback.length ? `; ${fallback.length} stored without OS encryption (${fallback.join(', ')})` : ''}; OS encryption ${this.encryptionAvailable ? 'available' : 'unavailable'}`);
  }

  get encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  async get(id: string): Promise<string | undefined> {
    const held = this.memory.get(id);
    if (held !== undefined) return held;
    const v = this.data[id];
    if (!v) return undefined;
    if (v.startsWith('enc:')) {
      try {
        return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
      } catch (e) {
        // The key is gone as far as the app is concerned (another OS user, a reinstalled keychain);
        // say so once per provider so a "no API key" error can be traced back here.
        if (!this.warnedDecrypt.has(id)) {
          this.warnedDecrypt.add(id);
          this.log('warn', `could not decrypt the stored API key for ${id}: ${e instanceof Error ? e.message : String(e)}; re-enter it under Settings → Providers`);
        }
        return undefined;
      }
    }
    if (v.startsWith('b64:')) return Buffer.from(v.slice(4), 'base64').toString('utf8');
    return v;
  }

  has(id: string): boolean {
    return this.memory.has(id) || !!this.data[id];
  }

  get fallbackProviderIds(): string[] {
    return Object.entries(this.data)
      .filter(([, value]) => value.startsWith('b64:'))
      .map(([id]) => id)
      .sort();
  }

  get hasFallback(): boolean {
    return this.fallbackProviderIds.length > 0;
  }

  get status(): SecretStatus {
    const fallbackProviderIds = this.fallbackProviderIds;
    return { encryptionAvailable: this.encryptionAvailable, hasFallback: fallbackProviderIds.length > 0, fallbackProviderIds };
  }

  private persist(): Promise<void> {
    // Keys may be reversible when safeStorage is unavailable; never leave the file readable by
    // other users while that fallback is in use (and keep the mode for encrypted values too).
    return writeJson(this.file, this.data, { mode: 0o600 });
  }

  async set(id: string, value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) return this.clear(id);
    if (this.keepInMemory(id)) {
      const wasStored = id in this.data;
      this.memory.set(id, trimmed);
      delete this.data[id];
      if (wasStored) await this.persist();
      if (!this.warnedSession.has(id)) {
        this.warnedSession.add(id);
        this.log('warn', `${id} kept for this session only: OS encryption is unavailable, so it is not written to disk`);
      }
      return;
    }
    this.memory.delete(id);
    const encrypted = this.encryptionAvailable;
    this.data[id] = encrypted ? 'enc:' + safeStorage.encryptString(trimmed).toString('base64') : 'b64:' + Buffer.from(trimmed, 'utf8').toString('base64');
    this.warnedDecrypt.delete(id);
    await this.persist();
    if (encrypted) this.log('info', `API key stored for ${id}`);
    else this.log('warn', `API key stored for ${id} WITHOUT OS encryption (safeStorage unavailable); it is only obfuscated on disk`);
  }

  async clear(id: string): Promise<void> {
    this.memory.delete(id);
    const had = id in this.data;
    delete this.data[id];
    await this.persist();
    if (had) this.log('info', `API key cleared for ${id}`);
  }
}
