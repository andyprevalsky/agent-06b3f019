import { PurchaseSpendStatus } from '@prisma/client';
import { createLogger } from './logger';
import { reversePurchasePaymentIntent } from './stripe';

const log = createLogger('PurchaseCleanup');

/** Called only after interrupted purchase funding has been reclaimed. */
export async function reverseStalePurchasePayment(purchase: {
  id: string;
  stripePaymentIntentId: string | null;
}): Promise<PurchaseSpendStatus> {
  if (purchase.stripePaymentIntentId === null) return PurchaseSpendStatus.FAILED;
  try {
    const reversal = await reversePurchasePaymentIntent(
      purchase.stripePaymentIntentId,
      purchase.id
    );
    return reversal === 'refunded' ? PurchaseSpendStatus.REFUNDED : PurchaseSpendStatus.FAILED;
  } catch (error) {
    log.warn('Failed to reverse Stripe payment for stale CHARGING purchase', {
      purchase_id: purchase.id,
      stripe_payment_intent_id: purchase.stripePaymentIntentId,
      error: error instanceof Error ? error.message : String(error),
    });
    // The canonical failed-refund reconciler retries this same payment and idempotency key.
    return PurchaseSpendStatus.REFUND_FAILED;
  }
}
