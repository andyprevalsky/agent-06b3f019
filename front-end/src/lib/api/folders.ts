/**
 * Folders REST client: the user-facing name of a Project row (organizational only).
 * Backend contract: back-end/src/domains/projects/routes.topFolders.ts.
 *
 *   GET    /api/folders            -> { folders: Folder[] }
 *   POST   /api/folders { name }   -> 201 Folder | 409 duplicate name
 *                                     (any other field, e.g. a repo, is a 400)
 *   GET    /api/folders/:id        -> Folder | 404
 *   PATCH  /api/folders/:id {name} -> Folder | 409 duplicate name
 *   DELETE /api/folders/:id        -> 204 (its agents fall back to Home)
 *
 * A folder IS a project: `legacy_project_id === id`, so every /api/projects
 * endpoint (settings, env files, template sync) and Agent.project_id keep
 * working. Subfolders stay at /api/projects/:id/folders (lib/api/projects.ts).
 * A folder never carries a repo on create: GitHub repos are connected on the
 * Integrations panel; `github_repo` here is a read-only summary.
 */

import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

export interface FolderGithubRepo {
  /** `gh:<owner>/<repo>`, lowercased. */
  canonical_ref: string;
  repo_url: string;
}

export interface Folder {
  id: string;
  name: string;
  /** Same row under the legacy /api/projects API. */
  legacy_project_id: string;
  subfolders: { id: string; name: string }[];
  /** Connected repo the folder's code sessions restore; null: none. */
  github_repo: FolderGithubRepo | null;
  created_at: string;
  updated_at: string;
}

/** POST / PATCH answered 409: the user already has a folder with this name. */
export class DuplicateFolderNameError extends Error {
  constructor(readonly folderName: string) {
    super(`A folder named “${folderName}” already exists`);
    this.name = 'DuplicateFolderNameError';
  }
}

/** React Query key of GET /api/folders (read-only github_repo per folder). */
export const FOLDERS_QUERY_KEY = ['folders'] as const;

const FOLDERS_URL = `${API_BASE_WITH_PATH}/folders`;

function folderUrl(id: string): string {
  return `${FOLDERS_URL}/${encodeURIComponent(id)}`;
}

export async function fetchFolders(): Promise<Folder[]> {
  const response = await fetch(FOLDERS_URL, { headers: getAuthHeaders() });
  if (!response.ok) throw new Error(`Failed to load folders (${response.status})`);
  return ((await response.json()) as { folders: Folder[] }).folders;
}

/** Name only: a folder is never created with a repo. */
export async function createFolder(name: string): Promise<Folder> {
  const response = await fetch(FOLDERS_URL, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ name }),
  });
  if (response.status === 409) throw new DuplicateFolderNameError(name);
  if (!response.ok) throw new Error(`Failed to create folder (${response.status})`);
  return (await response.json()) as Folder;
}

export async function renameFolder(id: string, name: string): Promise<Folder> {
  const response = await fetch(folderUrl(id), {
    method: 'PATCH',
    headers: getAuthHeaders(),
    body: JSON.stringify({ name }),
  });
  if (response.status === 409) throw new DuplicateFolderNameError(name);
  if (!response.ok) throw new Error(`Failed to rename folder (${response.status})`);
  return (await response.json()) as Folder;
}

export async function deleteFolder(id: string): Promise<void> {
  const response = await fetch(folderUrl(id), { method: 'DELETE', headers: getAuthHeaders() });
  if (!response.ok) throw new Error(`Failed to delete folder (${response.status})`);
}
