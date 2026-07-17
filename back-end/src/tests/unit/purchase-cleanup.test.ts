#!/usr/bin/env tsx
/**
 * Unit tests for the purchase-card cleanup + reconciliation backstops
 * (`providers/purchaseCleanup.ts`).
 *
 * Each reconciler is exercised against the live local Postgres with injected card
 * and wallet-funding providers plus a stubbed Stripe, covering the spent/unspent,
 * reclaim-consumed, release-pending, and refund-failure branches. Every scan is
 * scoped by userId so concurrent blackbox purchase rows are never touched.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import {
  cleanupAgentPurchaseCards,
  reconcileDissolvedPurchaseHolds,
  reconcileFailedPurchaseFundingReclaims,
  reconcileFailedPurchaseRefunds,
  reconcileStaleChargingPurchases,
  reconcileTerminalAgentPurchaseCards,
} from '../../providers/purchaseCleanup';
import {
  WalletFundingProviderError,
  type WalletFundingReclaimRequest,
  type WalletFundingResult,
} from '../../providers/wallet-funding';
import {
  FailingDetailsCardProvider,
  FakeWalletFundingProvider,
  StubCardStateProvider,
  withFakeStripe,
} from '../blackbox/purchases.testkit';

const createdUserIds: string[] = [];
let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  PASS ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`  FAIL ${name}\n`);
  }
}

class ReclaimErrorWalletProvider extends FakeWalletFundingProvider {
  constructor(private readonly error: Error) {
    super();
  }
  async reclaimUserWalletFunding(
    request: WalletFundingReclaimRequest
  ): Promise<WalletFundingResult> {
    this.reclaimCalls.push(request);
    throw this.error;
  }
}

async function seedUser(): Promise<string> {
  const userId = `cleanup-unit-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  createdUserIds.push(userId);
  return userId;
}

async function seedAgent(userId: string, status: string): Promise<string> {
  const agent = await prisma.agent.create({
    data: { userId, goal: 'cleanup test', status: status as never },
  });
  return agent.id;
}

async function seedHeld(
  userId: string,
  opts: { agentId?: string; cardId?: string; status?: PurchaseSpendStatus } = {}
): Promise<string> {
  const row = await prisma.purchaseSpend.create({
    data: {
      userId,
      agentId: opts.agentId,
      fingerprint: `fp-${randomUUID()}`,
      merchant: 'Cleanup Merchant',
      lineItemsJson: { totalCents: 1080 },
      totalCents: 1080,
      status: opts.status ?? PurchaseSpendStatus.HELD,
      cardId: opts.cardId ?? `card-${randomUUID()}`,
      stripePaymentIntentId: `pi_${randomUUID()}`,
    },
  });
  return row.id;
}

async function seedFunding(
  purchaseId: string,
  userId: string,
  status: PurchaseWalletFundingStatus = PurchaseWalletFundingStatus.FUNDED
): Promise<void> {
  await prisma.purchaseWalletFunding.create({
    data: {
      purchaseId,
      userId,
      amountCents: 1080,
      currency: 'usd',
      status,
      providerTransferId: `owt_${randomUUID()}`,
      idempotencyKey: `purchase-wallet-fund:${purchaseId}`,
    },
  });
}

async function statusOf(purchaseId: string): Promise<PurchaseSpendStatus | undefined> {
  const row = await prisma.purchaseSpend.findUnique({ where: { id: purchaseId } });
  return row?.status;
}

async function main(): Promise<void> {
  process.stdout.write('Running purchase cleanup unit tests...\n');

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
    await withFakeStripe(async (calls) => {
      await cleanupAgentPurchaseCards(
        agentId,
        new StubCardStateProvider({ status: 'OPEN', balanceCents: 1080 }),
        wallet
      );
      assert.equal(calls.refunds.length, 1, 'unspent cleanup must refund the captured charge');
    });
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
    await withFakeStripe(async (calls) => {
      await reconcileFailedPurchaseRefunds({ userId });
      assert.equal(calls.refunds.length, 1);
    });
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.REFUNDED);
  });

  await test('reconcileFailedPurchaseFundingReclaims reclaims then voids', async () => {
    const userId = await seedUser();
    const purchaseId = await seedHeld(userId, {
      status: PurchaseSpendStatus.FUNDING_RECLAIM_FAILED,
    });
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.FUNDED);
    const wallet = new FakeWalletFundingProvider();
    await withFakeStripe(async (calls) => {
      await reconcileFailedPurchaseFundingReclaims(wallet, { userId });
      assert.equal(calls.refunds.length, 1);
    });
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.VOIDED);
    assert.equal(wallet.reclaimCalls.length, 1);
  });

  await test('reconcileStaleChargingPurchases reclaims, cancels the hold, and fails the row', async () => {
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
    await seedFunding(row.id, userId, PurchaseWalletFundingStatus.FUNDED);
    const wallet = new FakeWalletFundingProvider();
    await withFakeStripe(async (calls) => {
      await reconcileStaleChargingPurchases(wallet, { userId });
      assert.equal(calls.cancels.length, 1, 'the stale hold must be canceled');
    });
    assert.equal(await statusOf(row.id), PurchaseSpendStatus.FAILED);
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
      { refundError: new Error('stripe refund unavailable') }
    );
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.REFUND_FAILED);
  });

  await test('cleanup treats a reclaim-in-progress closed card as unspent', async () => {
    const userId = await seedUser();
    const agentId = await seedAgent(userId, 'COMPLETED');
    const purchaseId = await seedHeld(userId, { agentId });
    // Funding already RECLAIMING: the card reads CLOSED because Rose closed it, not because a
    // merchant settled it, so cleanup must reclaim/refund rather than mark it settled.
    await seedFunding(purchaseId, userId, PurchaseWalletFundingStatus.RECLAIMING);
    const wallet = new FakeWalletFundingProvider();
    await withFakeStripe(async () => {
      await cleanupAgentPurchaseCards(
        agentId,
        new StubCardStateProvider({ status: 'CLOSED', balanceCents: 0 }),
        wallet
      );
    });
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.VOIDED);
    assert.equal(wallet.reclaimCalls.length, 1);
  });

  await test('reconcileFailedPurchaseRefunds leaves the row on a retry failure', async () => {
    const userId = await seedUser();
    const purchaseId = await seedHeld(userId, { status: PurchaseSpendStatus.REFUND_FAILED });
    await withFakeStripe(async () => await reconcileFailedPurchaseRefunds({ userId }), {
      refundError: new Error('still failing'),
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
      await reconcileFailedPurchaseFundingReclaims(wallet, { userId });
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
      await reconcileFailedPurchaseFundingReclaims(wallet, { userId });
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
    });
    assert.equal(await statusOf(row.id), PurchaseSpendStatus.CAPTURE_FAILED);
  });

  await test('reconcileStaleChargingPurchases records FUNDING_RECLAIM_FAILED on a generic error', async () => {
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
    await seedFunding(row.id, userId, PurchaseWalletFundingStatus.FUNDED);
    const wallet = new ReclaimErrorWalletProvider(new Error('mcp down'));
    await withFakeStripe(async () => {
      await reconcileStaleChargingPurchases(wallet, { userId });
    });
    assert.equal(await statusOf(row.id), PurchaseSpendStatus.FUNDING_RECLAIM_FAILED);
  });

  process.stdout.write(
    `\nPurchase cleanup unit tests: ${passed} passed, ${failures.length} failed\n`
  );
  for (const failure of failures) process.stdout.write(`  ${failure}\n`);
}

async function cleanup(): Promise<void> {
  for (const userId of createdUserIds) {
    await prisma.purchaseSpend.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
  await prisma.$disconnect();
}

main()
  .then(async () => {
    await cleanup();
    if (failures.length > 0) process.exit(1);
  })
  .catch(async (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    await cleanup();
    process.exit(1);
  });
