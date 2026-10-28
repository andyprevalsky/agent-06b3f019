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
 *   POST   /api/projects/cli-login-codes { projectId } -> 201 CliLoginCode
 *                                                 (one-time code for `rose agent-init`)
 *   GET    /api/projects/:id/maintenance       -> MaintenanceState (template sync)
 *   POST   /api/projects/:id/maintenance/runs {mode} -> 202 MaintenanceRun
 *   GET    /api/projects/:id/maintenance/runs/:runId -> MaintenanceRun with its log
 *
 * Agents carry `project_id`; agents without one (or with an id that is not in
 * the list) belong to Home, the root project. POST /api/agents takes
 * `project_id` to start an agent inside a project.
 */

import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

/** Template sync: the script run on the project's template sandbox (boxes.dev "Template maintenance"). */
export interface ProjectMaintenance {
  /** null = no script. */
  script: string | null;
  /** 1..480. */
  timeoutS: number;
  nightly: boolean;
  onGithubChange: boolean;
  /** Next nightly run; null when the schedule is off. */
  nextRunAt: string | null;
  /** Last GitHub head poll; null when not watching or never checked. */
  watchCheckedAt: string | null;
  running: boolean;
}

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
  maintenance: ProjectMaintenance;
  /** Latest published template snapshot new code sessions start from; null: none yet. */
  snapshot: { takenAt: string; sha: string | null } | null;
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
  /** `script: null` clears the script. */
  maintenance?: {
    script?: string | null;
    timeoutS?: number;
    nightly?: boolean;
    onGithubChange?: boolean;
  };
}

export const MIN_STARTUP_TIMEOUT_S = 1;
export const MAX_STARTUP_TIMEOUT_S = 3600;
export const MIN_MAINTENANCE_TIMEOUT_S = 1;
/** Boxes.dev Template maintenance allows up to 8 minutes. */
export const MAX_MAINTENANCE_TIMEOUT_S = 480;

export type MaintenanceRunStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT';
export type MaintenanceMode = 'sync' | 'snapshot';

export interface MaintenanceRun {
  id: string;
  trigger: 'manual' | 'snapshot' | 'nightly' | 'github';
  mode: MaintenanceMode;
  status: MaintenanceRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  headSha: string | null;
  snapshotId: string | null;
  fromSnapshot: boolean;
  error: string | null;
  /** Redacted output tail; only on the single-run response. */
  log?: string;
}

export interface MaintenanceState {
  snapshot: { takenAt: string; sha: string | null } | null;
  running: boolean;
  nextRunAt: string | null;
  watchCheckedAt: string | null;
  runs: MaintenanceRun[];
}

/** POST …/maintenance/runs answered 409: a sync is already running for this project. */
export class MaintenanceRunningError extends Error {
  constructor() {
    super('A sync is already running for this project');
    this.name = 'MaintenanceRunningError';
  }
}

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

/** One-time code for `rose agent-init --login-code` (single use, ~30 minutes). */
export interface CliLoginCode {
  code: string;
  expiresAt: string;
  project: { id: string; name: string } | null;
}

export async function createCliLoginCode(projectId: string): Promise<CliLoginCode> {
  const response = await fetch(`${PROJECTS_URL}/cli-login-codes`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ projectId }),
  });
  if (!response.ok) throw new Error(`Failed to create a setup code (${response.status})`);
  return (await response.json()) as CliLoginCode;
}

function maintenanceUrl(projectId: string): string {
  return `${projectUrl(projectId)}/maintenance`;
}

export async function fetchMaintenance(projectId: string): Promise<MaintenanceState> {
  const response = await fetch(maintenanceUrl(projectId), { headers: getAuthHeaders() });
  if (!response.ok) throw new Error(`Failed to load sync status (${response.status})`);
  return (await response.json()) as MaintenanceState;
}

/** Run now (`sync`) or Snapshot now (`snapshot`). Resolves with the started run. */
export async function startMaintenanceRun(
  projectId: string,
  mode: MaintenanceMode,
): Promise<MaintenanceRun> {
  const response = await fetch(`${maintenanceUrl(projectId)}/runs`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ mode }),
  });
  if (response.status === 409) throw new MaintenanceRunningError();
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to start the sync (${response.status})`);
  }
  return (await response.json()) as MaintenanceRun;
}

export async function fetchMaintenanceRun(
  projectId: string,
  runId: string,
): Promise<MaintenanceRun> {
  const response = await fetch(`${maintenanceUrl(projectId)}/runs/${encodeURIComponent(runId)}`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error(`Failed to load the run (${response.status})`);
  return (await response.json()) as MaintenanceRun;
}
