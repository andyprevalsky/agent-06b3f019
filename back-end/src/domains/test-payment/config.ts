export const TEST_PAYMENT_ENABLED =
  process.env.NODE_ENV !== 'production' && process.env.ENABLE_TEST_PAYMENT !== 'false';

export const TEST_PAYMENT_PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? '')
  .trim()
  .replace(/\/$/, '');

export const PRODUCTION_BENCHMARK_USER_ID = (
  process.env.BENCHMARK_USER_ID ?? '1f85ff25-6e29-4c1b-8739-f917bd101a30'
).trim();

export function getPhoneBenchmarkPaymentAuditPathOverride(): string {
  return (process.env.PHONE_BENCHMARK_PAYMENT_AUDIT_PATH ?? '').trim();
}
