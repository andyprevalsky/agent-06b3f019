#!/usr/bin/env tsx
/** Terminal purchase rows must certify Stripe reversal, including interrupted pre-card work. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import {
  reconcileFailedPurchaseRefunds,
  reconcileStaleChargingPurchases,
} from '../../providers/purchaseCleanup';
import {
  capturedPaymentIntent,
  FakeWalletFundingProvider,
  withFakeStripe,
} from './purchases.testkit';

config();
const users: string[] = [];

async function fixture() {
  const userId = `purchase-stale-reversal-${randomUUID()}`;
  users.push(userId);
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  const purchase = await prisma.purchaseSpend.create({
    data: {
      userId,
      fingerprint: randomUUID(),
      merchant: 'Stale reversal fixture',
      lineItemsJson: {},
      totalCents: 1000,
      status: 'CHARGING',
      stripePaymentIntentId: `pi_${randomUUID()}`,
      updatedAt: new Date(0),
    },
  });
  return { userId, purchase };
}

async function failedCancelIsRetryable() {
  const { userId, purchase } = await fixture();
  await withFakeStripe(
    async (calls) => {
      await reconcileStaleChargingPurchases(new FakeWalletFundingProvider(), { userId });
      assert.equal(calls.refunds.length, 0);
      assert.equal(
        (await prisma.purchaseSpend.findUniqueOrThrow({ where: { id: purchase.id } })).status,
        'REFUND_FAILED',
        'an unconfirmed Stripe reversal cannot become terminal FAILED'
      );
    },
    { cancelError: new Error('temporary fixture cancellation failure') }
  );
  await withFakeStripe(async (calls) => {
    await reconcileFailedPurchaseRefunds({ userId });
    assert.deepEqual(calls.cancels, [purchase.stripePaymentIntentId]);
    assert.equal(calls.refunds.length, 0);
    assert.equal(
      (await prisma.purchaseSpend.findUniqueOrThrow({ where: { id: purchase.id } })).status,
      'FAILED'
    );
  });
}

async function capturedChargeIsRefunded() {
  const { userId, purchase } = await fixture();
  await withFakeStripe(
    async (calls) => {
      await reconcileStaleChargingPurchases(new FakeWalletFundingProvider(), { userId });
      assert.equal(calls.cancels.length, 0, 'a captured payment needs the canonical refund path');
      assert.equal(calls.refunds.length, 1);
      assert.deepEqual(calls.refundIdempotencyKeys, [`purchase-refund:${purchase.id}`]);
      assert.equal(
        (await prisma.purchaseSpend.findUniqueOrThrow({ where: { id: purchase.id } })).status,
        'REFUNDED'
      );
    },
    { retrievePaymentIntent: capturedPaymentIntent }
  );
}

async function successfulCancelIsTerminal() {
  const { userId, purchase } = await fixture();
  await withFakeStripe(async (calls) => {
    await reconcileStaleChargingPurchases(new FakeWalletFundingProvider(), { userId });
    assert.deepEqual(calls.cancels, [purchase.stripePaymentIntentId]);
    assert.equal(calls.refunds.length, 0);
    assert.equal(
      (await prisma.purchaseSpend.findUniqueOrThrow({ where: { id: purchase.id } })).status,
      'FAILED'
    );
  });
}

async function main() {
  let failures = 0;
  try {
    for (const [name, test] of [
      ['failed cancellation remains retryable and later confirms release', failedCancelIsRetryable],
      ['captured stale payment uses one canonical refund', capturedChargeIsRefunded],
      ['confirmed cancellation can become terminal', successfulCancelIsTerminal],
    ] as const) {
      try {
        await test();
        console.log(`PASS ${name}`);
      } catch (error) {
        failures++;
        console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await prisma.purchaseSpend.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { userId: { in: users } } });
    await prisma.$disconnect();
  }
  assert.equal(failures, 0, `${failures} stale reversal cases failed`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
