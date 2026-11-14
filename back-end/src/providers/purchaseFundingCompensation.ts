import { reconcileIssuedPurchaseEvidence } from './purchaseIssuedEvidence';
import { PurchaseSpendStatus } from '@prisma/client';
import { createCardProviderForAgent, type CardProvider } from './card-provider';
import { AgentCardProviderError } from './card-provider/errors';
import { ROSE_AGENT_CARD_ID } from './card-provider/static-card';
import { prisma } from './database';
import { createLogger } from './logger';
import {
  beginPurchaseWalletReclaim,
  discardPendingPurchaseWalletCollection,
  reclaimPurchaseWalletFunding,
  recordIssuedPurchaseCardFunding,
} from './purchase-wallet-funding';
import { reversePurchasePaymentIntent, getStripeClientForLivemode } from './stripe';
import {
  createWalletFundingProvider,
  isWalletFundingConsumedDuringReclaimError,
  type WalletFundingProvider,
} from './wallet-funding';

const log = createLogger('PurchaseFundingCompensation');
const fundingPendingAbandonRaw = process.env.PURCHASE_FUNDING_PENDING_ABANDON_MS;
const FUNDING_PENDING_ABANDON_MS =
  fundingPendingAbandonRaw === undefined ? 12 * 60 * 1000 : Number(fundingPendingAbandonRaw);
if (!Number.isInteger(FUNDING_PENDING_ABANDON_MS) || FUNDING_PENDING_ABANDON_MS <= 0) {
  throw new Error('PURCHASE_FUNDING_PENDING_ABANDON_MS must be a positive integer');
}

const TERMINAL_AGENTCARD_MINT_CODES = new Set([
  'agentcard_card_creation_failed',
  'agentcard_cardholder_not_found',
]);

function isTerminalAgentCardMintFailure(error: unknown): boolean {
  if (!(error instanceof AgentCardProviderError) || error.code === undefined) return false;
  return TERMINAL_AGENTCARD_MINT_CODES.has(error.code);
}

export type FundingCompensationScope = { userId?: string; agentId?: string };

function scopeWhere(scope?: FundingCompensationScope): FundingCompensationScope {
  return {
    ...(scope?.userId !== undefined ? { userId: scope.userId } : {}),
    ...(scope?.agentId !== undefined ? { agentId: scope.agentId } : {}),
  };
}

async function recoverUnpersistedStripeIntent(
  purchaseId: string,
  livemode: boolean
): Promise<string | null> {
  const result = await getStripeClientForLivemode(livemode).paymentIntents.search({
    query: `metadata['purchaseSpendId']:'${purchaseId}'`,
    limit: 10,
  });
  if (result.data.length === 0) return null;
  if (result.data.length !== 1) {
    throw new Error(`Expected one Stripe authorization for purchase ${purchaseId}`);
  }
  const paymentIntentId = result.data[0].id;
  await prisma.purchaseSpend.updateMany({
    where: {
      id: purchaseId,
      status: PurchaseSpendStatus.FUNDING_ABANDONED,
      stripePaymentIntentId: null,
    },
    data: { stripePaymentIntentId: paymentIntentId },
  });
  return paymentIntentId;
}

async function reversePurchaseAuthorization(
  purchaseId: string,
  persistedPaymentIntentId: string | null,
  livemode: boolean
): Promise<string | null> {
  const paymentIntentId =
    persistedPaymentIntentId ?? (await recoverUnpersistedStripeIntent(purchaseId, livemode));
  if (paymentIntentId === null) return null;
  await reversePurchasePaymentIntent(paymentIntentId, purchaseId, livemode);
  return paymentIntentId;
}

