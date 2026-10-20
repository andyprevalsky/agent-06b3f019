/**
 * Constants and pure validators for the per-user UI runtime.
 *
 * Everything that decides whether user-authored data may touch the app origin
 * lives here so the security rules are testable without rendering:
 *   - theme tokens are CSS data, never code (name + value allow-lists)
 *   - user files load only from an http(s) usercontent origin that differs
 *     from the app origin (never `srcdoc`, `blob:`, `data:` or same-origin)
 */
import type {
  InlineViewMetadata,
  ResolvedBackground,
  UserUiTheme,
  UserUiViewMessage,
} from './types';

/** The ONLY sandbox flags a user frame ever gets (no allow-same-origin). */
export const USER_UI_IFRAME_SANDBOX = 'allow-scripts';
export const INLINE_VIEW_MIN_HEIGHT = 60;
export const INLINE_VIEW_MAX_HEIGHT = 900;
export const INLINE_VIEW_DEFAULT_HEIGHT = 240;
/** Max simultaneously-live inline iframes in one trajectory. */
export const INLINE_VIEW_LIVE_CAP = 4;
/** How far outside the viewport an inline view may be and still go live. */
export const INLINE_VIEW_ROOT_MARGIN = '400px 0px';
/** Backdrop opacity after the first user message when the theme sets none (ledger row 34). */
export const DEFAULT_BACKGROUND_FADE = 0.8;
export const BACKGROUND_FADE_TRANSITION_MS = 600;
export const LIVE_RELOAD_POLL_MS = 5_000;
/** Any number of live-refresh requests inside this window collapse into one GET. */
export const USER_UI_REFRESH_WINDOW_MS = 750;
export const SAFE_MODE_STORAGE_KEY = 'rose_safe_mode';
export const SAFE_MODE_QUERY_PARAM = 'rose_safe';
export const LIVE_RELOAD_QUERY_PARAM = 'rose_ui_live';
export const USER_UI_IS_DEV = import.meta.env.DEV === true;

const TOKEN_NAME_RE = /^--[a-z0-9-]+$/;
const TOKEN_VALUE_MAX_LENGTH = 256;
/**
 * Anything that could fetch a resource, run script or escape the declaration.
 * Backslash is banned because CSS escapes can spell `url(` indirectly.
 */
const FORBIDDEN_TOKEN_VALUE_PARTS = [
  'url(',
  'src(',
  'image(',
  'image-set(',
  'element(',
  'expression',
  'javascript:',
  '@import',
  ';',
  '{',
  '}',
  '<',
  '\\',
];

export interface TokenValidationResult {
  accepted: Record<string, string>;
  rejected: string[];
}

export function isValidThemeTokenName(name: string): boolean {
  return TOKEN_NAME_RE.test(name);
}

export function isValidThemeTokenValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > TOKEN_VALUE_MAX_LENGTH) return false;
  const lower = value.toLowerCase();
  return !FORBIDDEN_TOKEN_VALUE_PARTS.some((part) => lower.includes(part));
}

/** Split theme tokens into the safe CSS custom properties and rejected names. */
export function validateThemeTokens(tokens: unknown): TokenValidationResult {
  const accepted: Record<string, string> = {};
  const rejected: string[] = [];
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    return { accepted, rejected };
  }
  for (const [name, value] of Object.entries(tokens as Record<string, unknown>)) {
    if (isValidThemeTokenName(name) && isValidThemeTokenValue(value)) {
      accepted[name] = value;
    } else {
      rejected.push(name);
    }
  }
  return { accepted, rejected };
}

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

/**
 * The backdrop behind the app: a theme image and/or a `background` slot.
 * Null when neither exists, so the stock opaque app background stays.
 */
export function resolveBackground(
  theme: UserUiTheme | null,
  baseUrl: string,
  hasBackgroundSlot = false,
): ResolvedBackground | null {
  const image = theme?.background?.image;
  const imageUrl =
    typeof image === 'string' && image.length > 0 ? joinUserContentUrl(baseUrl, image) : null;
  if (!imageUrl && !hasBackgroundSlot) return null;
  const rawFade = theme?.background?.fadeAfterFirstMessage;
  const fadeOpacity =
    typeof rawFade === 'number' && Number.isFinite(rawFade)
      ? Math.min(1, Math.max(0, rawFade))
      : DEFAULT_BACKGROUND_FADE;
  return { imageUrl, fadeOpacity };
}

/** App backdrop opacity: opaque until the agent has a USER message. */
export function backdropOpacity(fade: number | null, hasUserMessage: boolean): number {
  return fade !== null && hasUserMessage ? fade : 1;
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
