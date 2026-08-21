/**
 * Whether the stored session belongs to an admin viewing ANOTHER user's account.
 *
 * Every background sync in this app pushes THIS MACHINE's data — iMessage,
 * WhatsApp, browser cookies and passwords, Claude/Codex credentials — to the
 * backend authenticated as the current session. While an admin is impersonating,
 * that session is the TARGET user, so an unguarded sync writes the operator's
 * personal data into someone else's account. That is silent, cross-account data
 * corruption which no later fix can un-write, so every outbound sync is gated on
 * this check.
 *
 * The signal is the RFC 8693 `act` (actor) claim that the backend stamps onto
 * impersonated sessions. It is server-signed and travels with the token, so the
 * main process needs no IPC from the renderer and cannot drift out of sync with
 * it. Decoding is deliberate — this is an authorization-shaped question the
 * backend already answered, and re-verifying the signature here would add a
 * secret to the desktop app for no gain: a forged token fails at the backend.
 */
export function accessTokenIsImpersonated(accessToken: string | undefined | null): boolean {
  if (accessToken === undefined || accessToken === null || accessToken === '') return false;
  const segments = accessToken.split('.');
  if (segments.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as {
      act?: { sub?: unknown };
    };
    return typeof payload.act?.sub === 'string' && payload.act.sub !== '';
  } catch {
    // An unparseable token is not a proven impersonation; the backend still
    // rejects it, so failing "not impersonated" here changes nothing.
    return false;
  }
}

/** User-facing reason local device data is unavailable during impersonation. */
export const IMPERSONATED_MACHINE_DATA_MESSAGE = 'Unavailable while viewing another account';

/**
 * Keep a session only when it is safe to use for data harvested from this Mac.
 *
 * This generic form lets every owning upload boundary apply one shared policy
 * without replacing its existing AuthService mock/test seam.
 */
export function sessionForLocalMachineData<T extends { access_token?: string | null }>(
  session: T | null | undefined
): T | null {
  if (session === null || session === undefined) return null;
  return accessTokenIsImpersonated(session.access_token) ? null : session;
}
