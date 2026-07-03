export const TEST_PAYMENT_ENABLED =
  process.env.NODE_ENV !== 'production' && process.env.ENABLE_TEST_PAYMENT !== 'false';

export const TEST_PAYMENT_PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? '')
  .trim()
  .replace(/\/$/, '');

export function getPhoneBenchmarkPaymentAuditPathOverride(): string {
  return (process.env.PHONE_BENCHMARK_PAYMENT_AUDIT_PATH ?? '').trim();
}
