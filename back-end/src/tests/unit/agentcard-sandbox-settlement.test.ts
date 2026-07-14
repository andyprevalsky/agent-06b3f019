#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  AgentCardSandboxSettlementError,
  settleAgentCardSandboxPayment,
} from '../../providers/agentcard/sandbox-settlement';

async function main(): Promise<void> {
  const charges: Array<Record<string, unknown>> = [];
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
  assert.deepEqual(charges, [
    {
      cardId: 'card-1',
      amountCents: 4396,
      merchant: 'Rose Labs Test Payment',
    },
  ]);
  assert.deepEqual(cleared, ['purchase-1']);

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
