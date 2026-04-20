/**
 * Types for the cache-storage-reader domain.
 *
 * Encapsulates the shapes produced when parsing Chrome's on-disk
 * Service-Worker CacheStorage directory into per-origin cache-name metadata.
 */

/** One named cache inside Chrome's CacheStorage for a given origin. */
export interface CacheInfo {
  name: string;
  size?: number;
}

/** All caches belonging to a single origin. */
export interface CacheStorageOriginData {
  origin: string;
  caches: CacheInfo[];
}

/**
 * Aggregate result returned by `readCacheStorage` — one entry per origin
 * that has at least one parseable cache on disk, plus a stable per-origin
 * hash suitable for change detection.
 */
export interface CacheStorageData {
  origins: CacheStorageOriginData[];
  hashes: Record<string, string>; // origin -> hash
  originCount: number;
}
