import { createAgent } from '@/lib/api';
import { getClientSource } from '@/lib/clientSource';
import { getStoredSession } from '@/lib/supabase';

import { API_BASE_URL, API_BASE_WITH_PATH } from './config';
import type {
  ConnectedIntegration,
  GmailResyncResult,
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

/** Like fetchIntegrationsApi, but a failed request is null, never an empty list. */
export async function fetchIntegrationsOrNullApi(): Promise<ConnectedIntegration[] | null> {
  const headers = getAuthHeaders();
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations`, { headers });
  if (!response.ok) return null;
  const data: { integrations?: ConnectedIntegration[] } = await response.json();
  return data.integrations ?? [];
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

/**
 * Repair one damaged Gmail account.
 *
 * The server decides whether the break is transient (a retry it just performed)
 * or terminal (`needsReauth`, meaning the caller must run the OAuth flow).
 */
export async function resyncGmailAccountApi(email: string): Promise<GmailResyncResult> {
  const headers = getAuthHeaders();
  const response = await fetch(
    `${API_BASE_WITH_PATH}/integrations/email/gmail/accounts/${encodeURIComponent(email)}/resync`,
    {
      method: 'POST',
      headers,
    },
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || 'Failed to reconnect Gmail account');
  }
  return payload as GmailResyncResult;
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

/**
 * Spawn the LinkedIn export directly as a cloud agent (no chat routing: the
 * task is fully specified), then record it as the user's LinkedIn sync so
 * every client shows "Connecting" until that agent ends.
 */
export async function createLinkedInSyncAgentApi(): Promise<string> {
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

  const agent = await createAgent({ goal, source: getClientSource(), start_phase: 'execute' });

  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/linkedin/sync`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ agent_id: agent.agent_id }),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error ?? `Failed to record LinkedIn sync (HTTP ${response.status})`);
  }
  return agent.agent_id;
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

// --- compute accounts (multi-account Claude / Codex) -------------------------
//
// Mirrors the Gmail account model: the user connects N accounts per provider and
// each renders as a removable chip. Only CONNECTIONS are exposed -- the grants
// behind them are minted and replaced automatically, so surfacing them would
// invite users to act on something the system already heals.

export interface ComputeAccount {
  provider: string;
  accountId: string;
  accountEmail: string | null;
  /** "connected" | "needs_reconnect" -- the only user-actionable state. */
  state: string;
  lastErrorReason: string | null;
  connectedAt: string;
}

export interface ConnectSessionHandle {
  connectId: string;
  provider: string;
  /** Live view the user signs into. */
  liveViewUrl: string | null;
  expiresAt: string;
}

export interface ConnectPollResult {
  state: 'pending' | 'connected' | 'expired' | 'unknown';
  /** Sent once the cloud browser has booted; null while still provisioning. */
  liveViewUrl?: string | null;
  /**
   * Fine-grained progress for the connect modal. Only the server knows which
   * step it is on (browser boot, cookie restore, page load, minting), so this
   * comes over the wire rather than being guessed client-side.
   */
  stage?:
    | 'creating_browser'
    | 'restoring_session'
    | 'loading_authorize'
    | 'awaiting_human'
    | 'capturing'
    | 'minting'
    | 'connected';
  accountEmail?: string;
  accountId?: string;
  reason?: string;
}

export async function fetchComputeAccounts(provider?: string): Promise<ComputeAccount[]> {
  const qs = provider === undefined ? '' : `?provider=${encodeURIComponent(provider)}`;
  const res = await fetch(`${API_BASE_URL}/api/compute-accounts${qs}`, {
    headers: getAuthHeaders(),
  });
  if (!res.ok) throw new Error(`Failed to load compute accounts (${res.status})`);
  const body = (await res.json()) as { accounts: ComputeAccount[] };
  return body.accounts;
}

export async function startComputeConnect(provider: string): Promise<ConnectSessionHandle> {
  const res = await fetch(`${API_BASE_URL}/api/compute-accounts/connect`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ provider }),
  });
  if (!res.ok) throw new Error(`Failed to start sign-in (${res.status})`);
  return (await res.json()) as ConnectSessionHandle;
}

export async function pollComputeConnect(connectId: string): Promise<ConnectPollResult> {
  const res = await fetch(
    `${API_BASE_URL}/api/compute-accounts/connect/${encodeURIComponent(connectId)}`,
    { headers: getAuthHeaders() },
  );
  if (!res.ok) throw new Error(`Failed to poll sign-in (${res.status})`);
  return (await res.json()) as ConnectPollResult;
}

/**
 * Abandon a sign-in. Called on cancel AND on unmount: the remote browser bills
 * until released, and users abandon sign-in far more often than they finish it.
 */
export async function cancelComputeConnect(connectId: string): Promise<void> {
  await fetch(`${API_BASE_URL}/api/compute-accounts/connect/${encodeURIComponent(connectId)}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  }).catch(() => undefined);
}

export async function removeComputeAccount(provider: string, accountId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/api/compute-accounts/${encodeURIComponent(provider)}/${encodeURIComponent(accountId)}`,
    { method: 'DELETE', headers: getAuthHeaders() },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to remove account (${res.status})`);
  }
}
