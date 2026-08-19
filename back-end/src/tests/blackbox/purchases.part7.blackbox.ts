#!/usr/bin/env tsx
/**
 * Black-box tests for the admin purchase bypass (part 7).
 *
 * Admins (ADMIN_USER_IDS) bypass the subscription / card-on-file requirement: the card is minted
 * from the AgentCard company transfer with NO personal Stripe hold (Rose fronts the cost). A
 * non-admin without a Stripe billing customer still fails with a 402. Sandbox AgentCard
 * lifecycle benches run as the admin account with BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH so
 * they keep unlimited credits and still hit the charged mint path.
 */

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { PurchaseSpendStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import {
  BENCHMARK_PAYMENT_LIFECYCLE_ADMIN_RUN_USER_ID,
  BENCHMARK_PAYMENT_LIFECYCLE_USER_ID,
  benchmarkForceCustomerPurchasePath,
} from '../../domains/purchases/config';
import * as purchasesService from '../../domains/purchases/service';
import { getTestPaymentLifecycle } from '../../domains/test-payment/service';
import { isAdminUser } from '../../utils/adminAccess';
import {
  assert,
  FakeCardProvider,
  FakeWalletFundingProvider,
  withFakeStripe,
} from './purchases.testkit';

config();

const RUN_ID =
  process.env.BLACKBOX_TEST_RUN_ID ||
  process.env.CONTRACT_TEST_RUN_ID ||
  `${Date.now()}-${randomUUID().slice(0, 8)}`;

const FORCE_PATH_ENV_KEYS = [
  'BENCHMARK_MODE',
  'BENCHMARK_ISOLATED_RUN',
  'BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH',
] as const;

async function withForcePathEnv(
  values: Partial<Record<(typeof FORCE_PATH_ENV_KEYS)[number], string | undefined>>,
  fn: () => Promise<void>
): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const key of FORCE_PATH_ENV_KEYS) {
    previous[key] = process.env[key];
  }
  try {
    for (const key of FORCE_PATH_ENV_KEYS) {
      const next = values[key];
      if (next === undefined) delete process.env[key];
      else process.env[key] = next;
    }
    await fn();
  } finally {
    for (const key of FORCE_PATH_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const ADMIN_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30'; // Andy Prevalsky — ADMIN_USER_IDS
/** The exact cart the four agent-payment-* lifecycle benchmarks buy. */
const LIFECYCLE_TOTAL_CENTS = 4396;

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

async function adminMintIssuesCompanyCardWithoutCharge(): Promise<void> {
  await prisma.user.upsert({
    where: { userId: ADMIN_USER_ID },
    update: {},
    create: { userId: ADMIN_USER_ID, isAnonymous: true },
  });
  const fingerprint = `admin-nocharge-${RUN_ID}-${randomUUID()}`;
  const provider = new FakeCardProvider();
  const walletFundingProvider = new FakeWalletFundingProvider();
  try {
    await withFakeStripe(async (calls) => {
      const result = await purchasesService.mintPurchaseCard(
        validMintBody({ userId: ADMIN_USER_ID, fingerprint, totalCents: 1000 }) as never,
        provider,
        walletFundingProvider
      );
      assert(result.cardId === provider.cardId, 'admin mint should issue the company card');
      assert(result.status === PurchaseSpendStatus.HELD, `expected HELD, got ${result.status}`);
      assert(provider.mintCalls === 1, `expected one company-flow mint, got ${provider.mintCalls}`);
      assert(
        provider.mintRequests[0]?.fundsSource === 'company_flow',
        'admin card should still request AgentCard company_flow funding'
      );
      assert(
        calls.charges.length === 0,
        `admin mint must not authorize a Stripe hold, got ${calls.charges.length}`
      );
      assert(
        calls.captures.length === 0,
        `admin mint must not capture a Stripe charge, got ${calls.captures.length}`
      );
      const row = await prisma.purchaseSpend.findFirst({
        where: { userId: ADMIN_USER_ID, fingerprint },
        orderBy: { createdAt: 'desc' },
      });
      assert(row?.status === PurchaseSpendStatus.HELD, `expected HELD row, got ${row?.status}`);
      assert(row?.cardId === provider.cardId, 'admin purchase should store the card id');
      assert(
        row?.stripePaymentIntentId === null,
        'admin (Rose-funded) purchase should carry no Stripe payment intent'
      );
    });
  } finally {
    // Andy is a real synced user — never delete him; drop only this test's purchase rows
    // (PurchaseWalletFunding cascades on the PurchaseSpend FK).
    await prisma.purchaseSpend.deleteMany({ where: { userId: ADMIN_USER_ID, fingerprint } });
  }
  console.log('PASS admin mint issues a company-funded card with no Stripe charge');
}

async function nonAdminWithoutCustomerFails402(): Promise<void> {
  const userId = `purchase7-${RUN_ID}-non-admin-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  const fingerprint = `non-admin-402-${randomUUID()}`;
  const provider = new FakeCardProvider();
  try {
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
      assert(purchaseError.statusCode === 402, `expected 402, got ${purchaseError.statusCode}`);
      assert(provider.mintCalls === 0, 'non-admin without a customer must never mint a card');
      assert(calls.charges.length === 0, 'non-admin 402 must not touch Stripe');
      const row = await prisma.purchaseSpend.findFirst({
        where: { userId, fingerprint },
        orderBy: { createdAt: 'desc' },
      });
      assert(row?.status === PurchaseSpendStatus.FAILED, `expected FAILED, got ${row?.status}`);
    });
  } finally {
    await prisma.user.deleteMany({ where: { userId } });
  }
  console.log('PASS non-admin without a Stripe customer still fails 402');
}

/**
 * Regression for the AgentCard payment-lifecycle benchmarks
 * (agent-payment-test-shop / -setup-resume / -idempotent-abandonment / -abandonment).
 *
 * Those tasks assert `payment_lifecycle.stripeHold = { status: 'succeeded', amountReceivedCents:
 * 4396 }`. `getTestPaymentLifecycle` only ever reads a hold when the purchase row carries a
 * `stripePaymentIntentId`, and only `chargeAndIssueCard` writes one. `resolveAndIssuePurchaseCard`
 * routes ADMIN_USER_IDS to `issueAdminCompanyCard`, which deliberately mints off the AgentCard org
 * transfer with no personal hold — so when the benchmarks ran as the hardcoded admin benchmark
 * user, `stripeHold` was structurally `null` and the assertion could never be satisfied.
 *
 * This walks the real mint path for the benchmark payment identity and reads the resulting
 * lifecycle. Nothing about the hold is stubbed into existence: the fake `retrieveStripeHold`
 * refuses any intent this run did not actually authorize AND capture, so a hold can only appear
 * if the charged path really ran.
 */
async function benchmarkPaymentIdentityProducesTheAssertedStripeHold(): Promise<void> {
  const userId = BENCHMARK_PAYMENT_LIFECYCLE_USER_ID;
  const fingerprint = `lifecycle-hold-${RUN_ID}-${randomUUID()}`;
  const provider = new FakeCardProvider();
  const walletFundingProvider = new FakeWalletFundingProvider();
  await prisma.user.upsert({
    where: { userId },
    update: {},
    create: { userId, isAnonymous: false, name: 'Rose Labs Benchmark Payer' },
  });
  const agent = await prisma.agent.create({
    data: { userId, goal: 'payment lifecycle blackbox' },
  });
  const previousSubscription = await prisma.subscription.findUnique({ where: { userId } });
  await prisma.subscription.upsert({
    where: { userId },
    update: { stripeCustomerId: previousSubscription?.stripeCustomerId ?? `cus_${RUN_ID}` },
    create: {
      userId,
      subscriptionTier: 1,
      stripeCustomerId: `cus_${RUN_ID}`,
      stripeSubscriptionId: `sub_${RUN_ID}`,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  try {
    await withFakeStripe(async (calls) => {
      const result = await purchasesService.mintPurchaseCard(
        {
          userId,
          agentId: agent.id,
          fingerprint,
          merchant: 'Rose Labs Test Payment',
          currency: 'USD',
          lineItems: [{ label: 'Benchmark cart', amountCents: 3600 }],
          fees: [
            { label: 'Tax', amountCents: 297 },
            { label: 'Shipping', amountCents: 499 },
          ],
          subtotalCents: 3600,
          totalCents: LIFECYCLE_TOTAL_CENTS,
        } as never,
        provider,
        walletFundingProvider
      );
      assert(result.status === PurchaseSpendStatus.HELD, `expected HELD, got ${result.status}`);
      assert(
        calls.charges.length === 1,
        'benchmark purchase must authorize exactly one Stripe hold, got ' +
          `${calls.charges.length}; zero means resolveAndIssuePurchaseCard took the ` +
          `company-funded ADMIN path (isAdminUser(${userId})=${isAdminUser(userId)})`
      );
      assert(
        calls.captures.length === 1,
        `benchmark purchase must capture its Stripe hold, got ${calls.captures.length}`
      );

      const row = await prisma.purchaseSpend.findFirst({
        where: { userId, fingerprint },
        orderBy: { createdAt: 'desc' },
      });
      assert(
        row?.stripePaymentIntentId !== null && row?.stripePaymentIntentId !== undefined,
        'benchmark purchase must persist its Stripe payment intent; a null intent means the ' +
          'company-funded admin path ran and the lifecycle can never report a hold'
      );

      const capturedIntentIds = new Set(calls.captures);
      const lifecycle = await getTestPaymentLifecycle(agent.id, {
        // Stripe/AgentCard reads are the only stubs: a hold is reported ONLY for an intent this
        // run genuinely authorized and captured, so the assertion cannot be faked into passing.
        retrieveStripeHold: async (paymentIntentId: string) => {
          assert(
            capturedIntentIds.has(paymentIntentId),
            `lifecycle asked for uncaptured intent ${paymentIntentId}`
          );
          return {
            id: paymentIntentId,
            status: 'succeeded',
            amount: LIFECYCLE_TOTAL_CENTS,
            amount_capturable: 0,
            amount_received: LIFECYCLE_TOTAL_CENTS,
          };
        },
        listStripeRefunds: async () => ({ data: [] }),
        searchStripeHolds: async () => ({ data: [] }),
        getCardSummary: async () => ({ status: 'active', balanceCents: LIFECYCLE_TOTAL_CENTS }),
        getOrgCardholderId: async () => undefined,
        listOrgCards: async () => ({ structuredContent: { cards: [] } }),
        listOrgTransfers: async () => ({ structuredContent: { transfers: [] } }),
      });

      assert(
        lifecycle.stripeHold !== null,
        'payment lifecycle reported no Stripe hold for the benchmark payment user — the ' +
          'company-funded admin path was taken and expected_payment_lifecycle.stripeHold is unreachable'
      );
      assert(
        lifecycle.stripeHold?.status === 'succeeded',
        `expected a succeeded hold, got ${lifecycle.stripeHold?.status}`
      );
      assert(
        lifecycle.stripeHold?.amountReceivedCents === LIFECYCLE_TOTAL_CENTS,
        `expected ${LIFECYCLE_TOTAL_CENTS} captured, got ${lifecycle.stripeHold?.amountReceivedCents}`
      );
      assert(
        lifecycle.stripeHold?.amountCapturableCents === 0,
        `expected a fully captured hold, got ${lifecycle.stripeHold?.amountCapturableCents}`
      );
      // Restates the cause behind every assertion above, so a future admin-listing of this id
      // fails with the reason rather than only the symptom.
      assert(
        !isAdminUser(userId),
        `payment-lifecycle benchmark user ${userId} must never be an admin: admins mint ` +
          'company-funded cards with no Stripe hold, so the lifecycle benchmarks can never pass'
      );
    });
  } finally {
    await prisma.purchaseSpend.deleteMany({ where: { userId, fingerprint } });
    await prisma.agent.deleteMany({ where: { id: agent.id } });
    if (previousSubscription === null) {
      await prisma.subscription.deleteMany({ where: { userId } });
    }
  }
  console.log(
    'PASS benchmark payment identity mints on the charged path and reports a Stripe hold'
  );
}


async function adminWithForcedCustomerPathProducesStripeHold(): Promise<void> {
  const userId = BENCHMARK_PAYMENT_LIFECYCLE_ADMIN_RUN_USER_ID;
  assert(userId === ADMIN_USER_ID, 'sandbox lifecycle run-user must be the hardcoded admin');
  assert(isAdminUser(userId), 'sandbox lifecycle run-user must remain an admin for unlimited credits');
  const fingerprint = `admin-force-hold-${RUN_ID}-${randomUUID()}`;
  const provider = new FakeCardProvider();
  const walletFundingProvider = new FakeWalletFundingProvider();
  await prisma.user.upsert({
    where: { userId },
    update: {},
    create: { userId, isAnonymous: false, name: 'Andy Prevalsky' },
  });
  const agent = await prisma.agent.create({
    data: { userId, goal: 'forced customer path blackbox' },
  });
  const previousSubscription = await prisma.subscription.findUnique({ where: { userId } });
  await prisma.subscription.upsert({
    where: { userId },
    update: { stripeCustomerId: previousSubscription?.stripeCustomerId ?? `cus_force_${RUN_ID}` },
    create: {
      userId,
      subscriptionTier: 1,
      stripeCustomerId: `cus_force_${RUN_ID}`,
      stripeSubscriptionId: `sub_force_${RUN_ID}`,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  try {
    await withForcePathEnv(
      { BENCHMARK_MODE: '1', BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH: '1' },
      async () => {
        assert(
          benchmarkForceCustomerPurchasePath(),
          'BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH must be honored in benchmark mode'
        );
        await withFakeStripe(async (calls) => {
          const result = await purchasesService.mintPurchaseCard(
            validMintBody({
              userId,
              agentId: agent.id,
              fingerprint,
              totalCents: LIFECYCLE_TOTAL_CENTS,
              subtotalCents: 3600,
              lineItems: [{ label: 'Benchmark cart', amountCents: 3600 }],
              fees: [
                { label: 'Tax', amountCents: 297 },
                { label: 'Shipping', amountCents: 499 },
              ],
            }) as never,
            provider,
            walletFundingProvider
          );
          assert(result.status === PurchaseSpendStatus.HELD, `expected HELD, got ${result.status}`);
          assert(
            calls.charges.length === 1,
            'admin + force-customer-path must authorize exactly one Stripe hold, got ' +
              `${calls.charges.length}`
          );
          assert(
            calls.captures.length === 1,
            `admin + force-customer-path must capture its Stripe hold, got ${calls.captures.length}`
          );
          const row = await prisma.purchaseSpend.findFirst({
            where: { userId, fingerprint },
            orderBy: { createdAt: 'desc' },
          });
          assert(
            row?.stripePaymentIntentId !== null && row?.stripePaymentIntentId !== undefined,
            'forced customer path must persist a Stripe payment intent'
          );
        });
      }
    );
  } finally {
    await prisma.purchaseSpend.deleteMany({ where: { userId, fingerprint } });
    await prisma.agent.deleteMany({ where: { id: agent.id } });
    if (previousSubscription === null) {
      await prisma.subscription.deleteMany({ where: { userId } });
    }
  }
  console.log('PASS admin + forced customer path authorizes a Stripe hold');
}

async function forceFlagWithoutBenchmarkModeKeepsAdminPath(): Promise<void> {
  const fingerprint = `admin-force-ignored-${RUN_ID}-${randomUUID()}`;
  const provider = new FakeCardProvider();
  const walletFundingProvider = new FakeWalletFundingProvider();
  await prisma.user.upsert({
    where: { userId: ADMIN_USER_ID },
    update: {},
    create: { userId: ADMIN_USER_ID, isAnonymous: true },
  });
  try {
    await withForcePathEnv(
      { BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH: '1' },
      async () => {
        assert(
          !benchmarkForceCustomerPurchasePath(),
          'force flag must be inert when BENCHMARK_MODE and BENCHMARK_ISOLATED_RUN are unset'
        );
        await withFakeStripe(async (calls) => {
          const result = await purchasesService.mintPurchaseCard(
            validMintBody({ userId: ADMIN_USER_ID, fingerprint, totalCents: 1000 }) as never,
            provider,
            walletFundingProvider
          );
          assert(result.status === PurchaseSpendStatus.HELD, `expected HELD, got ${result.status}`);
          assert(
            calls.charges.length === 0,
            `force flag without benchmark mode must keep the admin no-hold path, got ${calls.charges.length}`
          );
        });
      }
    );
  } finally {
    await prisma.purchaseSpend.deleteMany({ where: { userId: ADMIN_USER_ID, fingerprint } });
  }
  console.log('PASS force flag without benchmark mode keeps the admin company-card path');
}

async function main(): Promise<void> {
  try {
    await adminMintIssuesCompanyCardWithoutCharge();
    await nonAdminWithoutCustomerFails402();
    await benchmarkPaymentIdentityProducesTheAssertedStripeHold();
    await adminWithForcedCustomerPathProducesStripeHold();
    await forceFlagWithoutBenchmarkModeKeepsAdminPath();
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
