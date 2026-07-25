import { ADMIN_USER_IDS } from './adminAccounts';

/** Accounts allowed to see + use the Fast Mode aggressive cache toggle. */
export const FAST_MODE_USER_IDS: readonly string[] = ADMIN_USER_IDS;

/** Accounts where new root agents default to Fast Mode on. */
export const DEFAULT_FAST_MODE_USER_IDS: readonly string[] = [
  '1f85ff25-6e29-4c1b-8739-f917bd101a30', // Andy Prevalsky
];
