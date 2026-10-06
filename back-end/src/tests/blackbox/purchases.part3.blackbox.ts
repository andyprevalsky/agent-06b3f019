#!/usr/bin/env tsx

import { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import * as purchasesService from '../../domains/purchases/service';
import { settlePurchaseAfterTransactionCleared } from '../../domains/purchases/repoSettlement';
import type { CardProvider } from '../../providers/card-provider';
import { prisma } from '../../providers/database';
import {
  cleanupAgentPurchaseCards,
  reconcileDissolvedPurchaseHolds,
  reconcileFailedPurchaseFundingReclaims,
} from '../../providers/purchaseCleanup';
import { WalletFundingProviderError } from '../../providers/wallet-funding';
import {
  assert,
  FakeCardProvider,
  FakeWalletFundingProvider,
  LifecycleCardProvider,
  withFakeStripe,
} from './purchases.testkit';

async function unavailableCompanyCardLifecycle(userId: string): Promise<void> {
  const failures: string[] = [];
  async function scenario(name: string, run: () => Promise<void>) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${message}`);
      console.log(`FAIL ${name}: ${message}`);
    }
  }
  async function fixture() {
    const agent = await prisma.agent.create({
      data: { userId, goal: 'company card financial lifecycle regression' },
    });
    const card = new LifecycleCardProvider();
    const funding = new FakeWalletFundingProvider();
    const body = {
      userId,
      agentId: agent.id,
      fingerprint: `unavailable-company-${randomUUID()}`,
      merchant: 'Regression Merchant',
      currency: 'USD',
      lineItems: [{ label: 'Widget', amountCents: 1000 }],
      fees: [],
      subtotalCents: 1000,
      totalCents: 1000,
    };
    const minted = await purchasesService.mintPurchaseCard(body as never, card, funding);
    return { agent, card, funding, body, minted };
  }
  async function purchase(id: string) {
    return prisma.purchaseSpend.findUniqueOrThrow({
      where: { id },
      include: { walletFunding: true },
    });
  }
  await scenario(
    'closed company card lookup preserves unresolved funding and prevents a second mint',
    async () => {
      await withFakeStripe(async (calls) => {
        const f = await fixture();
        f.card.closed = true;
        const found = await purchasesService.lookupPurchase(userId, f.body.fingerprint, f.card);
        const row = await purchase(f.minted.purchaseId);
        assert(found.found && !found.reusable, 'closed card must remain found and nonreusable');
        assert(
          found.purchase?.status === PurchaseSpendStatus.HELD,
          'lookup must not call a closed card merchant-cleared'
        );
        assert(
          row.status === PurchaseSpendStatus.HELD &&
            row.walletFunding?.status === PurchaseWalletFundingStatus.FUNDED,
          'unconfirmed closure must preserve HELD/FUNDED'
        );
        let rejected = false;
        try {
          await purchasesService.mintPurchaseCard(f.body as never, f.card, f.funding);
        } catch (error) {
          rejected = error instanceof purchasesService.PurchaseError && error.statusCode === 409;
        }
        assert(rejected, 'unresolved funding must reject a second same-cart mint');
        assert(
          calls.charges.length === 1 && f.card.mintCalls === 1,
          'nonreuse must not create a second charge or card'
        );
      });
    }
  );
  await scenario(
    'canonical agent cleanup waits for exact unused-card release before refunding',
    async () => {
      await withFakeStripe(
        async (calls) => {
          const f = await fixture();
          f.card.closed = true;
          let entered!: () => void;
          let release!: () => void;
          const enteredProvider = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const releasedProvider = new Promise<void>((resolve) => {
            release = resolve;
          });
          f.funding.reclaimUserWalletFunding = async (request) => {
            f.funding.reclaimCalls.push(request);
            entered();
            await releasedProvider;
            return {
              providerTransferId: request.providerTransferId,
              metadata: { status: 'release_confirmed' },
            };
          };
          const cleanup = cleanupAgentPurchaseCards(f.agent.id, f.card, f.funding);
          try {
            const boundary = await Promise.race([
              enteredProvider.then(() => 'provider'),
              cleanup.then(() => 'completed'),
            ]);
            assert(
              boundary === 'provider',
              'closed funded card must enter canonical reclaim instead of assumed consumption'
            );
            const pending = await purchase(f.minted.purchaseId);
            assert(
              pending.status === PurchaseSpendStatus.HELD &&
                pending.walletFunding?.status === PurchaseWalletFundingStatus.RECLAIMING,
              'pending provider release must preserve purchase/funding ownership'
            );
            assert(
              calls.refunds.length === 0,
              'Stripe must not refund before exact transfer release'
            );
            assert(
              f.funding.reclaimCalls[0].cardId === f.card.cardId &&
                f.funding.reclaimCalls[0].providerTransferId === f.card.providerTransferId,
              'reclaim must retain the exact card and funding identity'
            );
          } finally {
            release();
            await cleanup;
          }
          const terminal = await purchase(f.minted.purchaseId);
          assert(
            terminal.status === PurchaseSpendStatus.VOIDED &&
              terminal.walletFunding?.status === PurchaseWalletFundingStatus.RECLAIMED,
            'confirmed unused release must reach VOIDED/RECLAIMED'
          );
          assert(
            calls.refunds.length === 1 && f.funding.reclaimCalls.length === 1,
            'release must refund exactly once'
          );
        },
        { retrievePaymentIntent: (id) => ({ id, status: 'succeeded', amount_received: 1000 }) }
      );
    }
  );
  await scenario(
    'unknown card read cannot clear funding or create another same-cart charge',
    async () => {
      await withFakeStripe(async (calls) => {
        const f = await fixture();
        f.card.readFailure = new Error('provider lookup unavailable');
        let lookupRejected = false;
        try {
          await purchasesService.lookupPurchase(userId, f.body.fingerprint, f.card);
        } catch (error) {
          lookupRejected = error === f.card.readFailure;
        }
        assert(lookupRejected, 'an unreadable card must preserve its unresolved observation');
        let mintRejected = false;
        try {
          await purchasesService.mintPurchaseCard(f.body as never, f.card, f.funding);
        } catch (error) {
          mintRejected = error === f.card.readFailure;
        }
        assert(mintRejected, 'unknown liveness must not open a new cart purchase');
        const row = await purchase(f.minted.purchaseId);
        assert(
          row.status === PurchaseSpendStatus.HELD &&
            row.walletFunding?.status === PurchaseWalletFundingStatus.FUNDED,
          'read outage must preserve HELD/FUNDED'
        );
        assert(
          calls.charges.length === 1 && f.card.mintCalls === 1,
          'read outage must not bill or mint again'
        );
        await cleanupAgentPurchaseCards(f.agent.id, f.card, f.funding);
        assert(
          f.funding.reclaimCalls.length === 0 && calls.refunds.length === 0,
          'unknown read must not claim financial release'
        );
      });
    }
  );
  await scenario(
    'authoritative merchant clearance preserves consumed funding without a refund',
    async () => {
      await withFakeStripe(async (calls) => {
        const f = await fixture();
        assert(
          (await settlePurchaseAfterTransactionCleared(f.minted.purchaseId)).outcome === 'cleared',
          'canonical settlement must accept merchant clearance'
        );
        f.card.closed = true;
        const found = await purchasesService.lookupPurchase(userId, f.body.fingerprint, f.card);
        assert(
          found.purchase?.status === PurchaseSpendStatus.CLEARED && !found.reusable,
          'confirmed merchant settlement remains cleared and nonreusable'
        );
        await cleanupAgentPurchaseCards(f.agent.id, f.card, f.funding);
        const row = await purchase(f.minted.purchaseId);
        assert(
          row.status === PurchaseSpendStatus.CLEARED &&
            row.walletFunding?.status === PurchaseWalletFundingStatus.CONSUMED,
          'settlement must remain atomically CLEARED/CONSUMED'
        );
        assert(
          f.funding.reclaimCalls.length === 0 && calls.refunds.length === 0,
          'confirmed merchant spend cannot be reclaimed or refunded'
        );
      });
    }
  );
  if (failures.length) throw new Error(failures.join('; '));
}

async function dissolvedClosedCompanyCardLifecycle(userId: string): Promise<void> {
  const card = new FakeCardProvider();
  const funding = new FakeWalletFundingProvider();
  await withFakeStripe(
    async (calls) => {
      const minted = await purchasesService.mintPurchaseCard(
        {
          userId,
          fingerprint: `dissolved-closed-${randomUUID()}`,
          merchant: 'Dissolved Hold Merchant',
          currency: 'USD',
          lineItems: [{ label: 'Widget', amountCents: 1000 }],
          fees: [],
          subtotalCents: 1000,
          totalCents: 1000,
        } as never,
        card,
        funding
      );
      card.getDetails = async (cardId: string) => {
        assert(cardId === card.cardId, 'read must retain the exact card');
        card.detailCalls += 1;
        return {
          pan: card.pan,
          cvv: card.cvv,
          expiry: card.expiry,
          status: 'CLOSED',
          balanceCents: 0,
        };
      };
      card.closeCard = async (cardId: string) => {
        assert(cardId === card.cardId, 'close must retain the exact card');
        card.closeCalls += 1;
        throw Object.assign(new Error('card_closed'), { code: 'card_closed' });
      };
      let entered!: () => void;
      let release!: () => void;
      const enteredProvider = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const releasedProvider = new Promise<void>((resolve) => {
        release = resolve;
      });
      funding.reclaimUserWalletFunding = async (request) => {
        funding.reclaimCalls.push(request);
        entered();
        await releasedProvider;
        return {
          providerTransferId: request.providerTransferId,
          metadata: { status: 'release_confirmed' },
        };
      };
      const reconciliation = reconcileDissolvedPurchaseHolds(card, funding, { userId }).then(
        () => undefined,
        (error: unknown) => error
      );
      try {
        const boundary = await Promise.race([
          enteredProvider.then(() => 'provider'),
          reconciliation.then(() => 'completed'),
        ]);
        assert(
          boundary === 'provider',
          'already-closed unused card must reach exact funding release'
        );
        const pending = await prisma.purchaseSpend.findUniqueOrThrow({
          where: { id: minted.purchaseId },
          include: { walletFunding: true },
        });
        assert(
          pending.status === PurchaseSpendStatus.HELD &&
            pending.walletFunding?.status === 'RECLAIMING',
          'pending release must remain HELD/RECLAIMING'
        );
        assert(
          funding.reclaimCalls[0].cardId === card.cardId &&
            funding.reclaimCalls[0].providerTransferId === card.providerTransferId,
          'release must retain exact card and transfer'
        );
        assert(
          calls.refunds.length === 0 && calls.cancels.length === 0,
          'pending release must not reverse Stripe'
        );
      } finally {
        release();
        const error = await reconciliation;
        assert(error === undefined, 'typed card_closed must not abandon dissolved-hold reclaim');
      }
      const terminal = await prisma.purchaseSpend.findUniqueOrThrow({
        where: { id: minted.purchaseId },
        include: { walletFunding: true },
      });
      assert(
        terminal.status === PurchaseSpendStatus.VOIDED &&
          terminal.walletFunding?.status === 'RECLAIMED',
        'confirmed release must void the dissolved hold without fake consumption'
      );
      assert(
        card.closeCalls === 1 && funding.reclaimCalls.length === 1,
        'close and exact reclaim must run once'
      );
      assert(
        calls.refunds.length === 0 && calls.cancels.length === 0,
        'already dissolved Stripe hold must not be reversed twice'
      );
    },
    { retrievePaymentIntent: (id) => ({ id, status: 'canceled', amount_capturable: 0 }) }
  );
  console.log('PASS dissolved hold reclaims an already-closed unused company card');
}

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
    await dissolvedClosedCompanyCardLifecycle(userId);
    await unavailableCompanyCardLifecycle(userId);
    await withFakeStripe(
      async (calls) => {
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
        await reconcileFailedPurchaseFundingReclaims(
          walletFundingProvider,
          { userId },
          cardProvider
        );
        assert(calls.refunds.length === 1, 'confirmed release must refund Stripe exactly once');
      },
      {
        retrievePaymentIntent: (id) => ({ id, status: 'succeeded', amount_received: 1000 }),
      }
    );

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

    const setupFingerprint = `service-agentcard-setup-${randomUUID()}`;
    const setupUrl = 'https://agentcard.example/onboard/session-123';
    const setupError = Object.assign(new Error('One Time Agent Payment Setup is required'), {
      name: 'AgentCardProviderError',
      status: 409,
      code: 'agentcard_setup_required',
      details: {
        agentcardStatus: 'cardholder_onboarding_required',
        setupAction: 'complete_agentcard_cardholder_onboarding',
        setupUrl,
      },
    });
    const setupProvider: CardProvider = {
      async mintCard() {
        throw setupError;
      },
      async getDetails() {
        throw new Error('getDetails should not run after setup gate');
      },
      async closeCard() {},
    };

    await withFakeStripe(async (calls) => {
      let caught: unknown;
      try {
        await purchasesService.mintPurchaseCard(
          {
            userId,
            fingerprint: setupFingerprint,
            merchant: 'Test Merchant',
            currency: 'USD',
            lineItems: [{ label: 'Widget', amountCents: 1000 }],
            fees: [],
            subtotalCents: 1000,
            totalCents: 1000,
          } as never,
          setupProvider
        );
      } catch (error) {
        caught = error;
      }

      assert(caught instanceof purchasesService.PurchaseError, 'expected PurchaseError');
      const purchaseError = caught as purchasesService.PurchaseError;
      assert(purchaseError.statusCode === 409, `expected 409, got ${purchaseError.statusCode}`);
      assert(
        purchaseError.code === 'agentcard_setup_required',
        `expected agentcard_setup_required, got ${purchaseError.code}`
      );
      assert(
        purchaseError.details.agentcardStatus === 'cardholder_onboarding_required',
        'setup status must be preserved for the attention gate'
      );
      assert(purchaseError.details.setupUrl === setupUrl, 'setup URL must be preserved');
      assert(calls.cancels.length === 1, 'setup-required failure must cancel the hold');

      const row = await prisma.purchaseSpend.findFirst({
        where: { userId, fingerprint: setupFingerprint },
        orderBy: { createdAt: 'desc' },
      });
      assert(row !== null, 'setup mint failure should persist a purchase spend row');
      assert(row?.status === PurchaseSpendStatus.FAILED, `expected FAILED, got ${row?.status}`);
      assert(row?.cardId === null, 'setup mint failure should not store a card id');
    });
    console.log('PASS setup-shaped AgentCard errors stay typed at the purchase boundary');
  } finally {
    await prisma.purchaseSpend.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { userId } });
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
