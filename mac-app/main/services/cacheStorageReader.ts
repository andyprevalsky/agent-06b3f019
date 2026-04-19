/**
 * Legacy entry path for the cache-storage-reader domain.
 *
 * The implementation lives in `main/domains/cache-storage-reader/`; this
 * shim preserves the pre-refactor import path for callers (browser-state-sync
 * service, blackbox tests) without forcing them to update their imports.
 *
 * New code should import from 'main/domains/cache-storage-reader/runtime'.
 */

export { CacheStorageReader } from '../domains/cache-storage-reader/runtime';
export type {
  CacheInfo,
  CacheStorageData,
  CacheStorageOriginData,
} from '../domains/cache-storage-reader/runtime';
