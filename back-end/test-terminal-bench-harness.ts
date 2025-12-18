/**
 * Standalone test for Terminal-Bench harness
 * Tests sampling and Harbor integration without needing full auth
 */

// Load environment variables
import { config } from 'dotenv';
config();

import { TerminalBenchHarness } from './src/benchmarks/harnesses/terminal-bench';

async function testTerminalBenchHarness() {
  console.log('🧪 Testing Terminal-Bench Harness Integration\n');
  
  const harness = new TerminalBenchHarness();
  
  // Test 1: Load dataset
  console.log('1️⃣ Loading full dataset of 89 tasks...');
  const allTasks = await harness.loadDataset();
  console.log(`   ✓ Loaded ${allTasks.length} tasks\n`);
  
  // Test 2: Sample 3 tasks
  console.log('2️⃣ Sampling 3 tasks using seed=42...');
  const sampledTasks = harness.sampleQuestions(allTasks, 3, 42);
  console.log(`   ✓ Sampled ${sampledTasks.length} tasks:`);
  sampledTasks.forEach((task, i) => {
    console.log(`      ${i + 1}. ${task.id} -> Harbor ID: ${task.harborTaskId}`);
  });
  console.log();
  
  // Test 3: Extract Harbor task names
  console.log('3️⃣ Extracting Harbor task names...');
  const harborTaskNames = sampledTasks
    .map((t: any) => t.harborTaskName)
    .filter(Boolean);
  console.log(`   ✓ Harbor task names: ${harborTaskNames.join(', ')}\n`);
  
  // Test 4: Check Harbor installation
  console.log('4️⃣ Checking Harbor installation...');
  const { harborClient } = await import('./src/benchmarks/harbor-client');
  const isInstalled = await harborClient.checkInstalled();
  console.log(`   ${isInstalled ? '✓' : '✗'} Harbor installed: ${isInstalled}\n`);
  
  if (!isInstalled) {
    console.log('⚠️  Harbor not installed. Install with: uv tool install harbor');
    console.log('   Then set DAYTONA_API_KEY and ANTHROPIC_API_KEY in your environment.\n');
    return;
  }
  
  // Test 5: Dry run - show what would be executed
  console.log('5️⃣ Dry run - Command that would be executed:');
  const model = 'rose-labs/rose-1-lite';  // Rose model via custom agent
  const agent = 'rose-agent';
  const environment = 'daytona';
  
  console.log(`   harbor run -d terminal-bench@2.0 -m ${model} -a ${agent} --env ${environment} -n ${harborTaskNames.length}`);
  harborTaskNames.forEach(name => {
    console.log(`     --task-name ${name}`);
  });
  console.log();
  
  console.log('⚠️  COST & TIME ESTIMATE:');
  console.log(`   - Running ${harborTaskNames.length} task(s)`);
  console.log(`   - Using Rose Agent (calls Rose API)`);
  console.log(`   - Estimated cost: ~$${harborTaskNames.length * 0.5} (Rose is cheaper!)`);
  console.log(`   - Estimated time: ~${harborTaskNames.length * 5} minutes`);
  console.log();
  
  // Actually run Harbor
  console.log('6️⃣ Running Harbor with Rose Agent...\n');
  
  const result = await harness.runBatch(harborTaskNames, model, { agent, environment, seed: 42 });
  
  console.log(`\n✅ Harbor execution complete!`);
  console.log(`   Result: ${result.tasks.length} tasks completed`);
  result.tasks.forEach((task, i) => {
    console.log(`      ${i + 1}. ${task.id}: ${task.success ? '✓ PASS' : '✗ FAIL'} (${task.durationMs}ms)`);
  });
  
  const passCount = result.tasks.filter(t => t.success).length;
  const accuracy = (passCount / result.tasks.length * 100).toFixed(1);
  console.log(`\n📊 Accuracy: ${accuracy}% (${passCount}/${result.tasks.length})`);
  
  console.log('\n✅ Terminal-Bench harness validated successfully!');
}

// Run tests
testTerminalBenchHarness().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});

