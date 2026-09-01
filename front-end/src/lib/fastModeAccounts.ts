import { ADMIN_ACCOUNTS } from './adminAccounts';

/** Current-identity allowlist for Fast Mode (not legacy admin ids). */
const CURRENT_ADMIN_USER_IDS: readonly string[] = ADMIN_ACCOUNTS.map((account) => account.userId);

/** Accounts allowed to see + use the Fast Mode aggressive cache toggle. */
export const FAST_MODE_USER_IDS: readonly string[] = CURRENT_ADMIN_USER_IDS;

/** Accounts where new root agents default to Fast Mode on (all toggle-capable accounts). */
export const DEFAULT_FAST_MODE_USER_IDS: readonly string[] = FAST_MODE_USER_IDS;
