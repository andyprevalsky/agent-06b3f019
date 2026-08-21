#!/usr/bin/env tsx
/**
 * Black-box tests for the /test_payment MERCHANT (acquirer) Stripe key.
 *
 * Rose sits on BOTH sides of a /test_payment purchase and the two sides must never share a key:
 *
 *   BILLING  `STRIPE_SECRET_KEY`  (the `stripe` singleton)
 *     Subscriptions, customers, and the personal purchase hold/capture/refund. Stays TEST-mode:
 *     every production `Subscription.stripeCustomerId` was created in test mode, so a live global
 *     key orphans every real user's billing.
 *
 *   MERCHANT  `TEST_PAYMENT_MERCHANT_STRIPE_SECRET_KEY`  (`getTestPaymentMerchantStripeClient()`)
 *     The shop taking a card at hosted Checkout. Must be LIVE for a live Rose-minted AgentCard to
 *     authorize on real card rails — AgentCard refuses `test_charge` on live cards and Stripe test
 *     mode never touches the networks.
 *
 * These tests exist so the two can never be transposed. They are behavioural: both clients are
 * stubbed and the REAL checkout functions are driven, so a swap makes the "wrong key" recorder fire
 * and the test fails. No live network is touched and no money moves.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createTestPaymentCheckoutSession,
  settleTestPaymentCheckoutSession,
} from '../../domains/test-payment/checkout';
import {
  TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV,
  getTestPaymentMerchantStripeClient,
  resolveTestPaymentMerchantSecretKey,
  stripe,
  type Stripe,
} from '../../providers/stripe';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
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

/**
 * A merchant key that is syntactically a Stripe key but belongs to no account: the SDK is never
 * actually called over the wire in this suite (every method under test is stubbed), so this can
 * never authorize anything.
 */
const FAKE_MERCHANT_KEY = 'sk_test_merchant_blackbox_never_dialed';

