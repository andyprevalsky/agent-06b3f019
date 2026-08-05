/**
 * messaging-whatsapp: pure connection-close policy
 *
 * Baileys emits `restartRequired` (515) immediately after a *successful* QR
 * pairing. It is a handshake signal, not a failure: the credentials that were
 * just persisted are valid, and the socket only has to be torn down and
 * re-dialled with them. Clearing credentials on 515 destroys the pairing that
 * just succeeded, so the user is bounced back to a fresh QR code and pairing
 * can never complete.
 *
 * Only `loggedOut` (401) means the stored credentials are actually dead.
 *
 * Kept pure (no fs, no electron, no socket) so the policy is unit-testable
 * without standing up a WhatsApp Web connection.
 */
import { WHATSAPP_STATUS_LOGGED_OUT, WHATSAPP_STATUS_RESTART_REQUIRED } from './config';

export interface ConnectionCloseDecision {
  /** Wipe the on-disk Baileys auth state — only when the session is truly dead. */
  clearCredentials: boolean;
  /** Re-dial the socket reusing the existing credentials. */
  reconnect: boolean;
}

/**
 * Decide what to do when the Baileys socket closes.
 *
 * @param statusCode - Baileys `DisconnectReason` code from `lastDisconnect`.
 * @param reconnectAttempts - Reconnects already made for this pairing.
 * @param maxReconnectAttempts - Ceiling on reconnect attempts.
 */
export function decideConnectionClose(
  statusCode: number | undefined,
  reconnectAttempts: number,
  maxReconnectAttempts: number
): ConnectionCloseDecision {
  if (statusCode === WHATSAPP_STATUS_LOGGED_OUT) {
    return { clearCredentials: true, reconnect: false };
  }

  if (statusCode === WHATSAPP_STATUS_RESTART_REQUIRED) {
    return {
      clearCredentials: false,
      reconnect: reconnectAttempts < maxReconnectAttempts,
    };
  }

  return { clearCredentials: false, reconnect: false };
}
