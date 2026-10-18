/** Canonical allowlist for product-wide administrator capabilities. */
export const ADMIN_USER_IDS = new Set([
  // Current prod User rows (phone-login identities).
  '1f85ff25-6e29-4c1b-8739-f917bd101a30', // Andy Prevalsky (+19729777432)
  '8283e892-b0a4-4298-9ef7-b95bcc67e46b', // Tamara Chayo
  // Historical ids kept so fixtures / older sessions keep resolving as admin.
  '43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9', // Tamara (legacy)
]);

/**
 * Additional admin userIds sourced from `ADMIN_USER_IDS_EXTRA` (comma-separated). This lets a
 * NON-production stack (e.g. the local benchmark harness) grant admin to a dedicated synthetic
 * user — so admin-bypass benchmarks never run against, or mutate, a real admin's account. It is
 * unset in production, where the two hardcoded IDs above are the only admins. Read per-call so a
 * benchmark can toggle it without a process restart.
 */
function envAdminUserIds(): Set<string> {
  const raw = process.env.ADMIN_USER_IDS_EXTRA;
  if (raw === undefined || raw.trim() === '') return new Set<string>();
  return new Set(
    raw
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  );
}

export function isAdminUser(userId: string | undefined): boolean {
  if (userId === undefined) return false;
  return ADMIN_USER_IDS.has(userId) || envAdminUserIds().has(userId);
}
