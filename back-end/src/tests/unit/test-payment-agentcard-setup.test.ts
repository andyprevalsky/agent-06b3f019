#!/usr/bin/env tsx
/**
 * Unit tests for benchmark AgentCard setup toggles in test-payment/service.ts.
 * Split from test-payment-service.test.ts to stay under max-lines.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { configureBenchmarkAgentCardSetup } from '../../domains/test-payment/service';

const createdUserIds: string[] = [];
let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  PASS ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`  FAIL ${name}\n`);
  }
}

async function seedUser(): Promise<string> {
  const userId = `test-payment-agentcard-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  createdUserIds.push(userId);
  return userId;
}

async function main(): Promise<void> {
  await test('configureBenchmarkAgentCardSetup toggles connect/reset state', async () => {
    const userId = await seedUser();
    await assert.rejects(
      () => configureBenchmarkAgentCardSetup({ action: 'complete' }),
      /userId is required/
    );
    await assert.rejects(
      () => configureBenchmarkAgentCardSetup({ userId, action: 'nonsense' }),
      /action must be reset or complete/
    );
    const connected = await configureBenchmarkAgentCardSetup(
      { userId, action: 'complete' },
      {
        resolveCardholderId: async () => 'cardholder-live-fixture',
        getCardholderVerificationStatus: async () => 'verified',
      }
    );
    assert.equal(connected.status, 'connected');
    const row = await prisma.integration.findUnique({
      where: { userId_name: { userId, name: 'agentcard' } },
    });
    const config = row?.config as { orgManaged?: boolean; cardholderId?: string };
    assert.equal(config?.orgManaged, true);
    assert.equal(config?.cardholderId, 'cardholder-live-fixture');
    const reset = await configureBenchmarkAgentCardSetup({ userId, action: 'reset' });
    assert.equal(reset.status, 'connect_required');
    const resetRow = await prisma.integration.findUnique({
      where: { userId_name: { userId, name: 'agentcard' } },
    });
    const resetConfig = resetRow?.config as {
      onboardingSessionId?: string;
    };
    assert.equal(resetRow?.status, 'NOT_CONNECTED');
    assert.equal(resetConfig?.onboardingSessionId, `benchmark-agentcard-onboarding-${userId}`);
  });

  await test('configureBenchmarkAgentCardSetup ignores stale BENCHMARK cardholder override', async () => {
    const userId = await seedUser();
    const previous = process.env.BENCHMARK_AGENTCARD_CARDHOLDER_ID;
    process.env.BENCHMARK_AGENTCARD_CARDHOLDER_ID = 'cardholder-stale-missing';
    try {
      const connected = await configureBenchmarkAgentCardSetup(
        { userId, action: 'complete' },
        {
          resolveCardholderId: async () => 'cardholder-from-list',
          getCardholderVerificationStatus: async () => 'verified',
        }
      );
      assert.equal(connected.status, 'connected');
      const row = await prisma.integration.findUnique({
        where: { userId_name: { userId, name: 'agentcard' } },
      });
      const config = row?.config as { cardholderId?: string };
      assert.equal(config?.cardholderId, 'cardholder-from-list');
    } finally {
      if (previous === undefined) delete process.env.BENCHMARK_AGENTCARD_CARDHOLDER_ID;
      else process.env.BENCHMARK_AGENTCARD_CARDHOLDER_ID = previous;
    }
  });

  process.stdout.write(
    `\nTest-payment AgentCard setup unit tests: ${passed} passed, ${failures.length} failed\n`
  );
  for (const failure of failures) process.stdout.write(`  ${failure}\n`);
}

async function cleanup(): Promise<void> {
  for (const userId of createdUserIds) {
    await prisma.integration.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
  await prisma.$disconnect();
}

main()
  .then(async () => {
    await cleanup();
    if (failures.length > 0) process.exit(1);
  })
  .catch(async (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    await cleanup();
    process.exit(1);
  });
