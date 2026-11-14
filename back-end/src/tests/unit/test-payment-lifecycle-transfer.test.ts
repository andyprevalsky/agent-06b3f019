#!/usr/bin/env tsx
/**
 * Lifecycle org-transfer mapping: when AgentCard leaves transferred_cents at 0
 * on consumed/reclaimed mint rows, amount_cents is the funded amount.
 */
import assert from 'node:assert/strict';
import { assertV2LifecycleContract } from '../blackbox/test-payment-v2-lifecycle.cases';
import { PurchaseSpendStatus } from '@prisma/client';
import { TestPaymentError } from '../../domains/test-payment/errors';
import { getTestPaymentLifecycle } from '../../domains/test-payment/lifecycle';
import { mapOrgTransfer } from '../../domains/test-payment/lifecycleOrgTransfer';

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  ${name}: `);
  await fn();
  process.stdout.write('ok\n');
}

async function main(): Promise<void> {
  await assertV2LifecycleContract();
  process.stdout.write('test-payment-lifecycle-transfer\n');
  await test('derives transferredCents from amount when provider leaves it at 0', async () => {
    const createdAt = new Date();
    const cardId = 'card-zero-transferred';
    const lifecycle = await getTestPaymentLifecycle('agent-zero-transferred', {
      findPurchase: async () => ({
        id: 'p-zero',
        userId: 'u-zero',
        status: PurchaseSpendStatus.CLEARED,
        merchant: 'Rose Labs Test Payment',
        totalCents: 4396,
        cardId,
        stripePaymentIntentId: 'pi_zero',
        createdAt,
        walletFunding: {
          status: 'CONSUMED',
          amountCents: 4396,
          providerTransferId: 'owt_zero',
          reclaimProviderTransferId: null,
        },
      }),
      findPurchaseLifecycleIntegrity: async () => ({
        purchaseCount: 1,
        walletFundingCount: 1,
        stripePaymentIntentCount: 1,
        cardCount: 1,
      }),
      findAttentionRequests: async () => [],
      getCardSummary: async () => {
        throw new Error(
          'get_card_details failed: card_closed: This card is closed and its credentials are no longer available.'
        );
      },
      retrieveStripeHold: async () => ({
        livemode: false,
        id: 'pi_zero',
        status: 'succeeded',
        amount: 4396,
        amount_capturable: 0,
        amount_received: 4396,
      }),
      listStripeRefunds: async () => ({ data: [] }),
      getOrgCardholderId: async () => 'cardholder-zero',
      searchStripeHolds: async () => ({ data: [{ id: 'pi_zero' }] }),
      listOrgCards: async () => ({
        structuredContent: {
          cards: [
            {
              id: cardId,
              cardholderId: 'cardholder-zero',
              spendLimitCents: 4396,
              createdAt: createdAt.toISOString(),
            },
          ],
        },
      }),
      listOrgTransfers: async () => ({
        structuredContent: {
          transfers: [
            {
              id: 'owt_zero',
              status: 'consumed',
              amount_cents: 4396,
              transferred_cents: 0,
              released_cents: 0,
              card_id: cardId,
              cardholder_id: 'cardholder-zero',
              created_at: createdAt.toISOString(),
              livemode: false,
            },
          ],
        },
      }),
    });
    assert.equal(lifecycle.orgTransfer?.amountCents, 4396);
    assert.equal(lifecycle.orgTransfer?.transferredCents, 4396);
    assert.equal(lifecycle.orgTransfer?.releasedCents, 0);
  });

  await test('mapOrgTransfer zeroes transferredCents for live reclaimed transfers', async () => {
    const mapped = mapOrgTransfer({ cardId: 'card-reclaimed' }, [
      {
        structuredContent: {
          transfers: [
            {
              id: 'owt-reclaimed',
              status: 'reclaimed',
              amount_cents: 100,
              transferred_cents: 100,
              released_cents: 100,
              card_id: 'card-reclaimed',
              livemode: true,
            },
          ],
        },
      },
    ]);
    assert.equal(mapped?.status, 'reclaimed');
    assert.equal(mapped?.amountCents, 100);
    assert.equal(mapped?.transferredCents, 0);
    assert.equal(mapped?.releasedCents, 100);
  });

  await test('mapOrgTransfer derives sandbox reclaimed transferredCents from amount when provider leaves it at 0', async () => {
    const mapped = mapOrgTransfer({ cardId: 'card-sandbox-reclaimed' }, [
      {
        structuredContent: {
          transfers: [
            {
              id: 'owt-sandbox-reclaimed',
              status: 'reclaimed',
              amount_cents: 4396,
              transferred_cents: 0,
              released_cents: 4396,
              card_id: 'card-sandbox-reclaimed',
              livemode: false,
            },
          ],
        },
      },
    ]);
    assert.equal(mapped?.status, 'reclaimed');
    assert.equal(mapped?.amountCents, 4396);
    assert.equal(mapped?.transferredCents, 4396);
    assert.equal(mapped?.releasedCents, 4396);
    assert.equal(mapped?.livemode, false);
  });

  await test('mapOrgTransfer returns null when purchase has no card', async () => {
    const mapped = mapOrgTransfer({ cardId: null }, [
      {
        structuredContent: {
          transfers: [
            {
              id: 'owt-unlinked',
              status: 'released',
              amount_cents: 100,
              transferred_cents: 100,
              released_cents: 100,
              card_id: null,
              livemode: false,
            },
          ],
        },
      },
    ]);
    assert.equal(mapped, null);
  });

  await test('mapOrgTransfer zeroes releasedCents on consumed transfers with leftover echo', async () => {
    const mapped = mapOrgTransfer({ cardId: 'card-consumed-echo' }, [
      {
        structuredContent: {
          transfers: [
            {
              id: 'owt-consumed-echo',
              status: 'consumed',
              amount_cents: 4396,
              transferred_cents: 4396,
              released_cents: 3721,
              card_id: 'card-consumed-echo',
              livemode: false,
            },
          ],
        },
      },
    ]);
    assert.equal(mapped?.status, 'consumed');
    assert.equal(mapped?.amountCents, 4396);
    assert.equal(mapped?.transferredCents, 4396);
    assert.equal(mapped?.releasedCents, 0);
  });

  await test('mapOrgTransfer ignores non-integer released_cents when sorting', async () => {
    const mapped = mapOrgTransfer({ cardId: 'card-1' }, [
      {
        structuredContent: {
          transfers: [
            {
              id: 'owt-bad',
              status: 'released',
              amount_cents: 50,
              transferred_cents: 50,
              released_cents: 0.5,
              card_id: 'card-1',
              livemode: false,
            },
            {
              id: 'owt-good',
              status: 'released',
              amount_cents: 75,
              transferred_cents: 75,
              released_cents: 10,
              card_id: 'card-1',
              livemode: false,
            },
          ],
        },
      },
    ]);
    assert.equal(mapped?.id, 'owt-good');
    assert.equal(mapped?.releasedCents, 10);
  });

  await test('missing transfers error carries the provider message', async () => {
    assert.throws(
      () =>
        mapOrgTransfer({ cardId: 'card-1' }, [
          {
            structuredContent: {
              status: 'error',
              message: 'API key rate limit exceeded',
            },
          },
        ]),
      (error: unknown) =>
        error instanceof TestPaymentError &&
        error.statusCode === 502 &&
        error.message ===
          'AgentCard lifecycle response missing transfers: API key rate limit exceeded'
    );
    assert.throws(
      () => mapOrgTransfer({ cardId: 'card-1' }, [{ structuredContent: {} }]),
      (error: unknown) =>
        error instanceof TestPaymentError &&
        error.message === 'AgentCard lifecycle response missing transfers'
    );
  });
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
