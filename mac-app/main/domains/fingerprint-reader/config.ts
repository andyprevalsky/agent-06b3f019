/**
 * Configuration constants for the fingerprint-reader domain.
 *
 * Houses the macOS Chrome-binary search paths, puppeteer launch flags, and
 * page-navigation timeouts. The user's home-dir candidate is resolved lazily
 * at call time (via `resolveChromePaths`) because `app.getPath('home')` is an
 * Electron side-effect that must not run at module load.
 */

import { app } from 'electron';
import path from 'path';

/** Log prefix used by every console message the domain emits. */
export const LOG_COMPONENT = 'FingerprintReader';

/** Filesystem-only Chrome executable locations on macOS (no home dir). */
const SYSTEM_CHROME_PATHS: readonly string[] = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
];

/**
 * Return the ordered list of candidate Chrome executable paths. The user's
 * `~/Applications/Google Chrome.app/...` path is appended last so the
 * system-wide install wins when both exist. Resolved at call time so
 * `app.getPath` runs only when the service actually needs it.
 */
export function resolveChromePaths(): string[] {
  return [
    ...SYSTEM_CHROME_PATHS,
    path.join(app.getPath('home'), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ];
}

/** Prefix used for the per-launch Chrome user-data-dir under os.tmpdir(). */
export const TEMP_USER_DATA_DIR_PREFIX = 'rose-fingerprint-';

/** Navigation target whose APIs unlock the full fingerprint evaluation. */
export const FINGERPRINT_NAV_URL = 'https://example.com';

/** `page.goto` timeout for the fingerprint-collection navigation. */
export const FINGERPRINT_NAV_TIMEOUT_MS = 10_000;

/**
 * Chrome command-line flags shared across every fingerprint-collection
 * launch. Headful is required (headless reports fake screen metrics and a
 * "HeadlessChrome" userAgent), so the window is shoved off-screen and shrunk
 * to 1×1 to stay out of the user's way.
 */
export const FINGERPRINT_CHROME_ARGS: readonly string[] = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--window-position=-10000,-10000',
  '--window-size=1,1',
  '--start-minimized',
];
