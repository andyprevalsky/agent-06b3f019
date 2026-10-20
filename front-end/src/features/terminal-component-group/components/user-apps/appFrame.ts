/**
 * Frame rules for app views (pure, testable without rendering).
 *
 *   published user app (usercontent origin) → sandbox "allow-scripts" only, like
 *     every rose_user_ui frame: opaque origin, no app cookies/storage/session
 *   code-session preview (Rose / a task: https://5173-<sandbox>…) → its own
 *     origin (allow-same-origin keeps the preview's OWN storage so it can hold
 *     its own Supabase sign-in); it must never be the app origin
 *
 * Sign-in for the preview origin uses the backend's single-use handoff code in
 * the URL fragment (L-APPS2); no token is ever put in a URL or postMessage.
 */

export const USER_APP_FRAME_SANDBOX = 'allow-scripts';
export const PREVIEW_FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups';
export const PREVIEW_HANDOFF_PARAM = 'rose_preview_handoff';

function appOrigin(): string | null {
  return typeof window === 'undefined' ? null : window.location.origin;
}

/** Absolute http(s) URL on another origin than the app (never framed same-origin). */
export function isCrossOriginHttpUrl(
  url: string | null | undefined,
  origin: string | null = appOrigin(),
): url is string {
  if (typeof url !== 'string' || url === '') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  return origin === null || parsed.origin !== origin;
}

/** preview_url + '#rose_preview_handoff=<code>' (replaces any existing fragment). */
export function withPreviewHandoff(previewUrl: string, code: string): string {
  const base = previewUrl.split('#')[0];
  return `${base}#${PREVIEW_HANDOFF_PARAM}=${encodeURIComponent(code)}`;
}

/** Fixed desktop viewport the trajectory card scales down. */
export const PREVIEW_CARD_VIEWPORT = { width: 1280, height: 800 } as const;
export const PREVIEW_CARD_WIDTH = 240;
export const PREVIEW_CARD_SCALE = PREVIEW_CARD_WIDTH / PREVIEW_CARD_VIEWPORT.width;
