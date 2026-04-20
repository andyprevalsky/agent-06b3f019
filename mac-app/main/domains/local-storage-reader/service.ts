/**
 * Service layer for local-storage-reader.
 *
 * Orchestrates the full localStorage scan:
 *   1. Resolve Chrome's `Local Storage/leveldb` directory (repo).
 *   2. Copy the locked directory into a temp path (repo).
 *   3. Open the temp LevelDB and iterate every (key, value) buffer pair (repo).
 *   4. Decode Chrome's key framing
 *        `"_" + encoding + origin + NUL + encoding + key`
 *      and value framing
 *        `encoding + bytes`
 *      into strings (this file, pure byte-parsing).
 *   5. Drop Chrome-internal `META:` keys and `chrome-extension://` origins.
 *   6. Group surviving entries by origin and compute a deterministic truncated
 *      sha256 hash per origin (stable under insertion order; drives the
 *      sync-layer re-injection cache).
 *   7. Close the LevelDB handle and remove the temp copy — even if the
 *      iterator throws mid-stream.
 *
 * All filesystem / LevelDB / Electron boundaries go through repo.ts; this
 * file is pure business logic plus `crypto`.
 */

import crypto from 'crypto';
import {
  ENCODING_LATIN1,
  ENCODING_UTF16_LE,
  EXTENSION_ORIGIN_PREFIX,
  KEY_PREFIX_BYTE,
  LOG_COMPONENT,
  META_KEY_PREFIX,
  ORIGIN_HASH_PREFIX_LENGTH,
} from './config';
import {
  copyLevelDbToTemp,
  makeTempCopyPath,
  openLevelDb,
  removeTempCopy,
  resolveLocalStorageDir,
} from './repo';
import type { LocalStorageData, LocalStorageEntry } from './types';

// ---------------------------------------------------------------------------
// Chrome LevelDB framing parsers
// ---------------------------------------------------------------------------

/**
 * Decode a raw byte-slice according to Chrome's encoding-byte sentinel.
 * 0x00 = UTF-16-LE, 0x01 = Latin-1. Anything else falls back to UTF-8 — this
 * matches the pre-refactor contract exactly.
 */
function decodeValue(bytes: Buffer, encodingByte: number): string {
  if (encodingByte === ENCODING_UTF16_LE) {
    return bytes.toString('utf16le');
  }
  if (encodingByte === ENCODING_LATIN1) {
    return bytes.toString('latin1');
  }
  return bytes.toString('utf8');
}

/**
 * Parse a Chrome localStorage LevelDB key buffer.
 *
 * Format: `"_" + encoding_byte(origin) + origin_bytes + NUL + encoding_byte(key) + key_bytes`
 *
 * Returns null for any buffer that doesn't start with "_", is missing a null
 * separator, or decodes to empty strings — the caller skips those rows.
 */
export function parseKey(keyBuffer: Buffer): { origin: string; key: string } | null {
  try {
    if (keyBuffer[0] !== KEY_PREFIX_BYTE) {
      return null;
    }

    // Skip the "_" prefix.
    const data = keyBuffer.slice(1);

    // First byte after "_" is the encoding byte for the origin.
    const originEncoding = data[0];

    // Find the NUL separator that terminates the origin segment.
    let nullIndex = -1;
    for (let i = 1; i < data.length; i++) {
      if (data[i] === 0x00) {
        nullIndex = i;
        break;
      }
    }

    if (nullIndex === -1 || nullIndex >= data.length - 1) {
      return null;
    }

    // Extract origin (skip the origin encoding byte at index 0).
    const originBytes = data.slice(1, nullIndex);
    const origin = decodeValue(originBytes, originEncoding);

    // After the NUL, the next byte is the encoding for the key, then the key bytes.
    const keyEncoding = data[nullIndex + 1];
    const keyBytes = data.slice(nullIndex + 2);
    const key = decodeValue(keyBytes, keyEncoding);

    if (!origin || !key) {
      return null;
    }

    return { origin, key };
  } catch {
    return null;
  }
}

