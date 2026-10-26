/**
 * Integrations list, sync-progress poll and disconnect (Rose Desktop list,
 * single-account contract, lane L-CULL-INTEG):
 *
 *   GET    /api/integrations                     → rows (accounts = [one entry]) + accountsByProvider
 *   GET    /api/integrations/progress?since=<c>  → {cursor, changed?, accountsByProvider?}
 *   DELETE /api/integrations/:name               → 200 | 404 (already gone)
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

function byProviderOrNull(value: unknown): AccountsByProvider | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as AccountsByProvider)
    : null;
}

/** GET /api/integrations with its `accountsByProvider`. */
export async function fetchIntegrationsListApi(): Promise<IntegrationsList> {
  const headers = getAuthHeaders();
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations`, { headers });
  if (!response.ok) return { integrations: [], accountsByProvider: null };
  const data: { integrations?: ConnectedIntegration[]; accountsByProvider?: unknown } =
    await response.json();
  return {
    integrations: data.integrations ?? [],
    accountsByProvider: byProviderOrNull(data.accountsByProvider),
  };
}

/**
 * The cheap sync-progress poll: nothing changed unless something of this user
 * changed after `since`. Pass the returned cursor back on the next call. A
 * response without `changed` counts as changed when it carries
 * `accountsByProvider`. It does not see deletes from another device (refetch
 * the full list for those).
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
  const accountsByProvider = byProviderOrNull(data.accountsByProvider);
  const changed = data.changed ?? accountsByProvider !== null;
  return {
    cursor: data.cursor,
    changed: changed && accountsByProvider !== null,
    accountsByProvider: changed && accountsByProvider !== null ? accountsByProvider : undefined,
  };
}

/** Disconnect one integration row (Rose Desktop chip ×). A 404 means already removed. */
export async function deleteIntegrationApi(name: string): Promise<void> {
  const url = `${API_BASE_WITH_PATH}/integrations/${encodeURIComponent(name)}`;
  const response = await fetch(url, { method: 'DELETE', headers: getAuthHeaders() });
  if (response.ok || response.status === 404) return;
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new Error(payload?.error ?? `Failed to disconnect (HTTP ${response.status})`);
}
