#!/usr/bin/env tsx
/** Regression coverage for provider-resolution failures in purchase reuse and cleanup loops. */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { ROSE_AGENT_CARD_ID } from '../../providers/card-provider/static-card';
import { prisma } from '../../providers/database';
import {
  cleanupAgentPurchaseCards,
  reconcileDissolvedPurchaseHolds,
} from '../../providers/purchaseCleanup';
import { FakeWalletFundingProvider, withFakeStripe } from '../blackbox/purchases.testkit';

const STATIC_CARD_ENV = {
  ROSE_AGENT_CARD_PAN: '4111111111111111',
  ROSE_AGENT_CARD_CVV: '321',
  ROSE_AGENT_CARD_EXPIRY: '11/30',
  ROSE_AGENT_CARD_PIN: '4242',
};
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

async function seedHeldPair(): Promise<{
  userId: string;
  agentId: string;
  purchaseIds: string[];
}> {
  const userId = `provider-boundary-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  createdUserIds.push(userId);
  const agent = await prisma.agent.create({
    data: { userId, goal: 'provider resolution boundary', status: 'COMPLETED' as never },
  });
  const purchaseIds: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const purchase = await prisma.purchaseSpend.create({
      data: {
        userId,
        agentId: agent.id,
        fingerprint: `fp-${randomUUID()}`,
        merchant: 'Provider Boundary Merchant',
        lineItemsJson: { totalCents: 1080 },
        totalCents: 1080,
        status: PurchaseSpendStatus.HELD,
        cardId: ROSE_AGENT_CARD_ID,
        stripePaymentIntentId: `pi_${randomUUID()}`,
      },
    });
    purchaseIds.push(purchase.id);
    await prisma.purchaseWalletFunding.create({
      data: {
        purchaseId: purchase.id,
        userId,
        amountCents: 1080,
        currency: 'usd',
        status: PurchaseWalletFundingStatus.FUNDED,
        providerTransferId: `owt_${randomUUID()}`,
        idempotencyKey: `purchase-wallet-fund:${purchase.id}`,
      },
    });
  }
  return { userId, agentId: agent.id, purchaseIds };
}

async function withStaticCardEnv<T>(fn: () => Promise<T>): Promise<T> {
  const envKeys = [
    'AGENTCARD_MINT_ENABLED',
    'BENCHMARK_MODE',
    'BENCHMARK_ISOLATED_RUN',
    ...Object.keys(STATIC_CARD_ENV),
  ];
  const prevEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  delete process.env.AGENTCARD_MINT_ENABLED;
  delete process.env.BENCHMARK_MODE;
  delete process.env.BENCHMARK_ISOLATED_RUN;
  Object.assign(process.env, STATIC_CARD_ENV);
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function withFailingFirstAgentLookup(fn: () => Promise<void>): Promise<number> {
  const agentDelegate = prisma.agent as unknown as {
    findUnique: typeof prisma.agent.findUnique;
  };
  const originalFindUnique = agentDelegate.findUnique;
  let lookupCount = 0;
  agentDelegate.findUnique = (async () => {
    lookupCount += 1;
    if (lookupCount === 1) throw new Error('benchmark lookup unavailable');
    return { isBenchmark: false };
  }) as typeof prisma.agent.findUnique;
  try {
    await fn();
  } finally {
    agentDelegate.findUnique = originalFindUnique;
  }
  return lookupCount;
}

async function assertOneHeldAndOneVoided(purchaseIds: string[]): Promise<void> {
  const rows = await prisma.purchaseSpend.findMany({
    where: { id: { in: purchaseIds } },
    select: { status: true },
  });
  assert.deepEqual(
    rows.map((row) => row.status).sort(),
    [PurchaseSpendStatus.HELD, PurchaseSpendStatus.VOIDED].sort()
  );
}

async function main(): Promise<void> {
  process.stdout.write('Running purchase provider-resolution boundary tests...\n');

  await test('cleanup isolates benchmark routing failures to one purchase', async () => {
    const { agentId, purchaseIds } = await seedHeldPair();
    const lookupCount = await withStaticCardEnv(() =>
      withFailingFirstAgentLookup(() =>
        withFakeStripe(async () => {
          await cleanupAgentPurchaseCards(agentId, undefined, new FakeWalletFundingProvider());
        })
      )
    );
    assert.equal(lookupCount, 2, 'cleanup continues to the second purchase');
    await assertOneHeldAndOneVoided(purchaseIds);
  });

  await test('dissolved-hold reconciliation isolates benchmark routing failures', async () => {
    const { userId, purchaseIds } = await seedHeldPair();
    const lookupCount = await withStaticCardEnv(() =>
      withFailingFirstAgentLookup(() =>
        withFakeStripe(
          async () => {
            await reconcileDissolvedPurchaseHolds(undefined, new FakeWalletFundingProvider(), {
              userId,
            });
          },
          { retrievePaymentIntent: () => ({ id: 'pi', status: 'canceled', amount_capturable: 0 }) }
        )
      )
    );
    assert.equal(lookupCount, 2, 'reconciliation continues to the second purchase');
    await assertOneHeldAndOneVoided(purchaseIds);
  });

  process.stdout.write(
    `\nPurchase provider-resolution boundary tests: ${passed} passed, ${failures.length} failed\n`
  );
  for (const failure of failures) process.stdout.write(`  ${failure}\n`);
}

async function cleanup(): Promise<void> {
  for (const userId of createdUserIds) {
    await prisma.purchaseSpend.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { userId } });
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
