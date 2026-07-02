#!/usr/bin/env tsx
/* eslint-disable no-console -- CLI test runner prints results to stdout */
/**
 * Black-box tests (part 2) for the auth-hold purchase model.
 *
 * The purchase charge is a Stripe manual-capture HOLD, not an immediate charge. These tests lock
 * down the settlement lifecycle at the service level:
 *   - `transaction.cleared`  → CAPTURE the hold (money taken).
 *   - `transaction.voided`   → CANCEL an un-captured hold (no money), or REFUND a captured one.
 *   - explicit close         → CANCEL the hold (agent abandoned the buy).
 *   - agent-session cleanup  → liveness-aware: CANCEL unspent holds, CAPTURE ones the card settled.
 * Split from purchases.blackbox.ts to stay under the max-lines cap.
 */

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { PurchaseSpendStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import { cleanupAgentPurchaseCards } from '../../providers/purchaseCleanup';
import { stripe } from '../../providers/stripe';
import * as purchasesService from '../../domains/purchases/service';
import {
  assert,
  FakeCardProvider,
  StubCardStateProvider,
  withFakeStripe,
} from './purchases.testkit';

config();

const RUN_ID = process.env.BLACKBOX_TEST_RUN_ID || `${Date.now()}-${randomUUID().slice(0, 8)}`;
const trackedUserIds = new Set<string>();

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

async function createUser(label: string): Promise<string> {
  const userId = `purchase2-${RUN_ID}-${label}-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  trackedUserIds.add(userId);
  return userId;
}

async function createSubscribedUser(label: string): Promise<string> {
  const userId = await createUser(label);
  await prisma.subscription.create({
    data: {
      userId,
      subscriptionTier: 1,
      stripeSubscriptionId: `sub_${RUN_ID}_${label}_${randomUUID()}`,
      stripeCustomerId: `cus_${RUN_ID}_${label}_${randomUUID()}`,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  return userId;
}

async function createAgent(userId: string, label: string): Promise<string> {
  const agent = await prisma.agent.create({
    data: { userId, goal: `purchase cleanup test ${label}` },
    select: { id: true },
  });
  return agent.id;
}

function validMintBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fingerprint: `fp-${randomUUID()}`,
    merchant: 'Test Merchant',
    currency: 'USD',
    lineItems: [{ label: 'Widget', amountCents: 1000 }],
    fees: [{ label: 'Tax', amountCents: 80 }],
    subtotalCents: 1000,
    totalCents: 1080,
    ...overrides,
  };
}

test('service close cancels the hold (no refund) and voids an un-spent purchase', async () => {
  const userId = await createSubscribedUser('service-close');
  const fingerprint = `service-close-${randomUUID()}`;
  const provider = new FakeCardProvider();

  await withFakeStripe(async (calls) => {
    await purchasesService.mintPurchaseCard(
      validMintBody({ userId, fingerprint, totalCents: 1000 }) as never,
      provider
    );
    const closed = await purchasesService.closePurchaseCard(provider.cardId, provider);

    assert(closed.status === PurchaseSpendStatus.VOIDED, `expected VOIDED, got ${closed.status}`);
    assert(provider.closeCalls === 1, `expected one provider close, got ${provider.closeCalls}`);
    assert(calls.cancels.length === 1, `expected one hold cancel, got ${calls.cancels.length}`);
    assert(
      calls.refunds.length === 0,
      `an un-captured hold must be canceled, not refunded (got ${calls.refunds.length})`
    );

    const row = await prisma.purchaseSpend.findFirst({
      where: { userId, fingerprint },
      orderBy: { createdAt: 'desc' },
    });
    assert(row?.status === PurchaseSpendStatus.VOIDED, `expected VOIDED row, got ${row?.status}`);
  });
});

test('service webhook reconciles cleared (capture) and voided (cancel) transactions', async () => {
  const clearedUserId = await createUser('webhook-cleared');
  const voidedUserId = await createUser('webhook-voided');
  const clearedCardId = `card-cleared-${randomUUID()}`;
  const voidedCardId = `card-voided-${randomUUID()}`;

  await prisma.purchaseSpend.createMany({
    data: [
      {
        userId: clearedUserId,
        fingerprint: `cleared-${randomUUID()}`,
        cardId: clearedCardId,
        merchant: 'Cleared Merchant',
        lineItemsJson: { totalCents: 1000 },
        totalCents: 1000,
        status: PurchaseSpendStatus.HELD,
        stripePaymentIntentId: `pi_${randomUUID()}`,
      },
      {
        userId: voidedUserId,
        fingerprint: `voided-${randomUUID()}`,
        cardId: voidedCardId,
        merchant: 'Voided Merchant',
        lineItemsJson: { totalCents: 1000 },
        totalCents: 1000,
        status: PurchaseSpendStatus.HELD,
        stripePaymentIntentId: `pi_${randomUUID()}`,
      },
    ],
  });

  await withFakeStripe(async (calls) => {
    await purchasesService.handleAgentCardWebhook({
      type: 'transaction.cleared',
      cardId: clearedCardId,
    });
    await purchasesService.handleAgentCardWebhook({
      type: 'transaction.voided',
      cardId: voidedCardId,
    });

    const cleared = await prisma.purchaseSpend.findFirst({ where: { cardId: clearedCardId } });
    const voided = await prisma.purchaseSpend.findFirst({ where: { cardId: voidedCardId } });

    assert(
      cleared?.status === PurchaseSpendStatus.CLEARED,
      `expected CLEARED, got ${cleared?.status}`
    );
    assert(voided?.status === PurchaseSpendStatus.VOIDED, `expected VOIDED, got ${voided?.status}`);
    assert(
      calls.captures.length === 1,
      `cleared should capture the hold once, got ${calls.captures.length}`
    );
    assert(
      calls.cancels.length === 1,
      `voided (un-captured) should cancel the hold once, got ${calls.cancels.length}`
    );
    assert(
      calls.refunds.length === 0,
      `an un-captured voided hold must be canceled, not refunded (got ${calls.refunds.length})`
    );
  });
});

test('webhook voided refunds a purchase whose hold was already captured (CLEARED)', async () => {
  const userId = await createUser('webhook-voided-cleared');
  const cardId = `card-vc-${randomUUID()}`;

  await prisma.purchaseSpend.create({
    data: {
      userId,
      fingerprint: `vc-${randomUUID()}`,
      cardId,
      merchant: 'VC Merchant',
      lineItemsJson: { totalCents: 1000 },
      totalCents: 1000,
      status: PurchaseSpendStatus.CLEARED,
      stripePaymentIntentId: `pi_${randomUUID()}`,
    },
  });

  await withFakeStripe(async (calls) => {
    await purchasesService.handleAgentCardWebhook({ type: 'transaction.voided', cardId });

    assert(
      calls.refunds.length === 1,
      `a reversed captured charge should refund once, got ${calls.refunds.length}`
    );
    assert(calls.cancels.length === 0, 'a captured charge is refunded, not canceled');

    const row = await prisma.purchaseSpend.findFirst({ where: { cardId } });
    assert(row?.status === PurchaseSpendStatus.REFUNDED, `expected REFUNDED, got ${row?.status}`);
  });
});

test('webhook cleared swallows an already-settled Stripe hold (idempotent capture)', async () => {
  const userId = await createUser('webhook-cleared-idempotent');
  const cardId = `card-idem-${randomUUID()}`;

  await prisma.purchaseSpend.create({
    data: {
      userId,
      fingerprint: `idem-${randomUUID()}`,
      cardId,
      merchant: 'Idem Merchant',
      lineItemsJson: { totalCents: 1000 },
      totalCents: 1000,
      status: PurchaseSpendStatus.HELD,
      stripePaymentIntentId: `pi_${randomUUID()}`,
    },
  });

  // At-least-once webhooks can capture a PaymentIntent another path already settled; Stripe raises
  // `payment_intent_unexpected_state`, which the hold helper must swallow.
  const paymentIntents = stripe.paymentIntents as unknown as {
    capture: (id: string) => Promise<unknown>;
  };
  const originalCapture = paymentIntents.capture;
  paymentIntents.capture = async () => {
    const err = new Error('already captured') as Error & { code: string };
    err.code = 'payment_intent_unexpected_state';
    throw err;
  };
  try {
    await purchasesService.handleAgentCardWebhook({ type: 'transaction.cleared', cardId });
  } finally {
    paymentIntents.capture = originalCapture;
  }

  const row = await prisma.purchaseSpend.findFirst({ where: { cardId } });
  assert(
    row?.status === PurchaseSpendStatus.CLEARED,
    `expected CLEARED after an idempotent capture, got ${row?.status}`
  );
});

test('cleanup cancels the hold and voids an un-spent held card (agent gave up)', async () => {
  const userId = await createUser('cleanup-held');
  const agentId = await createAgent(userId, 'held-card');
  // FakeCardProvider.getDetails reports a live (unspent) card → cleanup should cancel the hold.
  const provider = new FakeCardProvider();
  const fingerprint = `cleanup-${randomUUID()}`;

  await prisma.purchaseSpend.create({
    data: {
      userId,
      agentId,
      fingerprint,
      cardId: provider.cardId,
      merchant: 'Cleanup Merchant',
      lineItemsJson: { totalCents: 1000 },
      totalCents: 1000,
      status: PurchaseSpendStatus.HELD,
      stripePaymentIntentId: `pi_${randomUUID()}`,
    },
  });

  await withFakeStripe(async (calls) => {
    await cleanupAgentPurchaseCards(agentId, provider);

    assert(provider.closeCalls === 1, `expected one provider close, got ${provider.closeCalls}`);
    assert(
      calls.cancels.length === 1,
      `an unspent held card should cancel the hold once, got ${calls.cancels.length}`
    );
    assert(
      calls.refunds.length === 0,
      `cleanup must cancel (not refund) an un-captured hold, got ${calls.refunds.length}`
    );

    const row = await prisma.purchaseSpend.findFirst({
      where: { userId, fingerprint },
      orderBy: { createdAt: 'desc' },
    });
    assert(row?.status === PurchaseSpendStatus.VOIDED, `expected VOIDED, got ${row?.status}`);
  });
});

test('cleanup captures the hold and clears a held card the network already settled', async () => {
  const userId = await createUser('cleanup-settled');
  const agentId = await createAgent(userId, 'settled-card');
  const cardId = `settled-card-${randomUUID()}`;
  // Card was already used (CLOSED/0) but transaction.cleared hasn't landed → cleanup must CAPTURE
  // the hold so we collect, not cancel and eat the cost.
  const provider = new StubCardStateProvider({ status: 'CLOSED', balanceCents: 0 });
  const fingerprint = `cleanup-settled-${randomUUID()}`;

  await prisma.purchaseSpend.create({
    data: {
      userId,
      agentId,
      fingerprint,
      cardId,
      merchant: 'Settled Merchant',
      lineItemsJson: { totalCents: 1000 },
      totalCents: 1000,
      status: PurchaseSpendStatus.HELD,
      stripePaymentIntentId: `pi_${randomUUID()}`,
    },
  });

  await withFakeStripe(async (calls) => {
    await cleanupAgentPurchaseCards(agentId, provider);

    assert(
      calls.captures.length === 1,
      `a used card should capture the hold once, got ${calls.captures.length}`
    );
    assert(
      calls.cancels.length === 0 && calls.refunds.length === 0,
      'a used card must be captured, not canceled/refunded'
    );

    const row = await prisma.purchaseSpend.findFirst({ where: { userId, fingerprint } });
    assert(
      row?.status === PurchaseSpendStatus.CLEARED,
      `a used card should be CLEARED, got ${row?.status}`
    );
  });
});

async function cleanupDb(): Promise<void> {
  for (const userId of trackedUserIds) {
    await prisma.purchaseSpend.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.subscription.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

async function main() {
  const results: Array<{ name: string; passed: boolean }> = [];
  for (const item of tests) {
    try {
      await item.fn();
      results.push({ name: item.name, passed: true });
      console.log(`PASS ${item.name}`);
    } catch (error) {
      results.push({ name: item.name, passed: false });
      console.error(`FAIL ${item.name}`);
      console.error(error instanceof Error ? error.stack || error.message : String(error));
    }
  }

  await cleanupDb();
  await prisma.$disconnect();
  const failed = results.filter((result) => !result.passed);
  console.log(`\nResults: ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
