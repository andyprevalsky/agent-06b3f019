/**
 * Compatibility shim for the chrome-profile-resolver domain.
 *
 * The implementation lives in `main/domains/chrome-profile-resolver/` (types,
 * config, repo, service, runtime). This file preserves the original public
 * import path so that other domains (cookie-reader, local-storage-reader,
 * cache-storage-reader, permission-reader) and the blackbox tests keep
 * importing from `main/services/chromeProfileResolver` without changes.
 */

export {
  resolveChromeProfileDir,
  resolveChromeProfilePath,
} from '../domains/chrome-profile-resolver/runtime';
