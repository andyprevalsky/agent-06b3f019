/**
 * Layout constants + pure helpers for the right app bar and its drawers.
 * Kept pure so resize clamping is unit-testable without a DOM.
 */

/** Right app bar width; mirrors the collapsed left sidebar rail. */
export const APP_BAR_WIDTH = 64;
/** Gap between the drawer and the app bar / viewport edges. */
export const DRAWER_GAP = 12;
/** Narrowest the drawer may be dragged. */
export const DRAWER_MIN_WIDTH = 420;
/** Width always left for the chat column beside the drawer. */
export const CHAT_MIN_WIDTH = 320;

export const DRAWER_EASE = 'cubic-bezier(.22,1,.36,1)';
export const DRAWER_DURATION_MS = 520;

/** Default drawer width: half the viewport. */
export function defaultDrawerWidth(viewportWidth: number): number {
  return Math.round(viewportWidth * 0.5);
}

/** Clamp a requested drawer width to [min, viewport - app bar - chat room]. */
export function clampDrawerWidth(width: number, viewportWidth: number): number {
  const max = Math.max(
    DRAWER_MIN_WIDTH,
    viewportWidth - APP_BAR_WIDTH - DRAWER_GAP * 2 - CHAT_MIN_WIDTH,
  );
  return Math.round(Math.min(max, Math.max(DRAWER_MIN_WIDTH, width)));
}

/** Drawer width for a drag handle at clientX (drawer's left edge follows the pointer). */
export function drawerWidthFromPointer(clientX: number, viewportWidth: number): number {
  return clampDrawerWidth(viewportWidth - APP_BAR_WIDTH - DRAWER_GAP - clientX, viewportWidth);
}
