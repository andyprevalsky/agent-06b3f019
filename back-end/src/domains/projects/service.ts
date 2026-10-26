/**
 * Projects: owner-scoped codebase settings (default branch, startup script and
 * timeout, lifecycle) plus managed env files whose values are stored only as
 * credential envelopes.
 *
 *   UI / rose-sync ─► routes ─► service ─► repo (providers/projects/store)
 *                                  │
 *                                  └─► providers/projects/secrets (encrypt / fingerprint)
 *
 * Responses never include a secret value: env files expose variable names,
 * descriptions and sizes only.
 *
 * 10k-agent behaviour: every call touches one user's project rows (bounded by
 * PROJECT_LIST_LIMIT / MAX_ENV_FILES); listing uses one query with counts.
 * Rose dev accounts get their "Rose" project set up on list (roseProject.ts).
 */
import { createLogger } from '../../providers/logger';
import type { EnvVariableMeta } from '../../providers/projects/envFile';
import { sandboxSizeColumn } from '../../providers/projects/store';
import * as repo from './repo';
import { applyRoseProjectSetup, planRoseProjectSetup } from './roseProject';
import type { CreateProjectBody, UpdateProjectBody } from './types';

export class ProjectError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
  }
}

export interface ProjectDto {
  id: string;
  name: string;
  repoUrl: string | null;
  /** Rose has verified clone access to repoUrl for this user (GithubRepoAccess grant). */
  githubConnected: boolean;
  defaultBranch: string;
  startupScript: string | null;
  startupTimeoutS: number;
  lifecycle: { autoWake: boolean };
  /** Default code-sandbox size of new sessions (C16); null = deployment default. */
  sandboxSize: { cpu?: number; memoryGb?: number } | null;
  sync: { revision: number; lastSyncedAt: string | null };
  envFileCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface EnvFileDto {
  id: string;
  path: string;
  description: string | null;
  kind: string;
  source: string;
  variables: EnvVariableMeta[];
  hasContent: boolean;
  sizeBytes: number;
  linkTarget: string | null;
  updatedAt: string;
  /** Variable names that matched `q` (search responses only). */
  matches?: string[];
}

export function toProjectDto(
  project: repo.ProjectRecord,
  envFileCount: number,
  githubConnected: boolean
): ProjectDto {
  return {
    id: project.id,
    name: project.name,
    repoUrl: project.repoUrl,
    githubConnected,
    defaultBranch: project.defaultBranch,
    startupScript: project.startupScript,
    startupTimeoutS: project.startupTimeoutS,
    lifecycle: { autoWake: project.autoWake },
    sandboxSize: sandboxSizeOf(project.sandboxSize),
    sync: {
      revision: project.syncRevision,
      lastSyncedAt: project.lastSyncedAt ? project.lastSyncedAt.toISOString() : null,
    },
    envFileCount,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

/** The stored `{cpu?, memoryGb?}`, or null for anything else. */
export function sandboxSizeOf(value: unknown): { cpu?: number; memoryGb?: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { cpu, memoryGb } = value as { cpu?: unknown; memoryGb?: unknown };
  const size = {
    ...(Number.isInteger(cpu) ? { cpu: cpu as number } : {}),
    ...(Number.isInteger(memoryGb) ? { memoryGb: memoryGb as number } : {}),
  };
  return Object.keys(size).length > 0 ? size : null;
}

export function variablesOf(file: repo.ProjectEnvFileRecord): EnvVariableMeta[] {
  if (!Array.isArray(file.variables)) return [];
  return (file.variables as unknown[]).flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { name, description } = entry as { name?: unknown; description?: unknown };
    if (typeof name !== 'string') return [];
    return typeof description === 'string' && description !== ''
      ? [{ name, description }]
      : [{ name }];
  });
}

export function toEnvFileDto(file: repo.ProjectEnvFileRecord): EnvFileDto {
  return {
    id: file.id,
    path: file.path,
    description: file.description,
    kind: file.kind,
    source: file.source,
    variables: variablesOf(file),
    hasContent: file.encryptedContent !== null,
    sizeBytes: file.sizeBytes,
    linkTarget: file.linkTarget,
    updatedAt: file.updatedAt.toISOString(),
  };
}

/** Strip userinfo (tokens) from a remote URL before it is stored or shown. */
export function sanitizeRepoUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim();
  if (value === '') return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      url.username = '';
      url.password = '';
      return url.toString().replace(/\/$/, '');
    }
  } catch {
    // scp-style (git@host:org/repo) or local paths are stored verbatim
  }
  return value;
}

