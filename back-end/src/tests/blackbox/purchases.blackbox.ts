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

import crypto, { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { z } from 'zod';
import { PurchaseSpendStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import { AgentCardProviderError, type CardProvider } from '../../providers/card-provider';
import * as purchasesService from '../../domains/purchases/service';
import {
  assert,
  assertStatus,
  FakeCardProvider,
  RepurchaseProvider,
  StubCardStateProvider,
  seedHeldPurchase,
  withFakeStripe,
} from './purchases.testkit';

config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const RUN_ID =
  process.env.BLACKBOX_TEST_RUN_ID ||
  process.env.CONTRACT_TEST_RUN_ID ||
  `${Date.now()}-${randomUUID().slice(0, 8)}`;

const trackedUserIds = new Set<string>();
const trackedAgentIds = new Set<string>();

const ErrorResponse = z.object({
  error: z.string(),
  code: z.string().optional(),
});

const PurchaseLookupResponse = z.object({
  found: z.boolean(),
  reusable: z.boolean(),
  purchase: z
    .object({
      id: z.string(),
      agentId: z.string().nullable(),
      fingerprint: z.string(),
      cardId: z.string().nullable(),
      merchant: z.string(),
      totalCents: z.number(),
      status: z.nativeEnum(PurchaseSpendStatus),
      createdAt: z.string().or(z.date()),
      updatedAt: z.string().or(z.date()),
    })
    .nullable(),
});

const OkResponse = z.object({
  ok: z.literal(true),
});

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function request(
  path: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown; headers: Headers }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const contentType = response.headers.get('content-type');
  const data = contentType?.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data, headers: response.headers };
}

function apiKeyHeaders(userId?: string): Record<string, string> {
  return {
    'X-API-Key': API_KEY,
    ...(userId ? { 'X-User-Id': userId } : {}),
  };
}

