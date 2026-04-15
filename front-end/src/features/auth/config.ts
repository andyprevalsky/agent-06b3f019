/**
 * Auth feature — configuration constants.
 *
 * Env reads, defaults, and magic values live here.
 * May import from own types only.
 */

/** Backend API base URL (no trailing slash). */
export const AUTH_API_BASE_URL = (
  import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001'
).replace(/\/$/, '');
