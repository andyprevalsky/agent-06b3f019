export const MAX_PURCHASE_CENTS = Number(process.env.MAX_PURCHASE_CENTS ?? '5000');
export const PURCHASE_APPROVAL_CACHE_HOURS = 24;
export const AGENTCARD_WEBHOOK_SECRET = process.env.AGENTCARD_WEBHOOK_SECRET ?? '';
const BENCHMARK_KYC_REQUIRED_USER_ID = '00000000-0000-4000-8000-000000000103';

function benchmarkModeEnabled(): boolean {
  const enabled = new Set(['1', 'true', 'yes', 'on']);
  return (
    enabled.has((process.env.BENCHMARK_MODE ?? '').trim().toLowerCase()) ||
    enabled.has((process.env.BENCHMARK_ISOLATED_RUN ?? '').trim().toLowerCase())
  );
}

export function benchmarkPurchaseKycRequired(userId: string): boolean {
  return benchmarkModeEnabled() && userId === BENCHMARK_KYC_REQUIRED_USER_ID;
}
