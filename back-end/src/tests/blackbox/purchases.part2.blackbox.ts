#!/usr/bin/env tsx
/**
 * Black-box tests (part 2) for the JIT company-funding purchase model.
 *
 * Stripe is authorized first and captured when AgentCard confirms company funding. These tests
 * lock down the remaining lifecycle: settlement consumes funding; void/close/abandonment reclaim
 * AgentCard funding before issuing one idempotent Stripe refund.
 * Split from purchases.blackbox.ts to stay under the max-lines cap.
 */

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { PurchaseSpendStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import {
  cleanupAgentPurchaseCards,
  reconcileDissolvedPurchaseHolds,
  reconcileFailedPurchaseRefunds,
  reconcileFailedPurchaseFundingReclaims,
  reconcileStaleChargingPurchases,
  reconcileTerminalAgentPurchaseCards,
} from '../../providers/purchaseCleanup';
import * as purchasesService from '../../domains/purchases/service';
import {
  assert,
  FakeCardProvider,
  FakeWalletFundingProvider,
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

test('service close refunds the captured charge and voids an un-spent funded purchase', async () => {
  const userId = await createSubscribedUser('service-close');
  const fingerprint = `service-close-${randomUUID()}`;
  const provider = new FakeCardProvider();
  const walletFundingProvider = new FakeWalletFundingProvider();

  await withFakeStripe(async (calls) => {
    await purchasesService.mintPurchaseCard(
      validMintBody({ userId, fingerprint, totalCents: 1000 }) as never,
      provider,
      walletFundingProvider
    );
    const closed = await purchasesService.closePurchaseCard(
      provider.cardId,
      provider,
      walletFundingProvider
    );

    assert(closed.status === PurchaseSpendStatus.VOIDED, `expected VOIDED, got ${closed.status}`);
    assert(provider.closeCalls === 1, `expected one provider close, got ${provider.closeCalls}`);
    assert(
      walletFundingProvider.reclaimCalls.length === 1,
      `expected one wallet reclaim, got ${walletFundingProvider.reclaimCalls.length}`
    );
    assert(calls.cancels.length === 0, `captured funding must not be canceled`);
    assert(
      calls.refunds.length === 1,
      `unused funded purchase must refund once (got ${calls.refunds.length})`
    );

    const row = await prisma.purchaseSpend.findFirst({
      where: { userId, fingerprint },
      orderBy: { createdAt: 'desc' },
    });
    assert(row?.status === PurchaseSpendStatus.VOIDED, `expected VOIDED row, got ${row?.status}`);
    const funding = await prisma.purchaseWalletFunding.findUnique({
      where: { purchaseId: row?.id ?? '' },
    });
    assert(
      funding?.status === 'RECLAIMED',
      `expected wallet funding RECLAIMED, got ${funding?.status}`
    );
  });
});

test('failed Stripe refund is recorded specifically and retried idempotently', async () => {
  const userId = await createSubscribedUser('refund-retry');
  const fingerprint = `refund-retry-${randomUUID()}`;
  const provider = new FakeCardProvider();
  const walletFundingProvider = new FakeWalletFundingProvider();
  let purchaseId = '';

  await withFakeStripe(
    async () => {
      await purchasesService.mintPurchaseCard(
        validMintBody({ userId, fingerprint, totalCents: 1000 }) as never,
        provider,
        walletFundingProvider
      );
      let threw = false;
      try {
        await purchasesService.closePurchaseCard(provider.cardId, provider, walletFundingProvider);
      } catch (error) {
        threw = error instanceof Error && error.message === 'temporary Stripe refund failure';
      }
      assert(threw, 'close should surface the Stripe refund failure');
      const failed = await prisma.purchaseSpend.findFirst({ where: { userId, fingerprint } });
      purchaseId = failed?.id ?? '';
      assert(failed?.status === 'REFUND_FAILED', `expected REFUND_FAILED, got ${failed?.status}`);
    },
    { refundError: new Error('temporary Stripe refund failure') }
  );

  await withFakeStripe(async (calls) => {
    await reconcileFailedPurchaseRefunds({ userId });
    assert(calls.refunds.length === 1, `expected one refund retry, got ${calls.refunds.length}`);
    assert(
      calls.refundIdempotencyKeys[0] === `purchase-refund:${purchaseId}`,
      'refund retry must retain its purchase-scoped idempotency key'
    );
  });
  const recovered = await prisma.purchaseSpend.findUnique({ where: { id: purchaseId } });
  assert(recovered?.status === 'REFUNDED', `expected REFUNDED, got ${recovered?.status}`);
});

test('failed company release is retried before the captured charge is refunded', async () => {
  const userId = await createUser('reclaim-retry');
  const cardId = `card-reclaim-${randomUUID()}`;
  const paymentIntentId = `pi_${randomUUID()}`;
  const walletFundingProvider = new FakeWalletFundingProvider();
  const purchase = await prisma.purchaseSpend.create({
    data: {
      userId,
      fingerprint: `reclaim-retry-${randomUUID()}`,
      cardId,
      merchant: 'Reclaim Retry Merchant',
      lineItemsJson: { totalCents: 1000 },
      totalCents: 1000,
      status: PurchaseSpendStatus.FUNDING_RECLAIM_FAILED,
      stripePaymentIntentId: paymentIntentId,
    },
  });
  await prisma.purchaseWalletFunding.create({
    data: {
      purchaseId: purchase.id,
      userId,
      amountCents: 1000,
      currency: 'usd',
      status: 'RECLAIM_FAILED',
      idempotencyKey: `purchase-wallet-fund:${purchase.id}`,
      reclaimIdempotencyKey: `purchase-wallet-reclaim:${purchase.id}`,
      providerTransferId: `owt_${randomUUID()}`,
    },
  });

  await withFakeStripe(async (calls) => {
    calls.captures.push(paymentIntentId);
    await reconcileFailedPurchaseFundingReclaims(walletFundingProvider, { userId });
    const reclaim = walletFundingProvider.reclaimCalls.find(
      (request) => request.purchaseId === purchase.id
    );
    assert(reclaim?.cardId === cardId, 'reclaim retry must carry the AgentCard card id');
    const matchingRefunds = calls.refunds
      .map((entry) => JSON.parse(entry) as { payment_intent?: string })
      .filter((entry) => entry.payment_intent === paymentIntentId);
    assert(matchingRefunds.length === 1, 'expected one refund after confirmed reclaim');
  });
  const recovered = await prisma.purchaseSpend.findUnique({ where: { id: purchase.id } });
  assert(recovered?.status === PurchaseSpendStatus.VOIDED, `got ${recovered?.status}`);
});

test('service webhook marks cleared without recapture and refunds a voided funded transaction', async () => {
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
      calls.captures.length === 0,
      `cleared must not recapture funding, got ${calls.captures.length}`
    );
    assert(calls.cancels.length === 0, `voided funded purchase must not cancel a captured intent`);
    assert(
      calls.refunds.length === 1,
      `voided funded purchase must refund once (got ${calls.refunds.length})`
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

test('duplicate cleared webhooks consume funding without another Stripe action', async () => {
  const userId = await createUser('webhook-cleared-idempotent');
  const cardId = `card-idem-${randomUUID()}`;

  const purchase = await prisma.purchaseSpend.create({
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
  await prisma.purchaseWalletFunding.create({
    data: {
      purchaseId: purchase.id,
      userId,
      amountCents: 1000,
      currency: 'usd',
      status: 'FUNDED',
      idempotencyKey: `purchase-wallet-fund:${purchase.id}`,
      providerTransferId: `owt_${randomUUID()}`,
    },
  });

  await withFakeStripe(async (calls) => {
    await purchasesService.handleAgentCardWebhook({ type: 'transaction.cleared', cardId });
    await purchasesService.handleAgentCardWebhook({ type: 'transaction.cleared', cardId });
    assert(calls.captures.length === 0, 'settlement must not capture Stripe again');
    assert(calls.cancels.length === 0, 'settlement must not cancel Stripe');
    assert(calls.refunds.length === 0, 'settlement must not refund Stripe');
  });

  const row = await prisma.purchaseSpend.findFirst({ where: { cardId } });
  assert(
    row?.status === PurchaseSpendStatus.CLEARED,
    `expected CLEARED after duplicate settlement, got ${row?.status}`
  );
  const funding = await prisma.purchaseWalletFunding.findUnique({
    where: { purchaseId: purchase.id },
  });
  assert(funding?.status === 'CONSUMED', `expected funding CONSUMED, got ${funding?.status}`);
});

test('cleanup refunds the captured charge and voids an un-spent funded card', async () => {
  const userId = await createUser('cleanup-held');
  const agentId = await createAgent(userId, 'held-card');
  // FakeCardProvider.getDetails reports a live (unspent) card, so cleanup must refund it.
  const provider = new FakeCardProvider();
  const fingerprint = `cleanup-${randomUUID()}`;
  const paymentIntentId = `pi_${randomUUID()}`;

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
      stripePaymentIntentId: paymentIntentId,
    },
  });

  await withFakeStripe(async (calls) => {
    calls.captures.push(paymentIntentId);
    await cleanupAgentPurchaseCards(agentId, provider);

    assert(provider.closeCalls === 1, `expected one provider close, got ${provider.closeCalls}`);
    assert(calls.cancels.length === 0, `an unspent funded card must not cancel a captured intent`);
    assert(
      calls.refunds.length === 1,
      `cleanup must refund captured funding, got ${calls.refunds.length}`
    );

    const row = await prisma.purchaseSpend.findFirst({
      where: { userId, fingerprint },
      orderBy: { createdAt: 'desc' },
    });
    assert(row?.status === PurchaseSpendStatus.VOIDED, `expected VOIDED, got ${row?.status}`);
  });
});

test('terminal-agent reconciler finds and cleans up an abandoned funded card', async () => {
  const userId = await createUser('terminal-reconcile');
  const agentId = await createAgent(userId, 'terminal-reconcile');
  const provider = new FakeCardProvider();
  const walletFundingProvider = new FakeWalletFundingProvider();
  const paymentIntentId = `pi_${randomUUID()}`;
  const purchase = await prisma.purchaseSpend.create({
    data: {
      userId,
      agentId,
      fingerprint: `terminal-reconcile-${randomUUID()}`,
      cardId: provider.cardId,
      merchant: 'Abandoned Merchant',
      lineItemsJson: { totalCents: 1000 },
      totalCents: 1000,
      status: PurchaseSpendStatus.HELD,
      stripePaymentIntentId: paymentIntentId,
    },
  });
  await prisma.purchaseWalletFunding.create({
    data: {
      purchaseId: purchase.id,
      userId,
      agentId,
      amountCents: 1000,
      currency: 'usd',
      status: 'FUNDED',
      idempotencyKey: `purchase-wallet-fund:${purchase.id}`,
      providerTransferId: provider.providerTransferId,
    },
  });
  await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });

  await withFakeStripe(async (calls) => {
    calls.captures.push(paymentIntentId);
    await reconcileTerminalAgentPurchaseCards(provider, walletFundingProvider, { userId });
    assert(provider.closeCalls === 1, `expected one card close, got ${provider.closeCalls}`);
    assert(calls.refunds.length === 1, `expected one refund, got ${calls.refunds.length}`);
  });
  const row = await prisma.purchaseSpend.findUnique({ where: { id: purchase.id } });
  assert(row?.status === PurchaseSpendStatus.VOIDED, `expected VOIDED, got ${row?.status}`);
});

test('cleanup reclaims wallet funding before refunding an un-spent funded card', async () => {
  const userId = await createSubscribedUser('cleanup-funded-held');
  const agentId = await createAgent(userId, 'funded-held-card');
  const provider = new FakeCardProvider();
  const walletFundingProvider = new FakeWalletFundingProvider();
  const fingerprint = `cleanup-funded-${randomUUID()}`;

  await withFakeStripe(async (calls) => {
    await purchasesService.mintPurchaseCard(
      validMintBody({ userId, agentId, fingerprint, totalCents: 1000 }) as never,
      provider,
      walletFundingProvider
    );
    await cleanupAgentPurchaseCards(agentId, provider, walletFundingProvider);

    assert(provider.closeCalls === 1, `expected one provider close, got ${provider.closeCalls}`);
    assert(
      walletFundingProvider.reclaimCalls.length === 1,
      `expected one wallet reclaim, got ${walletFundingProvider.reclaimCalls.length}`
    );
    assert(calls.cancels.length === 0, `captured funding must not be canceled`);
    assert(calls.refunds.length === 1, `expected one captured-charge refund`);

    const row = await prisma.purchaseSpend.findFirst({ where: { userId, fingerprint } });
    assert(row?.status === PurchaseSpendStatus.VOIDED, `expected VOIDED, got ${row?.status}`);
    const funding = await prisma.purchaseWalletFunding.findUnique({
      where: { purchaseId: row?.id ?? '' },
    });
    assert(
      funding?.status === 'RECLAIMED',
      `expected wallet funding RECLAIMED, got ${funding?.status}`
    );
  });
});

test('cleanup clears a settled card without recapturing its funding charge', async () => {
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
      calls.captures.length === 0,
      `a used card must not recapture funding, got ${calls.captures.length}`
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

test('dissolved hold closes an unused card, reclaims wallet funding, and voids purchase', async () => {
  const userId = await createSubscribedUser('dissolved-unspent');
  const agentId = await createAgent(userId, 'dissolved-unspent');
  const provider = new FakeCardProvider();
  const walletFundingProvider = new FakeWalletFundingProvider();
  const fingerprint = `dissolved-unspent-${randomUUID()}`;

  await withFakeStripe(
    async () => {
      await purchasesService.mintPurchaseCard(
        validMintBody({ userId, agentId, fingerprint, totalCents: 1000 }) as never,
        provider,
        walletFundingProvider
      );
      await reconcileDissolvedPurchaseHolds(provider, walletFundingProvider, { userId });

      const row = await prisma.purchaseSpend.findFirst({ where: { userId, fingerprint } });
      assert(row?.status === PurchaseSpendStatus.VOIDED, `expected VOIDED, got ${row?.status}`);
      const funding = await prisma.purchaseWalletFunding.findUnique({
        where: { purchaseId: row?.id ?? '' },
      });
      assert(
        funding?.status === 'RECLAIMED',
        `expected wallet funding RECLAIMED, got ${funding?.status}`
      );
    },
    {
      retrievePaymentIntent: (id) => ({ id, status: 'canceled', amount_capturable: 0 }),
    }
  );
});

test('dissolved hold after card spend records capture failure for reconciliation', async () => {
  const userId = await createSubscribedUser('dissolved-spent');
  const agentId = await createAgent(userId, 'dissolved-spent');
  const mintProvider = new FakeCardProvider();
  const spentProvider = new StubCardStateProvider({ status: 'CLOSED', balanceCents: 0 });
  const walletFundingProvider = new FakeWalletFundingProvider();
  const fingerprint = `dissolved-spent-${randomUUID()}`;

  await withFakeStripe(
    async () => {
      await purchasesService.mintPurchaseCard(
        validMintBody({ userId, agentId, fingerprint, totalCents: 1000 }) as never,
        mintProvider,
        walletFundingProvider
      );
      await reconcileDissolvedPurchaseHolds(spentProvider, walletFundingProvider, { userId });

      const row = await prisma.purchaseSpend.findFirst({ where: { userId, fingerprint } });
      assert(
        row?.status === PurchaseSpendStatus.CAPTURE_FAILED,
        `expected CAPTURE_FAILED, got ${row?.status}`
      );
      const funding = await prisma.purchaseWalletFunding.findUnique({
        where: { purchaseId: row?.id ?? '' },
      });
      assert(
        funding?.status === 'CONSUMED',
        `expected wallet funding CONSUMED, got ${funding?.status}`
      );
    },
    {
      retrievePaymentIntent: (id) => ({ id, status: 'canceled', amount_capturable: 0 }),
    }
  );
});

test('stale charging reconciler reclaims wallet funding and cancels the hold', async () => {
  const userId = await createUser('stale-charging-reconciler');
  const walletFundingProvider = new FakeWalletFundingProvider();
  const purchase = await prisma.purchaseSpend.create({
    data: {
      userId,
      fingerprint: `stale-reconcile-${randomUUID()}`,
      merchant: 'Stale Reconcile Merchant',
      lineItemsJson: { totalCents: 1000 },
      totalCents: 1000,
      status: PurchaseSpendStatus.CHARGING,
      stripePaymentIntentId: `pi_stale_${randomUUID()}`,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  });
  await prisma.purchaseWalletFunding.create({
    data: {
      purchaseId: purchase.id,
      userId,
      amountCents: 1000,
      currency: 'usd',
      status: 'FUNDED',
      providerTransferId: `wft_stale_${randomUUID()}`,
      idempotencyKey: `purchase-wallet-fund:${purchase.id}`,
    },
  });

  await withFakeStripe(async (calls) => {
    await reconcileStaleChargingPurchases(walletFundingProvider, { userId });

    assert(calls.cancels.length === 1, `expected one hold cancel, got ${calls.cancels.length}`);
    assert(
      walletFundingProvider.reclaimCalls.length === 1,
      `expected one wallet reclaim, got ${walletFundingProvider.reclaimCalls.length}`
    );
    const row = await prisma.purchaseSpend.findUnique({ where: { id: purchase.id } });
    assert(row?.status === PurchaseSpendStatus.FAILED, `expected FAILED, got ${row?.status}`);
    const funding = await prisma.purchaseWalletFunding.findUnique({
      where: { purchaseId: purchase.id },
    });
    assert(
      funding?.status === 'RECLAIMED',
      `expected wallet funding RECLAIMED, got ${funding?.status}`
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
