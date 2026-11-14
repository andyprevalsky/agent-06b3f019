#!/usr/bin/env tsx
/**
 * Unit tests for the purchases Prisma repository (`src/domains/purchases/repo.ts`).
 *
 * Exercises every exported query/mutation against the live local Postgres so the
 * status-transition helpers (wallet-funding lifecycle, held-card lookups, reuse
 * window) are verified end-to-end rather than only through the mint happy path.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import * as repo from '../../domains/purchases/repo';

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

async function seedUser(): Promise<string> {
  const userId = `purchases-repo-unit-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  createdUserIds.push(userId);
  return userId;
}

async function seedPurchase(
  userId: string,
  overrides: Partial<{
    fingerprint: string;
    merchant: string;
    totalCents: number;
    status: PurchaseSpendStatus;
    cardId: string | null;
    stripePaymentIntentId: string | null;
    createdAt: Date;
  }> = {}
): Promise<string> {
  const row = await prisma.purchaseSpend.create({
    data: {
      userId,
      fingerprint: overrides.fingerprint ?? `fp-${randomUUID()}`,
      merchant: overrides.merchant ?? 'Repo Test Merchant',
      lineItemsJson: { currency: 'usd', lineItems: [], totalCents: overrides.totalCents ?? 1080 },
      totalCents: overrides.totalCents ?? 1080,
      status: overrides.status ?? PurchaseSpendStatus.HELD,
      cardId: overrides.cardId === undefined ? `card-${randomUUID()}` : overrides.cardId,
      stripePaymentIntentId:
        overrides.stripePaymentIntentId === undefined
          ? `pi_${randomUUID()}`
          : overrides.stripePaymentIntentId,
      ...(overrides.createdAt !== undefined ? { createdAt: overrides.createdAt } : {}),
    },
  });
  return row.id;
}

async function seedFunding(
  purchaseId: string,
  userId: string,
  status: PurchaseWalletFundingStatus = PurchaseWalletFundingStatus.FUNDED
): Promise<string> {
  const row = await prisma.purchaseWalletFunding.create({
    data: {
      purchaseId,
      userId,
      amountCents: 1080,
      currency: 'usd',
      status,
      idempotencyKey: `purchase-wallet-fund:${purchaseId}`,
    },
  });
  return row.id;
}

async function main(): Promise<void> {
  process.stdout.write('Running purchases repo unit tests...\n');

  await test('createPendingPurchase opens a PENDING_APPROVAL row', async () => {
    const userId = await seedUser();
    const fingerprint = `fp-pending-${randomUUID()}`;
    const purchase = await repo.createPendingPurchase({
      userId,
      agentId: undefined,
      fingerprint,
      merchant: 'Pending Merchant',
      lineItemsJson: { totalCents: 500 },
      totalCents: 500,
    });
    assert.equal(purchase.status, PurchaseSpendStatus.PENDING_APPROVAL);
    assert.equal(purchase.merchant, 'Pending Merchant');
    assert.equal(purchase.cardId, null);
  });

  await test('findMostRecentPurchaseByUserAndFingerprint returns the newest row', async () => {
    const userId = await seedUser();
    const fingerprint = `fp-recent-${randomUUID()}`;
    await seedPurchase(userId, {
      fingerprint,
      status: PurchaseSpendStatus.FAILED,
      createdAt: new Date(Date.now() - 60_000),
    });
    const newerId = await seedPurchase(userId, {
      fingerprint,
      status: PurchaseSpendStatus.HELD,
    });
    const found = await repo.findMostRecentPurchaseByUserAndFingerprint(userId, fingerprint);
    assert.equal(found?.id, newerId);
    const miss = await repo.findMostRecentPurchaseByUserAndFingerprint(userId, 'no-such-fp');
    assert.equal(miss, null);
  });

  await test('findRecentPurchaseByUserAndFingerprint honors the since window', async () => {
    const userId = await seedUser();
    const fingerprint = `fp-window-${randomUUID()}`;
    await seedPurchase(userId, {
      fingerprint,
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const stale = await repo.findRecentPurchaseByUserAndFingerprint(userId, fingerprint, since);
    assert.equal(stale, null, 'a row older than the window must not match');
    const freshId = await seedPurchase(userId, { fingerprint });
    const fresh = await repo.findRecentPurchaseByUserAndFingerprint(userId, fingerprint, since);
    assert.equal(fresh?.id, freshId);
  });

  await test('updatePurchaseStatus writes status plus optional card/intent/lineItems', async () => {
    const userId = await seedUser();
    const purchaseId = await seedPurchase(userId, { status: PurchaseSpendStatus.PENDING_APPROVAL });
    const updated = await repo.updatePurchaseStatus(purchaseId, PurchaseSpendStatus.HELD, {
      cardId: 'card-updated',
      stripePaymentIntentId: 'pi_updated',
      lineItemsJson: { totalCents: 4242 },
    });
    assert.equal(updated.status, PurchaseSpendStatus.HELD);
    assert.equal(updated.cardId, 'card-updated');
    assert.equal(updated.stripePaymentIntentId, 'pi_updated');
    assert.deepEqual(updated.lineItemsJson, { totalCents: 4242 });

    // The no-extra branch leaves lineItemsJson untouched.
    const cleared = await repo.updatePurchaseStatus(purchaseId, PurchaseSpendStatus.CLEARED);
    assert.equal(cleared.status, PurchaseSpendStatus.CLEARED);
    assert.deepEqual(cleared.lineItemsJson, { totalCents: 4242 });
  });

  await test('createOrGetWalletFunding is idempotent on purchaseId', async () => {
    const userId = await seedUser();
    const purchaseId = await seedPurchase(userId);
    const first = await repo.createOrGetWalletFunding({
      purchaseId,
      userId,
      amountCents: 1080,
      currency: 'usd',
      idempotencyKey: `purchase-wallet-fund:${purchaseId}`,
    });
    assert.equal(first.status, PurchaseWalletFundingStatus.PENDING);
    const second = await repo.createOrGetWalletFunding({
      purchaseId,
      userId,
      amountCents: 9999,
      currency: 'usd',
      idempotencyKey: `purchase-wallet-fund:${purchaseId}`,
    });
    assert.equal(second.id, first.id, 'upsert must return the same row');
    assert.equal(second.amountCents, 1080, 'existing amount must not be overwritten');
    const byPurchase = await repo.findWalletFundingByPurchaseId(purchaseId);
    assert.equal(byPurchase?.id, first.id);
  });

  await test('markWalletFundingFunded records transfer id, metadata, and fundedAt', async () => {
    const userId = await seedUser();
    const purchaseId = await seedPurchase(userId);
    const fundingId = await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.PENDING);
    const funded = await repo.markWalletFundingFunded(fundingId, {
      providerTransferId: 'owt_funded',
      metadata: { ok: true },
    });
    assert.equal(funded.status, PurchaseWalletFundingStatus.FUNDED);
    assert.equal(funded.providerTransferId, 'owt_funded');
    assert.deepEqual(funded.metadata, { ok: true });
    assert.notEqual(funded.fundedAt, null);
    assert.equal(funded.errorMessage, null);
  });

  await test('markWalletFundingFailed records the error message', async () => {
    const userId = await seedUser();
    const purchaseId = await seedPurchase(userId);
    const fundingId = await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.PENDING);
    const failed = await repo.markWalletFundingFailed(fundingId, 'boom');
    assert.equal(failed.status, PurchaseWalletFundingStatus.FAILED);
    assert.equal(failed.errorMessage, 'boom');
  });

  await test('markWalletFundingConsumed only consumes FUNDED/CONSUMED rows', async () => {
    const userId = await seedUser();
    const fundedPurchase = await seedPurchase(userId);
    await seedFunding(fundedPurchase, userId, PurchaseWalletFundingStatus.FUNDED);
    const consumed = await repo.markWalletFundingConsumed(fundedPurchase);
    assert.equal(consumed.count, 1);
    const row = await repo.findWalletFundingByPurchaseId(fundedPurchase);
    assert.equal(row?.status, PurchaseWalletFundingStatus.CONSUMED);
    assert.notEqual(row?.consumedAt, null);

    const pendingPurchase = await seedPurchase(userId);
    await seedFunding(pendingPurchase, userId, PurchaseWalletFundingStatus.PENDING);
    const noop = await repo.markWalletFundingConsumed(pendingPurchase);
    assert.equal(noop.count, 0, 'PENDING funding must not be consumed');
  });

  await test('reclaiming lifecycle transitions FUNDED -> RECLAIMING -> RECLAIMED', async () => {
    const userId = await seedUser();
    const purchaseId = await seedPurchase(userId);
    const fundingId = await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.FUNDED);
    const reclaiming = await repo.markWalletFundingReclaiming(fundingId, {
      reclaimIdempotencyKey: `purchase-wallet-reclaim:${purchaseId}`,
    });
    assert.equal(reclaiming.status, PurchaseWalletFundingStatus.RECLAIMING);
    assert.equal(reclaiming.reclaimIdempotencyKey, `purchase-wallet-reclaim:${purchaseId}`);
    const reclaimed = await repo.markWalletFundingReclaimed(fundingId, {
      providerTransferId: 'owt_reclaimed',
      metadata: { released: true },
    });
    assert.equal(reclaimed.status, PurchaseWalletFundingStatus.RECLAIMED);
    assert.equal(reclaimed.reclaimProviderTransferId, 'owt_reclaimed');
    assert.notEqual(reclaimed.reclaimedAt, null);
  });

  await test('markWalletFundingReclaimFailed records the reclaim error', async () => {
    const userId = await seedUser();
    const purchaseId = await seedPurchase(userId);
    const fundingId = await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.RECLAIMING);
    const failed = await repo.markWalletFundingReclaimFailed(fundingId, 'release pending');
    assert.equal(failed.status, PurchaseWalletFundingStatus.RECLAIM_FAILED);
    assert.equal(failed.errorMessage, 'release pending');
  });

  await test('findSubscriptionByUserId returns the persisted subscription', async () => {
    const userId = await seedUser();
    assert.equal(await repo.findSubscriptionByUserId(userId), null);
    await prisma.subscription.create({
      data: {
        userId,
        subscriptionTier: 1,
        stripeSubscriptionId: `sub_${randomUUID()}`,
        stripeCustomerId: `cus_${randomUUID()}`,
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    const subscription = await repo.findSubscriptionByUserId(userId);
    assert.notEqual(subscription, null);
    assert.ok(subscription?.stripeCustomerId?.startsWith('cus_'));
  });

  await test('findPurchaseByCardId returns the newest purchase for the card', async () => {
    const userId = await seedUser();
    const cardId = `card-shared-${randomUUID()}`;
    await seedPurchase(userId, { cardId, createdAt: new Date(Date.now() - 60_000) });
    const newerId = await seedPurchase(userId, { cardId });
    const found = await repo.findPurchaseByCardId(cardId);
    assert.equal(found?.id, newerId);
    assert.equal(await repo.findPurchaseByCardId('missing-card'), null);
  });

  await test('findPurchaseByCardId scopes ownership before ordering shared card purchases', async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const cardId = `card-shared-owners-${randomUUID()}`;
    await seedPurchase(owner, { cardId, createdAt: new Date(Date.now() - 120_000) });
    const ownId = await seedPurchase(owner, { cardId, createdAt: new Date(Date.now() - 60_000) });
    const otherId = await seedPurchase(other, { cardId });
    assert.equal((await repo.findPurchaseByCardId(cardId, owner))?.id, ownId);
    assert.equal((await repo.findPurchaseByCardId(cardId, other))?.id, otherId);
    assert.equal(await repo.findPurchaseByCardId(cardId, 'not-an-owner'), null);
    assert.equal(
      (await repo.findPurchaseByCardId(cardId))?.id,
      otherId,
      'trusted reconciliation retains the unscoped provider-card lookup'
    );
  });

  await test('findHeldPurchasesByTotal returns HELD carded rows and respects the limit', async () => {
    const userId = await seedUser();
    const totalCents = 3300 + Math.floor(Math.random() * 1000);
    const heldId = await seedPurchase(userId, { totalCents, status: PurchaseSpendStatus.HELD });
    await seedPurchase(userId, { totalCents, status: PurchaseSpendStatus.HELD, cardId: null });
    await seedPurchase(userId, { totalCents, status: PurchaseSpendStatus.CLEARED });
    const held = await repo.findHeldPurchasesByTotal(totalCents);
    const ids = held.map((row) => row.id);
    assert.ok(ids.includes(heldId), 'HELD carded row must be returned');
    assert.ok(
      held.every((row) => row.status === PurchaseSpendStatus.HELD && row.cardId !== null),
      'only HELD carded rows are eligible'
    );
    const limited = await repo.findHeldPurchasesByTotal(totalCents, 1);
    assert.ok(limited.length <= 1, 'limit must bound the result set');
  });

  process.stdout.write(
    `\nPurchases repo unit tests: ${passed} passed, ${failures.length} failed\n`
  );
  for (const failure of failures) process.stdout.write(`  ${failure}\n`);
}

async function cleanup(): Promise<void> {
  for (const userId of createdUserIds) {
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
