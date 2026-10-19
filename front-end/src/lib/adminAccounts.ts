import { getImpersonatedAccount } from './impersonation';

/** Canonical front-end allowlist for product-wide administrator capabilities. */
export interface AdminAccount {
  userId: string;
  /** Short display name for the account switcher's quick-reset chips. */
  name: string;
}

/** Quick-reset chips in the account switcher — current prod identities only. */
export const ADMIN_ACCOUNTS: readonly AdminAccount[] = [
  { userId: '1f85ff25-6e29-4c1b-8739-f917bd101a30', name: 'Andy' },
  { userId: '8283e892-b0a4-4298-9ef7-b95bcc67e46b', name: 'Tamy' },
];

/** Legacy User ids still authorized as admin (fixtures / older sessions). */
const LEGACY_ADMIN_USER_IDS: readonly string[] = [
  '43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9', // Tamara (legacy)
];

/** All user ids that carry admin capabilities (current + legacy). */
export const ADMIN_USER_IDS: readonly string[] = [
  ...ADMIN_ACCOUNTS.map((account) => account.userId),
  ...LEGACY_ADMIN_USER_IDS,
];

/** Digits-only phone numbers that carry admin capabilities. */
export const ADMIN_PHONE_DIGITS: readonly string[] = ['19729777432', '9729777432'];

/**
 * Whether the PERSON using the app is an administrator.
 *
 * This is deliberately not "is the signed-in account an admin". While an admin
 * is impersonating, the active session belongs to the target account, so an
 * identity-only check hides every admin surface (Health, Benchmarks, debug
 * panels) from an operator who is still an admin — and who reaches those
 * surfaces with the STASHED admin token, which the backend authorizes.
 *
 * Impersonation implies admin by construction: only an admin can start it, and
 * getImpersonatedAccount() returns null unless a live, unexpired admin session
 * is stashed. The backend remains the real gate; this only decides what to show.
 */
export function isAdminOperator(user: { id?: string; phone?: string } | null): boolean {
  if (getImpersonatedAccount() !== null) return true;
  if (!user) return false;
  if (user.id !== undefined && user.id !== '' && ADMIN_USER_IDS.includes(user.id)) return true;
  const phoneDigits = (user.phone ?? '').replace(/\D/g, '');
  return ADMIN_PHONE_DIGITS.includes(phoneDigits);
}
