#!/usr/bin/env tsx
/**
 * Check a specific workflow's details
 * Usage: tsx scripts/check-single-workflow.ts <workflow-id>
 */

import { config } from 'dotenv';
import { getTemporalClient } from '../src/lib/temporal';

config();

async function checkWorkflow() {
  const workflowId = process.argv[2] || '6d115f80-0614-422b-8508-094f81a4d7e1';
  
  console.log(`🔍 Checking workflow: ${workflowId}\n`);

  const client = await getTemporalClient();

  try {
    const handle = client.workflow.getHandle(workflowId);
    const description = await handle.describe();

    console.log('📊 Workflow Details:');
    console.log(`   Workflow ID: ${description.workflowId}`);
    console.log(`   Status: ${description.status.name}`);
    console.log(`   Task Queue: ${description.taskQueue}`);
    console.log(`   Workflow Type: ${description.type}`);
    console.log(`   Run ID: ${description.runId}`);
    console.log(`   Start Time: ${description.startTime}`);
    console.log(`   History Length: ${description.historyLength}`);
    
    if (description.status.name !== 'RUNNING') {
      console.log(`\n⚠️  Workflow is not running - it's ${description.status.name}`);
      console.log(`   This usually means it's waiting for a worker to pick it up.`);
    }
    
  } catch (error: any) {
    console.log(`❌ Error: ${error.message}`);
  }
}

checkWorkflow().catch(console.error);

