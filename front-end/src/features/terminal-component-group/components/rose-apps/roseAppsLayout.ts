/**
 * Layout constants + pure helpers for the Rose Desktop app icons and panels
 * (UI ledger rows 22/58/66). There is no right bar: the app icons sit bare in
 * the window's top-right corner and panels open flush against the right edge,
 * below that icon row. Kept pure so width clamping is unit-testable.
 */

/** Rose left bar resting width (the only bar). */
export const LEFT_BAR_WIDTH = 64;
/** Panels start below the top-right icon row. */
export const APP_PANEL_TOP = 56;
/** Only the panel's top-left corner is rounded; every other edge is flush. */
export const APP_PANEL_RADIUS = 12;
/** The phone floats this far from the window's right edge. */
export const PHONE_EDGE_GAP = 24;
/** Icon hit target in the top-right row. */
export const APP_ICON_SIZE = 34;
export const APP_ICON_GAP = 4;
export const APP_ICON_EDGE = 16;
/** Narrowest a panel may be dragged. */
export const DRAWER_MIN_WIDTH = 420;
/** Default panel width (mock `.rp`). */
export const DRAWER_DEFAULT_WIDTH = 560;
/** Width always left for the chat column beside a panel. */
export const CHAT_MIN_WIDTH = 320;

export const DRAWER_EASE = 'cubic-bezier(.22,1,.36,1)';
export const DRAWER_DURATION_MS = 520;

/** Width of the top-right icon row incl. its edge margin (other top-right UI sits left of it). */
export function appIconsInset(count: number): number {
  return count * APP_ICON_SIZE + Math.max(0, count - 1) * APP_ICON_GAP + APP_ICON_EDGE;
}

/** Default panel width: 560px, never wider than the space right of the left bar. */
export function defaultDrawerWidth(viewportWidth: number): number {
  return Math.min(DRAWER_DEFAULT_WIDTH, viewportWidth - LEFT_BAR_WIDTH);
}

/** Clamp a requested panel width to [min, viewport - left bar - chat room]. */
export function clampDrawerWidth(width: number, viewportWidth: number): number {
  const max = Math.max(DRAWER_MIN_WIDTH, viewportWidth - LEFT_BAR_WIDTH - CHAT_MIN_WIDTH);
  return Math.round(Math.min(max, Math.max(DRAWER_MIN_WIDTH, width)));
}

/** Panel width for a drag handle at clientX (the panel's left edge follows the pointer). */
export function drawerWidthFromPointer(clientX: number, viewportWidth: number): number {
  return clampDrawerWidth(viewportWidth - clientX, viewportWidth);
}
