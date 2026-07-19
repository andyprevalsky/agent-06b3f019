export const STRIPE_API_VERSION = '2025-02-24.acacia' as const;

export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? '';
// Trim at the source so a whitespace-only value is treated as missing by the
// `=== ''` guard in createSubscriptionCheckoutSession (and matches the
// production bootstrap validator, which rejects untrimmed / blank values).
export const STRIPE_SUBSCRIPTION_PRICE_ID = (process.env.STRIPE_SUBSCRIPTION_PRICE_ID ?? '').trim();
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

export const RETURN_URL_PRODUCTION = 'https://roselabs.ai/settings';
export const RETURN_URL_DEVELOPMENT = 'http://localhost:5173/settings';
