#!/usr/bin/env tsx

/**
 * Cleanup Script: Delete All Agents and Terminate Workflows
 * 
 * This script will:
 * 1. Find all non-deleted agents in the database
 * 2. Terminate their Temporal workflows
 * 3. Soft-delete them from the database
 */

import { prisma } from '../src/lib/prisma';
import { getTemporalClient } from '../src/lib/temporal';
import * as dotenv from 'dotenv';

dotenv.config();

async function cleanupAllAgents() {
  console.log('🧹 Starting cleanup of all agents...\n');

  try {
    // Get all non-deleted agents
    const agents = await prisma.agent.findMany({
      where: {
        deletedAt: null,
      },
      select: {
        id: true,
        userId: true,
        goal: true,
        status: true,
        temporalWorkflowId: true,
      },
    });

    console.log(`📊 Found ${agents.length} active agents\n`);

    if (agents.length === 0) {
      console.log('✅ No agents to clean up!');
      return;
    }

    // Initialize Temporal client
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

    console.log('\n' + '='.repeat(60));
    console.log('📈 Cleanup Summary:');
    console.log(`   Total agents: ${agents.length}`);
    console.log(`   Successfully deleted: ${successCount}`);
    console.log(`   Failed: ${failCount}`);
    console.log('='.repeat(60));

    if (failCount === 0) {
      console.log('\n✅ All agents cleaned up successfully!');
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
cleanupAllAgents()
  .then(() => {
    console.log('\n👋 Cleanup complete');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Cleanup failed:', error);
    process.exit(1);
  });

