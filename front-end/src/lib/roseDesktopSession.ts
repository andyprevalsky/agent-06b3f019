/**
 * Session-level Rose Desktop decision. A separate module so it calls
 * isRoseDesktopUser through its import binding (tests override that flag).
 */
import { isRoseDesktopUser } from './roseDesktop';

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
