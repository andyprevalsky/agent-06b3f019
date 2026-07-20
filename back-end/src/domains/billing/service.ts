import { stripe } from '../../providers/stripe';
import * as repo from './repo';
import {
  IS_PRODUCTION,
  RETURN_URL_PRODUCTION,
  RETURN_URL_DEVELOPMENT,
  STRIPE_SUBSCRIPTION_PRICE_ID,
} from './config';

export class NotFoundError extends Error {
  constructor(msg: string) {
    super(msg);
  }
}

export async function createPortalSession(userId: string): Promise<{ url: string }> {
  // Get user's subscription to find their Stripe customer ID
  const subscription = await repo.findSubscriptionByUserId(userId);

  if (!subscription || !subscription.stripeCustomerId) {
    throw new NotFoundError('You need an active subscription to access the billing portal.');
  }

  // Determine return URL based on environment
  const returnUrl = IS_PRODUCTION ? RETURN_URL_PRODUCTION : RETURN_URL_DEVELOPMENT;

  // Create a billing portal session
  const portalSession = await stripe.billingPortal.sessions.create({
    customer: subscription.stripeCustomerId,
    return_url: returnUrl,
  });

  return { url: portalSession.url };
}

export async function createSubscriptionCheckoutSession(userId: string): Promise<{ url: string }> {
  const returnUrl = IS_PRODUCTION ? RETURN_URL_PRODUCTION : RETURN_URL_DEVELOPMENT;

  if (STRIPE_SUBSCRIPTION_PRICE_ID === '') {
    throw new Error('STRIPE_SUBSCRIPTION_PRICE_ID is required');
  }

  const session = await stripe.checkout.sessions.create(
    {
      mode: 'subscription',
      client_reference_id: userId,
      line_items: [{ price: STRIPE_SUBSCRIPTION_PRICE_ID, quantity: 1 }],
      success_url: `${returnUrl}?subscription=success`,
      cancel_url: `${returnUrl}?subscription=cancelled`,
      allow_promotion_codes: true,
    },
    // Per-user idempotency: the subscription gate that mints this is a per-user
    // singleton and its Temporal mint activity is at-least-once, so a retry must
    // reuse the same Checkout session (within Stripe's 24h key window) instead of
    // creating a duplicate. Params are stable per user+env.
    { idempotencyKey: `subscription-checkout:${userId}` }
  );

  if (session.url === null || session.url === '') {
    throw new Error('Stripe did not return a checkout URL');
  }

  return { url: session.url };
}
