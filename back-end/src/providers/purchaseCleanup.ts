import { PurchaseSpendStatus } from '@prisma/client';
import { createCardProvider, type CardProvider } from './card-provider';
import { prisma } from './database';
import { createLogger } from './logger';
import { stripe } from './stripe';

const log = createLogger('PurchaseCleanup');

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
    log.info(`Closing ${openPurchases.length} held purchase card(s) for agent ${agentId}`);
  }

  const activeCardProvider = cardProvider ?? createCardProvider();
  for (const purchase of openPurchases) {
    try {
      await activeCardProvider.closeCard(purchase.cardId!);
      if (purchase.stripePaymentIntentId) {
        await stripe.refunds.create({
          payment_intent: purchase.stripePaymentIntentId,
          metadata: { purchaseSpendId: purchase.id, cleanupReason: 'agent_session_cleanup' },
        });
      }
      await prisma.purchaseSpend.update({
        where: { id: purchase.id },
        data: { status: PurchaseSpendStatus.REFUNDED },
      });
    } catch (error) {
      log.warn('Failed to clean up purchase card', {
        agent_id: agentId,
        purchase_id: purchase.id,
        card_id: purchase.cardId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
