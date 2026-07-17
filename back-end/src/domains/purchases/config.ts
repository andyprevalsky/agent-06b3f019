/**
 * Parse an env-configured positive-integer amount/duration, failing startup on invalid input.
 * `Number()` silently yields NaN/Infinity/zero/negatives, which would break the lifecycle retry
 * loops (a NaN deadline never passes, a non-positive interval hot-loops), so reject them here.
 */
function parsePositiveIntEnv(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer, got "${raw}"`);
  }
  return parsed;
}

export const MAX_PURCHASE_CENTS = parsePositiveIntEnv(
  'MAX_PURCHASE_CENTS',
  process.env.MAX_PURCHASE_CENTS,
  5000
);
export const PURCHASE_APPROVAL_CACHE_HOURS = 24;
export const AGENTCARD_WEBHOOK_SECRET = process.env.AGENTCARD_WEBHOOK_SECRET ?? '';

// A CHARGING purchase older than this is treated as stale and recovered/reconciled.
export const PURCHASE_STALE_CHARGING_MS = parsePositiveIntEnv(
  'PURCHASE_STALE_CHARGING_MS',
  process.env.PURCHASE_STALE_CHARGING_MS,
  15 * 60 * 1000
);

// Bounds for the AgentCard company-funding confirmation retry loop.
export const AGENTCARD_COMPANY_FLOW_MAX_WAIT_MS = parsePositiveIntEnv(
  'AGENTCARD_COMPANY_FLOW_MAX_WAIT_MS',
  process.env.AGENTCARD_COMPANY_FLOW_MAX_WAIT_MS,
  60 * 1000
);
export const AGENTCARD_COMPANY_FLOW_RETRY_MS = parsePositiveIntEnv(
  'AGENTCARD_COMPANY_FLOW_RETRY_MS',
  process.env.AGENTCARD_COMPANY_FLOW_RETRY_MS,
  2 * 1000
);
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
