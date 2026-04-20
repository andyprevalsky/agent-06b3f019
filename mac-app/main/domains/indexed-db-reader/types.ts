/**
 * Types for the indexed-db-reader domain.
 *
 * Encapsulates the shapes produced when parsing Chrome's IndexedDB LevelDB
 * via the bundled `scripts/read_indexeddb.py` helper. A per-origin sha256
 * prefix is attached downstream for cache invalidation.
 */

/** One decoded record inside a Chrome IndexedDB object store. */
export interface IndexedDBRecord {
  key: string | number | (string | number)[];
  value: unknown;
  error?: string;
}

/** One object store inside a Chrome IndexedDB database. */
export interface IndexedDBObjectStore {
  name: string;
  records: IndexedDBRecord[];
}

/** One Chrome IndexedDB database belonging to a single origin. */
export interface IndexedDBDatabase {
  name: string;
  objectStores: IndexedDBObjectStore[];
}

/**
 * All IndexedDB databases for a single origin. `error` is set by the Python
 * helper when that origin could not be parsed (e.g. leveldb corrupt); it is
 * preserved in the output so callers can still see which origin failed.
 */
export interface IndexedDBOriginData {
  origin: string;
  databases: IndexedDBDatabase[];
  error?: string;
}

/**
 * Aggregate result of `readIndexedDB`: the raw per-origin payload from the
 * Python helper plus a stable `sha256(JSON.stringify(origin.databases))`
 * prefix per non-error origin, suitable for change detection.
 */
export interface IndexedDBData {
  origins: IndexedDBOriginData[];
  hashes: Record<string, string>; // origin -> hash
}
