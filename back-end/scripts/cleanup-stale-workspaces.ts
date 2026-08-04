#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Cleanup stale workspace resources (safe for pre-deploy).
 *
 * 1. Terminates Temporal workflows on queues belonging to archived Conductor workspaces
 * 2. Kills orphaned processes (backend, worker, frontend, etc.) from archived workspaces
 * 3. Stops orphaned Docker containers from archived workspaces
 *
 * Safety guarantees (allow-list — see archivedWorkspaceForQueue):
 * - ONLY terminates queues positively attributable to an archived Conductor
 *   workspace of this repository (`navi-agent-tasks-<archived-workspace>`)
 * - NEVER touches production, plain (`navi-agent-tasks`) or generation-scoped
 *   (`navi-agent-tasks@<surfaceHash>`)
 * - NEVER touches workflows or processes from active (non-archived) workspaces
 * - Unknown/unrecognized queues are KEPT, never terminated
 */

import { Connection, Client } from '@temporalio/client';
import { execFileSync, execSync } from 'child_process';
import { config } from 'dotenv';
import * as path from 'path';
import * as os from 'os';
import { isIsolatedBenchmarkResource } from '../src/utils/benchmarkResources';
import type { WorkflowTerminationClient } from '../src/providers/workflowReplacement';

config();

/**
 * Base production queue. Production workers actually poll a generation-scoped
 * variant, `${PROD_QUEUE}@<surfaceHash>` (agents/helpers/worker_generation.py),
 * so nothing here may assume the plain name is the only production queue.
 */
const PROD_QUEUE = 'navi-agent-tasks';
/** Conductor workspace queues, and ONLY these, are eligible for cleanup. */
const QUEUE_PREFIX = `${PROD_QUEUE}-`;
/** Mirrors GENERATION_QUEUE_SEPARATOR in agents/helpers/worker_generation.py. */
const GENERATION_QUEUE_SEPARATOR = '@';
const CONDUCTOR_DB = path.join(
  os.homedir(),
  'Library/Application Support/com.conductor.app/conductor.db'
);

// ── Resolve active workspaces from Conductor DB ──

export interface ActiveWorkspaces {
  /** Every identity that may own a queue or container. */
  resourceNames: Set<string>;
  /** directory_name — used in filesystem paths */
  directoryNames: Set<string>;
  /**
   * Identities of ARCHIVED workspaces. Cleanup is an allow-list over THIS set —
   * a resource is destroyed only when it can be attributed to one of these, so
   * anything unrecognized survives by construction.
   */
  archivedResourceNames: Set<string>;
  /** archived directory_name — used in filesystem paths */
  archivedDirectoryNames: Set<string>;
  repositoryId: string;
}

