/**
 * Service layer for cache-storage-reader.
 *
 * Orchestrates the full cache-storage scan:
 *   1. Resolve Chrome's Service Worker/CacheStorage directory (repo)
 *   2. Extract candidate origin URLs from Service Worker/Database `.log`/`.ldb`
 *      files (repo)
 *   3. Compute Chrome's per-origin directory hash
 *      (SHA1("<scheme>_<hostname>_<port>") with "0" for default ports)
 *   4. For each on-disk match, parse the binary `index.txt` to recover the
 *      protobuf-framed cache-name tokens (UUID / $-ref / pure-numeric / hex
 *      tokens are discarded)
 *   5. Compute a stable 16-hex-char sha256 prefix per origin for change
 *      detection
 *
 * All filesystem boundaries go through repo.ts; this file is pure business
 * logic plus `crypto`.
 */

import crypto from 'crypto';
import {
  EXCLUDED_ORIGIN_SUBSTRINGS,
  LOG_COMPONENT,
  MAX_CACHE_NAME_LENGTH,
  MAX_HEX_TOKEN_LENGTH,
  MIN_TOKEN_LENGTH,
  ORIGIN_HASH_PREFIX_LENGTH,
} from './config';
import {
  listSwDatabaseFiles,
  readOriginIndex,
  readSwDatabaseFile,
  resolveCacheStorageDir,
  resolveServiceWorkerDbDir,
} from './repo';
import type { CacheInfo, CacheStorageData, CacheStorageOriginData } from './types';

// ---------------------------------------------------------------------------
// Origin extraction from Service Worker database
// ---------------------------------------------------------------------------

/**
 * Normalize a candidate origin URL: drop trailing slash, leave scheme/host
 * intact. Chrome's SW DB happens to store them mostly-already-normalized; we
 * just make sure we don't emit duplicate `https://x.com` and `https://x.com/`.
 */
function normalizeOrigin(raw: string): string {
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/**
 * Return true for origins that must be dropped before the dir-hash step —
 * chrome-extension URLs, localhost, and loopback IPs never carry real
 * cache-storage metadata we care about.
 */
function isExcludedOrigin(origin: string): boolean {
  return EXCLUDED_ORIGIN_SUBSTRINGS.some((needle) => origin.includes(needle));
}

/**
 * Scan Chrome's Service Worker database for candidate origin URLs. Per-file
 * read errors are swallowed so the scan keeps going across sibling files.
 */
export function extractOriginsFromSwDatabase(): string[] {
  const origins = new Set<string>();

  try {
    const swDbPath = resolveServiceWorkerDbDir();
    if (swDbPath === null) {
      console.log(`[${LOG_COMPONENT}] Service Worker database not found`);
      return [];
    }

    for (const fileName of listSwDatabaseFiles(swDbPath)) {
      const content = readSwDatabaseFile(swDbPath, fileName);
      if (content === null) continue;

      const text = content.toString('utf8');
      const matches = text.matchAll(/https?:\/\/[\w.-]+(?::\d+)?/g);

      for (const match of matches) {
        const candidate = match[0];
        if (isExcludedOrigin(candidate)) continue;
        origins.add(normalizeOrigin(candidate));
      }
    }
  } catch (error) {
    console.error(`[${LOG_COMPONENT}] Error reading SW database:`, error);
  }

  console.log(`[${LOG_COMPONENT}] Found ${origins.size} potential origins from SW database`);
  return Array.from(origins);
}

// ---------------------------------------------------------------------------
// Directory-hash computation
// ---------------------------------------------------------------------------

/**
 * Compute Chrome's CacheStorage directory hash for an origin.
 *
 * Chrome uses `SHA1("<scheme>_<hostname>_<port>")`. The port is "0" for the
 * default port of each scheme (https/443, http/80). Invalid URLs resolve to
 * an empty string and are skipped by the caller.
 */
export function computeCacheStorageDirHash(origin: string): string {
  try {
    const url = new URL(origin);
    const scheme = url.protocol.replace(':', '');
    const port = url.port === '' ? '0' : url.port;
    const identifier = `${scheme}_${url.hostname}_${port}`;
    return crypto.createHash('sha1').update(identifier).digest('hex');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// index.txt protobuf-string parser
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CACHE_NAME_PATTERN = /^[a-zA-Z0-9_\-./:]+$/;
const PURE_NUMERIC_PATTERN = /^[0-9.]+$/;
const PURE_HEX_PATTERN = /^[0-9a-f]+$/;

/**
 * Pull every printable-ASCII run of length `>= MIN_TOKEN_LENGTH` out of a raw
 * buffer. Cache names live between non-printable protobuf field markers.
 */
function extractPrintableTokens(buffer: Buffer): string[] {
  const tokens: string[] = [];
  let current = '';
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte >= 0x20 && byte <= 0x7e) {
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= MIN_TOKEN_LENGTH) tokens.push(current);
      current = '';
    }
  }
  if (current.length >= MIN_TOKEN_LENGTH) tokens.push(current);
  return tokens;
}

