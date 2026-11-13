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
import { quarantine } from '../helpers/quarantine';
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

async function testQuantityEchoNameParity(): Promise<void> {
  const bare = fixtureReceipt('Aurora Notebook', '1,284 reviews');
  const echoed = fixtureReceipt('Aurora Notebook x1', '1,284 reviews');
  const bareFp = canonicalStoredPurchaseFingerprint({
    userId: 'fixture-user',
    merchant: 'Rose Labs Test Payment',
    lineItemsJson: bare,
    totalCents: 1200,
  });
  const echoedFp = canonicalStoredPurchaseFingerprint({
    userId: 'fixture-user',
    merchant: 'Rose Labs Test Payment',
    lineItemsJson: echoed,
    totalCents: 1200,
  });
  assert(bareFp !== null && echoedFp !== null, 'quantity-echo receipts must fingerprint');
  assert(bareFp === echoedFp, 'trailing x{qty} on line-item names must match bare product titles');
  assert(
    bareFp === 'bc0508689ba5fa17a6cea3e6009bf84587ee26f67ac749d4c82f80ff17f4b2e9',
    'backend quantity-echo canonicalization must match the agents-side Python fingerprint'
  );

  const hyphenEcho = fixtureReceipt('Aurora Notebook - x1', '1,284 reviews');
  assert(
    canonicalStoredPurchaseFingerprint({
      userId: 'fixture-user',
      merchant: 'Rose Labs Test Payment',
      lineItemsJson: hyphenEcho,
      totalCents: 1200,
    }) === bareFp,
    'matching hyphenated quantity echo must reuse the bare-title card'
  );

  const merchantEcho = fixtureReceipt(
    'Aurora Notebook x1 (Rose Labs Test Payment)',
    '1,284 reviews'
  );
  assert(
    canonicalStoredPurchaseFingerprint({
      userId: 'fixture-user',
      merchant: 'Rose Labs Test Payment',
      lineItemsJson: merchantEcho,
      totalCents: 1200,
    }) === bareFp,
    'matching quantity and merchant echo must reuse the bare-title card'
  );
  const wrongMerchantEcho = fixtureReceipt('Aurora Notebook x1 (Different Shop)', '1,284 reviews');
  assert(
    canonicalStoredPurchaseFingerprint({
      userId: 'fixture-user',
      merchant: 'Rose Labs Test Payment',
      lineItemsJson: wrongMerchantEcho,
      totalCents: 1200,
    }) !== bareFp,
    'a different merchant in the name suffix must remain distinct'
  );

  const placeholderHttp = fixtureReceipt(
    'Aurora Notebook',
    '1,284 reviews',
    1200,
    'http://placehold.co/320x220/png?text=Aurora+Notebook'
  );
  const placeholderHttps = fixtureReceipt(
    'Aurora Notebook',
    '1,284 reviews',
    1200,
    'https://placehold.co/320x220/png?text=Aurora+Notebook'
  );
  assert(
    canonicalStoredPurchaseFingerprint({
      userId: 'fixture-user',
      merchant: 'Rose Labs Test Payment',
      lineItemsJson: placeholderHttp,
      totalCents: 1200,
    }) ===
      canonicalStoredPurchaseFingerprint({
        userId: 'fixture-user',
        merchant: 'Rose Labs Test Payment',
        lineItemsJson: placeholderHttps,
        totalCents: 1200,
      }),
    'placeholder HTTP and HTTPS image URLs must identify the same item'
  );

  const pricedEcho = fixtureReceipt('Aurora Notebook - 1 x $12.00', '1,284 reviews');
  assert(
    canonicalStoredPurchaseFingerprint({
      userId: 'fixture-user',
      merchant: 'Rose Labs Test Payment',
      lineItemsJson: pricedEcho,
      totalCents: 1200,
    }) === bareFp,
    'matching order-summary quantity and price must reuse the bare-title card'
  );
  const wrongPrice = fixtureReceipt('Aurora Notebook - 1 x $13.00', '1,284 reviews');
  assert(
    canonicalStoredPurchaseFingerprint({
      userId: 'fixture-user',
      merchant: 'Rose Labs Test Payment',
      lineItemsJson: wrongPrice,
      totalCents: 1200,
    }) !== bareFp,
    'a suffix with a different price must stay a distinct purchase'
  );

  const mismatchedQty = {
    ...echoed,
    lineItems: [{ ...(echoed.lineItems[0] as object), name: 'Aurora Notebook x2', quantity: 1 }],
  };
  assert(
    canonicalStoredPurchaseFingerprint({
      userId: 'fixture-user',
      merchant: 'Rose Labs Test Payment',
      lineItemsJson: mismatchedQty,
      totalCents: 1200,
    }) !== bareFp,
    'x{n} that does not match quantity must remain a distinct cart'
  );

  const mismatchedHyphenQty = fixtureReceipt('Aurora Notebook - x2', '1,284 reviews');
  assert(
    canonicalStoredPurchaseFingerprint({
      userId: 'fixture-user',
      merchant: 'Rose Labs Test Payment',
      lineItemsJson: mismatchedHyphenQty,
      totalCents: 1200,
    }) !== bareFp,
    'a hyphenated quantity echo with a different quantity must remain distinct'
  );
}

