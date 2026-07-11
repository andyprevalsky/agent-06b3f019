/**
 * Invite-gate provider — waitlist gating shared across domains.
 *
 * Used by invite-codes (gate check + waitlist recording) and agents
 * (server-side enforcement on agent creation). Lives in providers/ because
 * domains must not import each other's services.
 */

import { prisma } from './database';
import { createLogger } from './logger';

const log = createLogger('InviteGate');

export interface GatedUserInput {
  userId: string;
  phone: string;
}

/**
 * Whether a user is still behind the invite gate (no invite code used).
 * Unknown users are gated: they haven't been through the invite flow.
 */
export async function isUserGated(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { userId },
    select: { usedInviteCode: true },
  });
  return user === null || user.usedInviteCode === null;
}

/**
 * Record a logged-in-but-gated user on the waitlist (phone-based entry).
 * Best-effort: failures are logged, never thrown — waitlist bookkeeping must
 * not block the invite-gate check.
 */
export async function registerGatedUser(input: GatedUserInput): Promise<void> {
  if (typeof input.phone !== 'string' || input.phone === '') return;
  // Supabase JWTs carry the phone claim without a leading '+'; store canonical E.164.
  const digits = input.phone.replace(/\D/g, '');
  if (digits === '') return;
  try {
    const user = await prisma.user.findUnique({
      where: { userId: input.userId },
      select: { name: true },
    });
    await prisma.waitlist.upsert({
      where: { phone: '+' + digits },
      create: {
        phone: '+' + digits,
        name: user?.name ?? '',
        variant: 'gated-login',
      },
      update: {},
    });
  } catch (error) {
    log.error('Failed to record gated user on waitlist', {
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
