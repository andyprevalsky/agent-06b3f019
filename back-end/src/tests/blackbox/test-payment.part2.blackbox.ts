#!/usr/bin/env tsx
/**
 * Black-box tests (part 2) for the dev-only test-payment fixture.
 *
 * Covers the lifecycle mappers for a purchase with no card/hold, the AgentCard transfer envelope
 * parsing (text-content + missing-field guards), and the phone-benchmark Stripe branches that
 * tokenize a non-sandbox card and reject a non-succeeded PaymentIntent. Stripe is stubbed, so no
 * live network is touched.
 */

import 'dotenv/config';
import {
  assertV2LifecycleContract,
  assertV2SandboxSettlementContract,
} from './test-payment-v2-lifecycle.cases';
import {
  confirmPhoneBenchmarkPayment,
  getTestPaymentLifecycle,
} from '../../domains/test-payment/service';
import { stripe } from '../../providers/stripe';

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

interface StripeStubOptions {
  paymentIntentStatus?: string;
}

async function withStubbedStripe<T>(
  fn: (calls: { paymentMethods: unknown[]; paymentIntents: unknown[] }) => Promise<T>,
  options: StripeStubOptions = {}
): Promise<T> {
  const paymentMethods = stripe.paymentMethods as unknown as {
    create: (params: unknown) => Promise<{ id: string }>;
  };
  const paymentIntents = stripe.paymentIntents as unknown as {
    create: (params: unknown) => Promise<{ id: string; status: string }>;
  };
  const originalPaymentMethodCreate = paymentMethods.create;
  const originalPaymentIntentCreate = paymentIntents.create;
  const calls = {
    paymentMethods: [] as unknown[],
    paymentIntents: [] as unknown[],
  };

  paymentMethods.create = async (params: unknown) => {
    calls.paymentMethods.push(params);
    return { id: 'pm_stub_non_sandbox' };
  };
  paymentIntents.create = async (params: unknown) => {
    calls.paymentIntents.push(params);
    return {
      id: 'pi_test_payment_part2',
      status: options.paymentIntentStatus ?? 'succeeded',
    };
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
    'v2 lifecycle observes exact transfer and cursor integrity without legacy identity',
    assertV2LifecycleContract,
  ],
  [
    'v2 sandbox settlement requires exact cleared REST transaction in test mode',
    assertV2SandboxSettlementContract,
  ],
  [
    'lifecycle maps a purchase with no card or hold to empty cross-references',
    async () => {
      const result = await getTestPaymentLifecycle('agent-no-card', {
        findPurchase: async () =>
          ({
            id: 'purchase-no-card',
            userId: 'user-1',
            agentId: 'agent-no-card',
            fingerprint: 'fp-1',
            cardId: null,
            merchant: 'Rose Labs Test Payment',
            lineItemsJson: [],
            totalCents: 4396,
            status: 'PENDING_APPROVAL',
            stripePaymentIntentId: null,
            provider: 'agentcard',
            createdAt: new Date(),
            updatedAt: new Date(),
            walletFunding: null,
          }) as never,
        findAttentionRequests: async () => [] as never,
        searchStripeHolds: async () => ({ data: [] }),
        getOrgCardholderId: async () => undefined,
      });

      assert(result.purchase?.status === 'PENDING_APPROVAL', 'expected the pending purchase');
      assert(result.walletFunding === null, 'no funding row should map to null');
      assert(result.stripeHold === null, 'no payment intent should map to a null hold');
      assert(result.stripeRefund === null, 'no payment intent should map to a null refund');
      assert(result.agentCard === null, 'no card id should map to a null AgentCard');
      assert(result.orgTransfer === null, 'no card id should map to a null org transfer');
      assert(result.attention.openKinds.length === 0, 'no attention requests should be open');
    },
  ],
  [
    'lifecycle maps a consumed sandbox transfer from its immutable funded amount',
    async () => {
      const result = await getTestPaymentLifecycle('agent-text-envelope', {
        findPurchase: async () =>
          ({
            id: 'purchase-text',
            userId: 'user-1',
            agentId: 'agent-text-envelope',
            fingerprint: 'fp-text',
            cardId: 'card-text',
            merchant: 'Rose Labs Test Payment',
            lineItemsJson: [],
            totalCents: 4396,
            status: 'CLEARED',
            stripePaymentIntentId: null,
            provider: 'agentcard',
            createdAt: new Date(),
            updatedAt: new Date(),
            walletFunding: null,
          }) as never,
        findAttentionRequests: async () => [] as never,
        getCardSummary: async () => ({ status: 'CLOSED', balanceCents: 0 }),
        searchStripeHolds: async () => ({ data: [] }),
        getOrgCardholderId: async () => undefined,
        listOrgTransfers: async () => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                transfers: [
                  {
                    id: 'transfer-text',
                    status: 'consumed',
                    amount_cents: 4396,
                    // Captured AgentCard sandbox response after a successful $43.96 checkout:
                    // this mutable counter had fallen by the $12.00 first line item.
                    transferred_cents: 3196,
                    // AgentCard sandbox (2026-09-28) also echoes a cumulative
                    // authorization-release counter on consumed rows.
                    released_cents: 3721,
                    card_id: 'card-text',
                    livemode: false,
                  },
                ],
              }),
            },
          ],
        }),
      });

      assert(result.orgTransfer?.id === 'transfer-text', 'expected the text-envelope transfer id');
      assert(result.orgTransfer?.transferredCents === 4396, 'expected the transferred amount');
      assert(
        result.orgTransfer?.releasedCents === 0,
        'consumed leftover echo is unused leftover 0'
      );
      assert(result.agentCard?.status === 'CLOSED', 'expected the closed card summary');
    },
  ],
  [
    'lifecycle rejects a transfer envelope missing a required integer field',
    async () => {
      let threw = false;
      try {
        await getTestPaymentLifecycle('agent-bad-int', {
          findPurchase: async () =>
            ({
              id: 'purchase-bad-int',
              userId: 'user-1',
              agentId: 'agent-bad-int',
              fingerprint: 'fp-bad-int',
              cardId: 'card-bad-int',
              merchant: 'Rose Labs Test Payment',
              lineItemsJson: [],
              totalCents: 4396,
              status: 'CLEARED',
              stripePaymentIntentId: null,
              provider: 'agentcard',
              createdAt: new Date(),
              updatedAt: new Date(),
              walletFunding: null,
            }) as never,
          findAttentionRequests: async () => [] as never,
          getCardSummary: async () => ({ status: 'CLOSED', balanceCents: 0 }),
          searchStripeHolds: async () => ({ data: [] }),
          getOrgCardholderId: async () => undefined,
          listOrgTransfers: async () => ({
            structuredContent: {
              transfers: [
                {
                  id: 'transfer-bad-int',
                  status: 'consumed',
                  transferred_cents: 4396,
                  released_cents: 0,
                  card_id: 'card-bad-int',
                },
              ],
            },
          }),
        });
      } catch (error) {
        threw = error instanceof Error && error.message.includes('amount_cents');
      }
      assert(threw, 'a transfer missing amount_cents must raise a lifecycle error');
    },
  ],
  [
    'lifecycle rejects a transfer envelope missing a required string field',
    async () => {
      let threw = false;
      try {
        await getTestPaymentLifecycle('agent-bad-str', {
          findPurchase: async () =>
            ({
              id: 'purchase-bad-str',
              userId: 'user-1',
              agentId: 'agent-bad-str',
              fingerprint: 'fp-bad-str',
              cardId: 'card-bad-str',
              merchant: 'Rose Labs Test Payment',
              lineItemsJson: [],
              totalCents: 4396,
              status: 'CLEARED',
              stripePaymentIntentId: null,
              provider: 'agentcard',
              createdAt: new Date(),
              updatedAt: new Date(),
              walletFunding: null,
            }) as never,
          findAttentionRequests: async () => [] as never,
          getCardSummary: async () => ({ status: 'CLOSED', balanceCents: 0 }),
          searchStripeHolds: async () => ({ data: [] }),
          getOrgCardholderId: async () => undefined,
          listOrgTransfers: async () => ({
            structuredContent: {
              transfers: [
                {
                  status: 'consumed',
                  amount_cents: 4396,
                  transferred_cents: 4396,
                  released_cents: 0,
                  card_id: 'card-bad-str',
                },
              ],
            },
          }),
        });
      } catch (error) {
        threw = error instanceof Error && error.message.includes('id');
      }
      assert(threw, 'a transfer missing its id must raise a lifecycle error');
    },
  ],
  [
    'phone benchmark tokenizes a non-sandbox card into a fresh Stripe payment method',
    async () => {
      await withStubbedStripe(async (calls) => {
        const result = await confirmPhoneBenchmarkPayment({
          cardNumber: '4111 1111 1111 1111',
          expiration: '11/29',
          cvc: '456',
          billingZip: '10001',
          cardholderName: 'Rose Labs',
        });
        assert(result.status === 'succeeded', 'expected the phone payment to succeed');
        assert(
          calls.paymentMethods.length === 1,
          'a non-sandbox card must be tokenized via Stripe PaymentMethods'
        );
        assert(calls.paymentIntents.length === 1, 'expected one Stripe PaymentIntent');
        assert(result.cardLastFour === '1111', 'expected the last four of the non-sandbox card');
      });
    },
  ],
  [
    'phone benchmark rejects a PaymentIntent that does not reach succeeded',
    async () => {
      let threw = false;
      await withStubbedStripe(
        async () => {
          try {
            await confirmPhoneBenchmarkPayment({
              cardNumber: '4242 4242 4242 4242',
              expiration: '12/30',
              cvc: '123',
              billingZip: '78731',
              cardholderName: 'Rose Labs',
            });
          } catch (error) {
            threw = error instanceof Error && error.message.includes('did not succeed');
          }
        },
        { paymentIntentStatus: 'requires_action' }
      );
      assert(threw, 'a non-succeeded PaymentIntent must raise a payment error');
    },
  ],
];

async function main(): Promise<void> {
  process.stdout.write(`Running test-payment black-box tests part 2 (${tests.length} tests)...\n`);
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
    `\nTest-payment black-box tests part 2: ${passed}/${results.length} passed\n`
  );
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exit(1);
});
