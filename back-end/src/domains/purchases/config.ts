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
 * Dedicated synthetic identity for the AgentCard payment-lifecycle benchmarks
 * (`agent-payment-test-shop`, `-setup-resume`, `-idempotent-abandonment`, `-abandonment`).
 *
 * It MUST stay OUT of `ADMIN_USER_IDS` / `ADMIN_USER_IDS_EXTRA`: `resolveAndIssuePurchaseCard`
 * routes admins to `issueAdminCompanyCard`, which mints off the AgentCard org transfer and never
 * authorizes a personal Stripe hold. Those benchmarks assert the real end-user lifecycle
 * (hold -> mint -> capture -> clear/refund), so running them as an admin makes their
 * `stripeHold` assertions unsatisfiable by construction. Seeded by
 * `back-end/scripts/setup-benchmark-payment.ts`; the agents harness runs those tasks as this user.
 * The admin funding path keeps its own benchmark (`gate-subscription-card-mint-admin-bypass`).
 */
export const BENCHMARK_PAYMENT_LIFECYCLE_USER_ID = '00000000-0000-4000-8000-000000000106';

/**
 * Production counterpart of `BENCHMARK_PAYMENT_LIFECYCLE_USER_ID`, used by the two production-only
 * AgentCard lifecycle probes (`agent-payment-production-abandonment`, which is /deploy Step 13c,
 * and `agent-payment-production-purchase`). Same rule: it MUST stay out of `ADMIN_USER_IDS` /
 * `ADMIN_USER_IDS_EXTRA`, or `resolveAndIssuePurchaseCard` mints a company-funded card with no
 * personal Stripe hold and the probes' `stripeHold` / `stripePaymentIntentCount` assertions become
 * unsatisfiable.
 *
 * It is deliberately a SEPARATE id from the sandbox one rather than a shared "benchmark payer":
 * a user owns exactly one `Subscription` row (unique `userId`, one `stripeCustomerId`) and one
 * `Integration` row per name (unique `(userId, 'agentcard')`, one `cardholderId`). Production needs
 * LIVE-mode values there; the sandbox fixture needs TEST-mode values. One identity cannot hold
 * both, and sharing it would let `setup-benchmark-payment.ts` overwrite the live pointers with
 * sandbox ones (its default `DATABASE_URL` in `back-end/.env` is the production database).
 * Provisioned once by `back-end/scripts/setup-benchmark-payment.ts --live`.
 */
export const BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID = '00000000-0000-4000-8000-000000000107';

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
