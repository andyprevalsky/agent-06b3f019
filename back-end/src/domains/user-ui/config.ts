/**
 * Served by GET /usercontent/:versionId/*. User code is untrusted: in
 * production USERCONTENT_BASE_URL MUST point at a separate origin (e.g.
 * https://usercontent.roselabs.ai) so user UI never shares an origin — and
 * therefore cookies, storage or service workers — with the app or this API.
 * The backend-origin fallback exists only for local development.
 */
export const USERCONTENT_CSP =
  "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; img-src * data: blob:; media-src * data: blob:; " +
  "connect-src 'self'; frame-ancestors *";

export const USERCONTENT_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export function configuredUsercontentBaseUrl(): string | null {
  const value = process.env.USERCONTENT_BASE_URL?.trim();
  return value !== undefined && value !== '' ? value.replace(/\/+$/, '') : null;
}

export const USER_UI_LIST_LIMIT = 100;
