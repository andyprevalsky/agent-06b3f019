/**
 * Integration health for the Rose Desktop Integrations icon (UI ledger row 68).
 *
 * Reads the same status data the Integrations page renders:
 *   GET /api/integrations             -> { integrations: rows with `status` and per-account `emailCredentials` }
 *   GET /api/integrations/plaid/items -> { items: rows with `status` and `institutionName` }
 *
 * Needs reconnection: an integration whose status is EXPIRED or with any email
 * account in `needs_reconnect` (only re-consent fixes those), or a Plaid item
 * in REQUIRES_REAUTH (the page's "sign in again" state).
 */

import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

export interface IntegrationHealthRow {
  name: string;
  status: string;
  emailCredentials?: { email: string | null; state: string }[];
}

export interface PlaidItemHealthRow {
  institutionName: string | null;
  status: string;
}

export interface IntegrationHealth {
  integrations: IntegrationHealthRow[];
  plaidItems: PlaidItemHealthRow[];
}

async function fetchJson<T>(path: string): Promise<T | null> {
  const response = await fetch(`${API_BASE_WITH_PATH}${path}`, { headers: getAuthHeaders() });
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as T | null;
}

export async function fetchIntegrationHealth(): Promise<IntegrationHealth> {
  const [integrations, plaid] = await Promise.all([
    fetchJson<{ integrations?: IntegrationHealthRow[] }>('/integrations'),
    fetchJson<{ items?: PlaidItemHealthRow[] }>('/integrations/plaid/items'),
  ]);
  return { integrations: integrations?.integrations ?? [], plaidItems: plaid?.items ?? [] };
}

/** Labels of integrations that need the user to reconnect them, e.g. `gmail`, `Plaid (Chase)`. */
export function integrationsNeedingReconnect(health: IntegrationHealth): string[] {
  const integrations = health.integrations
    .filter(
      (row) =>
        row.status === 'EXPIRED' ||
        (row.emailCredentials ?? []).some((c) => c.state === 'needs_reconnect'),
    )
    .map((row) => row.name);
  const plaid = health.plaidItems
    .filter((item) => item.status === 'REQUIRES_REAUTH')
    .map((item) => `Plaid (${item.institutionName ?? 'bank'})`);
  return [...integrations, ...plaid];
}
