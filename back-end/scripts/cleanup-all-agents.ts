#!/usr/bin/env tsx

/**
 * Cleanup Script: Delete All Agents, Terminate Workflows, Clear Blueprints, and Attention Requests
 *
 * Scoped to THE CURRENT WORKTREE, but covers every stack it has:
 *   - The stack recorded in .context/services.json (docker container or system Postgres)
 *   - The victoria-db-<worktree-basename> container. Stopped containers are
 *     started, cleaned, and stopped again. (CONDUCTOR_WORKSPACE_NAME is
 *     deliberately ignored — it leaks across worktrees.)
 *   - env DATABASE_URL, only when it points at localhost. Remote/shared DBs
 *     (e.g. Supabase) are skipped unless CLEANUP_REMOTE_DB=1.
 *
 * Per database, this script will:
 * 1. Find all active (non-deleted) agents
 * 2. Archive goals from other users to GoalHistory table
 * 3. Terminate their Temporal workflows
 * 4. Soft-delete them from the database
 * 5. Find all soft-deleted agents and hard-delete them
 * 6. Clear all blueprints from the knowledge base
 * 7. Clear all attention requests
 *
 * Before touching any database it kills Python workers whose cwd is inside
 * this worktree (other worktrees' workers are left alone).
 *
 * Set MY_USER_ID environment variable to skip archiving your own agents' goals.
 */

import { PrismaClient, Prisma } from '@prisma/client';
import type { Client as TemporalClient } from '@temporalio/client';
import { getTemporalClient } from '../src/providers/temporal';
import * as dotenv from 'dotenv';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import pLimit from 'p-limit';

dotenv.config();

const MY_USER_ID = process.env.MY_USER_ID || '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const WORKTREE_ROOT = path.resolve(__dirname, '..', '..');

interface DbTarget {
  label: string;
  url: string;
  /** Container we started just for this cleanup — stop it again when done */
  stopContainerAfter?: string;
}

interface CleanupStats {
  archivedCount: number;
  failedArchiveCount: number;
  activeCount: number;
  softDeletedCount: number;
  softDeleteFailCount: number;
  hardDeletedCount: number;
  hardDeleteFailCount: number;
  skippedHardDeleteCount: number;
  blueprintsClearedCount: number;
  attentionClearedCount: number;
  cleanupFailures: number;
}

function emptyStats(): CleanupStats {
  return {
    archivedCount: 0,
    failedArchiveCount: 0,
    activeCount: 0,
    softDeletedCount: 0,
    softDeleteFailCount: 0,
    hardDeletedCount: 0,
    hardDeleteFailCount: 0,
    skippedHardDeleteCount: 0,
    blueprintsClearedCount: 0,
    attentionClearedCount: 0,
    cleanupFailures: 0,
  };
}

function totalFailures(stats: CleanupStats): number {
  return (
    stats.softDeleteFailCount +
    stats.hardDeleteFailCount +
    stats.failedArchiveCount +
    stats.cleanupFailures
  );
}

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8' }).trim();
}

