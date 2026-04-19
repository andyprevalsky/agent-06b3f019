/**
 * Configuration constants for the local-storage-reader domain.
 *
 * All tunables live here — log component prefix, the Chrome-profile subpath
 * pair, the value-framing encoding-byte sentinels Chrome uses inside LevelDB,
 * and the per-origin change-detection hash prefix length.
 */

/** Log prefix used for all domain console output. */
export const LOG_COMPONENT = 'LocalStorageReader';

/** Chrome stores localStorage LevelDB under `<profile>/Local Storage/leveldb`. */
export const CHROME_LOCAL_STORAGE_SEGMENT = 'Local Storage' as const;
export const CHROME_LEVELDB_SEGMENT = 'leveldb' as const;

/** Prefix used by `fs.cpSync` when duplicating the locked LevelDB into temp. */
export const TEMP_COPY_PREFIX = 'localStorage-copy-';

/** First byte of every Chrome localStorage key ("_"). */
export const KEY_PREFIX_BYTE = 0x5f;

/** Chrome's value-encoding sentinels. 0x00 = UTF-16-LE, 0x01 = Latin-1. */
export const ENCODING_UTF16_LE = 0x00;
export const ENCODING_LATIN1 = 0x01;

/** Length of the sha256 prefix used as a per-origin change-detection hash. */
export const ORIGIN_HASH_PREFIX_LENGTH = 16;

/** Keys starting with this prefix are Chrome-internal metadata, skipped. */
export const META_KEY_PREFIX = 'META:';

/** Origins with this scheme are extensions, skipped. */
export const EXTENSION_ORIGIN_PREFIX = 'chrome-extension://';