async function ensureIssuedCardIsRecorded(
  purchase: Awaited<ReturnType<typeof loadAbandonedPurchase>>,
  cardProvider: CardProvider
): Promise<{ cardId: string; staticCard: boolean } | null> {
  if (purchase === null) return null;
  if (purchase.cardId === ROSE_AGENT_CARD_ID) {
    return { cardId: purchase.cardId, staticCard: true };
  }
  if (purchase.cardId !== null && purchase.walletFunding !== null) {
    return { cardId: purchase.cardId, staticCard: false };
  }

  // One idempotent observation of the original create request. It may report funding_in_progress
  // again; in that case the abandoned row remains the durable polling owner with no Stripe hold.
  const minted = await cardProvider.mintCard({
    amountCents: purchase.totalCents,
    idempotencyKey: `purchase:${purchase.id}`,
    fundsSource: 'company_flow',
    expectedLivemode: purchase.stripeLivemode,
  });
  if (minted.metadata?.staticCard === true) {
    await discardPendingPurchaseWalletCollection(purchase.id);
    await prisma.purchaseSpend.updateMany({
      where: { id: purchase.id, status: PurchaseSpendStatus.FUNDING_ABANDONED },
      data: { cardId: minted.cardId },
    });
    return { cardId: minted.cardId, staticCard: true };
  }
  const transferId = minted.providerTransferId;
  if (transferId === undefined || transferId.trim() === '') {
    throw new Error('AgentCard reconciliation returned a card without a company transfer id');
  }
  await recordIssuedPurchaseCardFunding(purchase, 'usd', minted.cardId, transferId, {
    ...(minted.metadata ?? {}),
    last4: minted.last4,
  });
  return { cardId: minted.cardId, staticCard: false };
}

function loadAbandonedPurchase(id: string) {
  return prisma.purchaseSpend.findFirst({
    where: { id, status: PurchaseSpendStatus.FUNDING_ABANDONED },
    include: { walletFunding: true },
  });
}

async function compensateAbandonedPurchase(
  purchaseId: string,
  cardProvider?: CardProvider,
  walletFundingProvider?: WalletFundingProvider
): Promise<void> {
  let purchase = await loadAbandonedPurchase(purchaseId);
  if (purchase === null) return;
  const evidence = await reconcileIssuedPurchaseEvidence(purchase.id);
  if (evidence === 'settled' || evidence === 'pending') return;

  const paymentIntentId =
    purchase.stripePaymentIntentId ??
    (await recoverUnpersistedStripeIntent(purchase.id, purchase.stripeLivemode));
  if (paymentIntentId === null) {
    // The funding marker is written before Stripe. No Stripe PI means the process died before any
    // provider call could start, so this row is safe to terminate without replaying AgentCard.
    await discardPendingPurchaseWalletCollection(purchase.id);
    await prisma.purchaseSpend.updateMany({
      where: { id: purchase.id, status: PurchaseSpendStatus.FUNDING_ABANDONED },
      data: { status: PurchaseSpendStatus.FAILED },
    });
    return;
  }

  purchase = await loadAbandonedPurchase(purchase.id);
  if (purchase === null) return;
  const activeCardProvider =
    cardProvider ?? (await createCardProviderForAgent(purchase.userId, purchase.agentId));
  let issued: { cardId: string; staticCard: boolean } | null;
  try {
    issued = await ensureIssuedCardIsRecorded(purchase, activeCardProvider);
  } catch (error) {
    // AgentCard stores terminal create_card failures under purchase:{id}. Replaying the same
    // idempotency key can never succeed — reverse the Stripe hold and stop compensation.
    if (!isTerminalAgentCardMintFailure(error)) throw error;
    log.warn('Abandoned purchase mint is terminal; releasing Stripe authorization', {
      purchase_id: purchase.id,
      error: error instanceof Error ? error.message : String(error),
      code: error instanceof AgentCardProviderError ? error.code : undefined,
    });
    await discardPendingPurchaseWalletCollection(purchase.id);
    await reversePurchaseAuthorization(purchase.id, paymentIntentId, purchase.stripeLivemode);
    await prisma.purchaseSpend.updateMany({
      where: { id: purchase.id, status: PurchaseSpendStatus.FUNDING_ABANDONED },
      data: { status: PurchaseSpendStatus.FAILED },
    });
    return;
  }
  if (issued === null) return;
  if (issued.staticCard) {
    await reversePurchaseAuthorization(purchase.id, paymentIntentId, purchase.stripeLivemode);
    await prisma.purchaseSpend.updateMany({
      where: { id: purchase.id, status: PurchaseSpendStatus.FUNDING_ABANDONED },
      data: { status: PurchaseSpendStatus.VOIDED },
    });
    return;
  }

  const issuedEvidence = await reconcileIssuedPurchaseEvidence(purchase.id);
  if (issuedEvidence === 'settled' || issuedEvidence === 'pending') return;
  const reclaimClaim = await beginPurchaseWalletReclaim(purchase.id);
  if (reclaimClaim.status === 'already_owned') return;
  await activeCardProvider.closeCard(issued.cardId);
  try {
    await reclaimPurchaseWalletFunding(
      { ...purchase, cardId: issued.cardId },
      'abandoned_company_funding_reconciliation',
      walletFundingProvider ?? createWalletFundingProvider(),
      reclaimClaim.status === 'owned' ? { reclaimLeaseToken: reclaimClaim.reclaimLeaseToken } : {}
    );
  } catch (error) {
    if (isWalletFundingConsumedDuringReclaimError(error)) {
      await prisma.purchaseSpend.updateMany({
        where: { id: purchase.id, status: PurchaseSpendStatus.FUNDING_ABANDONED },
        data: { status: PurchaseSpendStatus.CAPTURE_FAILED },
      });
      return;
    }
    throw error;
  }
  await reversePurchaseAuthorization(purchase.id, paymentIntentId, purchase.stripeLivemode);
  await prisma.purchaseSpend.updateMany({
    where: { id: purchase.id, status: PurchaseSpendStatus.FUNDING_ABANDONED },
    data: { status: PurchaseSpendStatus.VOIDED },
  });
}

