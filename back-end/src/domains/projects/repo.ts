import type { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { newSyncSalt } from '../../providers/projects/store';

export {
  claimSyncRevision,
  countEnvFiles,
  createProject,
  deleteEnvFile,
  deleteEnvFilesByPath,
  deleteProject,
  findEnvFile,
  findEnvFileById,
  findGithubConnectedRepoUrls,
  findProject,
  findProjectByName,
  findSyncSnapshot,
  listEnvFiles,
  listProjects,
  updateProject,
  upsertEnvFile,
  userExists,
  writeSyncSnapshot,
  type EnvFileWrite,
  type ProjectEnvFileRecord,
  type ProjectRecord,
  type ProjectWithCount,
} from '../../providers/projects/store';

/** Settings the Rose project setup writes (domains/projects/roseProject.ts). */
export interface RoseProjectSetupWrite {
  createProject: boolean;
  fillProjectId: string | null;
  name: string;
  defaultBranch: string;
  repoUrl: string;
  startupScript: string;
  envPaths: readonly string[];
}

async function declareEnvFiles(
  tx: Prisma.TransactionClient,
  projectId: string,
  paths: readonly string[]
): Promise<void> {
  await tx.projectEnvFile.createMany({
    data: paths.map((path) => ({ projectId, path, kind: 'env', source: 'declared' })),
    skipDuplicates: true,
  });
}

/**
 * One transaction: create-if-missing (upsert by name) or fill-if-still-pristine
 * (conditional update), plus the declared env files, so a partial failure
 * leaves the project pristine and the next list retries it.
 */
export async function writeRoseProjectSetup(
  userId: string,
  write: RoseProjectSetupWrite
): Promise<void> {
  const settings = { repoUrl: write.repoUrl, startupScript: write.startupScript };
  await runTransactionWithRetry(async (tx) => {
    if (write.createProject) {
      const project = await tx.project.upsert({
        where: { userId_name: { userId, name: write.name } },
        create: {
          userId,
          name: write.name,
          defaultBranch: write.defaultBranch,
          syncSalt: newSyncSalt(),
          ...settings,
        },
        update: {},
      });
      if (project.repoUrl === write.repoUrl) await declareEnvFiles(tx, project.id, write.envPaths);
    }
    if (write.fillProjectId !== null) {
      // Conditional on the planner's whole pristine predicate (roseProject.ts
      // isPristine): an edit, env file or accepted sync after the list read
      // wins over the defaults.
      const filled = await tx.project.updateMany({
        where: {
          id: write.fillProjectId,
          userId,
          repoUrl: null,
          startupScript: null,
          syncRevision: 0,
          envFiles: { none: {} },
        },
        data: settings,
      });
      if (filled.count === 1) await declareEnvFiles(tx, write.fillProjectId, write.envPaths);
    }
  });
}

/** Idempotent GithubRepoAccess grant (skip duplicates). */
export async function grantGithubRepoAccess(userId: string, repoUrl: string): Promise<void> {
  await prisma.githubRepoAccess.createMany({
    data: [{ userId, repoUrl }],
    skipDuplicates: true,
  });
}

/** Indexed one-level folder CRUD; service checks the owning project first. */
export function listFolders(projectId: string) {
  return prisma.projectFolder.findMany({ where: { projectId }, orderBy: { name: 'asc' } });
}
export function createFolder(projectId: string, name: string) {
  return prisma.projectFolder.create({ data: { projectId, name } });
}
export function renameFolder(projectId: string, id: string, name: string) {
  return prisma.projectFolder.updateMany({ where: { id, projectId }, data: { name } });
}
export function deleteFolder(projectId: string, id: string) {
  return prisma.projectFolder.deleteMany({ where: { id, projectId } });
}
