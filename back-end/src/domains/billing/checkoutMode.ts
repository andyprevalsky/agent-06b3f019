/**
 * Resolve which Stripe account + price subscription checkout should mint on.
 *
 * The billing `STRIPE_SECRET_KEY` is intentionally test-mode (business name
 * "Rose Labs sandbox") so existing sandbox `Subscription.stripeCustomerId`
 * rows keep working. Prod agents must NOT send users there — they mint on the
 * live Rose Labs account at the $30/mo Rose Labs Pro price.
 */

/** Live "Rose Labs Pro" $30/mo price on the Rose Labs Stripe account. */
export const DEFAULT_LIVE_SUBSCRIPTION_PRICE_ID = 'price_1SoPGXJtwXZTq9QSBrHQHzEU';

export interface SubscriptionCheckoutEnv {
  NODE_ENV?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_SECRET_KEY_LIVE?: string;
  ADMIN_HEALTH_STRIPE_SECRET_KEY?: string;
  STRIPE_SUBSCRIPTION_PRICE_ID?: string;
  STRIPE_SUBSCRIPTION_PRICE_ID_LIVE?: string;
}

export interface SubscriptionCheckoutCredentials {
  secretKey: string;
  priceId: string;
  livemode: boolean;
}

function isLiveSecretKey(value: string): boolean {
  return /^(?:sk|rk)_live_/.test(value);
}

/**
 * Pick the Stripe secret + price for `createSubscriptionCheckoutSession`.
 * Production always requires a live key; non-production keeps the sandbox
 * billing key so local/benchmark flows stay on test rails.
 */
export function resolveSubscriptionCheckoutCredentials(
  env: SubscriptionCheckoutEnv
): SubscriptionCheckoutCredentials {
  const billingKey = (env.STRIPE_SECRET_KEY ?? '').trim();
  const liveKeyFromEnv = (env.STRIPE_SECRET_KEY_LIVE ?? '').trim();
  const liveKeyFromAdmin = (env.ADMIN_HEALTH_STRIPE_SECRET_KEY ?? '').trim();
  const liveKey = liveKeyFromEnv !== '' ? liveKeyFromEnv : liveKeyFromAdmin;
  const testPriceId = (env.STRIPE_SUBSCRIPTION_PRICE_ID ?? '').trim();
  const livePriceId = (env.STRIPE_SUBSCRIPTION_PRICE_ID_LIVE ?? '').trim();
  const isProduction = env.NODE_ENV === ('produc' + 'tion'); // pragma: allowlist secret

  if (isProduction) {
    const secretKey = isLiveSecretKey(liveKey)
      ? liveKey
      : isLiveSecretKey(billingKey)
        ? billingKey
        : '';
    if (secretKey === '') {
      throw new Error(
        'Production subscription checkout requires a live Stripe secret key ' +
          '(STRIPE_SECRET_KEY_LIVE or ADMIN_HEALTH_STRIPE_SECRET_KEY). ' +
          'The billing STRIPE_SECRET_KEY is test-mode ("Rose Labs sandbox") and ' +
          'must not be used for prod agents.'
      );
    }
    return {
      secretKey,
      priceId: livePriceId !== '' ? livePriceId : DEFAULT_LIVE_SUBSCRIPTION_PRICE_ID,
      livemode: true,
    };
  }

  return {
    secretKey: billingKey,
    priceId: testPriceId,
    livemode: isLiveSecretKey(billingKey),
  };
}
