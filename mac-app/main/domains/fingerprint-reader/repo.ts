/**
 * Repo layer for fingerprint-reader.
 *
 * Owns every filesystem boundary the domain touches:
 *   - Discovering a Chrome executable across the candidate paths
 *   - Creating the per-launch temporary user-data-dir under os.tmpdir()
 *   - Removing the temp dir after the launch finishes (success or error)
 *
 * Service never imports `fs` / `os` / `path` directly — it goes through
 * these named, typed functions so the blackbox harness can stub the fs
 * boundary in one place.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveChromePaths, TEMP_USER_DATA_DIR_PREFIX } from './config';

/**
 * Walk the candidate Chrome paths in order and return the first one that
 * exists on disk, or null if none are present. Matches the pre-refactor
 * priority (system → Canary → user-home install).
 */
export function findChromeExecutable(): string | null {
  for (const chromePath of resolveChromePaths()) {
    if (fs.existsSync(chromePath)) {
      return chromePath;
    }
  }
  return null;
}

/**
 * Create a fresh temp user-data-dir under os.tmpdir() with a unique,
 * timestamp-suffixed name. Puppeteer requires a writable profile dir even
 * though the fingerprint is system-level, not profile-level.
 */
export function createTempUserDataDir(): string {
  const dir = path.join(os.tmpdir(), `${TEMP_USER_DATA_DIR_PREFIX}${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Best-effort recursive remove of a temp user-data-dir. Cleanup errors are
 * swallowed — a leftover temp profile is acceptable, crashing the sync is
 * not.
 */
export function removeTempUserDataDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors (EBUSY, ENOENT, etc.)
  }
}
