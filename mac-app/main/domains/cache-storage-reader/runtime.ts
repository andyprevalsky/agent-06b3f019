/**
 * Runtime layer for cache-storage-reader.
 *
 * Exposes the static `CacheStorageReader` class that existing callers
 * (browser-state-sync service, blackbox tests) already import. Keeps the
 * public surface identical to the pre-refactor flat file so wiring and
 * mocks don't need to change.
 *
 * Responsibilities: delegate `readCacheStorage` to the service layer.
 */

import * as service from './service';
import type { CacheStorageData } from './types';

export type { CacheInfo, CacheStorageData, CacheStorageOriginData } from './types';

export class CacheStorageReader {
  /**
   * Read Cache Storage metadata from Chrome's Service Worker directory.
   * Returns cache names per origin (not the actual cached responses).
   */
  static async readCacheStorage(): Promise<CacheStorageData> {
    return service.readCacheStorage();
  }
}
