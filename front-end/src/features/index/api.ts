import { getApiBaseUrl } from './config';
import type { WaitlistPayload, WaitlistResponse } from './types';

/** Submit a waitlist sign-up to the backend. */
export async function submitWaitlist(payload: WaitlistPayload): Promise<WaitlistResponse> {
  const base = getApiBaseUrl();
  const response = await fetch(`${base}/waitlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data: WaitlistResponse = await response.json();

  if (!response.ok) {
    throw new Error((data as Record<string, string>).error || 'Failed to join waitlist');
  }

  return data;
}
