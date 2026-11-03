/**
 * GET /api/user-settings — the signed-in account's Rose profile (name, email,
 * phone, delivery address, customization) from the backend User row.
 *
 * One client for every reader: Settings → Personal Info (features/settings
 * loadSettingsApi) and the Rose Desktop left bar's account row (its name and
 * cursive initial; phone-OTP accounts have no name in Supabase auth metadata).
 */

import { BACKEND_BASE_URL } from '../backendUrl';
import { getStoredSession } from '../supabase';

export async function fetchUserSettings(): Promise<Record<string, unknown>> {
  const session = getStoredSession();
  if (!session) throw new Error('Not authenticated');
  const response = await fetch(`${BACKEND_BASE_URL}/api/user-settings`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (!response.ok) throw new Error('Failed to load settings');
  return response.json() as Promise<Record<string, unknown>>;
}
