/**
 * Rose out of the box (rose-builds-rose PJ4): a Rose repo owner's project
 * list always carries a configured "Rose" project (owners: utils/roseRepoOwners).
 *
 *   GET /api/projects (repo owner) ─► planRoseProjectSetup(rows, connected)
 *        │ nothing to do (steady state) ─► list as-is, zero extra queries
 *        └ plan ─► applyRoseProjectSetup ─► re-list
 *
 * The plan fills in only what was never configured, so later edits stick:
 *   - no "Rose" project (by name,  → create it fully configured
 *     or by the Rose repo when renamed)
 *   - pristine (name-only) "Rose"  → set repo + startup script, declare the six
 *                                     env files (paths only, no values)
 *   - sync script never set (null)  → fill the default sync script (template sync;
 *                                     triggers stay off: they spend E2B compute)
 *   - startup script still exactly → replace it with the current default
 *     an earlier Rose default          (and a still-default 120 s timeout);
 *                                      an edited script is never touched
 *   - Rose repo, no GitHub grant   → grant clone access (same table the public
 *                                     auto-grant and slack-auto-rca write), only
 *                                     when the backend's GitHub token reaches it
 * Env-file VALUES are never produced here: they arrive only through codebase
 * sync from the owner's checkout (`scripts/rose-sync push --project Rose`).
 *
 * 10k-agent behaviour: non-owner accounts return before any query; an owner
 * pays one bounded write burst (and one GitHub API read) once, then nothing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { fetchGithubRepoVisibility, normalizeGithubUrl } from '../../providers/github';
import { createLogger } from '../../providers/logger';
import { isRoseRepoOwner } from '../../utils/roseRepoOwners';
import * as repo from './repo';
import { DEFAULT_MAINTENANCE_TIMEOUT_S, DEFAULT_STARTUP_TIMEOUT_S } from './types';
import type { ProjectWithCount } from './repo';

const log = createLogger('Projects');

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
/** The Rose project's template sync script (Andy's boxes Template maintenance script, adapted). */
export const ROSE_SYNC_SCRIPT_PATH = 'agents/benchmarks/fixtures/projects/rose-sync.sh';
/**
 * Earlier checked-in defaults, byte-exact. When the default changes, move the
 * old file here: projects still holding it exactly are upgraded on next list.
 */
export const ROSE_PREVIOUS_STARTUP_SCRIPTS_DIR =
  'agents/benchmarks/fixtures/projects/rose-startup-previous';
/**
 * A fresh E2B session installs the Rose dependency trees before the agent
 * starts (rose-startup.sh); a resumed one skips them in seconds.
 */
export const ROSE_PROJECT_STARTUP_TIMEOUT_S = 900;

export interface RoseSetupDeps {
  /** Accounts that get the Rose project (default: the explicit repo-owner list). */
  isOwner: (userId: string) => boolean;
  /** One GitHub API read: can the backend's GitHub token reach the repo? */
  repoReachable: () => Promise<boolean>;
}

export const DEFAULT_ROSE_SETUP: RoseSetupDeps = {
  isOwner: isRoseRepoOwner,
  repoReachable: async () =>
    ['public', 'private'].includes(await fetchGithubRepoVisibility('Rose-Ai-Labs', 'rose')),
};

/** Repo root: back-end/{src,dist}/domains/projects → ../../../.. */
const REPO_ROOT = resolve(__dirname, '../../../..');

export function roseStartupScript(): string {
  return readFileSync(resolve(REPO_ROOT, ROSE_STARTUP_SCRIPT_PATH), 'utf8');
}

let previousScripts: readonly string[] | null = null;

/** Every earlier Rose default script (read once; the fixtures never change at runtime). */
export function rosePreviousStartupScripts(): readonly string[] {
  if (previousScripts === null) {
    const dir = resolve(REPO_ROOT, ROSE_PREVIOUS_STARTUP_SCRIPTS_DIR);
    previousScripts = readdirSync(dir)
      .filter((name) => name.endsWith('.sh'))
      .sort()
      .map((name) => readFileSync(resolve(dir, name), 'utf8'));
  }
  return previousScripts;
}

export function roseSyncScript(): string {
  return readFileSync(resolve(REPO_ROOT, ROSE_SYNC_SCRIPT_PATH), 'utf8');
}

