/**
 * Canonical Stripe SDK provider.
 * Domain code must import from here instead of 'stripe' directly.
 * ESLint no-restricted-imports enforces this in src/domains/.
 *
 * ── TWO STRIPE ROLES, TWO KEYS ───────────────────────────────────────────────────────────────
 * Rose sits on BOTH sides of a Stripe transaction and they must not share a key:
 *
 *   BILLING  (`STRIPE_SECRET_KEY`, the `stripe` singleton below)
 *     Subscriptions, customers, and the personal purchase hold/capture/refund lifecycle. This key
 *     deliberately STAYS test-mode: every production `Subscription.stripeCustomerId` was created in
 *     test mode, so flipping the global key to live orphans every real user's billing (a live-key
 *     lookup of an existing prod customer returns "No such customer"). Never change it to unblock
 *     an acquirer-side problem.
 *
 *   MERCHANT / ACQUIRER (`TEST_PAYMENT_MERCHANT_STRIPE_SECRET_KEY`,
 *                        `getTestPaymentMerchantStripeClient()`)
 *     The `/test_payment` shop taking a card at checkout. This side must be LIVE for a live
 *     Rose-minted AgentCard to be authorized on real card rails: AgentCard refuses `test_charge` on
 *     live cards ("Live cards are charged by real merchants") and Stripe test mode never touches
 *     the card networks, so a live PAN can only be proven by a real acquirer authorization.
 *
 * Transposing them is a silent, expensive failure in both directions — a merchant charge on the
 * billing key proves nothing about live rails, and billing on the merchant key writes real-money
 * customers Rose cannot reconcile. Keep the two accessors separate and single-purpose.
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

// ── /test_payment MERCHANT (acquirer) client ──────────────────────────────────────────────────

/** Env var holding the `/test_payment` shop's own Stripe secret key. Never the billing key. */
export const TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV = 'TEST_PAYMENT_MERCHANT_STRIPE_SECRET_KEY';

export interface ResolvedMerchantSecretKey {
  secretKey: string;
  /** True when no merchant key was configured and the BILLING key is standing in for it. */
  usedBillingFallback: boolean;
}

/**
 * Pick the key the `/test_payment` shop charges with. A configured merchant key ALWAYS wins; the
 * billing key is only a last-resort stand-in, and the caller must announce that (see
 * `getTestPaymentMerchantStripeClient`) rather than quietly acquiring on the billing account.
 */
export function resolveTestPaymentMerchantSecretKey(
  merchantKey: string | undefined,
  billingKey: string
): ResolvedMerchantSecretKey {
  const trimmed = merchantKey?.trim() ?? '';
  if (trimmed !== '') {
    return { secretKey: trimmed, usedBillingFallback: false };
  }
  return { secretKey: billingKey, usedBillingFallback: true };
}

/** One client per distinct merchant key, so repeated checkouts reuse a single connection pool. */
const merchantStripeClients = new Map<string, Stripe>();

/**
 * Stripe client for the `/test_payment` shop — the ACQUIRER side.
 *
 * When `TEST_PAYMENT_MERCHANT_STRIPE_SECRET_KEY` is absent:
 *   - production FAILS CLOSED. The only prod consumer is the live-lifecycle payment benchmark,
 *     whose entire purpose is proving a LIVE Rose card authorizes on real rails. Test-mode rails
 *     cannot do that, so a fallback there would turn a real capability check into a confusing
 *     Stripe decline (or worse, a green run that proved nothing). The throw names the fix.
 *   - non-production falls back to the billing key and says so LOUDLY on every call. Local dev and
 *     the sandbox benchmarks mint test-mode cards, which the test-mode billing key can authorize,
 *     so the shop stays usable — but the log makes it impossible to mistake that for live rails.
 *
 * This client is for merchant charges ONLY. Subscriptions, customers, and purchase holds keep using
 * the `stripe` billing singleton.
 */
export function getTestPaymentMerchantStripeClient(): Stripe {
  const resolved = resolveTestPaymentMerchantSecretKey(
    process.env[TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV],
    STRIPE_SECRET_KEY
  );
  if (resolved.usedBillingFallback) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `${TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV} is not configured. The /test_payment shop is the ` +
          'ACQUIRER for Rose-minted AgentCards and needs its OWN live-mode Stripe secret key; the ' +
          'global STRIPE_SECRET_KEY is the BILLING key and stays test-mode on purpose (every ' +
          'production Subscription.stripeCustomerId was created in test mode). Set ' +
          `${TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV} on the backend service — do NOT change ` +
          'STRIPE_SECRET_KEY.'
      );
    }
    log.warn(
      `${TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV} is not set; /test_payment is acquiring on the ` +
        'BILLING key. Test-mode rails never reach the card networks, so a LIVE Rose-minted ' +
        'AgentCard cannot be authorized on this path until the merchant key is configured.',
      { merchant_key_env: TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV, using_billing_fallback: true }
    );
    // Return the billing singleton itself rather than a second client on the same key, so the
    // fallback is observably identical to billing instead of masquerading as a merchant account.
    return stripe;
  }
  if (!/^(sk|rk)_(test|live)_/.test(resolved.secretKey)) {
    throw new Error(
      `${TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV} is not a Stripe secret/restricted key ` +
        '(expected an sk_live_/sk_test_/rk_live_/rk_test_ value)'
    );
  }
  let client = merchantStripeClients.get(resolved.secretKey);
  if (client === undefined) {
    client = new Stripe(resolved.secretKey, { apiVersion: STRIPE_API_VERSION });
    merchantStripeClients.set(resolved.secretKey, client);
  }
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
