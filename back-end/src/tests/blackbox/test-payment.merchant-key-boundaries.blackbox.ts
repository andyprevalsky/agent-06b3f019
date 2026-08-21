#!/usr/bin/env tsx
/**
 * Settlement and source-boundary tests for the /test_payment merchant Stripe key.
 * Split from test-payment.merchant-key.blackbox.ts to keep each suite under max-lines.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { settleTestPaymentCheckoutSession } from '../../domains/test-payment/checkout';
import {
  TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV,
  getTestPaymentMerchantStripeClient,
  stripe,
  type Stripe,
} from '../../providers/stripe';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

interface CheckoutSessionsResource {
  retrieve: (id: string, params?: unknown) => Promise<unknown>;
}

interface StubbedCall {
  client: 'merchant' | 'billing';
  op: 'retrieve';
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
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

const FAKE_MERCHANT_KEY = 'sk_test_merchant_blackbox_never_dialed';

function withMerchantKey<T>(key: string, fn: () => T): T {
  const previous = process.env[TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV];
  const restore = () => {
    if (previous === undefined) delete process.env[TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV];
    else process.env[TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV] = previous;
  };
  process.env[TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV] = key;
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function checkoutSessions(client: Stripe): CheckoutSessionsResource {
  return client.checkout.sessions as unknown as CheckoutSessionsResource;
}

async function withCheckoutRetrievalsStubbed<T>(
  merchant: Stripe,
  fn: (calls: StubbedCall[]) => Promise<T>
): Promise<T> {
  const calls: StubbedCall[] = [];
  const targets: Array<{ label: 'merchant' | 'billing'; resource: CheckoutSessionsResource }> = [
    { label: 'merchant', resource: checkoutSessions(merchant) },
    { label: 'billing', resource: checkoutSessions(stripe) },
  ];
  const originals = targets.map(({ resource }) => resource.retrieve);

  for (const { label, resource } of targets) {
    resource.retrieve = async () => {
      calls.push({ client: label, op: 'retrieve' });
      return { payment_status: 'unpaid', amount_total: 100 };
    };
  }

  try {
    return await fn(calls);
  } finally {
    targets.forEach(({ resource }, index) => {
      resource.retrieve = originals[index];
    });
  }
}

const SOURCE_ROOT = join(dirname(new URL(import.meta.url).pathname), '../..');

function readSource(relativePath: string): string {
  return readFileSync(join(SOURCE_ROOT, relativePath), 'utf-8');
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    'settling a checkout session reads it back on the MERCHANT key, never billing',
    async () => {
      await withMerchantKey(FAKE_MERCHANT_KEY, async () => {
        const merchant = getTestPaymentMerchantStripeClient();
        await withCheckoutRetrievalsStubbed(merchant, async (calls) => {
          let failure: unknown;
          try {
            await settleTestPaymentCheckoutSession('cs_test_merchant');
          } catch (error) {
            failure = error;
          }
          assert(
            failure instanceof Error && /unpaid/.test(failure.message),
            `settlement must consume the merchant session, got ${String(failure)}`
          );
          assert(
            calls.length === 1 && calls[0].client === 'merchant',
            `the session must be read on the merchant client, got ${JSON.stringify(calls)}`
          );
        });
      });
    },
  ],
  [
    'only the /test_payment checkout path may reach for the merchant client',
    async () => {
      const checkoutSource = readSource('domains/test-payment/checkout.ts');
      assert(
        checkoutSource.includes('getTestPaymentMerchantStripeClient'),
        'checkout.ts must acquire through the merchant client'
      );
      const stripeImport = /import \{([^}]*)\} from '\.\.\/\.\.\/providers\/stripe';/.exec(
        checkoutSource
      );
      assert(stripeImport !== null, 'checkout.ts should import from providers/stripe');
      const bindings = (stripeImport?.[1] ?? '')
        .split(',')
        .map((binding) => binding.replace(/^type\s+/, '').trim());
      assert(
        !bindings.includes('stripe'),
        'checkout.ts must not bind the billing `stripe` singleton'
      );
      for (const billingPath of [
        'domains/billing/service.ts',
        'domains/purchases/charge.ts',
        'domains/test-payment/lifecycle.ts',
        'domains/test-payment/service.ts',
        'providers/agentcard/checkout-settlement.ts',
        'domains/webhooks/service.ts',
      ]) {
        const source = readSource(billingPath);
        assert(
          !source.includes('getTestPaymentMerchantStripeClient('),
          `${billingPath} is a billing call site and must never use the merchant client`
        );
      }
      const billingService = readSource('domains/billing/service.ts');
      assert(
        billingService.includes('checkout.sessions.create'),
        'billing subscription checkout must still mint Stripe Checkout sessions'
      );
      assert(
        billingService.includes('getStripeClientForSecretKey') ||
          billingService.includes('stripe.checkout.sessions.create'),
        'billing subscription checkout must use the billing Stripe client'
      );
    },
  ],
];

async function main(): Promise<void> {
  process.stdout.write(`Running merchant-key boundary tests (${tests.length} tests)...\n`);
  const results: TestResult[] = [];
  for (const [name, fn] of tests) results.push(await runTest(name, fn));
  const passed = results.filter((result) => result.passed).length;
  for (const result of results) {
    process.stdout.write(
      `${result.passed ? 'PASS' : 'FAIL'} ${result.name} (${result.duration}ms)\n`
    );
    if (!result.passed) process.stdout.write(`  ${result.error}\n`);
  }
  process.stdout.write(`\nMerchant-key boundary tests: ${passed}/${results.length} passed\n`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
