/**
 * Default task price-limit policy.
 */

/** Default price limit for new tasks ($10.00). */
export const DEFAULT_TASK_PRICE_LIMIT_CENTS = 1000;

/** Use explicit limit when provided; otherwise use the $10 default. */
export function resolvePriceLimitCents(explicitCents: number | undefined): number {
  if (explicitCents !== undefined && explicitCents !== 0) {
    return explicitCents;
  }
  return DEFAULT_TASK_PRICE_LIMIT_CENTS;
}
