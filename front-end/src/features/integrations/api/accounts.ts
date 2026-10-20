/**
 * Per-account integrations endpoints (lane L-INTEG-CORE, I0):
 *
 *   GET    /api/integrations                     → rows + accountsByProvider
 *   GET    /api/integrations/progress?since=<c>  → {cursor, changed, accountsByProvider?}
 *   DELETE /api/integrations/:provider/accounts/:accountId
 *            → 200 | 404 (already gone) | 501 ACCOUNT_CLEANUP_NOT_IMPLEMENTED {reason}
 *
 * Wire shapes live in ../types (AccountsByProvider, IntegrationsProgressDelta).
 */

import { API_BASE_WITH_PATH } from '../config';
import { getAuthHeaders } from '../api';
import type { AccountsByProvider, ConnectedIntegration, IntegrationsProgressDelta } from '../types';

export interface IntegrationsList {
  integrations: ConnectedIntegration[];
  /** Per-provider accounts, including providers that have only reported progress. */
  accountsByProvider: AccountsByProvider | null;
}

/** GET /api/integrations with its `accountsByProvider`. */
export async function fetchIntegrationsListApi(): Promise<IntegrationsList> {
  const headers = getAuthHeaders();
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations`, { headers });
  if (!response.ok) return { integrations: [], accountsByProvider: null };
  const data: { integrations?: ConnectedIntegration[]; accountsByProvider?: unknown } =
    await response.json();
  const byProvider = data.accountsByProvider;
  return {
    integrations: data.integrations ?? [],
    accountsByProvider:
      byProvider !== null && typeof byProvider === 'object' && !Array.isArray(byProvider)
        ? (byProvider as AccountsByProvider)
        : null,
  };
}

/**
 * The cheap sync-progress poll: `changed: false` unless something of this user
 * changed after `since`. Pass the returned cursor back on the next call. It
 * does not see deletes from another device (refetch the full list for those).
 */
export async function fetchIntegrationsProgressApi(
  since: string | null,
): Promise<IntegrationsProgressDelta | null> {
  const query = since === null ? '' : `?since=${encodeURIComponent(since)}`;
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/progress${query}`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as Partial<IntegrationsProgressDelta>;
  if (typeof data.cursor !== 'string') return null;
  return {
    cursor: data.cursor,
    changed: data.changed === true,
    accountsByProvider: data.changed === true ? data.accountsByProvider : undefined,
  };
}

/**
 * DELETE answered 501 ACCOUNT_CLEANUP_NOT_IMPLEMENTED: that provider's lane has
 * not filled its cleanup hook yet. The account stays; `reason` is user-facing.
 */
export class AccountCleanupNotImplementedError extends Error {
  constructor(
    readonly provider: string,
    readonly reason: string,
  ) {
    super(reason);
  }
}

/**
 * Remove a connected account (Rose Desktop chip ×).
 *
 * With `accountId`: ONE account of a multi-account provider (the id is
 * URL-encoded — Gmail ids are emails). Without: the whole one-row integration
 * (DELETE /api/integrations/:name), used when the backend reports no
 * per-account list. A 404 means already removed; 501 throws
 * AccountCleanupNotImplementedError.
 */
export async function deleteIntegrationAccountApi(name: string, accountId?: string): Promise<void> {
  const account = accountId === undefined ? '' : `/accounts/${encodeURIComponent(accountId)}`;
  const url = `${API_BASE_WITH_PATH}/integrations/${encodeURIComponent(name)}${account}`;
  const response = await fetch(url, { method: 'DELETE', headers: getAuthHeaders() });
  if (response.ok || response.status === 404) return;
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
    provider?: string;
    reason?: string;
  } | null;
  if (response.status === 501) {
    throw new AccountCleanupNotImplementedError(
      payload?.provider ?? name,
      payload?.reason ?? 'Removing this account is not supported yet.',
    );
  }
  throw new Error(payload?.error ?? `Failed to remove account (HTTP ${response.status})`);
}
