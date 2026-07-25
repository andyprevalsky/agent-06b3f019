/**
 * Canonical Stripe SDK provider.
 * Domain code must import from here instead of 'stripe' directly.
 * ESLint no-restricted-imports enforces this in src/domains/.
 */
import Stripe from 'stripe';
import { createLogger } from './logger';

const STRIPE_API_VERSION = '2025-02-24.acacia' as const;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? '';

export function resolveStripeMetricsSecretKey(
  adminHealthKey: string | undefined,
  billingKey: string
): string {
  return adminHealthKey?.trim() || billingKey;
}

export function assertStripeMetricsAccountId(expected: string, actual: string): void {
  if (expected.trim() === '') {
    throw new Error('ADMIN_HEALTH_STRIPE_ACCOUNT_ID is required');
  }
  if (actual !== expected) {
    throw new Error(`Admin health Stripe account mismatch: expected ${expected}, got ${actual}`);
  }
}

const STRIPE_METRICS_SECRET_KEY = resolveStripeMetricsSecretKey(
  process.env.ADMIN_HEALTH_STRIPE_SECRET_KEY,
  STRIPE_SECRET_KEY
);
const STRIPE_METRICS_ACCOUNT_ID = process.env.ADMIN_HEALTH_STRIPE_ACCOUNT_ID?.trim() ?? '';

const log = createLogger('Stripe');

export const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: STRIPE_API_VERSION,
});

let stripeMetricsClient: Stripe | null = null;
let stripeMetricsAccountVerification: Promise<void> | null = null;

export function getStripeMetricsClient(): Stripe {
  if (!/^(sk|rk)_live_/.test(STRIPE_METRICS_SECRET_KEY)) {
    throw new Error('Admin health requires a live-mode Stripe secret key');
  }
  stripeMetricsClient ??= new Stripe(STRIPE_METRICS_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION,
  });
  return stripeMetricsClient;
}

export async function getVerifiedStripeMetricsClient(): Promise<Stripe> {
  const client = getStripeMetricsClient();
  stripeMetricsAccountVerification ??= client.accounts
    .retrieve()
    .then((account) => {
      assertStripeMetricsAccountId(STRIPE_METRICS_ACCOUNT_ID, account.id);
    })
    .catch((error: unknown) => {
      stripeMetricsAccountVerification = null;
      throw error;
    });
  await stripeMetricsAccountVerification;
  return client;
}

export type { Stripe };

/**
 * Capture a previously-authorized manual-capture hold — this is the moment the user is actually
 * charged. A lost/terminal response is only considered successful after re-reading Stripe and
 * proving that the intent was captured; a canceled intent must never be returned as a usable card.
 */
export async function captureAuthorizedHold(paymentIntentId: string): Promise<void> {
  try {
    await stripe.paymentIntents.capture(paymentIntentId);
  } catch (error) {
    let intent: ReturnType<typeof paymentIntentStatus>;
    try {
      intent = paymentIntentStatus(await stripe.paymentIntents.retrieve(paymentIntentId));
    } catch {
      throw error;
    }
    if (paymentIntentWasCaptured(intent)) {
      log.warn('Capture response was ambiguous, but Stripe confirms the charge succeeded', {
        payment_intent_id: paymentIntentId,
      });
      return;
    }
    throw error;
  }
}

/**
 * Release a previously-authorized hold — no money is taken and (unlike a refund) there is no
 * user-visible charge/refund churn or fee. An ambiguous response is only successful after Stripe
 * confirms cancellation; if a concurrent capture won, the caller must retry through refund logic.
 */
export async function cancelAuthorizedHold(paymentIntentId: string): Promise<void> {
  try {
    await stripe.paymentIntents.cancel(paymentIntentId);
  } catch (error) {
    let intent: ReturnType<typeof paymentIntentStatus>;
    try {
      intent = paymentIntentStatus(await stripe.paymentIntents.retrieve(paymentIntentId));
    } catch {
      throw error;
    }
    if (intent.status === 'canceled') {
      log.warn('Cancel response was ambiguous, but Stripe confirms the hold was canceled', {
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

function paymentIntentStatus(paymentIntent: unknown): {
  status?: string;
  amountCapturable?: number;
  amountReceived?: number;
} {
  const candidate = paymentIntent as {
    status?: unknown;
    amount_capturable?: unknown;
    amount_received?: unknown;
  };
  return {
    status: typeof candidate.status === 'string' ? candidate.status : undefined,
    amountCapturable:
      typeof candidate.amount_capturable === 'number' ? candidate.amount_capturable : undefined,
    amountReceived:
      typeof candidate.amount_received === 'number' ? candidate.amount_received : undefined,
  };
}

function paymentIntentWasCaptured(intent: ReturnType<typeof paymentIntentStatus>): boolean {
  return (
    intent.status === 'succeeded' ||
    (intent.amountReceived !== undefined && intent.amountReceived > 0)
  );
}

/**
 * Reverse a purchase PaymentIntent after its AgentCard funding was reclaimed.
 * Manual-capture holds must be canceled; only already-captured charges can be refunded.
 */
export async function reversePurchasePaymentIntent(
  paymentIntentId: string,
  purchaseId: string
): Promise<'canceled' | 'refunded' | 'noop'> {
  const intent = paymentIntentStatus(await stripe.paymentIntents.retrieve(paymentIntentId));
  if (intent.status === 'canceled') {
    return 'noop';
  }
  if (
    intent.status === 'requires_capture' ||
    (intent.amountCapturable !== undefined && intent.amountCapturable > 0)
  ) {
    await cancelAuthorizedHold(paymentIntentId);
    return 'canceled';
  }
  if (
    intent.status === 'requires_payment_method' &&
    (intent.amountReceived === undefined || intent.amountReceived === 0)
  ) {
    return 'noop';
  }
  await refundCapturedPurchase(paymentIntentId, purchaseId);
  return 'refunded';
}
