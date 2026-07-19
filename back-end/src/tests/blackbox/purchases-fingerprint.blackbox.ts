#!/usr/bin/env tsx
/** Cross-runtime purchase fingerprint and legacy-index backfill regressions. */

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { PurchaseSpendStatus } from '@prisma/client';
import { PurchaseError } from '../../domains/purchases/errors';
import { canonicalStoredPurchaseFingerprint } from '../../domains/purchases/fingerprint';
import * as purchasesRepo from '../../domains/purchases/repo';
import * as purchasesService from '../../domains/purchases/service';
import { prisma } from '../../providers/database';
import { retryWithBackoff } from '../../providers/retry';
import { assert, StubCardStateProvider } from './purchases.testkit';

config();

const RUN_ID = process.env.BLACKBOX_TEST_RUN_ID || `${Date.now()}-${randomUUID().slice(0, 8)}`;
const trackedUserIds = new Set<string>();

async function createUser(label: string): Promise<string> {
  const userId = `purchase-fingerprint-${RUN_ID}-${label}-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  trackedUserIds.add(userId);
  return userId;
}

function fixtureReceipt(
  name: string,
  reviewCount: string,
  totalCents = 1200,
  imageUrl = 'https://example.test/item.png',
  productUrl = 'https://example.test/p/item'
) {
  return {
    currency: 'USD',
    lineItems: [
      {
        name,
        imageUrl,
        productUrl,
        rating: '4.8 stars',
        reviewCount,
        unitPriceCents: totalCents,
        quantity: 1,
        lineTotalCents: totalCents,
      },
    ],
    fees: [],
    subtotalCents: totalCents,
    totalCents,
  };
}

async function testUnicodeParity(): Promise<void> {
  const unicodeReceipt = fixtureReceipt(
    'Lámpara 🪔',
    '1,284 reviews',
    1200,
    'https://example.test/lamp.png',
    'https://example.test/p/lamp'
  );
  assert(
    canonicalStoredPurchaseFingerprint({
      userId: 'fixture-user',
      merchant: 'Café 🛍️',
      lineItemsJson: unicodeReceipt,
      totalCents: 1200,
    }) === '4371b8e8e65a46dd90791b63be4c448d4468e63d73a4e18d542e2f98f78b4fbc',
    'Unicode fingerprints must match Python ensure_ascii JSON byte-for-byte'
  );

  const controlReceipt = fixtureReceipt(
    'Control',
    '1,284 reviews',
    1200,
    'https://example.test/control.png',
    'https://example.test/p/control'
  );
  assert(
    canonicalStoredPurchaseFingerprint({
      userId: 'fixture-user',
      merchant: 'DEL\u007f',
      lineItemsJson: controlReceipt,
      totalCents: 1200,
    }) === '74d08f6f960b66ef68b819e83f8a0beb474894ac01633991afe585a76ee10dbe',
    'DEL must be escaped exactly like Python ensure_ascii JSON'
  );

  const localizedReceipt = fixtureReceipt(
    'Localized',
    '١,٢٨٤ reviews',
    1200,
    'https://example.test/localized.png',
    'https://example.test/p/localized'
  );
  assert(
    canonicalStoredPurchaseFingerprint({
      userId: 'fixture-user',
      merchant: 'Localized Merchant',
      lineItemsJson: localizedReceipt,
      totalCents: 1200,
    }) === '420d16398a5ef89852f906f68a59a3768ad0f40223a02b219537c04ad137ccd8',
    'Unicode decimal-digit separators must match Python canonicalization'
  );
}

async function testBackfillBeyondTwenty(): Promise<void> {
  const userId = await createUser('over-twenty');
  const baseTime = new Date('2026-07-19T12:00:00.000Z');
  const receipts = Array.from({ length: 21 }, (_, index) =>
    fixtureReceipt(`Legacy item ${index}`, `${index + 1},284 reviews`, 1200 + index)
  );
  const targetCardId = `held-card-${randomUUID()}`;
  await Promise.all(
    receipts.map((receipt, index) =>
      prisma.purchaseSpend.create({
        data: {
          userId,
          fingerprint: `legacy-rank-${index}-${randomUUID()}`,
          merchant: 'Legacy Rank Merchant',
          lineItemsJson: receipt,
          totalCents: receipt.totalCents,
          status: PurchaseSpendStatus.HELD,
          cardId: index === 0 ? targetCardId : `noise-card-${randomUUID()}`,
          createdAt: new Date(baseTime.getTime() + index * 1000),
        },
      })
    )
  );
  const targetRetryReceipt = fixtureReceipt('Legacy item 0', '1284 reviews');
  const targetFingerprint = canonicalStoredPurchaseFingerprint({
    userId,
    merchant: 'Legacy Rank Merchant',
    lineItemsJson: targetRetryReceipt,
    totalCents: targetRetryReceipt.totalCents,
  });
  assert(targetFingerprint !== null, 'target receipt should produce a canonical fingerprint');

  const backfillCounts = await Promise.all(
    Array.from({ length: 2 }, () =>
      purchasesRepo.backfillLegacyCanonicalFingerprints(
        userId,
        new Date('2026-07-19T11:00:00.000Z'),
        new Date('2026-07-20T00:00:00.000Z')
      )
    )
  );
  assert(
    backfillCounts.reduce((sum, count) => sum + count, 0) === 21,
    'concurrent backfills should process each legacy row exactly once'
  );
  assert(
    backfillCounts.filter((count) => count > 0).length === 1,
    'the advisory lock should give only one concurrent caller the backfill batch'
  );

  const result = await purchasesService.lookupPurchase(
    userId,
    targetFingerprint,
    new StubCardStateProvider({ status: 'OPEN', balanceCents: 1200 }),
    new Date('2026-07-19T13:00:00.000Z')
  );

  assert(result.reusable === true, 'the oldest of 21 legacy holds should remain reusable');
  assert(result.purchase?.cardId === targetCardId, 'lookup should return the oldest target card');
  assert(
    (await prisma.purchaseSpend.count({
      where: { userId, canonicalFingerprint: { not: null } },
    })) === 21,
    'the one-time backfill should index every eligible legacy hold'
  );
}

async function testChargingMintGuard(): Promise<void> {
  const userId = await createUser('charging-guard');
  const storedReceipt = fixtureReceipt('In-flight item', '1,284 reviews');
  const retryReceipt = fixtureReceipt('In-flight item', '1284 reviews');
  const canonicalFingerprint = canonicalStoredPurchaseFingerprint({
    userId,
    merchant: 'In-flight Merchant',
    lineItemsJson: retryReceipt,
    totalCents: 1200,
  });
  assert(canonicalFingerprint !== null, 'retry receipt should produce a canonical fingerprint');
  const createdAt = new Date('2026-07-17T12:00:00.000Z');
  const updatedAt = new Date('2026-07-19T12:00:00.000Z');
  const chargingPurchase = await prisma.purchaseSpend.create({
    data: {
      userId,
      fingerprint: `legacy-charging-${randomUUID()}`,
      merchant: 'In-flight Merchant',
      lineItemsJson: storedReceipt,
      totalCents: 1200,
      status: PurchaseSpendStatus.CHARGING,
      createdAt,
      updatedAt,
    },
  });
  await prisma.purchaseSpend.create({
    data: {
      userId,
      fingerprint: `recent-lookup-noise-${randomUUID()}`,
      merchant: 'Recent Lookup Merchant',
      lineItemsJson: fixtureReceipt('Recent lookup item', '9,876 reviews'),
      totalCents: 1200,
      status: PurchaseSpendStatus.PENDING_APPROVAL,
      createdAt: new Date('2026-07-19T12:30:00.000Z'),
    },
  });

  let releaseLock = () => undefined;
  let signalLocked = () => undefined;
  const releaseRequested = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const lockAcquired = new Promise<void>((resolve) => {
    signalLocked = resolve;
  });
  const blocker = prisma.$transaction(
    async (transaction) => {
      // Keep the repo's per-user lock occupied so the recent lookup is provably first and the
      // history-wide mint joins while that narrower service-level request is still active.
      await transaction.$queryRaw`
        WITH acquired AS MATERIALIZED (
          SELECT pg_advisory_xact_lock(hashtextextended(${userId}, ${8_675_309}))
        )
        SELECT 1 AS locked FROM acquired
      `;
      signalLocked();
      await releaseRequested;
    },
    { maxWait: 10_000, timeout: 10_000 }
  );
  await lockAcquired;

  async function waitForAdvisoryWaiters(expected: number): Promise<void> {
    await retryWithBackoff(
      async () => {
        const [row] = await prisma.$queryRaw<Array<{ waiters: number }>>`
        SELECT count(*)::int AS waiters
        FROM pg_stat_activity
        WHERE wait_event = 'advisory'
          AND query LIKE '%hashtextextended%'
      `;
        if ((row?.waiters ?? 0) >= expected) return;
        throw new Error(`expected ${expected} advisory lock waiters`);
      },
      {
        maxRetries: 100,
        fixedDelays: new Array(99).fill(10),
        isRetryable: () => true,
        component: 'PurchaseFingerprintLockWait',
      }
    );
  }

  const recentLookup = purchasesService.lookupPurchase(
    userId,
    `missing-recent-${randomUUID()}`,
    undefined,
    new Date('2026-07-19T13:00:00.000Z')
  );
  await waitForAdvisoryWaiters(1);

  const mintAttempt = purchasesService
    .mintPurchaseCard(
      {
        userId,
        fingerprint: canonicalFingerprint,
        merchant: 'In-flight Merchant',
        ...retryReceipt,
      },
      undefined,
      undefined,
      new Date('2026-07-19T12:01:00.000Z')
    )
    .then((): unknown => undefined)
    .catch((error: unknown) => error);
  await waitForAdvisoryWaiters(2);
  releaseLock();

  const [lookupResult, thrown] = await Promise.all([recentLookup, mintAttempt, blocker]);

  assert(lookupResult.found === false, 'the unrelated recent lookup should remain a miss');
  assert(thrown instanceof PurchaseError, 'canonical retry should surface a PurchaseError');
  assert(
    thrown.statusCode === 409,
    `canonical retry should preserve 409, got ${thrown.statusCode}`
  );
  assert(
    (await prisma.purchaseSpend.count({ where: { userId } })) === 2,
    'canonical retry must not create a third purchase row'
  );
  const indexed = await prisma.purchaseSpend.findUnique({ where: { id: chargingPurchase.id } });
  assert(
    indexed?.canonicalFingerprint === canonicalFingerprint,
    'the >24-hour CHARGING row should be indexed before the mint guard runs'
  );
}

async function main(): Promise<void> {
  try {
    await testUnicodeParity();
    await testBackfillBeyondTwenty();
    await testChargingMintGuard();
    console.log('PASS purchase fingerprint parity and legacy indexed backfill');
  } finally {
    for (const userId of trackedUserIds) {
      await prisma.user.deleteMany({ where: { userId } });
    }
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