type ConductorQuery = (query: string) => string;

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function nonEmptyLines(result: string): string[] {
  return result
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function resolveActiveWorkspaces(
  workspaceName: string,
  queryConductor: ConductorQuery
): ActiveWorkspaces {
  const repositoryIds = new Set(
    nonEmptyLines(
      queryConductor(
        `SELECT DISTINCT repository_id FROM workspaces WHERE repository_id IS NOT NULL AND (directory_name = ${sqlLiteral(workspaceName)} OR secondary_directory_name = ${sqlLiteral(workspaceName)})`
      )
    )
  );

  if (repositoryIds.size === 0) {
    throw new Error(`Could not resolve a Conductor repository for workspace ${workspaceName}`);
  }
  if (repositoryIds.size > 1) {
    throw new Error(`Workspace ${workspaceName} matched multiple Conductor repositories`);
  }

  const repositoryId = [...repositoryIds][0];
  const rows = nonEmptyLines(
    queryConductor(
      `SELECT directory_name, COALESCE(secondary_directory_name, ''), state FROM workspaces WHERE repository_id = ${sqlLiteral(repositoryId)}`
    )
  );

  if (rows.length === 0) {
    throw new Error(`No active Conductor workspaces found for repository ${repositoryId}`);
  }

  const parsed = rows.map((row) => {
    const [directoryName, secondaryDirectoryName = '', state = '', ...extraColumns] =
      row.split('|');
    if (!directoryName || !state || extraColumns.length > 0) {
      throw new Error(`Malformed Conductor workspace identity row: ${row}`);
    }
    return {
      directoryName,
      identities: [directoryName, secondaryDirectoryName].filter(Boolean),
      archived: state === 'archived',
    };
  });

  const activeRows = parsed.filter((row) => !row.archived);
  const identityOwners = new Map<string, string>();
  for (const { directoryName, identities } of activeRows) {
    for (const identity of identities) {
      const existingOwner = identityOwners.get(identity);
      if (existingOwner && existingOwner !== directoryName) {
        throw new Error(
          `Active Conductor identity ${identity} is ambiguous between ${existingOwner} and ${directoryName}`
        );
      }
      identityOwners.set(identity, directoryName);
    }
  }

  const resourceNames = new Set(identityOwners.keys());
  const directoryNames = new Set(activeRows.map((row) => row.directoryName));

  if (directoryNames.size === 0 || resourceNames.size === 0) {
    throw new Error(
      `No active Conductor workspace identities found for repository ${repositoryId}`
    );
  }

  // ONE rule for both archived sets: any name an ACTIVE workspace claims is
  // never destroyable, even when an archived workspace claimed it too. Applying
  // it as a single predicate is what keeps the two sets from diverging — an
  // archived directory_name colliding with an active workspace's *secondary*
  // alias must not survive into the set killOrphanedProcesses SIGKILLs on.
  const archivedRows = parsed.filter((row) => row.archived);
  const destroyable = (name: string) => !resourceNames.has(name);
  const archivedResourceNames = new Set(
    archivedRows.flatMap((row) => row.identities).filter(destroyable)
  );
  const archivedDirectoryNames = new Set(
    archivedRows.map((row) => row.directoryName).filter(destroyable)
  );

  console.log(
    `Active workspace identities (${resourceNames.size}): ${[...resourceNames].join(', ')}`
  );
  console.log(
    `Archived workspace identities (${archivedResourceNames.size}) are eligible cleanup targets.`
  );
  return {
    resourceNames,
    directoryNames,
    archivedResourceNames,
    archivedDirectoryNames,
    repositoryId,
  };
}

function getActiveWorkspaces(): ActiveWorkspaces {
  const workspaceName =
    process.env.CONDUCTOR_WORKSPACE_NAME ||
    path.basename(execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim());

  return resolveActiveWorkspaces(workspaceName, (query) =>
    execFileSync('sqlite3', [CONDUCTOR_DB, query], { encoding: 'utf-8' }).trim()
  );
}

// ── Temporal workflow cleanup ──

/**
 * Decorations a workspace queue may carry after its identity. Each must be
 * recognized EXPLICITLY — an unrecognized decoration means we cannot attribute
 * the queue, so it is kept.
 *
 * - `@<generationHash>`: worker-generation suffix (agents/helpers/worker_generation.py)
 * - `-deploy-<utcTimestamp>-<pid>`: per-deploy semantic lane (scripts/lib/deploy-local-env.sh)
 */
const GENERATION_SUFFIX = /@[^@]+$/;
const DEPLOY_LANE_SUFFIX = /-deploy-\d{8,}-\d+$/;

/**
 * Shared infrastructure queues that are never owned by a Conductor workspace,
 * even when a workspace identity collides with the name.
 *
 * `navi-agent-tasks-test` is the checked-in default TEMPORAL_TASK_QUEUE in both
 * `agents/.env` and `back-end/.env`, and the e2e helpers' default — so it is
 * shared infrastructure regardless of which workspace names happen to exist
 * today. (At the time of the incident it also collided with an archived
 * workspace's secondary alias "test", and carried 326 running workflows.)
 */
const RESERVED_QUEUES = new Set([`${QUEUE_PREFIX}test`]);

/**
 * The single terminate/keep decision. Returns the archived workspace that owns
 * `queue`, or null to keep the workflow.
 *
 * INVARIANT: this is an allow-list — a workflow is terminated only when its
 * queue is positively attributable to an archived Conductor workspace, so
 * anything unrecognized survives by construction. Any future queue-naming
 * change must fail toward keeping workflows alive. The deny-list this replaced
 * ("unknown queue — terminate") became a production kill-switch as soon as prod
 * workers moved to generation-scoped queues; see
 * docs/rca/cases/2026-08-03-deploy-cleanup-denylist-terminated-generation-scoped-prod-queues.md
 */
export function archivedWorkspaceForQueue(
  queue: string,
  workspaces: Pick<ActiveWorkspaces, 'archivedResourceNames'>
): string | null {
  // Prod (`navi-agent-tasks`), generation-scoped prod (`navi-agent-tasks@<hash>`),
  // and every foreign queue fail this check and are kept.
  if (!queue.startsWith(QUEUE_PREFIX)) return null;
  if (RESERVED_QUEUES.has(queue)) return null;

  // Isolated benchmarks own their queue and DB lifetime through benchmarks/local.py.
  // They are intentionally absent from Conductor's workspace registry.
  if (isIsolatedBenchmarkResource(queue)) return null;

  // The identity must match EXACTLY, after stripping only decorations we model —
  // treating "whatever follows the prefix" as a workspace name is what let an
  // active workspace's in-flight deploy lane be misread as an archived workspace.
  const rest = queue.slice(QUEUE_PREFIX.length);
  const withoutGeneration = rest.replace(GENERATION_SUFFIX, '');
  for (const candidate of new Set([
    rest,
    withoutGeneration,
    rest.replace(DEPLOY_LANE_SUFFIX, ''),
    withoutGeneration.replace(DEPLOY_LANE_SUFFIX, ''),
  ])) {
    if (candidate && workspaces.archivedResourceNames.has(candidate)) return candidate;
  }

  return null;
}

/**
 * Last line of defense before any terminate. The incident this file exists to
 * prevent was a classifier that misread a production queue; if a future change
 * ever reintroduces that, abort the whole run loudly instead of destroying prod.
 */
function assertNotProduction(queue: string): void {
  const base = queue.split(GENERATION_QUEUE_SEPARATOR)[0];
  if (base === PROD_QUEUE) {
    throw new Error(
      `Refusing to terminate workflows on production queue "${queue}". This is a cleanup classifier bug — fix archivedWorkspaceForQueue.`
    );
  }
}

/** The subset of the Temporal client this cleanup needs — injectable for tests. */
export interface CleanupWorkflowClient {
  workflow: WorkflowTerminationClient & {
    list(options: { query: string }): AsyncIterable<{
      workflowId: string;
      runId?: string;
      taskQueue?: string;
    }>;
  };
}

export async function terminateStaleWorkflowsWithClient(
  client: CleanupWorkflowClient,
  workspaces: Pick<ActiveWorkspaces, 'archivedResourceNames'>,
  options: { dryRun?: boolean } = {}
): Promise<{ terminated: number; skipped: number }> {
  let skipped = 0;
  const targets: Array<{ workflowId: string; runId?: string; queue: string }> = [];
  const staleQueues = new Map<string, number>();

  // Classify EVERYTHING before destroying anything, so assertNotProduction below
  // is a gate rather than a tripwire that fires only after some workflows have
  // already been terminated. Only matched workflows are buffered, so this stays
  // bounded by the archived-workspace target set, not by the namespace size.
  for await (const wf of client.workflow.list({ query: 'ExecutionStatus="Running"' })) {
    const queue = wf.taskQueue || '';
    if (!archivedWorkspaceForQueue(queue, workspaces)) {
      skipped++;
      continue;
    }
    targets.push({ workflowId: wf.workflowId, runId: wf.runId, queue });
    staleQueues.set(queue, (staleQueues.get(queue) || 0) + 1);
  }

  for (const { queue } of targets) assertNotProduction(queue);

  if (staleQueues.size > 0) {
    console.log(
      options.dryRun
        ? 'Stale workspace queues (dry run, nothing terminated):'
        : 'Stale workspace queues to terminate:'
    );
    for (const [queue, count] of staleQueues) {
      console.log(`  ${queue}: ${count} workflow(s)`);
    }
  }

  if (options.dryRun) return { terminated: targets.length, skipped };

  let terminated = 0;
  for (const { workflowId, runId } of targets) {
    try {
      await client.workflow
        .getHandle(workflowId, runId)
        .terminate('Deploy cleanup: stale workspace workflow');
      terminated++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('not found') && !msg.includes('already completed')) {
        console.log(`  Failed to terminate ${workflowId}: ${msg}`);
      }
    }
  }

  return { terminated, skipped };
}

