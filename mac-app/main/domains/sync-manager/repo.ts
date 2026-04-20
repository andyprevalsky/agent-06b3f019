/**
 * sync-manager — repo layer
 *
 * Sole data-access layer for the sync coordination domain. Wraps the one
 * external data source: GET {apiUrl}/api/integrations.
 *
 * Layer rule: repo imports its own types/config and provider clients only
 * (here: the shared config provider from main/base).
 */

import { config } from '../../base/config';
import type { Integration } from './types';

/**
 * Result of a backend integration fetch. The service layer uses `ok` to decide
 * whether to fall back to a stale cache and `statusText` for diagnostics.
 */
export interface FetchIntegrationsResult {
  /** True when the HTTP request returned 2xx. */
  ok: boolean;
  /** Integration records returned by the backend (empty when !ok). */
  integrations: Integration[];
  /** HTTP status text when !ok, for logging by the service layer. */
  statusText?: string;
}

/**
 * Fetch integrations from the backend API. Pure data access — no caching,
 * no logging, no business decisions.
 */
export async function fetchIntegrations(accessToken: string): Promise<FetchIntegrationsResult> {
  const response = await fetch(`${config.apiUrl}/api/integrations`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    return { ok: false, integrations: [], statusText: response.statusText };
  }

  const data = (await response.json()) as { integrations?: Integration[] };
  return { ok: true, integrations: data.integrations ?? [] };
}
