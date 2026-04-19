import { MARKERS_URL, getApiBaseUrl } from './config';
import type { MarkersFile, WaitlistPayload, WaitlistResponse } from './types';

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

/** Fetch the markers JSON describing feature-video segments. */
export async function fetchMarkers(): Promise<MarkersFile> {
  const response = await fetch(MARKERS_URL);
  if (!response.ok) throw new Error(`Failed to load markers: ${response.status}`);
  const data = (await response.json()) as MarkersFile;
  return data;
}

/**
 * Prefetch the full master video to a cached Blob and return an object URL.
 * Caller is responsible for calling `URL.revokeObjectURL` on unmount.
 */
export async function prefetchVideoBlobUrl(sourceUrl: string): Promise<string | null> {
  const res = await fetch(sourceUrl, { cache: 'force-cache', credentials: 'same-origin' });
  if (!res.ok) return null;
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
