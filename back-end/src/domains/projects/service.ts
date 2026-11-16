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
 * Rose repo owners get their "Rose" project set up on list (roseProject.ts).
 * A connected GitHub repo is a project: listing first links connections that
 * have none (one indexed query; writes only when such connections exist), and
 * deleting a project disconnects its repo so the link never resurrects it.
 *
 * A row is a left-bar folder (isFolder: POST /api/folders), a repository
 * (isRepository: GitHub connect, POST/PUT /api/projects, rose push), or both:
 *
 *   DELETE /api/folders/:id   both → stays a repository (agents Home, subfolders gone)
 *                             folder only → deleted;  repository only → 404
 *   DELETE /api/projects/:id  both → stays a folder (repo, env files, synced code gone)
 *                             otherwise → deleted
 *
 * The list also carries repositories teammates shared through a team
 * (`shared`), read-only: no env files, scripts or subfolders, and every
 * write route stays owner-scoped (404). One extra indexed query per list.
 */
import { createLogger } from '../../providers/logger';
import { sandboxSizeColumn } from '../../providers/projects/store';
import * as repo from './repo';
import {
  DEFAULT_ROSE_SETUP,
  applyRoseProjectSetup,
  planRoseProjectSetup,
  type RoseSetupDeps,
} from './roseProject';
import { toProjectDto, toSharedProjectDto, type ProjectDto } from './servicePresentation';
import type { CreateProjectBody, UpdateProjectBody } from './types';

/** DTO assembly lives in servicePresentation.ts; callers keep importing it from here. */
export {
  sandboxSizeOf,
  toEnvFileDto,
  toProjectDto,
  variablesOf,
  type EnvFileDto,
  type ProjectDto,
} from './servicePresentation';

export class ProjectError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
  }
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
    ...maintenanceData(body.maintenance),
  };
}

/** A cleared script is stored as "" (null means never configured: the Rose default fills in). */
function maintenanceData(maintenance: UpdateProjectBody['maintenance']) {
  if (maintenance === undefined) return {};
  return {
    ...(maintenance.script !== undefined
      ? {
          maintenanceScript:
            maintenance.script !== null && maintenance.script.trim() !== ''
              ? maintenance.script
              : '',
        }
      : {}),
    ...(maintenance.timeoutS !== undefined ? { maintenanceTimeoutS: maintenance.timeoutS } : {}),
    ...(maintenance.nightly !== undefined ? { maintenanceNightly: maintenance.nightly } : {}),
    ...(maintenance.onGithubChange !== undefined
      ? { maintenanceOnGithubChange: maintenance.onGithubChange }
      : {}),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

const log = createLogger('Projects');

/** The owner's project rows and the repo URLs among them the owner may clone. */
async function readProjects(userId: string) {
  const rows = await repo.listProjects(userId);
  const urls = rows.map((row) => row.repoUrl);
  return { rows, connected: await repo.findGithubConnectedRepoUrls(userId, urls) };
}

/** The caller's own rows, then the repositories teammates share with them (deduplicated). */
export async function listProjects(
  userId: string,
  roseSetup: RoseSetupDeps = DEFAULT_ROSE_SETUP
): Promise<{ projects: ProjectDto[] }> {
  const [{ projects }, shared] = await Promise.all([
    listOwnedProjects(userId, roseSetup),
    repo.listSharedRepositoryProjects(userId),
  ]);
  const owned = new Set(projects.map((project) => project.id));
  const others = shared.filter((row) => !owned.has(row.project.id));
  const connected = await repo.findGithubConnectedRepoUrls(
    userId,
    others.map((row) => row.project.repoUrl)
  );
  return {
    projects: [
      ...projects,
      ...others.map((row) =>
        toSharedProjectDto(row, row.project.repoUrl !== null && connected.has(row.project.repoUrl))
      ),
    ],
  };
}

/** A CLI credential (rose push) lists the user's own projects only: its bound one, if any. */
export async function listCliProjects(
  userId: string,
  boundProjectId: string | null
): Promise<{ projects: ProjectDto[] }> {
  const { projects } = await listOwnedProjects(userId, DEFAULT_ROSE_SETUP);
  return { projects: projects.filter((p) => boundProjectId === null || p.id === boundProjectId) };
}

/** GET /api/folders: the caller's left-bar folders only (one query + one grant read). */
export async function listFolderProjects(userId: string): Promise<{ projects: ProjectDto[] }> {
  const rows = await repo.listProjects(userId, { foldersOnly: true });
  const connected = await repo.findGithubConnectedRepoUrls(
    userId,
    rows.map((row) => row.repoUrl)
  );
  return {
    projects: rows.map((row) =>
      toProjectDto(row, row._count.envFiles, row.repoUrl !== null && connected.has(row.repoUrl))
    ),
  };
}

async function listOwnedProjects(
  userId: string,
  roseSetup: RoseSetupDeps
): Promise<{ projects: ProjectDto[] }> {
  // A connected repo is a project: link the ones without one (never fails the list).
  await repo.linkUnlinkedRepoConnections(userId);
  let { rows, connected } = await readProjects(userId);
  const rosePlan = planRoseProjectSetup(userId, rows, connected, roseSetup.isOwner);
  if (rosePlan !== null) {
    log.info('Setting up the Rose project', { userId, ...rosePlan });
    try {
      await applyRoseProjectSetup(userId, rosePlan, roseSetup);
    } catch (error) {
      // Listing never depends on the setup; the next list retries it.
      log.error('Rose project setup failed', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    ({ rows, connected } = await readProjects(userId));
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

/** A new row is a repository (the API and CLI), or a left-bar folder for /api/folders. */
export async function createProject(
  userId: string,
  body: CreateProjectBody,
  options: { isFolder?: boolean } = {}
): Promise<ProjectDto> {
  await requireUser(userId);
  try {
    const project = await repo.createProject({
      userId,
      ...settingsData(body),
      name: body.name,
      isFolder: options.isFolder ?? false,
    });
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
  try {
    const updated = await repo.updateProject(existing.id, settingsData(body));
    return { project: await projectDto(userId, updated), created: false };
  } catch (error) {
    if (error instanceof repo.ProjectRepositoryBusyError) {
      throw new ProjectError(
        409,
        'Wait for the project sync to finish before changing its repository'
      );
    }
    throw error;
  }
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
    if (err instanceof repo.ProjectRepositoryBusyError) {
      throw new ProjectError(
        409,
        'Wait for the project sync to finish before changing its repository'
      );
    }
    throw err;
  }
}

/** DELETE /api/projects/:id: a folder keeps its folder role; anything else is deleted. */
export async function deleteProject(userId: string, id: string): Promise<void> {
  const project = await requireProject(userId, id);
  let removal: repo.RepositoryRemoval;
  try {
    removal = await repo.removeRepository(project.id);
  } catch (error) {
    if (error instanceof repo.ProjectRepositoryBusyError) {
      throw new ProjectError(409, 'Wait for the project sync to finish before removing it');
    }
    throw error;
  }
  if (removal === 'missing') throw new ProjectError(404, 'Project not found');
  log.info('Project removed', { userId, projectId: project.id, removal });
}

/** DELETE /api/folders/:id: a repository keeps its repository role; a plain folder is deleted. */
export async function deleteFolderProject(userId: string, id: string): Promise<void> {
  const project = await requireProject(userId, id);
  const removal = await repo.removeFolder(project.id);
  if (removal === 'not_a_folder') throw new ProjectError(404, 'Project not found');
  log.info('Folder removed', { userId, projectId: project.id, removal });
}
