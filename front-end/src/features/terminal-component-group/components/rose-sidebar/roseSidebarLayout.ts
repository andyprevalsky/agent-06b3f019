/**
 * Layout constants shared by the Rose Desktop left and right bars (UI ledger
 * rows 21/22): both rest at 64px and expand to full titles on hover.
 */

/** Resting width of either bar (matches the stock collapsed rail). */
export const ROSE_BAR_WIDTH = 64;
/** Width while a bar is hover-expanded (full titles). */
export const ROSE_BAR_EXPANDED_WIDTH = 236;
/** Shared easing for bar width and the panels that slide with it. */
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
