#!/usr/bin/env tsx
/** Durable cross-request AgentCard company-funding retry regressions. */

import { assertIssuedLedgerCleanup } from './purchases-issued-ledger.cases';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { mintPurchaseCard } from '../../domains/purchases/service';
import { PurchaseError } from '../../domains/purchases/errors';
import { prisma } from '../../providers/database';
import { AgentCardProviderError, type CardProvider } from '../../providers/card-provider';
import {
  assert,
  FakeWalletFundingProvider,
  ResumableFundingInProgressCardProvider,
  withFakeStripe,
} from './purchases.testkit';

config();

const RUN_ID = process.env.BLACKBOX_TEST_RUN_ID || `${Date.now()}-${randomUUID().slice(0, 8)}`;
const userIds: string[] = [];

async function createSubscribedUser(): Promise<string> {
  const userId = `purchase6-${RUN_ID}-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  userIds.push(userId);
  await prisma.subscription.create({
    data: {
      userId,
      subscriptionTier: 1,
      stripeSubscriptionId: `sub_${randomUUID()}`,
      stripeCustomerId: `cus_${randomUUID()}`,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  return userId;
}

function mintInput(userId: string, fingerprint: string, totalCents = 1000) {
  return {
    userId,
    fingerprint,
    merchant: 'Test Merchant',
    currency: 'USD',
    lineItems: [{ label: 'Widget', amountCents: 1000 }],
    fees: [{ label: 'Tax', amountCents: 80 }],
    subtotalCents: 1000,
    totalCents,
  } as never;
}

async function expectPurchaseError(fn: () => Promise<unknown>): Promise<PurchaseError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof PurchaseError) return error;
    throw error;
  }
  throw new Error('expected PurchaseError');
}

async function main(): Promise<void> {
  assertIssuedLedgerCleanup(process.cwd());
  const userId = await createSubscribedUser();
  const fingerprint = `funding-resume-${randomUUID()}`;
  const input = mintInput(userId, fingerprint);
  const provider = new ResumableFundingInProgressCardProvider();
  const walletProvider = new FakeWalletFundingProvider();

  await withFakeStripe(async (calls) => {
    const firstError = await expectPurchaseError(() =>
      mintPurchaseCard(input, provider, walletProvider)
    );
    assert(
      firstError.code === 'agentcard_company_funding_in_progress',
      `expected funding-in-progress, got ${firstError.code}`
    );
    const pending = await prisma.purchaseSpend.findFirstOrThrow({
      where: { userId, fingerprint },
    });
    assert(
      pending.status === PurchaseSpendStatus.FUNDING_PENDING,
      `expected FUNDING_PENDING, got ${pending.status}`
    );

    const mismatch = await expectPurchaseError(() =>
      mintPurchaseCard(mintInput(userId, fingerprint, 2000), provider, walletProvider)
    );
    assert(
      mismatch.code === 'purchase_funding_resume_mismatch',
      `expected resume mismatch, got ${mismatch.code}`
    );

    provider.completeFunding();
    const result = await mintPurchaseCard(input, provider, walletProvider);
    assert(result.purchaseId === pending.id, 'retry must resume the original purchase row');
    assert(result.status === PurchaseSpendStatus.HELD, `expected HELD, got ${result.status}`);

    const purchases = await prisma.purchaseSpend.findMany({
      where: { userId, fingerprint },
      include: { walletFunding: true },
    });
    assert(purchases.length === 1, `expected one PurchaseSpend, got ${purchases.length}`);
    assert(calls.charges.length === 2, `expected two Stripe calls, got ${calls.charges.length}`);
    assert(
      calls.chargeIdempotencyKeys[0] === calls.chargeIdempotencyKeys[1],
      'Stripe retries must use the same idempotency key'
    );
    assert(
      calls.chargeResultIds[0] === calls.chargeResultIds[1],
      'Stripe retries must resolve to the same PaymentIntent'
    );
    assert(
      provider.mintRequests.length === 2 &&
        provider.mintRequests[0]?.idempotencyKey === provider.mintRequests[1]?.idempotencyKey,
      'AgentCard retries must use the same purchase-scoped idempotency key'
    );
    assert(
      purchases[0]?.walletFunding?.status === PurchaseWalletFundingStatus.FUNDED,
      `expected FUNDED wallet row, got ${purchases[0]?.walletFunding?.status}`
    );
    assert(calls.cancels.length === 0, 'the shared hold must never be canceled');
    assert(calls.captures.length === 1, 'the shared hold must be captured exactly once');
  });

  const ambiguousUserId = await createSubscribedUser();
  const ambiguousFingerprint = `ambiguous-kyc-prose-${randomUUID()}`;
  const ambiguousProvider: CardProvider = {
    async mintCard(): Promise<never> {
      throw new AgentCardProviderError(
        'AgentCard returned 500; diagnostics mentioned kyc_required after create',
        500
      );
    },
    async getDetails(): Promise<never> {
      throw new Error('details must not run for an ambiguous provider response');
    },
    async closeCard(): Promise<void> {
      throw new Error('an unknown card must not be closed without its id');
    },
  };
  await withFakeStripe(async (calls) => {
    const error = await expectPurchaseError(() =>
      mintPurchaseCard(
        mintInput(ambiguousUserId, ambiguousFingerprint),
        ambiguousProvider,
        new FakeWalletFundingProvider()
      )
    );
    assert(
      error.code === 'agentcard_company_funding_in_progress',
      `ambiguous KYC prose must remain funding-pending, got ${error.code}`
    );
    const purchase = await prisma.purchaseSpend.findFirstOrThrow({
      where: { userId: ambiguousUserId, fingerprint: ambiguousFingerprint },
      include: { walletFunding: true },
    });
    assert(
      purchase.status === PurchaseSpendStatus.FUNDING_PENDING,
      `ambiguous response must preserve FUNDING_PENDING, got ${purchase.status}`
    );
    assert(
      purchase.walletFunding?.status === PurchaseWalletFundingStatus.PENDING,
      `ambiguous response must preserve the funding marker, got ${purchase.walletFunding?.status}`
    );
    assert(calls.cancels.length === 0, 'ambiguous provider outcome must preserve the Stripe hold');
  });

  const safeGateUserId = await createSubscribedUser();
  const safeGateFingerprint = `safe-gate-after-funding-${randomUUID()}`;
  let safeGateMintCalls = 0;
  const safeGateAfterFundingProvider: CardProvider = {
    async mintCard(): Promise<never> {
      safeGateMintCalls += 1;
      if (safeGateMintCalls === 1) {
        throw new AgentCardProviderError(
          'AgentCard company funding is in progress',
          409,
          undefined,
          'agentcard_company_funding_in_progress',
          { agentcardStatus: 'funding_in_progress', retryAfterSeconds: 60 }
        );
      }
      throw new AgentCardProviderError(
        'AgentCard organization setup required: org_wallet_funding_required',
        409,
        undefined,
        'agentcard_org_wallet_funding_required',
        { agentcardStatus: 'org_wallet_funding_required' }
      );
    },
    async getDetails(): Promise<never> {
      throw new Error('details must not run when AgentCard returns a setup gate');
    },
    async closeCard(): Promise<void> {
      throw new Error('an unknown card must not be closed without its id');
    },
  };
  await withFakeStripe(async (calls) => {
    const firstError = await expectPurchaseError(() =>
      mintPurchaseCard(
        mintInput(safeGateUserId, safeGateFingerprint),
        safeGateAfterFundingProvider,
        new FakeWalletFundingProvider()
      )
    );
    assert(
      firstError.code === 'agentcard_company_funding_in_progress',
      `first response should preserve funding retry, got ${firstError.code}`
    );

    const secondError = await expectPurchaseError(() =>
      mintPurchaseCard(
        mintInput(safeGateUserId, safeGateFingerprint),
        safeGateAfterFundingProvider,
        new FakeWalletFundingProvider()
      )
    );
    assert(
      secondError.code === 'agentcard_company_funding_in_progress',
      `a later safe gate cannot resolve the earlier funding intent, got ${secondError.code}`
    );
    const purchase = await prisma.purchaseSpend.findFirstOrThrow({
      where: { userId: safeGateUserId, fingerprint: safeGateFingerprint },
      include: { walletFunding: true },
    });
    assert(
      purchase.status === PurchaseSpendStatus.FUNDING_PENDING,
      `unresolved prior funding must stay resumable, got ${purchase.status}`
    );
    assert(
      purchase.walletFunding?.status === PurchaseWalletFundingStatus.PENDING,
      'prior funding marker must remain until its exact outcome is known'
    );
    assert(calls.cancels.length === 0, 'an unresolved prior card must keep its backing hold');
  });

  // Live RCA: Org MCP "Cardholder not found" must fail closed (not rewrite into funding-in-progress).
  const missingCardholderUserId = await createSubscribedUser();
  const missingCardholderFingerprint = `missing-cardholder-${randomUUID()}`;
  const missingCardholderProvider: CardProvider = {
    async mintCard(): Promise<never> {
      throw new AgentCardProviderError(
        'create_card failed: Cardholder not found',
        409,
        undefined,
        'agentcard_cardholder_not_found',
        { agentcardStatus: 'cardholder_not_found' }
      );
    },
    async getDetails(): Promise<never> {
      throw new Error('details must not run when cardholder is missing');
    },
    async closeCard(): Promise<void> {
      throw new Error('an unknown card must not be closed without its id');
    },
  };
  await withFakeStripe(async (calls) => {
    const error = await expectPurchaseError(() =>
      mintPurchaseCard(
        mintInput(missingCardholderUserId, missingCardholderFingerprint),
        missingCardholderProvider,
        new FakeWalletFundingProvider()
      )
    );
    assert(
      error.code === 'agentcard_cardholder_not_found',
      `missing cardholder must keep typed code, got ${error.code}`
    );
    assert(
      !/funding outcome is not confirmed/i.test(error.message),
      'missing cardholder must not be rewritten as ambiguous funding'
    );
    const purchase = await prisma.purchaseSpend.findFirstOrThrow({
      where: { userId: missingCardholderUserId, fingerprint: missingCardholderFingerprint },
      include: { walletFunding: true },
    });
    assert(
      purchase.status === PurchaseSpendStatus.FAILED,
      `missing cardholder should fail the purchase, got ${purchase.status}`
    );
    assert(purchase.walletFunding === null, 'pending wallet marker should be discarded');
    assert(calls.cancels.length === 1, 'the Stripe hold should be canceled');
  });

  // Live RCA (agent 500c444d): Org MCP "card_creation_failed" is a terminal idempotency-key
  // outcome — fail closed, do not rewrite into funding-in-progress.
  const cardCreationFailedUserId = await createSubscribedUser();
  const cardCreationFailedFingerprint = `card-creation-failed-${randomUUID()}`;
  const cardCreationFailedProvider: CardProvider = {
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
      throw new Error('an unknown card must not be closed without its id');
    },
  };
  await withFakeStripe(async (calls) => {
    const error = await expectPurchaseError(() =>
      mintPurchaseCard(
        mintInput(cardCreationFailedUserId, cardCreationFailedFingerprint),
        cardCreationFailedProvider,
        new FakeWalletFundingProvider()
      )
    );
    assert(
      error.code === 'agentcard_card_creation_failed',
      `card_creation_failed must keep typed code, got ${error.code}`
    );
    assert(
      !/funding outcome is not confirmed/i.test(error.message),
      'card_creation_failed must not be rewritten as ambiguous funding'
    );
    const purchase = await prisma.purchaseSpend.findFirstOrThrow({
      where: { userId: cardCreationFailedUserId, fingerprint: cardCreationFailedFingerprint },
      include: { walletFunding: true },
    });
    assert(
      purchase.status === PurchaseSpendStatus.FAILED,
      `card_creation_failed should fail the purchase, got ${purchase.status}`
    );
    assert(purchase.walletFunding === null, 'pending wallet marker should be discarded');
    assert(calls.cancels.length === 1, 'the Stripe hold should be canceled');
  });

  const closedReplayUserId = await createSubscribedUser();
  const closedReplayFingerprint = `closed-replay-${randomUUID()}`;
  const closedReplayCardId = `card-closed-${randomUUID()}`;
  let closedReplayCloseCalls = 0;
  const closedReplayProvider: CardProvider = {
    async mintCard() {
      return {
        cardId: closedReplayCardId,
        last4: '4242',
        expiry: '12/30',
        spendLimitCents: 1000,
        status: 'CLOSED',
        providerTransferId: `owt_closed_${randomUUID()}`,
      };
    },
    async getDetails() {
      return {
        pan: '4242424242424242',
        cvv: '123',
        expiry: '12/30',
        balanceCents: 0,
        status: 'CLOSED',
      };
    },
    async closeCard() {
      closedReplayCloseCalls += 1;
    },
  };
  const closedReplayWallet = new FakeWalletFundingProvider();
  await withFakeStripe(async (calls) => {
    const error = await expectPurchaseError(() =>
      mintPurchaseCard(
        mintInput(closedReplayUserId, closedReplayFingerprint),
        closedReplayProvider,
        closedReplayWallet
      )
    );
    assert(
      error.code === 'agentcard_company_card_unusable',
      `closed replay must fail as unusable, got ${error.code}`
    );
    assert(calls.captures.length === 0, 'a closed replay card must never capture Stripe');
    assert(calls.cancels.length === 1, 'a closed replay card must release the Stripe hold');
    assert(closedReplayCloseCalls === 1, 'the unusable card must enter idempotent close cleanup');
    assert(
      closedReplayWallet.reclaimCalls.length === 1,
      'the unusable card transfer must be reclaimed'
    );
    const purchase = await prisma.purchaseSpend.findFirstOrThrow({
      where: { userId: closedReplayUserId, fingerprint: closedReplayFingerprint },
    });
    assert(
      purchase.status === PurchaseSpendStatus.FAILED,
      `closed replay cleanup must end FAILED, got ${purchase.status}`
    );
  });

  process.stdout.write('PASS durable AgentCard company-funding resume (3/3)\n');
}

main()
  .catch((error) => {
    process.stderr.write(`FAIL ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.purchaseSpend.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.subscription.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.$disconnect();
  });
