#!/usr/bin/env tsx

/**
 * Post-completion chat re-escalation must persist the router goal onto
 * Agent.goal (schema / fast-cache / UI source of truth) without dropping the
 * prior goal, and first-run escalate must keep the create-time row.
 */

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import {
  followUpRunStateUpdate,
  shouldSnapshotPreviousGoal,
} from '../../domains/agents/repoAgentMutations';
import { prisma } from '../../providers/database';
import { createTestHarness } from './[REDACTED]-test-utils';

const { test, finish } = createTestHarness('chat follow-up goal persist');

assert.deepStrictEqual(
  followUpRunStateUpdate(
    'Get a refund for the DoorDash order delivered to the wrong location',
    'order me glide floss from doordash'
  ).goal,
  'Get a refund for the DoorDash order delivered to the wrong location'
);
assert.strictEqual(
  followUpRunStateUpdate('order me glide floss from doordash', 'order me glide floss from doordash')
    .goal,
  undefined
);
assert.strictEqual(followUpRunStateUpdate('   ', 'order me glide floss from doordash').goal, undefined);
assert.strictEqual(
  shouldSnapshotPreviousGoal(
    'Get a refund for the DoorDash order delivered to the wrong location',
    'order me glide floss from doordash'
  ),
  true
);
assert.strictEqual(
  shouldSnapshotPreviousGoal('order me glide floss from doordash', 'order me glide floss from doordash'),
  false
);

async function main(): Promise<void> {
  await test('follow-up write persists router goal and keeps prior goal readable', async () => {
    const runId = `chat-followup-goal-${randomUUID()}`;
    const agentId = randomUUID();
    const previousGoal = 'order me glide floss from doordash';
    const nextGoal = 'Get a refund for the DoorDash order delivered to the wrong location';
    try {
      await prisma.agent.create({
        data: {
          id: agentId,
          userId: runId,
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
        where: { id: agentId },
        data: followUpRunStateUpdate(nextGoal, previousGoal),
      });
      const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(after.goal, nextGoal);
      assert.strictEqual(after.responseSchema, null);
      assert.strictEqual(after.structuredResponse, null);
      assert.strictEqual(after.progress, 0);
      assert.deepStrictEqual(after.toolsInUse, []);
      assert.strictEqual(after.statusMessage, null);
      assert.strictEqual(shouldSnapshotPreviousGoal(nextGoal, previousGoal), true);
    } finally {
      await prisma.agent.deleteMany({ where: { userId: runId } });
    }
  });

  await test('first-run escalate shape does not rewrite create-time Agent.goal', async () => {
    const runId = `chat-first-run-goal-${randomUUID()}`;
    const agentId = randomUUID();
    const createTimeGoal = 'order me glide floss from doordash';
    const routerParaphrase = 'Order Oral-B Glide floss on DoorDash';
    try {
      await prisma.agent.create({
        data: {
          id: agentId,
          userId: runId,
          goal: createTimeGoal,
          status: 'ACTIVE',
          progress: 0,
          verifier: { create: {} },
        },
      });
      const before = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(before.structuredResponse, null);
      assert.strictEqual(before.progress, 0);
      // Handler only calls followUpRunStateUpdate when structuredResponse or
      // progress says a prior run finished. First-run must not persist the
      // router paraphrase (2026-07-03 fast-cache namespace).
      assert.notStrictEqual(routerParaphrase, createTimeGoal);
      const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(after.goal, createTimeGoal);
    } finally {
      await prisma.agent.deleteMany({ where: { userId: runId } });
    }
  });

  await finish();
}

void main();
