/**
 * Real-merchant checkout for /test_payment.
 *
 * AgentCard refuses `test_charge` on live cards ("Live cards are charged by real merchants") and
 * Stripe blocks live-mode raw-PAN tokenization, so a LIVE Rose-minted card can only be proven by an
 * actual acquirer authorization. Stripe collects the PAN on its own hosted page, which keeps this
 * backend out of PCI scope entirely.
 *
 * KEY SPLIT: every Stripe call in this file is the shop ACQUIRING a card, so it runs on the
 * dedicated merchant client (`TEST_PAYMENT_MERCHANT_STRIPE_SECRET_KEY`), never on the `stripe`
 * billing singleton. The acquirer must be LIVE for a live Rose card to authorize; billing
 * (subscriptions, customers, the personal purchase hold) stays test-mode until production customers
 * are migrated. Two roles, two keys — see providers/stripe.ts.
 */

import { randomUUID } from 'node:crypto';
import { settleRoseCardStripeCheckout } from '../../providers/agentcard/checkout-settlement';
import {
  findHeldPurchasesByTotal,
  type HeldPurchase,
} from '../../providers/agentcard/sandbox-settlement';
import { createCardProviderForAgent } from '../../providers/card-provider';
import { getTestPaymentMerchantStripeClient, type Stripe } from '../../providers/stripe';
import { calculateTotals, normalizeLineItems } from './catalog';
import { TEST_PAYMENT_CHECKOUT_RETURN_URL, TEST_PAYMENT_LIVE_LIFECYCLE_QUERY } from './config';
import { TestPaymentError } from './errors';
import type { TestPaymentConfirmation, TestPaymentLineItem } from './types';

/**
 * Resolve the merchant (acquirer) client, surfacing a misconfiguration as an actionable
 * TestPaymentError instead of a generic 500. The provider throws in production when the merchant
 * key is missing — falling back to the test-mode billing key there would silently make this shop
 * incapable of authorizing the live card it exists to prove.
 */
function merchantStripe(): Stripe {
  try {
    return getTestPaymentMerchantStripeClient();
  } catch (error) {
    throw new TestPaymentError(error instanceof Error ? error.message : String(error), 503);
  }
}

/**
 * Create a REAL Stripe Checkout session for the selected test-shop items.
 *
 * This is what turns /test_payment from a fixture into an actual merchant. AgentCard's `test_charge`
 * is sandbox-only ("Live cards are charged by real merchants"), and live-mode raw-PAN tokenization
 * is blocked by Stripe, so a hosted Checkout is the only way a LIVE Rose-minted card can be
 * authorized on real card rails. Stripe collects the PAN on its own page, keeping us out of PCI
 * scope entirely.
 */
interface CheckoutSessionDependencies {
  findHeldPurchasesByTotal?: (amountCents: number) => Promise<HeldPurchase[]>;
  /**
   * Resolve the minted card's last4 for a HELD purchase. Hosted Checkout is created BEFORE Stripe
   * collects the PAN, so amount-only matching cannot tell two same-total HELD rows apart — the
   * browser must send the card last4 it was given, and we prove it against the candidate cards
   * the same way sandbox settle proves by full PAN.
   */
  getCardLast4?: (userId: string, agentId: string | null, cardId: string) => Promise<string>;
}

function checkoutFeeLineItem(name: string, amountCents: number) {
  return {
    price_data: {
      currency: 'usd' as const,
      unit_amount: amountCents,
      product_data: { name },
    },
    quantity: 1,
  };
}

function normalizeCardLast4(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) return undefined;
  return digits.slice(-4);
}

async function defaultGetCardLast4(
  userId: string,
  agentId: string | null,
  cardId: string
): Promise<string> {
  const provider = await createCardProviderForAgent(userId, agentId);
  const details = await provider.getDetails(cardId);
  return details.pan.replace(/\s+/g, '').slice(-4);
}

