export const STRIPE_API_VERSION = '2025-02-24.acacia' as const;

export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? '';
export const STRIPE_SUBSCRIPTION_PRICE_ID = process.env.STRIPE_SUBSCRIPTION_PRICE_ID ?? '';
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

export const RETURN_URL_PRODUCTION = 'https://roselabs.ai/settings';
export const RETURN_URL_DEVELOPMENT = 'http://localhost:5173/settings';
export const SUBSCRIBE_FALLBACK_URL =
  process.env.SUBSCRIBE_FALLBACK_URL ?? 'https://roselabs.ai/subscribe';
