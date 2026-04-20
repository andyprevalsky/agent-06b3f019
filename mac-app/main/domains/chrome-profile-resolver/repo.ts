/**
 * Repo layer for chrome-profile-resolver.
 *
 * Owns every system boundary the domain touches:
 *   - `electron.app.getPath('home')` for the user's home directory
 *   - `fs.existsSync` / `fs.statSync` for disk checks + mtime lookup
 *   - `glob.sync` for enumerating `<base>/*\/Preferences` candidates
 *
 * Service layer never imports `fs`, `glob`, or `electron` directly — it
 * goes through these named, typed functions. Each is safe to stub in
 * blackbox tests (the suite mocks `electron`, `fs`, and `glob` at exactly
 * these seams).
 */

import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { glob } from 'glob';
import { CHROME_BASE_SUBPATH, PREFERENCES_FILENAME } from './config';

/**
 * Return the absolute path of Chrome's per-user base directory on macOS.
 * Computed on every call (rather than cached at module load) so tests can
 * stub `electron.app.getPath` per-case and get a fresh read.
 */
export function getChromeBaseDir(): string {
  return path.join(app.getPath('home'), CHROME_BASE_SUBPATH);
}

/**
 * Return `true` iff `p` exists on disk. Thin wrapper around `fs.existsSync`
 * so the service layer stays pure.
 */
export function fileExists(p: string): boolean {
  return fs.existsSync(p);
}

/**
 * Enumerate every `<base>/*\/Preferences` path under Chrome's base dir.
 * Uses `glob.sync` so the walk is synchronous — the resolver is called
 * from hot paths (cookie/local-storage/permission reads) and the glob
 * is tiny (≤ low-single-digit profile count).
 */
export function listPreferenceFiles(baseDir: string): string[] {
  const pattern = path.join(baseDir, `*/${PREFERENCES_FILENAME}`);
  return glob.sync(pattern);
}

/**
 * Return the mtime (as epoch millis) of the file at `p`. Throws on missing
 * file / permission error; the service calls this only on paths returned
 * by `listPreferenceFiles`, so missing-file isn't expected in practice.
 */
export function getMtimeMs(p: string): number {
  return fs.statSync(p).mtime.getTime();
}

/**
 * Join `profileDir` with the provided segments. Framework-agnostic helper
 * so the service doesn't have to import `path` directly.
 */
export function joinProfilePath(profileDir: string, segments: string[]): string {
  return path.join(profileDir, ...segments);
}

/** Return the parent directory of `p`. Wrapper around `path.dirname`. */
export function dirnameOf(p: string): string {
  return path.dirname(p);
}
