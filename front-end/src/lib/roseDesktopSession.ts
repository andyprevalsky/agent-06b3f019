/** Session UI availability and signed-in account identity are separate decisions. */
import { isRoseDesktopUser } from './roseDesktop';

/** The existing Rose Desktop UI is available before login and invite checks. */
export function isRoseDesktopSession(session: {
  isAnonymous: boolean;
  authUser: { id?: string; is_anonymous?: boolean } | null;
  /** The invite check answered "needs invite" (pending or failed checks are not). */
  inviteRequired?: boolean;
}): boolean {
  return isRoseDesktopUser(session.authUser);
}

/** Per-account state still belongs only to a real, eligible signed-in user. */
export function roseDesktopAccountId(session: Parameters<typeof isRoseDesktopSession>[0]) {
  const user = session.authUser;
  return !session.isAnonymous &&
    session.inviteRequired !== true &&
    user?.is_anonymous !== true &&
    user?.id &&
    isRoseDesktopSession(session)
    ? user.id
    : null;
}
