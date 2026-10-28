/**
 * Shared bottom-left chip portal styling used by UpdateIndicator and
 * ConnectivityIndicator so multiple chips stack without overlapping.
 */

export const PORTAL_ID = 'rose-bottom-left-chips';

export const CHIP_SLOT =
  'fixed bottom-6 left-6 z-[9999] flex flex-col gap-2 items-start pointer-events-none';

/**
 * Chip fill. UpdateIndicator wraps it in the liquid-metal ring (which replaces
 * a border); html.dark (set by the main window's RoseThemeProvider) swaps to
 * the dark query-box palette.
 */
export const CHIP_BASE =
  'relative flex items-center rounded-full bg-neutral-100 px-3 py-1.5 dark:bg-[#262624] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]';

export const CHIP_LABEL = 'text-xs font-medium text-neutral-600 dark:text-[#e4e4df]';
