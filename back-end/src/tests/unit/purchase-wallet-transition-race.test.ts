#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { markHeldPurchaseClearedIfNoReclaim } from '../../domains/purchases/repo';
import { settlePurchaseAfterTransactionCleared } from '../../domains/purchases/repoSettlement';
import { prisma } from '../../providers/database';
import {
  beginPurchaseWalletReclaim,
  recordPurchaseWalletFunding,
} from '../../providers/purchase-wallet-funding';
import {
  claimWalletFundingReclaimRetry,
  findWalletFundingByPurchaseId,
  lockPurchaseWalletTransition,
  markWalletFundingReclaiming,
} from '../../providers/purchase-wallet-funding-repo';

const createdUserIds: string[] = [];

async function seedHeldPurchase() {
  const userId = `pwf-race-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  createdUserIds.push(userId);
  const purchase = await prisma.purchaseSpend.create({
    data: {
      userId,
      fingerprint: `fp-${randomUUID()}`,
      merchant: 'PWF Race Merchant',
      lineItemsJson: { totalCents: 1080 },
      totalCents: 1080,
      status: PurchaseSpendStatus.HELD,
      cardId: `card-${randomUUID()}`,
      stripePaymentIntentId: `pi_${randomUUID()}`,
    },
  });
  await recordPurchaseWalletFunding(purchase, 'usd', `owt_${randomUUID()}`, {});
  return purchase;
}

async function clearingWaitsForReclaimTransition(): Promise<void> {
  const purchase = await seedHeldPurchase();
  let releaseLock!: () => void;
  const lockHeld = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  let markLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    markLocked = resolve;
  });
  const reclaimTransition = prisma.$transaction(async (transaction) => {
    await lockPurchaseWalletTransition(transaction, purchase.id);
    markLocked();
    await lockHeld;
    await transaction.purchaseWalletFunding.update({
      where: { purchaseId: purchase.id },
      data: { status: PurchaseWalletFundingStatus.RECLAIMING },
    });
  });
  await locked;
  const clearing = markHeldPurchaseClearedIfNoReclaim(purchase.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseLock();
  await reclaimTransition;
  const cleared = await clearing;

  assert.equal(cleared.count, 0, 'a queued clear must observe the committed reclaim state');
  const [currentPurchase, funding] = await Promise.all([
    prisma.purchaseSpend.findUniqueOrThrow({ where: { id: purchase.id } }),
    findWalletFundingByPurchaseId(purchase.id),
  ]);
  assert.equal(currentPurchase.status, PurchaseSpendStatus.HELD);
  assert.equal(funding?.status, PurchaseWalletFundingStatus.RECLAIMING);
}

async function reclaimCannotClaimClearedPurchase(): Promise<void> {
  const purchase = await seedHeldPurchase();
  assert.equal((await settlePurchaseAfterTransactionCleared(purchase.id)).outcome, 'cleared');
  assert.equal(
    (await markHeldPurchaseClearedIfNoReclaim(purchase.id)).count,
    0,
    'settlement is already terminal'
  );
  const claim = await beginPurchaseWalletReclaim(purchase.id);
  assert.equal(claim.status, 'not_applicable');
  const funding = await findWalletFundingByPurchaseId(purchase.id);
  assert.equal(funding?.status, PurchaseWalletFundingStatus.CONSUMED);
}

async function everyReclaimEntryPointRejectsClearedPurchase(): Promise<void> {
  const directPurchase = await seedHeldPurchase();
  const directFunding = await findWalletFundingByPurchaseId(directPurchase.id);
  assert.ok(directFunding);
  assert.equal((await settlePurchaseAfterTransactionCleared(directPurchase.id)).outcome, 'cleared');
  const direct = await markWalletFundingReclaiming(directFunding.id, {
    reclaimIdempotencyKey: `reclaim-${randomUUID()}`,
    reclaimLeaseToken: `lease-${randomUUID()}`,
    expectedReclaimLeaseToken: null,
    allowConsumed: false,
    allowReclaiming: false,
  });
  assert.equal(direct.count, 0, 'direct reclaim transition must reject a CLEARED purchase');

  const retryPurchase = await seedHeldPurchase();
  const retryFunding = await findWalletFundingByPurchaseId(retryPurchase.id);
  assert.ok(retryFunding);
  assert.equal((await settlePurchaseAfterTransactionCleared(retryPurchase.id)).outcome, 'cleared');
  const retry = await claimWalletFundingReclaimRetry(retryFunding.id, {
    reclaimIdempotencyKey: `reclaim-${randomUUID()}`,
    reclaimLeaseToken: `lease-${randomUUID()}`,
    staleReclaimingBefore: new Date(Date.now() + 60_000),
  });
  assert.equal(retry.count, 0, 'retry reclaim transition must reject a CLEARED purchase');

  const current = await Promise.all([
    findWalletFundingByPurchaseId(directPurchase.id),
    findWalletFundingByPurchaseId(retryPurchase.id),
  ]);
  assert.deepEqual(
    current.map((funding) => funding?.status),
    [PurchaseWalletFundingStatus.CONSUMED, PurchaseWalletFundingStatus.CONSUMED]
  );
}

async function main(): Promise<void> {
  await clearingWaitsForReclaimTransition();
  process.stdout.write('  PASS purchase clearing serializes behind reclaim\n');
  await reclaimCannotClaimClearedPurchase();
  process.stdout.write('  PASS reclaim cannot claim a CLEARED purchase\n');
  await everyReclaimEntryPointRejectsClearedPurchase();
  process.stdout.write('  PASS every reclaim entry point rejects a CLEARED purchase\n');
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const userId of createdUserIds) {
      await prisma.user.deleteMany({ where: { userId } });
    }
    await prisma.$disconnect();
  });
