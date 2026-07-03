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
  confirmPhoneBenchmarkPayment,
  confirmTestPayment,
  recordPhoneBenchmarkPaymentAudit,
} from '../../domains/test-payment/service';
import { stripe } from '../../providers/stripe';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const writeLine = (message = ''): void => {
  process.stdout.write(`${message}\n`);
};
const writeErrorLine = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

const ErrorResponse = z.object({ error: z.string() });
const VapiToolResponse = z.object({
  results: z.array(
    z.object({
      toolCallId: z.string(),
      result: z.string(),
    })
  ),
});
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
    'confirm accepts AgentCard sandbox PAN through Stripe test payment method',
    async () => {
      await withFakeStripe(async (calls) => {
        const result = await confirmTestPayment({
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
        });

        assert(result.status === 'succeeded', 'expected payment confirmation to succeed');
        assert(
          calls.paymentMethods.length === 0,
          'AgentCard sandbox PAN should not be raw-tokenized'
        );
        assert(calls.paymentIntents.length === 1, 'expected one Stripe payment intent');
        const paymentIntent = JSON.parse(calls.paymentIntents[0]) as {
          payment_method?: string;
          payment_method_types?: string[];
        };
        assert(
          paymentIntent.payment_method === 'pm_card_visa',
          `expected pm_card_visa, got ${paymentIntent.payment_method}`
        );
        assert(
          paymentIntent.payment_method_types?.join(',') === 'card',
          `expected card-only payment method types, got ${paymentIntent.payment_method_types}`
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
  [
    'Vapi phone payment tool returns tool-call result envelope on validation failure',
    async () => {
      const response = await request('/api/test-payment/vapi-phone-payment-tool', {
        method: 'POST',
        body: JSON.stringify({
          message: {
            type: 'tool-calls',
            toolCallList: [
              {
                id: 'toolu_phone_payment_missing_cvc',
                name: 'complete_test_payment',
                arguments: {
                  card_number: '4242 4242 4242 4242',
                  expiration: '12/30',
                  billing_zip: '78731',
                },
              },
            ],
          },
        }),
      });
      assertStatus(response.status, 200, response.data);
      const body = assertSchema(VapiToolResponse, response.data, 'vapi payment tool');
      assert(
        body.results[0].toolCallId === 'toolu_phone_payment_missing_cvc',
        'wrong tool call id'
      );
      const result = JSON.parse(body.results[0].result) as { status?: string; error?: string };
      assert(result.status === 'failed', 'expected failed result');
      assert(String(result.error || '').includes('cvc'), `expected cvc error, got ${result.error}`);
    },
  ],
  [
    'Vapi phone payment tool accepts JSON-string tool arguments',
    async () => {
      const response = await request('/api/test-payment/vapi-phone-payment-tool', {
        method: 'POST',
        body: JSON.stringify({
          message: {
            type: 'tool-calls',
            toolCallList: [
              {
                id: 'toolu_phone_payment_string_args',
                name: 'complete_test_payment',
                arguments: JSON.stringify({
                  card_number: '4242 4242 4242 4242',
                  expiration: '12/30',
                  billing_zip: '78731',
                }),
              },
            ],
          },
        }),
      });
      assertStatus(response.status, 200, response.data);
      const body = assertSchema(VapiToolResponse, response.data, 'vapi payment tool');
      assert(
        body.results[0].toolCallId === 'toolu_phone_payment_string_args',
        'wrong tool call id'
      );
      const result = JSON.parse(body.results[0].result) as { status?: string; error?: string };
      assert(result.status === 'failed', 'expected failed result');
      assert(String(result.error || '').includes('cvc'), `expected cvc error, got ${result.error}`);
    },
  ],
  [
    'Vapi phone payment tool accepts nested function toolCalls payload',
    async () => {
      const response = await request('/api/test-payment/vapi-phone-payment-tool', {
        method: 'POST',
        body: JSON.stringify({
          message: {
            type: 'tool-calls',
            toolCalls: [
              {
                id: 'call_nested_missing_cvc',
                type: 'function',
                function: {
                  name: 'complete_test_payment',
                  arguments: {
                    card_number: '4242 4242 4242 4242',
                    expiration: '12/30',
                    billing_zip: '78731',
                  },
                },
              },
            ],
          },
        }),
      });
      assertStatus(response.status, 200, response.data);
      const body = assertSchema(VapiToolResponse, response.data, 'vapi payment tool');
      assert(body.results[0].toolCallId === 'call_nested_missing_cvc', 'wrong tool call id');
      const result = JSON.parse(body.results[0].result) as { status?: string; error?: string };
      assert(result.status === 'failed', 'expected failed result');
      assert(String(result.error || '').includes('cvc'), `expected cvc error, got ${result.error}`);
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
