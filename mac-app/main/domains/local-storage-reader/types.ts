/**
 * Types for the local-storage-reader domain.
 *
 * Encapsulates the shapes produced when parsing Chrome's on-disk
 * `Local Storage/leveldb` directory into per-origin localStorage snapshots.
 */

/** One flat (origin, key, value) triple captured from Chrome's localStorage. */
export interface LocalStorageEntry {
  origin: string;
  key: string;
  value: string;
}

/**
 * Aggregate result returned by `readLocalStorage` — the flat entry list, the
 * same entries grouped by origin, and a stable per-origin hash suitable for
 * change detection (drives re-injection cache invalidation in the sync layer).
 */
export interface LocalStorageData {
  entries: LocalStorageEntry[];
  byOrigin: Record<string, { key: string; value: string }[]>;
  hashes: Record<string, string>;
  entryCount: number;
  originCount: number;
}
