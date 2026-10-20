/**
 * integration-progress — config layer
 *
 * Constants for the per-account progress write boundary.
 * Layer rule: config imports from own types only.
 */

/** Log prefix shared by the domain's layers. */
export const INTEGRATION_PROGRESS_LOG_PREFIX = '[IntegrationProgress]';

/** Wire spelling of the legacy/default account (storage `accountId = ''`). */
export const DEFAULT_ACCOUNT_ID = 'default';

/** Unit reported for cookie-count progress. */
export const COOKIE_PROGRESS_UNIT = 'cookies';

/**
 * Build the progress endpoint path for one account. `accountId` is URL-encoded
 * so a profile name with a space (`Profile 1`) stays one path segment.
 */
export function progressEndpointPath(provider: string, accountId: string): string {
  return `/api/integrations/${encodeURIComponent(provider)}/accounts/${encodeURIComponent(
    accountId
  )}/progress`;
}
