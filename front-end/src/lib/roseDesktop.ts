/**
 * Rose Desktop feature flag: the new chrome and apps (toolbar nub, right app bar
 * and drawers, Browser drawer instead of fullscreen, per-user rose_user_ui,
 * inline user views, new popular goals).
 *
 * On only for the accounts below; every other account, and every signed-out
 * visitor, keeps the stock UI. Account-scoped on purpose: while an admin
 * impersonates someone else, that account's normal UI is shown.
 */

export const ROSE_DESKTOP_USER_IDS: readonly string[] = [
  '1f85ff25-6e29-4c1b-8739-f917bd101a30', // Andy
];

export function isRoseDesktopUser(user: { id?: string } | null | undefined): boolean {
  const id = user?.id;
  return typeof id === 'string' && id !== '' && ROSE_DESKTOP_USER_IDS.includes(id);
}