/**
 * Pick the single HELD purchase this hosted Checkout is allowed to clear.
 *
 * Amount alone is not an identity: leftover HELD rows from prior / concurrent agents at the same
 * total (common for the $1.00 lifecycle probe) make a global amount scan return >1. Sandbox settle
 * already walks candidates and matches the charged PAN; hosted session creation happens *before*
 * Stripe sees a card, so the shopper/agent must supply the last4 of the Rose card they intend to
 * pay with.
 *
 * When `cardLast4` is present it is authoritative even if the amount scan returned exactly one
 * row — otherwise a lone stale HELD at $1.00 would silently bind the wrong purchase. Missing
 * last4 keeps the legacy single-match path and still fail-closes on ambiguity.
 */
async function resolveHeldPurchaseForCheckout(
  candidates: HeldPurchase[],
  cardLast4: string | undefined,
  getCardLast4: (userId: string, agentId: string | null, cardId: string) => Promise<string>
): Promise<HeldPurchase> {
  if (candidates.length === 0) {
    throw new TestPaymentError('No held Rose purchase matches this checkout total', 409);
  }

  if (cardLast4 !== undefined) {
    // Parallel last4 proofs: sequential AgentCard getDetails across leftover HELDs hung Place
    // order for minutes (fleet: many $1 HELD rows → checkout-session never returned). Fail-closed
    // still requires every readable candidate so duplicate last4s cannot bind the wrong hold.
    const carded = candidates.filter(
      (candidate): candidate is HeldPurchase & { cardId: string } => candidate.cardId !== null
    );
    const proofs = await Promise.all(
      carded.map(async (candidate) => {
        try {
          const last4 = (await getCardLast4(candidate.userId, candidate.agentId, candidate.cardId))
            .replace(/\D/g, '')
            .slice(-4);
          return { candidate, last4 } as const;
        } catch {
          // Unreadable card is not evidence of a match — skip and keep scanning.
          return null;
        }
      })
    );
    const matched: HeldPurchase[] = [];
    for (const proof of proofs) {
      if (proof === null) continue;
      if (proof.last4 === cardLast4) matched.push(proof.candidate);
    }
    if (matched.length === 1) {
      const purchase = matched[0];
      if (purchase !== undefined) return purchase;
    }
    if (matched.length === 0) {
      throw new TestPaymentError('No held Rose purchase matches this checkout card', 409);
    }
    throw new TestPaymentError(
      'Multiple held Rose purchases match this checkout total; refusing an ambiguous charge',
      409
    );
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    if (only === undefined) {
      throw new TestPaymentError('No held Rose purchase matches this checkout total', 409);
    }
    return only;
  }
  throw new TestPaymentError(
    'Multiple held Rose purchases match this checkout total; refusing an ambiguous charge',
    409
  );
}