/** Kill Python workers whose cwd is inside this worktree (leave other worktrees alone) */
async function killThisWorktreeWorkers() {
  console.log(`🔪 Killing Python workers running from ${WORKTREE_ROOT}...\n`);

  try {
    const pids = sh('pgrep -f "python worker.py" || true')
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean);

    let killed = 0;
    for (const pid of pids) {
      let cwd = '';
      try {
        cwd = sh(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1`);
      } catch {
        continue; // process already gone or unreadable
      }
      if (cwd === WORKTREE_ROOT || cwd.startsWith(WORKTREE_ROOT + path.sep)) {
        console.log(`📍 Killing worker PID ${pid} (cwd: ${cwd})`);
        try {
          execSync(`kill -9 ${pid}`);
          killed++;
        } catch {
          // already exited between pgrep and kill
        }
      }
    }
    console.log(killed > 0 ? `✅ Killed ${killed} worker(s)\n` : '✅ No workers running\n');
  } catch (error: any) {
    console.log('⚠️  Error checking/killing workers:', error.message);
    console.log('⚠️  Continuing with cleanup...\n');
  }
}

function isLocalUrl(url: string): boolean {
  return url.includes('localhost') || url.includes('127.0.0.1');
}

function containerState(name: string): 'running' | 'stopped' | 'absent' {
  try {
    const state = sh(`docker inspect --format '{{.State.Running}}' ${JSON.stringify(name)}`);
    return state === 'true' ? 'running' : 'stopped';
  } catch {
    return 'absent';
  }
}

function containerHostPort(name: string): string | null {
  try {
    const portLine = sh(`docker port ${JSON.stringify(name)} 5432/tcp`)
      .split('\n')[0]
      .trim();
    const port = portLine.split(':').pop();
    return port && /^\d+$/.test(port) ? port : null;
  } catch {
    return null;
  }
}

function waitForContainerPg(name: string): boolean {
  for (let i = 0; i < 30; i++) {
    try {
      execSync(`docker exec ${JSON.stringify(name)} pg_isready -U postgres -q`, {
        stdio: 'ignore',
      });
      return true;
    } catch {
      execSync('sleep 1');
    }
  }
  return false;
}

interface ServicesManifest {
  database?: { container?: string; use_system_postgres?: boolean; runtime_port?: number };
  ports?: { local_db?: number };
}

function readServicesManifest(): ServicesManifest | null {
  const manifestPath = path.join(WORKTREE_ROOT, '.context', 'services.json');
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Every database belonging to THIS worktree. Local stacks all use the same
 * credentials (postgres:postgres, db "victoria") — see scripts/setup-db.sh
 * and scripts/run.sh at the repo root.
 */
function discoverDbTargets(): DbTarget[] {
  const targets: DbTarget[] = [];
  const seenUrls = new Set<string>();

  const addTarget = (target: DbTarget) => {
    const key = target.url.replace(/^postgresql:/, 'postgres:').replace(/\/+$/, '');
    if (seenUrls.has(key)) return;
    seenUrls.add(key);
    targets.push(target);
  };

  const manifest = readServicesManifest();

  // Workspace names this worktree may have used for its DB container.
  // CONDUCTOR_WORKSPACE_NAME is intentionally NOT trusted here — it leaks
  // across worktrees (see normalize_conductor_workspace_env in
  // scripts/lib/workspace-env.sh, which overrides it with the directory
  // basename for the same reason). The services.json manifest is written
  // after that normalization, so it is authoritative.
  const workspaceNames = new Set<string>();
  if (manifest?.database?.container?.startsWith('victoria-db-')) {
    workspaceNames.add(manifest.database.container.slice('victoria-db-'.length));
  }
  workspaceNames.add(path.basename(WORKTREE_ROOT));

  let dockerOk = true;
  try {
    execSync('docker ps', { stdio: 'ignore' });
  } catch {
    dockerOk = false;
    console.log('⚠️  Docker unavailable — skipping container databases');
  }

  if (dockerOk) {
    for (const workspace of Array.from(workspaceNames)) {
      const container = `victoria-db-${workspace}`;
      const state = containerState(container);
      if (state === 'absent') continue;

      if (state === 'stopped') {
        console.log(`🐘 Starting stopped container ${container} to clean it...`);
        try {
          execSync(`docker start ${JSON.stringify(container)}`, { stdio: 'ignore' });
        } catch (error: any) {
          console.log(`⚠️  Failed to start ${container}: ${error.message} — skipping`);
          continue;
        }
        if (!waitForContainerPg(container)) {
          console.log(`⚠️  ${container} did not become ready — skipping`);
          execSync(`docker stop ${JSON.stringify(container)} || true`, { stdio: 'ignore' });
          continue;
        }
      }

      const port = containerHostPort(container);
      if (!port) {
        console.log(`⚠️  Could not determine host port for ${container} — skipping`);
        continue;
      }
      addTarget({
        label: container,
        url: `postgresql://postgres:postgres@localhost:${port}/victoria`,
        stopContainerAfter: state === 'stopped' ? container : undefined,
      });
    }
  }

  // System-Postgres fallback stack (run.sh without Docker)
  if (manifest?.database?.use_system_postgres) {
    const systemPostgresPort = manifest.database.runtime_port ?? 5432;
    addTarget({
      label: `system postgres :${systemPostgresPort}`,
      url: `postgresql://postgres:postgres@localhost:${systemPostgresPort}/victoria`,
    });
  }

  // env DATABASE_URL: local URLs are part of this worktree's stack; remote/shared
  // DBs are out of scope unless explicitly requested
  const envUrl = process.env.DATABASE_URL;
  if (envUrl) {
    if (isLocalUrl(envUrl)) {
      addTarget({ label: 'env DATABASE_URL', url: envUrl });
    } else if (process.env.CLEANUP_REMOTE_DB === '1') {
      addTarget({ label: 'env DATABASE_URL (remote)', url: envUrl });
    } else {
      console.log(
        'ℹ️  env DATABASE_URL is remote — skipping (set CLEANUP_REMOTE_DB=1 to clean it too)'
      );
    }
  }

  return targets;
}

