/**
 * Repo layer for cache-storage-reader.
 *
 * Owns every filesystem boundary the domain touches:
 *   - Resolving the active Chrome profile directory for a path suffix
 *   - Listing and reading `.log` / `.ldb` files inside Service Worker/Database
 *   - Checking existence of and reading per-origin CacheStorage `index.txt`
 *
 * Service layer never imports `fs` or the Chrome-profile resolver directly —
 * it goes through these named, typed functions. Each function has typed args
 * in and typed results out, and is safe to stub in blackbox tests.
 */

import fs from 'fs';
import path from 'path';
import { resolveChromeProfilePath } from '../../services/chromeProfileResolver';
import { SW_DB_FILE_EXTENSIONS } from './config';

/**
 * Return the absolute path of Chrome's Service Worker/CacheStorage directory
 * for the active profile, or null if Chrome is not installed / the directory
 * does not exist.
 */
export function resolveCacheStorageDir(): string | null {
  return resolveChromeProfilePath('Service Worker', 'CacheStorage');
}

/**
 * Return the absolute path of Chrome's Service Worker/Database directory for
 * the active profile, or null if it is missing.
 */
export function resolveServiceWorkerDbDir(): string | null {
  return resolveChromeProfilePath('Service Worker', 'Database');
}

/**
 * List the `.log` / `.ldb` files inside a Service-Worker database directory.
 * Any filesystem error (permission, gone-midway) is surfaced to the caller.
 */
export function listSwDatabaseFiles(swDbPath: string): string[] {
  const entries = fs.readdirSync(swDbPath);
  return entries.filter((entry) => SW_DB_FILE_EXTENSIONS.some((ext) => entry.endsWith(ext)));
}

/**
 * Read the raw bytes of a single SW-database file. Returns `null` on any
 * filesystem error so the scanner can keep going across sibling files.
 */
export function readSwDatabaseFile(swDbPath: string, fileName: string): Buffer | null {
  try {
    return fs.readFileSync(path.join(swDbPath, fileName));
  } catch {
    return null;
  }
}

/**
 * Read a per-origin CacheStorage `index.txt` if it exists. Returns `null`
 * when the origin directory is missing or the index file cannot be read.
 *
 * The explicit origin-dir existence check is load-bearing: the blackbox
 * suite wires `fs.existsSync` to distinguish "dir absent" from "index
 * absent", so this pre-check is the observable boundary, not a TOCTOU.
 */
export function readOriginIndex(
  cacheStorageDir: string,
  dirHash: string
): { indexPath: string; contents: Buffer } | null {
  const originPath = path.join(cacheStorageDir, dirHash);
  if (!fs.existsSync(originPath)) return null;

  const indexPath = path.join(originPath, 'index.txt');
  if (!fs.existsSync(indexPath)) return null;

  try {
    return { indexPath, contents: fs.readFileSync(indexPath) };
  } catch {
    return null;
  }
}
