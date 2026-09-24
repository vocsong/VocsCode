/** A minimal in-memory IndexedDB for jsdom page tests: open (with upgrade), object stores, and
 *  get/put/delete inside transactions that complete asynchronously — exactly the surface
 *  relay/src/page.ts uses. Values are structured-cloned like the real thing. */
type Stores = Map<string, Map<IDBValidKey, unknown>>;

export function fakeIndexedDB(seed: Record<string, Record<string, Record<string, unknown>>> = {}) {
  const databases = new Map<string, Stores>();
  for (const [db, stores] of Object.entries(seed)) {
    databases.set(db, new Map(Object.entries(stores).map(([name, rows]) => [name, new Map(Object.entries(rows))])));
  }
  const later = (fn: () => void) => setTimeout(fn, 0);
  return {
    databases,
    open(name: string) {
      const request: Record<string, unknown> & { onsuccess?: (e: unknown) => void; onupgradeneeded?: (e: unknown) => void } = { result: undefined, error: null };
      later(() => {
        const fresh = !databases.has(name);
        const stores: Stores = databases.get(name) ?? new Map();
        databases.set(name, stores);
        const db = {
          objectStoreNames: { contains: (store: string) => stores.has(store) },
          createObjectStore: (store: string) => {
            stores.set(store, new Map());
            return {};
          },
          close: () => undefined,
          transaction: (storeName: string) => {
            const tx: Record<string, unknown> & { oncomplete?: () => void } = { error: null };
            const store = stores.get(storeName);
            if (!store) throw new Error(`no object store ${storeName}`);
            let pending = 0;
            const run = <T>(work: () => T) => {
              const req: Record<string, unknown> & { onsuccess?: (e: unknown) => void } = { result: undefined };
              pending++;
              later(() => {
                req.result = work();
                req.onsuccess?.({ target: req });
                if (--pending === 0) later(() => tx.oncomplete?.());
              });
              return req;
            };
            tx.objectStore = () => ({
              get: (key: IDBValidKey) => run(() => (store.has(key) ? structuredClone(store.get(key)) : undefined)),
              put: (value: unknown, key: IDBValidKey) => run(() => {
                store.set(key, structuredClone(value));
                return key;
              }),
              delete: (key: IDBValidKey) => run(() => {
                store.delete(key);
                return undefined;
              })
            });
            return tx;
          }
        };
        request.result = db;
        if (fresh) request.onupgradeneeded?.({ target: request });
        request.onsuccess?.({ target: request });
      });
      return request;
    }
  };
}
