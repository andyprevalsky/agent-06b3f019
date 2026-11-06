/**
 * Per-origin change-detection hash for indexed-db-reader.
 *
 * Kept free of Electron imports so the hash contract can be exercised directly.
 */

import crypto from 'crypto';
import { ORIGIN_HASH_PREFIX_LENGTH } from './config';
import type { SliceClock } from '../../base/timeSlice';
import type { IndexedDBOriginData } from './types';

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

/**
 * {@link computeOriginHash}, streamed record by record in time slices.
 *
 * Feeds sha256 the exact bytes `JSON.stringify(data.databases)` would produce
 * (databases are `{name, objectStores}`, stores are `{name, records}`, in that
 * key order) without building one multi-MB string in a single main-thread task.
 */
export async function computeOriginHashSliced(
  data: IndexedDBOriginData,
  clock: SliceClock
): Promise<string> {
  const hash = crypto.createHash('sha256');
  hash.update('[');
  for (const [dbIndex, db] of data.databases.entries()) {
    if (dbIndex > 0) hash.update(',');
    hash.update(`{"name":${JSON.stringify(db.name)},"objectStores":[`);
    for (const [storeIndex, store] of db.objectStores.entries()) {
      if (storeIndex > 0) hash.update(',');
      hash.update(`{"name":${JSON.stringify(store.name)},"records":[`);
      for (const [recordIndex, record] of store.records.entries()) {
        if (recordIndex > 0) hash.update(',');
        hash.update(JSON.stringify(record));
        if (clock.shouldYield()) await clock.yieldToEventLoop();
      }
      hash.update(']}');
    }
    hash.update(']}');
  }
  hash.update(']');
  return hash.digest('hex').slice(0, ORIGIN_HASH_PREFIX_LENGTH);
}
