import { getStoredSession } from '@/lib/supabase';

import { API_BASE_URL, API_BASE_WITH_PATH } from './config';
import type {
  ConnectedIntegration,
  PlaidItem,
  PlaidLinkSuccessMetadata,
  PlaidLinkTokenResponse,
} from './types';

export function getAuthHeaders(): Record<string, string> {
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

function getAuthToken(): string {
  const session = getStoredSession();
  const token = session?.access_token;
  if (!token) {
    throw new Error('Not authenticated');
  }
  return token;
}

export async function fetchIntegrationsApi(): Promise<ConnectedIntegration[]> {
  const headers = getAuthHeaders();
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations`, { headers });
  if (!response.ok) return [];
  const data: { integrations?: ConnectedIntegration[] } = await response.json();
  return data.integrations ?? [];
}

export async function uploadFileApi(
  type: 'vcf' | 'email-zip',
  file: File,
): Promise<{ created?: number; updated?: number; skipped?: number; message?: string }> {
  const token = getAuthToken();
  const formData = new FormData();
  formData.append('file', file);

  const endpoint =
    type === 'vcf'
      ? `${API_BASE_WITH_PATH}/integrations/contacts/upload`
      : `${API_BASE_WITH_PATH}/integrations/email/upload`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || 'Failed to upload file');
  }
  return payload;
}

export async function startGmailOAuthApi(returnUrl?: string): Promise<{ authUrl: string }> {
  const headers = getAuthHeaders();
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/email/gmail/start`, {
    method: 'POST',
    headers,
    body: returnUrl ? JSON.stringify({ returnUrl }) : undefined,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.authUrl) {
    throw new Error(payload?.error || 'Failed to start email connection');
  }
  return payload;
}

export async function disconnectGmailAccountApi(email: string): Promise<void> {
  const headers = getAuthHeaders();
  const response = await fetch(
    `${API_BASE_WITH_PATH}/integrations/email/gmail/accounts/${encodeURIComponent(email)}`,
    {
      method: 'DELETE',
      headers,
    },
  );

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || 'Failed to disconnect Gmail account');
  }
}

export async function sendPasswordRequestApi(request: string): Promise<void> {
  const headers = getAuthHeaders();
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/passwords/request`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ request }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || 'Failed to send request');
  }
}

export async function uploadApplePasswordsApi(file: File): Promise<{ passwordCount: number }> {
  const token = getAuthToken();
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/passwords/apple/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || 'Failed to import passwords');
  }
  return payload;
}

export async function createLinkedInSyncAgentApi(): Promise<void> {
  const session = getStoredSession();
  const backendUrl = API_BASE_URL;
  const goal = `Download my LinkedIn data export and upload it to the platform.

Steps:
1. Use a browser agent to navigate to https://www.linkedin.com/mypreferences/d/download-my-data and request a full data export. Click "Request archive" to initiate.

2. LinkedIn takes time to prepare the export (can be minutes to hours). Wait 10 minutes between checks. Use a browser agent to check my email inbox for an email from LinkedIn with subject containing "Your LinkedIn data archive is ready". Repeat checking every 10 minutes for up to 8 hours.

3. When the email arrives, use a browser agent to:
   - Open the email
   - Click the download link
   - Download the ZIP file from the LinkedIn download page

4. After downloading the ZIP file, use a claude code agent to upload it to the backend:
   curl -X POST ${backendUrl}/api/integrations/linkedin/upload -H "Authorization: Bearer ${session?.access_token}" -F "file=@/path/to/downloaded-linkedin-export.zip"`;

  const response = await fetch(`${backendUrl}/api/agents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session?.access_token}`,
    },
    body: JSON.stringify({
      goal,
      depth: 1,
      source: 'MAC_APP',
      price_limit_cents: 500,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create agent');
  }
}

// ─── Plaid (consolidated from former features/plaid) ────────────────────────

async function plaidJsonOrThrow<T>(response: Response, label: string): Promise<T> {
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      payload !== null &&
      typeof payload === 'object' &&
      'error' in payload &&
      typeof (payload as { error: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : `${label} failed (HTTP ${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

export async function createPlaidLinkTokenApi(input?: {
  mode?: 'create' | 'update';
  itemId?: string;
}): Promise<PlaidLinkTokenResponse> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/plaid/link-token`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  return plaidJsonOrThrow<PlaidLinkTokenResponse>(response, 'Create Plaid link token');
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
  if (input.metadata) {
    body.metadata = input.metadata;
  }
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/plaid/exchange-public-token`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
  });
  return plaidJsonOrThrow<{ item: PlaidItem }>(response, 'Exchange Plaid public token');
}

export async function listPlaidItemsApi(): Promise<PlaidItem[]> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/plaid/items`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) return [];
  const data = (await response.json().catch(() => null)) as { items?: PlaidItem[] } | null;
  return data?.items ?? [];
}

export async function disconnectPlaidItemApi(itemId: string): Promise<{ ok: true }> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/plaid/items/${itemId}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  return plaidJsonOrThrow<{ ok: true }>(response, 'Disconnect Plaid item');
}

export async function completePlaidUpdateModeApi(itemId: string): Promise<{ item: PlaidItem }> {
  const response = await fetch(
    `${API_BASE_WITH_PATH}/integrations/plaid/items/${itemId}/update-complete`,
    {
      method: 'POST',
      headers: getAuthHeaders(),
    },
  );
  return plaidJsonOrThrow<{ item: PlaidItem }>(response, 'Complete Plaid update mode');
}
