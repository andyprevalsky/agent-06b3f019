/**
 * Integration health for the Rose Desktop Integrations icon (UI ledger row 68).
 *
 * Reads the same status data the Integrations page renders:
 *   GET /api/integrations             -> { integrations: rows with `status` and per-account `emailCredentials` }
 *   GET /api/integrations/plaid/items -> { items: rows with `status` and `institutionName` }
 *
 * Needs reconnection (the red dot): an integration whose status is EXPIRED,
 * whose account (`accounts[]`, lane L-CULL-INTEG) is `needs_reconnect` or
 * `EXPIRED`, or with any email account in `needs_reconnect` (only re-consent
 * fixes those), or a Plaid item in REQUIRES_REAUTH (the page's "sign in again"
 * state). A failed sync (`sync_failed` / SYNC_FAILED) is not a reconnect: the
 * Integrations page shows its error instead, and no dot is drawn for it.
 */

import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

export interface IntegrationHealthRow {
  name: string;
  status: string;
  emailCredentials?: { email: string | null; state: string }[];
  accounts?: { state?: unknown }[] | null;
}

const RECONNECT_STATES = new Set(['needs_reconnect', 'expired']);

function accountNeedsReconnect(row: IntegrationHealthRow): boolean {
  if (!Array.isArray(row.accounts)) return false;
  return row.accounts.some(
    (account) =>
      typeof account?.state === 'string' && RECONNECT_STATES.has(account.state.toLowerCase()),
  );
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
        accountNeedsReconnect(row) ||
        (row.emailCredentials ?? []).some((c) => c.state === 'needs_reconnect'),
    )
    .map((row) => row.name);
  const plaid = health.plaidItems
    .filter((item) => item.status === 'REQUIRES_REAUTH')
    .map((item) => `Plaid (${item.institutionName ?? 'bank'})`);
  return [...integrations, ...plaid];
}
