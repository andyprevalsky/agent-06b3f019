import { getSession } from '@/lib/supabase';
import { type CustomizationData } from '@/features/customization';
import { getBackendUrl } from './config';
import type { Integration, UserSettingsResponse } from './types';

const authHeader = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

const requireToken = (): string => {
  const session = getSession();
  if (session === null || session === undefined || session.access_token === '') {
    throw new Error('Not authenticated');
  }
  return session.access_token;
};

const maybeToken = (): string | null => {
  const session = getSession();
  if (session === null || session === undefined || session.access_token === '') {
    return null;
  }
  return session.access_token;
};

export const fetchUserSettings = async (): Promise<UserSettingsResponse | null> => {
  const token = maybeToken();
  if (token === null) return null;
  const response = await fetch(`${getBackendUrl()}/api/user-settings`, {
    headers: authHeader(token),
  });
  if (!response.ok) return null;
  return (await response.json()) as UserSettingsResponse;
};

export const fetchCustomization = async (): Promise<CustomizationData | null> => {
  try {
    const data = await fetchUserSettings();
    if (data === null) return null;
    return {
      systemName:
        data.systemName !== null && data.systemName !== undefined ? data.systemName : 'Rose',
      profilePicture:
        data.profilePicture !== null && data.profilePicture !== undefined
          ? data.profilePicture
          : null,
      customSystemPrompt:
        data.customSystemPrompt !== null && data.customSystemPrompt !== undefined
          ? data.customSystemPrompt
          : '',
    };
  } catch (err) {
    console.error('Failed to load customization:', err);
    return null;
  }
};

