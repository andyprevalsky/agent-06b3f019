/**
 * Served by GET /usercontent/:versionId/*. User code is untrusted: in
 * production USERCONTENT_BASE_URL MUST point at a separate origin (e.g.
 * https://usercontent.roselabs.ai) so user UI never shares an origin — and
 * therefore cookies, storage or service workers — with the app or this API.
 * The backend-origin fallback exists only for local development.
 *
 * worker-src blob: lets user views run Web Workers (e.g. OffscreenCanvas). The
 * sandboxed frame's origin is opaque, so `new Worker(url)` on usercontent is
 * refused as cross-origin; a blob: worker created by the frame inherits the
 * frame's own opaque origin and gets no extra capability. Without this
 * directive worker-src falls back to script-src, which blocks blob:.
 * The rose-ui preview CLI serves the identical policy (unit-tested).
 */
export const USERCONTENT_CSP =
  "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; img-src * data: blob:; media-src * data: blob:; " +
  "connect-src 'self'; worker-src blob:; frame-ancestors *";

export const USERCONTENT_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export function configuredUsercontentBaseUrl(): string | null {
  const value = process.env.USERCONTENT_BASE_URL?.trim();
  return value !== undefined && value !== '' ? value.replace(/\/+$/, '') : null;
}

export const USER_UI_LIST_LIMIT = 100;
