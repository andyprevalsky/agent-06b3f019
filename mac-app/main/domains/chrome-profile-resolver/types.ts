/**
 * Types for the chrome-profile-resolver domain.
 *
 * The resolver surfaces two shapes:
 *   - an absolute Chrome profile directory (`resolveChromeProfileDir`)
 *   - an absolute path to a file inside the active profile
 *     (`resolveChromeProfilePath`)
 *
 * Both return `null` when Chrome isn't installed, no profile is configured,
 * or the requested target doesn't exist on disk. Callers (cookie-reader,
 * local-storage-reader, cache-storage-reader, permission-reader) rely on
 * the null signal to short-circuit cleanly.
 */

/**
 * Internal record used while ranking candidate profile directories by the
 * mtime of their `Preferences` file. Not part of the public surface.
 */
export interface ProfileCandidate {
  dir: string;
  mtime: number;
}
