#!/usr/bin/env tsx
/**
 * Black-box tests (part 5) for the purchases domain.
 *
 * Exercises the charge/rollback compensation branches, the mint recovery guards, the Stripe
 * KYC and wallet-funding helpers through local fakes, so no live provider is touched.
 * Split from purchases.blackbox.ts to stay under the max-lines cap.
 */

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import { stripe } from '../../providers/stripe';
import * as purchasesService from '../../domains/purchases/service';
import { KYC_REQUIRED_CODE } from '../../domains/purchases/kyc';
import { PurchaseError } from '../../domains/purchases/errors';
import { confirmPurchaseWalletCollection } from '../../domains/purchases/walletFunding';
import {
  assert,
  FailingDetailsAndCloseCardProvider,
  FailingDetailsCardProvider,
  FakeCardProvider,
  FakeWalletFundingProvider,
  FundingInProgressNoTransferCardProvider,
  NoTransferIdCardProvider,
  withFakeStripe,
} from './purchases.testkit';

config();

const RUN_ID = process.env.BLACKBOX_TEST_RUN_ID || `${Date.now()}-${randomUUID().slice(0, 8)}`;
const trackedUserIds = new Set<string>();
const BENCHMARK_KYC_USER_ID = '00000000-0000-4000-8000-000000000103';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function createUser(label: string): Promise<string> {
  const userId = `purchase5-${RUN_ID}-${label}-${randomUUID()}`;
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

function mintBody(
  userId: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    userId,
    fingerprint: `fp-${randomUUID()}`,
    merchant: 'Test Merchant',
    currency: 'USD',
    lineItems: [{ label: 'Widget', amountCents: 1000 }],
    fees: [{ label: 'Tax', amountCents: 80 }],
    subtotalCents: 1000,
    totalCents: 1000,
    ...overrides,
  };
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

async function expectPurchaseError(fn: () => Promise<unknown>): Promise<PurchaseError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof PurchaseError) return error;
    throw new Error(`expected PurchaseError, got ${String(error)}`);
  }
  throw new Error('expected PurchaseError, but call resolved');
}

