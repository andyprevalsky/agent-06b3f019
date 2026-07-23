#!/usr/bin/env tsx
/** Financial side-effect crash/concurrency regressions for the purchase state machine. */

import { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { canonicalInputFingerprint, purchaseReceipt } from '../../domains/purchases/fundingResume';
import { mintPurchaseCard } from '../../domains/purchases/service';
import { prisma } from '../../providers/database';
import {
  cleanupAgentPurchaseCards,
  reconcileAbandonedPurchaseFunding,
  reconcileStaleChargingPurchases,
} from '../../providers/purchaseCleanup';
import { stripe } from '../../providers/stripe';
import {
  assert,
  FakeCardProvider,
  FakeWalletFundingProvider,
  ResumableFundingInProgressCardProvider,
  withFakeStripe,
} from './purchases.testkit';

const RUN_ID = process.env.BLACKBOX_TEST_RUN_ID || `${Date.now()}-${randomUUID().slice(0, 8)}`;
const userIds: string[] = [];

async function subscribedUser(): Promise<string> {
  const userId = `purchase7-${RUN_ID}-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  userIds.push(userId);
  await prisma.subscription.create({
    data: {
      userId,
      subscriptionTier: 1,
      stripeSubscriptionId: `sub_${randomUUID()}`,
      stripeCustomerId: `cus_${randomUUID()}`,
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    },
  });
  return userId;
}

function input(userId: string, fingerprint: string, agentId?: string) {
  return {
    userId,
    agentId,
    fingerprint,
    merchant: 'Crash Boundary Merchant',
    currency: 'USD',
    lineItems: [{ label: 'Widget', amountCents: 1000 }],
    fees: [],
    subtotalCents: 1000,
    totalCents: 1000,
  };
}

async function testConcurrentFirstOpen(): Promise<void> {
  const userId = await subscribedUser();
  const body = input(userId, `concurrent-${randomUUID()}`);
  const card = new FakeCardProvider();
  const wallet = new FakeWalletFundingProvider();
  await withFakeStripe(async (calls) => {
    const results = await Promise.allSettled([
      mintPurchaseCard(body as never, card, wallet),
      mintPurchaseCard(body as never, card, wallet),
    ]);
    assert(
      results.some((result) => result.status === 'fulfilled'),
      'one mint must succeed'
    );
    const rows = await prisma.purchaseSpend.findMany({ where: { userId } });
    assert(rows.length === 1, `expected one purchase row, got ${rows.length}`);
    assert(card.mintCalls === 1, `expected one AgentCard create, got ${card.mintCalls}`);
    assert(new Set(calls.chargeResultIds).size === 1, 'expected one Stripe PaymentIntent');
    assert(calls.captures.length === 1, 'expected one Stripe capture');
  });
}

async function testHiddenStripeIntentRecovery(): Promise<void> {
  const userId = await subscribedUser();
  const fingerprint = `hidden-stripe-${randomUUID()}`;
  const body = input(userId, fingerprint);
  const purchase = await prisma.purchaseSpend.create({
    data: {
      userId,
      fingerprint,
      canonicalFingerprint: canonicalInputFingerprint(body as never),
      merchant: body.merchant,
      lineItemsJson: purchaseReceipt(body as never),
      totalCents: body.totalCents,
      status: PurchaseSpendStatus.CHARGING,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  });
  await prisma.purchaseWalletFunding.create({
    data: {
      purchaseId: purchase.id,
      userId,
      amountCents: body.totalCents,
      idempotencyKey: `purchase-wallet-fund:${purchase.id}`,
      status: PurchaseWalletFundingStatus.PENDING,
    },
  });
  await withFakeStripe(async (calls) => {
    const hidden = await stripe.paymentIntents.create(
      {
        amount: body.totalCents,
        currency: 'usd',
        metadata: { purchaseSpendId: purchase.id },
      },
      { idempotencyKey: `purchase-charge:${purchase.id}` }
    );
    const result = await mintPurchaseCard(
      body as never,
      new FakeCardProvider(),
      new FakeWalletFundingProvider()
    );
    const recovered = await prisma.purchaseSpend.findUniqueOrThrow({ where: { id: purchase.id } });
    assert(result.purchaseId === purchase.id, 'resume must retain the original purchase');
    assert(recovered.stripePaymentIntentId === hidden.id, 'hidden Stripe PI must be recovered');
    assert(calls.chargeResultIds[0] === calls.chargeResultIds[1], 'Stripe key must be replayed');
  });
}

async function testIssuedCardCrashCompensation(): Promise<void> {
  const userId = await subscribedUser();
  const card = new FakeCardProvider();
  const wallet = new FakeWalletFundingProvider();
  const purchase = await prisma.purchaseSpend.create({
    data: {
      userId,
      fingerprint: `issued-crash-${randomUUID()}`,
      merchant: 'Crash Boundary Merchant',
      lineItemsJson: { totalCents: 1000 },
      totalCents: 1000,
      status: PurchaseSpendStatus.CHARGING,
      cardId: card.cardId,
      stripePaymentIntentId: `pi_${randomUUID()}`,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  });
  await prisma.purchaseWalletFunding.create({
    data: {
      purchaseId: purchase.id,
      userId,
      amountCents: 1000,
      idempotencyKey: `purchase-wallet-fund:${purchase.id}`,
      providerTransferId: card.providerTransferId,
      status: PurchaseWalletFundingStatus.FUNDED,
    },
  });
  await withFakeStripe(async (calls) => {
    await reconcileStaleChargingPurchases(wallet, { userId });
    await reconcileAbandonedPurchaseFunding(card, wallet, { userId });
    const row = await prisma.purchaseSpend.findUniqueOrThrow({ where: { id: purchase.id } });
    assert(row.status === PurchaseSpendStatus.VOIDED, `expected VOIDED, got ${row.status}`);
    assert(card.closeCalls === 1, 'the interrupted issued card must be closed');
    assert(wallet.reclaimCalls.length === 1, 'the company transfer must be reclaimed');
    assert(calls.cancels.length === 1, 'the uncaptured Stripe hold must be canceled');
  });
}

async function testTerminalPendingCompensation(): Promise<void> {
  const userId = await subscribedUser();
  const agent = await prisma.agent.create({
    data: { userId, goal: 'funding abandonment crash test', status: 'FAILED' },
  });
  const card = new ResumableFundingInProgressCardProvider();
  const wallet = new FakeWalletFundingProvider();
  const purchase = await prisma.purchaseSpend.create({
    data: {
      userId,
      agentId: agent.id,
      fingerprint: `terminal-pending-${randomUUID()}`,
      merchant: 'Crash Boundary Merchant',
      lineItemsJson: { totalCents: 1000 },
      totalCents: 1000,
      status: PurchaseSpendStatus.FUNDING_PENDING,
      stripePaymentIntentId: `pi_${randomUUID()}`,
    },
  });
  await prisma.purchaseWalletFunding.create({
    data: {
      purchaseId: purchase.id,
      userId,
      agentId: agent.id,
      amountCents: 1000,
      idempotencyKey: `purchase-wallet-fund:${purchase.id}`,
      status: PurchaseWalletFundingStatus.PENDING,
    },
  });
  await withFakeStripe(async (calls) => {
    await cleanupAgentPurchaseCards(agent.id, card, wallet);
    let row = await prisma.purchaseSpend.findUniqueOrThrow({ where: { id: purchase.id } });
    assert(
      row.status === PurchaseSpendStatus.FUNDING_ABANDONED,
      `expected FUNDING_ABANDONED, got ${row.status}`
    );
    assert(calls.cancels.length === 1, 'terminal cleanup must release the Stripe hold');
    card.completeFunding();
    await reconcileAbandonedPurchaseFunding(card, wallet, { userId });
    row = await prisma.purchaseSpend.findUniqueOrThrow({ where: { id: purchase.id } });
    assert(row.status === PurchaseSpendStatus.VOIDED, `expected VOIDED, got ${row.status}`);
    assert(card.closeCalls === 1, 'a late card must be closed');
    assert(wallet.reclaimCalls.length === 1, 'a late transfer must be reclaimed');
  });
}

async function main(): Promise<void> {
  await testConcurrentFirstOpen();
  await testHiddenStripeIntentRecovery();
  await testIssuedCardCrashCompensation();
  await testTerminalPendingCompensation();
  process.stdout.write('PASS purchase crash/concurrency compensation (4/4)\n');
}

main()
  .catch((error) => {
    process.stderr.write(`FAIL ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.purchaseSpend.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.agent.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.subscription.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.$disconnect();
  });
