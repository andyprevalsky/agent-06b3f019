#!/usr/bin/env tsx
/** Financial side-effect crash/concurrency regressions for the purchase state machine. */

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
import type { CardProvider, CardProviderMintRequest } from '../../providers/card-provider';

const RUN_ID = process.env.BLACKBOX_TEST_RUN_ID || `${Date.now()}-${randomUUID().slice(0, 8)}`;
const userIds: string[] = [];
const CRASH_AFTER_AGENTCARD = 'after_agentcard_before_record';
const CRASH_AFTER_CAPTURE = 'after_capture_before_held';

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

function requiredCrashEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`missing ${name}`);
  return value;
}

function fixedCardProvider(
  cardId: string,
  providerTransferId: string,
  onMint?: (request: CardProviderMintRequest) => void
): CardProvider {
  return {
    async mintCard(request) {
      onMint?.(request);
      return {
        cardId,
        last4: '4242',
        expiry: '12/30',
        spendLimitCents: 1000,
        status: 'OPEN',
        providerTransferId,
      };
    },
    async getDetails() {
      return {
        pan: '4242424242424242',
        cvv: '123',
        expiry: '12/30',
        balanceCents: 1000,
        status: 'OPEN',
      };
    },
    async closeCard() {},
  };
}

async function runCrashChild(mode: string): Promise<void> {
  const userId = requiredCrashEnv('PURCHASE_CRASH_USER_ID');
  const fingerprint = requiredCrashEnv('PURCHASE_CRASH_FINGERPRINT');
  const cardId = requiredCrashEnv('PURCHASE_CRASH_CARD_ID');
  const transferId = requiredCrashEnv('PURCHASE_CRASH_TRANSFER_ID');
  const paymentIntentId = requiredCrashEnv('PURCHASE_CRASH_PAYMENT_INTENT_ID');
  const markerPath = requiredCrashEnv('PURCHASE_CRASH_MARKER_PATH');
  let provider: CardProvider;
  if (mode === CRASH_AFTER_AGENTCARD) {
    provider = {
      ...fixedCardProvider(cardId, transferId),
      async mintCard(request) {
        const minted = {
          cardId,
          last4: '4242',
          expiry: '12/30',
          spendLimitCents: 1000,
          status: 'OPEN',
        } as {
          cardId: string;
          last4: string;
          expiry: string;
          spendLimitCents: number;
          status: string;
          providerTransferId?: string;
        };
        Object.defineProperty(minted, 'providerTransferId', {
          enumerable: true,
          get() {
            writeFileSync(
              markerPath,
              JSON.stringify({ idempotencyKey: request.idempotencyKey, cardId, transferId })
            );
            process.exit(86);
          },
        });
        return minted;
      },
    };
  } else if (mode === CRASH_AFTER_CAPTURE) {
    provider = fixedCardProvider(cardId, transferId);
  } else {
    throw new Error(`unknown crash mode ${mode}`);
  }

  await withFakeStripe(
    async () => {
      await mintPurchaseCard(
        input(userId, fingerprint) as never,
        provider,
        new FakeWalletFundingProvider()
      );
    },
    {
      fixedPaymentIntentId: paymentIntentId,
      ...(mode === CRASH_AFTER_CAPTURE
        ? {
            afterCapture: (capturedId: string) => {
              writeFileSync(markerPath, JSON.stringify({ capturedId, cardId, transferId }));
              process.exit(87);
            },
          }
        : {}),
    }
  );
  throw new Error(`crash child ${mode} reached the end without terminating`);
}

