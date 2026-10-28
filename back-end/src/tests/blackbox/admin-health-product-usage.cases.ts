import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { findProductRootTasksBetween } from '../../domains/admin-health/repoProductUsage';
import { taskCompletionRate } from '../../domains/admin-health/taskStats';
import { ARCHIVED_AGENT_STATUS_MESSAGE } from '../../providers/agentKill';
import { prisma } from '../../providers/database';

/** Exercises the product cohort against real PostgreSQL in the admin-health gate. */
export async function testProductCompletionCohort(): Promise<void> {
  const customerId = randomUUID();
  const operatorId = randomUUID();
  const fixtureId = randomUUID();
  const unsubscribedId = randomUUID();
  const ids = Array.from({ length: 23 }, () => randomUUID());
  const start = new Date('2001-01-01T00:00:00.000Z');
  const end = new Date('2001-01-02T00:00:00.000Z');
  const at = new Date('2001-01-01T12:00:00.000Z');
  const goal = 'Test and benchmark my own website';
  try {
    await prisma.user.createMany({
      data: [
        { userId: customerId, name: 'Real Customer', email: `${customerId}@customer.dev` },
        { userId: operatorId, name: 'Core Teammate', phone: '+1 (713) 471-2306' },
        { userId: fixtureId, name: 'Fixture Person', email: `${fixtureId}@blackbox-test.dev` },
        { userId: unsubscribedId, name: 'Never Paid', email: `${unsubscribedId}@customer.dev` },
      ],
    });
    await prisma.agent.createMany({
      data: [
        { id: ids[0], userId: customerId, goal, status: 'COMPLETED', source: 'WEB' },
        { id: ids[1], userId: customerId, goal, status: 'FAILED', source: 'MAC_APP' },
        { id: ids[2], userId: customerId, goal, status: 'COMPLETED', isBenchmark: true },
        { id: ids[3], userId: customerId, goal, status: 'COMPLETED', worldModelMode: 'simulate' },
        { id: ids[4], userId: customerId, goal, status: 'COMPLETED', worldModelMode: 'shadow' },
        { id: ids[5], userId: customerId, goal, status: 'COMPLETED', depth: 1 },
        { id: ids[6], userId: fixtureId, goal, status: 'COMPLETED' },
        { id: ids[7], userId: operatorId, goal, status: 'COMPLETED' },
        // A real person: listed here; series.ts keeps them only while a Stripe subscriber.
        { id: ids[22], userId: unsubscribedId, goal, status: 'COMPLETED' },
        // A stale ordinary archive must not resurrect a live benchmark.
        { id: ids[8], userId: customerId, goal, status: 'COMPLETED', isBenchmark: true },
        { id: ids[12], userId: customerId, goal, status: 'FAILED', source: 'WHATSAPP' },
        // Still running: listed as usage, but it has no outcome for the rate yet.
        { id: ids[19], userId: customerId, goal, status: 'ACTIVE', source: 'WEB' },
        { id: ids[13], userId: customerId, goal, status: 'COMPLETED', parentAgentId: ids[0] },
        // Chat-only question: never entered the agent loop, so it is not a task run.
        { id: ids[18], userId: customerId, goal, status: 'COMPLETED' },
        // Archived while running: FAILED by the archive, but it never had an outcome.
        {
          id: ids[20],
          userId: customerId,
          goal,
          status: 'FAILED',
          statusMessage: ARCHIVED_AGENT_STATUS_MESSAGE,
          deletedAt: at,
        },
      ].map((row) => ({ ...row, createdAt: at })),
    });
    await prisma.toolUsage.createMany({
      data: [...ids.slice(0, 9), ids[12], ids[13], ids[18], ids[19], ids[20], ids[22]].map(
        (agentId) => ({
          agentId,
          userId: customerId,
          toolName: agentId === ids[18] ? 'chat_router' : 'web_search',
          totalCostCents: 0,
          usageItems: [],
        })
      ),
    });
    await prisma.goalHistory.createMany({
      data: [
        { originalAgentId: ids[0], status: 'FAILED' as const },
        { originalAgentId: ids[8], status: 'COMPLETED' as const },
        { originalAgentId: ids[9], status: 'COMPLETED' as const, isBenchmark: true },
        { originalAgentId: ids[10], status: 'COMPLETED' as const, worldModelMode: 'simulate' },
        { originalAgentId: ids[11], status: 'COMPLETED' as const },
        { originalAgentId: ids[11], status: 'COMPLETED' as const },
        { originalAgentId: ids[14], status: 'COMPLETED' as const, worldModelMode: 'shadow' },
        { originalAgentId: ids[15], status: 'COMPLETED' as const, userId: operatorId },
        { originalAgentId: ids[16], status: 'COMPLETED' as const, userId: fixtureId },
        { originalAgentId: ids[17], status: 'COMPLETED' as const },
        { originalAgentId: ids[21], status: 'COMPLETED' as const, wasAgentRun: false },
        {
          originalAgentId: ids[17],
          status: 'COMPLETED' as const,
          isBenchmark: true,
          agentUpdatedAt: new Date(at.getTime() + 1),
        },
      ].map((row) => ({
        userId: customerId,
        goal,
        model: 'rose-1-ultra',
        contextSize: 0,
        messageCount: 0,
        tokenCount: 0,
        tokensIn: 0,
        tokensOut: 0,
        source: 'SMS' as const,
        depth: 0,
        agentCreatedAt: at,
        agentUpdatedAt: at,
        wasAgentRun: true,
        ...row,
      })),
    });
    const tasks = await findProductRootTasksBetween(start, end);
    assert.deepEqual(
      tasks.map((task) => task.taskId).sort(),
      [ids[0], ids[1], ids[7], ids[11], ids[12], ids[15], ids[19], ids[20], ids[22]].sort(),
      'Core team + real people (subscription is applied per period in series.ts); fixture, benchmark, simulated, child and chat-only roots never count'
    );
    assert.deepEqual(
      tasks
        .filter((task) => task.coreTeam)
        .map((task) => task.taskId)
        .sort(),
      [ids[7], ids[15]].sort(),
      'Aman (matched by phone, no admin id) is core team, so his retried goals collapse'
    );
    assert.deepEqual(
      tasks.filter((task) => task.archivedBeforeOutcome).map((task) => task.taskId),
      [ids[20]],
      'Only the root archived while running is flagged as having no outcome'
    );
    assert.equal(
      taskCompletionRate(tasks),
      0.7143,
      'Completed / resolved runs; still-running and archived-while-running roots have no outcome'
    );
    assert.equal(
      taskCompletionRate(tasks.filter((task) => [ids[19], ids[20]].includes(task.taskId))),
      null,
      'No resolved task is null, never 0%'
    );
  } finally {
    await prisma.goalHistory.deleteMany({ where: { originalAgentId: { in: ids } } });
    await prisma.agent.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({
      where: { userId: { in: [customerId, operatorId, fixtureId, unsubscribedId] } },
    });
  }
}
