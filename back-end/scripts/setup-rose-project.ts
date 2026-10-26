#!/usr/bin/env tsx
/**
 * Set up a Rose dev account's "Rose" project now, with the same planner and
 * writes GET /api/projects runs (src/domains/projects/roseProject.ts).
 *
 *   npx tsx scripts/setup-rose-project.ts --user <userId>           dry run (READ ONLY)
 *   npx tsx scripts/setup-rose-project.ts --user <userId> --apply   apply, then re-plan
 *
 * The dry run reads inside one READ ONLY transaction and prints the plan; it
 * cannot write. --apply is idempotent: a second run plans nothing. Prints ids,
 * paths and flags only — never env-file values (none are written here).
 * Uses DATABASE_URL from back-end/.env, which is PRODUCTION on dev machines.
 */
import 'dotenv/config';
import { prisma } from '../src/providers/database';
import { normalizeGithubUrl } from '../src/providers/github';
import { PROJECT_LIST_LIMIT } from '../src/providers/projects/store';
import {
  ROSE_PROJECT_ENV_FILES,
  ROSE_PROJECT_REPO_URL,
  applyRoseProjectSetup,
  findRoseProject,
  planRoseProjectSetup,
  roseStartupScript,
} from '../src/domains/projects/roseProject';
import { isRoseDevUser } from '../src/utils/roseDevAccess';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function readPlan(userId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const rows = await tx.project.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      take: PROJECT_LIST_LIMIT,
      include: { _count: { select: { envFiles: true } } },
    });
    const urls = rows.flatMap((row) => {
      const url = row.repoUrl === null ? null : normalizeGithubUrl(row.repoUrl);
      return url === null ? [] : [url];
    });
    const grants = await tx.githubRepoAccess.findMany({
      where: { userId, repoUrl: { in: urls } },
      select: { repoUrl: true },
    });
    const granted = new Set(grants.map((g) => g.repoUrl));
    const connected = new Set(
      rows.flatMap((row) => {
        const url = row.repoUrl === null ? null : normalizeGithubUrl(row.repoUrl);
        return row.repoUrl !== null && url !== null && granted.has(url) ? [row.repoUrl] : [];
      })
    );
    const rose = findRoseProject(rows) ?? null;
    const envPaths = rose
      ? (
          await tx.projectEnvFile.findMany({
            where: { projectId: rose.id },
            select: { path: true },
          })
        ).map((f) => f.path)
      : [];
    const [{ transaction_read_only: readOnly }] = await tx.$queryRawUnsafe<
      { transaction_read_only: string }[]
    >('SHOW transaction_read_only');
    return {
      readOnly,
      plan: planRoseProjectSetup(userId, rows, connected),
      current: rose && {
        id: rose.id,
        repoUrl: rose.repoUrl,
        defaultBranch: rose.defaultBranch,
        startupScriptSet: rose.startupScript !== null,
        startupTimeoutS: rose.startupTimeoutS,
        syncRevision: rose.syncRevision,
        envFiles: envPaths,
        githubConnected: rose.repoUrl !== null && connected.has(rose.repoUrl),
      },
    };
  });
}

async function main(): Promise<number> {
  const userId = arg('--user');
  if (!userId) {
    console.error('usage: setup-rose-project.ts --user <userId> [--apply]');
    return 2;
  }
  if (!isRoseDevUser(userId)) {
    console.error(`${userId} is not a Rose dev account; nothing to set up`);
    return 2;
  }
  const before = await readPlan(userId);
  const target = {
    repoUrl: ROSE_PROJECT_REPO_URL,
    defaultBranch: 'main',
    startupScriptBytes: Buffer.byteLength(roseStartupScript()),
    envFiles: ROSE_PROJECT_ENV_FILES,
  };
  console.log(JSON.stringify({ mode: 'dry-run', ...before, target }, null, 2));
  if (!process.argv.includes('--apply') || before.plan === null) return 0;
  await applyRoseProjectSetup(userId, before.plan);
  const after = await readPlan(userId);
  console.log(JSON.stringify({ mode: 'applied', ...after }, null, 2));
  return after.plan === null ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
