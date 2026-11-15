#!/usr/bin/env tsx
/**
 * Black-box tests for the dev-only /api/test-payment benchmark fixture.
 *
 * Boundary capture:
 *   These tests assert validation paths that short-circuit before Stripe. The
 *   live Stripe test-mode charge is covered by the agent-payment benchmark.
 */

import 'dotenv/config';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  configureBenchmarkAgentCardSetup,
  confirmPhoneBenchmarkPayment,
  confirmTestPayment,
  getTestPaymentLifecycle,
  recordPhoneBenchmarkPaymentAudit,
} from '../../domains/test-payment/service';
import { prisma } from '../../providers/database';
import { stripe } from '../../providers/stripe';
import { assertBenchmarkAgentCardResetFixture } from './test-payment-agentcard-fixture';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const writeLine = (message = ''): void => {
  process.stdout.write(`${message}\n`);
};
const writeErrorLine = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

const ErrorResponse = z.object({ error: z.string() });
const ItemsResponse = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        imageUrl: z.string().url(),
        priceCents: z.number().int().positive(),
      })
    )
    .length(5),
});

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const contentType = response.headers.get('content-type');
  const data = contentType?.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected)
    throw new Error(`Expected ${expected}, got ${actual}: ${JSON.stringify(data)}`);
}

