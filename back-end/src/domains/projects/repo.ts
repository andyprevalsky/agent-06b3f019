import { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { folderOrderBy, newSyncSalt } from '../../providers/projects/store';

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
  return prisma.projectFolder.findMany({ where: { projectId }, orderBy: folderOrderBy });
}

export class FolderProjectMissingError extends Error {}

/** Serialize membership and order changes on just this project, before reading folders. */
function writeFolders<T>(projectId: string, write: (tx: Prisma.TransactionClient) => Promise<T>) {
  return runTransactionWithRetry(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE
    `;
    if (rows.length === 0) throw new FolderProjectMissingError();
    return write(tx);
  });
}

export function createFolder(projectId: string, name: string) {
  return writeFolders(projectId, async (tx) => {
    const last = await tx.projectFolder.aggregate({
      where: { projectId },
      _max: { sortOrder: true },
    });
    return tx.projectFolder.create({
      data: { projectId, name, sortOrder: (last._max.sortOrder ?? -1) + 1 },
    });
  });
}
export function renameFolder(projectId: string, id: string, name: string) {
  return writeFolders(projectId, async (tx) => {
    const result = await tx.projectFolder.updateMany({ where: { id, projectId }, data: { name } });
    return result.count === 0 ? null : tx.projectFolder.findUniqueOrThrow({ where: { id } });
  });
}
export function deleteFolder(projectId: string, id: string) {
  return writeFolders(projectId, (tx) => tx.projectFolder.deleteMany({ where: { id, projectId } }));
}

/** Exact membership is checked after the lock; stale clients cannot partially reorder. */
export function reorderFolders(projectId: string, folderIds: string[]) {
  return writeFolders(projectId, async (tx) => {
    const current = await tx.projectFolder.findMany({ where: { projectId }, select: { id: true } });
    const desired = new Set(folderIds);
    if (current.length !== folderIds.length || current.some((folder) => !desired.has(folder.id))) {
      return null;
    }
    await tx.$executeRaw`
      UPDATE "ProjectFolder" AS folder SET "sortOrder" = ranks.position
      FROM (VALUES ${Prisma.join(folderIds.map((id, position) => Prisma.sql`(${id}, ${position}::integer)`))})
        AS ranks(id, position)
      WHERE folder.id = ranks.id AND folder."projectId" = ${projectId}
    `;
    return tx.projectFolder.findMany({ where: { projectId }, orderBy: folderOrderBy });
  });
}
