/**
 * Benchmark payment identities shared across domains.
 *
 * These ids are consumed by BOTH `domains/purchases` (which mints and settles
 * the cards) and `domains/test-payment` (whose harness endpoints clear leftover
 * state before a probe). A constant needed by two domains belongs in providers/
 * — importing it across the domain boundary is what the structural gate rejects.
 */

/**
 * Non-admin production identity for the AgentCard lifecycle probe.
 *
 * Must NOT be an admin (`ADMIN_USER_IDS` / `ADMIN_USER_IDS_EXTRA`), or
 * `resolveAndIssuePurchaseCard` mints a company-funded card with no personal
 * Stripe hold and the probes' `stripeHold` / `stripePaymentIntentCount`
 * assertions become unsatisfiable.
 *
 * It is deliberately a SEPARATE id from the sandbox one rather than a shared
 * "benchmark payer": a user owns exactly one `Subscription` row (unique
 * `userId`, one `stripeCustomerId`) and one `Integration` row per name (unique
 * `(userId, 'agentcard')`, one `cardholderId`). Production needs LIVE-mode
 * values there; the sandbox fixture needs TEST-mode values. One identity cannot
 * hold both, and sharing it would let `setup-benchmark-payment.ts` overwrite the
 * live pointers with sandbox ones (its default `DATABASE_URL` in
 * `back-end/.env` is the production database).
 *
 * Provisioned once by `back-end/scripts/setup-benchmark-payment.ts --live`.
 */
export const BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID = '00000000-0000-4000-8000-000000000107';

/**
 * Owner account the live production lifecycle probe runs as (2026-11-14). Its benchmark agents bill
 * a dedicated live Stripe customer (providers/ownerLifecycleBilling.ts), never its Subscription.
 */
export const BENCHMARK_PAYMENT_LIFECYCLE_OWNER_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
