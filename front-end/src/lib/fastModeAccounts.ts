import { ADMIN_USER_IDS, isAdminOperator } from './adminAccounts';

/** Accounts allowed to see + use the Fast Mode aggressive cache toggle. */
export const FAST_MODE_USER_IDS: readonly string[] = ADMIN_USER_IDS;

/** Accounts where new root agents default to Fast Mode on (all toggle-capable accounts). */
export const DEFAULT_FAST_MODE_USER_IDS: readonly string[] = FAST_MODE_USER_IDS;

export type FastModeOperator = { id?: string; phone?: string } | null;

/**
 * Fast Mode follows the same operator check as Health / Benchmarks / Report Bug:
 * current + legacy admin ids, verified admin phones, and a live impersonation session.
 * Identity-only allow-lists hide the control when the session id is a third Andy/Tamy
 * row or the auth user is phone-only.
 */
export function canUseFastMode(user: FastModeOperator): boolean {
  return isAdminOperator(user);
}

/** New-root default is on for every operator who can see the toggle. */
export function defaultsFastModeOn(user: FastModeOperator): boolean {
  return canUseFastMode(user);
}
