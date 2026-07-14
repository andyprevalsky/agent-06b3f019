import { backendApiUrl } from '@/lib/backendUrl';
import { getStoredSession } from '@/lib/supabase';

import type { AdminHealthData, AdminHealthTimeSlice } from './types';

const REQUEST_TIMEOUT_MS = 15 * 1000;

export async function fetchAdminHealthData(
  timeSlice: AdminHealthTimeSlice,
): Promise<AdminHealthData> {
  const session = getStoredSession();
  if (!session) throw new Error('Not authenticated');

  const params = new URLSearchParams({ timeSlice });
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${backendApiUrl()}/admin-health?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to load admin health (${response.status})`);
    }

    return (await response.json()) as AdminHealthData;
  } finally {
    window.clearTimeout(timeoutId);
  }
}
