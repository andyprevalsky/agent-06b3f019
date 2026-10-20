/**
 * Projects REST client (Rose Desktop left bar + project settings panel).
 *
 *   GET    /api/projects      -> Project[]
 *   POST   /api/projects      (body: { name }) -> Project
 *   PATCH  /api/projects/:id  (body: ProjectUpdate) -> Project
 *   DELETE /api/projects/:id  -> 204
 *
 * Agents carry `project_id`; agents without one (or with an id that is not in
 * the list) belong to Home, the root project.
 */

import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

export interface ProjectEnvFile {
  /** Path inside the workspace, e.g. `agents/.env`. */
  path: string;
  description: string;
}

export interface Project {
  id: string;
  name: string;
  /** Code repo the project's workspaces clone, e.g. `https://github.com/org/repo`. */
  repoUrl?: string | null;
  /** Server-computed: the user's GitHub connection can access `repoUrl`. */
  githubConnected?: boolean;
  defaultBranch: string;
  startupScript: string;
  startupTimeoutSec: number;
  envFiles: ProjectEnvFile[];
  autoWake: boolean;
}

export type ProjectUpdate = Partial<Omit<Project, 'id' | 'githubConnected'>>;

const PROJECTS_URL = `${API_BASE_WITH_PATH}/projects`;

function projectUrl(id: string): string {
  return `${PROJECTS_URL}/${encodeURIComponent(id)}`;
}

export async function fetchProjects(): Promise<Project[]> {
  const response = await fetch(PROJECTS_URL, { headers: getAuthHeaders() });
  if (!response.ok) throw new Error(`Failed to load projects (${response.status})`);
  return (await response.json()) as Project[];
}

export async function createProject(name: string): Promise<Project> {
  const response = await fetch(PROJECTS_URL, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new Error(`Failed to create project (${response.status})`);
  return (await response.json()) as Project;
}

export async function updateProject(id: string, updates: ProjectUpdate): Promise<Project> {
  const response = await fetch(projectUrl(id), {
    method: 'PATCH',
    headers: getAuthHeaders(),
    body: JSON.stringify(updates),
  });
  if (!response.ok) throw new Error(`Failed to save project (${response.status})`);
  return (await response.json()) as Project;
}

export async function deleteProject(id: string): Promise<void> {
  const response = await fetch(projectUrl(id), { method: 'DELETE', headers: getAuthHeaders() });
  if (!response.ok) throw new Error(`Failed to delete project (${response.status})`);
}
