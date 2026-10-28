/**
 * Rose Desktop chrome and apps default on for every signed-in account.
 * Signed-out and anonymous visitors keep the public website. Shared/benchmark
 * views without a RoseDesktopContext provider retain their stock layout.
 */
export const ROSE_DESKTOP_ENABLED_BY_DEFAULT = true;

/** Original pilot accounts, retained for a targeted rollout if the default is off. */
export const ROSE_DESKTOP_USER_IDS: readonly string[] = [
  '1f85ff25-6e29-4c1b-8739-f917bd101a30', // Andy
];

export function isRoseDesktopUser(
  user: { id?: string; is_anonymous?: boolean } | null | undefined,
): boolean {
  const id = user?.id;
  return (
    typeof id === 'string' &&
    id !== '' &&
    user?.is_anonymous !== true &&
    (ROSE_DESKTOP_ENABLED_BY_DEFAULT || ROSE_DESKTOP_USER_IDS.includes(id))
  );
}
