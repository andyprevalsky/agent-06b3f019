/**
 * Granola integration API: one-click sign-in, status, sync and disconnect.
 */

import { getAuthHeaders } from '../api';
import { API_BASE_WITH_PATH } from '../config';

export interface GranolaStatus {
  connected: boolean;
  status: 'NOT_CONNECTED' | 'PENDING' | 'CONNECTED' | 'SYNCING' | 'SYNC_FAILED' | 'EXPIRED';
  accountEmail: string | null;
  backfillDone: boolean;
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
  documents: Partial<Record<'granola_note' | 'granola_summary' | 'granola_transcript', number>>;
}

async function granolaJsonOrThrow<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => null)) as
    (T & { error?: string; message?: string }) | null;
  if (!response.ok) {
    throw new Error(
      data?.error === 'GRANOLA_UNAVAILABLE'
        ? 'Granola is unavailable right now. Try again.'
        : (data?.message ?? data?.error ?? `Granola request failed (${response.status})`),
    );
  }
  return data as T;
}

export async function fetchGranolaStatusApi(): Promise<GranolaStatus> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/granola`, {
    headers: getAuthHeaders(),
  });
  return granolaJsonOrThrow<GranolaStatus>(response);
}

/** Start the one-click sign-in; the browser then opens `authorizeUrl`. */
export async function startGranolaSignInApi(
  redirectUri: string,
): Promise<{ authorizeUrl: string }> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/granola/oauth/start`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ redirectUri }),
  });
  return granolaJsonOrThrow<{ authorizeUrl: string }>(response);
}

/** Finish the sign-in with the signed-in user's own session (callback page). */
export async function completeGranolaSignInApi(
  code: string,
  state: string,
): Promise<GranolaStatus> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/granola/oauth/complete`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ code, state }),
  });
  return granolaJsonOrThrow<GranolaStatus>(response);
}

export async function syncGranolaApi(): Promise<GranolaStatus> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/granola/sync`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  return granolaJsonOrThrow<GranolaStatus>(response);
}

export async function disconnectGranolaApi(): Promise<void> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/granola`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  await granolaJsonOrThrow<{ deletedDocuments: number }>(response);
}
