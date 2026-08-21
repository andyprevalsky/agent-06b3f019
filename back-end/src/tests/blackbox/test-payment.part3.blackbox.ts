#!/usr/bin/env tsx
/**
 * Black-box tests (part 3) for the dev-only test-payment fixture: settlement routing by purchase
 * FUNDING SOURCE.
 *
 * A purchase reaches settlement from one of two mint paths, and they differ in whether a personal
 * Stripe hold exists:
 *
 *   admin  → `issueAdminCompanyCard`  → card funded by the AgentCard org transfer, NO Stripe hold
 *   user   → `chargeAndIssueCard`     → Stripe hold authorized BEFORE the mint, always present
 *
 * Settlement therefore may not treat a null `stripePaymentIntentId` as uniformly corrupt. These
 * tests drive the REAL settlement provider through `confirmTestPayment` (only its data reads are
 * stubbed) so the routing decision itself is under test, and Stripe is stubbed so no live network is
 * touched.
 */

import 'dotenv/config';
import { confirmTestPayment } from '../../domains/test-payment/service';
import { settleAgentCardSandboxPayment } from '../../providers/agentcard/sandbox-settlement';
import { stripe } from '../../providers/stripe';
import { ADMIN_USER_IDS } from '../../utils/adminAccess';

const ADMIN_USER_ID = [...ADMIN_USER_IDS][0];
const ROSE_MINTED_PAN = '4242424242420640';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

const writeLine = (message = ''): void => {
  process.stdout.write(`${message}\n`);
};
const writeErrorLine = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

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

const CHECKOUT_ITEMS = [
  { id: 'aurora-notebook', quantity: 1 },
  { id: 'ceramic-mug', quantity: 1 },
  { id: 'canvas-tote', quantity: 1 },
];

const CHECKOUT_CARD = {
  name: 'Rose Labs',
  number: ROSE_MINTED_PAN,
  expiry: '06/28',
  cvv: '497',
  postalCode: '94105',
};

const tests: Array<[string, () => Promise<void>]> = [
  [
    'confirm settles a company-funded ADMIN purchase that has no Stripe hold',
    async () => {
      // REGRESSION (2026-07-28): admins mint through `issueAdminCompanyCard`, which funds the card
      // from the AgentCard org transfer and never authorizes a personal Stripe hold. Settlement used
      // to reject that null payment intent as a corrupt row, so EVERY admin checkout returned 502
      // forever — the four agent-payment-* benchmarks each burned their full 900s cap retrying
      // `POST /api/test-payment/confirm` (45/45 responses were 502).
      await withFakeStripe(async (calls) => {
        const charges: Array<Record<string, unknown>> = [];
        const cleared: string[] = [];
        const result = await confirmTestPayment(
          { items: CHECKOUT_ITEMS, card: CHECKOUT_CARD },
          {
            settleAgentCardSandboxPayment: async (input) =>
              settleAgentCardSandboxPayment(input, {
                findHeldPurchasesByTotal: async () => [
                  {
                    id: 'purchase-admin',
                    userId: ADMIN_USER_ID,
                    agentId: 'agent-admin',
                    cardId: 'card-admin',
                    stripePaymentIntentId: null,
                  },
                ],
                getCardPan: async () => ROSE_MINTED_PAN,
                claimHeldPurchaseForCharge: async () => true,
                testCharge: async (charge) => {
                  charges.push(charge);
                  return {};
                },
                markPurchaseCleared: async (purchaseId) => {
                  cleared.push(purchaseId);
                },
              }),
          }
        );

        assert(result.status === 'succeeded', 'admin company-funded checkout must succeed');
        assert(result.paymentIntentId === null, 'a company-funded purchase has no payment intent');
        assert(result.purchaseId === 'purchase-admin', 'expected the admin purchase to settle');
        assert(result.cardId === 'card-admin', 'expected the minted admin card id');
        assert(charges.length === 1, 'expected exactly one AgentCard charge');
        assert(charges[0]?.amountCents === 4396, 'expected the exact order total to be charged');
        assert(cleared[0] === 'purchase-admin', 'expected the purchase to be marked cleared');
        // The Rose card must never be double-charged through the raw-PAN Stripe fall-through.
        assert(calls.paymentMethods.length === 0, 'Rose PAN must not be raw-tokenized');
        assert(
          calls.paymentIntents.length === 0,
          'Rose PAN must not get a substitute Stripe charge'
        );
      });
    },
  ],
  [
    'confirm still rejects a NON-admin purchase whose Stripe hold is missing',
    async () => {
      // The 502 guard is load-bearing for ordinary users: their hold is authorized BEFORE the mint,
      // so a HELD purchase with a card but no payment intent is corrupt and must never be charged.
      await withFakeStripe(async () => {
        const charges: Array<Record<string, unknown>> = [];
        let failure: unknown;
        try {
          await confirmTestPayment(
            { items: CHECKOUT_ITEMS, card: CHECKOUT_CARD },
            {
              settleAgentCardSandboxPayment: async (input) =>
                settleAgentCardSandboxPayment(input, {
                  findHeldPurchasesByTotal: async () => [
                    {
                      id: 'purchase-corrupt',
                      userId: 'ordinary-user-1',
                      agentId: 'agent-corrupt',
                      cardId: 'card-corrupt',
                      stripePaymentIntentId: null,
                    },
                  ],
                  getCardPan: async () => ROSE_MINTED_PAN,
                  claimHeldPurchaseForCharge: async () => true,
                  testCharge: async (charge) => {
                    charges.push(charge);
                    return {};
                  },
                }),
            }
          );
        } catch (error) {
          failure = error;
        }
        assert(failure !== undefined, 'a missing hold on a user purchase must not settle');
        assert(
          (failure as { statusCode?: number }).statusCode === 502,
          `expected a 502 settlement fault, got ${JSON.stringify(failure)}`
        );
        assert(charges.length === 0, 'a missing Stripe hold must fail before charging');
      });
    },
  ],
];

async function main(): Promise<void> {
  writeLine('\nTest-payment settlement-routing black-box tests\n');
  const results: TestResult[] = [];
  for (const [name, fn] of tests) {
    const result = await runTest(name, fn);
    results.push(result);
    const status = result.passed ? 'PASS' : 'FAIL';
    writeLine(`${status} ${result.name} (${result.duration}ms)`);
    if (!result.passed) writeErrorLine(`     ${result.error}`);
  }
  const passed = results.filter((result) => result.passed).length;
  writeLine(`\nTest-payment part3 black-box tests: ${passed}/${results.length} passed`);
  if (passed !== results.length) process.exit(1);
}

void main();
