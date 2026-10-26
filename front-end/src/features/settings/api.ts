import { fetchUserSettings } from '@/lib/api/userSettings';
import { getStoredSession } from '@/lib/supabase';

import { API_URL } from './config';

function getAuthHeaders() {
  const session = getStoredSession();
  if (!session) throw new Error('Not authenticated');
  return { Authorization: `Bearer ${session.access_token}` };
}

/** Loads user settings from the backend (shared client; the Rose left bar reads it too). */
export async function loadSettingsApi(): Promise<Record<string, unknown>> {
  return fetchUserSettings();
}

/** Saves personal info fields via PUT. */
export async function savePersonalInfoApi(data: {
  name: string;
  email: string;
  deliveryRecipientName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_URL}/api/user-settings`, {
    method: 'PUT',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error('Failed to save settings');
  return response.json() as Promise<Record<string, unknown>>;
}

/** Saves customization fields via PATCH. */
export async function saveCustomizationApi(data: {
  systemName: string | null;
  profilePicture: string | null;
  customSystemPrompt: string | null;
}): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_URL}/api/user-settings`, {
    method: 'PATCH',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error('Failed to save customization');
  return response.json() as Promise<Record<string, unknown>>;
}

/** Loads subscription info. */
export async function loadSubscriptionApi(): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_URL}/api/credits/subscription`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Failed to load subscription');
  return response.json() as Promise<Record<string, unknown>>;
}

/** Loads API keys. */
export async function loadApiKeysApi(): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_URL}/api/api-keys`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Failed to load API keys');
  return response.json() as Promise<Record<string, unknown>>;
}

/** Opens billing portal, returns the portal URL. */
export async function openBillingPortalApi(): Promise<{
  url: string;
  notFound?: boolean;
  message?: string;
}> {
  const response = await fetch(`${API_URL}/api/billing/portal`, {
    headers: getAuthHeaders(),
  });

  if (!response.ok) {
    const data = (await response.json()) as Record<string, unknown>;
    if (response.status === 404) {
      return {
        url: '',
        notFound: true,
        message:
          (data.message as string) ||
          'You need an active subscription to access the billing portal.',
      };
    }
    throw new Error('Failed to open billing portal');
  }

  return response.json() as Promise<{ url: string }>;
}

/** Generates a new API key. */
export async function generateApiKeyApi(name: string | null): Promise<{ apiKey: string }> {
  const response = await fetch(`${API_URL}/api/api-keys`, {
    method: 'POST',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    const data = (await response.json()) as Record<string, unknown>;
    throw new Error((data.error as string) || 'Failed to generate API key');
  }
  return response.json() as Promise<{ apiKey: string }>;
}

/** Deletes an API key by ID. */
export async function deleteApiKeyApi(keyId: string): Promise<void> {
  await fetch(`${API_URL}/api/api-keys/${keyId}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
}
