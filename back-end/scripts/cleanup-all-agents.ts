#!/usr/bin/env tsx
/* eslint-disable no-console, @typescript-eslint/no-explicit-any */

/**
 * Cleanup Script: Delete All Agents, Terminate Workflows, Clear Blueprints, and Attention Requests
 *
 * Cleans BOTH databases that can hold agents for this checkout:
 *   1. This worktree's LOCAL docker DB (discovered from .context/services.json) — where
 *      `scripts/run.sh` points the running stack (it exports DATABASE_URL to a per-worktree
 *      `victoria-db-<workspace>` container). This is the DB the local app/benchmarks write to.
 *   2. PROD (the DATABASE_URL in back-end/.env — shared Supabase).
 *
 * For each target it will:
 *   - Find all active (non-deleted) agents and archive other users' goals to GoalHistory
 *   - Terminate their Temporal workflows (cloud namespace, shared across targets)
 *   - Soft-delete them, then hard-delete previously soft-deleted agents
 *   - Clear blueprints without feedback and all attention requests
 *
 * Worker processes are killed SCOPED TO THIS WORKTREE ONLY (by matching the process cwd),
 * so parallel Conductor worktrees running their own stacks are never disrupted.
 *
 * Set MY_USER_ID environment variable to skip archiving your own agents' goals.
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { getTemporalClient } from '../src/providers/temporal';
import * as dotenv from 'dotenv';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import pLimit from 'p-limit';

dotenv.config();

const MY_USER_ID = process.env.MY_USER_ID || '1f85ff25-6e29-4c1b-8739-f917bd101a30';

// Worktree root = two levels up from back-end/scripts.
const WORKTREE_ROOT = path.resolve(__dirname, '../../');

interface CleanupTarget {
  label: string;
  url: string;
}

/** PROD target: the DATABASE_URL baked into back-end/.env (shared Supabase). */
function getProdTarget(): CleanupTarget | null {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('⚠️  No DATABASE_URL in env — skipping prod cleanup');
    return null;
  }
  return { label: 'prod (DATABASE_URL from .env)', url };
}

/**
 * LOCAL target: this worktree's docker DB. Resolved by CONTAINER NAME
 * (`victoria-db-<CONDUCTOR_WORKSPACE_NAME>`) via `docker port`, NOT by the port recorded in
 * services.json — that port can be stale and since reused by a SIBLING worktree's container,
 * which would make us clean the wrong database. Starts the container if it is stopped so its
 * data can be purged. Falls back to services.json only when the workspace name is unavailable
 * (e.g. system-postgres setups). Returns null when the worktree has no local DB.
 */
function getLocalWorktreeTarget(): CleanupTarget | null {
  const workspace = process.env.CONDUCTOR_WORKSPACE_NAME;
  if (workspace) {
    const container = `victoria-db-${workspace}`;
    try {
      const running = execSync(
        `docker ps --filter "name=^${container}$" --format '{{.Names}}'`,
        { encoding: 'utf-8' }
      ).trim();
      if (!running) {
        const exists = execSync(
          `docker ps -a --filter "name=^${container}$" --format '{{.Names}}'`,
          { encoding: 'utf-8' }
        ).trim();
        if (exists) {
          console.log(
            `⚠️  ${container} is stopped — not cleaning in place (its stored port may be reused\n` +
              `    by a sibling worktree). Purge it with: docker rm -f ${container}`
          );
        }
        return null;
      }
      const portLine = execSync(`docker port ${container} 5432 2>/dev/null || true`, {
        encoding: 'utf-8',
      }).trim();
      const port = portLine.split('\n')[0]?.match(/:(\d+)\s*$/)?.[1];
      if (!port) return null;
      // Collision guard: confirm the RUNNING container publishing this port is actually ours —
      // never a sibling worktree's container that grabbed the same port number.
      const owner = execSync(`docker ps --filter "publish=${port}" --format '{{.Names}}'`, {
        encoding: 'utf-8',
      }).trim();
      if (owner !== container) {
        console.log(
          `⚠️  Port :${port} is published by '${owner || 'unknown'}', not '${container}' — ` +
            `skipping local cleanup so a sibling worktree's DB is never touched.`
        );
        return null;
      }
      const url = `postgresql://postgres:postgres@localhost:${port}/victoria`;
      if (url !== process.env.DATABASE_URL) {
        return { label: `local worktree (${container} on :${port})`, url };
      }
    } catch (error: any) {
      console.log(`⚠️  Could not resolve ${container} via docker:`, error.message);
    }
  }

  // Fallback: services.json (system-postgres / no workspace name).
  try {
    const servicesPath = path.join(WORKTREE_ROOT, '.context', 'services.json');
    if (!fs.existsSync(servicesPath)) return null;
    const svc = JSON.parse(fs.readFileSync(servicesPath, 'utf-8'));
    const port = svc?.ports?.local_db;
    const container = svc?.database?.container;
    if (!port) return null;
    const url = `postgresql://postgres:postgres@localhost:${port}/victoria`;
    if (url === process.env.DATABASE_URL) return null;
    return { label: `local worktree (${container ?? 'victoria'} on :${port})`, url };
  } catch (error: any) {
    console.log('⚠️  Could not read local worktree DB from services.json:', error.message);
    return null;
  }
}