export async function createTestPaymentCheckoutSession(
  input: { items?: TestPaymentLineItem[]; cardLast4?: unknown } | null | undefined,
  dependencies: CheckoutSessionDependencies = {}
): Promise<{ sessionId: string; url: string; totalCents: number }> {
  const lineItems = normalizeLineItems(input?.items ?? []);
  const totals = calculateTotals(lineItems);
  const findPurchases = dependencies.findHeldPurchasesByTotal ?? findHeldPurchasesByTotal;
  const getCardLast4 = dependencies.getCardLast4 ?? defaultGetCardLast4;
  const candidates = await findPurchases(totals.totalCents);
  const purchase = await resolveHeldPurchaseForCheckout(
    candidates,
    normalizeCardLast4(input?.cardLast4),
    getCardLast4
  );
  const stripeLineItems = [
    ...lineItems.map((item) => ({
      price_data: {
        currency: 'usd' as const,
        unit_amount: item.unitPriceCents,
        product_data: { name: item.name },
      },
      quantity: item.quantity,
    })),
    ...(totals.taxCents > 0 ? [checkoutFeeLineItem('Tax', totals.taxCents)] : []),
    ...(totals.shippingCents > 0 ? [checkoutFeeLineItem('Shipping', totals.shippingCents)] : []),
  ];
  // Acquirer side: the shop's own key, NOT the billing key.
  const session = await merchantStripe().checkout.sessions.create({
    mode: 'payment',
    line_items: stripeLineItems,
    client_reference_id: purchase.id,
    metadata: { purchaseId: purchase.id },
    success_url:
      `${TEST_PAYMENT_CHECKOUT_RETURN_URL}/test_payment?` +
      `benchmark=${TEST_PAYMENT_LIVE_LIFECYCLE_QUERY}&checkout_session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:
      `${TEST_PAYMENT_CHECKOUT_RETURN_URL}/test_payment?` +
      `benchmark=${TEST_PAYMENT_LIVE_LIFECYCLE_QUERY}&checkout=cancelled`,
    billing_address_collection: 'auto',
  });
  if (session.url === null || session.url === '') {
    throw new TestPaymentError('Stripe did not return a checkout URL', 502);
  }
  return { sessionId: session.id, url: session.url, totalCents: totals.totalCents };
}

/**
 * Reconcile a completed hosted Checkout back onto the Rose purchase record.
 *
 * Stripe has already captured by the time this runs. This only proves the session really is paid
 * and then marks the matching HELD purchase CLEARED — it must never move money itself.
 *
 * The session read is MERCHANT-side; the purchase's `stripePaymentIntentId` it carries through is
 * the BILLING-side hold on the user. They live on different Stripe accounts and different keys, and
 * this function must never try to act on the hold with the merchant client.
 */
export async function settleTestPaymentCheckoutSession(
  sessionId: string
): Promise<TestPaymentConfirmation> {
  const trimmed = sessionId.trim();
  if (trimmed === '') throw new TestPaymentError('checkout_session_id is required');

  // The session was created on the merchant account, so it can only be read back with the merchant
  // key — the billing key would 404 on it.
  const session = await merchantStripe().checkout.sessions.retrieve(trimmed, {
    expand: ['payment_intent.payment_method'],
  });
  if (session.payment_status !== 'paid') {
    throw new TestPaymentError(`Checkout session is ${session.payment_status}`, 402);
  }

  const paymentIntent = session.payment_intent;
  if (paymentIntent === null || typeof paymentIntent === 'string') {
    throw new TestPaymentError('Checkout session has no expanded payment intent', 502);
  }
  const paymentMethod = paymentIntent.payment_method;
  if (paymentMethod === null || typeof paymentMethod === 'string') {
    throw new TestPaymentError('Checkout session has no expanded payment method', 502);
  }
  const last4 = paymentMethod.card?.last4 ?? '';
  const amountCents = session.amount_total ?? 0;
  const clientReferenceId = session.client_reference_id?.trim() ?? '';
  const metadataPurchaseId = session.metadata?.purchaseId?.trim() ?? '';
  if (clientReferenceId === '' || metadataPurchaseId === '') {
    throw new TestPaymentError('Checkout session has no Rose purchase reference', 502);
  }
  if (clientReferenceId !== metadataPurchaseId) {
    throw new TestPaymentError('Checkout session purchase references do not match', 502);
  }

  const settlement = await settleRoseCardStripeCheckout({
    purchaseId: clientReferenceId,
    last4,
    amountCents,
  });
  return {
    orderId: `tp_${randomUUID().slice(0, 8)}`,
    status: 'succeeded',
    paymentIntentId: settlement.stripePaymentIntentId,
    purchaseId: settlement.purchaseId,
    cardId: settlement.cardId,
    receipt: {
      lineItems: [],
      totals: {
        subtotalCents: amountCents,
        taxCents: 0,
        shippingCents: 0,
        totalCents: amountCents,
      },
    },
  };
}
