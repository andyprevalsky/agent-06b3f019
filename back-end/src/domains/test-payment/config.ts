export const TEST_PAYMENT_ENABLED =
  process.env.NODE_ENV !== 'production' && process.env.ENABLE_TEST_PAYMENT !== 'false';

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === 'production';
}

export const TEST_PAYMENT_PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? '')
  .trim()
  .replace(/\/$/, '');

/**
 * The single JWT-authenticated end user permitted to reach the production
 * benchmark lifecycle routes. Fails closed: when BENCHMARK_USER_ID is unset or
 * blank there is NO configured benchmark user, so only the internal API key can
 * authorize production lifecycle access. Never fall back to a hardcoded account.
 */
export const PRODUCTION_BENCHMARK_USER_ID = (process.env.BENCHMARK_USER_ID ?? '').trim();

export function getPhoneBenchmarkPaymentAuditPathOverride(): string {
  return (process.env.PHONE_BENCHMARK_PAYMENT_AUDIT_PATH ?? '').trim();
}

export function getBenchmarkAgentCardCardholderIdOverride(): string {
  return (process.env.BENCHMARK_AGENTCARD_CARDHOLDER_ID ?? '').trim();
}

/**
 * Where Stripe returns the shopper after a hosted Checkout. Prefers the tunnel/base URL a benchmark
 * stack advertises so a cloud browser agent lands somewhere it can actually reach; falls back to
 * production. Stripe requires an absolute URL, so this can never be a relative path.
 */
export const TEST_PAYMENT_CHECKOUT_RETURN_URL = (
  TEST_PAYMENT_PUBLIC_BASE_URL !== '' ? TEST_PAYMENT_PUBLIC_BASE_URL : 'https://roselabs.ai'
).replace(/\/+$/, '');
