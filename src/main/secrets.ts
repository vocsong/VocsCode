import path from 'node:path';
import { safeStorage } from 'electron';
import { readJson, writeJson } from './util/fs';

/**
 * API keys encrypted at rest with Electron's safeStorage (DPAPI on Windows, Keychain on macOS,
 * libsecret on Linux). Falls back to obfuscated storage when OS encryption is unavailable.
 */
export class SecretStore {
  private data: Record<string, string> = {};
  private readonly file: string;

  constructor(userData: string) {
    this.file = path.join(userData, 'secrets.json');
  }

  async load(): Promise<void> {
    this.data = await readJson<Record<string, string>>(this.file, {});
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
      } catch {
        return undefined;
      }
    }
    if (v.startsWith('b64:')) return Buffer.from(v.slice(4), 'base64').toString('utf8');
    return v;
  }

  has(id: string): boolean {
    return !!this.data[id];
  }

  async set(id: string, value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) return this.clear(id);
    this.data[id] = this.encryptionAvailable ? 'enc:' + safeStorage.encryptString(trimmed).toString('base64') : 'b64:' + Buffer.from(trimmed, 'utf8').toString('base64');
    await writeJson(this.file, this.data);
  }

  async clear(id: string): Promise<void> {
    delete this.data[id];
    await writeJson(this.file, this.data);
  }
}
