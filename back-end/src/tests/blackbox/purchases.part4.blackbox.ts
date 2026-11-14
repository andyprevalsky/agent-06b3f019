#!/usr/bin/env tsx
/**
 * Black-box tests (part 4) for /api/purchases and /api/webhooks/agentcard.
 *
 * Covers the stale-charging/failed-row mint recovery paths plus the HTTP
 * boundary branches (lookup auth/validation and AgentCard webhook idempotency)
 * that short-circuit before Stripe and AgentCard calls.
 * Split from purchases.blackbox.ts to stay under the max-lines cap.
 */

import crypto, { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { z } from 'zod';
import { PurchaseSpendStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import { AgentCardOrgMcpProvider, AgentCardProviderError } from '../../providers/card-provider';
import * as purchasesService from '../../domains/purchases/service';
import { companyFundingInProgressDetails } from '../../domains/purchases/errors';
import {
  assert,
  assertStatus,
  FakeCardProvider,
  FakeWalletFundingProvider,
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

function assertWebhookResult(response: { status: number; data: unknown }, label: string): void {
  if (!process.env.AGENTCARD_WEBHOOK_SECRET) {
    assertStatus(response.status, 503, response.data);
    const body = assertSchema(ErrorResponse, response.data, label);
    assert(
      body.error === 'AgentCard webhook signing secret is not configured',
      'missing signing configuration must reject every webhook'
    );
    return;
  }
  assertStatus(response.status, 200, response.data);
  assertSchema(OkResponse, response.data, label);
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
  for (const userId of trackedUserIds) {
    await prisma.user.deleteMany({ where: { userId } });
  }
  await prisma.$disconnect();
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    'organization MCP preserves transferless company-funding retries',
    async () => {
      const provider = new AgentCardOrgMcpProvider('cardholder-funding', async () => ({
        content: [
          {
            type: 'text',
            text: 'Company-wallet funding is in progress — call create_card again with the SAME arguments and the SAME idempotency_key in ~10s to collect the card.',
          },
        ],
        structuredContent: {
          message:
            'Company-wallet funding is in progress — call create_card again with the SAME arguments and the SAME idempotency_key in ~10s to collect the card.',
          status: 'funding_in_progress',
          retryAfterSeconds: 10,
        },
      }));

      let caught: unknown;
      try {
        await provider.mintCard({
          amountCents: 100,
          fundsSource: 'company_flow',
          idempotencyKey: 'purchase:transferless-funding',
        });
      } catch (error) {
        caught = error;
      }

      assert(
        caught instanceof AgentCardProviderError &&
          caught.status === 409 &&
          caught.code === 'agentcard_company_funding_in_progress' &&
          caught.details.transferId === undefined &&
          caught.details.retryAfterSeconds === 10,
        `expected a typed transferless funding retry, got "${caught instanceof Error ? caught.message : String(caught)}"`
      );
      const funding = companyFundingInProgressDetails(caught);
      assert(
        funding?.transferId === undefined && funding?.retryAfterSeconds === 10,
        'the purchase retry loop must accept a transferless funding response'
      );
    },
  ],
  [
    'organization MCP prose-only setup errors fail closed after provider mutation starts',
    async () => {
      const calls: string[] = [];
      const provider = new AgentCardOrgMcpProvider('cardholder-missing', async (name) => {
        calls.push(name);
        const message =
          'create_card failed: org_onboarding_required: This cardholder has no linked user yet — complete hosted onboarding first.';
        return {
          content: [{ type: 'text', text: message }],
          structuredContent: {
            message,
            status: 'error',
          },
        };
      });

      let caught: unknown;
      try {
        await provider.mintCard({
          amountCents: 100,
          fundsSource: 'company_flow',
          idempotencyKey: 'purchase:missing-cardholder',
        });
      } catch (error) {
        caught = error;
      }

      assert(
        caught instanceof AgentCardProviderError &&
          caught.message ===
            'create_card failed: org_onboarding_required: This cardholder has no linked user yet — complete hosted onboarding first.',
        `expected upstream AgentCard error, got "${caught instanceof Error ? caught.message : String(caught)}"`
      );
      assert(
        caught instanceof AgentCardProviderError &&
          caught.status === undefined &&
          caught.code === undefined,
        'prose-only onboarding text must remain an ambiguous provider failure'
      );
      assert(
        calls.length === 1 && calls[0] === 'create_card',
        `error response must stop before card details; calls=${calls.join(',')}`
      );
    },
  ],
  [
    'organization MCP retries idempotent create_card timeouts before failing the purchase',
    async () => {
      const calls: Array<{ name: string; args: unknown }> = [];
      const provider = new AgentCardOrgMcpProvider('cardholder-timeout', async (name, args) => {
        calls.push({ name, args });
        if (name === 'create_card' && calls.filter((call) => call.name === name).length === 1) {
          throw new Error('Request timed out');
        }
        if (name === 'create_card') {
          return {
            structuredContent: {
              card_id: 'card-after-timeout',
              transfer_id: 'owt-after-timeout',
              status: 'OPEN',
              amount_cents: 4396,
            },
          };
        }
        if (name === 'get_card_details') {
          return {
            structuredContent: {
              pan: '4242424242424242',
              cvv: '123',
              expiry: '12/30',
              balance_cents: 4396,
              status: 'OPEN',
            },
          };
        }
        throw new Error(`unexpected tool ${name}`);
      });

      const request = {
        amountCents: 4396,
        fundsSource: 'company_flow' as const,
        idempotencyKey: 'purchase:timeout-retry',
      };
      const minted = await provider.mintCard(request);

      assert(minted.cardId === 'card-after-timeout', 'retry should recover the minted card');
      assert(
        minted.providerTransferId === 'owt-after-timeout',
        'retry should preserve transfer id'
      );
      assert(
        calls.length === 3 && calls[0]?.name === 'create_card' && calls[1]?.name === 'create_card',
        `expected create_card retry before details; calls=${calls.map((call) => call.name).join(',')}`
      );
      assert(
        JSON.stringify(calls[0]?.args) === JSON.stringify(calls[1]?.args),
        'retry must use the exact original create_card arguments and idempotency key'
      );
    },
  ],
  [
    'mint recovers stale charging rows before retrying the same cart',
    async () => {
      const userId = await createSubscribedUser('stale-charging-retry');
      const fingerprint = `stale-charging-${randomUUID()}`;
      const provider = new FakeCardProvider();
      const input = validMintBody({ userId, fingerprint, totalCents: 1000 });
      const oldPurchase = await prisma.purchaseSpend.create({
        data: {
          userId,
          fingerprint,
          merchant: 'Test Merchant',
          lineItemsJson: {
            currency: 'USD',
            lineItems: input.lineItems,
            fees: input.fees,
            subtotalCents: 1000,
            totalCents: 1000,
          },
          totalCents: 1000,
          status: PurchaseSpendStatus.CHARGING,
          stripePaymentIntentId: `pi_stale_${randomUUID()}`,
          updatedAt: new Date(Date.now() - 60 * 60 * 1000),
        },
      });
      await prisma.purchaseWalletFunding.create({
        data: {
          purchaseId: oldPurchase.id,
          userId,
          amountCents: 1000,
          currency: 'usd',
          status: 'FUNDED',
          providerTransferId: provider.providerTransferId,
          idempotencyKey: `purchase-wallet-fund:${oldPurchase.id}`,
        },
      });
      const walletFundingProvider = new FakeWalletFundingProvider();

      await withFakeStripe(async (calls) => {
        const result = await purchasesService.mintPurchaseCard(
          input as never,
          provider,
          walletFundingProvider
        );

        assert(result.cardId === provider.cardId, 'retry should recover the original card');
        assert(calls.cancels.length === 0, 'same-purchase retry must preserve its Stripe hold');
        assert(calls.charges.length === 1, 'retry should replay one idempotent Stripe request');
        assert(
          walletFundingProvider.reclaimCalls.length === 0,
          'same-key recovery must not reclaim its original transfer'
        );
        assert(
          provider.mintRequests[0]?.fundsSource === 'company_flow',
          'retry should request company_flow for the fresh purchase'
        );
        assert(
          walletFundingProvider.fundCalls.length === 0,
          'retry should not pre-fund the user wallet'
        );

        const oldRow = await prisma.purchaseSpend.findUnique({ where: { id: oldPurchase.id } });
        assert(oldRow?.status === PurchaseSpendStatus.HELD, `expected HELD, got ${oldRow?.status}`);
        const rows = await prisma.purchaseSpend.findMany({ where: { userId, fingerprint } });
        assert(rows.length === 1, 'retry must not create a second purchase row');
      });
    },
  ],
  [
    'mint retries failed rows with a fresh purchase idempotency boundary',
    async () => {
      const userId = await createSubscribedUser('failed-retry-fresh-row');
      const fingerprint = `failed-retry-${randomUUID()}`;
      const oldPurchase = await prisma.purchaseSpend.create({
        data: {
          userId,
          fingerprint,
          merchant: 'Failed Merchant',
          lineItemsJson: { totalCents: 1000 },
          totalCents: 1000,
          status: PurchaseSpendStatus.FAILED,
        },
      });
      const provider = new FakeCardProvider();
      const walletFundingProvider = new FakeWalletFundingProvider();

      await withFakeStripe(async (calls) => {
        const result = await purchasesService.mintPurchaseCard(
          validMintBody({ userId, fingerprint, totalCents: 1000 }) as never,
          provider,
          walletFundingProvider
        );

        assert(result.cardId === provider.cardId, 'retry should mint a card');
        assert(calls.charges.length === 1, 'retry should create one fresh Stripe hold');

        const oldRow = await prisma.purchaseSpend.findUnique({ where: { id: oldPurchase.id } });
        assert(oldRow?.status === PurchaseSpendStatus.FAILED, 'old failed row must stay failed');
        const newRow = await prisma.purchaseSpend.findFirst({
          where: { userId, fingerprint, status: PurchaseSpendStatus.HELD },
          orderBy: { createdAt: 'desc' },
        });
        assert(newRow !== null, 'retry should create a new HELD purchase row');
        assert(newRow?.id !== oldPurchase.id, 'retry must not reuse the failed purchase row');
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
      const { MAX_PURCHASE_CENTS, PURCHASE_ABOVE_MAX_LIMIT_CODE } =
        await import('../../domains/purchases/config');
      const response = await request('/api/purchases/mint', {
        method: 'POST',
        headers: apiKeyHeaders(userId),
        body: JSON.stringify(validMintBody({ fingerprint, totalCents: MAX_PURCHASE_CENTS + 1 })),
      });
      assertStatus(response.status, 400, response.data);
      const body = assertSchema(ErrorResponse, response.data, 'over-limit mint');
      assert(
        body.code === PURCHASE_ABOVE_MAX_LIMIT_CODE,
        `expected code ${PURCHASE_ABOVE_MAX_LIMIT_CODE}, got ${body.code}`
      );
      assert(
        body.error === `Purchase is above max limit of ${MAX_PURCHASE_CENTS}`,
        `expected over-limit message, got ${body.error}`
      );
      const details = response.data as { maxPurchaseCents?: unknown };
      assert(
        details.maxPurchaseCents === MAX_PURCHASE_CENTS,
        `expected maxPurchaseCents ${MAX_PURCHASE_CENTS}, got ${details.maxPurchaseCents}`
      );

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
      assertWebhookResult(response, 'webhook unknown card');
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
      assertWebhookResult(response, 'legacy webhook unknown card');
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
      assertWebhookResult(response, 'webhook no card id');
    },
  ],
];

async function main(): Promise<void> {
  console.log(`Running purchases black-box tests part 4 (${tests.length} tests)...`);
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

  console.log(`\nPurchases black-box tests part 4: ${passed}/${results.length} passed`);
  if (passed !== results.length) process.exit(1);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  await cleanup();
  process.exit(1);
});