export interface RoseProjectPlan {
  createProject: boolean;
  /** Existing pristine project to fill in (null when creating or nothing to fill). */
  fillProjectId: string | null;
  /** Existing project whose script is still exactly an earlier Rose default. */
  upgradeScriptProjectId: string | null;
  /** Existing Rose project that never had a sync script (null column). */
  fillSyncScriptProjectId: string | null;
  grantRepo: boolean;
}

function isRoseRepo(repoUrl: string | null): boolean {
  return repoUrl !== null && normalizeGithubUrl(repoUrl) === ROSE_PROJECT_REPO_URL;
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

/** The Rose project by name, or by the Rose repo when it was renamed (never a second one). */
export function findRoseProject<T extends { name: string; repoUrl: string | null }>(
  rows: T[]
): T | undefined {
  return (
    rows.find((row) => row.name === ROSE_PROJECT_NAME) ??
    rows.find((row) => isRoseRepo(row.repoUrl))
  );
}

/** Pure: what the dev account still needs, from rows the list already read. */
export function planRoseProjectSetup(
  userId: string,
  rows: ProjectWithCount[],
  connectedRepoUrls: ReadonlySet<string>,
  isOwner: RoseSetupDeps['isOwner'] = DEFAULT_ROSE_SETUP.isOwner
): RoseProjectPlan | null {
  if (!isOwner(userId)) return null;
  const rose = findRoseProject(rows);
  if (!rose) {
    return {
      createProject: true,
      fillProjectId: null,
      upgradeScriptProjectId: null,
      fillSyncScriptProjectId: null,
      grantRepo: true,
    };
  }
  const fill = isPristine(rose);
  const upgrade =
    rose.startupScript !== null && rosePreviousStartupScripts().includes(rose.startupScript);
  const repoUrl = fill ? ROSE_PROJECT_REPO_URL : rose.repoUrl;
  const grantRepo = repoUrl !== null && isRoseRepo(repoUrl) && !connectedRepoUrls.has(repoUrl);
  const fillSync = !fill && rose.maintenanceScript === null && isRoseRepo(rose.repoUrl);
  if (!fill && !upgrade && !fillSync && !grantRepo) return null;
  return {
    createProject: false,
    fillProjectId: fill ? rose.id : null,
    upgradeScriptProjectId: upgrade ? rose.id : null,
    fillSyncScriptProjectId: fillSync ? rose.id : null,
    grantRepo,
  };
}

/**
 * Idempotent and race-safe: create-if-missing, fill-if-still-pristine,
 * upgrade-if-still-an-earlier-default, skip duplicates. Project settings and the declared env files commit together, so
 * a partial failure leaves the project pristine and the next list retries it.
 * The clone grant is written only when the backend's GitHub token can reach
 * the repository.
 */
export async function applyRoseProjectSetup(
  userId: string,
  plan: RoseProjectPlan,
  deps: RoseSetupDeps = DEFAULT_ROSE_SETUP
): Promise<void> {
  if (
    plan.createProject ||
    plan.fillProjectId !== null ||
    plan.upgradeScriptProjectId !== null ||
    plan.fillSyncScriptProjectId !== null
  ) {
    await repo.writeRoseProjectSetup(userId, {
      createProject: plan.createProject,
      fillProjectId: plan.fillProjectId,
      upgradeScriptProjectId: plan.upgradeScriptProjectId,
      fillSyncScriptProjectId: plan.fillSyncScriptProjectId,
      syncScript: roseSyncScript(),
      syncTimeoutS: DEFAULT_MAINTENANCE_TIMEOUT_S,
      name: ROSE_PROJECT_NAME,
      defaultBranch: ROSE_PROJECT_DEFAULT_BRANCH,
      repoUrl: ROSE_PROJECT_REPO_URL,
      startupScript: roseStartupScript(),
      previousStartupScripts: rosePreviousStartupScripts(),
      startupTimeoutS: ROSE_PROJECT_STARTUP_TIMEOUT_S,
      previousStartupTimeoutS: DEFAULT_STARTUP_TIMEOUT_S,
      envPaths: ROSE_PROJECT_ENV_FILES,
    });
  }
  if (plan.grantRepo) {
    if (!(await deps.repoReachable())) {
      log.warn('[Projects] Rose repo grant skipped: backend GitHub token cannot reach the repo', {
        userId,
        repoUrl: ROSE_PROJECT_REPO_URL,
      });
      return;
    }
    await repo.grantGithubRepoAccess(userId, ROSE_PROJECT_REPO_URL);
  }
}