/** Terminal-agent hook: stop user-owned retries before releasing their Stripe authorization. */
export async function abandonAgentFundingPending(agentId: string): Promise<void> {
  const purchases = await prisma.purchaseSpend.findMany({
    where: { agentId, status: PurchaseSpendStatus.FUNDING_PENDING },
    select: { id: true, updatedAt: true },
  });
  for (const purchase of purchases) {
    const evidence = await reconcileIssuedPurchaseEvidence(purchase.id);
    if (evidence === 'settled' || evidence === 'pending') continue;
    await prisma.purchaseSpend.updateMany({
      where: {
        id: purchase.id,
        status: PurchaseSpendStatus.FUNDING_PENDING,
        updatedAt: purchase.updatedAt,
      },
      data: { status: PurchaseSpendStatus.FUNDING_ABANDONED },
    });
  }
}

/** Cron lease: attempts older than the active workflow retry window become compensation-owned. */
export async function abandonStaleFundingPending(scope?: FundingCompensationScope): Promise<void> {
  const staleBefore = new Date(Date.now() - FUNDING_PENDING_ABANDON_MS);
  const purchases = await prisma.purchaseSpend.findMany({
    where: {
      ...scopeWhere(scope),
      status: PurchaseSpendStatus.FUNDING_PENDING,
      updatedAt: { lt: staleBefore },
    },
    select: { id: true, updatedAt: true },
  });
  for (const purchase of purchases) {
    const evidence = await reconcileIssuedPurchaseEvidence(purchase.id);
    if (evidence === 'settled' || evidence === 'pending') continue;
    await prisma.purchaseSpend.updateMany({
      where: {
        id: purchase.id,
        status: PurchaseSpendStatus.FUNDING_PENDING,
        updatedAt: purchase.updatedAt,
      },
      data: { status: PurchaseSpendStatus.FUNDING_ABANDONED },
    });
  }
}

/**
 * Replay the exact AgentCard key until the external outcome is observable. A late card is
 * atomically recorded, closed, and reclaimed before Stripe is canceled/refunded, so a consumed
 * card can never receive a free user-payment reversal.
 */
export async function reconcileAbandonedPurchaseFunding(
  cardProvider?: CardProvider,
  walletFundingProvider?: WalletFundingProvider,
  scope?: FundingCompensationScope
): Promise<void> {
  const purchases = await prisma.purchaseSpend.findMany({
    where: {
      ...scopeWhere(scope),
      status: PurchaseSpendStatus.FUNDING_ABANDONED,
    },
    select: { id: true },
  });
  for (const purchase of purchases) {
    try {
      await compensateAbandonedPurchase(purchase.id, cardProvider, walletFundingProvider);
    } catch (error) {
      log.warn('Abandoned purchase funding is still awaiting provider reconciliation', {
        purchase_id: purchase.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
