/**
 * integration-progress — config layer
 *
 * Constants for the sync-progress write boundary.
 * Layer rule: config imports from own types only.
 */

/** Log prefix shared by the domain's layers. */
export const INTEGRATION_PROGRESS_LOG_PREFIX = '[IntegrationProgress]';

/**
 * Wire spelling of an Integration row's legacy `''` account id. Every Mac
 * pipeline (iMessage, WhatsApp, Telegram) syncs that one row.
 */
export const DEFAULT_ACCOUNT_ID = 'default';

/** The progress endpoint of one Integration row (`accountId` URL-encoded). */
export function progressEndpointPath(provider: string, accountId: string): string {
  return `/api/integrations/${encodeURIComponent(provider)}/accounts/${encodeURIComponent(
    accountId
  )}/progress`;
}
