/** Pairing storage for the web shell. Credentials carry non-extractable CryptoKeys, which only
 *  IndexedDB can structured-clone; localStorage can hold neither, so it is used only to migrate
 *  the legacy exportable-JWK pairing and never again. */
import type { PairingVault, VaultState } from '../../../relay/src/web-client';

/** The IndexedDB vault: one `state` entry in `vocs-code-remote`. */
export function indexedDbVault(): PairingVault {
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
    load: async () => ((await run('readonly', (store) => store.get('state'))) as VaultState | undefined) ?? null,
    save: async (state) => {
      await run('readwrite', (store) => store.put(state, 'state'));
    },
    clear: async () => {
      await run('readwrite', (store) => store.delete('state'));
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
