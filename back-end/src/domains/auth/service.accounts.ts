/**
 * OTP-login account helpers: one phone maps to one account (unique User.phone).
 */

import { createLogger } from '../../providers/logger';
import { isUniqueViolation } from '../../providers/phoneAccountLookup';
import * as repo from './repo';

const log = createLogger('Auth');

/**
 * Apply OTP-login updates. If another account claimed the phone after the
 * owner check (unique User.phone), keep the login and the other updates and
 * simply leave the phone off this account.
 */
export async function applyUserUpdates(
  userId: string,
  updates: { phone?: string; name?: string; isAnonymous?: boolean }
): Promise<void> {
  try {
    await repo.updateUser(userId, updates);
  } catch (error) {
    if (!isUniqueViolation(error) || updates.phone === undefined) throw error;
    const rest = { ...updates };
    delete rest.phone;
    log.warn('Phone was claimed by another account during OTP login', { user_id: userId });
    if (Object.keys(rest).length > 0) await repo.updateUser(userId, rest);
  }
}

/** The account a concurrent OTP login created: this userId, else the phone's owner. */
export async function resolveRacedAccount(
  userId: string,
  phone: string
): Promise<NonNullable<Awaited<ReturnType<typeof repo.findUserById>>>> {
  const sameUser = await repo.findUserById(userId);
  if (sameUser !== null) return sameUser;
  const owner = await repo.findUserByPhone(phone);
  const ownerRow = owner === null ? null : await repo.findUserById(owner.userId);
  if (ownerRow === null) throw new Error('OTP login lost a create race but no account owns it');
  return ownerRow;
}
