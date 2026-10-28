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

/** `rose agent-init --login-code`: a minted code works once, for this long (boxes.dev parity). */
export const CLI_LOGIN_CODE_TTL_MS = 30 * 60_000;
/** The projects-scoped personal credential a code is exchanged for. */
export const CLI_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60_000;
/** Failed exchange attempts allowed per client address per window (then 429). */
export const CLI_EXCHANGE_RATE_LIMIT = 10;
export const CLI_EXCHANGE_RATE_WINDOW_MS = 15 * 60_000;
/** Failed exchanges across all addresses per window: a backstop against address spraying. */
export const CLI_EXCHANGE_GLOBAL_RATE_LIMIT = 600;
/** Bounded limiter memory: at most this many tracked client addresses per window. */
export const CLI_EXCHANGE_RATE_MAX_KEYS = 10_000;
