import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SecretStore } from '../src/main/secrets';

// Stub Electron's safeStorage so SecretStore is testable in plain node. Mutable flag lets the
// unavailable-encryption fallback path be exercised without re-declaring the mock.
const safeStorageMock = vi.hoisted(() => ({
  encryptionAvailable: true,
  backend: 'gnome_libsecret',
  isEncryptionAvailable: () => safeStorageMock.encryptionAvailable,
  getSelectedStorageBackend: () => safeStorageMock.backend,
  encryptString: (s: string) => Buffer.concat([Buffer.from('enc|'), Buffer.from(s, 'utf8')]),
  decryptString: (b: Buffer) => {
    const raw = b.toString('utf8');
    if (!raw.startsWith('enc|')) throw new Error('not encrypted with this key');
    return raw.slice(4);
  }
}));
vi.mock('electron', () => ({ safeStorage: safeStorageMock }));

describe('SecretStore', () => {
  const tmpRoot = path.join(os.tmpdir(), `vocs-code-secrets-test-${Date.now()}-${process.pid}`);
  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('round-trips a key through the fake safeStorage as enc: base64', async () => {
    safeStorageMock.encryptionAvailable = true;
    const dir = path.join(tmpRoot, 'enc');
    const store = new SecretStore(dir);
    await store.load();
    await store.set('deepseek', '  sk-test-123  ');
    expect(store.has('deepseek')).toBe(true);
    // Value is trimmed, encrypted (not plaintext) and decrypts back via the fake.
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'secrets.json'), 'utf8')) as Record<string, string>;
    expect(raw.deepseek.startsWith('enc:')).toBe(true);
    expect(raw.deepseek).not.toContain('sk-test-123');
    expect(await store.get('deepseek')).toBe('sk-test-123');
  });

  it('falls back to b64: obfuscation when OS encryption is unavailable', async () => {
    safeStorageMock.encryptionAvailable = false;
    try {
      const dir = path.join(tmpRoot, 'b64');
      const store = new SecretStore(dir);
      await store.load();
      await store.set('openai', 'sk-fallback');
      const raw = JSON.parse(await fs.readFile(path.join(dir, 'secrets.json'), 'utf8')) as Record<string, string>;
      expect(raw.openai.startsWith('b64:')).toBe(true);
      expect(raw.openai).not.toContain('sk-fallback');
      expect(await store.get('openai')).toBe('sk-fallback');
      expect(store.status).toEqual({ encryptionAvailable: false, hasFallback: true, fallbackProviderIds: ['openai'] });
      if (process.platform !== 'win32') expect((await fs.stat(path.join(dir, 'secrets.json'))).mode & 0o777).toBe(0o600);
    } finally {
      safeStorageMock.encryptionAvailable = true;
    }
  });

  it('keeps session-only identity secrets off disk without OS encryption, and removes an earlier obfuscated copy', async () => {
    const dir = path.join(tmpRoot, 'session-only');
    const identity = JSON.stringify({ deviceId: 'd1', refresh: 'refresh-credential-value' });
    // An earlier version wrote the identity obfuscated next to an ordinary API key.
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'secrets.json'), JSON.stringify({
      'remote-host': 'b64:' + Buffer.from(identity).toString('base64'),
      openai: 'b64:' + Buffer.from('sk-ordinary').toString('base64'),
    }));
    safeStorageMock.encryptionAvailable = false;
    try {
      const log = vi.fn();
      const store = new SecretStore(dir, log, { sessionOnly: ['remote-host', 'remote-enroll'] });
      await store.load();
      const onDisk = async () => JSON.parse(await fs.readFile(path.join(dir, 'secrets.json'), 'utf8')) as Record<string, string>;
      // Loading moves it to memory and rewrites the file without it; ordinary keys keep the fallback.
      expect(Object.keys(await onDisk())).toEqual(['openai']);
      expect(await store.get('remote-host')).toBe(identity);
      expect(await store.get('openai')).toBe('sk-ordinary');
      await store.set('remote-enroll', 'enrollment-secret');
      await store.set('remote-host', identity.replace('d1', 'd2'));
      await store.set('remote-host', identity.replace('d1', 'd3'));
      const raw = await fs.readFile(path.join(dir, 'secrets.json'), 'utf8');
      expect(raw).not.toContain(Buffer.from('enrollment-secret').toString('base64'));
      expect(Object.keys(JSON.parse(raw))).toEqual(['openai']);
      expect(await store.get('remote-host')).toContain('d3');
      expect(store.has('remote-enroll')).toBe(true);
      expect(log.mock.calls.filter(([, line]) => String(line).includes('remote-host kept for this session only'))).toHaveLength(1);
      // A restart without OS encryption has nothing to read back: pairing starts over.
      const restarted = new SecretStore(dir, () => undefined, { sessionOnly: ['remote-host', 'remote-enroll'] });
      await restarted.load();
      expect(await restarted.get('remote-host')).toBeUndefined();
      expect(await restarted.get('remote-enroll')).toBeUndefined();
      // With OS encryption the same ids are stored encrypted as before.
      safeStorageMock.encryptionAvailable = true;
      await restarted.set('remote-host', identity);
      expect((await onDisk())['remote-host']!.startsWith('enc:')).toBe(true);
      expect(await restarted.get('remote-host')).toBe(identity);
    } finally {
      safeStorageMock.encryptionAvailable = true;
    }
  });

  it('keeps a Vocs sign-in record off disk without OS encryption, and never logs its token', async () => {
    const ids = ['vocs-account:production', 'vocs-account:staging'];
    const record = JSON.stringify({ v: 1, refreshToken: 'refresh-token-value-never-logged-000000000' });
    const log = vi.fn();
    safeStorageMock.encryptionAvailable = false;
    try {
      const dir = path.join(tmpRoot, 'vocs-account-memory');
      const store = new SecretStore(dir, log, { keychainOnly: ids });
      await store.load();
      await store.set('vocs-account:staging', record);
      expect(store.isMemoryOnly('vocs-account:staging')).toBe(true);
      expect(await store.get('vocs-account:staging')).toBe(record);
      expect(await fs.readFile(path.join(dir, 'secrets.json'), 'utf8').catch(() => '{}')).not.toContain(Buffer.from(record).toString('base64'));
      safeStorageMock.encryptionAvailable = true;
      const encrypted = new SecretStore(path.join(tmpRoot, 'vocs-account-enc'), log, { keychainOnly: ids });
      await encrypted.load();
      expect(encrypted.isMemoryOnly('vocs-account:production')).toBe(false);
      await encrypted.set('vocs-account:production', record);
      const raw = await fs.readFile(path.join(tmpRoot, 'vocs-account-enc', 'secrets.json'), 'utf8');
      expect(JSON.parse(raw)['vocs-account:production'].startsWith('enc:')).toBe(true);
      expect(raw).not.toContain('refresh-token-value');
      expect(JSON.stringify(log.mock.calls)).not.toContain('refresh-token-value');
    } finally {
      safeStorageMock.encryptionAvailable = true;
    }
  });

  it('treats a Linux basic_text or unknown keychain backend as no OS encryption for keychain-only ids, leaving remote access as it was', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    try {
      for (const backend of ['basic_text', 'unknown']) {
        const dir = path.join(tmpRoot, `linux-${backend}`);
        // Written under the fixed basic_text key by an earlier run: moved off disk at load.
        await fs.mkdir(dir, { recursive: true });
        const remoteHost = 'enc:' + Buffer.from('enc|remote-identity').toString('base64');
        await fs.writeFile(path.join(dir, 'secrets.json'), JSON.stringify({ 'vocs-account:production': 'enc:' + Buffer.from('enc|kept-record').toString('base64'), openai: 'enc:' + Buffer.from('enc|sk-ordinary').toString('base64'), 'remote-host': remoteHost }));
        safeStorageMock.backend = backend;
        const store = new SecretStore(dir, () => undefined, { sessionOnly: ['remote-host', 'remote-enroll'], keychainOnly: ['vocs-account:production'] });
        await store.load();
        expect(store.secureStorageAvailable).toBe(false);
        expect(store.isMemoryOnly('vocs-account:production')).toBe(true);
        expect(await store.get('vocs-account:production')).toBe('kept-record');
        // Remote access is unchanged by this: still on disk, still persisted.
        expect(store.isMemoryOnly('remote-host')).toBe(false);
        expect(await store.get('remote-host')).toBe('remote-identity');
        const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'secrets.json'), 'utf8')) as Record<string, string>;
        expect(Object.keys(onDisk).sort()).toEqual(['openai', 'remote-host']);
        expect(onDisk['remote-host']).toBe(remoteHost);
        await store.set('remote-enroll', 'enrollment-secret');
        expect(Object.keys(JSON.parse(await fs.readFile(path.join(dir, 'secrets.json'), 'utf8')))).toContain('remote-enroll');
      }
      safeStorageMock.backend = 'gnome_libsecret';
      const store = new SecretStore(path.join(tmpRoot, 'linux-libsecret'), () => undefined, { keychainOnly: ['vocs-account:production'] });
      expect(store.secureStorageAvailable).toBe(true);
      expect(store.isMemoryOnly('vocs-account:production')).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      safeStorageMock.backend = 'gnome_libsecret';
    }
  });

  it('keeps a keychain-only enc: record on disk when the weak backend cannot decrypt it (keyring not up yet)', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    try {
      const dir = path.join(tmpRoot, 'linux-undecryptable');
      // Sealed by the real keyring in an earlier run; this run came up on basic_text.
      const sealed = 'enc:' + Buffer.from('sealed-by-the-real-keyring').toString('base64');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'secrets.json'), JSON.stringify({ 'vocs-account:production': sealed }));
      safeStorageMock.backend = 'basic_text';
      const store = new SecretStore(dir, () => undefined, { keychainOnly: ['vocs-account:production'] });
      await store.load();
      expect(await store.get('vocs-account:production')).toBeUndefined();
      expect(JSON.parse(await fs.readFile(path.join(dir, 'secrets.json'), 'utf8'))['vocs-account:production']).toBe(sealed);
      // Once the keyring is back, the record reads again.
      safeStorageMock.backend = 'gnome_libsecret';
    } finally {
      Object.defineProperty(process, 'platform', platform);
      safeStorageMock.backend = 'gnome_libsecret';
    }
  });

  it('reads a keychain-only id back only as enc:, ignoring and removing a planted plain or b64 value', async () => {
    const dir = path.join(tmpRoot, 'planted');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'secrets.json'), JSON.stringify({
      'vocs-account:production': 'b64:' + Buffer.from('{"planted":true}').toString('base64'),
      'vocs-account:staging': '{"planted":true}',
      'remote-host': 'b64:' + Buffer.from('legacy-remote').toString('base64')
    }));
    const store = new SecretStore(dir, () => undefined, { sessionOnly: ['remote-host'], keychainOnly: ['vocs-account:production', 'vocs-account:staging'] });
    await store.load();
    expect(await store.get('vocs-account:production')).toBeUndefined();
    expect(await store.get('vocs-account:staging')).toBeUndefined();
    expect(await store.get('remote-host')).toBe('legacy-remote'); // unchanged for remote access
    expect(Object.keys(JSON.parse(await fs.readFile(path.join(dir, 'secrets.json'), 'utf8')))).toEqual(['remote-host']);
    await store.set('vocs-account:production', '{"v":1}');
    expect(await store.get('vocs-account:production')).toBe('{"v":1}');
  });

  it('clears a key and treats an empty set as a clear', async () => {
    const dir = path.join(tmpRoot, 'clear');
    const store = new SecretStore(dir);
    await store.load();
    await store.set('anthropic', 'sk-a');
    await store.clear('anthropic');
    expect(store.has('anthropic')).toBe(false);
    expect(await store.get('anthropic')).toBeUndefined();
    await store.set('anthropic', '   ');
    expect(store.has('anthropic')).toBe(false);
    // Cleared state is persisted.
    const again = new SecretStore(dir);
    await again.load();
    expect(again.has('anthropic')).toBe(false);
  });
});