async function cleanupDatabase(
  target: DbTarget,
  temporalClient: TemporalClient | null
): Promise<CleanupStats> {
  const stats = emptyStats();
  const prisma = new PrismaClient({
    log: ['error', 'warn'],
    datasources: { db: { url: target.url } },
  });

  try {
    // Get all non-deleted agents
    let agents;
    let softDeletedAgents;
    const agentSelect = {
      id: true,
      userId: true,
      goal: true,
      status: true,
      statusMessage: true,
      model: true,
      contextSize: true,
      messageCount: true,
      tokenCount: true,
      tokensIn: true,
      tokensOut: true,
      source: true,
      depth: true,
      createdAt: true,
      updatedAt: true,
      deletedAt: true,
      temporalWorkflowId: true,
    } as const;
    try {
      agents = await prisma.agent.findMany({
        where: { deletedAt: null },
        select: agentSelect,
      });

      // Get already soft-deleted agents for hard deletion (also need full data for archiving)
      softDeletedAgents = await prisma.agent.findMany({
        where: { deletedAt: { not: null } },
        select: agentSelect,
      });
    } catch (dbError: any) {
      console.log(`⚠️  Cannot query ${target.label}:`, dbError.message);
      console.log('⚠️  Skipping this database\n');
      stats.cleanupFailures++;
      return stats;
    }

    stats.activeCount = agents.length;
    console.log(`📊 Found ${agents.length} active agents`);
    console.log(`📊 Found ${softDeletedAgents.length} soft-deleted agents\n`);

    const limit = pLimit(10);

    // Track agent IDs that failed to archive — skip hard-deleting these
    const failedArchiveIds = new Set<string>();

    // Archive goals from other users to GoalHistory
    const allAgentsToArchive = [...agents, ...softDeletedAgents].filter(
      (agent) => MY_USER_ID && agent.userId !== MY_USER_ID
    );

    if (!MY_USER_ID) {
      console.log('ℹ️  MY_USER_ID not set - skipping goal archiving (all goals will be deleted)\n');
    } else if (allAgentsToArchive.length > 0) {
      console.log(
        `📦 Archiving ${allAgentsToArchive.length} goals from other users to GoalHistory...\n`
      );

      await Promise.all(
        allAgentsToArchive.map((agent) =>
          limit(async () => {
            try {
              const existing = await prisma.goalHistory.findFirst({
                where: { originalAgentId: agent.id },
                select: { id: true },
              });
              if (existing) {
                return;
              }
              await prisma.goalHistory.create({
                data: {
                  originalAgentId: agent.id,
                  userId: agent.userId,
                  goal: agent.goal,
                  status: agent.status,
                  statusMessage: agent.statusMessage,
                  model: agent.model,
                  contextSize: agent.contextSize,
                  messageCount: agent.messageCount,
                  tokenCount: agent.tokenCount,
                  tokensIn: agent.tokensIn,
                  tokensOut: agent.tokensOut,
                  source: agent.source,
                  depth: agent.depth,
                  agentCreatedAt: agent.createdAt,
                  agentUpdatedAt: agent.updatedAt,
                  agentDeletedAt: agent.deletedAt,
                },
              });
              console.log(
                `   📦 Archived goal from user ${agent.userId}: ${agent.goal.substring(0, 50)}...`
              );
              stats.archivedCount++;
            } catch (archiveError: any) {
              console.log(`   ⚠️  Failed to archive agent ${agent.id}: ${archiveError.message}`);
              failedArchiveIds.add(agent.id);
            }
          })
        )
      );
      console.log(`✅ Archived ${stats.archivedCount} goals to GoalHistory\n`);
      if (failedArchiveIds.size > 0) {
        console.log(
          `⚠️  ${failedArchiveIds.size} agent(s) failed to archive — will skip hard-deleting them\n`
        );
      }
    }
    stats.failedArchiveCount = failedArchiveIds.size;

    // Process active agents in parallel (terminate workflow + soft delete)
    await Promise.all(
      agents.map((agent) =>
        limit(async () => {
          console.log(`\n🔄 Processing agent ${agent.id}`);
          console.log(`   Goal: ${agent.goal.substring(0, 60)}...`);
          console.log(`   Status: ${agent.status}`);
          console.log(`   Workflow ID: ${agent.temporalWorkflowId || 'None'}`);

          try {
            if (agent.temporalWorkflowId && temporalClient) {
              try {
                const handle = temporalClient.workflow.getHandle(agent.temporalWorkflowId);
                await handle.terminate('Cleanup: All agents deleted');
                console.log(`   ✅ Terminated workflow`);
              } catch (workflowError: any) {
                if (
                  workflowError.message?.includes('not found') ||
                  workflowError.message?.includes('already completed')
                ) {
                  console.log(`   ℹ️  Workflow already finished (safe to delete)`);
                } else {
                  console.log(`   ⚠️  Failed to terminate workflow: ${workflowError.message}`);
                  stats.softDeleteFailCount++;
                  return;
                }
              }
            } else if (agent.temporalWorkflowId && !temporalClient) {
              console.log(`   ⚠️  Skipping workflow termination (no Temporal connection)`);
              stats.softDeleteFailCount++;
              return;
            } else {
              console.log(`   ℹ️  No workflow to terminate`);
            }

            await prisma.agent.update({
              where: { id: agent.id },
              data: { deletedAt: new Date() },
            });
            console.log(`   ✅ Deleted agent from database`);
            stats.softDeletedCount++;
          } catch (error: any) {
            console.error(`   ❌ Failed to delete agent: ${error.message}`);
            stats.softDeleteFailCount++;
          }
        })
      )
    );

    // Hard-delete soft-deleted agents in parallel (skip agents that failed to archive)
    const safeToDelete = softDeletedAgents.filter((a) => !failedArchiveIds.has(a.id));
    stats.skippedHardDeleteCount = softDeletedAgents.length - safeToDelete.length;
    if (stats.skippedHardDeleteCount > 0) {
      console.log(
        `\n⚠️  Skipping ${stats.skippedHardDeleteCount} agent(s) whose goals failed to archive`
      );
    }
    if (safeToDelete.length > 0) {
      console.log(`\n🗑️  Hard-deleting ${safeToDelete.length} soft-deleted agents...`);
      await Promise.all(
        safeToDelete.map((agent) =>
          limit(async () => {
            try {
              await prisma.agent.delete({
                where: { id: agent.id },
              });
              console.log(
                `   ✅ Hard-deleted agent ${agent.id} (deleted on ${agent.deletedAt?.toISOString()})`
              );
              stats.hardDeletedCount++;
            } catch (error: any) {
              console.log(`   ❌ Failed to hard-delete agent ${agent.id}: ${error.message}`);
              stats.hardDeleteFailCount++;
            }
          })
        )
      );
      console.log(`✅ Hard-deleted ${stats.hardDeletedCount} soft-deleted agent(s)`);
    }

    // Clear blueprints + attention requests in parallel (allSettled to always report both)
    const [blueprintResult, attentionResult] = await Promise.allSettled([
      (async () => {
        console.log('\n🗑️  Clearing blueprints without feedback...');
        const result = await prisma.goalBlueprint.deleteMany({
          where: {
            metadata: { equals: Prisma.DbNull },
          },
        });
        console.log(`✅ Deleted ${result.count} blueprint(s) (preserved blueprints with feedback)`);
        return result;
      })(),
      (async () => {
        console.log('\n🗑️  Clearing all attention requests...');
        const result = await prisma.agentAttentionRequest.deleteMany({});
        console.log(`✅ Deleted ${result.count} attention request(s)`);
        return result;
      })(),
    ]);
    stats.blueprintsClearedCount =
      blueprintResult.status === 'fulfilled' ? blueprintResult.value.count : 0;
    stats.attentionClearedCount =
      attentionResult.status === 'fulfilled' ? attentionResult.value.count : 0;
    if (blueprintResult.status === 'rejected') {
      console.log(`❌ Failed to clear blueprints: ${blueprintResult.reason}`);
      stats.cleanupFailures++;
    }
    if (attentionResult.status === 'rejected') {
      console.log(`❌ Failed to clear attention requests: ${attentionResult.reason}`);
      stats.cleanupFailures++;
    }

    return stats;
  } finally {
    await prisma.$disconnect();
    if (target.stopContainerAfter) {
      console.log(`🐘 Stopping ${target.stopContainerAfter} (was stopped before cleanup)`);
      try {
        execSync(`docker stop ${JSON.stringify(target.stopContainerAfter)}`, { stdio: 'ignore' });
      } catch (error: any) {
        console.log(`⚠️  Failed to stop ${target.stopContainerAfter}: ${error.message}`);
      }
    }
  }
}

