#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { PurchaseSpendStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import { reconcileFailedPurchaseFundingReclaims } from '../../providers/purchaseCleanup';
import { FakeWalletFundingProvider, withFakeStripe } from './purchases.testkit';

config();

const RUN_ID = process.env.BLACKBOX_TEST_RUN_ID || `${Date.now()}-${randomUUID().slice(0, 8)}`;
const userId = `purchase-reclaim-cancel-${RUN_ID}-${randomUUID()}`;

async function main() {
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  const paymentIntentId = `pi_${randomUUID()}`;
  const purchase = await prisma.purchaseSpend.create({
    data: {
      userId,
      fingerprint: `reclaim-cancel-${randomUUID()}`,
      merchant: 'Reclaim Cancel Merchant',
      lineItemsJson: { totalCents: 1000 },
      totalCents: 1000,
      status: PurchaseSpendStatus.FUNDING_RECLAIM_FAILED,
      cardId: `card-reclaim-cancel-${randomUUID()}`,
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

  const walletFundingProvider = new FakeWalletFundingProvider();
  await withFakeStripe(async (calls) => {
    await reconcileFailedPurchaseFundingReclaims(walletFundingProvider, { userId });
    assert.equal(walletFundingProvider.reclaimCalls.length, 1);
    assert.equal(calls.refunds.length, 0, 'uncaptured hold must not use Stripe refunds');
    assert.deepEqual(calls.cancels, [paymentIntentId], 'uncaptured hold must be canceled');
  });

  const recovered = await prisma.purchaseSpend.findUnique({ where: { id: purchase.id } });
  const funding = await prisma.purchaseWalletFunding.findUnique({
    where: { purchaseId: purchase.id },
  });
  assert.equal(recovered?.status, PurchaseSpendStatus.VOIDED);
  assert.equal(funding?.status, 'RECLAIMED');
}

main()
  .then(async () => {
    await prisma.purchaseSpend.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
    await prisma.$disconnect();
    console.log('PASS failed funding reclaim cancels uncaptured Stripe hold');
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    await prisma.purchaseSpend.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
    await prisma.$disconnect();
    process.exit(1);
  });
