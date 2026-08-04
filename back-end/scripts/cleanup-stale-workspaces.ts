#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Cleanup stale workspace resources (safe for pre-deploy).
 *
 * 1. Terminates Temporal workflows on queues belonging to archived Conductor workspaces
 * 2. Kills orphaned processes (backend, worker, frontend, etc.) from archived workspaces
 * 3. Stops orphaned Docker containers from archived workspaces
 *
 * Safety guarantees:
 * - NEVER touches the prod queue (navi-agent-tasks)
 * - NEVER touches workflows or processes from active (non-archived) workspaces
 * - Unknown queues (no matching workspace) are treated as stale and terminated
 */

import { Connection, Client } from '@temporalio/client';
import { execFileSync, execSync } from 'child_process';
import { config } from 'dotenv';
import * as path from 'path';
import * as os from 'os';
import { isIsolatedBenchmarkResource } from '../src/utils/benchmarkResources';
import { QUEUE_PREFIX, baseTaskQueue, classifyCleanupQueue } from '../src/utils/staleWorkflowQueue';

config();

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
      `SELECT directory_name, COALESCE(secondary_directory_name, '') FROM workspaces WHERE state != 'archived' AND repository_id = ${sqlLiteral(repositoryId)}`
    )
  );

  if (rows.length === 0) {
    throw new Error(`No active Conductor workspaces found for repository ${repositoryId}`);
  }

  const resourceNames = new Set<string>();
  const directoryNames = new Set<string>();
  const identityOwners = new Map<string, string>();

  const addIdentity = (identity: string, directoryName: string) => {
    if (!identity) return;
    const existingOwner = identityOwners.get(identity);
    if (existingOwner && existingOwner !== directoryName) {
      throw new Error(
        `Active Conductor identity ${identity} is ambiguous between ${existingOwner} and ${directoryName}`
      );
    }
    identityOwners.set(identity, directoryName);
    resourceNames.add(identity);
  };

  for (const row of rows) {
    const [directoryName, secondaryDirectoryName = '', ...extraColumns] = row.split('|');
    if (!directoryName || extraColumns.length > 0) {
      throw new Error(`Malformed active Conductor workspace identity row: ${row}`);
    }
    directoryNames.add(directoryName);
    addIdentity(directoryName, directoryName);
    addIdentity(secondaryDirectoryName, directoryName);
  }

  if (directoryNames.size === 0 || resourceNames.size === 0) {
    throw new Error(
      `No active Conductor workspace identities found for repository ${repositoryId}`
    );
  }

  console.log(
    `Active workspace identities (${resourceNames.size}): ${[...resourceNames].join(', ')}`
  );
  return { resourceNames, directoryNames, repositoryId };
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

async function terminateStaleWorkflows(
  activeNames: Set<string>
): Promise<{ terminated: number; skipped: number }> {
  const apiKey = process.env.TEMPORAL_API_KEY;
  if (!apiKey) {
    console.log('TEMPORAL_API_KEY not set, skipping Temporal cleanup');
    return { terminated: 0, skipped: 0 };
  }

  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS || 'us-east-1.aws.api.temporal.io:7233',
    tls: true,
    apiKey,
  });
  const client = new Client({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE || 'quickstart-navi.lqjlv',
  });

  const workflows = client.workflow.list({
    query: 'ExecutionStatus="Running"',
  });

  let terminated = 0;
  let skipped = 0;
  const staleQueues = new Map<string, number>();

  for await (const wf of workflows) {
    const queue = wf.taskQueue || '';
    const decision = classifyCleanupQueue(queue, activeNames);

    if (decision !== 'terminate') {
      skipped++;
      continue;
    }

    // Stale-but-recognized workspace queues are logged for visibility. Key by
    // the base queue so multiple build IDs of one stale workspace aggregate.
    const baseQueue = baseTaskQueue(queue);
    if (baseQueue.startsWith(QUEUE_PREFIX)) {
      staleQueues.set(baseQueue, (staleQueues.get(baseQueue) || 0) + 1);
    }

    // Stale or unknown — terminate
    try {
      const handle = client.workflow.getHandle(wf.workflowId, wf.runId);
      await handle.terminate('Deploy cleanup: stale workspace workflow');
      terminated++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('not found') && !msg.includes('already completed')) {
        console.log(`  Failed to terminate ${wf.workflowId}: ${msg}`);
      }
    }
  }

  if (staleQueues.size > 0) {
    console.log('Stale queues terminated:');
    for (const [queue, count] of staleQueues) {
      console.log(`  ${queue}: ${count} workflow(s)`);
    }
  }

  await connection.close();
  return { terminated, skipped };
}

// ── Orphaned process cleanup ──

function killOrphanedProcesses(
  activeDirectoryNames: Set<string>,
  activeResourceNames: Set<string>
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
    if (activeDirectoryNames.has(workspaceDirName)) continue;

    const pid = Number(line.trim().split(/\s+/)[0]);
    if (!pid || pid === process.pid) continue;

    // Skip Docker daemon
    if (/docker/i.test(line) && !/node|python|tsx|vite/i.test(line)) continue;

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
      if (containerMatch && !activeResourceNames.has(containerMatch[1])) {
        console.log(`  Stopping orphaned container: ${name}`);
        execSync(`docker stop "${name}" 2>/dev/null || true`);
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
  console.log('Cleaning up stale workspace resources...\n');

  const { resourceNames, directoryNames } = getActiveWorkspaces();

  const [temporalResult, processesKilled] = await Promise.all([
    terminateStaleWorkflows(resourceNames),
    Promise.resolve(killOrphanedProcesses(directoryNames, resourceNames)),
  ]);

  console.log('\n' + '='.repeat(50));
  console.log('Cleanup summary:');
  console.log(`  Temporal workflows terminated: ${temporalResult.terminated}`);
  console.log(`  Temporal workflows kept (active/prod): ${temporalResult.skipped}`);
  console.log(`  Orphaned processes/containers killed: ${processesKilled}`);
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
