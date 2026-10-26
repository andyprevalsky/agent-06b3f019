import { backendApiUrl } from '@/lib/backendUrl';
import { getAdminAccessToken } from '@/lib/impersonation';

import type { AdminHealthData, AdminHealthTimeSlice, AdminWaitlistInviteResponse } from './types';

const REQUEST_TIMEOUT_MS = 15 * 1000;

export async function fetchAdminHealthData(
  timeSlice: AdminHealthTimeSlice,
): Promise<AdminHealthData> {
  const token = getAdminAccessToken();
  if (token === null) throw new Error('Not authenticated');

  const params = new URLSearchParams({ timeSlice });
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${backendApiUrl()}/admin-health?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
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

/**
 * Biz health's first open of a UTC day waits on the backend's cold build
 * (~6-10 s in prod: Stripe, Amplitude, Linear and GitHub reads behind one
 * Promise.all); later requests that day are served from its day cache in ~1 ms.
 * Admin shells call this once when they mount so that build (and this feature's
 * code chunk) is underway before the panel opens. The response is discarded:
 * the panel still issues its own request, so nothing is cached in the browser.
 */
export function prewarmAdminHealth(): void {
  fetchAdminHealthData('monthly').catch(() => undefined);
}

async function parseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (typeof body.error === 'string' && body.error !== '') return body.error;
  } catch {
    // fall through to status-based message
  }
  return `Request failed (${response.status})`;
}

export async function inviteWaitlistPerson(
  id: string,
  idempotencyKey: string,
): Promise<AdminWaitlistInviteResponse> {
  const token = getAdminAccessToken();
  if (token === null) throw new Error('Not authenticated');

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${backendApiUrl()}/admin-health/waitlist/${encodeURIComponent(id)}/invite`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        signal: controller.signal,
      },
    );

    if (!response.ok) throw new Error(await parseError(response));

    return (await response.json()) as AdminWaitlistInviteResponse;
  } finally {
    window.clearTimeout(timeoutId);
  }
}
