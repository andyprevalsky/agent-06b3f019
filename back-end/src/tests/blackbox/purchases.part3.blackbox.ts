#!/usr/bin/env tsx

import { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus } from '@prisma/client';
import * as purchasesService from '../../domains/purchases/service';
import { prisma } from '../../providers/database';
import { reconcileFailedPurchaseFundingReclaims } from '../../providers/purchaseCleanup';
import { WalletFundingProviderError } from '../../providers/wallet-funding';
import {
  assert,
  FakeCardProvider,
  FakeWalletFundingProvider,
  withFakeStripe,
} from './purchases.testkit';

async function main(): Promise<void> {
  const userId = `purchase3-${Date.now()}-${randomUUID()}`;
  const fingerprint = `reclaim-pending-${randomUUID()}`;
  const cardProvider = new FakeCardProvider();
  const walletFundingProvider = new FakeWalletFundingProvider();
  let releaseAttempts = 0;

  await prisma.user.create({ data: { userId, isAnonymous: true } });
  await prisma.subscription.create({
    data: {
      userId,
      subscriptionTier: 1,
      stripeSubscriptionId: `sub_${randomUUID()}`,
      stripeCustomerId: `cus_${randomUUID()}`,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  walletFundingProvider.reclaimUserWalletFunding = async (request) => {
    walletFundingProvider.reclaimCalls.push(request);
    releaseAttempts += 1;
    if (releaseAttempts === 1) {
      throw new WalletFundingProviderError(
        'AgentCard company transfer release is still pending',
        409,
        'agentcard_company_transfer_release_pending'
      );
    }
    return {
      providerTransferId: request.providerTransferId,
      metadata: { status: 'release_confirmed' },
    };
  };

  try {
    await withFakeStripe(async (calls) => {
      const minted = await purchasesService.mintPurchaseCard(
        {
          userId,
          fingerprint,
          merchant: 'Pending Release Merchant',
          currency: 'USD',
          lineItems: [{ label: 'Widget', amountCents: 1000 }],
          fees: [],
          subtotalCents: 1000,
          totalCents: 1000,
        } as never,
        cardProvider,
        walletFundingProvider
      );

      const closeResult = await purchasesService.closePurchaseCard(
        cardProvider.cardId,
        cardProvider,
        walletFundingProvider
      );
      assert(closeResult.status === PurchaseSpendStatus.HELD, `got ${closeResult.status}`);
      assert(calls.refunds.length === 0, 'pending release must not refund Stripe');

      const pending = await prisma.purchaseSpend.findFirst({
        where: { userId, fingerprint },
        include: { walletFunding: true },
      });
      assert(pending?.status === PurchaseSpendStatus.HELD, 'purchase must remain HELD');
      assert(pending?.walletFunding?.status === 'RECLAIMING', 'funding must be RECLAIMING');

      // The minute reconciler intentionally leaves a live provider polling loop alone. Age the
      // durable lease to model the next eligible retry after that owner has exited pending.
      await prisma.purchaseWalletFunding.update({
        where: { purchaseId: minted.purchaseId },
        data: { updatedAt: new Date(Date.now() - 3 * 60 * 1000) },
      });
      await reconcileFailedPurchaseFundingReclaims(walletFundingProvider, { userId });
      assert(calls.refunds.length === 1, 'confirmed release must refund Stripe exactly once');
    });

    const recovered = await prisma.purchaseSpend.findFirst({ where: { userId, fingerprint } });
    assert(recovered?.status === PurchaseSpendStatus.VOIDED, `got ${recovered?.status}`);
    console.log(
      'PASS pending company release remains in progress until reconciliation confirms it'
    );

    const overlapFingerprint = `single-close-owner-${randomUUID()}`;
    const overlapCardProvider = new FakeCardProvider();
    const overlapWalletProvider = new FakeWalletFundingProvider();
    await withFakeStripe(async (calls) => {
      await purchasesService.mintPurchaseCard(
        {
          userId,
          fingerprint: overlapFingerprint,
          merchant: 'Single Close Owner Merchant',
          currency: 'USD',
          lineItems: [{ label: 'Widget', amountCents: 1000 }],
          fees: [],
          subtotalCents: 1000,
          totalCents: 1000,
        } as never,
        overlapCardProvider,
        overlapWalletProvider
      );

      let notifyProviderEntered!: () => void;
      let releaseProvider!: () => void;
      const providerEntered = new Promise<void>((resolve) => {
        notifyProviderEntered = resolve;
      });
      const providerRelease = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      overlapWalletProvider.reclaimUserWalletFunding = async (request) => {
        overlapWalletProvider.reclaimCalls.push(request);
        notifyProviderEntered();
        await providerRelease;
        return { providerTransferId: request.providerTransferId };
      };

      const owner = purchasesService.closePurchaseCard(
        overlapCardProvider.cardId,
        overlapCardProvider,
        overlapWalletProvider
      );
      await providerEntered;
      const loser = await purchasesService.closePurchaseCard(
        overlapCardProvider.cardId,
        overlapCardProvider,
        overlapWalletProvider
      );
      assert(loser.status === PurchaseSpendStatus.HELD, `got ${loser.status}`);
      assert(overlapCardProvider.closeCalls === 1, 'only the FUNDED CAS owner may close the card');
      assert(
        overlapWalletProvider.reclaimCalls.length === 1,
        'provider release must be single-flight'
      );
      assert(calls.refunds.length === 0, 'Stripe cannot refund before AgentCard release');
      releaseProvider();
      const ownerResult = await owner;
      assert(ownerResult.status === PurchaseSpendStatus.VOIDED, `got ${ownerResult.status}`);
      assert(calls.refunds.length === 1, 'the release owner refunds Stripe exactly once');
    });
    console.log('PASS overlapping cleanup paths elect one close/reclaim owner');

    const raceFingerprint = `reclaim-cleared-race-${randomUUID()}`;
    const raceCardProvider = new FakeCardProvider();
    const raceWalletProvider = new FakeWalletFundingProvider();
    await withFakeStripe(async (calls) => {
      const minted = await purchasesService.mintPurchaseCard(
        {
          userId,
          fingerprint: raceFingerprint,
          merchant: 'Reclaim Race Merchant',
          currency: 'USD',
          lineItems: [{ label: 'Widget', amountCents: 1000 }],
          fees: [],
          subtotalCents: 1000,
          totalCents: 1000,
        } as never,
        raceCardProvider,
        raceWalletProvider
      );

      raceWalletProvider.reclaimUserWalletFunding = async (request) => {
        raceWalletProvider.reclaimCalls.push(request);
        await prisma.$transaction([
          prisma.purchaseWalletFunding.update({
            where: { purchaseId: minted.purchaseId },
            data: { status: 'CONSUMED', consumedAt: new Date() },
          }),
          prisma.purchaseSpend.update({
            where: { id: minted.purchaseId },
            data: { status: PurchaseSpendStatus.CLEARED },
          }),
        ]);
        return {
          providerTransferId: request.providerTransferId,
          metadata: { status: 'release_confirmed' },
        };
      };

      const closeResult = await purchasesService.closePurchaseCard(
        raceCardProvider.cardId,
        raceCardProvider,
        raceWalletProvider
      );
      assert(closeResult.status === PurchaseSpendStatus.CLEARED, `got ${closeResult.status}`);
      assert(calls.refunds.length === 0, 'a cleared transaction must never refund as abandoned');
    });

    const raced = await prisma.purchaseSpend.findFirst({
      where: { userId, fingerprint: raceFingerprint },
      include: { walletFunding: true },
    });
    assert(raced?.status === PurchaseSpendStatus.CLEARED, `got ${raced?.status}`);
    assert(raced?.walletFunding?.status === 'CONSUMED', `got ${raced?.walletFunding?.status}`);
    console.log('PASS transaction clearance wins a concurrent wallet funding reclaim');
  } finally {
    await prisma.purchaseSpend.deleteMany({ where: { userId } });
    await prisma.subscription.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
