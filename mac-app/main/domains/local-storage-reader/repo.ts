/**
 * Repo layer for local-storage-reader.
 *
 * Owns every system boundary the domain touches:
 *   - Resolving the active Chrome `Local Storage/leveldb` directory
 *   - Duplicating that (locked) directory into a temp path
 *   - Opening/iterating the temp LevelDB via `classic-level`
 *   - Removing the temp copy on teardown
 *
 * Service layer never imports `fs`, `electron`, `classic-level`, or the
 * Chrome-profile resolver directly — it goes through these named, typed
 * functions. Each is safe to stub in blackbox tests (the suite mocks
 * `fs`/`electron`/`classic-level` exactly at these seams).
 */

import { ClassicLevel } from 'classic-level';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { resolveChromeProfilePath } from '../../services/chromeProfileResolver';
import { CHROME_LEVELDB_SEGMENT, CHROME_LOCAL_STORAGE_SEGMENT, TEMP_COPY_PREFIX } from './config';

/**
 * Return the absolute path of Chrome's `Local Storage/leveldb` directory for
 * the active profile, or null if Chrome is not installed / the directory
 * does not exist.
 */
export function resolveLocalStorageDir(): string | null {
  return resolveChromeProfilePath(CHROME_LOCAL_STORAGE_SEGMENT, CHROME_LEVELDB_SEGMENT);
}

/**
 * Allocate a fresh temp-copy path under `app.getPath('temp')`. Unique per
 * call (millisecond timestamp) so parallel reads don't collide.
 */
export function makeTempCopyPath(): string {
  return path.join(app.getPath('temp'), TEMP_COPY_PREFIX + Date.now());
}

/**
 * Duplicate Chrome's (locked) LevelDB directory into the temp path so we can
 * open it without fighting Chrome for the lock. Any copy error (permissions,
 * Chrome holding an exclusive lock, source gone mid-copy) is surfaced to the
 * caller so the service can fall back to an empty result.
 */
export function copyLevelDbToTemp(src: string, dest: string): void {
  fs.cpSync(src, dest, { recursive: true });
}

/**
 * Remove the temp LevelDB copy. Errors are intentionally swallowed — this is
 * a best-effort cleanup in a `finally` block; failing to remove is never a
 * reason to fail the overall read.
 */
export function removeTempCopy(dest: string): void {
  try {
    fs.rmSync(dest, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors.
  }
}

/**
 * Open a buffer-keyed / buffer-valued LevelDB handle against the temp copy
 * and return it. Caller is responsible for closing the handle.
 */
export function openLevelDb(dbPath: string): ClassicLevel<Buffer, Buffer> {
  return new ClassicLevel<Buffer, Buffer>(dbPath, {
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
  });
}
