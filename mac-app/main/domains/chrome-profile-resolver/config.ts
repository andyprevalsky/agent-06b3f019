/**
 * Configuration constants for the chrome-profile-resolver domain.
 *
 * Owns the macOS Chrome base-directory subpath and the `Preferences`
 * marker filename used to detect live profiles. Centralised so other
 * domains can depend on the resolver without hard-coding these strings.
 */

/** Log prefix used for all domain console output. */
export const LOG_COMPONENT = 'ChromeProfileResolver';

/**
 * macOS path (relative to the user's home dir) where Chrome stores its
 * per-profile data. We resolve it at call time via `app.getPath('home')`
 * rather than caching, so tests can stub `electron.app` per-case.
 */
export const CHROME_BASE_SUBPATH = 'Library/Application Support/Google/Chrome';

/**
 * Filename Chrome writes inside every active profile directory. Its
 * presence is our reliable "this profile exists" marker (Default,
 * Profile 1, Profile 2, …); mtime drives the "most recently used"
 * tie-breaker.
 */
export const PREFERENCES_FILENAME = 'Preferences';
