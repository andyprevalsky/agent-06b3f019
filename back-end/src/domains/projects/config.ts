/** Projects domain limits. */

export {
  DEFAULT_STARTUP_TIMEOUT_S,
  MAX_ENV_FILE_BYTES,
  MAX_STARTUP_SCRIPT_BYTES,
  MAX_STARTUP_TIMEOUT_S,
  MIN_STARTUP_TIMEOUT_S,
} from './types';
/** Encrypted git bundle / patch envelope caps (strings, after base64 + envelope). */
export const MAX_GIT_BUNDLE_ENVELOPE_CHARS = 70 * 1024 * 1024;
export const MAX_PATCH_ENVELOPE_CHARS = 25 * 1024 * 1024;
