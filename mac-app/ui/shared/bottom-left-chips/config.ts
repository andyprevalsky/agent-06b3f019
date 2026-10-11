/**
 * Shared bottom-left chip portal styling used by UpdateIndicator and
 * ConnectivityIndicator so multiple chips stack without overlapping.
 */

export const PORTAL_ID = 'rose-bottom-left-chips';

export const CHIP_SLOT =
  'fixed bottom-6 left-6 z-[9999] flex flex-col gap-2 items-start pointer-events-none';

export const CHIP_BASE =
  'flex items-center rounded-full bg-neutral-100 border border-neutral-200 px-3 py-1.5 shadow-sm';

export const CHIP_LABEL = 'text-xs font-medium text-neutral-600';
