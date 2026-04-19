import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { resolveChromeProfilePath } from './chromeProfileResolver';

export interface CacheInfo {
  name: string;
  size?: number;
}

export interface CacheStorageOriginData {
  origin: string;
  caches: CacheInfo[];
}

export interface CacheStorageData {
  origins: CacheStorageOriginData[];
  hashes: Record<string, string>; // origin -> hash
  originCount: number;
}

/**
 * Extract origin URLs from Chrome's Service Worker database files.
 * The database is LevelDB format, but we can extract URLs using string matching.
 */
function extractOriginsFromSwDatabase(): string[] {
  const origins = new Set<string>();

  try {
    const swDbPath = resolveChromeProfilePath('Service Worker', 'Database');
    if (!swDbPath) {
      console.log('[CacheStorageReader] Service Worker database not found');
      return [];
    }

    // Read all .log and .ldb files in the database directory
    const entries = fs.readdirSync(swDbPath);

    for (const entry of entries) {
      if (!entry.endsWith('.log') && !entry.endsWith('.ldb')) continue;

      const filePath = path.join(swDbPath, entry);

      try {
        const content = fs.readFileSync(filePath);
        const text = content.toString('utf8');

        // Match https:// or http:// URLs followed by domain
        // Be careful to only match valid origin patterns
        const matches = text.matchAll(/https?:\/\/[\w.-]+(?::\d+)?/g);

        for (const match of matches) {
          const url = match[0];
          // Skip chrome-extension and localhost for service workers
          if (url.includes('chrome-extension://')) continue;
          if (url.includes('localhost')) continue;
          if (url.includes('127.0.0.1')) continue;

          // Normalize: remove trailing slash and port for standard ports
          let origin = url;
          if (origin.endsWith('/')) {
            origin = origin.slice(0, -1);
          }

          origins.add(origin);
        }
      } catch {
        // Skip files we can't read
      }
    }
  } catch (error) {
    console.error('[CacheStorageReader] Error reading SW database:', error);
  }

  console.log(`[CacheStorageReader] Found ${origins.size} potential origins from SW database`);
  return Array.from(origins);
}

/**
 * Compute Chrome's CacheStorage directory hash for an origin.
 * Chrome uses: SHA1(scheme + "_" + hostname + "_" + port)
 * For https with default port 443, use port "0"
 * For http with default port 80, use port "0"
 */
function computeCacheStorageDirHash(origin: string): string {
  try {
    const url = new URL(origin);
    const scheme = url.protocol.replace(':', '');
    const hostname = url.hostname;

    // Chrome uses 0 for default ports
    let port = '0';
    if (url.port) {
      port = url.port;
    }

    const identifier = `${scheme}_${hostname}_${port}`;
    return crypto.createHash('sha1').update(identifier).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Parse cache names from Chrome's binary index.txt file (protobuf format).
 * Cache names and UUIDs are separated by non-printable protobuf field markers.
 * We extract readable strings and filter for cache-name-like patterns.
 */
function parseCacheNamesFromIndex(indexPath: string): string[] {
  const cacheNames: string[] = [];

  try {
    const buffer = fs.readFileSync(indexPath);

    // Extract all readable ASCII strings (min length 3)
    // Cache names are stored as length-prefixed strings in protobuf format
    const strings: string[] = [];
    let current = '';

    for (let i = 0; i < buffer.length; i++) {
      const byte = buffer[i];
      // Printable ASCII range (space to tilde) plus common chars
      if (byte >= 0x20 && byte <= 0x7e) {
        current += String.fromCharCode(byte);
      } else {
        if (current.length >= 3) {
          strings.push(current);
        }
        current = '';
      }
    }
    if (current.length >= 3) {
      strings.push(current);
    }

    // Filter strings to find cache names
    // Cache names are NOT UUIDs and typically contain meaningful characters
    const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

    for (const str of strings) {
      // Skip UUIDs (with or without $ prefix)
      if (uuidPattern.test(str) || uuidPattern.test(str.slice(1))) continue;

      // Skip strings that start with $ (UUID references)
      if (str.startsWith('$')) continue;

      // Skip very short strings or hex-like strings
      if (str.length < 3) continue;
      if (/^[0-9a-f]+$/.test(str) && str.length <= 16) continue;

      // Cache names typically look like: "offline-asset-cache", "sw-/mail/u/2/", etc.
      // They contain alphanumeric chars, dashes, slashes, dots
      if (/^[a-zA-Z0-9_\-./:]+$/.test(str)) {
        // Skip obvious non-cache-name patterns
        if (str.match(/^[0-9.]+$/)) continue; // Pure numbers/decimals
        if (str.length > 100) continue; // Too long

        if (!cacheNames.includes(str)) {
          cacheNames.push(str);
        }
      }
    }
  } catch {
    // Ignore read errors
  }

  return cacheNames;
}

/**
 * Compute a hash of cache storage data for change detection.
 */
function computeOriginHash(caches: CacheInfo[]): string {
  const sorted = [...caches].sort((a, b) => a.name.localeCompare(b.name));
  const content = JSON.stringify(sorted.map((c) => c.name));
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export class CacheStorageReader {
  /**
   * Read Cache Storage metadata from Chrome's Service Worker directory.
   * Returns cache names per origin (not the actual cached responses).
   *
   * Algorithm:
   * 1. Extract origin URLs from Service Worker database
   * 2. For each origin, compute the CacheStorage directory hash
   * 3. If directory exists, parse index.txt for cache names
   */
  static async readCacheStorage(): Promise<CacheStorageData> {
    // Resolve Chrome CacheStorage directory across profile directories
    const cachePath = resolveChromeProfilePath('Service Worker', 'CacheStorage');
    if (!cachePath) {
      console.log('[CacheStorageReader] Chrome CacheStorage directory not found');
      return {
        origins: [],
        hashes: {},
        originCount: 0,
      };
    }

    const origins: CacheStorageOriginData[] = [];
    const hashes: Record<string, string> = {};

    try {
      // Step 1: Get all origins from Service Worker database
      const swOrigins = extractOriginsFromSwDatabase();

      // Step 2: For each origin, check if CacheStorage directory exists
      for (const origin of swOrigins) {
        const dirHash = computeCacheStorageDirHash(origin);
        if (!dirHash) continue;

        const originPath = path.join(cachePath, dirHash);

        if (!fs.existsSync(originPath)) continue;

        // Step 3: Parse index.txt for cache names
        const indexPath = path.join(originPath, 'index.txt');

        if (!fs.existsSync(indexPath)) continue;

        const cacheNames = parseCacheNamesFromIndex(indexPath);

        // Only include origins that have caches
        if (cacheNames.length === 0) continue;

        // Skip chrome-extension origins
        if (origin.startsWith('chrome-extension://')) continue;

        const caches: CacheInfo[] = cacheNames.map((name) => ({ name }));

        origins.push({
          origin,
          caches,
        });

        hashes[origin] = computeOriginHash(caches);
      }

      console.log(`[CacheStorageReader] Read ${origins.length} origins with Cache Storage`);

      return {
        origins,
        hashes,
        originCount: origins.length,
      };
    } catch (error) {
      console.error('[CacheStorageReader] Error reading CacheStorage:', error);
      return {
        origins: [],
        hashes: {},
        originCount: 0,
      };
    }
  }
}
