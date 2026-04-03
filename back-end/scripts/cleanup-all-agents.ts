#!/usr/bin/env tsx
/* eslint-disable no-console, @typescript-eslint/no-explicit-any */

/**
 * Cleanup Script: Delete All Agents, Terminate Workflows, Clear Blueprints, and Attention Requests
 *
 * This script will:
 * 1. Kill any local workers running on the test queue
 * 2. Find all active (non-deleted) agents in the database
 * 3. Archive goals from other users to GoalHistory table
 * 4. Terminate their Temporal workflows
 * 5. Soft-delete them from the database
 * 6. Find all soft-deleted agents and hard-delete them
 * 7. Clear all blueprints from the knowledge base
 * 8. Clear all attention requests
 *
 * Set MY_USER_ID environment variable to skip archiving your own agents' goals.
 */

import { prisma } from '../src/providers/database';
import { getTemporalClient } from '../src/providers/temporal';
import * as dotenv from 'dotenv';
import { execSync } from 'child_process';
import pLimit from 'p-limit';

dotenv.config();

const MY_USER_ID = process.env.MY_USER_ID || '1f85ff25-6e29-4c1b-8739-f917bd101a30';

async function killTestQueueWorkers() {
  // Kill workers on test queue
  const testQueue = process.env.TEST_TASK_QUEUE || 'navi-agent-tasks-test';
  console.log(`🔪 Killing workers on test queue: ${testQueue}...\n`);

  try {
    // Check if any workers are running
    const checkCmd = 'ps aux | grep "[p]ython worker.py" || true';
    const runningWorkers = execSync(checkCmd, { encoding: 'utf-8' }).trim();

    if (runningWorkers) {
      console.log('📍 Found running workers:');
      console.log(runningWorkers);
      console.log('');

      // Kill the workers
      const killCmd = 'pkill -9 -f "python worker.py" || true';
      execSync(killCmd);
      console.log('✅ Killed all Python workers\n');
    } else {
      console.log('✅ No workers running\n');
    }
  } catch (error: any) {
    console.log('⚠️  Error checking/killing workers:', error.message);
    console.log('⚠️  Continuing with cleanup...\n');
  }
}

async function cleanupAllAgents() {
  console.log('🧹 Starting cleanup of all agents...\n');

  // First kill any local workers
  await killTestQueueWorkers();

  try {
    // Get all non-deleted agents
    let agents;
    let softDeletedAgents;
    try {
      agents = await prisma.agent.findMany({
        where: {
          deletedAt: null,
        },
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

      // Get already soft-deleted agents for hard deletion (also need full data for archiving)
      softDeletedAgents = await prisma.agent.findMany({
        where: {
          deletedAt: { not: null },
        },
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
      console.log('⚠️  Cannot connect to database:', dbError.message);
      console.log('⚠️  Skipping database cleanup (workers already killed)');
      console.log('✅ Cleanup complete (no database access needed)');
      return;
    }

    console.log(`📊 Found ${agents.length} active agents`);
    console.log(`📊 Found ${softDeletedAgents.length} soft-deleted agents\n`);

    const limit = pLimit(10);

    // Track agent IDs that failed to archive — skip hard-deleting these
    const failedArchiveIds = new Set<string>();

    // Run archiving + Temporal connection in parallel
    const [archivedCount, temporalClient] = await Promise.all([
      // Archive goals from other users to GoalHistory
      (async () => {
        const allAgentsToArchive = [...agents, ...softDeletedAgents].filter(
          (agent) => MY_USER_ID && agent.userId !== MY_USER_ID
        );

        if (!MY_USER_ID) {
          console.log(
            'ℹ️  MY_USER_ID not set - skipping goal archiving (all goals will be deleted)\n'
          );
          return 0;
        }

        console.log(`🔒 MY_USER_ID is set: ${MY_USER_ID}`);
        console.log(
          `📦 Archiving ${allAgentsToArchive.length} goals from other users to GoalHistory...\n`
        );

        let count = 0;
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
                count++;
              } catch (archiveError: any) {
                console.log(`   ⚠️  Failed to archive agent ${agent.id}: ${archiveError.message}`);
                failedArchiveIds.add(agent.id);
              }
            })
          )
        );
        console.log(`✅ Archived ${count} goals to GoalHistory\n`);
        if (failedArchiveIds.size > 0) {
          console.log(
            `⚠️  ${failedArchiveIds.size} agent(s) failed to archive — will skip hard-deleting them\n`
          );
        }
        return count;
      })(),

      // Initialize Temporal client
      (async () => {
        try {
          const client = await getTemporalClient();
          console.log('✅ Connected to Temporal Cloud\n');
          return client;
        } catch (error) {
          console.error('⚠️  Failed to connect to Temporal:', error);
          console.log('⚠️  Will proceed with database cleanup only\n');
          return null;
        }
      })(),
    ]);

    // Process active agents in parallel (terminate workflow + soft delete)
    let successCount = 0;
    let failCount = 0;

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
                  failCount++;
                  return;
                }
              }
            } else if (agent.temporalWorkflowId && !temporalClient) {
              console.log(`   ⚠️  Skipping workflow termination (no Temporal connection)`);
              failCount++;
              return;
            } else {
              console.log(`   ℹ️  No workflow to terminate`);
            }

            await prisma.agent.update({
              where: { id: agent.id },
              data: { deletedAt: new Date() },
            });
            console.log(`   ✅ Deleted agent from database`);
            successCount++;
          } catch (error: any) {
            console.error(`   ❌ Failed to delete agent: ${error.message}`);
            failCount++;
          }
        })
      )
    );

    // Hard-delete soft-deleted agents in parallel (skip agents that failed to archive)
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
              await prisma.agent.delete({
                where: { id: agent.id },
              });
              console.log(
                `   ✅ Hard-deleted agent ${agent.id} (deleted on ${agent.deletedAt?.toISOString()})`
              );
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

    // Clear blueprints + attention requests in parallel (allSettled to always report both)
    const { Prisma } = await import('@prisma/client');
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
    const blueprintsClearedCount =
      blueprintResult.status === 'fulfilled' ? blueprintResult.value.count : 0;
    const attentionClearedCount =
      attentionResult.status === 'fulfilled' ? attentionResult.value.count : 0;
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

    console.log('\n' + '='.repeat(60));
    console.log('📈 Cleanup Summary:');
    console.log(`   Goals archived to GoalHistory: ${archivedCount}`);
    console.log(`   Goals failed to archive: ${failedArchiveIds.size}`);
    console.log(`   Active agents processed: ${agents.length}`);
    console.log(`   Successfully soft-deleted: ${successCount}`);
    console.log(`   Failed to soft-delete: ${failCount}`);
    console.log(`   Hard-deleted (previously soft-deleted): ${hardDeletedCount}`);
    console.log(`   Failed to hard-delete: ${hardDeleteFailCount}`);
    console.log(`   Skipped hard-delete (archive failed): ${skippedCount}`);
    console.log(`   Blueprints cleared: ${blueprintsClearedCount}`);
    console.log(`   Attention requests cleared: ${attentionClearedCount}`);
    console.log('='.repeat(60));

    if (totalFailures === 0) {
      console.log('\n✅ All agents, blueprints, and attention requests cleaned up successfully!');
    } else {
      console.log(`\n⚠️  ${totalFailures} failure(s) during cleanup`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('❌ Fatal error during cleanup:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
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
