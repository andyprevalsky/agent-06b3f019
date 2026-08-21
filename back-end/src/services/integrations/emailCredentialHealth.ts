/**
 * Per-account health for connected email credentials.
 *
 * One `gmail` Integration row fans out to N connected addresses, so health has
 * to be tracked per EmailIntegrationCredential. Rolling it up onto the shared
 * Integration row (the old behaviour) lost the only fact the user needs: WHICH
 * address broke. It also marked healthy accounts as failed, because a single
 * dead refresh token flipped the whole row to SYNC_FAILED.
 */

import { prisma } from '../../providers/database';
import { createLogger } from '../../providers/logger';
import { classifyComputeGrantFailure } from '../../providers/computeGrantFailure';

const log = createLogger('EmailCredentialHealth');

/**
 * - `connected`      — token refreshes cleanly.
 * - `needs_reconnect` — TERMINAL. The grant is gone; only user re-consent fixes
 *                       it. This is what turns the FE chip amber.
 * - `sync_failed`     — transient, or a fault on our side. Retrying can fix it,
 *                       so we must NOT ask the user to reauthorize.
 */
export type EmailCredentialState = 'connected' | 'needs_reconnect' | 'sync_failed';

export interface EmailAuthFailure {
  state: Exclude<EmailCredentialState, 'connected'>;
  reason: string;
}

/**
 * Decide whether a failed Google token refresh is the user's problem or ours.
 *
 * Only an explicit revocation marker (`invalid_grant` and friends, matched by
 * the shared compute-grant classifier) may produce `needs_reconnect`. Every
 * other failure degrades to `sync_failed`.
 *
 * That asymmetry is deliberate and load-bearing. Google returns 400 for BOTH
 * "this user's refresh token is dead" (`invalid_grant` — re-consent is the only
 * fix) and "your OAuth client is misconfigured" (`invalid_client`,
 * `unauthorized_client` — a deploy-time fault affecting EVERY user). Treating
 * a bare 4xx as terminal would light up "Needs Reconnection" on every account
 * in the product the moment a client secret rotated, and send users through an
 * OAuth flow that cannot possibly succeed.
 */
export function classifyEmailAuthFailure(input: {
  status: number;
  body?: string;
}): EmailAuthFailure {
  const { verdict } = classifyComputeGrantFailure(input);

  if (verdict === 'revoked') {
    return {
      state: 'needs_reconnect',
      reason: 'Access was revoked or expired. Reconnect this account to restore it.',
    };
  }

  if (verdict === 'rate_limited') {
    return { state: 'sync_failed', reason: 'Google is rate limiting this account. Will retry.' };
  }

  return {
    state: 'sync_failed',
    reason: `Could not refresh access (HTTP ${input.status}). Will retry.`,
  };
}

/** Record a credential as healthy again. No-op write is fine; this is on the hot sync path. */
export async function markCredentialHealthy(credentialId: string): Promise<void> {
  await prisma.emailIntegrationCredential.update({
    where: { id: credentialId },
    data: { state: 'connected', lastErrorReason: null },
  });
}

export async function markCredentialFailure(
  credentialId: string,
  failure: EmailAuthFailure
): Promise<void> {
  log.info('Marking credential', { credentialId, state: failure.state, reason: failure.reason });
  await prisma.emailIntegrationCredential.update({
    where: { id: credentialId },
    data: {
      state: failure.state,
      lastErrorReason: failure.reason,
      lastFailedSyncAt: new Date(),
    },
  });
}
