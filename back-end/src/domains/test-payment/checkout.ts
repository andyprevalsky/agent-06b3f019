/**
 * Real-merchant checkout for /test_payment.
 *
 * AgentCard refuses `test_charge` on live cards ("Live cards are charged by real merchants") and
 * Stripe blocks live-mode raw-PAN tokenization, so a LIVE Rose-minted card can only be proven by an
 * actual acquirer authorization. Stripe collects the PAN on its own hosted page, which keeps this
 * backend out of PCI scope entirely.
 */

import { randomUUID } from 'node:crypto';
import { settleRoseCardStripeCheckout } from '../../providers/agentcard/checkout-settlement';
import { stripe } from '../../providers/stripe';
import { calculateTotals, normalizeLineItems } from './catalog';
import { TEST_PAYMENT_CHECKOUT_RETURN_URL } from './config';
import { TestPaymentError } from './errors';
import type { TestPaymentConfirmation, TestPaymentLineItem } from './types';

/**
 * Create a REAL Stripe Checkout session for the selected test-shop items.
 *
 * This is what turns /test_payment from a fixture into an actual merchant. AgentCard's `test_charge`
 * is sandbox-only ("Live cards are charged by real merchants"), and live-mode raw-PAN tokenization
 * is blocked by Stripe, so a hosted Checkout is the only way a LIVE Rose-minted card can be
 * authorized on real card rails. Stripe collects the PAN on its own page, keeping us out of PCI
 * scope entirely.
 */
export async function createTestPaymentCheckoutSession(input: {
  items: TestPaymentLineItem[];
}): Promise<{ sessionId: string; url: string; totalCents: number }> {
  const lineItems = normalizeLineItems(input.items);
  const totals = calculateTotals(lineItems);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: lineItems.map((item) => ({
      price_data: {
        currency: 'usd',
        unit_amount: item.unitPriceCents,
        product_data: { name: item.name },
      },
      quantity: item.quantity,
    })),
    success_url: `${TEST_PAYMENT_CHECKOUT_RETURN_URL}/test_payment?checkout_session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${TEST_PAYMENT_CHECKOUT_RETURN_URL}/test_payment?checkout=cancelled`,
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
 */
export async function settleTestPaymentCheckoutSession(
  sessionId: string
): Promise<TestPaymentConfirmation> {
  const trimmed = sessionId.trim();
  if (trimmed === '') throw new TestPaymentError('checkout_session_id is required');

  const session = await stripe.checkout.sessions.retrieve(trimmed, {
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

  const settlement = await settleRoseCardStripeCheckout({ last4, amountCents });
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