async function expectThrow(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected the call to throw, but it resolved');
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    'mint preserves an ambiguous provider result without opening a second external attempt',
    async () => {
      const userId = await createSubscribedUser('no-transfer-id');
      const provider = new NoTransferIdCardProvider();
      const walletProvider = new FakeWalletFundingProvider();
      const fingerprint = `no-transfer-${randomUUID()}`;

      await withFakeStripe(async (calls) => {
        const error = await expectPurchaseError(() =>
          purchasesService.mintPurchaseCard(
            mintBody(userId, { fingerprint }) as never,
            provider,
            walletProvider
          )
        );
        assert(
          error.code === 'agentcard_company_funding_in_progress',
          `expected funding-in-progress code, got ${error.code}`
        );
        assert(
          provider.closeCalls === 0,
          'an unpersisted provider result must be replayed, not guessed'
        );
        assert(calls.captures.length === 0, 'a card without a transfer must never be captured');
        assert(
          calls.cancels.length === 0,
          'the hold stays while the exact provider key is retryable'
        );
        assert(calls.refunds.length === 0, 'an uncaptured hold is canceled, not refunded');

        const row = await prisma.purchaseSpend.findFirst({ where: { userId, fingerprint } });
        assert(
          row?.status === PurchaseSpendStatus.FUNDING_PENDING,
          `expected FUNDING_PENDING, got ${row?.status}`
        );
      });
    },
  ],
  [
    'mint records FUNDING_RECLAIM_FAILED when the compensating card close also fails',
    async () => {
      const userId = await createSubscribedUser('close-fail');
      const provider = new FailingDetailsAndCloseCardProvider();
      const walletProvider = new FakeWalletFundingProvider();
      const fingerprint = `close-fail-${randomUUID()}`;

      await withFakeStripe(async (calls) => {
        const error = await expectThrow(() =>
          purchasesService.mintPurchaseCard(
            mintBody(userId, { fingerprint }) as never,
            provider,
            walletProvider
          )
        );
        assert(error.message.includes('card details failed'), 'the mint failure must surface');
        // Card was minted + funding recorded + charge captured, then getDetails failed. The
        // compensating close throws, so the payment reversal is deliberately skipped for manual
        // reconciliation.
        assert(provider.closeCalls === 1, 'rollback must attempt to close the issued card');
        assert(calls.captures.length === 1, 'the hold was captured before the failure');
        assert(calls.cancels.length === 0, 'a captured charge is never canceled');
        assert(calls.refunds.length === 0, 'reversal is skipped when the card close fails');

        const row = await prisma.purchaseSpend.findFirst({ where: { userId, fingerprint } });
        assert(
          row?.status === PurchaseSpendStatus.FUNDING_RECLAIM_FAILED,
          `expected FUNDING_RECLAIM_FAILED, got ${row?.status}`
        );
      });
    },
  ],
  [
    'mint records REFUND_FAILED when the captured charge cannot be reversed',
    async () => {
      const userId = await createSubscribedUser('refund-fail');
      const provider = new FailingDetailsCardProvider();
      const walletProvider = new FakeWalletFundingProvider();
      const fingerprint = `refund-fail-${randomUUID()}`;

      await withFakeStripe(
        async (calls) => {
          const error = await expectThrow(() =>
            purchasesService.mintPurchaseCard(
              mintBody(userId, { fingerprint }) as never,
              provider,
              walletProvider
            )
          );
          assert(error.message.includes('card details failed'), 'the mint failure must surface');
          // Card minted + captured, getDetails failed; the card closed cleanly and its funding was
          // reclaimed, so the captured charge must be refunded — but the refund fails here.
          assert(provider.closeCalls === 1, 'the issued card must be closed on rollback');
          assert(
            walletProvider.reclaimCalls.length === 1,
            'the recorded funding must be reclaimed before the refund attempt'
          );
          assert(calls.captures.length === 1, 'the hold was captured before the failure');
          assert(calls.refunds.length === 0, 'the refund attempt threw, so none was recorded');

          const row = await prisma.purchaseSpend.findFirst({ where: { userId, fingerprint } });
          assert(
            row?.status === PurchaseSpendStatus.REFUND_FAILED,
            `expected REFUND_FAILED, got ${row?.status}`
          );
        },
        { refundError: new Error('temporary Stripe refund failure') }
      );
    },
  ],
  [
    'mint preserves a resumable purchase when company funding stays in progress with no transfer',
    async () => {
      const userId = await createSubscribedUser('funding-in-progress-no-transfer');
      const provider = new FundingInProgressNoTransferCardProvider();
      const walletProvider = new FakeWalletFundingProvider();
      const fingerprint = `funding-in-progress-${randomUUID()}`;

      await withFakeStripe(async (calls) => {
        const error = await expectThrow(() =>
          purchasesService.mintPurchaseCard(
            mintBody(userId, { fingerprint }) as never,
            provider,
            walletProvider
          )
        );
        assert(
          error instanceof PurchaseError && error.code === 'agentcard_company_funding_in_progress',
          'the typed in-progress funding error must surface'
        );
        // No card was issued, but the provider may still finish the idempotent request. Preserve
        // both the hold and its durable funding marker for a same-purchase retry.
        assert(provider.closeCalls === 0, 'no card was issued, so none should be closed');
        assert(calls.captures.length === 0, 'the hold must not be captured');
        assert(calls.cancels.length === 0, 'the hold must survive the resumable provider attempt');
        assert(calls.refunds.length === 0, 'an uncaptured hold is never refunded');

        const row = await prisma.purchaseSpend.findFirst({
          where: { userId, fingerprint },
          include: { walletFunding: true },
        });
        assert(
          row?.status === PurchaseSpendStatus.FUNDING_PENDING,
          `expected FUNDING_PENDING, got ${row?.status}`
        );
        assert(
          row?.walletFunding?.status === PurchaseWalletFundingStatus.PENDING,
          `expected PENDING funding marker, got ${row?.walletFunding?.status}`
        );
      });
    },
  ],
  [
    'lookup rejects a blank fingerprint at the service boundary',
    async () => {
      const userId = await createUser('lookup-blank');
      const error = await expectPurchaseError(() => purchasesService.lookupPurchase(userId, '   '));
      assert(error.message.includes('fingerprint'), 'error should mention fingerprint');
    },
  ],
  [
    'mint rejects a concurrent in-flight purchase for the same cart with 409',
    async () => {
      const userId = await createSubscribedUser('in-flight');
      const fingerprint = `in-flight-${randomUUID()}`;
      await prisma.purchaseSpend.create({
        data: {
          userId,
          fingerprint,
          merchant: 'In Flight Merchant',
          lineItemsJson: { totalCents: 1000 },
          totalCents: 1000,
          status: PurchaseSpendStatus.CHARGING,
          stripePaymentIntentId: `pi_inflight_${randomUUID()}`,
          updatedAt: new Date(),
        },
      });

      const error = await expectPurchaseError(() =>
        purchasesService.mintPurchaseCard(
          mintBody(userId, { fingerprint }) as never,
          new FakeCardProvider(),
          new FakeWalletFundingProvider()
        )
      );
      assert(error.statusCode === 409, `expected 409, got ${error.statusCode}`);
      assert(error.message.includes('already in progress'), 'error should say in progress');
    },
  ],
  [
    'request recovery leaves an interrupted issued card to the cron compensator',
    async () => {
      const userId = await createSubscribedUser('stale-reclaim-fail');
      const fingerprint = `stale-reclaim-fail-${randomUUID()}`;
      const stale = await prisma.purchaseSpend.create({
        data: {
          userId,
          fingerprint,
          merchant: 'Stale Merchant',
          lineItemsJson: { totalCents: 1000 },
          totalCents: 1000,
          status: PurchaseSpendStatus.CHARGING,
          cardId: `card_stale_${randomUUID()}`,
          stripePaymentIntentId: `pi_stale_${randomUUID()}`,
          updatedAt: new Date(Date.now() - 60 * 60 * 1000),
        },
      });
      await prisma.purchaseWalletFunding.create({
        data: {
          purchaseId: stale.id,
          userId,
          amountCents: 1000,
          currency: 'usd',
          status: PurchaseWalletFundingStatus.FUNDED,
          providerTransferId: `wft_${randomUUID()}`,
          idempotencyKey: `purchase-wallet-fund:${stale.id}`,
        },
      });
      const walletProvider = new FakeWalletFundingProvider();
      walletProvider.failReclaim = true;

      await withFakeStripe(async () => {
        const error = await expectPurchaseError(() =>
          purchasesService.mintPurchaseCard(
            mintBody(userId, { fingerprint }) as never,
            new FakeCardProvider(),
            walletProvider
          )
        );
        assert(error.statusCode === 409, `expected 409, got ${error.statusCode}`);
        assert(error.code === 'purchase_funding_reconciliation_in_progress');
        const row = await prisma.purchaseSpend.findUnique({ where: { id: stale.id } });
        assert(
          row?.status === PurchaseSpendStatus.CHARGING,
          `expected CHARGING, got ${row?.status}`
        );
        assert(walletProvider.reclaimCalls.length === 0, 'HTTP recovery must not own card cleanup');
      });
    },
  ],
  [
    'stale recovery blocks a new purchase while Stripe cancellation is failing',
    async () => {
      const userId = await createSubscribedUser('stale-cancel-fail');
      const fingerprint = `stale-cancel-fail-${randomUUID()}`;
      const stale = await prisma.purchaseSpend.create({
        data: {
          userId,
          fingerprint,
          merchant: 'Stale Cancel Merchant',
          lineItemsJson: { totalCents: 1000 },
          totalCents: 1000,
          status: PurchaseSpendStatus.CHARGING,
          stripePaymentIntentId: `pi_stale_cancel_${randomUUID()}`,
          updatedAt: new Date(Date.now() - 60 * 60 * 1000),
        },
      });
      const provider = new FakeCardProvider();
      const walletProvider = new FakeWalletFundingProvider();

      await withFakeStripe(async () => {
        const originalCancel = stripe.paymentIntents.cancel;
        (stripe.paymentIntents as unknown as { cancel: unknown }).cancel = async () => {
          throw new Error('stripe cancel unavailable');
        };
        try {
          const error = await expectPurchaseError(() =>
            purchasesService.mintPurchaseCard(
              mintBody(userId, { fingerprint }) as never,
              provider,
              walletProvider
            )
          );
          assert(error.code === 'purchase_stripe_reconciliation_in_progress');
        } finally {
          (stripe.paymentIntents as unknown as { cancel: unknown }).cancel = originalCancel;
        }
        const staleRow = await prisma.purchaseSpend.findUnique({ where: { id: stale.id } });
        assert(
          staleRow?.status === PurchaseSpendStatus.CHARGING,
          `stale row should remain CHARGING, got ${staleRow?.status}`
        );
        const held = await prisma.purchaseSpend.findFirst({
          where: { userId, fingerprint, status: PurchaseSpendStatus.HELD },
        });
        assert(held === null, 'a failed cancellation must not allow a fresh purchase');
      });
    },
  ],
  [
    'benchmark KYC-required user fails the purchase and raises a typed KYC error',
    async () => {
      const previous = process.env.BENCHMARK_MODE;
      process.env.BENCHMARK_MODE = '1';
      const fingerprint = `benchmark-kyc-${randomUUID()}`;
      trackedUserIds.add(BENCHMARK_KYC_USER_ID);
      await prisma.user.upsert({
        where: { userId: BENCHMARK_KYC_USER_ID },
        create: { userId: BENCHMARK_KYC_USER_ID, isAnonymous: true },
        update: {},
      });
      try {
        const error = await expectPurchaseError(() =>
          purchasesService.mintPurchaseCard(
            mintBody(BENCHMARK_KYC_USER_ID, { fingerprint }) as never,
            new FakeCardProvider(),
            new FakeWalletFundingProvider()
          )
        );
        assert(error.code === KYC_REQUIRED_CODE, `expected kyc_required, got ${error.code}`);
        assert(error.statusCode === 422, `expected 422, got ${error.statusCode}`);
        const row = await prisma.purchaseSpend.findFirst({
          where: { userId: BENCHMARK_KYC_USER_ID, fingerprint },
        });
        assert(row?.status === PurchaseSpendStatus.FAILED, `expected FAILED, got ${row?.status}`);
      } finally {
        if (previous === undefined) delete process.env.BENCHMARK_MODE;
        else process.env.BENCHMARK_MODE = previous;
      }
    },
  ],
  [
    'closePurchaseCard records FUNDING_RECLAIM_FAILED when reclaim fails outright',
    async () => {
      const userId = await createUser('close-reclaim-fail');
      const cardId = `card-close-fail-${randomUUID()}`;
      const purchase = await prisma.purchaseSpend.create({
        data: {
          userId,
          fingerprint: `close-fail-${randomUUID()}`,
          cardId,
          merchant: 'Close Fail Merchant',
          lineItemsJson: { totalCents: 1000 },
          totalCents: 1000,
          status: PurchaseSpendStatus.HELD,
          stripePaymentIntentId: `pi_close_${randomUUID()}`,
        },
      });
      await prisma.purchaseWalletFunding.create({
        data: {
          purchaseId: purchase.id,
          userId,
          amountCents: 1000,
          currency: 'usd',
          status: PurchaseWalletFundingStatus.FUNDED,
          providerTransferId: `wft_${randomUUID()}`,
          idempotencyKey: `purchase-wallet-fund:${purchase.id}`,
        },
      });
      const provider = new FakeCardProvider();
      Object.defineProperty(provider, 'cardId', { value: cardId });
      const walletProvider = new FakeWalletFundingProvider();
      walletProvider.failReclaim = true;

      await withFakeStripe(async (calls) => {
        const result = await purchasesService.closePurchaseCard(cardId, provider, walletProvider);
        assert(
          result.status === PurchaseSpendStatus.FUNDING_RECLAIM_FAILED,
          `expected FUNDING_RECLAIM_FAILED, got ${result.status}`
        );
        assert(calls.refunds.length === 0, 'a failed reclaim must not refund the captured charge');
        const row = await prisma.purchaseSpend.findUnique({ where: { id: purchase.id } });
        assert(
          row?.status === PurchaseSpendStatus.FUNDING_RECLAIM_FAILED,
          `expected FUNDING_RECLAIM_FAILED row, got ${row?.status}`
        );
      });
    },
  ],
  [
    'voided webhook treats an already-consumed transfer as a settled clearance',
    async () => {
      const userId = await createUser('webhook-voided-consumed');
      const cardId = `card-voided-consumed-${randomUUID()}`;
      const purchase = await prisma.purchaseSpend.create({
        data: {
          userId,
          fingerprint: `voided-consumed-${randomUUID()}`,
          cardId,
          merchant: 'Voided Consumed Merchant',
          lineItemsJson: { totalCents: 1000 },
          totalCents: 1000,
          status: PurchaseSpendStatus.HELD,
          stripePaymentIntentId: `pi_vc_${randomUUID()}`,
        },
      });
      await prisma.purchaseWalletFunding.create({
        data: {
          purchaseId: purchase.id,
          userId,
          amountCents: 1000,
          currency: 'usd',
          status: PurchaseWalletFundingStatus.CONSUMED,
          consumedAt: new Date(),
          providerTransferId: `wft_${randomUUID()}`,
          idempotencyKey: `purchase-wallet-fund:${purchase.id}`,
        },
      });

      await withFakeStripe(async (calls) => {
        await purchasesService.handleAgentCardWebhook({ type: 'transaction.voided', cardId });
        assert(calls.refunds.length === 0, 'a consumed transfer must not be refunded as voided');
        const row = await prisma.purchaseSpend.findUnique({ where: { id: purchase.id } });
        assert(row?.status === PurchaseSpendStatus.CLEARED, `expected CLEARED, got ${row?.status}`);
      });
    },
  ],
  [
    'wallet collection short-circuits funded rows, rejects reclaimed rows, and records provider failures',
    async () => {
      const userId = await createUser('wallet-collection');
      const makePurchase = async (status: PurchaseWalletFundingStatus) => {
        const purchase = await prisma.purchaseSpend.create({
          data: {
            userId,
            fingerprint: `collection-${randomUUID()}`,
            merchant: 'Collection Merchant',
            lineItemsJson: { totalCents: 1000 },
            totalCents: 1000,
            status: PurchaseSpendStatus.CHARGING,
          },
        });
        await prisma.purchaseWalletFunding.create({
          data: {
            purchaseId: purchase.id,
            userId,
            amountCents: 1000,
            currency: 'usd',
            status,
            providerTransferId: `wft_${randomUUID()}`,
            idempotencyKey: `purchase-wallet-fund:${purchase.id}`,
          },
        });
        return purchase;
      };

      const funded = await makePurchase(PurchaseWalletFundingStatus.FUNDED);
      const fundedProvider = new FakeWalletFundingProvider();
      const fundedResult = await confirmPurchaseWalletCollection(
        funded as never,
        'usd',
        'owt_funded',
        undefined,
        fundedProvider
      );
      assert(
        fundedResult.status === PurchaseWalletFundingStatus.FUNDED,
        `already-funded collection should be a no-op, got ${fundedResult.status}`
      );
      assert(
        fundedProvider.confirmCalls.length === 0,
        'a funded row must not re-call the provider'
      );

      const reclaimed = await makePurchase(PurchaseWalletFundingStatus.RECLAIMED);
      const reclaimedError = await expectThrow(() =>
        confirmPurchaseWalletCollection(
          reclaimed as never,
          'usd',
          'owt_reclaimed',
          undefined,
          new FakeWalletFundingProvider()
        )
      );
      assert(
        reclaimedError.message.includes('already reclaimed'),
        'collecting a reclaimed transfer must throw'
      );

      const pending = await makePurchase(PurchaseWalletFundingStatus.PENDING);
      const failingProvider = new FakeWalletFundingProvider();
      failingProvider.confirmCollection = async () => {
        throw new Error('collection provider unavailable');
      };
      const providerError = await expectThrow(() =>
        confirmPurchaseWalletCollection(
          pending as never,
          'usd',
          'owt_pending',
          { note: 'test' },
          failingProvider
        )
      );
      assert(providerError.message.includes('provider unavailable'));
      const failedRow = await prisma.purchaseWalletFunding.findUnique({
        where: { purchaseId: pending.id },
      });
      assert(
        failedRow?.status === PurchaseWalletFundingStatus.FAILED,
        `expected funding FAILED after provider error, got ${failedRow?.status}`
      );
    },
  ],
];

async function cleanup(): Promise<void> {
  for (const userId of trackedUserIds) {
    await prisma.purchaseSpend.deleteMany({ where: { userId } });
    await prisma.subscription.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
  await prisma.$disconnect();
}

async function main(): Promise<void> {
  console.log(`Running purchases black-box tests part 5 (${tests.length} tests)...`);
  const results: TestResult[] = [];
  try {
    for (const [name, fn] of tests) {
      results.push(await runTest(name, fn));
    }
  } finally {
    await cleanup();
  }

  const passed = results.filter((result) => result.passed).length;
  for (const result of results) {
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name} (${result.duration}ms)`);
    if (!result.passed) console.log(`  ${result.error}`);
  }

  console.log(`\nPurchases black-box tests part 5: ${passed}/${results.length} passed`);
  if (passed !== results.length) process.exit(1);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  await cleanup();
  process.exit(1);
});
