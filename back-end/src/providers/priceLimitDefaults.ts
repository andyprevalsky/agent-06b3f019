/**
 * Default task price-limit policy: min(account credits, $10).
 */

import { getUserUsage } from './credits';

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

/** Resolve the default price limit for a user from their live credit balance. */
export async function resolveDefaultPriceLimitCents(userId: string): Promise<number> {
  const usage = await getUserUsage(userId);
  return computeDefaultPriceLimitCents(usage.remaining);
}

/** Use explicit limit when provided; otherwise resolve from account credits. */
export async function resolvePriceLimitCents(
  userId: string,
  explicitCents: number | undefined
): Promise<number> {
  if (explicitCents !== undefined && explicitCents !== 0) {
    return explicitCents;
  }
  return resolveDefaultPriceLimitCents(userId);
}