function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`${label} schema failed: ${parsed.error.message}`);
  return parsed.data;
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
      duration: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function withFakeStripe<T>(
  fn: (calls: { paymentMethods: string[]; paymentIntents: string[] }) => Promise<T>
) {
  const paymentMethods = stripe.paymentMethods as unknown as {
    create: (params: unknown) => Promise<{ id: string }>;
  };
  const paymentIntents = stripe.paymentIntents as unknown as {
    create: (params: unknown) => Promise<{ id: string; status: string }>;
  };
  const originalPaymentMethodCreate = paymentMethods.create;
  const originalPaymentIntentCreate = paymentIntents.create;
  const calls = { paymentMethods: [] as string[], paymentIntents: [] as string[] };

  paymentMethods.create = async (params: unknown) => {
    calls.paymentMethods.push(JSON.stringify(params));
    return { id: 'pm_should_not_be_used_for_agentcard_sandbox' };
  };
  paymentIntents.create = async (params: unknown) => {
    calls.paymentIntents.push(JSON.stringify(params));
    return { id: 'pi_test_payment_blackbox', status: 'succeeded' };
  };

  try {
    return await fn(calls);
  } finally {
    paymentMethods.create = originalPaymentMethodCreate;
    paymentIntents.create = originalPaymentIntentCreate;
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    'v2 benchmark AgentCard setup refuses live mode before any integration write',
    async () => {
      const userId = `benchmark-agentcard-unverified-${Date.now()}`;
      let message = '';
      try {
        await configureBenchmarkAgentCardSetup(
          { userId, action: 'complete' },
          {
            getV2FixtureUserId: () => 'usr_fixture_live',
            v2Request: async () => ({ livemode: true, default_funds_source: 'company_flow' }),
          }
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert(message.includes('sandbox credentials'), `expected sandbox-mode refusal: ${message}`);
      assert(
        (await prisma.integration.count({ where: { userId } })) === 0,
        'live mode must not write a fixture'
      );
    },
  ],
  [
    'v2 benchmark setup persists exclusive complete/reset transitions without legacy aliases',
    async () => {
      const userId = `benchmark-agentcard-setup-${Date.now()}`;
      const providerId = `usr_fixture_${Date.now()}`;
      await prisma.user.create({ data: { userId, isAnonymous: true } });
      const deps = {
        getV2FixtureUserId: () => providerId,
        v2Request: async (_method: string, resource: string) =>
          resource.endsWith('company_wallet')
            ? { livemode: false, default_funds_source: 'company_flow' }
            : { status: 'pending' },
      };
      try {
        const missing = await request('/api/test-payment/lifecycle/agentcard-setup', {
          method: 'POST',
          body: JSON.stringify({ action: 'complete' }),
        });
        assertStatus(missing.status, 400, missing.data);
        assert(
          (await configureBenchmarkAgentCardSetup({ userId, action: 'complete' }, deps)).status ===
            'connected',
          'expected v2 connected setup'
        );
        const integration = await prisma.integration.findUnique({
          where: { userId_name_accountId: { userId, name: 'agentcard', accountId: '' } },
        });
        assert(integration?.status === 'CONNECTED', 'expected persisted connection');
        assert(
          (integration?.config as Record<string, unknown>).v2UserId === providerId,
          'expected provider user.id'
        );
        assert(
          (await configureBenchmarkAgentCardSetup({ userId, action: 'reset' }, deps)).status ===
            'connect_required',
          'expected reset'
        );
        await assertBenchmarkAgentCardResetFixture(userId);
        assert(
          (await configureBenchmarkAgentCardSetup({ userId, action: 'complete' }, deps)).status ===
            'connected',
          'expected restored same identity'
        );
      } finally {
        await prisma.integration.deleteMany({ where: { userId, name: 'agentcard' } });
        await prisma.user.deleteMany({ where: { userId } });
      }
    },
  ],
  [
    'lifecycle requires an agent id at the HTTP boundary',
    async () => {
      const response = await request('/api/test-payment/lifecycle');
      assertStatus(response.status, 400, response.data);
      const body = assertSchema(ErrorResponse, response.data, 'lifecycle missing agent id');
      assert(body.error === 'agentId is required', `unexpected error: ${body.error}`);
    },
  ],
  [
    'benchmark abandonment endpoint is idempotent when no purchase exists',
    async () => {
      const response = await request('/api/test-payment/lifecycle/abandon', {
        method: 'POST',
        body: JSON.stringify({ agentId: `missing-agent-${Date.now()}` }),
      });
      assertStatus(response.status, 200, response.data);
      assert(
        (response.data as { purchase?: unknown }).purchase === null,
        'expected no purchase for missing benchmark agent'
      );
    },
  ],
  [
    'close-held-reuse rejects non-lifecycle prod users',
    async () => {
      const response = await request('/api/test-payment/lifecycle/close-held-reuse', {
        method: 'POST',
        body: JSON.stringify({ userId: 'not-the-lifecycle-prod-user' }),
      });
      assertStatus(response.status, 403, response.data);
      const body = assertSchema(ErrorResponse, response.data, 'close-held-reuse wrong user');
      assert(
        typeof body.error === 'string' && body.error.includes('lifecycle probe user'),
        `unexpected error: ${body.error}`
      );
    },
  ],
  [
    'owner-billing readiness reports an unconfigured dedicated probe customer',
    async () => {
      // The blackbox server runs without BENCHMARK_PAYMENT_LIFECYCLE_STRIPE_CUSTOMER_ID; the
      // configured path is covered in-process by purchases-owner-lifecycle.cases.ts.
      const response = await request('/api/test-payment/lifecycle/owner-billing');
      assertStatus(response.status, 200, response.data);
      assert(
        (response.data as { configured?: unknown }).configured === false,
        'expected an unconfigured owner probe customer'
      );
    },
  ],
  [
    'purge refuses an agent that is not the owner lifecycle probe',
    async () => {
      const response = await request('/api/test-payment/lifecycle/purge', {
        method: 'POST',
        body: JSON.stringify({ agentId: `missing-agent-${Date.now()}` }),
      });
      assertStatus(response.status, 404, response.data);
    },
  ],
  [
    'lifecycle cross-verifies purchase, hold, card, transfer, and resolved setup',
    async () => {
      let transferReads = 0;
      const result = await getTestPaymentLifecycle('agent-lifecycle-1', {
        findPurchase: async () =>
          ({
            id: 'purchase-1',
            userId: 'user-1',
            agentId: 'agent-lifecycle-1',
            fingerprint: 'fingerprint-1',
            cardId: 'card-1',
            merchant: 'Rose Labs Test Payment',
            lineItemsJson: [],
            totalCents: 4396,
            status: 'VOIDED',
            stripePaymentIntentId: 'pi-hold-1',
            provider: 'agentcard',
            createdAt: new Date(),
            updatedAt: new Date(),
            walletFunding: {
              id: 'funding-1',
              purchaseId: 'purchase-1',
              userId: 'user-1',
              agentId: 'agent-lifecycle-1',
              provider: 'agentcard',
              amountCents: 4396,
              currency: 'usd',
              status: 'RECLAIMED',
              providerTransferId: 'transfer-1',
              reclaimProviderTransferId: null,
              idempotencyKey: 'fund-purchase-1',
              reclaimIdempotencyKey: null,
              metadata: null,
              errorMessage: null,
              fundedAt: new Date(),
              consumedAt: null,
              reclaimedAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          }) as never,
        findAttentionRequests: async () =>
          [
            {
              userResponse: 'setup_complete',
              metadata: { attentionKind: 'agentcard_user_cardholder_onboarding_required' },
            },
          ] as never,
        getCardSummary: async () => ({ status: 'CLOSED', balanceCents: 0 }),
        searchStripeHolds: async () => ({ data: [] }),
        getOrgCardholderId: async () => undefined,
        retrieveStripeHold: async () => ({
          id: 'pi-hold-1',
          livemode: false,
          status: 'succeeded',
          amount: 4396,
          amount_capturable: 0,
          amount_received: 4396,
        }),
        listStripeRefunds: async () => ({
          data: [{ id: 're-1', status: 'succeeded', amount: 4396, payment_intent: 'pi-hold-1' }],
        }),
        listOrgTransfers: async ({ status }) => {
          transferReads += 1;
          if (status !== 'consumed' && status !== 'reclaimed') {
            return { structuredContent: { transfers: [] } };
          }
          return {
            structuredContent: {
              transfers: [
                {
                  id: 'transfer-1',
                  status,
                  amount_cents: 4396,
                  transferred_cents: 4396,
                  released_cents: status === 'reclaimed' ? 4396 : 0,
                  card_id: 'card-1',
                  livemode: false,
                },
              ],
            },
          };
        },
      });

      assert(result.purchase?.status === 'VOIDED', 'expected voided purchase');
      assert(result.walletFunding?.status === 'RECLAIMED', 'expected reclaimed funding');
      assert(result.stripeHold?.amountReceivedCents === 4396, 'expected captured Stripe hold');
      assert(result.stripeRefund?.status === 'succeeded', 'expected succeeded Stripe refund');
      assert(result.stripeRefund?.amountCents === 4396, 'expected full Stripe refund amount');
      assert(result.agentCard?.status === 'CLOSED', 'expected closed one-time card');
      assert(result.agentCard?.balanceCents === 0, 'expected empty card balance');
      assert(result.orgTransfer?.status === 'reclaimed', 'expected newest reclaimed org transfer');
      assert(result.orgTransfer?.releasedCents === 4396, 'expected full released transfer amount');
      assert(transferReads === 5, 'expected lifecycle cross-check across every transfer status');
      assert(result.orgTransfer?.livemode === false, 'expected sandbox transfer');
      assert(result.attention.openKinds.length === 0, 'setup attention should be resolved');
      assert(
        result.attention.resolvedKinds.includes('agentcard_user_cardholder_onboarding_required'),
        'expected resolved setup attention'
      );
      assert(!JSON.stringify(result).includes('424242'), 'lifecycle must not expose PAN data');
    },
  ],
  [
    'public URL reports PUBLIC_BASE_URL when configured',
    async () => {
      const expectedUrl = process.env.PUBLIC_BASE_URL;
      if (!expectedUrl) return;

      const response = await request('/api/test-payment/public-url');
      assertStatus(response.status, 200, response.data);
      assert(
        JSON.stringify(response.data) === JSON.stringify({ url: expectedUrl }),
        `Expected public URL ${expectedUrl}, got ${JSON.stringify(response.data)}`
      );
    },
  ],
  [
    'items exposes five benchmark products with images and prices',
    async () => {
      const response = await request('/api/test-payment/items');
      assertStatus(response.status, 200, response.data);
      const body = assertSchema(ItemsResponse, response.data, 'items');
      assert(
        body.items.some((item) => item.id === 'aurora-notebook'),
        'missing aurora-notebook'
      );
      assert(
        body.items.every((item) => item.imageUrl.includes('placehold.co')),
        'expected stable image URLs'
      );
    },
  ],
  [
    'confirm requires exactly three distinct selected items before card processing',
    async () => {
      const response = await request('/api/test-payment/confirm', {
        method: 'POST',
        body: JSON.stringify({
          items: [{ id: 'aurora-notebook', quantity: 1 }],
          card: { number: '', expiry: '', cvv: '', name: '' },
        }),
      });
      assertStatus(response.status, 400, response.data);
      const body = assertSchema(ErrorResponse, response.data, 'one item confirm');
      assert(body.error.includes('3 distinct'), 'error should mention three distinct items');
    },
  ],
  [
    'confirm validates card fields after item validation',
    async () => {
      const response = await request('/api/test-payment/confirm', {
        method: 'POST',
        body: JSON.stringify({
          items: [
            { id: 'aurora-notebook', quantity: 1 },
            { id: 'ceramic-mug', quantity: 1 },
            { id: 'canvas-tote', quantity: 1 },
          ],
          card: { number: '', expiry: '', cvv: '', name: '' },
        }),
      });
      assertStatus(response.status, 400, response.data);
      const body = assertSchema(ErrorResponse, response.data, 'missing card confirm');
      assert(body.error.includes('card number'), 'error should mention missing card number');
    },
  ],
  [
    'confirm settles an AgentCard sandbox PAN through the AgentCard lifecycle',
    async () => {
      await withFakeStripe(async (calls) => {
        const settlements: Array<Record<string, unknown>> = [];
        const result = await confirmTestPayment(
          {
            items: [
              { id: 'aurora-notebook', quantity: 1 },
              { id: 'ceramic-mug', quantity: 1 },
              { id: 'canvas-tote', quantity: 1 },
            ],
            card: {
              name: 'Rose Labs',
              number: '4242424242420640',
              expiry: '06/28',
              cvv: '497',
              postalCode: '94105',
            },
          },
          {
            settleAgentCardSandboxPayment: async (input) => {
              settlements.push(input);
              return {
                purchaseId: 'purchase-1',
                cardId: 'card-1',
                stripePaymentIntentId: 'pi_hold_1',
              };
            },
          }
        );

        assert(result.status === 'succeeded', 'expected payment confirmation to succeed');
        assert(result.purchaseId === 'purchase-1', 'expected lifecycle purchase id');
        assert(result.cardId === 'card-1', 'expected lifecycle card id');
        assert(settlements.length === 1, 'expected one AgentCard settlement');
        assert(settlements[0]?.amountCents === 4396, 'expected exact card charge amount');
        assert(settlements[0]?.merchant === 'Rose Labs Test Payment', 'expected merchant');
        assert(calls.paymentMethods.length === 0, 'AgentCard PAN must not be raw-tokenized');
        assert(
          calls.paymentIntents.length === 0,
          'AgentCard PAN must not use a substitute Stripe charge'
        );
      });
    },
  ],
  [
    'phone benchmark payment creates a Stripe test PaymentIntent',
    async () => {
      await withFakeStripe(async (calls) => {
        const result = await confirmPhoneBenchmarkPayment({
          cardNumber: '4242 4242 4242 4242',
          expiration: '12/30',
          cvc: '123',
          billingZip: '78731',
          cardholderName: 'Rose Labs',
        });

        assert(result.status === 'succeeded', 'expected phone payment to succeed');
        assert(result.confirmationCode === 'ROSE-4471', 'expected phone confirmation code');
        assert(result.amountCents === 3420, 'expected $34.20 benchmark amount');
        assert(calls.paymentMethods.length === 0, 'sandbox PAN should use Stripe test PM token');
        assert(calls.paymentIntents.length === 1, 'expected one Stripe payment intent');
        const paymentIntent = JSON.parse(calls.paymentIntents[0]) as {
          amount?: number;
          payment_method?: string;
          metadata?: Record<string, string>;
        };
        assert(paymentIntent.amount === 3420, `expected amount 3420, got ${paymentIntent.amount}`);
        assert(
          paymentIntent.payment_method === 'pm_card_visa',
          `expected pm_card_visa, got ${paymentIntent.payment_method}`
        );
        assert(
          paymentIntent.metadata?.benchmark === 'phone-call-payment',
          'expected phone benchmark metadata'
        );
      });
    },
  ],
  [
    'phone benchmark payment audit records tool-call PaymentIntent results',
    async () => {
      const previous = process.env.PHONE_BENCHMARK_PAYMENT_AUDIT_PATH;
      const tmp = await mkdtemp(path.join(os.tmpdir(), 'phone-payment-audit-'));
      const auditPath = path.join(tmp, 'payments.jsonl');
      process.env.PHONE_BENCHMARK_PAYMENT_AUDIT_PATH = auditPath;
      try {
        const entry = await recordPhoneBenchmarkPaymentAudit({
          toolCallId: 'call_payment_blackbox',
          status: 'succeeded',
          paymentIntentId: 'pi_payment_blackbox',
          amountCents: 3420,
          confirmationCode: 'ROSE-4471',
        });
        const lines = (await readFile(auditPath, 'utf8')).trim().split('\n');
        const persisted = JSON.parse(lines[0]) as {
          createdAt?: string;
          toolCallId?: string;
          status?: string;
          paymentIntentId?: string;
        };
        assert(
          entry.createdAt === persisted.createdAt,
          'expected returned audit entry to match file'
        );
        assert(persisted.toolCallId === 'call_payment_blackbox', 'wrong persisted tool call id');
        assert(persisted.status === 'succeeded', 'wrong persisted status');
        assert(
          persisted.paymentIntentId === 'pi_payment_blackbox',
          'wrong persisted PaymentIntent id'
        );
      } finally {
        if (previous === undefined) delete process.env.PHONE_BENCHMARK_PAYMENT_AUDIT_PATH;
        else process.env.PHONE_BENCHMARK_PAYMENT_AUDIT_PATH = previous;
        await rm(tmp, { recursive: true, force: true });
      }
    },
  ],
];

async function main(): Promise<void> {
  writeLine(`Running test-payment black-box tests (${tests.length} tests)...`);
  const results: TestResult[] = [];
  for (const [name, fn] of tests) results.push(await runTest(name, fn));
  const passed = results.filter((result) => result.passed).length;
  for (const result of results) {
    writeLine(`${result.passed ? 'PASS' : 'FAIL'} ${result.name} (${result.duration}ms)`);
    if (!result.passed) writeLine(`  ${result.error}`);
  }
  writeLine(`\nTest-payment black-box tests: ${passed}/${results.length} passed`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  writeErrorLine(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