/**
 * Return true for tokens that the parser should drop even though they pass
 * the printable-length cut — UUIDs (with or without a `$` prefix), $-prefixed
 * references, pure-numeric tokens, short hex blobs, and over-long strings.
 */
function isUnwantedCacheToken(token: string): boolean {
  if (UUID_PATTERN.test(token) || UUID_PATTERN.test(token.slice(1))) return true;
  if (token.startsWith('$')) return true;
  if (token.length < MIN_TOKEN_LENGTH) return true;
  if (PURE_HEX_PATTERN.test(token) && token.length <= MAX_HEX_TOKEN_LENGTH) return true;
  if (!CACHE_NAME_PATTERN.test(token)) return true;
  if (PURE_NUMERIC_PATTERN.test(token)) return true;
  if (token.length > MAX_CACHE_NAME_LENGTH) return true;
  return false;
}

/**
 * Parse cache names from Chrome's binary `index.txt`. Cache names are
 * length-prefixed strings in the protobuf blob; we extract every printable
 * run and discard everything that looks like metadata (UUIDs, $-refs, etc.).
 */
export function parseCacheNamesFromIndexBuffer(buffer: Buffer): string[] {
  const cacheNames: string[] = [];
  for (const token of extractPrintableTokens(buffer)) {
    if (isUnwantedCacheToken(token)) continue;
    if (!cacheNames.includes(token)) cacheNames.push(token);
  }
  return cacheNames;
}

// ---------------------------------------------------------------------------
// Per-origin change-detection hash
// ---------------------------------------------------------------------------

/** Stable short sha256 prefix over the sorted cache names of a single origin. */
export function computeOriginHash(caches: CacheInfo[]): string {
  const sorted = [...caches].sort((a, b) => a.name.localeCompare(b.name));
  const content = JSON.stringify(sorted.map((c) => c.name));
  return crypto
    .createHash('sha256')
    .update(content)
    .digest('hex')
    .slice(0, ORIGIN_HASH_PREFIX_LENGTH);
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** Empty `CacheStorageData` returned by all non-happy paths. */
function emptyResult(): CacheStorageData {
  return { origins: [], hashes: {}, originCount: 0 };
}

/**
 * Read Cache Storage metadata from Chrome's Service Worker directory.
 * Returns cache names per origin (not the actual cached responses).
 */
export async function readCacheStorage(): Promise<CacheStorageData> {
  const cachePath = resolveCacheStorageDir();
  if (cachePath === null) {
    console.log(`[${LOG_COMPONENT}] Chrome CacheStorage directory not found`);
    return emptyResult();
  }

  const origins: CacheStorageOriginData[] = [];
  const hashes: Record<string, string> = {};

  try {
    const swOrigins = extractOriginsFromSwDatabase();

    for (const origin of swOrigins) {
      const dirHash = computeCacheStorageDirHash(origin);
      if (dirHash === '') continue;

      const index = readOriginIndex(cachePath, dirHash);
      if (index === null) continue;

      const cacheNames = parseCacheNamesFromIndexBuffer(index.contents);
      if (cacheNames.length === 0) continue;

      // Belt-and-suspenders: chrome-extension origins are filtered upstream,
      // but keep the guard so this stage remains safe if that ever changes.
      if (origin.startsWith('chrome-extension://')) continue;

      const caches: CacheInfo[] = cacheNames.map((name) => ({ name }));
      origins.push({ origin, caches });
      hashes[origin] = computeOriginHash(caches);
    }

    console.log(`[${LOG_COMPONENT}] Read ${origins.length} origins with Cache Storage`);

    return { origins, hashes, originCount: origins.length };
  } catch (error) {
    console.error(`[${LOG_COMPONENT}] Error reading CacheStorage:`, error);
    return emptyResult();
  }
}
