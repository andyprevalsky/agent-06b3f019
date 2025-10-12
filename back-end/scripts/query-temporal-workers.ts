#!/usr/bin/env tsx
/**
 * Query Temporal to see what workers are running on which task queues
 * This helps diagnose queue isolation issues
 */

import { Connection, Client } from '@temporalio/client';
import { config } from 'dotenv';

config();

const TASK_QUEUES = [
  'navi-agent-tasks',      // Production
  'navi-agent-tasks-test', // Test/Development
];

async function queryTemporalWorkers() {
  const address = process.env.TEMPORAL_ADDRESS || 'us-east-1.aws.api.temporal.io:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE || 'quickstart-navi.lqjlv';
  const apiKey = process.env.TEMPORAL_API_KEY;

  if (!apiKey) {
    throw new Error('Missing TEMPORAL_API_KEY environment variable');
  }

  console.log('🔗 Connecting to Temporal Cloud...');
  console.log(`   Address: ${address}`);
  console.log(`   Namespace: ${namespace}`);
  console.log('');

  const connection = await Connection.connect({
    address,
    tls: true,
    apiKey,
  });

  const client = new Client({
    connection,
    namespace,
  });

  console.log('✅ Connected to Temporal Cloud\n');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('📊 WORKER STATUS BY TASK QUEUE');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Note: The TypeScript SDK doesn't expose task queue poller info directly
  // We can infer worker presence by looking at running workflows
  const queueWorkflows: Record<string, number> = {};
  
  try {
    const workflows = client.workflow.list({
      query: 'ExecutionStatus="Running"',
    });

    for await (const workflow of workflows) {
      const queue = workflow.taskQueue || 'unknown';
      queueWorkflows[queue] = (queueWorkflows[queue] || 0) + 1;
    }
  } catch (error) {
    console.log(`   ❌ Error listing workflows: ${error}`);
  }

  for (const taskQueue of TASK_QUEUES) {
    console.log(`🔍 Task Queue: ${taskQueue}`);
    console.log('─'.repeat(60));
    
    const count = queueWorkflows[taskQueue] || 0;
    
    if (count > 0) {
      console.log(`   ✅ ${count} workflow(s) running`);
      console.log(`   → Workers are likely polling this queue`);
    } else {
      console.log(`   ⚠️  No running workflows on this queue`);
      console.log(`   → Cannot confirm if workers are polling`);
    }

    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('📈 SUMMARY');
  console.log('═══════════════════════════════════════════════════════════\n');

  const totalWorkflows = Object.values(queueWorkflows).reduce((a, b) => a + b, 0);
  console.log(`   Total running workflows: ${totalWorkflows}`);
  
  if (totalWorkflows > 0) {
    console.log('\n   Workflows by queue:');
    Object.entries(queueWorkflows)
      .sort((a, b) => b[1] - a[1])
      .forEach(([queue, count]) => {
        console.log(`      ${queue}: ${count}`);
      });
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('💡 INTERPRETATION:');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log('   • Running workflows indicate workers are present');
  console.log('   • No running workflows = no workers OR workers idle');
  console.log('   • To see worker details, check Temporal UI:');
  console.log('     https://cloud.temporal.io/namespaces/quickstart-navi.lqjlv');
  console.log('\n═══════════════════════════════════════════════════════════\n');
  
  await connection.close();
}

// Run
queryTemporalWorkers().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