async function requireUser(userId: string): Promise<void> {
  if (!(await repo.userExists(userId))) throw new ProjectError(404, 'User not found');
}

export async function requireProject(userId: string, id: string): Promise<repo.ProjectRecord> {
  const project = await repo.findProject(userId, id);
  if (!project) throw new ProjectError(404, 'Project not found');
  return project;
}

function settingsData(body: UpdateProjectBody) {
  return {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.repoUrl !== undefined ? { repoUrl: sanitizeRepoUrl(body.repoUrl) } : {}),
    ...(body.defaultBranch !== undefined ? { defaultBranch: body.defaultBranch } : {}),
    ...(body.startupScript !== undefined
      ? { startupScript: body.startupScript === '' ? null : body.startupScript }
      : {}),
    ...(body.startupTimeoutS !== undefined ? { startupTimeoutS: body.startupTimeoutS } : {}),
    ...(body.lifecycle?.autoWake !== undefined ? { autoWake: body.lifecycle.autoWake } : {}),
    ...(body.sandboxSize !== undefined ? { sandboxSize: sandboxSizeColumn(body.sandboxSize) } : {}),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

const log = createLogger('Projects');

export async function listProjects(userId: string): Promise<{ projects: ProjectDto[] }> {
  let rows = await repo.listProjects(userId);
  let connected = await repo.findGithubConnectedRepoUrls(
    userId,
    rows.map((row) => row.repoUrl)
  );
  const rosePlan = planRoseProjectSetup(userId, rows, connected);
  if (rosePlan !== null) {
    log.info('Setting up the Rose project', { userId, ...rosePlan });
    try {
      await applyRoseProjectSetup(userId, rosePlan);
    } catch (error) {
      // Listing never depends on the setup; the next list retries it.
      log.error('Rose project setup failed', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    rows = await repo.listProjects(userId);
    connected = await repo.findGithubConnectedRepoUrls(
      userId,
      rows.map((row) => row.repoUrl)
    );
  }
  return {
    projects: rows.map((row) =>
      toProjectDto(row, row._count.envFiles, row.repoUrl !== null && connected.has(row.repoUrl))
    ),
  };
}

/** One project's DTO: env-file count + GitHub access in parallel. */
export async function projectDto(userId: string, project: repo.ProjectRecord): Promise<ProjectDto> {
  const [envFileCount, connected] = await Promise.all([
    repo.countEnvFiles(project.id),
    repo.findGithubConnectedRepoUrls(userId, [project.repoUrl]),
  ]);
  return toProjectDto(
    project,
    envFileCount,
    project.repoUrl !== null && connected.has(project.repoUrl)
  );
}

export async function getProject(userId: string, id: string): Promise<ProjectDto> {
  return projectDto(userId, await requireProject(userId, id));
}

export async function createProject(userId: string, body: CreateProjectBody): Promise<ProjectDto> {
  await requireUser(userId);
  try {
    const project = await repo.createProject({ userId, ...settingsData(body), name: body.name });
    return await projectDto(userId, project);
  } catch (err) {
    if (isUniqueViolation(err)) throw new ProjectError(409, 'A project with this name exists');
    throw err;
  }
}

/** PUT /api/projects: create or update the caller's project with this name. */
export async function upsertProjectByName(
  userId: string,
  body: CreateProjectBody
): Promise<{ project: ProjectDto; created: boolean }> {
  const existing = await repo.findProjectByName(userId, body.name);
  if (!existing) return { project: await createProject(userId, body), created: true };
  const updated = await repo.updateProject(existing.id, settingsData(body));
  return { project: await projectDto(userId, updated), created: false };
}

export async function updateProject(
  userId: string,
  id: string,
  body: UpdateProjectBody
): Promise<ProjectDto> {
  const project = await requireProject(userId, id);
  try {
    const updated = await repo.updateProject(project.id, settingsData(body));
    return await projectDto(userId, updated);
  } catch (err) {
    if (isUniqueViolation(err)) throw new ProjectError(409, 'A project with this name exists');
    throw err;
  }
}

export async function deleteProject(userId: string, id: string): Promise<void> {
  const project = await requireProject(userId, id);
  await repo.deleteProject(project.id);
}
