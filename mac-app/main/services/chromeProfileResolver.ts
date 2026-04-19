import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { glob } from 'glob';

const HOME = app.getPath('home');
const CHROME_BASE = path.join(HOME, 'Library/Application Support/Google/Chrome');

/**
 * Resolve the active Chrome profile directory.
 * Chrome may use "Default" or "Profile 1", "Profile 2", etc.
 * Returns the profile dir with the most recently modified Preferences file,
 * or null if Chrome is not installed.
 */
export function resolveChromeProfileDir(): string | null {
  if (!fs.existsSync(CHROME_BASE)) {
    return null;
  }

  // Look for profile dirs that have a Preferences file (the reliable marker)
  const pattern = path.join(CHROME_BASE, '*/Preferences');
  const matches = glob.sync(pattern);

  if (matches.length === 0) {
    return null;
  }

  // Pick the most recently modified profile
  const sorted = matches
    .map((p) => ({ dir: path.dirname(p), mtime: fs.statSync(p).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime);

  const chosen = sorted[0].dir;
  console.log(`[ChromeProfileResolver] Resolved Chrome profile: ${chosen}`);
  return chosen;
}

/**
 * Resolve a path within the active Chrome profile directory.
 * e.g. resolveChromeProfilePath('Cookies') -> '/Users/x/.../Google/Chrome/Profile 1/Cookies'
 * Returns null if no Chrome profile is found or the target doesn't exist.
 */
export function resolveChromeProfilePath(...segments: string[]): string | null {
  const profileDir = resolveChromeProfileDir();
  if (profileDir === null) return null;
  const target = path.join(profileDir, ...segments);
  return fs.existsSync(target) ? target : null;
}
