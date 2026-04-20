/**
 * Config for the update-indicator feature: constants and DOM ids shared
 * across layers. No env reads required.
 */

export const NONE_DISMISS_DELAY_MS = 3000;

export const PORTAL_ID = 'rose-update-indicator';

// Rose gradient colors for the "downloading" progress bar.
export const ROSE_GRADIENT = 'linear-gradient(to right, #094EFF, #537FFF, #84E4FF, #65CBDF)';

// Base chip styling shared across chip variants.
export const CHIP_BASE =
  'flex items-center rounded-full bg-neutral-100 border border-neutral-200 px-3 py-1.5 shadow-sm';
