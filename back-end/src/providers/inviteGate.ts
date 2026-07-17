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

/**
 * The invite code that unconditionally clears the waitlist gate. Grandfathered
 * users were backfilled with it (migration 20260710163714_waitlist_gate_latam)
 * and admins hand it out to pull people off the waitlist. Single source of
 * truth — the invite-codes redemption path (service.ts) matches against it.
 */
export const WAITLIST_BYPASS_INVITE_CODE = 181818;

export interface GatedUserInput {
  userId: string;
  phone: string;
}

/** Digits-only form of a phone number (drops '+', spaces, punctuation). */
function phoneDigits(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '');
}

export interface OffWaitlistResult {
  /** True when a matching account was just flagged off the waitlist. */
  flagged: boolean;
  /** The account we flagged / found, if any. */
  userId: string | null;
  /** True when a matching account was already flagged off the waitlist. */
  alreadyOffWaitlist: boolean;
}

/**
 * Flag a phone number's account as invited off the waitlist. This does NOT
 * grant access on its own — they still need a subscription (or an invite code)
 * to clear the gate. The flag only tells onboarding to show the subscription
 * view instead of the "You're on the waitlist!" view at the end of the flow.
 * Matches on canonical E.164 digits. Idempotent. Returns flagged:false when no
 * account exists for the phone yet (phone-only waitlist entry).
 */
export async function markOffWaitlistByPhone(phone: string): Promise<OffWaitlistResult> {
  const digits = phoneDigits(phone);
  if (digits === '') return { flagged: false, userId: null, alreadyOffWaitlist: false };

  const user = await prisma.user.findFirst({
    where: { phone: { in: ['+' + digits, digits] } },
    select: { userId: true, offWaitlistAt: true },
  });
  if (user === null) return { flagged: false, userId: null, alreadyOffWaitlist: false };

  if (user.offWaitlistAt !== null) {
    return { flagged: false, userId: user.userId, alreadyOffWaitlist: true };
  }

  await prisma.user.update({
    where: { userId: user.userId },
    data: { offWaitlistAt: new Date() },
  });
  log.info('Flagged user off waitlist (subscribe at onboarding end)', { userId: user.userId });
  return { flagged: true, userId: user.userId, alreadyOffWaitlist: false };
}

/**
 * Whether a user currently holds an active (unexpired) paid subscription.
 * An active subscription clears the invite gate — subscription OR invite code
 * gets a user in.
 */
export async function hasActiveSubscription(userId: string): Promise<boolean> {
  const subscription = await prisma.subscription.findUnique({
    where: { userId },
    select: { currentPeriodEnd: true },
  });
  return subscription !== null && subscription.currentPeriodEnd.getTime() > Date.now();
}

/**
 * Whether a user is still behind the invite gate. Cleared by redeeming an
 * invite code (usedInviteCode) OR holding an active subscription. Unknown users
 * are gated: they haven't been through the invite flow.
 */
export async function isUserGated(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { userId },
    select: { usedInviteCode: true },
  });
  if (user === null) return true;
  if (user.usedInviteCode !== null) return false;
  return !(await hasActiveSubscription(userId));
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
