/**
 * Configuration constants for the auth domain.
 *
 * Houses the electron-store namespace used to persist the session blob and
 * the pre-expiry buffer that drives proactive token refresh inside
 * getSession().
 */

/** Namespace passed to `new Store({ name })` for the auth session file. */
export const AUTH_STORE_NAME = 'navi-auth';

/**
 * Milliseconds before `expires_at` at which getSession() will eagerly refresh
 * the session. Keeps UI callers from ever seeing a token that's about to
 * expire mid-request.
 */
export const REFRESH_BUFFER_MS = 60 * 1000;

/**
 * Threshold below which an `expires_at` value is treated as seconds-precision
 * and multiplied by 1000 to yield milliseconds. Anything at or above this
 * value is assumed to already be milliseconds.
 *
 * 1e12 corresponds to 2001-09-09 in ms — well before any plausible session
 * expires_at — and is ~31,700 years when interpreted as seconds, so no real
 * token will ever cross the threshold in the wrong direction.
 */
export const MILLISECOND_THRESHOLD = 1_000_000_000_000;
