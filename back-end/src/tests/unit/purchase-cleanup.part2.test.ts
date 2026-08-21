#!/usr/bin/env tsx
/**
 * Unit tests for purchase-card cleanup + reconciliation backstops — part 2.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import {
  cleanupAgentPurchaseCards,
  reconcileAbandonedPurchaseFunding,
  reconcileDissolvedPurchaseHolds,
  reconcileFailedPurchaseRefunds,
  reconcileStaleChargingPurchases,
  reconcileTerminalAgentPurchaseCards,
} from '../../providers/purchaseCleanup';
import { WalletFundingProviderError } from '../../providers/wallet-funding';
import { AgentCardProviderError } from '../../providers/card-provider/errors';
import {
  capturedPaymentIntent,
  FailingDetailsCardProvider,
  FakeWalletFundingProvider,
  StubCardStateProvider,
  withFakeStripe,
} from '../blackbox/purchases.testkit';
import { ReclaimErrorWalletProvider } from './purchase-cleanup.testkit';
import {
  cleanupUsers,
  failures,
  passed,
  reconcileFailed,
  seedAgent,
  seedFunding,
  seedHeld,
  seedStaleCharging,
  seedUser,
  statusOf,
  test,
} from './purchase-cleanup.fixtures';

async function main(): Promise<void> {
  process.stdout.write('Running purchase cleanup unit tests (part 2)...\n');
  await test('reconcileTerminalAgentPurchaseCards cleans up a terminal agent', async () => {
    const userId = await seedUser();
    const agentId = await seedAgent(userId, 'COMPLETED');
    const purchaseId = await seedHeld(userId, { agentId });
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.FUNDED);
    const wallet = new FakeWalletFundingProvider();
    await withFakeStripe(async () => {
      await reconcileTerminalAgentPurchaseCards(
        new StubCardStateProvider({ status: 'OPEN', balanceCents: 1080 }),
        wallet,
        { userId }
      );
    });
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.VOIDED);
  });

  await test('cleanup records REFUND_FAILED when the refund throws', async () => {
    const userId = await seedUser();
    const agentId = await seedAgent(userId, 'COMPLETED');
    const purchaseId = await seedHeld(userId, { agentId });
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.FUNDED);
    await withFakeStripe(
      async () => {
        await cleanupAgentPurchaseCards(
          agentId,
          new StubCardStateProvider({ status: 'OPEN', balanceCents: 1080 }),
          new FakeWalletFundingProvider()
        );
      },
      {
        refundError: new Error('stripe refund unavailable'),
        retrievePaymentIntent: capturedPaymentIntent,
      }
    );
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.REFUND_FAILED);
  });

  await test('fresh reclaim ownership suppresses duplicate close until stale reconciliation', async () => {
    const userId = await seedUser();
    const agentId = await seedAgent(userId, 'COMPLETED');
    const purchaseId = await seedHeld(userId, { agentId });
    // Funding already RECLAIMING: the card reads CLOSED because Rose closed it, not because a
    // merchant settled it. A concurrent cleanup must leave the active release owner alone.
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.RECLAIMING);
    const wallet = new FakeWalletFundingProvider();
    await withFakeStripe(
      async (calls) => {
        await cleanupAgentPurchaseCards(
          agentId,
          new StubCardStateProvider({ status: 'CLOSED', balanceCents: 0 }),
          wallet
        );
        assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.HELD);
        assert.equal(wallet.reclaimCalls.length, 0);
        assert.equal(calls.refunds.length, 0);
        await reconcileFailed(wallet, userId);
        assert.equal(wallet.reclaimCalls.length, 0, 'minute cron must skip a fresh reclaim owner');

        await prisma.purchaseWalletFunding.update({
          where: { purchaseId },
          data: { updatedAt: new Date(Date.now() - 3 * 60 * 1000) },
        });
        await reconcileFailed(wallet, userId);
        assert.equal(calls.refunds.length, 1);
      },
      { retrievePaymentIntent: capturedPaymentIntent }
    );
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.VOIDED);
    assert.equal(wallet.reclaimCalls.length, 1);
  });

  await test('reconcileFailedPurchaseRefunds leaves the row on a retry failure', async () => {
    const userId = await seedUser();
    const purchaseId = await seedHeld(userId, { status: PurchaseSpendStatus.REFUND_FAILED });
    await withFakeStripe(async () => await reconcileFailedPurchaseRefunds({ userId }), {
      refundError: new Error('still failing'),
      retrievePaymentIntent: capturedPaymentIntent,
    });
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.REFUND_FAILED);
  });

  await test('reconcileFailedPurchaseFundingReclaims clears on consumed-during-reclaim', async () => {
    const userId = await seedUser();
    const purchaseId = await seedHeld(userId, {
      status: PurchaseSpendStatus.FUNDING_RECLAIM_FAILED,
    });
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.FUNDED);
    const wallet = new ReclaimErrorWalletProvider(
      new WalletFundingProviderError(
        'consumed',
        409,
        'agentcard_company_transfer_consumed_during_reclaim'
      )
    );
    await withFakeStripe(async () => {
      await reconcileFailed(wallet, userId);
    });
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.CLEARED);
  });

  await test('reconcileFailedPurchaseFundingReclaims leaves the row on a generic error', async () => {
    const userId = await seedUser();
    const purchaseId = await seedHeld(userId, {
      status: PurchaseSpendStatus.FUNDING_RECLAIM_FAILED,
    });
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.FUNDED);
    const wallet = new ReclaimErrorWalletProvider(new Error('mcp down'));
    await withFakeStripe(async () => {
      await reconcileFailed(wallet, userId);
    });
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.FUNDING_RECLAIM_FAILED);
  });

  await test('reconcileDissolvedPurchaseHolds skips when the hold cannot be retrieved', async () => {
    const userId = await seedUser();
    const purchaseId = await seedHeld(userId);
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.FUNDED);
    await withFakeStripe(
      async () => {
        await reconcileDissolvedPurchaseHolds(
          new StubCardStateProvider({ status: 'OPEN', balanceCents: 1080 }),
          new FakeWalletFundingProvider(),
          { userId }
        );
      },
      {
        retrievePaymentIntent: () => {
          throw new Error('stripe retrieve failed');
        },
      }
    );
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.HELD);
  });

  await test('reconcileDissolvedPurchaseHolds skips when the card cannot be read', async () => {
    const userId = await seedUser();
    const purchaseId = await seedHeld(userId);
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.FUNDED);
    await withFakeStripe(
      async () => {
        await reconcileDissolvedPurchaseHolds(
          new FailingDetailsCardProvider(),
          new FakeWalletFundingProvider(),
          { userId }
        );
      },
      { retrievePaymentIntent: () => ({ id: 'pi', status: 'canceled', amount_capturable: 0 }) }
    );
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.HELD);
  });

  await test('reconcileDissolvedPurchaseHolds records CAPTURE_FAILED when the card was spent', async () => {
    const userId = await seedUser();
    const purchaseId = await seedHeld(userId);
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.FUNDED);
    await withFakeStripe(
      async () => {
        await reconcileDissolvedPurchaseHolds(
          new StubCardStateProvider({ status: 'CLOSED', balanceCents: 0 }),
          new FakeWalletFundingProvider(),
          { userId }
        );
      },
      // status is neither capturable nor succeeded and nothing is capturable => dissolved.
      {
        retrievePaymentIntent: () => ({
          id: 'pi',
          status: 'requires_payment_method',
          amount_capturable: 0,
        }),
      }
    );
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.CAPTURE_FAILED);
  });

  await test('reconcileDissolvedPurchaseHolds records FUNDING_RECLAIM_FAILED on a reclaim error', async () => {
    const userId = await seedUser();
    const purchaseId = await seedHeld(userId);
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.FUNDED);
    const wallet = new ReclaimErrorWalletProvider(new Error('mcp down'));
    await withFakeStripe(
      async () => {
        await reconcileDissolvedPurchaseHolds(
          new StubCardStateProvider({ status: 'OPEN', balanceCents: 1080 }),
          wallet,
          { userId }
        );
      },
      { retrievePaymentIntent: () => ({ id: 'pi', status: 'canceled', amount_capturable: 0 }) }
    );
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.FUNDING_RECLAIM_FAILED);
  });

  await test('reconcileStaleChargingPurchases records CAPTURE_FAILED on consumed-during-reclaim', async () => {
    const userId = await seedUser();
    const row = await seedStaleCharging(userId);
    await seedFunding(row.id, userId, PurchaseWalletFundingStatus.FUNDED);
    const wallet = new ReclaimErrorWalletProvider(
      new WalletFundingProviderError(
        'consumed',
        409,
        'agentcard_company_transfer_consumed_during_reclaim'
      )
    );
    await withFakeStripe(async () => {
      await reconcileStaleChargingPurchases(wallet, { userId });
      await reconcileAbandonedPurchaseFunding(
        new StubCardStateProvider({ status: 'CLOSED', balanceCents: 0 }),
        wallet,
        { userId }
      );
    });
    assert.equal(await statusOf(row.id), PurchaseSpendStatus.CAPTURE_FAILED);
  });

  await test('stale issued-card compensation remains abandoned on a reclaim error', async () => {
    const userId = await seedUser();
    const row = await seedStaleCharging(userId);
    await seedFunding(row.id, userId, PurchaseWalletFundingStatus.FUNDED);
    const wallet = new ReclaimErrorWalletProvider(new Error('mcp down'));
    await withFakeStripe(async () => {
      await reconcileStaleChargingPurchases(wallet, { userId });
      await reconcileAbandonedPurchaseFunding(
        new StubCardStateProvider({ status: 'OPEN', balanceCents: 1080 }),
        wallet,
        { userId }
      );
    });
    assert.equal(await statusOf(row.id), PurchaseSpendStatus.FUNDING_ABANDONED);
  });

  await test('abandoned compensation fail-closes poisoned card_creation_failed mint keys', async () => {
    const userId = await seedUser();
    const row = await prisma.purchaseSpend.create({
      data: {
        userId,
        fingerprint: `fp-${randomUUID()}`,
        merchant: 'Poisoned Idempotency Merchant',
        lineItemsJson: { totalCents: 100 },
        totalCents: 100,
        status: PurchaseSpendStatus.FUNDING_ABANDONED,
        cardId: null,
        stripePaymentIntentId: `pi_${randomUUID()}`,
      },
    });
    await seedFunding(row.id, userId, PurchaseWalletFundingStatus.PENDING);
    const poisonedMintProvider = {
      async mintCard(): Promise<never> {
        throw new AgentCardProviderError(
          'create_card failed: card_creation_failed',
          409,
          undefined,
          'agentcard_card_creation_failed',
          { agentcardStatus: 'card_creation_failed' }
        );
      },
      async getDetails(): Promise<never> {
        throw new Error('details must not run when create_card failed');
      },
      async closeCard(): Promise<void> {
        throw new Error('close must not run when no card was issued');
      },
    };
    await withFakeStripe(async (calls) => {
      await reconcileAbandonedPurchaseFunding(
        poisonedMintProvider,
        new FakeWalletFundingProvider(),
        {
          userId,
        }
      );
      assert.equal(calls.cancels.length, 1, 'poisoned mint must release the Stripe hold');
    });
    assert.equal(await statusOf(row.id), PurchaseSpendStatus.FAILED);
    const funding = await prisma.purchaseWalletFunding.findUnique({
      where: { purchaseId: row.id },
    });
    assert.equal(funding, null, 'pending wallet marker must be discarded');
  });

  await test('reconcileStaleChargingPurchases preserves a pre-card funding attempt', async () => {
    const userId = await seedUser();
    const row = await prisma.purchaseSpend.create({
      data: {
        userId,
        fingerprint: `fp-${randomUUID()}`,
        merchant: 'Stale Merchant',
        lineItemsJson: { totalCents: 1080 },
        totalCents: 1080,
        status: PurchaseSpendStatus.CHARGING,
        stripePaymentIntentId: `pi_${randomUUID()}`,
        updatedAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    await seedFunding(row.id, userId, PurchaseWalletFundingStatus.PENDING);
    const wallet = new FakeWalletFundingProvider();
    await withFakeStripe(async (calls) => {
      await reconcileStaleChargingPurchases(wallet, { userId });
      assert.equal(calls.cancels.length, 0);
    });
    assert.equal(wallet.reclaimCalls.length, 0);
    assert.equal(await statusOf(row.id), PurchaseSpendStatus.FUNDING_PENDING);
  });

  process.stdout.write(
    `\nPurchase cleanup unit tests: ${passed} passed, ${failures.length} failed\n`
  );
  for (const failure of failures) process.stdout.write(`  ${failure}\n`);
}

main()
  .then(async () => {
    await cleanupUsers();
    if (failures.length > 0) process.exit(1);
  })
  .catch(async (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    await cleanupUsers();
    process.exit(1);
  });
