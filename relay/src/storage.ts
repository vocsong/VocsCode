/** Storage contracts shared across relay core and analytics persistence. */

/** Implemented by Durable Object storage (worker) and in-memory maps (tests). */
export interface RelayStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** All entries whose key starts with `prefix`, with the full key. */
  list<T>(prefix: string): Promise<Array<[string, T]>>;
}

export interface RelayStore extends RelayStorage {
  /** Atomic multi-key commit for device minting; never publish a partially approved pair. */
  transaction<T>(work: (tx: RelayStorage) => Promise<T>): Promise<T>;
}
