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
 * Strips spaces, dashes and parentheses first, and treats a leading `00` or
 * `+00` international prefix as `+`. Returns null when the input has no digits, so
 * callers never match rows with an empty phone.
 */
export function phoneLookupVariants(phone: string): [string, string] | null {
  const stripped = phone.replace(/[\s\-()]/g, '');
  const normalized = stripped.replace(/^\+?00/, '+');
  const digitsOnly = normalized.replace(/\+/g, '');
  if (digitsOnly.length === 0) {
    return null;
  }
  const phoneWithPlus = normalized.startsWith('+') ? normalized : `+${normalized}`;
  const phoneWithoutPlus = normalized.startsWith('+') ? normalized.slice(1) : normalized;
  return [phoneWithPlus, phoneWithoutPlus];
}

/**
 * Prisma filter matching every stored form of `phone`. Falls back to the exact
 * value when it has no digits (matches nothing useful, never every row).
 */
export function phoneOwnerWhere(phone: string): Prisma.UserWhereInput {
  const variants = phoneLookupVariants(phone);
  return variants === null ? { phone } : { phone: { in: variants } };
}
