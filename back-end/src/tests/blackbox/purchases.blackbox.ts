#!/usr/bin/env tsx
/* eslint-disable no-console */
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
import { stripe } from '../../providers/stripe';
import type { CardProvider } from '../../providers/card-provider';
import { cleanupAgentPurchaseCards } from '../../providers/purchaseCleanup';
import * as purchasesService from '../../domains/purchases/service';

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

class FakeCardProvider implements CardProvider {
  mintCalls = 0;
  detailCalls = 0;
  closeCalls = 0;
  readonly cardId = `fake-card-${randomUUID()}`;
  readonly pan = '4242424242424242';
  readonly cvv = '123';
  readonly expiry = '12/30';

  async mintCard() {
    this.mintCalls += 1;
    return {
      cardId: this.cardId,
      last4: '4242',
      expiry: this.expiry,
      spendLimitCents: 1000,
      status: 'active',
    };
  }

  async getDetails(cardId: string) {
    this.detailCalls += 1;
    assert(cardId === this.cardId, `unexpected card id ${cardId}`);
    return {
      pan: this.pan,
      cvv: this.cvv,
      expiry: this.expiry,
      balanceCents: 1000,
      status: 'active',
    };
  }

  async closeCard(cardId: string) {
    this.closeCalls += 1;
    assert(cardId === this.cardId, `unexpected card id ${cardId}`);
  }
}

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
  const signature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
  return { 'agentcard-signature': `sha256=${signature}` };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected status ${expected}, got ${actual}: ${JSON.stringify(data)}`);
  }
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

async function createAgent(userId: string, label: string): Promise<string> {
  const agent = await prisma.agent.create({
    data: {
      userId,
      goal: `purchase cleanup test ${label}`,
    },
    select: { id: true },
  });
  trackedAgentIds.add(agent.id);
  return agent.id;
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

async function withFakeStripe<T>(
  fn: (calls: { charges: string[]; refunds: string[] }) => Promise<T>
) {
  const paymentIntents = stripe.paymentIntents as unknown as {
    create: (params: unknown) => Promise<{ id: string }>;
  };
  const refunds = stripe.refunds as unknown as {
    create: (params: unknown) => Promise<{ id: string }>;
  };
  const customers = stripe.customers as unknown as {
    retrieve: (customerId: string) => Promise<{
      id: string;
      deleted?: boolean;
      invoice_settings: { default_payment_method: string };
    }>;
  };
  const originalPaymentIntentCreate = paymentIntents.create;
  const originalRefundCreate = refunds.create;
  const originalCustomerRetrieve = customers.retrieve;
  const calls = { charges: [] as string[], refunds: [] as string[] };

  customers.retrieve = async (customerId: string) => ({
    id: customerId,
    invoice_settings: { default_payment_method: 'pm_fake_default' },
  });
  paymentIntents.create = async (params: unknown) => {
    const id = `pi_${randomUUID()}`;
    calls.charges.push(JSON.stringify(params));
    return { id };
  };
  refunds.create = async (params: unknown) => {
    const id = `re_${randomUUID()}`;
    calls.refunds.push(JSON.stringify(params));
    return { id };
  };

  try {
    return await fn(calls);
  } finally {
    paymentIntents.create = originalPaymentIntentCreate;
    refunds.create = originalRefundCreate;
    customers.retrieve = originalCustomerRetrieve;
  }
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

        const row = await prisma.purchaseSpend.findUnique({
          where: { userId_fingerprint: { userId, fingerprint } },
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
      });
    },
  ],
  [
    'service close refunds held cards and marks the purchase refunded',
    async () => {
      const userId = await createSubscribedUser('service-close');
      const fingerprint = `service-close-${randomUUID()}`;
      const provider = new FakeCardProvider();

      await withFakeStripe(async (calls) => {
        await purchasesService.mintPurchaseCard(
          validMintBody({ userId, fingerprint, totalCents: 1000 }) as never,
          provider
        );
        const closed = await purchasesService.closePurchaseCard(provider.cardId, provider);

        assert(
          closed.status === PurchaseSpendStatus.REFUNDED,
          `expected REFUNDED, got ${closed.status}`
        );
        assert(
          provider.closeCalls === 1,
          `expected one provider close, got ${provider.closeCalls}`
        );
        assert(
          calls.refunds.length === 1,
          `expected one Stripe refund, got ${calls.refunds.length}`
        );

        const row = await prisma.purchaseSpend.findUnique({
          where: { userId_fingerprint: { userId, fingerprint } },
        });
        assert(
          row?.status === PurchaseSpendStatus.REFUNDED,
          `expected REFUNDED row, got ${row?.status}`
        );
      });
    },
  ],
  [
    'service webhook reconciles cleared and voided card transactions',
    async () => {
      const clearedUserId = await createUser('webhook-cleared');
      const voidedUserId = await createUser('webhook-voided');
      const clearedCardId = `card-cleared-${randomUUID()}`;
      const voidedCardId = `card-voided-${randomUUID()}`;

      await prisma.purchaseSpend.createMany({
        data: [
          {
            userId: clearedUserId,
            fingerprint: `cleared-${randomUUID()}`,
            cardId: clearedCardId,
            merchant: 'Cleared Merchant',
            lineItemsJson: { totalCents: 1000 },
            totalCents: 1000,
            status: PurchaseSpendStatus.HELD,
            stripePaymentIntentId: `pi_${randomUUID()}`,
          },
          {
            userId: voidedUserId,
            fingerprint: `voided-${randomUUID()}`,
            cardId: voidedCardId,
            merchant: 'Voided Merchant',
            lineItemsJson: { totalCents: 1000 },
            totalCents: 1000,
            status: PurchaseSpendStatus.HELD,
            stripePaymentIntentId: `pi_${randomUUID()}`,
          },
        ],
      });

      await withFakeStripe(async (calls) => {
        await purchasesService.handleAgentCardWebhook({
          type: 'transaction.cleared',
          cardId: clearedCardId,
        });
        await purchasesService.handleAgentCardWebhook({
          type: 'transaction.voided',
          cardId: voidedCardId,
        });

        const cleared = await prisma.purchaseSpend.findFirst({ where: { cardId: clearedCardId } });
        const voided = await prisma.purchaseSpend.findFirst({ where: { cardId: voidedCardId } });

        assert(
          cleared?.status === PurchaseSpendStatus.CLEARED,
          `expected CLEARED, got ${cleared?.status}`
        );
        assert(
          voided?.status === PurchaseSpendStatus.VOIDED,
          `expected VOIDED, got ${voided?.status}`
        );
        assert(
          calls.refunds.length === 1,
          `expected one refund for voided transaction, got ${calls.refunds.length}`
        );
      });
    },
  ],
  [
    'cleanup closes held agent purchase cards and refunds the user charge',
    async () => {
      const userId = await createUser('cleanup-held');
      const agentId = await createAgent(userId, 'held-card');
      const provider = new FakeCardProvider();
      const fingerprint = `cleanup-${randomUUID()}`;

      await prisma.purchaseSpend.create({
        data: {
          userId,
          agentId,
          fingerprint,
          cardId: provider.cardId,
          merchant: 'Cleanup Merchant',
          lineItemsJson: { totalCents: 1000 },
          totalCents: 1000,
          status: PurchaseSpendStatus.HELD,
          stripePaymentIntentId: `pi_${randomUUID()}`,
        },
      });

      await withFakeStripe(async (calls) => {
        await cleanupAgentPurchaseCards(agentId, provider);

        assert(
          provider.closeCalls === 1,
          `expected one provider close, got ${provider.closeCalls}`
        );
        assert(
          calls.refunds.length === 1,
          `expected one Stripe refund, got ${calls.refunds.length}`
        );

        const row = await prisma.purchaseSpend.findUnique({
          where: { userId_fingerprint: { userId, fingerprint } },
        });
        assert(
          row?.status === PurchaseSpendStatus.REFUNDED,
          `expected REFUNDED, got ${row?.status}`
        );
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

      const row = await prisma.purchaseSpend.findUnique({
        where: { userId_fingerprint: { userId, fingerprint } },
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
