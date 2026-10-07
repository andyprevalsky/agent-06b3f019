#!/usr/bin/env tsx
/**
 * Terminal status broadcasts must publish a null workflow id even when the
 * row still holds a leftover id. Omitting the field left AGENT_MODE_STARTED
 * composers on Stop after COMPLETED.
 *
 * Run: npx tsx src/tests/unit/status-broadcast-workflow-id.test.ts
 */

import assert from 'node:assert/strict';
import { workflowIdForStatusBroadcast } from '../../domains/agents/statusBroadcastWorkflowId';

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

test('COMPLETED publishes null even with a leftover workflow id', () => {
  assert.equal(workflowIdForStatusBroadcast('COMPLETED', 'wf-old'), null);
});

test('FAILED / OUT_OF_CREDITS / COST_LIMIT_REACHED publish null', () => {
  assert.equal(workflowIdForStatusBroadcast('FAILED', 'wf-old'), null);
  assert.equal(workflowIdForStatusBroadcast('OUT_OF_CREDITS', 'wf-old'), null);
  assert.equal(workflowIdForStatusBroadcast('COST_LIMIT_REACHED', 'wf-old'), null);
});

test('ACTIVE and PAUSED keep the live workflow id', () => {
  assert.equal(workflowIdForStatusBroadcast('ACTIVE', 'wf-live'), 'wf-live');
  assert.equal(workflowIdForStatusBroadcast('PAUSED', 'wf-live'), 'wf-live');
});

test('ACTIVE with no workflow id publishes null', () => {
  assert.equal(workflowIdForStatusBroadcast('ACTIVE', null), null);
});

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}

process.stdout.write(`status-broadcast-workflow-id: ${passed} passed\n`);
