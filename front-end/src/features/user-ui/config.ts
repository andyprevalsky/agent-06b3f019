/**
 * Constants and pure validators for the per-user UI runtime.
 *
 * Everything that decides whether user-authored data may touch the app origin
 * lives here so the security rules are testable without rendering: user files
 * load only from an http(s) usercontent origin that differs from the app
 * origin (never `srcdoc`, `blob:`, `data:` or same-origin).
 */
import type { InlineViewMetadata, UserUiViewMessage } from './types';

/** The ONLY sandbox flags a user frame ever gets (no allow-same-origin). */
export const USER_UI_IFRAME_SANDBOX = 'allow-scripts';
export const INLINE_VIEW_MIN_HEIGHT = 60;
export const INLINE_VIEW_MAX_HEIGHT = 900;
export const INLINE_VIEW_DEFAULT_HEIGHT = 240;
/** Max simultaneously-live inline iframes in one trajectory. */
export const INLINE_VIEW_LIVE_CAP = 4;
/** How far outside the viewport an inline view may be and still go live. */
export const INLINE_VIEW_ROOT_MARGIN = '400px 0px';
export const LIVE_RELOAD_POLL_MS = 5_000;
/** Any number of live-refresh requests inside this window collapse into one GET. */
export const USER_UI_REFRESH_WINDOW_MS = 750;
export const SAFE_MODE_STORAGE_KEY = 'rose_safe_mode';
export const SAFE_MODE_QUERY_PARAM = 'rose_safe';
export const LIVE_RELOAD_QUERY_PARAM = 'rose_ui_live';
export const USER_UI_IS_DEV = import.meta.env.DEV === true;

function currentAppOrigin(): string | null {
  return typeof window === 'undefined' ? null : window.location.origin;
}

/**
 * True only for absolute http(s) URLs on a different origin than the app.
 * User code must never be loaded on the app origin.
 */
export function isAllowedUserContentUrl(
  url: string,
  appOrigin: string | null = currentAppOrigin(),
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (appOrigin !== null && parsed.origin === appOrigin) return false;
  return true;
}

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  if (path.startsWith('//') || path.includes('\\')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return !path.split('/').some((segment) => segment === '..');
}

/** `${baseUrl}${path}` for a manifest-relative file, or null when unsafe. */
export function joinUserContentUrl(baseUrl: string, path: string): string | null {
  if (!isSafeRelativePath(path)) return null;
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = `${base}${path.replace(/^\.?\//, '')}`;
  return isAllowedUserContentUrl(url) ? url : null;
}

/** Origin of a usercontent URL (the origin a frame was loaded from). */
export function userContentOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Base URL of an immutable published version's files on the backend. */
export function versionBaseUrl(backendBaseUrl: string, versionId: string): string {
  const backend = backendBaseUrl.replace(/\/$/, '');
  return `${backend}/usercontent/${encodeURIComponent(versionId)}/`;
}

export function parseInlineViewMetadata(value: unknown): InlineViewMetadata | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.view !== 'string' || record.view.length === 0) return null;
  if (typeof record.versionId !== 'string' || record.versionId.length === 0) return null;
  return { view: record.view, versionId: record.versionId, props: record.props };
}

/** Parse a postMessage payload from a user view; unknown shapes are dropped. */
export function parseViewMessage(data: unknown): UserUiViewMessage | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (record.type === 'rose:ready') return { type: 'rose:ready' };
  if (
    record.type === 'rose:resize' &&
    typeof record.height === 'number' &&
    Number.isFinite(record.height)
  ) {
    return { type: 'rose:resize', height: record.height };
  }
  return null;
}

export function clampInlineHeight(height: number): number {
  return Math.min(INLINE_VIEW_MAX_HEIGHT, Math.max(INLINE_VIEW_MIN_HEIGHT, Math.round(height)));
}
