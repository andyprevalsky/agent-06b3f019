import { ADMIN_USER_IDS } from './adminAccounts';

/** Accounts allowed to see + use the Fast Mode aggressive cache toggle. */
export const FAST_MODE_USER_IDS: readonly string[] = ADMIN_USER_IDS;

/** Accounts where new root agents default to Fast Mode on (all toggle-capable accounts). */
export const DEFAULT_FAST_MODE_USER_IDS: readonly string[] = FAST_MODE_USER_IDS;
