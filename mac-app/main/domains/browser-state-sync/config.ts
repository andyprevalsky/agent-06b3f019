// Domain-level constants for browser-state-sync.

/** Maximum number of origins packed into a single upload batch. */
export const ORIGINS_PER_BATCH = 100;

/** Total retry attempts for transient batch upload failures. */
export const MAX_RETRIES = 3;

/** Base retry backoff (exponential: base * 2^attempt) in ms. */
export const RETRY_DELAY_MS = 1000;

/** Browser integration identifiers this domain knows how to sync. */
export const VALID_BROWSERS = [
  'chrome',
  'edge',
  'brave',
  'arc',
  'opera',
  'vivaldi',
  'chromium',
  'atlas',
  'safari',
  'firefox',
] as const;

/** Browser identifiers supporting password extraction. */
export const SUPPORTED_PASSWORD_BROWSERS = [
  'chrome',
  'edge',
  'brave',
  'arc',
  'opera',
  'vivaldi',
  'chromium',
  'atlas',
] as const;

/** Domains we eagerly read from IndexedDB (full scan is too slow). */
export const INDEXED_DB_FILTERS = [
  'amazon',
  'google',
  'doordash',
  'instacart',
  'uber',
  'netflix',
  'spotify',
] as const;

/** Backend upload endpoints (joined with apiUrl at call-site). */
export const ENDPOINTS = {
  localStorage: '/api/integrations/localStorage/upload',
  indexedDB: '/api/integrations/indexedDB/upload',
  permissions: '/api/integrations/permissions/upload',
  cacheStorage: '/api/integrations/cacheStorage/upload',
  passwords: '/api/integrations/passwords/upload',
} as const;
