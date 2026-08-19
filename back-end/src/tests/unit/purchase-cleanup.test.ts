#!/usr/bin/env tsx
/**
 * Unit tests for purchase-card cleanup + reconciliation backstops — part 1.
 */
import assert from 'node:assert/strict';
import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import {
  cleanupAgentPurchaseCards,
  reconcileAbandonedPurchaseFunding,
  reconcileDissolvedPurchaseHolds,
  reconcileFailedPurchaseRefunds,
  reconcileStaleChargingPurchases,
} from '../../providers/purchaseCleanup';
import { WalletFundingProviderError } from '../../providers/wallet-funding';
import {
  capturedPaymentIntent,
  FailingDetailsCardProvider,
  FakeWalletFundingProvider,
  StubCardStateProvider,
  withFakeStripe,
} from '../blackbox/purchases.testkit';
import {
  ConcurrentlyVoidedWalletProvider,
  ReclaimErrorWalletProvider,
} from './purchase-cleanup.testkit';
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
  process.stdout.write('Running purchase cleanup unit tests (part 1)...\n');

  await test('cleanup clears a settled (spent) held card', async () => {
    const userId = await seedUser();
    const agentId = await seedAgent(userId, 'COMPLETED');
    const purchaseId = await seedHeld(userId, { agentId });
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.FUNDED);
    await withFakeStripe(async () => {
      await cleanupAgentPurchaseCards(
        agentId,
        new StubCardStateProvider({ status: 'CLOSED', balanceCents: 0 }),
        new FakeWalletFundingProvider()
      );
    });
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.CLEARED);
    const funding = await prisma.purchaseWalletFunding.findUnique({ where: { purchaseId } });
    assert.equal(funding?.status, PurchaseWalletFundingStatus.CONSUMED);
  });

  await test('cleanup voids an unspent held card and refunds the charge', async () => {
    const userId = await seedUser();
    const agentId = await seedAgent(userId, 'COMPLETED');
    const purchaseId = await seedHeld(userId, { agentId });
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.FUNDED);
    const wallet = new FakeWalletFundingProvider();
    await withFakeStripe(
      async (calls) => {
        await cleanupAgentPurchaseCards(
          agentId,
          new StubCardStateProvider({ status: 'OPEN', balanceCents: 1080 }),
          wallet
        );
        assert.equal(calls.refunds.length, 1, 'unspent cleanup must refund the captured charge');
      },
      { retrievePaymentIntent: capturedPaymentIntent }
    );
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.VOIDED);
    assert.equal(wallet.reclaimCalls.length, 1);
    const funding = await prisma.purchaseWalletFunding.findUnique({ where: { purchaseId } });
    assert.equal(funding?.status, PurchaseWalletFundingStatus.RECLAIMED);
  });

  await test('cleanup clears when the transfer was consumed during reclaim', async () => {
    const userId = await seedUser();
    const agentId = await seedAgent(userId, 'COMPLETED');
    const purchaseId = await seedHeld(userId, { agentId });
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.FUNDED);
    const wallet = new ReclaimErrorWalletProvider(
      new WalletFundingProviderError(
        'consumed',
        409,
        'agentcard_company_transfer_consumed_during_reclaim'
      )
    );
    await withFakeStripe(async () => {
      await cleanupAgentPurchaseCards(
        agentId,
        new StubCardStateProvider({ status: 'OPEN', balanceCents: 1080 }),
        wallet
      );
    });
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.CLEARED);
  });

  await test('cleanup never overwrites a concurrently voided purchase as cleared', async () => {
    const userId = await seedUser();
    const agentId = await seedAgent(userId, 'COMPLETED');
    const purchaseId = await seedHeld(userId, { agentId });
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.FUNDED);
    await withFakeStripe(async () => {
      await cleanupAgentPurchaseCards(
        agentId,
        new StubCardStateProvider({ status: 'OPEN', balanceCents: 1080 }),
        new ConcurrentlyVoidedWalletProvider()
      );
    });
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.VOIDED);
  });

  await test('cleanup leaves the purchase HELD when release is pending', async () => {
    const userId = await seedUser();
    const agentId = await seedAgent(userId, 'COMPLETED');
    const purchaseId = await seedHeld(userId, { agentId });
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.FUNDED);
    const wallet = new ReclaimErrorWalletProvider(
      new WalletFundingProviderError('pending', 409, 'agentcard_company_transfer_release_pending')
    );
    await withFakeStripe(async () => {
      await cleanupAgentPurchaseCards(
        agentId,
        new StubCardStateProvider({ status: 'OPEN', balanceCents: 1080 }),
        wallet
      );
    });
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.HELD);
  });

  await test('cleanup records FUNDING_RECLAIM_FAILED on a generic reclaim error', async () => {
    const userId = await seedUser();
    const agentId = await seedAgent(userId, 'COMPLETED');
    const purchaseId = await seedHeld(userId, { agentId });
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.FUNDED);
    const wallet = new ReclaimErrorWalletProvider(new Error('mcp down'));
    await withFakeStripe(async () => {
      await cleanupAgentPurchaseCards(
        agentId,
        new StubCardStateProvider({ status: 'OPEN', balanceCents: 1080 }),
        wallet
      );
    });
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.FUNDING_RECLAIM_FAILED);
  });

  await test('cleanup leaves the hold when the card cannot be read', async () => {
    const userId = await seedUser();
    const agentId = await seedAgent(userId, 'COMPLETED');
    const purchaseId = await seedHeld(userId, { agentId });
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.FUNDED);
    await withFakeStripe(async () => {
      await cleanupAgentPurchaseCards(
        agentId,
        new FailingDetailsCardProvider(),
        new FakeWalletFundingProvider()
      );
    });
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.HELD);
  });

  await test('reconcileFailedPurchaseRefunds retries and marks REFUNDED', async () => {
    const userId = await seedUser();
    const purchaseId = await seedHeld(userId, { status: PurchaseSpendStatus.REFUND_FAILED });
    await withFakeStripe(
      async (calls) => {
        await reconcileFailedPurchaseRefunds({ userId });
        assert.equal(calls.refunds.length, 1);
      },
      { retrievePaymentIntent: capturedPaymentIntent }
    );
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.REFUNDED);
  });

  await test('reconcileFailedPurchaseRefunds cancels an uncaptured hold and marks FAILED', async () => {
    const userId = await seedUser();
    const purchaseId = await seedHeld(userId, { status: PurchaseSpendStatus.REFUND_FAILED });
    await withFakeStripe(async (calls) => {
      await reconcileFailedPurchaseRefunds({ userId });
      assert.equal(calls.cancels.length, 1);
      assert.equal(calls.refunds.length, 0);
    });
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.FAILED);
  });

  await test('reconcileFailedPurchaseFundingReclaims reclaims then voids', async () => {
    const userId = await seedUser();
    const purchaseId = await seedHeld(userId, {
      status: PurchaseSpendStatus.FUNDING_RECLAIM_FAILED,
    });
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.FUNDED);
    const wallet = new FakeWalletFundingProvider();
    await withFakeStripe(
      async (calls) => {
        await reconcileFailed(wallet, userId);
        assert.equal(calls.refunds.length, 1);
      },
      { retrievePaymentIntent: capturedPaymentIntent }
    );
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.VOIDED);
    assert.equal(wallet.reclaimCalls.length, 1);
  });

  await test('stale issued-card compensation reclaims, cancels the hold, and voids', async () => {
    const userId = await seedUser();
    const row = await seedStaleCharging(userId);
    await seedFunding(row.id, userId, PurchaseWalletFundingStatus.FUNDED);
    const wallet = new FakeWalletFundingProvider();
    await withFakeStripe(async (calls) => {
      await reconcileStaleChargingPurchases(wallet, { userId });
      assert.equal(await statusOf(row.id), PurchaseSpendStatus.FUNDING_ABANDONED);
      await reconcileAbandonedPurchaseFunding(
        new StubCardStateProvider({ status: 'OPEN', balanceCents: 1080 }),
        wallet,
        { userId }
      );
      assert.equal(calls.cancels.length, 1, 'the stale hold must be canceled');
    });
    assert.equal(await statusOf(row.id), PurchaseSpendStatus.VOIDED);
  });

  await test('reconcileDissolvedPurchaseHolds voids an unspent dissolved hold', async () => {
    const userId = await seedUser();
    const purchaseId = await seedHeld(userId);
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.FUNDED);
    const wallet = new FakeWalletFundingProvider();
    await withFakeStripe(
      async (calls) => {
        await reconcileDissolvedPurchaseHolds(
          new StubCardStateProvider({ status: 'OPEN', balanceCents: 1080 }),
          wallet,
          { userId }
        );
        assert.equal(calls.refunds.length, 0, 'a canceled hold is not refunded, only reclaimed');
      },
      { retrievePaymentIntent: () => ({ id: 'pi', status: 'canceled', amount_capturable: 0 }) }
    );
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.VOIDED);
    assert.equal(wallet.reclaimCalls.length, 1);
  });

  await test('reconcileDissolvedPurchaseHolds skips a still-capturable hold', async () => {
    const userId = await seedUser();
    const purchaseId = await seedHeld(userId);
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.FUNDED);
    await withFakeStripe(
      async () => {
        await reconcileDissolvedPurchaseHolds(
          new StubCardStateProvider({ status: 'OPEN', balanceCents: 1080 }),
          new FakeWalletFundingProvider(),
          {
            userId,
          }
        );
      },
      {
        retrievePaymentIntent: () => ({
          id: 'pi',
          status: 'requires_capture',
          amount_capturable: 1080,
        }),
      }
    );
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.HELD, 'live hold stays HELD');
  });

  process.stdout.write(
    `\nPurchase cleanup unit tests (part 1): ${passed} passed, ${failures.length} failed\n`
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
