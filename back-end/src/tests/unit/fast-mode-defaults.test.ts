#!/usr/bin/env tsx
/**
 * Unit/structural tests for Fast Mode defaults across agent create + Rose complete.
 *
 * Run: npx tsx src/tests/unit/fast-mode-defaults.test.ts
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentSchema } from '../../domains/agents/types';
import {
  applyFastModeDefault,
  applyFastModeInheritance,
} from '../../domains/agents/agentExecutionMode';
import { buildAgentWorkflowArgs } from '../../providers/temporal';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`  ❌ ${name}\n`);
  }
}

test('root agents default Fast Mode on when flag is absent', () => {
  const body = createAgentSchema.parse({ goal: 'x' });
  applyFastModeDefault(body, '1f85ff25-6e29-4c1b-8739-f917bd101a30');
  assert.strictEqual(body.fast_mode_cache_enabled, true);
});

test('explicit Fast Mode off is preserved for root agents', () => {
  const body = createAgentSchema.parse({ goal: 'x', fast_mode_cache_enabled: false });
  applyFastModeDefault(body, '1f85ff25-6e29-4c1b-8739-f917bd101a30');
  assert.strictEqual(body.fast_mode_cache_enabled, false);
});

test('all accounts default Fast Mode on for root agents', () => {
  const body = createAgentSchema.parse({ goal: 'x' });
  applyFastModeDefault(body, '43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9');
  assert.strictEqual(body.fast_mode_cache_enabled, true);
});

test('non-allowlisted accounts also default Fast Mode on', () => {
  const body = createAgentSchema.parse({ goal: 'x' });
  applyFastModeDefault(body, '00000000-0000-4000-8000-000000000099');
  assert.strictEqual(body.fast_mode_cache_enabled, true);
});

test('sub-agents do not use root Fast Mode default', () => {
  const body = createAgentSchema.parse({
    goal: 'x',
    parent_agent_id: '00000000-0000-4000-8000-000000000001',
    parent_workflow_id: 'workflow-parent',
  });
  applyFastModeDefault(body, '1f85ff25-6e29-4c1b-8739-f917bd101a30');
  assert.strictEqual(body.fast_mode_cache_enabled, undefined);
});

test('sub-agents inherit Fast Mode read flag from parent when absent', () => {
  const body = createAgentSchema.parse({
    goal: 'x',
    parent_agent_id: '00000000-0000-4000-8000-000000000001',
    parent_workflow_id: 'workflow-parent',
  });
  applyFastModeInheritance(body, true);
  assert.strictEqual(body.fast_mode_cache_enabled, true);
});

test('sub-agents inherit Fast Mode off from parent when absent', () => {
  const body = createAgentSchema.parse({
    goal: 'x',
    parent_agent_id: '00000000-0000-4000-8000-000000000001',
    parent_workflow_id: 'workflow-parent',
  });
  applyFastModeInheritance(body, false);
  assert.strictEqual(body.fast_mode_cache_enabled, false);
});

test('explicit sub-agent Fast Mode off is not overwritten by inheritance', () => {
  const body = createAgentSchema.parse({
    goal: 'x',
    parent_agent_id: '00000000-0000-4000-8000-000000000001',
    parent_workflow_id: 'workflow-parent',
    fast_mode_cache_enabled: false,
  });
  applyFastModeInheritance(body, true);
  assert.strictEqual(body.fast_mode_cache_enabled, false);
});

test('batch-created sub-agents use parent Fast Mode inheritance', () => {
  const batchParentFlags = readFileSync(
    join(process.cwd(), 'src', 'domains', 'agents', 'agentBatchParentFlags.ts'),
    'utf8'
  );
  const batchService = readFileSync(
    join(process.cwd(), 'src', 'domains', 'agents', 'agentBatchService.ts'),
    'utf8'
  );
  assert.ok(
    batchService.includes('applyExecutionModeInheritanceForBatch'),
    'batch create must resolve parent execution-mode flags before insert/start'
  );
  assert.ok(
    batchParentFlags.includes('applyFastModeInheritance(body, parent?.fastModeCacheEnabled)'),
    'batch create must inherit Fast Mode from parent'
  );
});

test('SMS start_new_agent persists Fast Mode on and passes resolved flag into Temporal', () => {
  const startAgent = readFileSync(
    join(process.cwd(), 'src', 'providers', 'smsSupervisor', 'supervisorTools.startAgent.ts'),
    'utf8'
  );
  assert.ok(
    startAgent.includes('fastModeCacheEnabled: true'),
    'SMS agent create must set Fast Mode on the Agent row'
  );
  assert.ok(
    startAgent.includes('fastModeCacheEnabled: existing.fastModeCacheEnabled'),
    'SMS P2002 recovery must adopt the persisted Fast Mode flag'
  );
  assert.ok(
    /startAgentWorkflowExecution\(\{[\s\S]*fastModeCacheEnabled:\s*resolvedFastMode/.test(
      startAgent
    ),
    'SMS startAgentWorkflowExecution must pass the resolved Fast Mode flag'
  );
});

test('Temporal workflow args default Fast Mode on when callers omit the flag', () => {
  const args = buildAgentWorkflowArgs({
    agentId: 'a',
    userId: 'u',
    goal: 'g',
    model: 'rose-labs/rose-1-flash',
    reasoningMaxTokens: 2048,
    verifier: { type: 'FLOAT_LLM_JUDGE' },
  });
  assert.strictEqual(args[15], true);
});

test('Temporal workflow args force Fast Mode off for simulate mode', () => {
  const args = buildAgentWorkflowArgs({
    agentId: 'a',
    userId: 'u',
    goal: 'g',
    model: 'rose-labs/rose-1-flash',
    reasoningMaxTokens: 2048,
    verifier: { type: 'FLOAT_LLM_JUDGE' },
    worldModelMode: 'simulate',
  });
  assert.strictEqual(args[15], false);
});

test('Temporal workflow args force Fast Mode off for shadow mode even if explicitly true', () => {
  const args = buildAgentWorkflowArgs({
    agentId: 'a',
    userId: 'u',
    goal: 'g',
    model: 'rose-labs/rose-1-flash',
    reasoningMaxTokens: 2048,
    verifier: { type: 'FLOAT_LLM_JUDGE' },
    worldModelMode: 'shadow',
    fastModeCacheEnabled: true,
  });
  assert.strictEqual(args[15], false);
});

// Provider speed defaults and per-leg forwarding: agent-speed.test.ts.

if (failures.length > 0) {
  process.stderr.write(
    `\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`
  );
  process.exit(1);
}
process.stdout.write(`\n✅ fast-mode defaults: ${passed}/${passed} passed\n`);
