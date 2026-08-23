/**
 * Default task price-limit policy: min(account credits, $10).
 */

/** Hard cap for auto-defaulted task price limits ($10.00). */
export const MAX_DEFAULT_PRICE_LIMIT_CENTS = 1000;

/** Minimum allowed task price limit (1 cent). */
export const MIN_PRICE_LIMIT_CENTS = 1;

/**
 * Compute the default task price limit in cents from remaining account credits (dollars).
 * Returns min(remaining credits, $10), floored at 1 cent.
 */
export function computeDefaultPriceLimitCents(remainingCreditsDollars: number): number {
  const creditsCents = Math.round(Math.max(0, remainingCreditsDollars) * 100);
  return Math.max(MIN_PRICE_LIMIT_CENTS, Math.min(creditsCents, MAX_DEFAULT_PRICE_LIMIT_CENTS));
}