export const saveCustomization = async (
  customization: CustomizationData,
  extras?: { voicePreferenceId?: string | null }
): Promise<void> => {
  const token = requireToken();
  const response = await fetch(`${getBackendUrl()}/api/user-settings`, {
    method: 'PATCH',
    headers: {
      ...authHeader(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      systemName:
        customization.systemName !== null &&
        customization.systemName !== undefined &&
        customization.systemName.length > 0
          ? customization.systemName
          : null,
      profilePicture:
        customization.profilePicture !== null && customization.profilePicture !== undefined
          ? customization.profilePicture
          : null,
      customSystemPrompt:
        customization.customSystemPrompt !== null &&
        customization.customSystemPrompt !== undefined &&
        customization.customSystemPrompt.length > 0
          ? customization.customSystemPrompt
          : null,
      ...(extras !== undefined ? { voicePreferenceId: extras.voicePreferenceId ?? null } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error('Failed to save customization');
  }
};

export const fetchIntegrations = async (): Promise<Integration[]> => {
  const token = maybeToken();
  if (token === null) return [];
  const response = await fetch(`${getBackendUrl()}/api/integrations`, {
    headers: authHeader(token),
  });
  if (!response.ok) return [];
  const data = (await response.json()) as { integrations?: Integration[] };
  return data.integrations ?? [];
};

export const startGmailOAuth = async (): Promise<string> => {
  const token = requireToken();
  const response = await fetch(`${getBackendUrl()}/api/integrations/email/gmail/start`, {
    method: 'POST',
    headers: {
      ...authHeader(token),
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error('Failed to start Gmail OAuth');
  }
  const payload = (await response.json()) as { authUrl?: string };
  if (payload.authUrl === undefined || payload.authUrl === '') {
    throw new Error('No auth URL returned');
  }
  return payload.authUrl;
};

interface ApplePasswordsUploadResult {
  passwordCount: number;
}

export const uploadApplePasswords = async (file: File): Promise<ApplePasswordsUploadResult> => {
  const token = requireToken();
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch(`${getBackendUrl()}/api/integrations/passwords/apple/upload`, {
    method: 'POST',
    headers: authHeader(token),
    body: formData,
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
    passwordCount?: number;
  } | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? 'Failed to import passwords');
  }
  return { passwordCount: payload?.passwordCount ?? 0 };
};

export const sendPasswordIntegrationRequest = async (request: string): Promise<void> => {
  const token = requireToken();
  const response = await fetch(`${getBackendUrl()}/api/integrations/passwords/request`, {
    method: 'POST',
    headers: {
      ...authHeader(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ request }),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? 'Failed to send request');
  }
};

// ---------------------------------------------------------------------------
// Plaid (Banking integration)
// ---------------------------------------------------------------------------

export interface PlaidLinkTokenResponse {
  link_token: string;
  expiration: string;
  request_id: string;
}

export interface PlaidExchangeInput {
  publicToken: string;
  institutionId?: string;
  institutionName?: string;
}

export interface PlaidIntegrationItemAccount {
  id: string;
  plaidAccountId: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
}

export interface PlaidIntegrationItem {
  id: string;
  plaidItemId: string;
  institutionId: string | null;
  institutionName: string | null;
  status: 'ACTIVE' | 'DISCONNECTED' | 'REQUIRES_REAUTH' | 'ERROR';
  accounts: PlaidIntegrationItemAccount[];
}

export const createPlaidLinkToken = async (): Promise<PlaidLinkTokenResponse> => {
  const token = requireToken();
  const response = await fetch(`${getBackendUrl()}/api/integrations/plaid/link-token`, {
    method: 'POST',
    headers: { ...authHeader(token), 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    const err = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? 'Failed to create Plaid link token');
  }
  return (await response.json()) as PlaidLinkTokenResponse;
};

export const exchangePlaidPublicToken = async (
  input: PlaidExchangeInput
): Promise<{ item: PlaidIntegrationItem }> => {
  const token = requireToken();
  const response = await fetch(`${getBackendUrl()}/api/integrations/plaid/exchange-public-token`, {
    method: 'POST',
    headers: { ...authHeader(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      public_token: input.publicToken,
      institution_id: input.institutionId,
      institution_name: input.institutionName,
    }),
  });
  if (!response.ok) {
    const err = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? 'Failed to exchange Plaid public token');
  }
  return (await response.json()) as { item: PlaidIntegrationItem };
};

export const fetchPlaidItems = async (): Promise<PlaidIntegrationItem[]> => {
  const token = maybeToken();
  if (token === null) return [];
  const response = await fetch(`${getBackendUrl()}/api/integrations/plaid/items`, {
    headers: authHeader(token),
  });
  if (!response.ok) return [];
  const data = (await response.json().catch(() => null)) as {
    items?: PlaidIntegrationItem[];
  } | null;
  return data?.items ?? [];
};

export const resolvePresetSamplePath = (
  voiceId: string,
  baseUrl: string = import.meta.env.BASE_URL
): string => {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${normalizedBase}voice-samples/${encodeURIComponent(voiceId)}.mp3`;
};

export const resolveCustomPreviewApiUrl = (
  voiceId: string,
  backendUrl: string = getBackendUrl()
): string => `${backendUrl}/api/voices/${encodeURIComponent(voiceId)}/preview`;

export const fetchCustomPreviewUrl = async (voiceId: string): Promise<string | null> => {
  try {
    const response = await fetch(resolveCustomPreviewApiUrl(voiceId));
    if (!response.ok) return null;
    const body = (await response.json()) as { url?: string };
    return typeof body.url === 'string' ? body.url : null;
  } catch {
    return null;
  }
};

export const spawnLinkedInSyncAgent = async (): Promise<void> => {
  const backendUrl = getBackendUrl();
  const token = requireToken();
  const goal = `Download my LinkedIn data export and upload it to the platform.

Steps:
1. Use a browser agent to navigate to https://www.linkedin.com/mypreferences/d/download-my-data and request a full data export. Click "Request archive" to initiate.

2. LinkedIn takes time to prepare the export (can be minutes to hours). Wait 10 minutes between checks. Use a browser agent to check my email inbox for an email from LinkedIn with subject containing "Your LinkedIn data archive is ready". Repeat checking every 10 minutes for up to 8 hours.

3. When the email arrives, use a browser agent to:
   - Open the email
   - Click the download link
   - Download the ZIP file from the LinkedIn download page

4. After downloading the ZIP file, use a claude code agent to upload it to the backend (replace the file path with the actual downloaded ZIP path):
   curl -X POST ${backendUrl}/api/integrations/linkedin/upload -H "Authorization: Bearer ${token}" -F "file=@<path-to-downloaded-zip>"`;

  const response = await fetch(`${backendUrl}/api/agents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(token),
    },
    body: JSON.stringify({
      goal,
      depth: 1,
      source: 'MAC_APP',
      price_limit_cents: 500,
    }),
  });
  if (!response.ok) {
    const err = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? 'Failed to create agent');
  }
};