async function cleanupAllAgents() {
  console.log(`🧹 Starting cleanup of all agents (worktree: ${WORKTREE_ROOT})...\n`);

  // First kill this worktree's workers
  await killThisWorktreeWorkers();

  const targets = discoverDbTargets();
  if (targets.length === 0) {
    console.log('⚠️  No databases found for this worktree');
    process.exitCode = 1;
    return;
  }

  console.log(`\n🎯 Cleaning ${targets.length} database(s):`);
  for (const target of targets) {
    console.log(`   - ${target.label}`);
  }
  console.log('');

  // One Temporal client shared across databases — all stacks use the same namespace
  let temporalClient: TemporalClient | null = null;
  try {
    temporalClient = await getTemporalClient();
    console.log('✅ Connected to Temporal Cloud\n');
  } catch (error) {
    console.error('⚠️  Failed to connect to Temporal:', error);
    console.log('⚠️  Will proceed with database cleanup only\n');
  }

  const perDbStats: Array<{ target: DbTarget; stats: CleanupStats }> = [];
  for (const target of targets) {
    console.log('\n' + '─'.repeat(60));
    console.log(`🗄️  Database: ${target.label}`);
    console.log('─'.repeat(60) + '\n');
    try {
      const stats = await cleanupDatabase(target, temporalClient);
      perDbStats.push({ target, stats });
    } catch (error: any) {
      console.error(`❌ Fatal error cleaning ${target.label}: ${error.message}`);
      const stats = emptyStats();
      stats.cleanupFailures++;
      perDbStats.push({ target, stats });
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('📈 Cleanup Summary:');
  let grandFailures = 0;
  for (const { target, stats } of perDbStats) {
    grandFailures += totalFailures(stats);
    console.log(`\n   ${target.label}:`);
    console.log(`      Goals archived to GoalHistory: ${stats.archivedCount}`);
    console.log(`      Goals failed to archive: ${stats.failedArchiveCount}`);
    console.log(`      Active agents processed: ${stats.activeCount}`);
    console.log(`      Successfully soft-deleted: ${stats.softDeletedCount}`);
    console.log(`      Failed to soft-delete: ${stats.softDeleteFailCount}`);
    console.log(`      Hard-deleted (previously soft-deleted): ${stats.hardDeletedCount}`);
    console.log(`      Failed to hard-delete: ${stats.hardDeleteFailCount}`);
    console.log(`      Skipped hard-delete (archive failed): ${stats.skippedHardDeleteCount}`);
    console.log(`      Blueprints cleared: ${stats.blueprintsClearedCount}`);
    console.log(`      Attention requests cleared: ${stats.attentionClearedCount}`);
  }
  console.log('\n' + '='.repeat(60));

  if (grandFailures === 0) {
    console.log('\n✅ All agents, blueprints, and attention requests cleaned up successfully!');
  } else {
    console.log(`\n⚠️  ${grandFailures} failure(s) during cleanup`);
    process.exitCode = 1;
  }
}

// Run cleanup
cleanupAllAgents()
  .then(() => {
    console.log('\n👋 Cleanup complete');
    process.exit(process.exitCode ?? 0);
  })
  .catch((error) => {
    console.error('\n💥 Cleanup failed:', error);
    process.exit(1);
  });
