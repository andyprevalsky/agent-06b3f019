/**
 * Runtime layer for local-storage-reader.
 *
 * Exposes the static `LocalStorageReader` class that existing callers
 * (browser-state-sync service, blackbox tests) already import. Keeps the
 * public surface identical to the pre-refactor flat file so wiring and
 * `vi.mock` seams don't need to change.
 *
 * Responsibility: delegate `readLocalStorage` to the service layer.
 */

import * as service from './service';
import type { LocalStorageData } from './types';

export type { LocalStorageData, LocalStorageEntry } from './types';

export class LocalStorageReader {
  /**
   * Read all localStorage entries from Chrome's LevelDB.
   * Returns entries grouped by origin with hashes for cache invalidation.
   */
  static async readLocalStorage(): Promise<LocalStorageData> {
    return service.readLocalStorage();
  }
}
