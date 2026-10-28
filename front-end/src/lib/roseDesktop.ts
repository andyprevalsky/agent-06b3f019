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

/**
 * Rose Desktop for the session's account, keyed to the authenticated user and
 * never to the async invite check (isFullySignedIn). The transcript loads and
 * subscribes as soon as the session is authenticated, so gating on the check
 * rendered the stock UI (standalone Thought cards) until it resolved, then
 * swapped in the compressed working row: the "old thought cards" flash.
 */
export function isRoseDesktopSession(session: {
  isAnonymous: boolean;
  authUser: { id?: string; is_anonymous?: boolean } | null;
  /** The invite check answered "needs invite" (pending or failed checks are not). */
  inviteRequired?: boolean;
}): boolean {
  return (
    !session.isAnonymous && session.inviteRequired !== true && isRoseDesktopUser(session.authUser)
  );
}

/** The account whose per-user state (theme, apps, UI) Rose Desktop shows. */
export function roseDesktopAccountId(session: Parameters<typeof isRoseDesktopSession>[0]) {
  return isRoseDesktopSession(session) ? (session.authUser?.id ?? null) : null;
}
