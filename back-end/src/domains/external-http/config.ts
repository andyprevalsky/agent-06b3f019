/** External HTTP proxy configuration for explore api_request tool. */

export const REQUEST_TIMEOUT_MS = 120_000;
export const MAX_ATTEMPTS = 4;
export const INITIAL_RETRY_DELAY_MS = 500;
export const MAX_RETRY_DELAY_MS = 8_000;
export const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
