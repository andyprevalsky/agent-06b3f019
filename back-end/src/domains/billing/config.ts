import type { SubscriptionCheckoutEnv } from './checkoutMode';

export const STRIPE_API_VERSION = '2025-02-24.acacia' as const;

export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? '';
// Trim at the source so a whitespace-only value is treated as missing by the
// `=== ''` guard in createSubscriptionCheckoutSession (and matches the
// production bootstrap validator, which rejects untrimmed / blank values).
export const STRIPE_SUBSCRIPTION_PRICE_ID = (process.env.STRIPE_SUBSCRIPTION_PRICE_ID ?? '').trim();
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

export const RETURN_URL_PRODUCTION = 'https://roselabs.ai/settings';
export const RETURN_URL_DEVELOPMENT = 'http://localhost:5173/settings';

/**
 * Read subscription-checkout credentials from process.env at call time.
 * Keeps domain service.ts free of direct `process.env` reads (lint rule) while
 * still reflecting NODE_ENV changes made by tests before the mint.
 */
export function getSubscriptionCheckoutEnv(): SubscriptionCheckoutEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_SECRET_KEY_LIVE: process.env.STRIPE_SECRET_KEY_LIVE,
    ADMIN_HEALTH_STRIPE_SECRET_KEY: process.env.ADMIN_HEALTH_STRIPE_SECRET_KEY,
    STRIPE_SUBSCRIPTION_PRICE_ID: (process.env.STRIPE_SUBSCRIPTION_PRICE_ID ?? '').trim(),
    STRIPE_SUBSCRIPTION_PRICE_ID_LIVE: (process.env.STRIPE_SUBSCRIPTION_PRICE_ID_LIVE ?? '').trim(),
  };
}
