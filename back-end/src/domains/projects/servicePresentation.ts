/**
 * Pure DTO assembly for projects (no reads): a caller's own row, and a
 * teammate's shared repository with the owner's settings stripped. Responses
 * never include a secret value: env files expose variable names, descriptions
 * and sizes only.
 */
import type { EnvVariableMeta } from '../../providers/projects/envFile';
import { nextNightlyRun } from '../../providers/projects/maintenanceSchedule';
import { canonicalGithubRepoRef } from '../../providers/projects/store';
import * as repo from './repo';

export interface ProjectDto {
  folders: { id: string; name: string; projectId: string }[];
  id: string;
  name: string;
  repoUrl: string | null;
  /** A left-bar folder (organizes agents). Always false for a shared row. */
  isFolder: boolean;
  /** Listed in Integrations › GitHub Repositories (a repo, synced code, or not a folder). */
  isRepository: boolean;
  /** Shared with the caller by a teammate through a team; null: the caller's own. */
  shared: { ownerName: string; teamName: string } | null;
  /** Rose has verified clone access to repoUrl for this user (GithubRepoAccess grant). */
  githubConnected: boolean;
  github_repo_ref: string | null; // connected repo's canonical ref (null: none granted)
  defaultBranch: string;
  startupScript: string | null;
  startupTimeoutS: number;
  lifecycle: { autoWake: boolean };
  /** Default code-sandbox size of new sessions (C16); null = deployment default. */
  sandboxSize: { cpu?: number; memoryGb?: number } | null;
  sync: { revision: number; lastSyncedAt: string | null };
  /** Template sync (Rose's equivalent of a Template box's maintenance script). */
  maintenance: {
    script: string | null;
    timeoutS: number;
    nightly: boolean;
    onGithubChange: boolean;
    /** Next nightly run (UTC slot); null when the schedule is off. */
    nextRunAt: string | null;
    watchCheckedAt: string | null;
    running: boolean;
  };
  /** Latest published template snapshot new code sessions start from; null: none yet. */
  snapshot: { takenAt: string; sha: string | null } | null;
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
    folders: project.folders ?? [],
    name: project.name,
    repoUrl: project.repoUrl,
    isFolder: project.isFolder,
    isRepository: repo.isRepositoryProject(project),
    shared: null,
    githubConnected,
    github_repo_ref: githubConnected ? canonicalGithubRepoRef(project.repoUrl) : null,
    defaultBranch: project.defaultBranch,
    startupScript: project.startupScript,
    startupTimeoutS: project.startupTimeoutS,
    lifecycle: { autoWake: project.autoWake },
    sandboxSize: sandboxSizeOf(project.sandboxSize),
    sync: {
      revision: project.syncRevision,
      lastSyncedAt: project.lastSyncedAt ? project.lastSyncedAt.toISOString() : null,
    },
    maintenance: {
      script: project.maintenanceScript === '' ? null : project.maintenanceScript,
      timeoutS: project.maintenanceTimeoutS,
      nightly: project.maintenanceNightly,
      onGithubChange: project.maintenanceOnGithubChange,
      nextRunAt: project.maintenanceNightly ? nextNightlyRun(new Date()).toISOString() : null,
      watchCheckedAt: project.maintenanceOnGithubChange
        ? (project.maintenanceWatchCheckedAt?.toISOString() ?? null)
        : null,
      running:
        project.maintenanceRunId !== null &&
        project.maintenanceLeaseUntil !== null &&
        project.maintenanceLeaseUntil.getTime() > Date.now(),
    },
    snapshot:
      project.templateSnapshotId !== null && project.templateSnapshotAt !== null
        ? {
            takenAt: project.templateSnapshotAt.toISOString(),
            sha: project.templateSnapshotSha,
          }
        : null,
    envFileCount,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

/**
 * A teammate's shared repository as the caller sees it: never the owner's
 * scripts, env files (count 0) or subfolders, and never a folder of the caller.
 */
export function toSharedProjectDto(
  shared: repo.SharedProjectRecord,
  githubConnected: boolean
): ProjectDto {
  const dto = toProjectDto(shared.project, 0, githubConnected);
  return {
    ...dto,
    folders: [],
    isFolder: false,
    isRepository: true,
    shared: { ownerName: shared.ownerName, teamName: shared.teamName },
    startupScript: null,
    maintenance: { ...dto.maintenance, script: null },
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
