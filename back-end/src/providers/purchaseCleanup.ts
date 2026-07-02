import { PurchaseSpendStatus } from '@prisma/client';
import { createCardProvider, isCardLive, type CardProvider } from './card-provider';
import { prisma } from './database';
import { createLogger } from './logger';
import { cancelAuthorizedHold, captureAuthorizedHold } from './stripe';

const log = createLogger('PurchaseCleanup');

/**
 * Reconcile a HELD agent's purchase cards at session end — the primary "cancel on fail" hook (no
 * cron needed). For each still-HELD card we ask the card itself whether it was used:
 *   - still live (unspent) → the agent abandoned the buy → close the card + CANCEL the hold (VOIDED).
 *     No money moved, no refund churn.
 *   - already settled → the card WAS used but the `transaction.cleared` webhook hasn't landed yet →
 *     CAPTURE the hold so we actually collect (CLEARED), instead of canceling and eating the cost.
 *   - unreadable → fail safe: leave the hold for the webhook / Stripe's ~7-day auto-release.
 * All Stripe hold ops are idempotent, so racing with the webhook is safe.
 */
export async function cleanupAgentPurchaseCards(
  agentId: string,
  cardProvider?: CardProvider
): Promise<void> {
  const openPurchases = await prisma.purchaseSpend.findMany({
    where: {
      agentId,
      status: PurchaseSpendStatus.HELD,
      cardId: { not: null },
    },
    select: {
      id: true,
      cardId: true,
      stripePaymentIntentId: true,
    },
  });

  if (openPurchases.length > 0) {
    log.info(`Reconciling ${openPurchases.length} held purchase card(s) for agent ${agentId}`);
  }

  const activeCardProvider = cardProvider ?? createCardProvider();
  for (const purchase of openPurchases) {
    const cardId = purchase.cardId;
    if (cardId === null) continue;
    try {
      let cardWasUsed: boolean;
      try {
        const details = await activeCardProvider.getDetails(cardId);
        cardWasUsed = !isCardLive(details);
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
        if (purchase.stripePaymentIntentId) {
          await captureAuthorizedHold(purchase.stripePaymentIntentId);
        }
        await prisma.purchaseSpend.update({
          where: { id: purchase.id },
          data: { status: PurchaseSpendStatus.CLEARED },
        });
      } else {
        await activeCardProvider.closeCard(cardId);
        if (purchase.stripePaymentIntentId) {
          await cancelAuthorizedHold(purchase.stripePaymentIntentId);
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
