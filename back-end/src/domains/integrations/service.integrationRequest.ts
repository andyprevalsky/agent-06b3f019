/**
 * "An integration not listed here?" requests from the Integrations page.
 *
 *   POST {request, request_id} ──► claim row (Integration name 'integration-request',
 *        accountId = request_id, smsState sending) under the user's row lock
 *          ├─ already sending/sent for this request_id ──► return it (no second SMS)
 *          └─ claimed ──► SMS the admin "<user> wants a new integration <X>"
 *                         ──► smsState sent | failed (a retry may reclaim failed)
 *
 * At most DAILY_LIMIT requests per user per 24 h (409 beyond that).
 */
import { createLogger } from '../../providers/logger';
import { IPHONE_ADMIN_PHONE } from '../../providers/phoneAccountPolicy';
import { sendSms } from '../../providers/smsQueue';
import { claimIntegrationRequest, finishIntegrationRequest } from './repo.integrationRequest';
import { IntegrationRequestError } from './types.integrationRequest';

export { IntegrationRequestError };

const log = createLogger('IntegrationRequests');

export type IntegrationRequestSmsSender = typeof sendSms;

export async function requestIntegration(
  userId: string,
  request: string,
  requestId: string,
  send: IntegrationRequestSmsSender = sendSms
): Promise<{ status: 'sent' }> {
  const { user, row } = await claimIntegrationRequest(userId, request, requestId);
  if (row === null) return { status: 'sent' };
  let sent = false;
  try {
    const who =
      [user.name, user.email, user.phone]
        .filter((v) => v !== null && v.trim() !== '')
        .join(' · ') || userId;
    const result = await send(
      IPHONE_ADMIN_PHONE,
      `${who} wants a new integration: ${request} (account ${userId}).`
    );
    if (!result.success)
      throw new IntegrationRequestError(503, 'Could not send your request. Try again.');
    sent = true;
    log.info('[IntegrationRequests] admin notified', { userId, integrationId: row.id });
  } finally {
    // The row survives a failed delivery; a retry with the same request_id reclaims it.
    await finishIntegrationRequest(row.id, request, sent);
  }
  return { status: 'sent' };
}
