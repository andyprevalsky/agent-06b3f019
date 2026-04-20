/**
 * Runtime layer for indexed-db-reader.
 *
 * Exposes the static `IndexedDBReader` class that existing callers
 * (browser-state-sync service, blackbox tests) already import. Keeps the
 * public surface identical to the pre-refactor flat file so wiring and
 * test mocks don't need to change.
 *
 * Responsibilities: delegate `readIndexedDB` to the service layer.
 */

import * as service from './service';
import type { IndexedDBData } from './types';

export type {
  IndexedDBData,
  IndexedDBDatabase,
  IndexedDBObjectStore,
  IndexedDBOriginData,
  IndexedDBRecord,
} from './types';

/**
 * IndexedDBReader reads Chrome's IndexedDB via a Python script.
 *
 * Chrome stores IndexedDB in a LevelDB format with a custom comparator
 * that standard Node.js LevelDB libraries can't read. We use the
 * `ccl_chromium_reader` Python library which handles this correctly.
 */
export class IndexedDBReader {
  /**
   * Read IndexedDB data for origins matching the filter.
   * @param originFilter - Optional filter string (e.g., "amazon" to get Amazon origins)
   */
  static async readIndexedDB(originFilter?: string): Promise<IndexedDBData> {
    return service.readIndexedDB(originFilter);
  }
}
