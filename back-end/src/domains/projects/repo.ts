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
  /** Replace the script only while it is still exactly one of previousStartupScripts. */
  upgradeScriptProjectId: string | null;
  name: string;
  defaultBranch: string;
  repoUrl: string;
  startupScript: string;
  previousStartupScripts: readonly string[];
  /** Written on create; on fill/upgrade only over a still-default previousStartupTimeoutS. */
  startupTimeoutS: number;
  previousStartupTimeoutS: number;
  envPaths: readonly string[];
}

/** The Rose timeout, only where the timeout was never changed from the old default. */
async function upgradeDefaultTimeout(
  tx: Prisma.TransactionClient,
  userId: string,
  projectId: string,
  write: RoseProjectSetupWrite
): Promise<void> {
  await tx.project.updateMany({
    where: { id: projectId, userId, startupTimeoutS: write.previousStartupTimeoutS },
    data: { startupTimeoutS: write.startupTimeoutS },
  });
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
 * One transaction: create-if-missing (upsert by name), fill-if-still-pristine
 * or upgrade-if-still-an-earlier-default (conditional updates), plus the
 * declared env files, so a partial failure leaves the project as it was and
 * the next list retries it.
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
          startupTimeoutS: write.startupTimeoutS,
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
      if (filled.count === 1) {
        await declareEnvFiles(tx, write.fillProjectId, write.envPaths);
        await upgradeDefaultTimeout(tx, userId, write.fillProjectId, write);
      }
    }
    if (write.upgradeScriptProjectId !== null && write.previousStartupScripts.length > 0) {
      // Conditional on the exact earlier default: a script the user edited
      // after the list read (or ever) is never overwritten.
      const upgraded = await tx.project.updateMany({
        where: {
          id: write.upgradeScriptProjectId,
          userId,
          startupScript: { in: [...write.previousStartupScripts] },
        },
        data: { startupScript: write.startupScript },
      });
      if (upgraded.count === 1) {
        await upgradeDefaultTimeout(tx, userId, write.upgradeScriptProjectId, write);
      }
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
