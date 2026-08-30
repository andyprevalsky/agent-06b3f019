#!/usr/bin/env tsx

/**
 * Hub publish must slot archived Agent parent/child rows so the live
 * GET /ancestors CTE works on current prod FE (no frontend deploy).
 */

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';

import { findAgentWithRelations, findAncestors } from '../../domains/agents/repo';
import {
  HUB_ANCESTOR_SKELETON_MODEL,
  HUB_ANCESTOR_SKELETON_USER_ID,
  deleteHubAncestorSkeletons,
  hubAncestorNodesFromBundle,
  slotHubAncestorSkeletons,
} from '../../providers/benchmarkHubAncestors';
import { prisma } from '../../providers/database';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write(`  fail ${name}\n`);
  }
}

function finish(): void {
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write(`\nbenchmark hub ancestor skeletons: ${passed} passed\n`);
}

function bundle(runId: string, rootId: string, childId: string): Record<string, unknown> {
  return {
    run_id: runId,
    tasks: [
      {
        name: 'mass-agent',
        passed: true,
        agent_id: rootId,
        logs: {
          messages: [{ role: 'USER', message: 'root goal' }],
          tree: {
            [rootId]: { parent_agent_id: null, goal: 'root goal', status: 'COMPLETED' },
            [childId]: { parent_agent_id: rootId, goal: 'gp goal', status: 'COMPLETED' },
          },
        },
      },
    ],
  };
}

async function testSlotsCteReadableParentChain(): Promise<void> {
  const rootId = randomUUID();
  const childId = randomUUID();
  const nodes = hubAncestorNodesFromBundle(bundle(`run-${rootId}`, rootId, childId));
  try {
    const written = await slotHubAncestorSkeletons(nodes);
    assert.strictEqual(written, 2, `expected 2 skeletons, wrote ${written}`);

    const liveMiss = await findAgentWithRelations(childId);
    assert.strictEqual(liveMiss, null, 'skeleton must not shadow GET /agents hub fallback');

    const ancestors = await findAncestors(childId);
    assert.strictEqual(ancestors.length, 1, `CTE ancestors ${ancestors.length} != 1`);
    assert.strictEqual(ancestors[0]?.id, rootId);
    assert.strictEqual(ancestors[0]?.goal, 'root goal');

    const child = await prisma.agent.findUnique({ where: { id: childId } });
    assert.ok(child?.deletedAt, 'skeleton must be archived');
    assert.strictEqual(child?.userId, HUB_ANCESTOR_SKELETON_USER_ID);
    assert.strictEqual(child?.model, HUB_ANCESTOR_SKELETON_MODEL);
    assert.strictEqual(child?.parentAgentId, rootId);
  } finally {
    await deleteHubAncestorSkeletons([rootId, childId]);
  }
}

async function testDoesNotOverwriteLiveAgent(): Promise<void> {
  const rootId = randomUUID();
  const childId = randomUUID();
  await prisma.agent.create({
    data: { id: rootId, userId: `live-${rootId}`, goal: 'LIVE ROOT', status: 'ACTIVE' },
  });
  try {
    await slotHubAncestorSkeletons([
      { id: rootId, parentAgentId: null, busId: rootId, goal: 'hub root', status: 'COMPLETED' },
      { id: childId, parentAgentId: rootId, busId: rootId, goal: 'gp goal', status: 'COMPLETED' },
    ]);
    const live = await prisma.agent.findUnique({ where: { id: rootId } });
    assert.strictEqual(live?.goal, 'LIVE ROOT');
    assert.strictEqual(live?.deletedAt, null);
    assert.strictEqual(live?.userId, `live-${rootId}`);

    const ancestors = await findAncestors(childId);
    assert.strictEqual(ancestors[0]?.id, rootId);
    assert.strictEqual(ancestors[0]?.goal, 'LIVE ROOT');
  } finally {
    await deleteHubAncestorSkeletons([childId]);
    await prisma.agent.deleteMany({ where: { id: { in: [rootId, childId] } } });
  }
}

await test(
  'slots archived parent/child so the live ancestors CTE works',
  testSlotsCteReadableParentChain
);
await test('never overwrites a live Agent row', testDoesNotOverwriteLiveAgent);
finish();
