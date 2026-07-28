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
          agentId: null,
          cardId: 'wrong-card',
          stripePaymentIntentId: 'pi_wrong',
        },
        {
          id: 'purchase-1',
          userId: 'user-1',
          agentId: null,
          cardId: 'card-1',
          stripePaymentIntentId: 'pi_hold_1',
        },
      ],
      getCardPan: async (_userId, _agentId, cardId) =>
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
              agentId: null,
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
              agentId: null,
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
              agentId: null,
              cardId: 'card-2',
              stripePaymentIntentId: 'pi_hold_2',
            },
          ],
          getCardPan: async () => '4242424242420640',
          claimHeldPurchaseForCharge: async () => true,
          testCharge: async () => ({ isError: true, message: 'declined' }),
        }
      ),
    (error: unknown) =>
      error instanceof AgentCardSandboxSettlementError &&
      error.statusCode === 402 &&
      error.message.includes('declined')
  );

  process.stdout.write('AgentCard sandbox settlement tests passed\n');
}

void main();
