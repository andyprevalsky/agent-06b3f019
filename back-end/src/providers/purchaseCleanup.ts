import { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import {
  createCardProviderForAgent,
  isCardLive,
  type CardProvider,
  type CardProviderDetailsResult,
} from './card-provider';
import { prisma } from './database';
import { createLogger } from './logger';
import { cancelAuthorizedHold, reversePurchasePaymentIntent, stripe } from './stripe';
import {
  isWalletFundingConsumedDuringReclaimError,
  isWalletFundingReleasePendingError,
  type WalletFundingProvider,
} from './wallet-funding';
import {
  beginPurchaseWalletReclaim,
  consumePurchaseWalletFunding,
  reclaimPurchaseWalletFunding,
} from './purchase-wallet-funding';
import {
  claimWalletFundingReclaimRetry,
  findWalletFundingByPurchaseId,
} from './purchase-wallet-funding-repo';
import {
  abandonAgentFundingPending,
  abandonStaleFundingPending,
  reconcileAbandonedPurchaseFunding,
} from './purchaseFundingCompensation';

export { abandonStaleFundingPending, reconcileAbandonedPurchaseFunding };

const log = createLogger('PurchaseCleanup');
const STALE_CHARGING_MS = Number(process.env.PURCHASE_STALE_CHARGING_MS ?? 15 * 60 * 1000);
// One provider release pass polls for roughly a minute. Do not let the minute cron start a second
// release-observation loop while that pass is still alive; crashed attempts become retryable on the next
// tick after this lease window.
const STALE_RECLAIMING_MS = 2 * 60 * 1000;

/**
 * Funding states that mean *we already closed this card to reclaim it* (or finished doing so). Once
 * a reclaim is underway, the card reads as not-live because Rose closed it, NOT because a merchant
 * settled a charge — so `!isCardLive` must not be treated as "the card was spent".
 */
const RECLAIM_IN_PROGRESS_FUNDING_STATUSES = new Set<PurchaseWalletFundingStatus>([
  PurchaseWalletFundingStatus.RECLAIMING,
  PurchaseWalletFundingStatus.RECLAIMED,
  PurchaseWalletFundingStatus.RECLAIM_FAILED,
]);

/**
 * Whether a purchase's single-use card was actually spent by a merchant (vs. closed by Rose during
 * an abandonment/reclaim). A live card is never spent. A not-live card is only "spent" when no
 * reclaim is already recorded for it; otherwise the card is not-live because a prior/concurrent
 * cleanup pass already closed it to release the AgentCard transfer, and reclassifying it as "used"
 * would consume the org-wallet funding and permanently drain the float. In that case we defer to the
 * in-flight reclaim / release-pending retry instead of marking the purchase settled.
 */
async function purchaseCardWasSpent(
  purchaseId: string,
  details: CardProviderDetailsResult
): Promise<boolean> {
  if (isCardLive(details)) return false;
  const funding = await findWalletFundingByPurchaseId(purchaseId);
  if (funding !== null && RECLAIM_IN_PROGRESS_FUNDING_STATUSES.has(funding.status)) {
    return false;
  }
  return true;
}

/**
 * Optional narrowing for the cron reconcilers. Production callers omit it so each reconciler scans
 * every stuck purchase (the correct cron behavior). Blackbox tests share a single Postgres database
 * and run domains concurrently, so they pass `{ userId }` to keep each test's global-scan reconciler
 * from picking up rows another concurrently-running purchase test created.
 */
export type PurchaseReconcileScope = { userId?: string; agentId?: string };

function reconcileUserFilter(scope?: PurchaseReconcileScope): PurchaseReconcileScope {
  return {
    ...(scope?.userId !== undefined ? { userId: scope.userId } : {}),
    ...(scope?.agentId !== undefined ? { agentId: scope.agentId } : {}),
  };
}

function hasDissolvedHold(paymentIntent: unknown): boolean {
  const candidate = paymentIntent as {
    status?: unknown;
    amount_capturable?: unknown;
  };
  if (candidate.status === 'canceled') return true;
  if (
    candidate.status !== 'requires_capture' &&
    candidate.status !== 'succeeded' &&
    candidate.amount_capturable === 0
  ) {
    return true;
  }
  return false;
}

/**
 * Reconcile a HELD agent's purchase cards at session end — the primary "cancel on fail" hook (no
 * cron needed). For each still-HELD card we ask the card itself whether it was used:
 *   - still live (unspent) → close/reclaim the card, then refund the captured funding charge.
 *   - already settled → consume the transfer and mark CLEARED; funding was captured at issuance.
 *   - unreadable → fail safe: leave the purchase for its transaction webhook.
 */
export async function cleanupAgentPurchaseCards(
  agentId: string,
  cardProvider?: CardProvider,
  walletFundingProvider?: WalletFundingProvider
): Promise<void> {
  // A terminal agent will no longer retry its funding 409. Transfer ownership to the compensator
  // immediately so the user's Stripe hold is released without waiting for the stale cron window.
  await abandonAgentFundingPending(agentId);
  await reconcileAbandonedPurchaseFunding(cardProvider, walletFundingProvider, { agentId });

  const openPurchases = await prisma.purchaseSpend.findMany({
    where: {
      agentId,
      status: PurchaseSpendStatus.HELD,
      cardId: { not: null },
    },
    select: {
      id: true,
      userId: true,
      agentId: true,
      cardId: true,
      totalCents: true,
      stripePaymentIntentId: true,
    },
  });

  if (openPurchases.length > 0) {
    log.info(`Reconciling ${openPurchases.length} held purchase card(s) for agent ${agentId}`);
  }

  for (const purchase of openPurchases) {
    const cardId = purchase.cardId;
    if (cardId === null) continue;
    try {
      const activeCardProvider =
        cardProvider ?? (await createCardProviderForAgent(purchase.userId, purchase.agentId));
      let cardWasUsed: boolean;
      try {
        const details = await activeCardProvider.getDetails(cardId);
        cardWasUsed = await purchaseCardWasSpent(purchase.id, details);
      } catch (readError) {
        // Can't confirm whether the card was used — don't guess with the user's money. Leave the
        // hold for the transaction webhook / Stripe auto-release.
        log.warn('Cleanup could not read card; leaving hold for webhook/auto-release', {
          agent_id: agentId,
          purchase_id: purchase.id,
          card_id: cardId,
          error: readError instanceof Error ? readError.message : String(readError),
        });
        continue;
      }

      if (cardWasUsed) {
        await consumePurchaseWalletFunding(purchase.id);
        await prisma.purchaseSpend.updateMany({
          where: { id: purchase.id, status: PurchaseSpendStatus.HELD },
          data: { status: PurchaseSpendStatus.CLEARED },
        });
      } else {
        // Claim the reclaim before closing the card so a concurrent pass can't read the now
        // not-live card as merchant-spent while the funding is still FUNDED.
        const reclaimClaim = await beginPurchaseWalletReclaim(purchase.id);
        if (reclaimClaim.status === 'already_owned') {
          log.info('Purchase funding reclaim is already owned; skipping duplicate card close', {
            agent_id: agentId,
            purchase_id: purchase.id,
            card_id: cardId,
          });
          continue;
        }
        await activeCardProvider.closeCard(cardId);
        try {
          await reclaimPurchaseWalletFunding(
            purchase,
            'agent_cleanup_unspent_card',
            walletFundingProvider,
            reclaimClaim.status === 'owned'
              ? { reclaimLeaseToken: reclaimClaim.reclaimLeaseToken }
              : {}
          );
        } catch (reclaimError) {
          if (isWalletFundingConsumedDuringReclaimError(reclaimError)) {
            await prisma.purchaseSpend.updateMany({
              where: { id: purchase.id, status: PurchaseSpendStatus.HELD },
              data: { status: PurchaseSpendStatus.CLEARED },
            });
            continue;
          }
          log.error('Cleanup could not reclaim wallet funding; leaving Stripe hold in place', {
            agent_id: agentId,
            purchase_id: purchase.id,
            card_id: cardId,
            error: reclaimError instanceof Error ? reclaimError.message : String(reclaimError),
          });
          if (!isWalletFundingReleasePendingError(reclaimError)) {
            await prisma.purchaseSpend.update({
              where: { id: purchase.id },
              data: { status: PurchaseSpendStatus.FUNDING_RECLAIM_FAILED },
            });
          }
          continue;
        }
        if (purchase.stripePaymentIntentId) {
          try {
            await reversePurchasePaymentIntent(purchase.stripePaymentIntentId, purchase.id);
          } catch (refundError) {
            await prisma.purchaseSpend.update({
              where: { id: purchase.id },
              data: { status: PurchaseSpendStatus.REFUND_FAILED },
            });
            throw refundError;
          }
        }
        await prisma.purchaseSpend.update({
          where: { id: purchase.id },
          data: { status: PurchaseSpendStatus.VOIDED },
        });
      }
    } catch (error) {
      log.warn('Failed to clean up purchase card', {
        agent_id: agentId,
        purchase_id: purchase.id,
        card_id: cardId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Retry Stripe reversals whose AgentCard transfer was already reclaimed. */
export async function reconcileFailedPurchaseRefunds(
  scope?: PurchaseReconcileScope
): Promise<void> {
  const failedRefunds = await prisma.purchaseSpend.findMany({
    where: {
      ...reconcileUserFilter(scope),
      status: PurchaseSpendStatus.REFUND_FAILED,
      stripePaymentIntentId: { not: null },
    },
    select: { id: true, stripePaymentIntentId: true },
  });

  for (const purchase of failedRefunds) {
    if (purchase.stripePaymentIntentId === null) continue;
    try {
      const reversal = await reversePurchasePaymentIntent(
        purchase.stripePaymentIntentId,
        purchase.id
      );
      await prisma.purchaseSpend.update({
        where: { id: purchase.id },
        data: {
          status:
            reversal === 'refunded' ? PurchaseSpendStatus.REFUNDED : PurchaseSpendStatus.FAILED,
        },
      });
    } catch (error) {
      log.warn('Failed to retry purchase payment reversal', {
        purchase_id: purchase.id,
        stripe_payment_intent_id: purchase.stripePaymentIntentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Retry company-transfer release failures; refund only after MCP confirms released funds. */
export async function reconcileFailedPurchaseFundingReclaims(
  walletFundingProvider?: WalletFundingProvider,
  scope?: PurchaseReconcileScope,
  cardProvider?: CardProvider
): Promise<void> {
  const staleReclaimingBefore = new Date(Date.now() - STALE_RECLAIMING_MS);
  const purchases = await prisma.purchaseSpend.findMany({
    where: {
      ...reconcileUserFilter(scope),
      OR: [
        { status: PurchaseSpendStatus.FUNDING_RECLAIM_FAILED },
        {
          status: {
            in: [
              PurchaseSpendStatus.HELD,
              PurchaseSpendStatus.CHARGING,
              PurchaseSpendStatus.FUNDING_ABANDONED,
            ],
          },
          walletFunding: {
            is: { status: 'RECLAIMING', updatedAt: { lte: staleReclaimingBefore } },
          },
        },
      ],
      stripePaymentIntentId: { not: null },
    },
    select: {
      id: true,
      status: true,
      userId: true,
      agentId: true,
      cardId: true,
      totalCents: true,
      stripePaymentIntentId: true,
    },
  });

  for (const purchase of purchases) {
    try {
      if (purchase.cardId !== null) {
        const activeCardProvider =
          cardProvider ?? (await createCardProviderForAgent(purchase.userId, purchase.agentId));
        // close_card is provider-idempotent. Retrying it closes the crash window where a reclaim
        // lease committed but the worker died before the original close call.
        await activeCardProvider.closeCard(purchase.cardId);
      }
      const funding = await findWalletFundingByPurchaseId(purchase.id);
      let reclaimLeaseToken: string | undefined;
      if (
        funding !== null &&
        (funding.status === PurchaseWalletFundingStatus.FUNDED ||
          funding.status === PurchaseWalletFundingStatus.RECLAIM_FAILED ||
          funding.status === PurchaseWalletFundingStatus.RECLAIMING)
      ) {
        reclaimLeaseToken = randomUUID();
        const retryClaim = await claimWalletFundingReclaimRetry(funding.id, {
          reclaimIdempotencyKey:
            funding.reclaimIdempotencyKey ?? `purchase-wallet-reclaim:${purchase.id}`,
          reclaimLeaseToken,
          staleReclaimingBefore,
        });
        if (retryClaim.count === 0) {
          log.info(
            'Purchase funding reclaim retry is already owned; skipping duplicate provider call',
            {
              purchase_id: purchase.id,
              funding_id: funding.id,
            }
          );
          continue;
        }
      }
      await reclaimPurchaseWalletFunding(
        purchase,
        'failed_company_transfer_release_retry',
        walletFundingProvider,
        reclaimLeaseToken !== undefined &&
          funding !== null &&
          (funding.status === PurchaseWalletFundingStatus.FUNDED ||
            funding.status === PurchaseWalletFundingStatus.RECLAIM_FAILED ||
            funding.status === PurchaseWalletFundingStatus.RECLAIMING)
          ? { reclaimLeaseToken }
          : {}
      );
      if (purchase.stripePaymentIntentId !== null) {
        await reversePurchasePaymentIntent(purchase.stripePaymentIntentId, purchase.id);
      }
      await prisma.purchaseSpend.update({
        where: { id: purchase.id },
        data: { status: PurchaseSpendStatus.VOIDED },
      });
    } catch (error) {
      if (isWalletFundingConsumedDuringReclaimError(error)) {
        const consumedStatus =
          purchase.status === PurchaseSpendStatus.CHARGING ||
          purchase.status === PurchaseSpendStatus.FUNDING_ABANDONED
            ? PurchaseSpendStatus.CAPTURE_FAILED
            : PurchaseSpendStatus.CLEARED;
        await prisma.purchaseSpend.updateMany({
          where: {
            id: purchase.id,
            status: purchase.status,
          },
          data: { status: consumedStatus },
        });
        continue;
      }
      log.warn('Failed to retry purchase funding reclaim', {
        purchase_id: purchase.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Backstop for terminal status updates whose immediate purchase cleanup could not complete. */
export async function reconcileTerminalAgentPurchaseCards(
  cardProvider?: CardProvider,
  walletFundingProvider?: WalletFundingProvider,
  scope?: PurchaseReconcileScope
): Promise<void> {
  const purchases = await prisma.purchaseSpend.findMany({
    where: {
      ...reconcileUserFilter(scope),
      status: {
        in: [
          PurchaseSpendStatus.HELD,
          PurchaseSpendStatus.FUNDING_PENDING,
          PurchaseSpendStatus.FUNDING_ABANDONED,
        ],
      },
      agentId: { not: null },
      agent: {
        status: { in: ['COMPLETED', 'FAILED', 'OUT_OF_CREDITS', 'COST_LIMIT_REACHED'] },
      },
    },
    select: { agentId: true },
    distinct: ['agentId'],
  });

  for (const purchase of purchases) {
    if (purchase.agentId === null) continue;
    await cleanupAgentPurchaseCards(purchase.agentId, cardProvider, walletFundingProvider);
  }
}

/**
 * Backstop for holds that dissolved outside the normal agent cleanup/webhook paths. If the card is
 * still live, close it and reclaim the wallet funding. If the card was spent but Stripe can no
 * longer be captured, record `CAPTURE_FAILED` so finance can reconcile the org-wallet loss.
 */
export async function reconcileDissolvedPurchaseHolds(
  cardProvider?: CardProvider,
  walletFundingProvider?: WalletFundingProvider,
  scope?: PurchaseReconcileScope
): Promise<void> {
  const heldPurchases = await prisma.purchaseSpend.findMany({
    where: {
      ...reconcileUserFilter(scope),
      status: PurchaseSpendStatus.HELD,
      cardId: { not: null },
      stripePaymentIntentId: { not: null },
    },
    select: {
      id: true,
      userId: true,
      agentId: true,
      cardId: true,
      totalCents: true,
      stripePaymentIntentId: true,
    },
  });

  for (const purchase of heldPurchases) {
    const cardId = purchase.cardId;
    const paymentIntentId = purchase.stripePaymentIntentId;
    if (cardId === null || paymentIntentId === null) continue;

    let paymentIntent: unknown;
    try {
      paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    } catch (error) {
      log.warn('Could not retrieve Stripe hold while reconciling dissolved purchase hold', {
        purchase_id: purchase.id,
        stripe_payment_intent_id: paymentIntentId,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!hasDissolvedHold(paymentIntent)) continue;

    let activeCardProvider: CardProvider;
    let cardWasUsed: boolean;
    try {
      activeCardProvider =
        cardProvider ?? (await createCardProviderForAgent(purchase.userId, purchase.agentId));
      const details = await activeCardProvider.getDetails(cardId);
      cardWasUsed = await purchaseCardWasSpent(purchase.id, details);
    } catch (error) {
      log.warn('Could not read card after Stripe hold dissolved', {
        purchase_id: purchase.id,
        card_id: cardId,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (cardWasUsed) {
      await consumePurchaseWalletFunding(purchase.id);
      await prisma.purchaseSpend.updateMany({
        where: { id: purchase.id, status: PurchaseSpendStatus.HELD },
        data: { status: PurchaseSpendStatus.CAPTURE_FAILED },
      });
      log.error('Stripe hold dissolved after AgentCard card was spent', {
        purchase_id: purchase.id,
        card_id: cardId,
        stripe_payment_intent_id: paymentIntentId,
      });
      continue;
    }

    // Claim the reclaim before closing the card so a concurrent pass can't read the now not-live
    // card as merchant-spent while the funding is still FUNDED.
    const reclaimClaim = await beginPurchaseWalletReclaim(purchase.id);
    if (reclaimClaim.status === 'already_owned') {
      log.info('Purchase funding reclaim is already owned; skipping duplicate card close', {
        purchase_id: purchase.id,
        card_id: cardId,
      });
      continue;
    }
    await activeCardProvider.closeCard(cardId);
    try {
      await reclaimPurchaseWalletFunding(
        purchase,
        'stripe_hold_dissolved_unspent_card',
        walletFundingProvider,
        reclaimClaim.status === 'owned' ? { reclaimLeaseToken: reclaimClaim.reclaimLeaseToken } : {}
      );
    } catch (error) {
      if (isWalletFundingConsumedDuringReclaimError(error)) {
        await prisma.purchaseSpend.updateMany({
          where: { id: purchase.id, status: PurchaseSpendStatus.HELD },
          data: { status: PurchaseSpendStatus.CAPTURE_FAILED },
        });
        continue;
      }
      log.error('Failed to reclaim wallet funding after Stripe hold dissolved', {
        purchase_id: purchase.id,
        card_id: cardId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!isWalletFundingReleasePendingError(error)) {
        await prisma.purchaseSpend.update({
          where: { id: purchase.id },
          data: { status: PurchaseSpendStatus.FUNDING_RECLAIM_FAILED },
        });
      }
      continue;
    }
    await prisma.purchaseSpend.update({
      where: { id: purchase.id },
      data: { status: PurchaseSpendStatus.VOIDED },
    });
  }
}

export async function reconcileStaleChargingPurchases(
  walletFundingProvider?: WalletFundingProvider,
  scope?: PurchaseReconcileScope
): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_CHARGING_MS);
  const stalePurchases = await prisma.purchaseSpend.findMany({
    where: {
      ...reconcileUserFilter(scope),
      status: PurchaseSpendStatus.CHARGING,
      updatedAt: { lt: staleBefore },
    },
    select: {
      id: true,
      userId: true,
      agentId: true,
      cardId: true,
      totalCents: true,
      stripePaymentIntentId: true,
      updatedAt: true,
      walletFunding: { select: { status: true } },
    },
  });

  for (const purchase of stalePurchases) {
    if (purchase.cardId !== null) {
      const marked = await prisma.purchaseSpend.updateMany({
        where: {
          id: purchase.id,
          status: PurchaseSpendStatus.CHARGING,
          cardId: purchase.cardId,
          updatedAt: purchase.updatedAt,
        },
        data: { status: PurchaseSpendStatus.FUNDING_ABANDONED },
      });
      log.warn('Transferred interrupted issued card to funding compensation', {
        purchase_id: purchase.id,
        claimed: marked.count === 1,
      });
      continue;
    }

    if (
      purchase.cardId === null &&
      purchase.walletFunding !== null &&
      (purchase.walletFunding.status === PurchaseWalletFundingStatus.PENDING ||
        purchase.walletFunding.status === PurchaseWalletFundingStatus.FUNDED ||
        purchase.walletFunding.status === PurchaseWalletFundingStatus.FAILED)
    ) {
      const marked = await prisma.purchaseSpend.updateMany({
        where: {
          id: purchase.id,
          status: PurchaseSpendStatus.CHARGING,
          cardId: null,
          updatedAt: purchase.updatedAt,
        },
        data: { status: PurchaseSpendStatus.FUNDING_PENDING },
      });
      log.warn('Preserved stale AgentCard funding attempt for idempotent retry', {
        purchase_id: purchase.id,
        claimed: marked.count === 1,
      });
      // Even if the CAS lost, this stale snapshot must not reclaim a purchase that a newer retry
      // has already claimed and refreshed.
      continue;
    }

    try {
      await reclaimPurchaseWalletFunding(
        purchase,
        'stale_charging_purchase_reconciler',
        walletFundingProvider
      );
    } catch (error) {
      if (isWalletFundingConsumedDuringReclaimError(error)) {
        await prisma.purchaseSpend.update({
          where: { id: purchase.id },
          data: { status: PurchaseSpendStatus.CAPTURE_FAILED },
        });
        continue;
      }
      log.error('Failed to reclaim wallet funding for stale CHARGING purchase', {
        purchase_id: purchase.id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!isWalletFundingReleasePendingError(error)) {
        await prisma.purchaseSpend.update({
          where: { id: purchase.id },
          data: { status: PurchaseSpendStatus.FUNDING_RECLAIM_FAILED },
        });
      }
      continue;
    }

    if (purchase.stripePaymentIntentId !== null) {
      await cancelAuthorizedHold(purchase.stripePaymentIntentId).catch((error) => {
        log.warn('Failed to cancel Stripe hold for stale CHARGING purchase', {
          purchase_id: purchase.id,
          stripe_payment_intent_id: purchase.stripePaymentIntentId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    await prisma.purchaseSpend.update({
      where: { id: purchase.id },
      data: { status: PurchaseSpendStatus.FAILED },
    });
  }
}