/**
 * Kill Python workers belonging to THIS worktree only, matched by process cwd.
 * Never does a global `pkill` (that would break sibling Conductor worktrees mid-run).
 */
function killThisWorktreeWorkers() {
  console.log(`🔪 Killing this worktree's Python workers (scoped to ${WORKTREE_ROOT})...\n`);
  try {
    const out = execSync('pgrep -f "python worker.py" || true', { encoding: 'utf-8' }).trim();
    const pids = out ? out.split('\n').filter(Boolean) : [];
    if (pids.length === 0) {
      console.log('✅ No workers running\n');
      return;
    }
    let killed = 0;
    for (const pid of pids) {
      try {
        const cwd = execSync(
          `lsof -a -d cwd -p ${pid} -Fn 2>/dev/null | grep '^n' | head -1 | cut -c2- || true`,
          { encoding: 'utf-8' }
        ).trim();
        if (cwd && cwd.startsWith(WORKTREE_ROOT)) {
          execSync(`kill -9 ${pid} 2>/dev/null || true`);
          console.log(`   ✅ Killed worker pid ${pid} (cwd ${cwd})`);
          killed++;
        } else {
          console.log(`   ⏭️  Skipped worker pid ${pid} (other worktree: ${cwd || 'unknown'})`);
        }
      } catch {
        // best-effort
      }
    }
    console.log(`✅ Killed ${killed} worker(s) for this worktree\n`);
  } catch (error: any) {
    console.log('⚠️  Error scoping/killing workers:', error.message);
    console.log('⚠️  Continuing with cleanup...\n');
  }
}

/** Clean a single database (terminate workflows + delete agents + clear blueprints/attention). */
async function cleanupOneDatabase(
  prisma: PrismaClient,
  temporalClient: any,
  label: string
): Promise<number> {
  console.log(`🧹 Cleaning agents in: ${label}\n`);

  // Get all non-deleted agents
  let agents;
  let softDeletedAgents;
  try {
    agents = await prisma.agent.findMany({
      where: { deletedAt: null },
      select: {
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
      },
    });

    softDeletedAgents = await prisma.agent.findMany({
      where: { deletedAt: { not: null } },
      select: {
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
      },
    });
  } catch (dbError: any) {
    console.log(`⚠️  Cannot connect to database (${label}):`, dbError.message);
    console.log('⚠️  Skipping this target');
    return 1;
  }

  console.log(`📊 Found ${agents.length} active agents`);
  console.log(`📊 Found ${softDeletedAgents.length} soft-deleted agents\n`);

  const limit = pLimit(10);
  const failedArchiveIds = new Set<string>();

  // Archive goals from other users to GoalHistory
  let archivedCount = 0;
  {
    const allAgentsToArchive = [...agents, ...softDeletedAgents].filter(
      (agent) => MY_USER_ID && agent.userId !== MY_USER_ID
    );

    if (!MY_USER_ID) {
      console.log('ℹ️  MY_USER_ID not set - skipping goal archiving (all goals will be deleted)\n');
    } else {
      console.log(`🔒 MY_USER_ID is set: ${MY_USER_ID}`);
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
              if (existing) return;
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
              archivedCount++;
            } catch (archiveError: any) {
              console.log(`   ⚠️  Failed to archive agent ${agent.id}: ${archiveError.message}`);
              failedArchiveIds.add(agent.id);
            }
          })
        )
      );
      console.log(`✅ Archived ${archivedCount} goals to GoalHistory\n`);
      if (failedArchiveIds.size > 0) {
        console.log(
          `⚠️  ${failedArchiveIds.size} agent(s) failed to archive — will skip hard-deleting them\n`
        );
      }
    }
  }

  // Process active agents in parallel (terminate workflow + soft delete)
  let successCount = 0;
  let failCount = 0;

  await Promise.all(
    agents.map((agent) =>
      limit(async () => {
        try {
          if (agent.temporalWorkflowId && temporalClient) {
            try {
              const handle = temporalClient.workflow.getHandle(agent.temporalWorkflowId);
              await handle.terminate('Cleanup: All agents deleted');
            } catch (workflowError: any) {
              if (
                workflowError.message?.includes('not found') ||
                workflowError.message?.includes('already completed')
              ) {
                // safe to delete
              } else {
                console.log(`   ⚠️  Failed to terminate workflow: ${workflowError.message}`);
                failCount++;
                return;
              }
            }
          } else if (agent.temporalWorkflowId && !temporalClient) {
            console.log(`   ⚠️  Skipping workflow termination (no Temporal connection)`);
            failCount++;
            return;
          }

          await prisma.agent.update({
            where: { id: agent.id },
            data: { deletedAt: new Date() },
          });
          successCount++;
        } catch (error: any) {
          console.error(`   ❌ Failed to delete agent ${agent.id}: ${error.message}`);
          failCount++;
        }
      })
    )
  );

  // Hard-delete soft-deleted agents (skip agents that failed to archive)
  let hardDeletedCount = 0;
  let hardDeleteFailCount = 0;
  const safeToDelete = softDeletedAgents.filter((a) => !failedArchiveIds.has(a.id));
  const skippedCount = softDeletedAgents.length - safeToDelete.length;
  if (skippedCount > 0) {
    console.log(`\n⚠️  Skipping ${skippedCount} agent(s) whose goals failed to archive`);
  }
  if (safeToDelete.length > 0) {
    console.log(`\n🗑️  Hard-deleting ${safeToDelete.length} soft-deleted agents...`);
    await Promise.all(
      safeToDelete.map((agent) =>
        limit(async () => {
          try {
            await prisma.agent.delete({ where: { id: agent.id } });
            hardDeletedCount++;
          } catch (error: any) {
            console.log(`   ❌ Failed to hard-delete agent ${agent.id}: ${error.message}`);
            hardDeleteFailCount++;
          }
        })
      )
    );
    console.log(`✅ Hard-deleted ${hardDeletedCount} soft-deleted agent(s)`);
  }

  // Clear blueprints + attention requests
  const [blueprintResult, attentionResult] = await Promise.allSettled([
    (async () => {
      const result = await prisma.goalBlueprint.deleteMany({
        where: { metadata: { equals: Prisma.DbNull } },
      });
      console.log(`✅ Deleted ${result.count} blueprint(s) (preserved blueprints with feedback)`);
      return result;
    })(),
    (async () => {
      const result = await prisma.agentAttentionRequest.deleteMany({});
      console.log(`✅ Deleted ${result.count} attention request(s)`);
      return result;
    })(),
  ]);
  if (blueprintResult.status === 'rejected') {
    console.log(`❌ Failed to clear blueprints: ${blueprintResult.reason}`);
  }
  if (attentionResult.status === 'rejected') {
    console.log(`❌ Failed to clear attention requests: ${attentionResult.reason}`);
  }

  const cleanupFailures =
    (blueprintResult.status === 'rejected' ? 1 : 0) +
    (attentionResult.status === 'rejected' ? 1 : 0);
  const totalFailures = failCount + hardDeleteFailCount + failedArchiveIds.size + cleanupFailures;

  console.log('\n' + '-'.repeat(60));
  console.log(`📈 Summary for ${label}:`);
  console.log(`   Goals archived: ${archivedCount}`);
  console.log(`   Active agents: ${agents.length}  (soft-deleted ${successCount}, failed ${failCount})`);
  console.log(`   Hard-deleted: ${hardDeletedCount}  (failed ${hardDeleteFailCount})`);
  console.log(`   Skipped hard-delete (archive failed): ${skippedCount}`);
  console.log('-'.repeat(60));

  return totalFailures;
}

