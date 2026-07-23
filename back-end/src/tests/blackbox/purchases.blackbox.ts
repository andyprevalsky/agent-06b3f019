#!/usr/bin/env tsx
/**
 * Black-box tests for /api/purchases and /api/webhooks/agentcard.
 *
 * Covers:
 *   GET  /api/purchases/lookup
 *   POST /api/purchases/mint
 *   POST /api/webhooks/agentcard
 *   POST /api/purchases/webhooks/agentcard
 *
 * Boundary capture tests:
 *   These tests only assert branches that short-circuit before Stripe and
 *   AgentCard calls. Full card minting is intentionally left to sandbox E2E
 *   with real provider credentials.
 */

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { PurchaseSpendStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import { AgentCardProviderError, type CardProvider } from '../../providers/card-provider';
import * as purchasesService from '../../domains/purchases/service';
import { canonicalStoredPurchaseFingerprint } from '../../domains/purchases/fingerprint';
import {
  assert,
  FakeCardProvider,
  FakeWalletFundingProvider,
  FailingDetailsCardProvider,
  FailingMintCardProvider,
  FundingInProgressCardProvider,
  RepurchaseProvider,
  StubCardStateProvider,
  seedHeldPurchase,
  withFakeStripe,
} from './purchases.testkit';

config();

const RUN_ID =
  process.env.BLACKBOX_TEST_RUN_ID ||
  process.env.CONTRACT_TEST_RUN_ID ||
  `${Date.now()}-${randomUUID().slice(0, 8)}`;

const trackedUserIds = new Set<string>();
const trackedAgentIds = new Set<string>();

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function createUser(label: string): Promise<string> {
  const userId = `purchase-test-${RUN_ID}-${label}-${randomUUID()}`;
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

async function cleanup(): Promise<void> {
  for (const agentId of trackedAgentIds) {
    await prisma.agent.deleteMany({ where: { id: agentId } });
  }
  for (const userId of trackedUserIds) {
    await prisma.user.deleteMany({ where: { userId } });
  }
  await prisma.$disconnect();
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    'service mint charges once, issues a card, and is idempotent by fingerprint',
    async () => {
      const userId = await createSubscribedUser('service-idempotent');
      const fingerprint = `service-idempotent-${randomUUID()}`;
      const provider = new FakeCardProvider();
      const walletFundingProvider = new FakeWalletFundingProvider();

      await withFakeStripe(async (calls) => {
        const first = await purchasesService.mintPurchaseCard(
          validMintBody({ userId, fingerprint, totalCents: 1000 }) as never,
          provider,
          walletFundingProvider
        );
        const second = await purchasesService.mintPurchaseCard(
          validMintBody({ userId, fingerprint, totalCents: 1000 }) as never,
          provider,
          walletFundingProvider
        );

        assert(first.cardId === provider.cardId, 'first mint should return fake card id');
        assert(second.cardId === provider.cardId, 'second mint should reuse fake card id');
        assert(
          first.pan === provider.pan,
          'first mint should return card details to trusted worker'
        );
        assert(second.pan === provider.pan, 'reused mint should return existing card details');
        assert(
          calls.charges.length === 1,
          `expected one Stripe charge, got ${calls.charges.length}`
        );
        assert(provider.mintCalls === 1, `expected one provider mint, got ${provider.mintCalls}`);
        assert(
          provider.mintRequests[0]?.fundsSource === 'company_flow',
          'purchase card should request AgentCard company_flow funding'
        );
        assert(
          walletFundingProvider.fundCalls.length === 0,
          `company_flow should not pre-fund the user wallet, got ${walletFundingProvider.fundCalls.length}`
        );
        assert(
          walletFundingProvider.confirmCalls.length === 0,
          `auto-approved company flow should not call confirm_collection, got ${walletFundingProvider.confirmCalls.length}`
        );
        assert(
          provider.detailCalls === 2,
          `expected details for both responses, got ${provider.detailCalls}`
        );

        const row = await prisma.purchaseSpend.findFirst({
          where: { userId, fingerprint },
          orderBy: { createdAt: 'desc' },
        });
        assert(row?.status === PurchaseSpendStatus.HELD, `expected HELD, got ${row?.status}`);
        assert(row?.cardId === provider.cardId, 'purchase spend should store the card id');
        assert(
          typeof row?.canonicalFingerprint === 'string' && row.canonicalFingerprint.length > 0,
          'new purchase rows should persist an indexed canonical fingerprint'
        );
        assert(
          row?.stripePaymentIntentId !== null,
          'purchase spend should store the payment intent id'
        );
        const funding = await prisma.purchaseWalletFunding.findUnique({
          where: { purchaseId: row?.id ?? '' },
        });
        assert(funding !== null, 'purchase should record AgentCard wallet funding');
        assert(
          funding?.status === 'FUNDED',
          `expected wallet funding FUNDED, got ${funding?.status}`
        );
        assert(
          funding?.providerTransferId === provider.providerTransferId,
          'wallet funding should record provider transfer id'
        );
        assert(
          calls.charges[0].includes('"statement_descriptor_suffix":"Test Merchant"'),
          'charge should set merchant descriptor suffix'
        );
        assert(
          calls.charges[0].includes('"capture_method":"manual"'),
          'mint must authorize a manual-capture hold, not an immediate charge'
        );
        assert(calls.captures.length === 1, 'funding completion must capture the hold once');
        assert(calls.cancels.length === 0, 'successful funding must not cancel the hold');
      });
    },
  ],
  [
    'service confirms AgentCard company-wallet collection and retries mint',
    async () => {
      const userId = await createSubscribedUser('service-company-confirm');
      const fingerprint = `service-company-confirm-${randomUUID()}`;
      const provider = new FundingInProgressCardProvider();
      const walletFundingProvider = new FakeWalletFundingProvider();

      await withFakeStripe(async () => {
        const result = await purchasesService.mintPurchaseCard(
          validMintBody({ userId, fingerprint, totalCents: 1000 }) as never,
          provider,
          walletFundingProvider
        );

        assert(result.cardId === provider.cardId, 'retry should return minted card');
        assert(provider.mintCalls === 2, `expected two mint attempts, got ${provider.mintCalls}`);
        assert(
          walletFundingProvider.confirmCalls.length === 1,
          `expected one confirm_collection, got ${walletFundingProvider.confirmCalls.length}`
        );
        assert(
          walletFundingProvider.confirmCalls[0]?.providerTransferId === provider.providerTransferId,
          'confirm_collection should use AgentCard transfer id'
        );

        const row = await prisma.purchaseSpend.findFirst({
          where: { userId, fingerprint },
          orderBy: { createdAt: 'desc' },
        });
        const funding = await prisma.purchaseWalletFunding.findUnique({
          where: { purchaseId: row?.id ?? '' },
        });
        assert(funding?.status === 'FUNDED', `expected FUNDED, got ${funding?.status}`);
        assert(
          funding?.providerTransferId === provider.providerTransferId,
          'funding row should retain confirmed transfer id'
        );
      });
    },
  ],
  [
    'service mint maps AgentCard KYC requirement to a typed error and cancels the hold',
    async () => {
      const userId = await createSubscribedUser('service-kyc-required');
      const fingerprint = `service-kyc-${randomUUID()}`;
      const provider: CardProvider = {
        async mintCard() {
          throw new AgentCardProviderError(
            'AgentCard request failed with 422',
            422,
            '{"code":"customers_needed_kyc","message":"Customer needs KYC"}'
          );
        },
        async getDetails() {
          throw new Error('getDetails should not run after KYC rejection');
        },
        async closeCard() {},
      };

      await withFakeStripe(async (calls) => {
        let caught: unknown;
        try {
          await purchasesService.mintPurchaseCard(
            validMintBody({ userId, fingerprint, totalCents: 1000 }) as never,
            provider
          );
        } catch (error) {
          caught = error;
        }

        assert(caught instanceof purchasesService.PurchaseError, 'expected PurchaseError');
        const purchaseError = caught as purchasesService.PurchaseError;
        assert(purchaseError.statusCode === 422, `expected 422, got ${purchaseError.statusCode}`);
        assert(
          purchaseError.code === 'kyc_required',
          `expected kyc_required, got ${purchaseError.code}`
        );
        assert(
          calls.charges.length === 1,
          'Stripe hold should have been authorized before card mint'
        );
        assert(calls.cancels.length === 1, 'KYC failure must cancel the authorized hold');

        const row = await prisma.purchaseSpend.findFirst({
          where: { userId, fingerprint },
          orderBy: { createdAt: 'desc' },
        });
        assert(row !== null, 'KYC mint failure should persist a purchase spend row');
        assert(row?.status === PurchaseSpendStatus.FAILED, `expected FAILED, got ${row?.status}`);
        assert(row?.cardId === null, 'KYC failure should not store a card id');
        assert(
          row?.stripePaymentIntentId !== null,
          'failed KYC row should keep the canceled payment intent id for audit'
        );
      });
    },
  ],
  [
    'lookup keeps a still-live held card reusable (auto-approve)',
    async () => {
      const userId = await createUser('lookup-live');
      const fingerprint = `lookup-live-${randomUUID()}`;
      await seedHeldPurchase(userId, fingerprint, `held-card-${randomUUID()}`);
      const provider = new StubCardStateProvider({ status: 'OPEN', balanceCents: 4396 });

      const result = await purchasesService.lookupPurchase(userId, fingerprint, provider);
      assert(result.found === true, 'should find the held purchase');
      assert(result.reusable === true, 'a live, unspent held card should remain reusable');
      assert(provider.getDetailsCalls === 1, 'should verify card liveness via the provider');
    },
  ],
  [
    'lookup canonicalizes mixed review-count punctuation from pre-fix held receipts',
    async () => {
      const userId = await createUser('lookup-canonical-mixed-reviews');
      const oldFingerprint = `pre-fix-mixed-${randomUUID()}`;
      const cardId = `held-card-${randomUUID()}`;
      const baseItems = [
        {
          name: 'Aurora Notebook',
          imageUrl: 'https://example.test/notebook.png',
          productUrl: 'https://example.test/p/notebook',
          rating: '4.8 stars',
          reviewCount: '1,284 reviews',
          unitPriceCents: 1200,
          quantity: 1,
          lineTotalCents: 1200,
        },
        {
          name: 'Canvas Tote',
          imageUrl: 'https://example.test/tote.png',
          productUrl: 'https://example.test/p/tote',
          rating: '4.9 stars',
          reviewCount: '5678 reviews',
          unitPriceCents: 1500,
          quantity: 1,
          lineTotalCents: 1500,
        },
      ];
      const storedReceipt = {
        currency: 'USD',
        lineItems: baseItems,
        fees: [{ label: 'Tax', amountCents: 200 }],
        subtotalCents: 2700,
        totalCents: 2900,
      };
      const storedPurchase = await prisma.purchaseSpend.create({
        data: {
          userId,
          fingerprint: oldFingerprint,
          merchant: 'Rose Labs Test Payment',
          lineItemsJson: storedReceipt,
          totalCents: 2900,
          status: PurchaseSpendStatus.HELD,
          cardId,
          createdAt: new Date('2026-07-19T12:00:00.000Z'),
        },
      });

      const retryReceipt = {
        ...storedReceipt,
        lineItems: [
          { ...baseItems[0], reviewCount: '1284 reviews' },
          { ...baseItems[1], reviewCount: '5,678 reviews' },
        ],
      };
      const canonicalFingerprint = canonicalStoredPurchaseFingerprint({
        userId,
        merchant: 'Rose Labs Test Payment',
        lineItemsJson: retryReceipt,
        totalCents: 2900,
      });
      assert(canonicalFingerprint !== null, 'retry receipt should produce a canonical fingerprint');
      assert(
        canonicalStoredPurchaseFingerprint({
          userId: 'fixture-user',
          merchant: 'Rose Labs Test Payment',
          lineItemsJson: retryReceipt,
          totalCents: 2900,
        }) === '15ff20e0397ee6fd67716bd8c7e3f05711bc9197502a4218376a7dd01165aade',
        'backend canonicalization must match the agents-side Python fingerprint fixture'
      );
      const provider = new StubCardStateProvider({ status: 'OPEN', balanceCents: 2900 });

      const result = await purchasesService.lookupPurchase(
        userId,
        canonicalFingerprint,
        provider,
        new Date('2026-07-19T13:00:00.000Z')
      );

      assert(result.reusable === true, 'mixed-format pre-fix hold should remain reusable');
      assert(
        result.purchase?.fingerprint === oldFingerprint,
        'lookup must return the stored key so mint reuses the original card'
      );
      assert(result.purchase?.cardId === cardId, 'lookup should return the original held card');
      const indexedPurchase = await prisma.purchaseSpend.findUnique({
        where: { id: storedPurchase.id },
      });
      assert(
        indexedPurchase?.canonicalFingerprint === canonicalFingerprint,
        'legacy lookup should persist the canonical fingerprint for indexed retries'
      );
    },
  ],
  [
    'lookup re-prompts (not reusable) and clears a held card the network already settled',
    async () => {
      const userId = await createUser('lookup-consumed');
      const fingerprint = `lookup-consumed-${randomUUID()}`;
      const seeded = await seedHeldPurchase(userId, fingerprint, `held-card-${randomUUID()}`);
      // Card was charged + auto-closed by the network, but transaction.cleared hasn't landed.
      const provider = new StubCardStateProvider({ status: 'CLOSED', balanceCents: 0 });

      const result = await purchasesService.lookupPurchase(userId, fingerprint, provider);
      assert(result.reusable === false, 'a consumed card must NOT silently auto-approve');
      assert(provider.getDetailsCalls === 1, 'should verify card liveness via the provider');

      const updated = await prisma.purchaseSpend.findUnique({ where: { id: seeded.id } });
      assert(
        updated?.status === PurchaseSpendStatus.CLEARED,
        `consumed card should be marked CLEARED, got ${updated?.status}`
      );
    },
  ],
  [
    'lookup fails safe (re-prompt) when the held card is unreadable',
    async () => {
      const userId = await createUser('lookup-unreadable');
      const fingerprint = `lookup-unreadable-${randomUUID()}`;
      const seeded = await seedHeldPurchase(userId, fingerprint, `held-card-${randomUUID()}`);
      const provider: CardProvider = {
        async mintCard() {
          throw new Error('unused');
        },
        async getDetails() {
          throw new Error('card not found');
        },
        async closeCard() {},
      };

      const result = await purchasesService.lookupPurchase(userId, fingerprint, provider);
      assert(result.reusable === false, 'an unverifiable card must fail safe to re-approval');
      const updated = await prisma.purchaseSpend.findUnique({ where: { id: seeded.id } });
      assert(
        updated?.status === PurchaseSpendStatus.CLEARED,
        `unreadable card should be marked CLEARED, got ${updated?.status}`
      );
    },
  ],
  [
    'mint re-purchases (new card, fresh charge) when the prior held card was already settled',
    async () => {
      const userId = await createSubscribedUser('mint-repurchase');
      const fingerprint = `mint-repurchase-${randomUUID()}`;
      const consumedCardId = `held-card-${randomUUID()}`;
      const seeded = await seedHeldPurchase(userId, fingerprint, consumedCardId);
      const provider = new RepurchaseProvider(consumedCardId);
      const walletFundingProvider = new FakeWalletFundingProvider();

      await withFakeStripe(async (calls) => {
        const result = await purchasesService.mintPurchaseCard(
          validMintBody({ userId, fingerprint, totalCents: 1080 }) as never,
          provider,
          walletFundingProvider
        );
        assert(result.cardId === provider.newCardId, 're-purchase should mint a NEW card');
        assert(provider.mintCalls === 1, 'should mint exactly one new card');
        assert(calls.charges.length === 1, 're-purchase should charge exactly once');
        assert(
          provider.mintRequests[0]?.fundsSource === 'company_flow',
          're-purchase should request AgentCard company_flow funding'
        );
        assert(
          walletFundingProvider.fundCalls.length === 0,
          're-purchase should not pre-fund the user wallet'
        );

        const oldRow = await prisma.purchaseSpend.findUnique({ where: { id: seeded.id } });
        assert(
          oldRow?.status === PurchaseSpendStatus.CLEARED,
          `prior purchase should be CLEARED, got ${oldRow?.status}`
        );
        const rows = await prisma.purchaseSpend.findMany({ where: { userId, fingerprint } });
        assert(rows.length === 2, `expected 2 rows for the re-bought cart, got ${rows.length}`);
        const held = rows.find((r) => r.status === PurchaseSpendStatus.HELD);
        assert(held?.cardId === provider.newCardId, 'the new row should hold the new card');
      });
    },
  ],
  [
    'mint preserves an ambiguous AgentCard failure for same-key reconciliation',
    async () => {
      const userId = await createSubscribedUser('mint-card-failure');
      const fingerprint = `mint-card-failure-${randomUUID()}`;
      const provider = new FailingMintCardProvider();
      const walletFundingProvider = new FakeWalletFundingProvider();

      await withFakeStripe(async (calls) => {
        let threw = false;
        try {
          await purchasesService.mintPurchaseCard(
            validMintBody({ userId, fingerprint, totalCents: 1000 }) as never,
            provider,
            walletFundingProvider
          );
        } catch (error) {
          threw = true;
          assert(
            error instanceof purchasesService.PurchaseError &&
              error.code === 'agentcard_company_funding_in_progress',
            `unexpected error: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        assert(threw, 'mint should throw when card issuance fails');
        assert(
          walletFundingProvider.fundCalls.length === 0,
          'company_flow should not pre-fund the user wallet'
        );
        assert(
          walletFundingProvider.reclaimCalls.length === 0,
          'no AgentCard funding should be reclaimed before create_card returns a transfer'
        );
        assert(calls.cancels.length === 0, 'an ambiguous provider outcome must keep the hold');

        const row = await prisma.purchaseSpend.findFirst({
          where: { userId, fingerprint },
          orderBy: { createdAt: 'desc' },
        });
        assert(
          row?.status === PurchaseSpendStatus.FUNDING_PENDING,
          `expected FUNDING_PENDING, got ${row?.status}`
        );
        const funding = await prisma.purchaseWalletFunding.findUnique({
          where: { purchaseId: row?.id ?? '' },
        });
        assert(
          funding?.status === 'PENDING',
          `the pre-provider marker must remain resumable, got ${funding?.status}`
        );
      });
    },
  ],
  [
    'mint reclaims the issued AgentCard and refunds Stripe if detail retrieval fails after funding',
    async () => {
      const userId = await createSubscribedUser('mint-details-failure');
      const fingerprint = `mint-details-failure-${randomUUID()}`;
      const provider = new FailingDetailsCardProvider();
      const walletFundingProvider = new FakeWalletFundingProvider();

      await withFakeStripe(async (calls) => {
        let errorMessage = '';
        try {
          await purchasesService.mintPurchaseCard(
            validMintBody({ userId, fingerprint, totalCents: 1000 }) as never,
            provider,
            walletFundingProvider
          );
        } catch (error) {
          errorMessage = error instanceof Error ? error.message : String(error);
        }
        assert(errorMessage.includes('card details failed'), `unexpected error: ${errorMessage}`);
        assert(provider.closeCalls === 1, 'issued AgentCard should be closed after detail failure');
        assert(
          calls.captures.length === 1,
          'AgentCard funding should capture Stripe before details'
        );
        assert(calls.cancels.length === 0, 'a captured Stripe payment must not be canceled');
        assert(calls.refunds.length === 1, 'captured Stripe payment should be refunded once');
        assert(
          walletFundingProvider.reclaimCalls.length === 1,
          'AgentCard company transfer should be reclaimed before refunding Stripe'
        );
        const row = await prisma.purchaseSpend.findFirst({
          where: { userId, fingerprint },
          orderBy: { createdAt: 'desc' },
        });
        assert(row?.status === PurchaseSpendStatus.FAILED, `expected FAILED, got ${row?.status}`);
        assert(
          calls.refundIdempotencyKeys[0] === `purchase-refund:${row?.id}`,
          'refund must use the purchase-scoped idempotency key'
        );
        const funding = await prisma.purchaseWalletFunding.findUnique({
          where: { purchaseId: row?.id ?? '' },
        });
        assert(
          funding?.status === 'RECLAIMED',
          `expected wallet funding RECLAIMED, got ${funding?.status}`
        );
      });
    },
  ],
];

async function main(): Promise<void> {
  console.log(`Running purchases black-box tests (${tests.length} tests)...`);
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
    const marker = result.passed ? 'PASS' : 'FAIL';
    console.log(`${marker} ${result.name} (${result.duration}ms)`);
    if (!result.passed) console.log(`  ${result.error}`);
  }

  console.log(`\nPurchases black-box tests: ${passed}/${results.length} passed`);
  if (passed !== results.length) process.exit(1);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  await cleanup();
  process.exit(1);
});