function withMerchantKey<T>(key: string | undefined, fn: () => T): T {
  const previous = process.env[TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV];
  const restore = () => {
    if (previous === undefined) delete process.env[TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV];
    else process.env[TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV] = previous;
  };
  if (key === undefined) delete process.env[TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV];
  else process.env[TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV] = key;
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

interface CheckoutSessionsResource {
  create: (params: unknown) => Promise<{ id: string; url: string | null }>;
  retrieve: (id: string, params?: unknown) => Promise<unknown>;
}

function checkoutSessions(client: Stripe): CheckoutSessionsResource {
  return client.checkout.sessions as unknown as CheckoutSessionsResource;
}

interface StubbedCall {
  client: 'merchant' | 'billing';
  op: 'create' | 'retrieve';
  params?: unknown;
}

/**
 * Stub `checkout.sessions.{create,retrieve}` on BOTH the merchant and billing clients and record
 * which one the code under test reached for. The billing stubs are the inversion detector: if the
 * checkout path ever regresses back to the `stripe` singleton, it lands in `calls` tagged
 * `billing` and every assertion below fails.
 */
async function withBothCheckoutClientsStubbed<T>(
  merchant: Stripe,
  session: { id: string; url: string | null; retrieved: unknown },
  fn: (calls: StubbedCall[]) => Promise<T>
): Promise<T> {
  const calls: StubbedCall[] = [];
  const targets: Array<{ label: 'merchant' | 'billing'; resource: CheckoutSessionsResource }> = [
    { label: 'merchant', resource: checkoutSessions(merchant) },
    { label: 'billing', resource: checkoutSessions(stripe) },
  ];
  const originals = targets.map(({ resource }) => ({
    create: resource.create,
    retrieve: resource.retrieve,
  }));

  for (const { label, resource } of targets) {
    resource.create = async (params) => {
      calls.push({ client: label, op: 'create', params });
      return { id: session.id, url: session.url };
    };
    resource.retrieve = async () => {
      calls.push({ client: label, op: 'retrieve' });
      return session.retrieved;
    };
  }

  try {
    return await fn(calls);
  } finally {
    targets.forEach(({ resource }, index) => {
      resource.create = originals[index].create;
      resource.retrieve = originals[index].retrieve;
    });
  }
}

const CHECKOUT_ITEMS = [
  { id: 'aurora-notebook', quantity: 1 },
  { id: 'ceramic-mug', quantity: 1 },
  { id: 'canvas-tote', quantity: 1 },
];

const SOURCE_ROOT = join(dirname(new URL(import.meta.url).pathname), '../..');

function readSource(relativePath: string): string {
  return readFileSync(join(SOURCE_ROOT, relativePath), 'utf-8');
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    'a configured merchant key always wins over the billing key',
    async () => {
      assert(
        resolveTestPaymentMerchantSecretKey('sk_live_merchant', 'sk_test_billing').secretKey ===
          'sk_live_merchant',
        'the merchant key must be preferred; picking the billing key acquires on the wrong account'
      );
      assert(
        resolveTestPaymentMerchantSecretKey('sk_live_merchant', 'sk_test_billing')
          .usedBillingFallback === false,
        'a configured merchant key is not a fallback'
      );
      assert(
        resolveTestPaymentMerchantSecretKey('  sk_live_padded  ', 'sk_test_billing').secretKey ===
          'sk_live_padded',
        'the merchant key is trimmed, not passed through with whitespace'
      );
    },
  ],
  [
    'an absent or blank merchant key falls back to billing and says so',
    async () => {
      for (const absent of [undefined, '', '   ']) {
        const resolved = resolveTestPaymentMerchantSecretKey(absent, 'sk_test_billing');
        assert(
          resolved.secretKey === 'sk_test_billing',
          `expected the billing fallback for ${JSON.stringify(absent)}`
        );
        assert(
          resolved.usedBillingFallback,
          'the fallback must be reported so the caller can warn/fail rather than acquire silently'
        );
      }
    },
  ],
  [
    'the merchant client is a distinct client from the billing singleton',
    async () => {
      const merchant = withMerchantKey(FAKE_MERCHANT_KEY, getTestPaymentMerchantStripeClient);
      assert(
        merchant !== stripe,
        'a configured merchant key must produce its own client, not the billing singleton'
      );
      assert(
        withMerchantKey(FAKE_MERCHANT_KEY, getTestPaymentMerchantStripeClient) === merchant,
        'the merchant client is memoized per key rather than rebuilt on every checkout'
      );
    },
  ],
  [
    'a non-Stripe merchant key is rejected instead of being dialed',
    async () => {
      let threw = false;
      try {
        withMerchantKey('not-a-stripe-key', getTestPaymentMerchantStripeClient);
      } catch {
        threw = true;
      }
      assert(threw, 'a malformed merchant key must fail closed');
    },
  ],
  [
    'production rejects a test-mode merchant key before constructing a client',
    async () => {
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        let failure: unknown;
        try {
          withMerchantKey(FAKE_MERCHANT_KEY, getTestPaymentMerchantStripeClient);
        } catch (error) {
          failure = error;
        }
        assert(
          failure instanceof Error &&
            failure.message.includes(TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV) &&
            failure.message.includes('sk_live_'),
          `production must fail closed with an actionable live-key error, got ${String(failure)}`
        );
      } finally {
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
      }
    },
  ],
  [
    'the dev fallback returns the billing singleton and warns loudly',
    async () => {
      const written: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      let client: Stripe;
      try {
        process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
          written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
          return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
        }) as typeof process.stdout.write;
        client = withMerchantKey(undefined, getTestPaymentMerchantStripeClient);
      } finally {
        process.stdout.write = originalWrite;
      }
      assert(
        client === stripe,
        'the fallback must be the billing singleton itself, never a second client masquerading ' +
          'as a merchant account'
      );
      const logged = written.join('');
      assert(
        logged.includes(TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV),
        `the fallback must name ${TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV}; got: ${logged.slice(-400)}`
      );
      assert(
        logged.includes('WARN') || logged.includes('"level":"warn"'),
        'the fallback must be logged at warn level, not swallowed'
      );
    },
  ],
  [
    'creating a checkout session acquires on the MERCHANT key, never billing',
    async () => {
      await withMerchantKey(FAKE_MERCHANT_KEY, async () => {
        const merchant = getTestPaymentMerchantStripeClient();
        await withBothCheckoutClientsStubbed(
          merchant,
          {
            id: 'cs_test_merchant',
            url: 'https://checkout.stripe.com/c/pay/cs_test_merchant',
            retrieved: {},
          },
          async (calls) => {
            const created = await createTestPaymentCheckoutSession(
              { items: CHECKOUT_ITEMS },
              {
                findHeldPurchasesByTotal: async (amountCents) => [
                  {
                    id: 'purchase-correlated',
                    userId: 'user-1',
                    agentId: 'agent-1',
                    cardId: 'card-1',
                    stripePaymentIntentId: 'pi_hold_1',
                    ...(amountCents === 4396 ? {} : { id: 'wrong-total' }),
                  },
                ],
              }
            );
            assert(created.sessionId === 'cs_test_merchant', 'returned the created session');
            assert(created.totalCents === 4396, 'returns the full subtotal + tax + shipping total');
            assert(
              calls.length === 1 && calls[0].client === 'merchant' && calls[0].op === 'create',
              `checkout must be created on the merchant client, got ${JSON.stringify(calls)}`
            );
            const params = calls[0]?.params as {
              client_reference_id?: string;
              metadata?: { purchaseId?: string };
              success_url?: string;
              line_items?: Array<{ price_data?: { unit_amount?: number }; quantity?: number }>;
            };
            assert(
              params.client_reference_id === 'purchase-correlated' &&
                params.metadata?.purchaseId === 'purchase-correlated',
              'the exact Rose purchase id must travel through both Stripe correlation fields'
            );
            assert(
              params.success_url?.includes('benchmark=agentcard-live-lifecycle') === true,
              'Stripe must return to the production-enabled lifecycle page before settlement'
            );
            const stripeTotal = (params.line_items ?? []).reduce(
              (sum, item) => sum + (item.price_data?.unit_amount ?? 0) * (item.quantity ?? 0),
              0
            );
            assert(
              stripeTotal === created.totalCents,
              `Stripe must capture the displayed full total; got ${stripeTotal} vs ${created.totalCents}`
            );
          }
        );
      });
    },
  ],
  [
    'the one-item production lifecycle cart creates an exact one-dollar correlated session',
    async () => {
      await withMerchantKey(FAKE_MERCHANT_KEY, async () => {
        const merchant = getTestPaymentMerchantStripeClient();
        await withBothCheckoutClientsStubbed(
          merchant,
          {
            id: 'cs_test_lifecycle',
            url: 'https://checkout.stripe.com/c/pay/cs_test_lifecycle',
            retrieved: {},
          },
          async (calls) => {
            const created = await createTestPaymentCheckoutSession(
              { items: [{ id: 'agentcard-lifecycle-probe', quantity: 1 }] },
              {
                findHeldPurchasesByTotal: async () => [
                  {
                    id: 'purchase-live-probe',
                    userId: 'user-1',
                    agentId: 'agent-1',
                    cardId: 'card-live',
                    stripePaymentIntentId: 'pi_hold_live',
                  },
                ],
              }
            );
            assert(created.totalCents === 100, 'the lifecycle probe stays exactly $1.00');
            const params = calls[0]?.params as {
              client_reference_id?: string;
              line_items?: Array<{ price_data?: { unit_amount?: number }; quantity?: number }>;
            };
            assert(
              params.client_reference_id === 'purchase-live-probe',
              'the lifecycle session carries the exact purchase correlation'
            );
            const stripeTotal = (params.line_items ?? []).reduce(
              (sum, item) => sum + (item.price_data?.unit_amount ?? 0) * (item.quantity ?? 0),
              0
            );
            assert(stripeTotal === 100, 'Stripe lifecycle capture must be exactly $1.00');
          }
        );
      });
    },
  ],
  [
    // RCA: leftover HELD $1 rows made sequential AgentCard getDetails hang Place order for minutes.
    // last4 proofs across amount candidates must run concurrently (still fail-closed on duplicates).
    'checkout-session proves candidate last4s concurrently',
    async () => {
      await withMerchantKey(FAKE_MERCHANT_KEY, async () => {
        const merchant = getTestPaymentMerchantStripeClient();
        await withBothCheckoutClientsStubbed(
          merchant,
          {
            id: 'cs_test_parallel_last4',
            url: 'https://checkout.stripe.com/c/pay/cs_test_parallel_last4',
            retrieved: {},
          },
          async () => {
            let inFlight = 0;
            let maxInFlight = 0;
            const release: Array<() => void> = [];
            const getCardLast4 = async (
              _userId: string,
              _agentId: string | null,
              cardId: string
            ) => {
              inFlight += 1;
              maxInFlight = Math.max(maxInFlight, inFlight);
              await new Promise<void>((resolve) => {
                release.push(() => {
                  inFlight -= 1;
                  resolve();
                });
              });
              return cardId === 'card-current' ? '8945' : '1111';
            };
            const pending = createTestPaymentCheckoutSession(
              {
                items: [{ id: 'agentcard-lifecycle-probe', quantity: 1 }],
                cardLast4: '8945',
              },
              {
                findHeldPurchasesByTotal: async () => [
                  {
                    id: 'purchase-stale-sibling',
                    userId: 'user-bench',
                    agentId: 'agent-older',
                    cardId: 'card-older',
                    stripePaymentIntentId: 'pi_hold_older',
                  },
                  {
                    id: 'purchase-current',
                    userId: 'user-bench',
                    agentId: 'agent-current',
                    cardId: 'card-current',
                    stripePaymentIntentId: 'pi_hold_current',
                  },
                ],
                getCardLast4,
              }
            );
            // Both proofs must be in-flight before either resolves — sequential await maxes at 1.
            await new Promise((resolve) => setImmediate(resolve));
            assert(
              maxInFlight === 2,
              `expected concurrent last4 proofs, maxInFlight=${maxInFlight}`
            );
            for (const done of release) done();
            const created = await pending;
            assert(
              created.sessionId === 'cs_test_parallel_last4',
              'parallel last4 path must still create'
            );
          }
        );
      });
    },
  ],
  [
    // RCA: agent-payment-production-purchase (bc64fd0a) — prod had two HELD $1.00 Rose
    // purchases from different agents; checkout-session matched by total only and 409'd
    // "Multiple held Rose purchases match this checkout total; refusing an ambiguous charge".
    // Sandbox settle already disambiguates by PAN among amount matches; hosted checkout must
    // accept the same class of card hint (last4) so leftover/sibling holds cannot block Place order.
    'checkout-session disambiguates multiple HELD same-total purchases by card last4',
    async () => {
      await withMerchantKey(FAKE_MERCHANT_KEY, async () => {
        const merchant = getTestPaymentMerchantStripeClient();
        await withBothCheckoutClientsStubbed(
          merchant,
          {
            id: 'cs_test_disambiguated',
            url: 'https://checkout.stripe.com/c/pay/cs_test_disambiguated',
            retrieved: {},
          },
          async (calls) => {
            const created = await createTestPaymentCheckoutSession(
              {
                items: [{ id: 'agentcard-lifecycle-probe', quantity: 1 }],
                cardLast4: '8945',
              },
              {
                findHeldPurchasesByTotal: async () => [
                  {
                    id: 'purchase-stale-sibling',
                    userId: 'user-bench',
                    agentId: 'agent-older',
                    cardId: 'card-older',
                    stripePaymentIntentId: 'pi_hold_older',
                  },
                  {
                    id: 'purchase-current',
                    userId: 'user-bench',
                    agentId: 'agent-current',
                    cardId: 'card-current',
                    stripePaymentIntentId: 'pi_hold_current',
                  },
                ],
                getCardLast4: async (_userId, _agentId, cardId) =>
                  cardId === 'card-current' ? '8945' : '1111',
              }
            );
            assert(
              created.sessionId === 'cs_test_disambiguated',
              'ambiguous totals must still create a session once last4 selects one purchase'
            );
            const params = calls[0]?.params as {
              client_reference_id?: string;
              metadata?: { purchaseId?: string };
            };
            assert(
              params.client_reference_id === 'purchase-current' &&
                params.metadata?.purchaseId === 'purchase-current',
              `must correlate Stripe to the last4-matched purchase, got ${JSON.stringify(params)}`
            );
          }
        );
      });
    },
  ],
  [
    'checkout-session still refuses when last4 cannot uniquely select among HELD totals',
    async () => {
      await withMerchantKey(FAKE_MERCHANT_KEY, async () => {
        const merchant = getTestPaymentMerchantStripeClient();
        await withBothCheckoutClientsStubbed(
          merchant,
          {
            id: 'cs_should_not_create',
            url: 'https://checkout.stripe.com/c/pay/cs_should_not_create',
            retrieved: {},
          },
          async (calls) => {
            let failure: unknown;
            try {
              await createTestPaymentCheckoutSession(
                {
                  items: [{ id: 'agentcard-lifecycle-probe', quantity: 1 }],
                  cardLast4: '0000',
                },
                {
                  findHeldPurchasesByTotal: async () => [
                    {
                      id: 'purchase-a',
                      userId: 'user-bench',
                      agentId: 'agent-a',
                      cardId: 'card-a',
                      stripePaymentIntentId: 'pi_a',
                    },
                    {
                      id: 'purchase-b',
                      userId: 'user-bench',
                      agentId: 'agent-b',
                      cardId: 'card-b',
                      stripePaymentIntentId: 'pi_b',
                    },
                  ],
                  getCardLast4: async () => '8945',
                }
              );
            } catch (error) {
              failure = error;
            }
            assert(
              failure instanceof Error &&
                /No held Rose purchase matches this checkout card/.test(failure.message),
              `unmatched last4 must fail closed without binding a wrong hold, got ${String(failure)}`
            );
            assert(calls.length === 0, 'must not create a Stripe session when still ambiguous');
          }
        );
      });
    },
  ],
  [
    'checkout-session rejects a lone HELD when supplied last4 does not match that card',
    async () => {
      await withMerchantKey(FAKE_MERCHANT_KEY, async () => {
        const merchant = getTestPaymentMerchantStripeClient();
        await withBothCheckoutClientsStubbed(
          merchant,
          {
            id: 'cs_stale_only',
            url: 'https://checkout.stripe.com/c/pay/cs_stale_only',
            retrieved: {},
          },
          async (calls) => {
            let failure: unknown;
            try {
              await createTestPaymentCheckoutSession(
                {
                  items: [{ id: 'agentcard-lifecycle-probe', quantity: 1 }],
                  cardLast4: '8945',
                },
                {
                  findHeldPurchasesByTotal: async () => [
                    {
                      id: 'purchase-stale-only',
                      userId: 'user-bench',
                      agentId: 'agent-stale',
                      cardId: 'card-stale',
                      stripePaymentIntentId: 'pi_stale',
                    },
                  ],
                  getCardLast4: async () => '1111',
                }
              );
            } catch (error) {
              failure = error;
            }
            assert(
              failure instanceof Error &&
                /No held Rose purchase matches this checkout card/.test(failure.message),
              `a single wrong-last4 hold must not be bound, got ${String(failure)}`
            );
            assert(calls.length === 0, 'must not create a Stripe session for a last4 mismatch');
          }
        );
      });
    },
  ],
  [
    'settling a checkout session reads it back on the MERCHANT key, never billing',
    async () => {
      await withMerchantKey(FAKE_MERCHANT_KEY, async () => {
        const merchant = getTestPaymentMerchantStripeClient();
        await withBothCheckoutClientsStubbed(
          merchant,
          {
            id: 'cs_test_merchant',
            url: null,
            // Deliberately unpaid: settlement then short-circuits on the payment_status the
            // MERCHANT client returned, which both proves the stubbed body was the one consumed and
            // keeps this suite free of any database round-trip.
            retrieved: { payment_status: 'unpaid', amount_total: 100 },
          },
          async (calls) => {
            let failure: unknown;
            try {
              await settleTestPaymentCheckoutSession('cs_test_merchant');
            } catch (error) {
              failure = error;
            }
            assert(
              failure instanceof Error && /unpaid/.test(failure.message),
              `settlement must consume the session the merchant client returned, got ${String(failure)}`
            );
            assert(
              calls.length === 1 && calls[0].client === 'merchant' && calls[0].op === 'retrieve',
              `the session must be read back on the merchant client, got ${JSON.stringify(calls)}`
            );
          }
        );
      });
    },
  ],
  [
    'only the /test_payment checkout path may reach for the merchant client',
    async () => {
      // Structural half of the guarantee: the behavioural tests above prove checkout uses the
      // merchant key; this proves nothing ELSE can start using it. Billing, purchase holds, and
      // settlement must stay on the billing singleton.
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
        'checkout.ts must not bind the billing `stripe` singleton; every Stripe call in the ' +
          'checkout path is an acquirer call and belongs on the merchant client'
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
          `${billingPath} is a BILLING-side call site and must never use the merchant client: ` +
            'subscriptions, customers, and personal purchase holds live on STRIPE_SECRET_KEY'
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
        'billing subscription checkout must mint via the billing/live Stripe client, ' +
          'never the merchant acquirer client'
      );
    },
  ],
];

async function main(): Promise<void> {
  process.stdout.write(
    `Running test-payment merchant-key black-box tests (${tests.length} tests)...\n`
  );
  const results: TestResult[] = [];
  for (const [name, fn] of tests) results.push(await runTest(name, fn));
  const passed = results.filter((result) => result.passed).length;
  for (const result of results) {
    process.stdout.write(
      `${result.passed ? 'PASS' : 'FAIL'} ${result.name} (${result.duration}ms)\n`
    );
    if (!result.passed) process.stdout.write(`  ${result.error}\n`);
  }
  process.stdout.write(
    `\nTest-payment merchant-key black-box tests: ${passed}/${results.length} passed\n`
  );
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exit(1);
});