async function main() {
  console.log('🧹 Starting cleanup (this worktree + prod)...\n');

  // Local first so any token-burning local workflows die before we touch prod.
  const targets = [getLocalWorktreeTarget(), getProdTarget()].filter(Boolean) as CleanupTarget[];
  if (targets.length === 0) {
    console.log('⚠️  No cleanup targets resolved — nothing to do.');
    return;
  }
  console.log('🎯 Cleanup targets:');
  targets.forEach((t) => console.log(`   - ${t.label}`));
  console.log('');

  // One Temporal client (cloud namespace) shared across targets.
  const temporalClient = await (async () => {
    try {
      const client = await getTemporalClient();
      console.log('✅ Connected to Temporal Cloud\n');
      return client;
    } catch (error) {
      console.error('⚠️  Failed to connect to Temporal:', error);
      console.log('⚠️  Will proceed with database cleanup only\n');
      return null;
    }
  })();

  let totalFailures = 0;
  for (const target of targets) {
    console.log('\n' + '#'.repeat(60));
    console.log(`# Cleaning: ${target.label}`);
    console.log('#'.repeat(60) + '\n');
    const prisma = new PrismaClient({ datasourceUrl: target.url });
    try {
      totalFailures += await cleanupOneDatabase(prisma, temporalClient, target.label);
    } catch (error: any) {
      console.error(`❌ Fatal error cleaning ${target.label}:`, error.message);
      totalFailures++;
    } finally {
      await prisma.$disconnect();
    }
  }

  // Kill workers LAST: killing this worktree's worker can trip run.sh's EXIT trap, which
  // tears down the local docker DB. Doing it after cleanup avoids making the DB unreachable
  // mid-run. NOTE: this stops this worktree's running stack — restart run.sh afterwards.
  console.log('');
  killThisWorktreeWorkers();

  console.log('\n' + '='.repeat(60));
  if (totalFailures === 0) {
    console.log('✅ All targets cleaned up successfully!');
  } else {
    console.log(`⚠️  ${totalFailures} failure(s) during cleanup`);
    process.exitCode = 1;
  }
  console.log('='.repeat(60));
}

// Run cleanup
main()
  .then(() => {
    console.log('\n👋 Cleanup complete');
    process.exit(process.exitCode ?? 0);
  })
  .catch((error) => {
    console.error('\n💥 Cleanup failed:', error);
    process.exit(1);
  });
