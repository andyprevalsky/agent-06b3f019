/**
 * Meeting note taker integration API: one-click sign-in, status, sync and disconnect.
 */

import { getAuthHeaders } from '../api';
import { API_BASE_WITH_PATH } from '../config';
import { meetingNotesProviders, type MeetingNotesProvider } from '../meetingNotes';

export interface MeetingNotesStatus {
  connected: boolean;
  status: 'NOT_CONNECTED' | 'PENDING' | 'CONNECTED' | 'SYNCING' | 'SYNC_FAILED' | 'EXPIRED';
  accountEmail: string | null;
  backfillDone: boolean;
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
  documents: Partial<Record<string, number>>;
}

async function meetingNotesJsonOrThrow<T>(
  provider: MeetingNotesProvider,
  response: Response,
): Promise<T> {
  const data = (await response.json().catch(() => null)) as
    (T & { error?: string; message?: string }) | null;
  if (!response.ok) {
    throw new Error(
      data?.error === `${provider.toUpperCase()}_UNAVAILABLE`
        ? `${meetingNotesProviders[provider].name} is unavailable right now. Try again.`
        : (data?.message ??
            data?.error ??
            `${meetingNotesProviders[provider].name} request failed (${response.status})`),
    );
  }
  return data as T;
}

export async function fetchMeetingNotesStatusApi(
  provider: MeetingNotesProvider,
): Promise<MeetingNotesStatus> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/${provider}`, {
    headers: getAuthHeaders(),
  });
  return meetingNotesJsonOrThrow<MeetingNotesStatus>(provider, response);
}

/** Start the one-click sign-in; the browser then opens `authorizeUrl`. */
export async function startMeetingNotesSignInApi(
  provider: MeetingNotesProvider,
  redirectUri: string,
): Promise<{ authorizeUrl: string }> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/${provider}/oauth/start`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ redirectUri }),
  });
  return meetingNotesJsonOrThrow<{ authorizeUrl: string }>(provider, response);
}

/** Finish the sign-in with the signed-in user's own session (callback page). */
export async function completeMeetingNotesSignInApi(
  provider: MeetingNotesProvider,
  code: string,
  state: string,
): Promise<MeetingNotesStatus> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/${provider}/oauth/complete`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ code, state }),
  });
  return meetingNotesJsonOrThrow<MeetingNotesStatus>(provider, response);
}

export async function syncMeetingNotesApi(
  provider: MeetingNotesProvider,
): Promise<MeetingNotesStatus> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/${provider}/sync`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  return meetingNotesJsonOrThrow<MeetingNotesStatus>(provider, response);
}

export async function disconnectMeetingNotesApi(provider: MeetingNotesProvider): Promise<void> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/${provider}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  await meetingNotesJsonOrThrow<{ deletedDocuments: number }>(provider, response);
}