async function terminateStaleWorkflows(
  workspaces: Pick<ActiveWorkspaces, 'archivedResourceNames'>,
  options: { dryRun?: boolean }
): Promise<{ terminated: number; skipped: number }> {
  const apiKey = process.env.TEMPORAL_API_KEY;
  if (!apiKey) {
    console.log('TEMPORAL_API_KEY not set, skipping Temporal cleanup');
    return { terminated: 0, skipped: 0 };
  }

  // No default: this script TERMINATES workflows, and a wrong namespace guess
  // would aim that at the wrong cluster. The repo's namespace lives in .env.
  const namespace = process.env.TEMPORAL_NAMESPACE;
  if (!namespace) {
    console.log('TEMPORAL_NAMESPACE not set, skipping Temporal cleanup');
    return { terminated: 0, skipped: 0 };
  }

  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS || 'us-east-1.aws.api.temporal.io:7233',
    tls: true,
    apiKey,
  });
  const client = new Client({ connection, namespace });

  try {
    return await terminateStaleWorkflowsWithClient(client, workspaces, options);
  } finally {
    await connection.close();
  }
}

// ── Orphaned process cleanup ──

/**
 * Same allow-list rule as the workflow cleanup: a process or container is
 * destroyed only when its owning workspace is a KNOWN ARCHIVED workspace.
 * "Not in the active set" is not good enough — an unregistered or
 * newly-created worktree is unrecognized, not abandoned.
 */
