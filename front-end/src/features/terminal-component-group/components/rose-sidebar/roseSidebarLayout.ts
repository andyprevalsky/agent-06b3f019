/**
 * Layout constants for the Rose Desktop left bar (UI ledger rows 21/22/66):
 * it rests at 64px and hover-expands to full titles. Dragging its right edge
 * sets the expanded width and pins it open. There is no right bar.
 */

/** Resting width of the bar (matches the stock collapsed rail). */
export const ROSE_BAR_WIDTH = 64;
/** Default (and minimum) width while the bar is expanded (full titles). */
export const ROSE_BAR_EXPANDED_WIDTH = 236;
/** Widest a dragged bar may be: this cap, or half the window if that is smaller. */
export const ROSE_BAR_MAX_WIDTH = 560;
/** Releasing a drag left of this collapses (and unpins) the bar. */
export const ROSE_BAR_COLLAPSE_SNAP = 150;
/** localStorage keys: the dragged width and whether the bar is pinned open. */
export const ROSE_BAR_WIDTH_STORAGE_KEY = 'rose-sidebar-width';
export const ROSE_BAR_PINNED_STORAGE_KEY = 'rose-sidebar-pinned';
/**
 * Root CSS var the content beside the bar offsets by: the bar's width while it
 * is pinned or being dragged open, else 64px (a hover-expanded bar overlays).
 */
export const ROSE_BAR_OFFSET_VAR = '--rose-bar-offset';
/** Window event fired after the offset changes, so fixed layers re-measure their anchors. */
export const ROSE_BAR_OFFSET_EVENT = 'rose-bar-offset-change';

/** Clamp a dragged width into [ROSE_BAR_EXPANDED_WIDTH, min(cap, 50% of the window)]. */
export function clampRoseBarWidth(raw: number, viewportWidth: number): number {
  const max = Math.max(ROSE_BAR_EXPANDED_WIDTH, Math.min(ROSE_BAR_MAX_WIDTH, viewportWidth / 2));
  return Math.round(Math.min(max, Math.max(ROSE_BAR_EXPANDED_WIDTH, raw)));
}
/** Easing for the bar width and the panels beside it that slide with it. */
export const ROSE_BAR_EASE = 'cubic-bezier(.2,.8,.2,1)';
export const ROSE_BAR_DURATION_MS = 280;
/** Active item color (no tiles/rings: active is color + weight only). */
export const ROSE_ACTIVE_COLOR = '#e8507f';

/**
 * Rose Desktop surface tokens (UI ledger row 65). Light values are unchanged;
 * `dark:` applies when <html> has class `dark`.
 */
export const ROSE_SURFACE = 'bg-white dark:bg-[#262624]';
export const ROSE_RAISED = 'bg-white dark:bg-[#2f2f2c]';
export const ROSE_TEXT = 'text-[hsl(240_15%_8%)] dark:text-[#ecece8]';
export const ROSE_MUTED = 'text-[hsl(240_8%_45%)] dark:text-[#a3a39d]';
export const ROSE_BORDER = 'border-gray-200/95 dark:border-white/[0.09]';
/** Row hover/focus wash inside menus. */
export const ROSE_MENU_HOVER =
  'focus:bg-[hsl(240_10%_96%)] dark:focus:bg-white/[0.06] focus:text-[hsl(240_15%_8%)] dark:focus:text-[#ecece8]';
