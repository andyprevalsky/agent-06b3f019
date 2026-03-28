/**
 * Production-aware logging utilities.
 * Truncates large payloads in production to prevent OOM crashes.
 * Keeps full output in development for debugging.
 */

const isProd = process.env.NODE_ENV === 'production';

const PROD_MAX_LENGTH = 500;

/**
 * Safely stringify an object for logging.
 * In production: truncates to 500 chars.
 * In development: full pretty-printed JSON.
 */
export function logJson(obj: unknown, maxLength = PROD_MAX_LENGTH): string {
  try {
    const str = isProd ? JSON.stringify(obj) : JSON.stringify(obj, null, 2);

    if (str === undefined) return 'undefined';

    if (isProd && str.length > maxLength) {
      return str.substring(0, maxLength) + `... (${str.length} chars total)`;
    }

    return str;
  } catch {
    // Circular references or other stringify failures
    return '[unserializable]';
  }
}

/**
 * Truncate a string for logging in production.
 * In development: returns full string.
 */
export function logTruncate(str: string, maxLength = PROD_MAX_LENGTH): string {
  if (!isProd || str.length <= maxLength) return str;
  return str.substring(0, maxLength) + `... (${str.length} chars total)`;
}
