/**
 * Integration health for the Rose Desktop Integrations icon (UI ledger row 68).
 *
 *   GET /api/integrations -> { integrations: rows with `status` and per-account `emailCredentials` }
 *
 * An integration needs reconnection when its status is EXPIRED or any of its
 * email accounts is `needs_reconnect` (only re-consent fixes those).
 */

import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

export interface IntegrationHealthRow {
  name: string;
  status: string;
  emailCredentials?: { email: string | null; state: string }[];
}

export async function fetchIntegrationHealth(): Promise<IntegrationHealthRow[]> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error(`Failed to load integrations (${response.status})`);
  const data = (await response.json()) as { integrations?: IntegrationHealthRow[] };
  return data.integrations ?? [];
}

/** Names of integrations that need the user to reconnect them. */
export function integrationsNeedingReconnect(rows: IntegrationHealthRow[]): string[] {
  return rows
    .filter(
      (row) =>
        row.status === 'EXPIRED' ||
        (row.emailCredentials ?? []).some((c) => c.state === 'needs_reconnect'),
    )
    .map((row) => row.name);
}
