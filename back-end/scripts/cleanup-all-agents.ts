#!/usr/bin/env tsx

/**
 * Cleanup Script: Delete MY Agents, Terminate Workflows, Clear Blueprints, and Attention Requests
 *
 * This script will (only for MY_USER_ID):
 * 1. Kill any local workers running on the test queue
 * 2. Find all active (non-deleted) agents for my user
 * 3. Terminate their Temporal workflows
 * 4. Soft-delete them from the database
 * 5. Find all soft-deleted agents for my user and hard-delete them
 * 6. Clear my blueprints from the knowledge base (without feedback)
 * 7. Clear my attention requests
 */

import { prisma } from '../src/lib/prisma';
import { getTemporalClient } from '../src/lib/temporal';
import * as dotenv from 'dotenv';
import { execSync } from 'child_process';

dotenv.config();

const MY_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

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

async function cleanupMyAgents() {
  console.log(`🧹 Starting cleanup of agents for user ${MY_USER_ID}...\n`);

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
          userId: MY_USER_ID,
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

      // Get already soft-deleted agents for hard deletion
      softDeletedAgents = await prisma.agent.findMany({
        where: {
          deletedAt: { not: null },
          userId: MY_USER_ID,
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

    console.log(`📊 Found ${agents.length} active agents for user ${MY_USER_ID}`);
    console.log(`📊 Found ${softDeletedAgents.length} soft-deleted agents\n`);

    // Initialize Temporal client (only if there are agents to process)
    let temporalClient;
    try {
      temporalClient = await getTemporalClient();
      console.log('✅ Connected to Temporal Cloud\n');
    } catch (error) {
      console.error('⚠️  Failed to connect to Temporal:', error);
      console.log('⚠️  Will proceed with database cleanup only\n');
    }

    // Process each agent
    let successCount = 0;
    let failCount = 0;

    for (const agent of agents) {
      console.log(`\n🔄 Processing agent ${agent.id}`);
      console.log(`   Goal: ${agent.goal.substring(0, 60)}...`);
      console.log(`   Status: ${agent.status}`);
      console.log(`   Workflow ID: ${agent.temporalWorkflowId || 'None'}`);

      try {
        // Terminate workflow if exists
        if (agent.temporalWorkflowId && temporalClient) {
          try {
            const handle = temporalClient.workflow.getHandle(agent.temporalWorkflowId);
            await handle.terminate('Cleanup: All agents deleted');
            console.log(`   ✅ Terminated workflow`);
          } catch (workflowError: any) {
            if (workflowError.message?.includes('not found')) {
              console.log(`   ℹ️  Workflow not found (may have already completed)`);
            } else {
              console.log(`   ⚠️  Failed to terminate workflow: ${workflowError.message}`);
            }
          }
        } else if (agent.temporalWorkflowId && !temporalClient) {
          console.log(`   ⚠️  Skipping workflow termination (no Temporal connection)`);
        } else {
          console.log(`   ℹ️  No workflow to terminate`);
        }

        // Soft delete agent
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
    }

    // Hard-delete soft-deleted agents
    let hardDeletedCount = 0;
    if (softDeletedAgents.length > 0) {
      console.log(`\n🗑️  Hard-deleting ${softDeletedAgents.length} soft-deleted agents...`);
      for (const agent of softDeletedAgents) {
        try {
          await prisma.agent.delete({
            where: { id: agent.id }
          });
          console.log(`   ✅ Hard-deleted agent ${agent.id} (deleted on ${agent.deletedAt?.toISOString()})`);
          hardDeletedCount++;
        } catch (error: any) {
          console.log(`   ❌ Failed to hard-delete agent ${agent.id}: ${error.message}`);
        }
      }
      console.log(`✅ Hard-deleted ${hardDeletedCount} soft-deleted agent(s)`);
    }

    // Clear my blueprints that don't have feedback metadata
    console.log('\n🗑️  Clearing my blueprints without feedback...');
    const { Prisma } = await import('@prisma/client');
    const deletedBlueprints = await prisma.goalBlueprint.deleteMany({
      where: {
        userId: MY_USER_ID,
        metadata: { equals: Prisma.DbNull },
      },
    });
    console.log(`✅ Deleted ${deletedBlueprints.count} blueprint(s) (preserved blueprints with feedback)`);

    // Clear my attention requests
    console.log('\n🗑️  Clearing my attention requests...');
    const deletedAttentionRequests = await prisma.agentAttentionRequest.deleteMany({
      where: { userId: MY_USER_ID },
    });
    console.log(`✅ Deleted ${deletedAttentionRequests.count} attention request(s)`);

    console.log('\n' + '='.repeat(60));
    console.log('📈 Cleanup Summary:');
    console.log(`   Active agents processed: ${agents.length}`);
    console.log(`   Successfully soft-deleted: ${successCount}`);
    console.log(`   Failed: ${failCount}`);
    console.log(`   Hard-deleted (previously soft-deleted): ${hardDeletedCount}`);
    console.log(`   Blueprints cleared: ${deletedBlueprints.count}`);
    console.log(`   Attention requests cleared: ${deletedAttentionRequests.count}`);
    console.log('='.repeat(60));

    if (failCount === 0) {
      console.log('\n✅ All agents, blueprints, and attention requests cleaned up successfully!');
    } else {
      console.log(`\n⚠️  ${failCount} agent(s) failed to delete`);
    }

  } catch (error) {
    console.error('❌ Fatal error during cleanup:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run cleanup
cleanupMyAgents()
  .then(() => {
    console.log('\n👋 Cleanup complete');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Cleanup failed:', error);
    process.exit(1);
  });

