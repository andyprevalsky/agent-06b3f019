#!/usr/bin/env tsx
/**
 * Black-box tests for the real-merchant (hosted Stripe Checkout) path on /test_payment.
 *
 * This path exists because AgentCard refuses `test_charge` on live cards ("Live cards are charged
 * by real merchants") and Stripe blocks live-mode raw-PAN tokenization — so a LIVE Rose-minted card
 * can only be proven by an actual acquirer authorization. These tests pin the behaviour that makes
 * that settlement safe: it must never clear a purchase Stripe did not actually pay for, must match
 * the specific minted card, and must be idempotent against a re-delivered success_url.
 *
 * Stripe is stubbed, so no live network is touched and no money moves.
 */

import 'dotenv/config';
import { settleRoseCardStripeCheckout } from '../../providers/agentcard/checkout-settlement';

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

function heldPurchase(overrides: Record<string, unknown> = {}) {
  return {
    id: 'purchase-1',
    userId: 'user-1',
    agentId: 'agent-1',
    cardId: 'card-1',
    stripePaymentIntentId: 'pi_hold_1',
    ...overrides,
  };
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    'settles the HELD purchase whose minted card Stripe actually charged',
    async () => {
      const cleared: string[] = [];
      const result = await settleRoseCardStripeCheckout(
        { last4: '2679', amountCents: 100 },
        {
          findHeldPurchasesByTotal: async () => [heldPurchase()],
          getCardLast4: async () => '2679',
          claimHeldPurchaseForCharge: async () => true,
          markPurchaseCleared: async (id) => {
            cleared.push(id);
          },
        }
      );
      assert(result.purchaseId === 'purchase-1', 'settled the matching purchase');
      assert(result.stripePaymentIntentId === 'pi_hold_1', 'carried the Stripe hold through');
      assert(cleared.length === 1, 'cleared exactly once');
    },
  ],
  [
    'never clears a purchase whose card Stripe did NOT charge',
    async () => {
      let threw = false;
      const cleared: string[] = [];
      try {
        await settleRoseCardStripeCheckout(
          { last4: '9999', amountCents: 100 },
          {
            findHeldPurchasesByTotal: async () => [heldPurchase()],
            getCardLast4: async () => '2679',
            claimHeldPurchaseForCharge: async () => true,
            markPurchaseCleared: async (id) => {
              cleared.push(id);
            },
          }
        );
      } catch {
        threw = true;
      }
      assert(threw, 'a non-matching last4 must not settle');
      assert(cleared.length === 0, 'must never clear a purchase it did not match');
    },
  ],
  [
    'is idempotent when the claim is already taken (double success_url delivery)',
    async () => {
      let threw = false;
      const cleared: string[] = [];
      try {
        await settleRoseCardStripeCheckout(
          { last4: '2679', amountCents: 100 },
          {
            findHeldPurchasesByTotal: async () => [heldPurchase()],
            getCardLast4: async () => '2679',
            // A concurrent settle already flipped HELD -> CHARGING.
            claimHeldPurchaseForCharge: async () => false,
            markPurchaseCleared: async (id) => {
              cleared.push(id);
            },
          }
        );
      } catch {
        threw = true;
      }
      assert(threw, 'a lost claim yields no match rather than a second clear');
      assert(cleared.length === 0, 'must never double-clear the same purchase');
    },
  ],
  [
    'skips an unresolvable candidate instead of failing the whole settlement',
    async () => {
      const cleared: string[] = [];
      const result = await settleRoseCardStripeCheckout(
        { last4: '2679', amountCents: 100 },
        {
          findHeldPurchasesByTotal: async () => [
            heldPurchase({ id: 'stale', cardId: 'gone' }),
            heldPurchase(),
          ],
          getCardLast4: async (_userId, _agentId, cardId) => {
            if (cardId === 'gone') throw new Error('card no longer resolves');
            return '2679';
          },
          claimHeldPurchaseForCharge: async () => true,
          markPurchaseCleared: async (id) => {
            cleared.push(id);
          },
        }
      );
      assert(result.purchaseId === 'purchase-1', 'scanned past the stale candidate');
      assert(cleared[0] === 'purchase-1', 'cleared only the real match');
    },
  ],
  [
    'refuses to settle a purchase missing its Stripe hold',
    async () => {
      let threw = false;
      try {
        await settleRoseCardStripeCheckout(
          { last4: '2679', amountCents: 100 },
          {
            findHeldPurchasesByTotal: async () => [heldPurchase({ stripePaymentIntentId: null })],
            getCardLast4: async () => '2679',
            claimHeldPurchaseForCharge: async () => true,
            markPurchaseCleared: async () => undefined,
          }
        );
      } catch {
        threw = true;
      }
      assert(threw, 'a purchase with no hold must not clear');
    },
  ],
  [
    'rejects a malformed last4 from Stripe rather than guessing',
    async () => {
      let threw = false;
      try {
        await settleRoseCardStripeCheckout(
          { last4: '', amountCents: 100 },
          {
            findHeldPurchasesByTotal: async () => [heldPurchase()],
            getCardLast4: async () => '2679',
            claimHeldPurchaseForCharge: async () => true,
            markPurchaseCleared: async () => undefined,
          }
        );
      } catch {
        threw = true;
      }
      assert(threw, 'an empty last4 must fail closed');
    },
  ],
];

async function main(): Promise<void> {
  process.stdout.write(
    `Running test-payment checkout black-box tests (${tests.length} tests)...\n`
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
    `\nTest-payment checkout black-box tests: ${passed}/${results.length} passed\n`
  );
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exit(1);
});
