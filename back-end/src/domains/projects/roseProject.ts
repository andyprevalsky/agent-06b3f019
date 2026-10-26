/**
 * Rose out of the box (rose-builds-rose PJ4): a Rose dev account's project
 * list always carries a configured "Rose" project.
 *
 *   GET /api/projects (dev account) ─► planRoseProjectSetup(rows, connected)
 *        │ nothing to do (steady state) ─► list as-is, zero extra queries
 *        └ plan ─► applyRoseProjectSetup ─► re-list
 *
 * The plan fills in only what was never configured, so later edits stick:
 *   - no "Rose" project            → create it fully configured
 *   - pristine (name-only) "Rose"  → set repo + startup script, declare the six
 *                                     env files (paths only, no values)
 *   - Rose repo, no GitHub grant   → grant clone access (same table the public
 *                                     auto-grant and slack-auto-rca write)
 * Env-file VALUES are never produced here: they arrive only through codebase
 * sync from the owner's checkout (`scripts/rose-sync push --project Rose`).
 *
 * 10k-agent behaviour: non-dev accounts return before any query; a dev account
 * pays one bounded write burst once, then nothing per list.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { normalizeGithubUrl } from '../../providers/github';
import { prisma } from '../../providers/database';
import { newSyncSalt, type ProjectWithCount } from '../../providers/projects/store';
import { isRoseDevUser } from '../../utils/roseDevAccess';

export const ROSE_PROJECT_NAME = 'Rose';
export const ROSE_PROJECT_REPO_URL = 'https://github.com/Rose-Ai-Labs/rose';
export const ROSE_PROJECT_DEFAULT_BRANCH = 'main';
/** Same six files and startup script as `scripts/rose-sync seed-rose`. */
export const ROSE_PROJECT_ENV_FILES = [
  'agents/.env',
  'back-end/.env',
  'agents/.env.benchmark-temporal',
  'front-end/.env',
  'mac-app/.env',
  'research/.env',
] as const;
export const ROSE_STARTUP_SCRIPT_PATH = 'agents/benchmarks/fixtures/projects/rose-startup.sh';

/** Repo root: back-end/{src,dist}/domains/projects → ../../../.. */
const REPO_ROOT = resolve(__dirname, '../../../..');

export function roseStartupScript(): string {
  return readFileSync(resolve(REPO_ROOT, ROSE_STARTUP_SCRIPT_PATH), 'utf8');
}

export interface RoseProjectPlan {
  createProject: boolean;
  /** Existing pristine project to fill in (null when creating or nothing to fill). */
  fillProjectId: string | null;
  grantRepo: boolean;
}

/** A Rose project nobody has configured yet (as "+ New project" creates it). */
function isPristine(project: ProjectWithCount): boolean {
  return (
    project.repoUrl === null &&
    project.startupScript === null &&
    project._count.envFiles === 0 &&
    project.syncRevision === 0
  );
}

/** Pure: what the dev account still needs, from rows the list already read. */
export function planRoseProjectSetup(
  userId: string,
  rows: ProjectWithCount[],
  connectedRepoUrls: ReadonlySet<string>
): RoseProjectPlan | null {
  if (!isRoseDevUser(userId)) return null;
  const rose = rows.find((row) => row.name === ROSE_PROJECT_NAME);
  if (!rose) return { createProject: true, fillProjectId: null, grantRepo: true };
  const fill = isPristine(rose);
  const repoUrl = fill ? ROSE_PROJECT_REPO_URL : rose.repoUrl;
  const grantRepo =
    repoUrl !== null &&
    normalizeGithubUrl(repoUrl) === ROSE_PROJECT_REPO_URL &&
    !connectedRepoUrls.has(repoUrl);
  if (!fill && !grantRepo) return null;
  return { createProject: false, fillProjectId: fill ? rose.id : null, grantRepo };
}

async function declareEnvFiles(projectId: string): Promise<void> {
  await prisma.projectEnvFile.createMany({
    data: ROSE_PROJECT_ENV_FILES.map((path) => ({
      projectId,
      path,
      kind: 'env',
      source: 'declared',
    })),
    skipDuplicates: true,
  });
}

/** Idempotent and race-safe: create-if-missing, fill-if-still-pristine, skip duplicates. */
export async function applyRoseProjectSetup(userId: string, plan: RoseProjectPlan): Promise<void> {
  const settings = {
    repoUrl: ROSE_PROJECT_REPO_URL,
    startupScript: roseStartupScript(),
  };
  if (plan.createProject) {
    const project = await prisma.project.upsert({
      where: { userId_name: { userId, name: ROSE_PROJECT_NAME } },
      create: {
        userId,
        name: ROSE_PROJECT_NAME,
        defaultBranch: ROSE_PROJECT_DEFAULT_BRANCH,
        syncSalt: newSyncSalt(),
        ...settings,
      },
      update: {},
    });
    if (project.repoUrl === ROSE_PROJECT_REPO_URL) await declareEnvFiles(project.id);
  }
  if (plan.fillProjectId !== null) {
    // Conditional: a concurrent edit after the list read wins over the defaults.
    const filled = await prisma.project.updateMany({
      where: { id: plan.fillProjectId, userId, repoUrl: null, startupScript: null },
      data: settings,
    });
    if (filled.count === 1) await declareEnvFiles(plan.fillProjectId);
  }
  if (plan.grantRepo) {
    await prisma.githubRepoAccess.createMany({
      data: [{ userId, repoUrl: ROSE_PROJECT_REPO_URL }],
      skipDuplicates: true,
    });
  }
}
