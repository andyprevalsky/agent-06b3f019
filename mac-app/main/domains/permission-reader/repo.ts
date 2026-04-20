/**
 * Repo layer for permission-reader.
 *
 * Owns every system boundary the domain touches:
 *   - Resolving the active Chrome `Preferences` file
 *   - Reading that file's JSON text
 *
 * Service layer never imports `fs` or the Chrome-profile resolver directly —
 * it goes through these named, typed functions. Each is safe to stub in
 * blackbox tests (the suite mocks `fs` and the profile resolver exactly at
 * these seams).
 */

import fs from 'fs';
import { resolveChromeProfilePath } from '../../services/chromeProfileResolver';
import { CHROME_PREFERENCES_SEGMENT } from './config';

/**
 * Return the absolute path of Chrome's `Preferences` file for the active
 * profile, or null if Chrome is not installed / the file does not exist.
 */
export function resolvePreferencesPath(): string | null {
  return resolveChromeProfilePath(CHROME_PREFERENCES_SEGMENT);
}

/**
 * Read the raw Chrome `Preferences` JSON text from disk. Throws on I/O error
 * (e.g. permission denied, file disappeared); the service layer catches and
 * falls back to an empty result.
 */
export function readPreferencesFile(path: string): string {
  return fs.readFileSync(path, 'utf-8');
}