function killOrphanedProcesses(
  archivedDirectoryNames: Set<string>,
  archivedResourceNames: Set<string>,
  dryRun: boolean
): number {
  const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  const workspacesBase = path.dirname(repoRoot);
  const repoDir = path.basename(workspacesBase);

  let psOutput: string;
  try {
    psOutput = execSync('ps axo pid=,command=', { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  } catch {
    console.log('Could not list processes');
    return 0;
  }

  let killed = 0;
  // Match processes containing a workspace path like conductor/workspaces/{repo}/{workspace}/
  const workspacePathRe = new RegExp(`conductor/workspaces/${repoDir}/([^/]+)/`);

  for (const line of psOutput.split('\n')) {
    const match = line.match(workspacePathRe);
    if (!match) continue;

    const workspaceDirName = match[1];
    if (!archivedDirectoryNames.has(workspaceDirName)) continue;

    const pid = Number(line.trim().split(/\s+/)[0]);
    if (!pid || pid === process.pid) continue;

    // Skip Docker daemon
    if (/docker/i.test(line) && !/node|python|tsx|vite/i.test(line)) continue;

    if (dryRun) {
      console.log(`  Would kill PID ${pid} (workspace: ${workspaceDirName})`);
      killed++;
      continue;
    }

    try {
      process.kill(pid, 'SIGKILL');
      console.log(`  Killed PID ${pid} (workspace: ${workspaceDirName})`);
      killed++;
    } catch {
      // Already gone
    }
  }

  // Stop Docker containers from archived workspaces
  try {
    const containers = execSync('docker ps --format "{{.Names}}"', { encoding: 'utf-8' }).trim();
    for (const name of containers.split('\n').filter(Boolean)) {
      if (isIsolatedBenchmarkResource(name)) continue;
      const containerMatch = name.match(/^victoria-db-(.+)$/);
      if (containerMatch && archivedResourceNames.has(containerMatch[1])) {
        console.log(`  ${dryRun ? 'Would stop' : 'Stopping'} orphaned container: ${name}`);
        if (!dryRun) execSync(`docker stop "${name}" 2>/dev/null || true`);
        killed++;
      }
    }
  } catch {
    // Docker not available
  }

  return killed;
}

// ── Main ──

export async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(
    dryRun
      ? 'Cleaning up stale workspace resources (DRY RUN — nothing will be destroyed)...\n'
      : 'Cleaning up stale workspace resources...\n'
  );

  const { archivedResourceNames, archivedDirectoryNames } = getActiveWorkspaces();

  // Sequential on purpose: killOrphanedProcesses is fully synchronous (execSync),
  // so wrapping it in Promise.all bought the appearance of concurrency, not any.
  const processesKilled = killOrphanedProcesses(
    archivedDirectoryNames,
    archivedResourceNames,
    dryRun
  );
  const temporalResult = await terminateStaleWorkflows({ archivedResourceNames }, { dryRun });

  const wouldOr = (verb: string) => (dryRun ? `that WOULD be ${verb}` : verb);
  console.log('\n' + '='.repeat(50));
  console.log('Cleanup summary:');
  console.log(`  Temporal workflows ${wouldOr('terminated')}: ${temporalResult.terminated}`);
  console.log(`  Temporal workflows kept (active/prod/unrecognized): ${temporalResult.skipped}`);
  console.log(`  Orphaned processes/containers ${wouldOr('killed')}: ${processesKilled}`);
  console.log('='.repeat(50));

  if (temporalResult.terminated === 0 && processesKilled === 0) {
    console.log('\nNothing to clean up.');
  }
}

if (require.main === module) {
  void main().catch((e) => {
    console.error('Cleanup failed:', e);
    process.exit(1);
  });
}