function spawnCrashChild(
  mode: string,
  values: {
    userId: string;
    fingerprint: string;
    cardId: string;
    transferId: string;
    paymentIntentId: string;
    markerPath: string;
  }
): void {
  const result = spawnSync('npx', ['tsx', __filename], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PURCHASE_CRASH_MODE: mode,
      PURCHASE_CRASH_USER_ID: values.userId,
      PURCHASE_CRASH_FINGERPRINT: values.fingerprint,
      PURCHASE_CRASH_CARD_ID: values.cardId,
      PURCHASE_CRASH_TRANSFER_ID: values.transferId,
      PURCHASE_CRASH_PAYMENT_INTENT_ID: values.paymentIntentId,
      PURCHASE_CRASH_MARKER_PATH: values.markerPath,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  const expectedStatus = mode === CRASH_AFTER_AGENTCARD ? 86 : 87;
  assert(
    result.status === expectedStatus,
    `crash child ${mode} exited ${result.status}: ${result.stderr || result.stdout}`
  );
  assert(existsSync(values.markerPath), `crash child ${mode} did not write its boundary marker`);
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

async function testCrashAfterAgentcardBeforeAtomicRecord(): Promise<void> {
  const userId = await subscribedUser();
  const fingerprint = `agentcard-boundary-${randomUUID()}`;
  const cardId = `card-boundary-${randomUUID()}`;
  const transferId = `owt-boundary-${randomUUID()}`;
  const paymentIntentId = `pi_boundary_${randomUUID()}`;
  const markerPath = path.join(tmpdir(), `purchase-agentcard-boundary-${randomUUID()}.json`);
  spawnCrashChild(CRASH_AFTER_AGENTCARD, {
    userId,
    fingerprint,
    cardId,
    transferId,
    paymentIntentId,
    markerPath,
  });
  const crashed = await prisma.purchaseSpend.findFirstOrThrow({
    where: { userId, fingerprint },
    include: { walletFunding: true },
  });
  const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
    idempotencyKey: string;
    cardId: string;
    transferId: string;
  };
  assert(crashed.status === PurchaseSpendStatus.CHARGING, 'crash must leave CHARGING durable');
  assert(crashed.cardId === null, 'card+transfer transaction must not be partially persisted');
  assert(
    crashed.walletFunding?.status === PurchaseWalletFundingStatus.PENDING,
    'pre-provider funding marker must survive the crash'
  );
  assert(
    marker.idempotencyKey === `purchase:${crashed.id}`,
    'provider call must use the purchase-scoped idempotency key'
  );
  assert(marker.cardId === cardId && marker.transferId === transferId, 'marker must prove mint');
  await prisma.purchaseSpend.update({
    where: { id: crashed.id },
    data: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) },
  });

  const replayRequests: CardProviderMintRequest[] = [];
  await withFakeStripe(
    async (calls) => {
      const result = await mintPurchaseCard(
        input(userId, fingerprint) as never,
        fixedCardProvider(cardId, transferId, (request) => replayRequests.push(request)),
        new FakeWalletFundingProvider()
      );
      assert(result.purchaseId === crashed.id, 'restart must resume the original purchase');
      assert(result.cardId === cardId, 'restart must recover the exact provider card');
      assert(
        calls.chargeResultIds.every((id) => id === paymentIntentId),
        'Stripe key must replay'
      );
      assert(calls.captures.length === 1, 'restart must capture the recovered hold exactly once');
    },
    { fixedPaymentIntentId: paymentIntentId }
  );
  assert(
    replayRequests.length === 1 && replayRequests[0]?.idempotencyKey === marker.idempotencyKey,
    'restart must replay the exact AgentCard key'
  );
  const recovered = await prisma.purchaseSpend.findUniqueOrThrow({
    where: { id: crashed.id },
    include: { walletFunding: true },
  });
  assert(recovered.status === PurchaseSpendStatus.HELD, `expected HELD, got ${recovered.status}`);
  assert(recovered.cardId === cardId, 'card id must commit with the recovered transfer');
  assert(
    recovered.walletFunding?.providerTransferId === transferId &&
      recovered.walletFunding.status === PurchaseWalletFundingStatus.FUNDED,
    'transfer must commit atomically with the recovered card'
  );
}

async function testCrashAfterCaptureBeforeHeldCompensation(): Promise<void> {
  const userId = await subscribedUser();
  const fingerprint = `capture-boundary-${randomUUID()}`;
  const cardId = `card-capture-${randomUUID()}`;
  const transferId = `owt-capture-${randomUUID()}`;
  const paymentIntentId = `pi_capture_${randomUUID()}`;
  const markerPath = path.join(tmpdir(), `purchase-capture-boundary-${randomUUID()}.json`);
  spawnCrashChild(CRASH_AFTER_CAPTURE, {
    userId,
    fingerprint,
    cardId,
    transferId,
    paymentIntentId,
    markerPath,
  });
  const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { capturedId: string };
  assert(marker.capturedId === paymentIntentId, 'marker must prove Stripe capture completed');
  const crashed = await prisma.purchaseSpend.findFirstOrThrow({
    where: { userId, fingerprint },
    include: { walletFunding: true },
  });
  assert(crashed.status === PurchaseSpendStatus.CHARGING, 'crash must precede HELD persistence');
  assert(crashed.cardId === cardId, 'issued card must already be durable before capture');
  assert(
    crashed.walletFunding?.providerTransferId === transferId &&
      crashed.walletFunding.status === PurchaseWalletFundingStatus.FUNDED,
    'card and transfer must be durable before capture'
  );
  await prisma.purchaseSpend.update({
    where: { id: crashed.id },
    data: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) },
  });

  let closeCalls = 0;
  const card: CardProvider = {
    ...fixedCardProvider(cardId, transferId),
    async closeCard(id) {
      assert(id === cardId, `unexpected compensation card ${id}`);
      closeCalls += 1;
    },
  };
  const wallet = new FakeWalletFundingProvider();
  await withFakeStripe(
    async (calls) => {
      await reconcileStaleChargingPurchases(wallet, { userId });
      await reconcileAbandonedPurchaseFunding(card, wallet, { userId });
      const row = await prisma.purchaseSpend.findUniqueOrThrow({ where: { id: crashed.id } });
      assert(row.status === PurchaseSpendStatus.VOIDED, `expected VOIDED, got ${row.status}`);
      assert(closeCalls === 1, 'the interrupted issued card must be closed');
      assert(wallet.reclaimCalls.length === 1, 'the company transfer must be reclaimed');
      assert(calls.refunds.length === 1, 'the captured Stripe payment must be refunded');
      assert(calls.cancels.length === 0, 'captured Stripe payment must not be canceled as a hold');
    },
    {
      fixedPaymentIntentId: paymentIntentId,
      retrievePaymentIntent: () => ({
        id: paymentIntentId,
        status: 'succeeded',
        amount_received: 1000,
        amount_capturable: 0,
      }),
    }
  );
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
  await testCrashAfterAgentcardBeforeAtomicRecord();
  await testCrashAfterCaptureBeforeHeldCompensation();
  await testTerminalPendingCompensation();
  process.stdout.write('PASS purchase crash/concurrency compensation (5/5)\n');
}

const crashMode = process.env.PURCHASE_CRASH_MODE;
(crashMode === undefined ? main() : runCrashChild(crashMode))
  .catch((error) => {
    process.stderr.write(`FAIL ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (crashMode !== undefined) {
      await prisma.$disconnect();
      return;
    }
    await prisma.purchaseSpend.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.agent.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.subscription.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.$disconnect();
  });