/**
 * Parse a Chrome localStorage value buffer. Values are `encoding_byte + bytes`.
 * Returns null for empty buffers so the caller can skip them.
 */
export function parseValue(valueBuffer: Buffer): string | null {
  try {
    if (valueBuffer.length === 0) {
      return null;
    }

    const encodingByte = valueBuffer[0];
    const data = valueBuffer.slice(1);

    return decodeValue(data, encodingByte);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-origin change-detection hash
// ---------------------------------------------------------------------------

/**
 * Compute a stable truncated-sha256 hash over an origin's entries.
 *
 * Entries are sort-by-key first so the hash is insertion-order independent —
 * this is load-bearing: the sync layer uses these hashes to decide whether a
 * per-origin re-injection is needed, and a hash that flipped on every scan
 * would thrash that cache.
 */
export function computeOriginHash(entries: { key: string; value: string }[]): string {
  const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
  const content = JSON.stringify(sorted);
  return crypto
    .createHash('sha256')
    .update(content)
    .digest('hex')
    .slice(0, ORIGIN_HASH_PREFIX_LENGTH);
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** Empty `LocalStorageData` returned by all non-happy paths. */
function emptyResult(): LocalStorageData {
  return {
    entries: [],
    byOrigin: {},
    hashes: {},
    entryCount: 0,
    originCount: 0,
  };
}

/**
 * Read all localStorage entries from Chrome's LevelDB.
 * Returns entries grouped by origin with hashes for cache invalidation.
 */
export async function readLocalStorage(): Promise<LocalStorageData> {
  const chromeLocalStoragePath = resolveLocalStorageDir();
  if (chromeLocalStoragePath === null) {
    console.log(`[${LOG_COMPONENT}] Chrome localStorage directory not found`);
    return emptyResult();
  }

  // Chrome holds an exclusive lock on its live LevelDB, so we clone it first.
  const tempPath = makeTempCopyPath();

  try {
    copyLevelDbToTemp(chromeLocalStoragePath, tempPath);
  } catch (error) {
    console.error(`[${LOG_COMPONENT}] Failed to copy database:`, error);
    return emptyResult();
  }

  const entries: LocalStorageEntry[] = [];
  const byOrigin: Record<string, { key: string; value: string }[]> = {};

  try {
    const db = openLevelDb(tempPath);

    await db.open();

    try {
      for await (const [keyBuffer, valueBuffer] of db.iterator()) {
        const parsed = parseKey(keyBuffer);
        if (!parsed) continue;

        const value = parseValue(valueBuffer);
        if (value === null) continue;

        const { origin, key } = parsed;

        // Skip Chrome-internal META: keys and extension origins.
        if (key.startsWith(META_KEY_PREFIX) || origin.startsWith(EXTENSION_ORIGIN_PREFIX)) {
          continue;
        }

        entries.push({ origin, key, value });

        const bucket = byOrigin[origin] ?? [];
        bucket.push({ key, value });
        byOrigin[origin] = bucket;
      }
    } finally {
      await db.close();
    }
  } catch (error) {
    console.error(`[${LOG_COMPONENT}] Error reading database:`, error);
  } finally {
    removeTempCopy(tempPath);
  }

  // Compute per-origin hashes after the full scan so they reflect the final
  // grouped entry set, not partial progress.
  const hashes: Record<string, string> = {};
  for (const [origin, originEntries] of Object.entries(byOrigin)) {
    hashes[origin] = computeOriginHash(originEntries);
  }

  console.log(
    `[${LOG_COMPONENT}] Read ${entries.length} entries from ${Object.keys(byOrigin).length} origins`
  );

  return {
    entries,
    byOrigin,
    hashes,
    entryCount: entries.length,
    originCount: Object.keys(byOrigin).length,
  };
}
