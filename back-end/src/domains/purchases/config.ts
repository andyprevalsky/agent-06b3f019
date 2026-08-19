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

// A retryable company-funding attempt keeps its Stripe authorization while the agent is actively
// retrying. Once that window expires, the compensator cancels the hold and continues reconciling
// AgentCard under FUNDING_ABANDONED so a late provider success can never become an orphan.
export const PURCHASE_FUNDING_PENDING_ABANDON_MS = parsePositiveIntEnv(
  'PURCHASE_FUNDING_PENDING_ABANDON_MS',
  process.env.PURCHASE_FUNDING_PENDING_ABANDON_MS,
  12 * 60 * 1000
);

// Bounds for the AgentCard company-funding confirmation retry loop.
export const AGENTCARD_COMPANY_FLOW_MAX_WAIT_MS = parsePositiveIntEnv(
  'AGENTCARD_COMPANY_FLOW_MAX_WAIT_MS',
  process.env.AGENTCARD_COMPANY_FLOW_MAX_WAIT_MS,
  45 * 1000
);
export const AGENTCARD_COMPANY_FLOW_RETRY_MS = parsePositiveIntEnv(
  'AGENTCARD_COMPANY_FLOW_RETRY_MS',
  process.env.AGENTCARD_COMPANY_FLOW_RETRY_MS,
  2 * 1000
);
const BENCHMARK_KYC_REQUIRED_USER_ID = '00000000-0000-4000-8000-000000000103';

/**
 * Disposable non-admin identity for charged-path unit/blackbox fixtures.
 *
 * Isolated sandbox AgentCard lifecycle benches no longer run as this user: they
 * run as `BENCHMARK_PAYMENT_LIFECYCLE_ADMIN_RUN_USER_ID` with
 * `BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH` so credit checks stay unlimited-admin
 * while minting still goes through `chargeAndIssueCard`. Keep this id out of
 * `ADMIN_USER_IDS` so those in-process fixtures can still exercise the
 * non-admin charged path without the force flag. The admin no-force path keeps
 * its own benchmark (`gate-subscription-card-mint-admin-bypass`).
 */
export const BENCHMARK_PAYMENT_LIFECYCLE_USER_ID = '00000000-0000-4000-8000-000000000106';

function benchmarkModeEnabled(): boolean {
  const enabled = new Set(['1', 'true', 'yes', 'on']);
  return (
    enabled.has((process.env.BENCHMARK_MODE ?? '').trim().toLowerCase()) ||
    enabled.has((process.env.BENCHMARK_ISOLATED_RUN ?? '').trim().toLowerCase())
  );
}

/**
 * Isolated sandbox AgentCard lifecycle benches run as the default admin account
 * (`1f85ff25-…`) so credit checks keep the unlimited-admin path. This env flag
 * (only honored in benchmark/isolated mode) forces `resolveAndIssuePurchaseCard`
 * onto `chargeAndIssueCard` so `stripeHold` / `payment_approval` stay reachable.
 * Never honored in production process env: `benchmarkModeEnabled()` is false there.
 */
export const BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH_ENV =
  'BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH';
export const BENCHMARK_PAYMENT_LIFECYCLE_ADMIN_RUN_USER_ID =
  '1f85ff25-6e29-4c1b-8739-f917bd101a30';

export function benchmarkForceCustomerPurchasePath(): boolean {
  if (!benchmarkModeEnabled()) return false;
  const enabled = new Set(['1', 'true', 'yes', 'on']);
  return enabled.has(
    (process.env.BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH ?? '').trim().toLowerCase()
  );
}

export function benchmarkPurchaseKycRequired(userId: string): boolean {
  return benchmarkModeEnabled() && userId === BENCHMARK_KYC_REQUIRED_USER_ID;
}
