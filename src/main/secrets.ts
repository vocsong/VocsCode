import path from 'node:path';
import { safeStorage } from 'electron';
import type { SecretStatus } from '../shared/types';
import type { Logger } from './log';
import { readJson, writeJson } from './util/fs';

/**
 * API keys encrypted at rest with Electron's safeStorage (DPAPI on Windows, Keychain on macOS,
 * libsecret on Linux). Falls back to obfuscated storage when OS encryption is unavailable.
 *
 * Log lines here name the provider id only — never a key, encrypted or not.
 */
export class SecretStore {
  private data: Record<string, string> = {};
  private readonly file: string;
  private readonly log: Logger;
  private warnedDecrypt = new Set<string>();

  constructor(userData: string, log: Logger = () => undefined) {
    this.file = path.join(userData, 'secrets.json');
    this.log = log;
  }

  async load(): Promise<void> {
    const loaded = await readJson<Record<string, string>>(this.file, {}, { log: this.log });
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
      this.log('warn', `${this.file} is not a key table; ignoring it`);
      this.data = {};
    } else this.data = loaded;
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
    return !!this.data[id];
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
    const encrypted = this.encryptionAvailable;
    this.data[id] = encrypted ? 'enc:' + safeStorage.encryptString(trimmed).toString('base64') : 'b64:' + Buffer.from(trimmed, 'utf8').toString('base64');
    this.warnedDecrypt.delete(id);
    await this.persist();
    if (encrypted) this.log('info', `API key stored for ${id}`);
    else this.log('warn', `API key stored for ${id} WITHOUT OS encryption (safeStorage unavailable); it is only obfuscated on disk`);
  }

  async clear(id: string): Promise<void> {
    const had = id in this.data;
    delete this.data[id];
    await this.persist();
    if (had) this.log('info', `API key cleared for ${id}`);
  }
}
