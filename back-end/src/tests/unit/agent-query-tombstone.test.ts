#!/usr/bin/env tsx
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import {
  getAgentDetail,
  tombstoneSkipsBenchmarkHub,
} from '../../domains/agents/agentQueryService';

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  process.stderr.write(`  ✅ ${name}\n`);
}

async function main(): Promise<void> {
  await test('GET detail of a soft-deleted agent 404s without consulting a warming hub', async () => {
    const userId = `tombstone-${randomUUID()}`;
    const agentId = randomUUID();
    await prisma.user.create({ data: { userId, isAnonymous: true } });
    try {
      await prisma.agent.create({
        data: {
          id: agentId,
          userId,
          goal: 'Tombstone GET must not 503',
          status: 'ACTIVE',
          busId: agentId,
          deletedAt: new Date(),
        },
      });

      const result = await getAgentDetail(agentId, {
        userId,
        allowBenchmarkArchive: true,
      });
      assert.strictEqual(
        result,
        null,
        'soft-deleted local agents must 404 instead of hitting Benchmark Hub'
      );

      assert.strictEqual(
        tombstoneSkipsBenchmarkHub({ isBenchmark: false }),
        true,
        'non-bench tombstones must skip hub'
      );
      assert.strictEqual(
        tombstoneSkipsBenchmarkHub({ isBenchmark: true }),
        false,
        'benchmark tombstones must still consult hub'
      );
      assert.strictEqual(tombstoneSkipsBenchmarkHub(null), false);
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
      await prisma.user.deleteMany({ where: { userId } });
    }
  });
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
