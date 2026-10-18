import type { Prisma } from '@prisma/client';

/**
 * Canonical ordering for resolving a phone number to ONE account.
 *
 * User.phone is not unique, so a phone can match several rows. Every phone
 * lookup must pick the same row: the oldest account, with userId as a stable
 * tie-breaker. Without an ORDER BY, Postgres returns whichever row the plan
 * reaches first, so OTP login could land on a different account over time.
 */
export const OLDEST_ACCOUNT_FIRST: Prisma.UserOrderByWithRelationInput[] = [
  { createdAt: 'asc' },
  { userId: 'asc' },
];

/**
 * The stored forms a phone number may have: `+digits` and bare `digits`.
 * Strips spaces, dashes and parentheses first. Returns null when the input has
 * no digits, so callers never match rows with an empty phone.
 */
export function phoneLookupVariants(phone: string): [string, string] | null {
  const normalized = phone.replace(/[\s\-()]/g, '');
  const digitsOnly = normalized.replace(/\+/g, '');
  if (digitsOnly.length === 0) {
    return null;
  }
  const phoneWithPlus = normalized.startsWith('+') ? normalized : `+${normalized}`;
  const phoneWithoutPlus = normalized.startsWith('+') ? normalized.slice(1) : normalized;
  return [phoneWithPlus, phoneWithoutPlus];
}
