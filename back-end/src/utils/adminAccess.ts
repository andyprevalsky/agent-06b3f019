/** Canonical allowlist for product-wide administrator capabilities. */
export const ADMIN_USER_IDS = new Set([
  '1f85ff25-6e29-4c1b-8739-f917bd101a30', // Andy Prevalsky
  '43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9', // Tamara Chayo
]);

export function isAdminUser(userId: string | undefined): boolean {
  return userId !== undefined && ADMIN_USER_IDS.has(userId);
}
