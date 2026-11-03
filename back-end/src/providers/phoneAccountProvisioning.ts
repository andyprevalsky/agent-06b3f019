import { randomUUID } from 'node:crypto';
import type { User } from '@prisma/client';
import { prisma } from './database';
import {
  OLDEST_ACCOUNT_FIRST,
  canonicalPhone,
  isUniqueViolation,
  phoneOwnerWhere,
} from './phoneAccountLookup';

/**
 * Find-or-create the account for a phone number that proved possession of the
 * number itself (an inbound SMS or WhatsApp message), with a generated userId.
 *
 * The phone is stored in its canonical `+digits` form. Concurrent first
 * messages from one number race on the find; the unique User.phone index lets
 * exactly one create win, and the others resolve to that winner's account.
 */
export async function provisionUserByPhone(
  phone: string
): Promise<{ user: User; created: boolean }> {
  const findOwner = () =>
    prisma.user.findFirst({ where: phoneOwnerWhere(phone), orderBy: OLDEST_ACCOUNT_FIRST });
  const existing = await findOwner();
  if (existing) return { user: existing, created: false };
  const storedPhone = canonicalPhone(phone);
  if (storedPhone === null) throw new Error('Cannot provision a user without a phone number');
  try {
    const user = await prisma.user.create({
      data: { userId: randomUUID(), phone: storedPhone, isAnonymous: false },
    });
    return { user, created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await findOwner();
    if (winner === null) throw error;
    return { user: winner, created: false };
  }
}
