import { stripe } from '../../providers/stripe';
import * as repo from './repo';
import {
  IS_PRODUCTION,
  RETURN_URL_PRODUCTION,
  RETURN_URL_DEVELOPMENT,
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
