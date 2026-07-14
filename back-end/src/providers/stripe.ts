/**
 * Canonical Stripe SDK provider.
 * Domain code must import from here instead of 'stripe' directly.
 * ESLint no-restricted-imports enforces this in src/domains/.
 */
import Stripe from 'stripe';
import { createLogger } from './logger';

const STRIPE_API_VERSION = '2025-02-24.acacia' as const;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? '';

const log = createLogger('Stripe');

export const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: STRIPE_API_VERSION,
});

export type { Stripe };

/**
 * Stripe raises this error code when you capture/cancel a PaymentIntent that is already in a
 * terminal state (already captured, already canceled). Our settlement paths are driven by
 * at-least-once AgentCard webhooks AND an agent-cleanup backstop, so the same hold can legitimately
 * be acted on twice — we treat that collision as an idempotent no-op instead of an error.
 */
function isPaymentIntentTerminalState(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'payment_intent_unexpected_state'
  );
}

/**
 * Capture a previously-authorized manual-capture hold — this is the moment the user is actually
 * charged. Idempotent: capturing an already-captured or already-canceled PaymentIntent is a no-op.
 */
export async function captureAuthorizedHold(paymentIntentId: string): Promise<void> {
  try {
    await stripe.paymentIntents.capture(paymentIntentId);
  } catch (error) {
    if (isPaymentIntentTerminalState(error)) {
      log.warn('Capture on an already-settled/canceled hold — idempotent no-op', {
        payment_intent_id: paymentIntentId,
      });
      return;
    }
    throw error;
  }
}

/**
 * Release a previously-authorized hold — no money is taken and (unlike a refund) there is no
 * user-visible charge/refund churn or fee. Idempotent on an already-captured/canceled PaymentIntent.
 */
export async function cancelAuthorizedHold(paymentIntentId: string): Promise<void> {
  try {
    await stripe.paymentIntents.cancel(paymentIntentId);
  } catch (error) {
    if (isPaymentIntentTerminalState(error)) {
      log.warn('Cancel on an already-captured/canceled hold — idempotent no-op', {
        payment_intent_id: paymentIntentId,
      });
      return;
    }
    throw error;
  }
}

/**
 * Refund the captured funding charge for a purchase. All compensation paths use the same
 * purchase-scoped idempotency key and parameters, so cleanup, explicit close, and duplicate
 * webhooks cannot create multiple refunds when they race.
 */
export async function refundCapturedPurchase(
  paymentIntentId: string,
  purchaseId: string
): Promise<void> {
  await stripe.refunds.create(
    {
      payment_intent: paymentIntentId,
      metadata: { purchaseSpendId: purchaseId },
    },
    { idempotencyKey: `purchase-refund:${purchaseId}` }
  );
}