function webhookHeaders(payload: unknown): Record<string, string> {
  const secret = process.env.AGENTCARD_WEBHOOK_SECRET;
  if (!secret) return {};
  const t = Math.floor(Date.now() / 1000).toString();
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${t}.${JSON.stringify(payload)}`)
    .digest('hex');
  return { 'agentcard-signature': `t=${t},v1=${signature}` };
}

function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`${label} schema validation failed: ${result.error.message}`);
  }
  return result.data;
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

      await withFakeStripe(async (calls) => {
        const first = await purchasesService.mintPurchaseCard(
          validMintBody({ userId, fingerprint, totalCents: 1000 }) as never,
          provider
        );
        const second = await purchasesService.mintPurchaseCard(
          validMintBody({ userId, fingerprint, totalCents: 1000 }) as never,
          provider
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
          row?.stripePaymentIntentId !== null,
          'purchase spend should store the payment intent id'
        );
        assert(
          calls.charges[0].includes('"statement_descriptor_suffix":"Test Merchant"'),
          'charge should set merchant descriptor suffix'
        );
        assert(
          calls.charges[0].includes('"capture_method":"manual"'),
          'mint must authorize a manual-capture hold, not an immediate charge'
        );
        assert(
          calls.captures.length === 0 && calls.cancels.length === 0,
          'minting alone must not capture or cancel the hold'
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

      await withFakeStripe(async (calls) => {
        const result = await purchasesService.mintPurchaseCard(
          validMintBody({ userId, fingerprint, totalCents: 1080 }) as never,
          provider
        );
        assert(result.cardId === provider.newCardId, 're-purchase should mint a NEW card');
        assert(provider.mintCalls === 1, 'should mint exactly one new card');
        assert(calls.charges.length === 1, 're-purchase should charge exactly once');

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
    'lookup rejects unauthenticated requests',
    async () => {
      const response = await request('/api/purchases/lookup?fingerprint=missing');
      assertStatus(response.status, 401, response.data);
      assertSchema(ErrorResponse, response.data, 'unauthenticated lookup');
    },
  ],
  [
    'lookup requires a fingerprint',
    async () => {
      const userId = await createUser('lookup-missing-fingerprint');
      const response = await request('/api/purchases/lookup', {
        headers: apiKeyHeaders(userId),
      });
      assertStatus(response.status, 400, response.data);
      const body = assertSchema(ErrorResponse, response.data, 'missing fingerprint');
      assert(body.error.includes('fingerprint'), 'error should mention fingerprint');
    },
  ],
  [
    'lookup returns a non-reusable miss without leaking card data',
    async () => {
      const userId = await createUser('lookup-miss');
      const response = await request('/api/purchases/lookup?fingerprint=no-such-purchase', {
        headers: apiKeyHeaders(userId),
      });
      assertStatus(response.status, 200, response.data);
      const body = assertSchema(PurchaseLookupResponse, response.data, 'lookup miss');
      assert(body.found === false, 'expected found=false');
      assert(body.reusable === false, 'expected reusable=false');
      assert(body.purchase === null, 'expected no purchase payload');
    },
  ],
  [
    'mint rejects purchases over the configured maximum before creating spend rows',
    async () => {
      const userId = await createUser('over-limit');
      const fingerprint = `over-limit-${randomUUID()}`;
      const response = await request('/api/purchases/mint', {
        method: 'POST',
        headers: apiKeyHeaders(userId),
        body: JSON.stringify(validMintBody({ fingerprint, totalCents: 2_147_483_647 })),
      });
      assertStatus(response.status, 402, response.data);
      assertSchema(ErrorResponse, response.data, 'over-limit mint');

      const rows = await prisma.purchaseSpend.findMany({ where: { userId, fingerprint } });
      assert(rows.length === 0, 'over-limit mint should not create a purchase spend row');
    },
  ],
  [
    'mint records a failed purchase when the user has no Stripe customer',
    async () => {
      const userId = await createUser('missing-stripe-customer');
      const fingerprint = `missing-customer-${randomUUID()}`;
      const response = await request('/api/purchases/mint', {
        method: 'POST',
        headers: apiKeyHeaders(userId),
        body: JSON.stringify(validMintBody({ fingerprint, totalCents: 1000 })),
      });
      assertStatus(response.status, 402, response.data);
      const body = assertSchema(ErrorResponse, response.data, 'missing customer mint');
      assert(
        body.error.includes('Stripe billing customer'),
        'error should identify missing Stripe customer'
      );

      const row = await prisma.purchaseSpend.findFirst({
        where: { userId, fingerprint },
        orderBy: { createdAt: 'desc' },
      });
      assert(row !== null, 'failed mint should persist a purchase spend row');
      assert(row?.status === PurchaseSpendStatus.FAILED, `expected FAILED, got ${row?.status}`);
      assert(row?.cardId === null, 'failed mint should not store a card id');
      assert(
        row?.stripePaymentIntentId === null,
        'failed mint should not store a payment intent id'
      );
    },
  ],
  [
    'agentcard webhook spec path accepts unknown card events as idempotent no-ops',
    async () => {
      const payload = { type: 'transaction.cleared', cardId: `card-${randomUUID()}` };
      const response = await request('/api/webhooks/agentcard', {
        method: 'POST',
        headers: webhookHeaders(payload),
        body: JSON.stringify(payload),
      });
      assertStatus(response.status, 200, response.data);
      assertSchema(OkResponse, response.data, 'webhook unknown card');
    },
  ],
  [
    'agentcard webhook legacy purchases path remains compatible',
    async () => {
      const payload = {
        type: 'transaction.voided',
        data: { card: { id: `card-${randomUUID()}` } },
      };
      const response = await request('/api/purchases/webhooks/agentcard', {
        method: 'POST',
        headers: webhookHeaders(payload),
        body: JSON.stringify(payload),
      });
      assertStatus(response.status, 200, response.data);
      assertSchema(OkResponse, response.data, 'legacy webhook unknown card');
    },
  ],
  [
    'agentcard webhook without a card id is an idempotent no-op',
    async () => {
      const payload = { type: 'transaction.cleared' };
      const response = await request('/api/webhooks/agentcard', {
        method: 'POST',
        headers: webhookHeaders(payload),
        body: JSON.stringify(payload),
      });
      assertStatus(response.status, 200, response.data);
      assertSchema(OkResponse, response.data, 'webhook no card id');
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
