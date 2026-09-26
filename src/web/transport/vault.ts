/** Pairing storage for the web shell. Credentials carry non-extractable CryptoKeys, which only
 *  IndexedDB can structured-clone; localStorage can hold neither, so it is used only to migrate
 *  the legacy exportable-JWK pairing and never again.
 *
 *  The vault is partitioned per account (relay/src/account.ts): one signed-in account must never
 *  see another's pairing keys, and the pre-account vault belongs to the incumbent legacy account
 *  only. An unauthenticated visitor gets no vault at all. */
import type { PairingVault, VaultState } from '../../../relay/src/web-client';
import { LEGACY_ACCOUNT_ID } from '../../../relay/src/account';

/** The IndexedDB vault: one `state:<accountId>` entry in `vocs-code-remote`. */
export function indexedDbVault(accountId: string | null, allowLegacyMigration = false): PairingVault {
  const stateKey = `state:${accountId ?? 'unauthenticated'}`;
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is unavailable'));
        return;
      }
      const request = indexedDB.open('vocs-code-remote', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('vault');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('vault', mode);
      const request = work(tx.objectStore('vault'));
      tx.oncomplete = () => {
        db.close();
        resolve(request.result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(tx.error ?? new Error('IndexedDB transaction failed'));
      };
    });
  };
  return {
    load: async () => {
      if (!accountId) return null;
      const current = (await run('readonly', (store) => store.get(stateKey))) as VaultState | undefined;
      if (current || !allowLegacyMigration || accountId !== LEGACY_ACCOUNT_ID) return current ?? null;
      // The pre-account vault belongs to the incumbent account only. Never import it for a new
      // GitHub subject, and remove the old key after its one-time move.
      const legacy = (await run('readonly', (store) => store.get('state'))) as VaultState | undefined;
      if (!legacy) return null;
      await run('readwrite', (store) => store.put(legacy, stateKey));
      await run('readwrite', (store) => store.delete('state'));
      return legacy;
    },
    save: async (state) => {
      if (!accountId) throw new Error('no account to store a pairing under');
      await run('readwrite', (store) => store.put(state, stateKey));
    },
    clear: async () => {
      if (!accountId) return;
      await run('readwrite', (store) => store.delete(stateKey));
    }
  };
}

/** Pre-vault string storage, read once to migrate a legacy pairing. */
export function localStorageApi() {
  return {
    get: (k: string) => window.localStorage.getItem(k),
    set: (k: string, v: string) => window.localStorage.setItem(k, v),
    remove: (k: string) => window.localStorage.removeItem(k)
  };
}

export { LEGACY_ACCOUNT_ID };
