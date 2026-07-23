#!/usr/bin/env tsx
/** Durable cross-request AgentCard company-funding retry regressions. */

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { mintPurchaseCard } from '../../domains/purchases/service';
import { PurchaseError } from '../../domains/purchases/errors';
import { prisma } from '../../providers/database';
import {
  assert,
  FakeWalletFundingProvider,
  ResumableFundingInProgressCardProvider,
  withFakeStripe,
} from './purchases.testkit';

config();

const RUN_ID = process.env.BLACKBOX_TEST_RUN_ID || `${Date.now()}-${randomUUID().slice(0, 8)}`;
const userIds: string[] = [];

async function createSubscribedUser(): Promise<string> {
  const userId = `purchase6-${RUN_ID}-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  userIds.push(userId);
  await prisma.subscription.create({
    data: {
      userId,
      subscriptionTier: 1,
      stripeSubscriptionId: `sub_${randomUUID()}`,
      stripeCustomerId: `cus_${randomUUID()}`,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  return userId;
}

function mintInput(userId: string, fingerprint: string, totalCents = 1000) {
  return {
    userId,
    fingerprint,
    merchant: 'Test Merchant',
    currency: 'USD',
    lineItems: [{ label: 'Widget', amountCents: 1000 }],
    fees: [{ label: 'Tax', amountCents: 80 }],
    subtotalCents: 1000,
    totalCents,
  } as never;
}

async function expectPurchaseError(fn: () => Promise<unknown>): Promise<PurchaseError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof PurchaseError) return error;
    throw error;
  }
  throw new Error('expected PurchaseError');
}

async function main(): Promise<void> {
  const userId = await createSubscribedUser();
  const fingerprint = `funding-resume-${randomUUID()}`;
  const input = mintInput(userId, fingerprint);
  const provider = new ResumableFundingInProgressCardProvider();
  const walletProvider = new FakeWalletFundingProvider();

  await withFakeStripe(async (calls) => {
    const firstError = await expectPurchaseError(() =>
      mintPurchaseCard(input, provider, walletProvider)
    );
    assert(
      firstError.code === 'agentcard_company_funding_in_progress',
      `expected funding-in-progress, got ${firstError.code}`
    );
    const pending = await prisma.purchaseSpend.findFirstOrThrow({
      where: { userId, fingerprint },
    });
    assert(
      pending.status === PurchaseSpendStatus.FUNDING_PENDING,
      `expected FUNDING_PENDING, got ${pending.status}`
    );

    const mismatch = await expectPurchaseError(() =>
      mintPurchaseCard(mintInput(userId, fingerprint, 2000), provider, walletProvider)
    );
    assert(
      mismatch.code === 'purchase_funding_resume_mismatch',
      `expected resume mismatch, got ${mismatch.code}`
    );

    provider.completeFunding();
    const result = await mintPurchaseCard(input, provider, walletProvider);
    assert(result.purchaseId === pending.id, 'retry must resume the original purchase row');
    assert(result.status === PurchaseSpendStatus.HELD, `expected HELD, got ${result.status}`);

    const purchases = await prisma.purchaseSpend.findMany({
      where: { userId, fingerprint },
      include: { walletFunding: true },
    });
    assert(purchases.length === 1, `expected one PurchaseSpend, got ${purchases.length}`);
    assert(calls.charges.length === 2, `expected two Stripe calls, got ${calls.charges.length}`);
    assert(
      calls.chargeIdempotencyKeys[0] === calls.chargeIdempotencyKeys[1],
      'Stripe retries must use the same idempotency key'
    );
    assert(
      calls.chargeResultIds[0] === calls.chargeResultIds[1],
      'Stripe retries must resolve to the same PaymentIntent'
    );
    assert(
      provider.mintRequests.length === 2 &&
        provider.mintRequests[0]?.idempotencyKey === provider.mintRequests[1]?.idempotencyKey,
      'AgentCard retries must use the same purchase-scoped idempotency key'
    );
    assert(
      purchases[0]?.walletFunding?.status === PurchaseWalletFundingStatus.FUNDED,
      `expected FUNDED wallet row, got ${purchases[0]?.walletFunding?.status}`
    );
    assert(calls.cancels.length === 0, 'the shared hold must never be canceled');
    assert(calls.captures.length === 1, 'the shared hold must be captured exactly once');
  });

  process.stdout.write('PASS durable AgentCard company-funding resume (1/1)\n');
}

main()
  .catch((error) => {
    process.stderr.write(`FAIL ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.purchaseSpend.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.subscription.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.$disconnect();
  });
