/** Canonical front-end allowlist for product-wide administrator capabilities. */
export interface AdminAccount {
  userId: string;
  /** Short display name for the account switcher's quick-reset chips. */
  name: string;
}

export const ADMIN_ACCOUNTS: readonly AdminAccount[] = [
  { userId: '1f85ff25-6e29-4c1b-8739-f917bd101a30', name: 'Andy' },
  { userId: '43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9', name: 'Tamy' },
];

export const ADMIN_USER_IDS: readonly string[] = ADMIN_ACCOUNTS.map((account) => account.userId);
