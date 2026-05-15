import { getStoredSession } from '@/lib/supabase';

import { API_BASE_WITH_PATH } from './config';
import type { PlaidItem, PlaidLinkSuccessMetadata, PlaidLinkTokenResponse } from './types';

function authHeaders(): Record<string, string> {
  const session = getStoredSession();
  const token = session?.access_token;
  if (!token) {
    throw new Error('Not authenticated');
  }
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function jsonOrThrow<T>(response: Response, label: string): Promise<T> {
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      payload !== null && typeof payload === 'object' && 'error' in payload && typeof (payload as { error: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : `${label} failed (HTTP ${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

export async function createPlaidLinkTokenApi(): Promise<PlaidLinkTokenResponse> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/plaid/link-token`, {
    method: 'POST',
    headers: authHeaders(),
  });
  return jsonOrThrow<PlaidLinkTokenResponse>(response, 'Create Plaid link token');
}

export async function exchangePlaidPublicTokenApi(input: {
  publicToken: string;
  metadata?: PlaidLinkSuccessMetadata;
}): Promise<{ item: PlaidItem }> {
  const body: Record<string, unknown> = { public_token: input.publicToken };
  if (input.metadata?.institution) {
    body.institution_id = input.metadata.institution.institution_id;
    body.institution_name = input.metadata.institution.name;
  }
  const response = await fetch(
    `${API_BASE_WITH_PATH}/integrations/plaid/exchange-public-token`,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    },
  );
  return jsonOrThrow<{ item: PlaidItem }>(response, 'Exchange Plaid public token');
}

export async function listPlaidItemsApi(): Promise<PlaidItem[]> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/plaid/items`, {
    headers: authHeaders(),
  });
  if (!response.ok) return [];
  const data = (await response.json().catch(() => null)) as { items?: PlaidItem[] } | null;
  return data?.items ?? [];
}

export async function disconnectPlaidItemApi(itemId: string): Promise<{ ok: true }> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/plaid/items/${itemId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  return jsonOrThrow<{ ok: true }>(response, 'Disconnect Plaid item');
}
