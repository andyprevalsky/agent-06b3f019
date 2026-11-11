/**
 * Layout constants + pure helpers for the Rose Desktop app icons and panels
 * (UI ledger rows 22/58/66/67). There is no right bar: the app icons sit bare
 * in the window's top-right corner and float over full-height drawers that
 * open flush against the right edge. Kept pure so width clamping is testable.
 */

/** Rose left bar resting width (the only bar). */
export const LEFT_BAR_WIDTH = 64;
/** Drawers are full height (row 67): the icon row floats over their top-right corner. */
export const APP_PANEL_TOP = 0;
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

/**
 * Apps whose panel covers the floating query box (ROSE_LAYER.coverPanel, with
 * the icon row at coverIcons above it). Browser and Biz health are also full
 * width: from the left bar to the window's right edge. Every right panel
 * (Integrations, Feedback, Benchmarks, Settings) is here too: nothing insets
 * the chat column, so a right panel overlaps the centered query box and would
 * otherwise sit under it.
 */
const COMPOSER_COVERING_APPS: readonly string[] = [
  'browser',
  'integrations',
  'health',
  'teams',
  'feedback',
  'benchmarks',
  'settings',
];

export function coversComposer(app: string | null | undefined): boolean {
  return app != null && COMPOSER_COVERING_APPS.includes(app);
}

export const DRAWER_EASE = 'cubic-bezier(.22,1,.36,1)';
export const DRAWER_DURATION_MS = 520;

/** Width of the top-right icon row incl. its edge margin (other top-right UI sits left of it). */
export function appIconsInset(count: number): number {
  return count * APP_ICON_SIZE + Math.max(0, count - 1) * APP_ICON_GAP + APP_ICON_EDGE;
}

/**
 * The live left offset: the Rose bar's published --rose-bar-offset (its width
 * while pinned, else 64px), or LEFT_BAR_WIDTH when nothing is published.
 */
export function readLeftBarOffset(): number {
  if (typeof document === 'undefined') return LEFT_BAR_WIDTH;
  const raw = document.documentElement.style.getPropertyValue('--rose-bar-offset');
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : LEFT_BAR_WIDTH;
}

/** Default panel width: 560px, never wider than the space right of the left bar. */
export function defaultDrawerWidth(viewportWidth: number, leftOffset = LEFT_BAR_WIDTH): number {
  return Math.min(DRAWER_DEFAULT_WIDTH, viewportWidth - leftOffset);
}

/** Clamp a requested panel width to [min, viewport - left bar (live offset) - chat room]. */
export function clampDrawerWidth(
  width: number,
  viewportWidth: number,
  leftOffset = LEFT_BAR_WIDTH,
): number {
  const max = Math.max(DRAWER_MIN_WIDTH, viewportWidth - leftOffset - CHAT_MIN_WIDTH);
  return Math.round(Math.min(max, Math.max(DRAWER_MIN_WIDTH, width)));
}

/** Panel width for a drag handle at clientX (the panel's left edge follows the pointer). */
export function drawerWidthFromPointer(
  clientX: number,
  viewportWidth: number,
  leftOffset = LEFT_BAR_WIDTH,
): number {
  return clampDrawerWidth(viewportWidth - clientX, viewportWidth, leftOffset);
}
