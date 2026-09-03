#!/usr/bin/env tsx

/**
 * Hub GET /tree?busId=<child> must return that child plus descendants,
 * not the full for_each fan-out. Root busId still returns the run tree.
 *
 * Run: npx tsx src/tests/unit/benchmark-hub-subtree.test.ts
 */

import assert from 'node:assert/strict';

import { subtreeAgentsForBus } from '../../providers/benchmarkHubView';

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write(`  fail ${name}\n`);
  }
}

const tree = [
  { agent_id: 'root', parent_agent_id: null, goal: 'root' },
  { agent_id: 'gp-a', parent_agent_id: 'root', goal: 'creator A' },
  { agent_id: 'gp-b', parent_agent_id: 'root', goal: 'creator B' },
  { agent_id: 'explore-a', parent_agent_id: 'gp-a', goal: 'explore A' },
];

test('root busId returns the full run tree', () => {
  const ids = subtreeAgentsForBus(tree, 'root').map((node) => node.agent_id);
  assert.deepEqual(ids, ['root', 'gp-a', 'gp-b', 'explore-a']);
});

test('child busId keeps that child plus descendants only', () => {
  const ids = subtreeAgentsForBus(tree, 'gp-a').map((node) => node.agent_id);
  assert.deepEqual(ids, ['gp-a', 'explore-a']);
});

test('sibling children are not leaked onto a child bus', () => {
  const ids = subtreeAgentsForBus(tree, 'gp-b').map((node) => node.agent_id);
  assert.deepEqual(ids, ['gp-b']);
});

test('unknown busId leaves the tree unchanged', () => {
  const ids = subtreeAgentsForBus(tree, 'missing').map((node) => node.agent_id);
  assert.deepEqual(ids, ['root', 'gp-a', 'gp-b', 'explore-a']);
});

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`\nbenchmark hub subtree: ${passed} passed\n`);