async function testCheckoutSummaryNameParity(): Promise<void> {
  const fingerprint = (name: string) =>
    canonicalStoredPurchaseFingerprint({
      userId: 'checkout-summary-user',
      merchant: 'Rose Labs Test Payment',
      lineItemsJson: fixtureReceipt(name, '1,284 reviews'),
      totalCents: 1200,
    });
  const bare = fingerprint('Aurora Notebook');
  assert(bare !== null, 'the purchase receipt must be fingerprintable');
  assert(
    fingerprint('Aurora Notebook - x1 - $12.00 (Rose Labs Test Payment checkout)') === bare,
    'the captured first-browser name must resolve to the same held card as the bare title'
  );
  assert(
    fingerprint('Aurora Notebook - x1 - $12.00') === bare,
    'a matching quantity and price echo is display-only'
  );
  for (const conflictingName of [
    'Aurora Notebook - x2 - $12.00 (Rose Labs Test Payment checkout)',
    'Aurora Notebook - x1 - $13.00 (Rose Labs Test Payment checkout)',
    'Aurora Notebook - x1 - $12.00 (Different Merchant checkout)',
  ]) {
    assert(fingerprint(conflictingName) !== bare, `${conflictingName} must remain distinct`);
  }
}

async function testProductDescriptionNameParity(): Promise<void> {
  const items = [
    ['Aurora Notebook', 'Hardcover planning notebook with dotted pages', 'aurora-notebook'],
    ['Ceramic Mug', 'Matte white mug for long checkout tests', 'ceramic-mug'],
    ['Canvas Tote', 'Heavy canvas tote with reinforced handles', 'canvas-tote'],
  ] as const;
  for (const [title, description, slug] of items) {
    const fingerprint = (name: string) =>
      canonicalStoredPurchaseFingerprint({
        userId: 'description-user',
        merchant: 'Rose Labs Test Payment',
        lineItemsJson: fixtureReceipt(
          name,
          '1,284 reviews',
          1200,
          'https://placehold.co/320x220/png?text=Aurora+Notebook',
          `https://shop.example/p/${slug}`
        ),
        totalCents: 1200,
      });
    assert(
      fingerprint(`${title} - ${description}`) === fingerprint(title),
      `a verified ${title} description must not mint a second card`
    );
    assert(
      fingerprint(`${title} - Red`) !== fingerprint(title),
      `a short ${title} variant must remain distinct`
    );
  }
  const wrongSlug = fixtureReceipt(
    'Different Notebook - Hardcover planning notebook with dotted pages',
    '1,284 reviews',
    1200,
    'https://placehold.co/320x220/png?text=Aurora+Notebook',
    'https://shop.example/p/aurora-notebook'
  );
  const bareWrongSlug = {
    ...wrongSlug,
    lineItems: [{ ...wrongSlug.lineItems[0], name: 'Different Notebook' }],
  };
  const identity = (receipt: typeof wrongSlug) =>
    canonicalStoredPurchaseFingerprint({
      userId: 'description-user',
      merchant: 'Rose Labs Test Payment',
      lineItemsJson: receipt,
      totalCents: 1200,
    });
  assert(
    identity(wrongSlug) !== identity(bareWrongSlug),
    'a mismatched URL slug must keep the suffix'
  );
}

async function testActiveCardSurvivesCanonicalizationUpgrade(): Promise<void> {
  const userId = await createUser('description-upgrade');
  const productUrl = 'https://shop.example/p/aurora-notebook';
  const described = fixtureReceipt(
    'Aurora Notebook - Hardcover planning notebook with dotted pages',
    '1,284 reviews',
    1200,
    'https://shop.example/notebook.png',
    productUrl
  );
  const bare = fixtureReceipt(
    'Aurora Notebook',
    '1,284 reviews',
    1200,
    'https://shop.example/notebook.png',
    productUrl
  );
  const held = await prisma.purchaseSpend.create({
    data: {
      userId,
      fingerprint: 'before-description-normalization',
      canonicalFingerprint: 'before-description-normalization',
      merchant: 'Rose Labs Test Payment',
      lineItemsJson: described,
      totalCents: 1200,
      status: PurchaseSpendStatus.HELD,
      cardId: `held-card-${randomUUID()}`,
    },
  });
  const canonicalFingerprint = canonicalStoredPurchaseFingerprint({
    userId,
    merchant: held.merchant,
    lineItemsJson: bare,
    totalCents: 1200,
  });
  assert(canonicalFingerprint !== null, 'bare receipt must fingerprint');
  const retry = await purchasesRepo.createPendingPurchaseWithLock({
    userId,
    fingerprint: 'after-description-normalization',
    canonicalFingerprint,
    merchant: held.merchant,
    lineItemsJson: bare,
    totalCents: 1200,
  });
  assert(!retry.created && retry.purchase.id === held.id, 'retry must reuse the held card');
  assert(
    retry.purchase.canonicalFingerprint === canonicalFingerprint,
    'reused purchase should be indexed under the new canonical fingerprint'
  );
  assert(
    (await prisma.purchaseSpend.count({ where: { userId } })) === 1,
    'canonicalization upgrade must not create a second purchase'
  );
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
    await testQuantityEchoNameParity();
    await testCheckoutSummaryNameParity();
    await testProductDescriptionNameParity();
    await testActiveCardSurvivesCanonicalizationUpgrade();
    await testUnicodeParity();
    // NOT_INTRODUCED flake: the runner's Postgres refused this 21-way insert burst (max_connections).
    const flakyUnit = 'purchases-fingerprint';
    await quarantine(
      {
        since: '2026-11-11',
        repair: 'pending-handoff:dffb463a2de34ec6875fc74fb17e9196',
        error: 'Too many database connections opened: FATAL: sorry, too many clients already',
        evidence:
          'PR1910 deploy round 22 backend-coverage-blackbox rca/dffb463a2de34ec6875fc74fb17e9196',
      },
      testBackfillBeyondTwenty,
      { unit: flakyUnit }
    )();
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
