#!/usr/bin/env tsx
/** The webhook supplement must be able to seed its real AgentCard Integration row. */
import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { PrismaClient } from '@prisma/client';

const databaseUrl = process.env.DATABASE_URL;
assert(databaseUrl, 'DATABASE_URL must be set by the isolated blackbox runner');
assert(
  ['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname),
  'gate fixture blackbox requires local PostgreSQL'
);

const userId = randomUUID();
const importSideEffectUserId = randomUUID();
process.env.BENCHMARK_USER_ID = importSideEffectUserId;
process.env.BENCHMARK_GATE_FIXTURE_MODE = 'source-connect';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await prisma.user.create({ data: { userId, isAnonymous: false } });
    const { seedOrgManagedAgentCardForUser } =
      await import('../../../scripts/gate-benchmark-fixture');
    await seedOrgManagedAgentCardForUser(userId, 'cardholder-blackbox-first', prisma);
    await seedOrgManagedAgentCardForUser(userId, 'cardholder-blackbox-second', prisma);

    const integrations = await prisma.integration.findMany({
      where: { userId, name: 'agentcard' },
    });
    assert.equal(integrations.length, 1, 're-seeding must update one AgentCard Integration row');
    assert.equal(integrations[0].accountId, '', 'the default AgentCard account must be selected');
    assert.equal(
      (integrations[0].config as { cardholderId?: string }).cardholderId,
      'cardholder-blackbox-second',
      're-seeding must persist the newest org cardholder'
    );
    assert.equal(
      await prisma.user.count({ where: { userId: importSideEffectUserId } }),
      0,
      'importing the seeding helper must not execute the gate fixture CLI'
    );
    console.log('PASS gate fixture AgentCard upsert, idempotency, and import safety');
  } finally {
    await prisma.integration.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
    await prisma.integration.deleteMany({ where: { userId: importSideEffectUserId } });
    await prisma.credit.deleteMany({ where: { userId: importSideEffectUserId } });
    await prisma.user.deleteMany({ where: { userId: importSideEffectUserId } });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
