/**
 * "Fix this account" for a connected email address.
 *
 * One user-facing action, because the user does not know (and should not have
 * to know) whether their sync broke because Google was briefly unreachable or
 * because their grant was revoked. The endpoint works out which it is and
 * either repairs it silently or hands back the OAuth URL to re-consent.
 *
 * Only the token refresh runs inline -- it is a single fast call to Google.
 * The full mailbox sync is left to the cron so the request cannot hang on a
 * large mailbox.
 */

import { getValidAccessToken } from '../../services/integrations/gmailSync';
import { createLogger } from '../../providers/logger';
import * as repo from './repo';

const log = createLogger('Integrations');

export class GmailAccountNotFoundError extends Error {
  constructor(email: string) {
    super(`No connected Gmail account for ${email}`);
    this.name = 'GmailAccountNotFoundError';
  }
}

export interface ResyncResult {
  email: string;
  /**
   * Terminal auth failure: retrying cannot fix it, so the client must send the
   * user through the normal OAuth connect flow. We deliberately do NOT mint an
   * authUrl here -- the client already owns that flow (Electron external-browser
   * vs web redirect, plus completion polling), and a second server-minted URL
   * would be a parallel path to keep correct for no benefit.
   */
  needsReauth: boolean;
  state: 'connected' | 'needs_reconnect' | 'sync_failed';
  reason: string | null;
}

export async function resyncGmailAccount(userId: string, email: string): Promise<ResyncResult> {
  const credential = await repo.findGmailCredentialForDisconnect(userId, email);
  if (credential === null || credential === undefined) {
    throw new GmailAccountNotFoundError(email);
  }

  log.info('Resync requested', { email, state: credential.state });

  const accessToken = await getValidAccessToken(credential);

  if (accessToken !== null) {
    // getValidAccessToken already cleared the failure state on success.
    return { email, needsReauth: false, state: 'connected', reason: null };
  }

  // Re-read: getValidAccessToken classified and persisted the failure.
  const refreshed = await repo.findGmailCredentialForDisconnect(userId, email);
  const state = refreshed?.state === 'needs_reconnect' ? 'needs_reconnect' : 'sync_failed';

  return {
    email,
    // Transient failures must NOT push the user into an OAuth flow that would
    // not have helped.
    needsReauth: state === 'needs_reconnect',
    state,
    reason: refreshed?.lastErrorReason ?? null,
  };
}
