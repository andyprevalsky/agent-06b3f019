/**
 * Projects REST client (Rose Desktop left bar + project settings panel).
 * Backend contract: feat/rose-user-ui @ ea032a02a (strict Zod bodies: unknown
 * fields are a 400, so writes send only the fields below).
 *
 *   GET    /api/projects                       -> { projects: Project[] }
 *   POST   /api/projects { name }              -> 201 Project | 409 duplicate name
 *   PUT    /api/projects/:id (ProjectUpdate)   -> Project (only the edited subset)
 *   DELETE /api/projects/:id                   -> 204
 *   GET    /api/projects/:id/env-files         -> { envFiles: ProjectEnvFile[], query }
 *                                                 (values never returned)
 *   POST   /api/projects/:id/env-files (NewProjectEnvFile) -> 201 ProjectEnvFile
 *   DELETE /api/projects/:id/env-files/:fileId -> 204
 *
 * Agents carry `project_id`; agents without one (or with an id that is not in
 * the list) belong to Home, the root project. POST /api/agents takes
 * `project_id` to start an agent inside a project.
 */

import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

export interface Project {
  id: string;
  name: string;
  /** Code repo the project's workspaces clone, e.g. `https://github.com/org/repo`. */
  repoUrl: string | null;
  /** Verified clone access; false = no repoUrl or not verified yet ("Not connected"). */
  githubConnected: boolean;
  defaultBranch: string;
  startupScript: string | null;
  /** 1..3600, default 120. */
  startupTimeoutS: number;
  lifecycle: { autoWake: boolean };
  sync: { revision: number; lastSyncedAt: string | null };
  envFileCount: number;
  createdAt: string;
  updatedAt: string;
}

/** PUT body: any subset; `startupScript: ''` clears the script. */
export interface ProjectUpdate {
  name?: string;
  repoUrl?: string | null;
  defaultBranch?: string;
  startupScript?: string;
  startupTimeoutS?: number;
  lifecycle?: { autoWake?: boolean };
}

export const MIN_STARTUP_TIMEOUT_S = 1;
export const MAX_STARTUP_TIMEOUT_S = 3600;

export interface ProjectEnvVariable {
  name: string;
  description?: string;
}

/** One managed env/config file. Values are never returned; only variable names. */
export interface ProjectEnvFile {
  id: string;
  /** Path inside the workspace, e.g. `agents/.env`. */
  path: string;
  description: string | null;
  kind: string;
  source: string;
  variables: ProjectEnvVariable[];
  hasContent: boolean;
  sizeBytes: number;
  linkTarget: string | null;
  updatedAt: string;
}

export interface NewProjectEnvFile {
  path: string;
  description?: string;
  /** Pasted dotenv content; encrypted at rest, never returned. */
  content?: string;
}

/** POST /api/projects answered 409: the user already has a project with this name. */
export class DuplicateProjectNameError extends Error {
  constructor(readonly projectName: string) {
    super(`A project named “${projectName}” already exists`);
    this.name = 'DuplicateProjectNameError';
  }
}

const PROJECTS_URL = `${API_BASE_WITH_PATH}/projects`;

function projectUrl(id: string): string {
  return `${PROJECTS_URL}/${encodeURIComponent(id)}`;
}

function envFilesUrl(projectId: string): string {
  return `${projectUrl(projectId)}/env-files`;
}

export async function fetchProjects(): Promise<Project[]> {
  const response = await fetch(PROJECTS_URL, { headers: getAuthHeaders() });
  if (!response.ok) throw new Error(`Failed to load projects (${response.status})`);
  const body = (await response.json()) as { projects: Project[] };
  return body.projects;
}

export async function createProject(name: string): Promise<Project> {
  const response = await fetch(PROJECTS_URL, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ name }),
  });
  if (response.status === 409) throw new DuplicateProjectNameError(name);
  if (!response.ok) throw new Error(`Failed to create project (${response.status})`);
  return (await response.json()) as Project;
}

export async function updateProject(id: string, updates: ProjectUpdate): Promise<Project> {
  const response = await fetch(projectUrl(id), {
    method: 'PUT',
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

export async function fetchProjectEnvFiles(projectId: string): Promise<ProjectEnvFile[]> {
  const response = await fetch(envFilesUrl(projectId), { headers: getAuthHeaders() });
  if (!response.ok) throw new Error(`Failed to load environment files (${response.status})`);
  // Backend envFileService.listEnvFiles wraps the list (it also serves ?q= search).
  const body = (await response.json()) as { envFiles: ProjectEnvFile[] };
  return body.envFiles;
}

export async function createProjectEnvFile(
  projectId: string,
  file: NewProjectEnvFile,
): Promise<ProjectEnvFile> {
  const response = await fetch(envFilesUrl(projectId), {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(file),
  });
  if (!response.ok) throw new Error(`Failed to add environment file (${response.status})`);
  return (await response.json()) as ProjectEnvFile;
}

export async function deleteProjectEnvFile(projectId: string, fileId: string): Promise<void> {
  const response = await fetch(`${envFilesUrl(projectId)}/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error(`Failed to delete environment file (${response.status})`);
}
