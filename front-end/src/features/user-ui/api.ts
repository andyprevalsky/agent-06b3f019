/**
 * HTTP layer for the per-user UI runtime.
 *
 *   GET /api/user-ui/active    → session user's active published version
 *   GET /api/user-ui/versions  → every published version (for pinned inline views)
 *   GET <usercontent>/theme    → theme.json (data only; never executed)
 */
import { API_BASE_WITH_PATH, getAuthHeaders } from '@/lib/api/client';

import type { ActiveUserUiResponse, UserUiTheme, UserUiVersionSummary } from './types';

export async function fetchActiveUserUi(): Promise<ActiveUserUiResponse> {
  const response = await fetch(`${API_BASE_WITH_PATH}/user-ui/active`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error(`Failed to load active user UI (${response.status})`);
  return (await response.json()) as ActiveUserUiResponse;
}

function extractVersionList(body: unknown): UserUiVersionSummary[] {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { versions?: unknown }).versions)
      ? (body as { versions: unknown[] }).versions
      : [];
  return list.filter(
    (item): item is UserUiVersionSummary =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as { id?: unknown }).id === 'string' &&
      !!(item as { manifest?: unknown }).manifest,
  );
}

export async function fetchUserUiVersions(): Promise<UserUiVersionSummary[]> {
  const response = await fetch(`${API_BASE_WITH_PATH}/user-ui/versions`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error(`Failed to load user UI versions (${response.status})`);
  return extractVersionList(await response.json());
}

/** theme.json lives on the usercontent origin; no app credentials are sent. */
export async function fetchUserUiTheme(url: string): Promise<UserUiTheme> {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`Failed to load user UI theme (${response.status})`);
  const body: unknown = await response.json();
  return body && typeof body === 'object' ? (body as UserUiTheme) : {};
}
