/**
 * Integration identifier used to check connection status and to tag the
 * batch upload. Must match the name registered server-side.
 */
export const COOKIE_SYNC_INTEGRATION = 'chrome' as const;

/**
 * Log prefix used across cookie-sync layers. Keeping it centralized avoids
 * drift between repo/service/runtime log lines.
 */
export const COOKIE_SYNC_LOG_PREFIX = '[CookieSync]';
