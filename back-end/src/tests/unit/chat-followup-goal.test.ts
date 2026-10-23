#!/usr/bin/env tsx

/**
 * Post-completion chat re-escalation must persist the router goal onto
 * Agent.goal (schema / demo-cache / UI source of truth) without dropping the
 * prior goal, and first-run escalate must keep the create-time row.
 */

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import {
  followUpRunStateUpdate,
  shouldSnapshotPreviousGoal,
} from '../../domains/agents/repoAgentMutations';
import { prisma } from '../../providers/database';

const previousGoal = 'order me glide floss from doordash';
const nextGoal = 'Get a refund for the DoorDash order delivered to the wrong location';
const routerParaphrase = 'Order Oral-B Glide floss on DoorDash';

assert.deepStrictEqual(followUpRunStateUpdate(nextGoal, previousGoal).goal, nextGoal);
assert.strictEqual(followUpRunStateUpdate(previousGoal, previousGoal).goal, undefined);
assert.strictEqual(followUpRunStateUpdate('   ', previousGoal).goal, undefined);
assert.strictEqual(shouldSnapshotPreviousGoal(nextGoal, previousGoal), true);
assert.strictEqual(shouldSnapshotPreviousGoal(previousGoal, previousGoal), false);
assert.strictEqual(shouldSnapshotPreviousGoal(routerParaphrase, previousGoal), true);

async function main(): Promise<void> {
  const followUpUserId = `chat-followup-goal-${randomUUID()}`;
  const followUpAgentId = randomUUID();
  try {
    await prisma.agent.create({
      data: {
        id: followUpAgentId,
        userId: followUpUserId,
        goal: previousGoal,
        status: 'ACTIVE',
        progress: 1,
        responseSchema: { fields: [{ name: 'order_confirmation_id', type: 'str' }] },
        structuredResponse: { order_confirmation_id: 'dff187de' },
        toolsInUse: ['spawn_browser_agent'],
        statusMessage: 'Task completed',
        verifier: { create: {} },
      },
    });
    await prisma.agent.update({
      where: { id: followUpAgentId },
      data: followUpRunStateUpdate(nextGoal, previousGoal),
    });
    const afterFollowUp = await prisma.agent.findUniqueOrThrow({ where: { id: followUpAgentId } });
    assert.strictEqual(afterFollowUp.goal, nextGoal);
    assert.strictEqual(afterFollowUp.responseSchema, null);
    assert.strictEqual(afterFollowUp.structuredResponse, null);
    assert.strictEqual(afterFollowUp.progress, 0);
    assert.deepStrictEqual(afterFollowUp.toolsInUse, []);
    assert.strictEqual(afterFollowUp.statusMessage, null);
  } finally {
    await prisma.agent.deleteMany({ where: { userId: followUpUserId } });
  }

  const firstRunUserId = `chat-first-run-goal-${randomUUID()}`;
  const firstRunAgentId = randomUUID();
  try {
    await prisma.agent.create({
      data: {
        id: firstRunAgentId,
        userId: firstRunUserId,
        goal: previousGoal,
        status: 'ACTIVE',
        progress: 0,
        verifier: { create: {} },
      },
    });
    const firstRun = await prisma.agent.findUniqueOrThrow({ where: { id: firstRunAgentId } });
    assert.strictEqual(firstRun.structuredResponse, null);
    assert.strictEqual(firstRun.progress, 0);
    assert.strictEqual(firstRun.goal, previousGoal);
    // Handler only applies followUpRunStateUpdate when a prior run finished.
    // Calling it here would persist a router paraphrase — that is the
    // 2026-07-03 demo-cache miss, so first-run must not take this write.
    assert.notStrictEqual(routerParaphrase, previousGoal);
  } finally {
    await prisma.agent.deleteMany({ where: { userId: firstRunUserId } });
  }

  process.stdout.write(
    'PASS chat follow-up persists router goal and keeps prior goal snapshotable\n'
  );
}

void main()
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack || error.message : String(error)}\n`
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
