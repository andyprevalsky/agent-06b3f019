import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { findProductRootTasksBetween } from '../../domains/admin-health/repoProductUsage';
import { taskCompletionRate } from '../../domains/admin-health/taskStats';
import { prisma } from '../../providers/database';

/** Exercises the product cohort against real PostgreSQL in the admin-health gate. */
export async function testProductCompletionCohort(): Promise<void> {
  const customerId = randomUUID();
  const operatorId = randomUUID();
  const fixtureId = randomUUID();
  const ids = Array.from({ length: 19 }, () => randomUUID());
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
        // A stale ordinary archive must not resurrect a live benchmark.
        { id: ids[8], userId: customerId, goal, status: 'COMPLETED', isBenchmark: true },
        { id: ids[12], userId: customerId, goal, status: 'FAILED', source: 'WHATSAPP' },
        { id: ids[13], userId: customerId, goal, status: 'COMPLETED', parentAgentId: ids[0] },
        {
          id: ids[18],
          userId: '1f85ff25-6e29-4c1b-8739-f917bd101a30',
          goal,
          status: 'COMPLETED',
        },
      ].map((row) => ({ ...row, createdAt: at })),
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
        ...row,
      })),
    });
    const tasks = await findProductRootTasksBetween(start, end);
    assert.deepEqual(
      tasks.map((task) => task.taskId).sort(),
      [ids[0], ids[1], ids[11], ids[12]].sort(),
      'Only customer product roots count; benchmark/test/operator/simulated roots never count'
    );
    assert.equal(
      taskCompletionRate(tasks),
      0.5,
      'Both numerator and denominator use product usage'
    );
  } finally {
    await prisma.goalHistory.deleteMany({ where: { originalAgentId: { in: ids } } });
    await prisma.agent.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({
      where: { userId: { in: [customerId, operatorId, fixtureId] } },
    });
  }
}
