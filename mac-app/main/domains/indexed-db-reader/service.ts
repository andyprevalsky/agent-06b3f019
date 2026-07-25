/**
 * Service layer for indexed-db-reader.
 *
 * Orchestrates the full IndexedDB scan using a fully native TypeScript reader
 * (no `python3`, no bundled helper script):
 *   1. Discover the `*.indexeddb.leveldb` folders in the active Chrome profile
 *      matching the optional origin filter (repo boundary).
 *   2. Decode each folder with the native reader (`./native`), which parses the
 *      LevelDB physical format, the IndexedDB envelope, and the V8/Blink
 *      structured-clone values — the same work `ccl_chromium_reader` did.
 *   3. Translate every failure mode (unreadable folder, decode error) into a
 *      per-origin `{ error }` entry; the service never rejects.
 *   4. Compute a deterministic 16-hex sha256 prefix per non-error origin over
 *      `JSON.stringify(origin.databases)`; this is the cache key the downstream
 *      sync layer uses.
 *
 * Filesystem / Electron boundaries go through repo.ts and the `./native`
 * discovery module; this file is orchestration plus `crypto`.
 */

import crypto from 'crypto';
import { getErrorMessage } from '../../../shared/utils/error';
import { LOG_COMPONENT, ORIGIN_HASH_PREFIX_LENGTH } from './config';
import { resolveHomeDir } from './repo';
import { findIndexedDbFolders } from './native/discovery';
import { readIndexedDbDatabases } from './native/indexeddb';
import type { IndexedDBData, IndexedDBOriginData } from './types';

// ---------------------------------------------------------------------------
// Per-origin change-detection hash
// ---------------------------------------------------------------------------

/**
 * Compute a stable 16-hex sha256 prefix over an origin's `databases`.
 *
 * The shape is hashed verbatim via `JSON.stringify` — callers upstream rely on
 * the fact that identical `databases` produce identical hashes across
 * invocations, and that any change (record add/remove/value tweak) flips the
 * hash. No sorting is applied: record ordering is part of the observed state.
 */
export function computeOriginHash(data: IndexedDBOriginData): string {
  const content = JSON.stringify(data.databases);
  return crypto
    .createHash('sha256')
    .update(content)
    .digest('hex')
    .slice(0, ORIGIN_HASH_PREFIX_LENGTH);
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

/** Empty `IndexedDBData` returned when no origins match. */
function emptyResult(): IndexedDBData {
  return { origins: [], hashes: {} };
}

/**
 * Tally every origin's `databases.length` and `objectStores[*].records.length`
 * in a single pass. Used only by the success-path summary log line.
 */
function summarizeCounts(origins: IndexedDBOriginData[]): {
  databases: number;
  records: number;
} {
  let databases = 0;
  let records = 0;
  for (const origin of origins) {
    const dbs = origin.databases ?? [];
    databases += dbs.length;
    for (const db of dbs) {
      for (const store of db.objectStores ?? []) {
        records += store.records?.length ?? 0;
      }
    }
  }
  return { databases, records };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Read IndexedDB data for origins matching the optional filter.
 * @param originFilter - Optional filter string (e.g., "amazon" to get Amazon origins)
 */
export async function readIndexedDB(originFilter?: string): Promise<IndexedDBData> {
  const filterSuffix = originFilter === undefined ? '' : ` for '${originFilter}'`;
  console.log(`[${LOG_COMPONENT}] Reading IndexedDB${filterSuffix}...`);

  // `readIndexedDbDatabases` is synchronous CPU/IO work; keep the async
  // signature (callers await it) but yield to the event loop first so a large
  // scan doesn't block other startup work on the main thread.
  await Promise.resolve();

  const folders = findIndexedDbFolders(resolveHomeDir(), originFilter);
  if (folders.length === 0) {
    console.log(`[${LOG_COMPONENT}] No IndexedDB data found${filterSuffix}`);
    return emptyResult();
  }

  const origins: IndexedDBOriginData[] = [];
  const hashes: Record<string, string> = {};

  for (const folder of folders) {
    try {
      const databases = readIndexedDbDatabases(folder.leveldbDir, folder.blobDir ?? undefined);
      const origin: IndexedDBOriginData = { origin: folder.origin, databases };
      origins.push(origin);
      hashes[folder.origin] = computeOriginHash(origin);
    } catch (error) {
      // A single unreadable/corrupt folder must not abort the whole scan.
      console.error(
        `[${LOG_COMPONENT}] Failed to read ${folder.folderName}: ${getErrorMessage(error)}`
      );
      origins.push({ origin: folder.origin, databases: [], error: getErrorMessage(error) });
    }
  }

  const { databases, records } = summarizeCounts(origins);
  console.log(
    `[${LOG_COMPONENT}] Read ${String(origins.length)} origins, ` +
      `${String(databases)} databases, ${String(records)} records`
  );

  return { origins, hashes };
}
