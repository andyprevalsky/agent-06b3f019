#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  AgentCardSandboxSettlementError,
  settleAgentCardSandboxPayment,
} from '../../providers/agentcard/sandbox-settlement';

async function main(): Promise<void> {
  const charges: Array<Record<string, unknown>> = [];
  const claims: string[] = [];
  const cleared: string[] = [];
  const result = await settleAgentCardSandboxPayment(
    {
      cardNumber: '4242424242420640',
      amountCents: 4396,
      merchant: 'Rose Labs Test Payment',
    },
    {
      findHeldPurchasesByTotal: async () => [
        {
          id: 'wrong-purchase',
          userId: 'user-1',
          cardId: 'wrong-card',
          stripePaymentIntentId: 'pi_wrong',
        },
        {
          id: 'purchase-1',
          userId: 'user-1',
          cardId: 'card-1',
          stripePaymentIntentId: 'pi_hold_1',
        },
      ],
      getCardPan: async (_userId, cardId) =>
        cardId === 'card-1' ? '4242 4242 4242 0640' : '4242 4242 4242 9999',
      claimHeldPurchaseForCharge: async (purchaseId) => {
        claims.push(purchaseId);
        return true;
      },
      testCharge: async (input) => {
        charges.push(input);
        return {};
      },
      markPurchaseCleared: async (purchaseId) => {
        cleared.push(purchaseId);
      },
    }
  );

  assert.deepEqual(result, {
    purchaseId: 'purchase-1',
    cardId: 'card-1',
    stripePaymentIntentId: 'pi_hold_1',
  });
  // The non-matching candidate is never claimed nor charged.
  assert.deepEqual(claims, ['purchase-1']);
  assert.deepEqual(charges, [
    {
      cardId: 'card-1',
      amountCents: 4396,
      merchant: 'Rose Labs Test Payment',
    },
  ]);
  assert.deepEqual(cleared, ['purchase-1']);

  // A purchase that loses the atomic claim (already reserved by a concurrent settlement) is skipped
  // and never charged.
  const skippedCharges: Array<Record<string, unknown>> = [];
  await assert.rejects(
    () =>
      settleAgentCardSandboxPayment(
        {
          cardNumber: '4242424242420640',
          amountCents: 4396,
          merchant: 'Rose Labs Test Payment',
        },
        {
          findHeldPurchasesByTotal: async () => [
            {
              id: 'purchase-race',
              userId: 'user-1',
              cardId: 'card-race',
              stripePaymentIntentId: 'pi_hold_race',
            },
          ],
          getCardPan: async () => '4242424242420640',
          claimHeldPurchaseForCharge: async () => false,
          testCharge: async (input) => {
            skippedCharges.push(input);
            return {};
          },
        }
      ),
    (error: unknown) => error instanceof AgentCardSandboxSettlementError && error.statusCode === 404
  );
  assert.deepEqual(skippedCharges, [], 'a lost claim must not issue a charge');

  // A matched purchase without a Stripe hold fails before any charge is issued.
  const noHoldCharges: Array<Record<string, unknown>> = [];
  await assert.rejects(
    () =>
      settleAgentCardSandboxPayment(
        {
          cardNumber: '4242424242420640',
          amountCents: 4396,
          merchant: 'Rose Labs Test Payment',
        },
        {
          findHeldPurchasesByTotal: async () => [
            {
              id: 'purchase-no-hold',
              userId: 'user-1',
              cardId: 'card-no-hold',
              stripePaymentIntentId: null,
            },
          ],
          getCardPan: async () => '4242424242420640',
          claimHeldPurchaseForCharge: async () => true,
          testCharge: async (input) => {
            noHoldCharges.push(input);
            return {};
          },
        }
      ),
    (error: unknown) => error instanceof AgentCardSandboxSettlementError && error.statusCode === 502
  );
  assert.deepEqual(noHoldCharges, [], 'a missing Stripe hold must fail before charging');

  await assert.rejects(
    () =>
      settleAgentCardSandboxPayment(
        {
          cardNumber: '4242424242420640',
          amountCents: 4396,
          merchant: 'Rose Labs Test Payment',
        },
        {
          findHeldPurchasesByTotal: async () => [],
        }
      ),
    (error: unknown) => error instanceof AgentCardSandboxSettlementError && error.statusCode === 404
  );

  await assert.rejects(
    () =>
      settleAgentCardSandboxPayment(
        {
          cardNumber: '4242424242420640',
          amountCents: 4396,
          merchant: 'Rose Labs Test Payment',
        },
        {
          findHeldPurchasesByTotal: async () => [
            {
              id: 'purchase-2',
              userId: 'user-1',
              cardId: 'card-2',
              stripePaymentIntentId: 'pi_hold_2',
            },
          ],
          getCardPan: async () => '4242424242420640',
          claimHeldPurchaseForCharge: async () => true,
          // Injected so the release path stays in-memory; without it this unit
          // test reaches the real Prisma client.
          releaseHeldPurchaseClaim: async () => {},
          testCharge: async () => ({ isError: true, message: 'declined' }),
        }
      ),
    (error: unknown) =>
      error instanceof AgentCardSandboxSettlementError &&
      error.statusCode === 402 &&
      error.message.includes('declined')
  );

  // Regression: a failed charge must RELEASE the claim so a retry can settle.
  //
  // `claimHeldPurchaseForCharge` latches HELD -> CHARGING. Before the fix,
  // nothing put it back when the charge threw, so the purchase was stranded:
  // every retry selects on `status: HELD`, finds nothing, and 404s forever
  // while the wallet transfer stays FUNDED and the issued card goes unspent.
  // Seen live in agent-payment-setup-resume — one 500 then six consecutive
  // "No matching held AgentCard purchase was found" 404s until the 900s cap.
  {
    const released: string[] = [];
    let held = true;

    const deps = () => ({
      // Mirrors the real query: it only returns purchases still in HELD.
      findHeldPurchasesByTotal: async () =>
        held
          ? [
              {
                id: 'purchase-retry',
                userId: 'user-1',
                cardId: 'card-retry',
                stripePaymentIntentId: 'pi_hold_retry',
              },
            ]
          : [],
      getCardPan: async () => '4242424242420640',
      claimHeldPurchaseForCharge: async () => {
        held = false;
        return true;
      },
      releaseHeldPurchaseClaim: async (purchaseId: string) => {
        released.push(purchaseId);
        held = true;
      },
      markPurchaseCleared: async () => {},
    });

    // First attempt: the charge throws (the observed 500).
    await assert.rejects(
      settleAgentCardSandboxPayment(
        { cardNumber: '4242424242420640', amountCents: 4396, merchant: 'Rose Labs Test Payment' },
        {
          ...deps(),
          testCharge: async () => {
            throw new Error('sandbox charge exploded');
          },
        }
      )
    );
    assert.deepEqual(released, ['purchase-retry'], 'failed charge must release the claim');

    // Second attempt on the same purchase must now find and settle it.
    const retry = await settleAgentCardSandboxPayment(
      { cardNumber: '4242424242420640', amountCents: 4396, merchant: 'Rose Labs Test Payment' },
      { ...deps(), testCharge: async () => ({ isError: false }) }
    );
    assert.equal(retry.purchaseId, 'purchase-retry', 'retry after a failed charge must settle');
  }

  // A declined charge (402) must release the claim too — it is equally retryable.
  {
    const released: string[] = [];
    await assert.rejects(
      settleAgentCardSandboxPayment(
        { cardNumber: '4242424242420640', amountCents: 4396, merchant: 'Rose Labs Test Payment' },
        {
          findHeldPurchasesByTotal: async () => [
            {
              id: 'purchase-declined',
              userId: 'user-1',
              cardId: 'card-declined',
              stripePaymentIntentId: 'pi_hold_declined',
            },
          ],
          getCardPan: async () => '4242424242420640',
          claimHeldPurchaseForCharge: async () => true,
          releaseHeldPurchaseClaim: async (purchaseId: string) => {
            released.push(purchaseId);
          },
          testCharge: async () => ({ isError: true, message: 'declined' }),
        }
      ),
      (error: unknown) =>
        error instanceof AgentCardSandboxSettlementError && error.statusCode === 402
    );
    assert.deepEqual(released, ['purchase-declined'], 'declined charge must release the claim');
  }

  process.stdout.write('AgentCard sandbox settlement tests passed\n');
}

void main();
