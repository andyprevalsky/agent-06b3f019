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

  // User.phone is not unique and may be stored as '+digits' or bare 'digits'.
  const candidates = await prisma.user.findMany({
    where: { phone: { in: ['+' + digits, digits] } },
    select: { userId: true, offWaitlistAt: true },
  });
  if (candidates.length === 0) return { flagged: false, userId: null, alreadyOffWaitlist: false };

  // Prefer a not-yet-flagged account so a re-send doesn't report already-off
  // when another account for the same number is still gated.
  const target = candidates.find((user) => user.offWaitlistAt === null) ?? candidates[0];
  if (target.offWaitlistAt !== null) {
    return { flagged: false, userId: target.userId, alreadyOffWaitlist: true };
  }

  // Conditional update: only stamps when still null, so two concurrent admin
  // requests can't both report a fresh flag (the loser sees count 0).
  const updated = await prisma.user.updateMany({
    where: { userId: target.userId, offWaitlistAt: null },
    data: { offWaitlistAt: new Date() },
  });
  if (updated.count === 0) {
    return { flagged: false, userId: target.userId, alreadyOffWaitlist: true };
  }
  log.info('Flagged user off waitlist (subscribe at onboarding end)', { userId: target.userId });
  return { flagged: true, userId: target.userId, alreadyOffWaitlist: false };
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
