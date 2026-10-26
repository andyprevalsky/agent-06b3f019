/** Rose Desktop UI and agent surfaces default on for all authenticated account ids.
 * Mirrored by the frontend and agents; developer publishing has its own gate.
 */
export const ROSE_DESKTOP_ENABLED_BY_DEFAULT = true;

/** Original pilot accounts, retained if the global rollout is turned off. */
export const ROSE_DESKTOP_USER_IDS: readonly string[] = [
  '1f85ff25-6e29-4c1b-8739-f917bd101a30', // Andy
];

export function isRoseDesktopUser(userId: string | null | undefined): boolean {
  return (
    typeof userId === 'string' &&
    userId !== '' &&
    (ROSE_DESKTOP_ENABLED_BY_DEFAULT || ROSE_DESKTOP_USER_IDS.includes(userId))
  );
}
