/**
 * Service layer for chrome-profile-resolver.
 *
 * Orchestrates the resolution algorithm:
 *   1. Check Chrome's base dir exists (repo). Short-circuit to `null` if not —
 *      this is the hot no-Chrome case and we want zero glob calls.
 *   2. Enumerate `<base>/*\/Preferences` candidates (repo).
 *   3. Pick the candidate whose `Preferences` file has the most recent mtime
 *      (repo stat) — Chrome's "most recently used profile" heuristic.
 *   4. For path resolution, join the chosen profile dir with caller segments
 *      and verify the target exists (repo); return `null` otherwise.
 *
 * All filesystem / Electron / glob boundaries go through repo.ts; this file
 * is pure sort-and-pick logic.
 */

import { LOG_COMPONENT } from './config';
import {
  dirnameOf,
  fileExists,
  getChromeBaseDir,
  getMtimeMs,
  joinProfilePath,
  listPreferenceFiles,
} from './repo';
import type { ProfileCandidate } from './types';

/**
 * Resolve the active Chrome profile directory.
 * Chrome may use "Default" or "Profile 1", "Profile 2", etc.
 * Returns the profile dir with the most recently modified Preferences file,
 * or null if Chrome is not installed.
 */
export function resolveChromeProfileDir(): string | null {
  const baseDir = getChromeBaseDir();
  if (!fileExists(baseDir)) {
    return null;
  }

  const matches = listPreferenceFiles(baseDir);
  if (matches.length === 0) {
    return null;
  }

  const candidates: ProfileCandidate[] = matches.map((p) => ({
    dir: dirnameOf(p),
    mtime: getMtimeMs(p),
  }));
  candidates.sort((a, b) => b.mtime - a.mtime);

  const chosen = candidates[0].dir;
  console.log(`[${LOG_COMPONENT}] Resolved Chrome profile: ${chosen}`);
  return chosen;
}

/**
 * Resolve a path within the active Chrome profile directory.
 * e.g. resolveChromeProfilePath('Cookies') -> '/Users/x/.../Google/Chrome/Profile 1/Cookies'
 * Returns null if no Chrome profile is found or the target doesn't exist.
 */
export function resolveChromeProfilePath(segments: string[]): string | null {
  const profileDir = resolveChromeProfileDir();
  if (profileDir === null) return null;
  const target = joinProfilePath(profileDir, segments);
  return fileExists(target) ? target : null;
}
