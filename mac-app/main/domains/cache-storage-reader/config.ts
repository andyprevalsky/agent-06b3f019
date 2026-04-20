/**
 * Configuration constants for the cache-storage-reader domain.
 *
 * Houses parser thresholds for the protobuf-style index.txt blob and the
 * origin-filter lists applied to Service-Worker database extracts.
 */

/** Log prefix used for all domain console output. */
export const LOG_COMPONENT = 'CacheStorageReader';

/** File extensions inside Chrome's Service Worker/Database we parse for URLs. */
export const SW_DB_FILE_EXTENSIONS = ['.log', '.ldb'] as const;

/** Minimum printable-run length considered a candidate token in index.txt. */
export const MIN_TOKEN_LENGTH = 3;

/** Maximum printable-run length allowed to be considered a cache name. */
export const MAX_CACHE_NAME_LENGTH = 100;

/** Treat pure-hex tokens no longer than this as non-cache-names (UUIDs, hashes). */
export const MAX_HEX_TOKEN_LENGTH = 16;

/** Length of the sha256 prefix used as a per-origin change-detection hash. */
export const ORIGIN_HASH_PREFIX_LENGTH = 16;

/** Origin substrings that must never surface as cache-storage origins. */
export const EXCLUDED_ORIGIN_SUBSTRINGS = [
  'chrome-extension://',
  'localhost',
  '127.0.0.1',
] as const;
