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

function readVersionId(record: Record<string, unknown>): string | null {
  if (typeof record.versionId === 'string' && record.versionId.length > 0) return record.versionId;
  // Legacy shape: `{ id, manifest }`.
  if (typeof record.id === 'string' && record.id.length > 0) return record.id;
  return null;
}

/** Accepts `{ activeVersionId, versions: [{ versionId, manifest, ... }] }` or a bare array. */
function extractVersionList(body: unknown): UserUiVersionSummary[] {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { versions?: unknown }).versions)
      ? (body as { versions: unknown[] }).versions
      : [];
  const versions: UserUiVersionSummary[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const versionId = readVersionId(record);
    const manifest = record.manifest;
    if (versionId === null || !manifest || typeof manifest !== 'object') continue;
    versions.push({
      versionId,
      manifest: manifest as UserUiVersionSummary['manifest'],
      ...(typeof record.fileCount === 'number' ? { fileCount: record.fileCount } : {}),
      ...(typeof record.totalBytes === 'number' ? { totalBytes: record.totalBytes } : {}),
      ...(typeof record.createdAt === 'string' ? { createdAt: record.createdAt } : {}),
      ...(typeof record.active === 'boolean' ? { active: record.active } : {}),
    });
  }
  return versions;
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
