/**
 * Invite-gate provider — waitlist gating shared across domains.
 *
 * Used by invite-codes (gate check + waitlist recording) and agents
 * (server-side enforcement on agent creation). Lives in providers/ because
 * domains must not import each other's services.
 */

import { prisma } from './database';
import { createLogger } from './logger';
import { OLDEST_ACCOUNT_FIRST, phoneOwnerWhere } from './phoneAccountLookup';
import { normalizeWaitlistEmail } from './waitlistIdentity';

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

  // Legacy rows may hold one number as '+digits' or bare 'digits'.
  // One phone maps to its oldest account — the one phone login resolves to.
  const target = await prisma.user.findFirst({
    where: phoneOwnerWhere(phone),
    orderBy: OLDEST_ACCOUNT_FIRST,
    select: { userId: true, offWaitlistAt: true },
  });
  if (target === null) return { flagged: false, userId: null, alreadyOffWaitlist: false };

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
  const phone = '+' + digits;
  try {
    const user = await prisma.user.findUnique({
      where: { userId: input.userId },
      select: { name: true, email: true },
    });
    const email = normalizeWaitlistEmail(user?.email);
    const name = user?.name ?? '';

    // The upsert stays create-only so two concurrent gate checks cannot collide
    // on the unique phone, and it deliberately carries no email: Waitlist.email
    // is UNIQUE, so an address another row already owns would fail the create
    // and lose the signup entirely. Contact details are attached separately,
    // where a collision is survivable and hand-curated values are preserved.
    await prisma.waitlist.upsert({
      where: { phone },
      create: { phone, name, variant: 'gated-login' },
      update: {},
    });

    await backfillGatedContactDetails({ phone, name, email });
  } catch (error) {
    log.error('Failed to record gated user on waitlist', {
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Fill in contact details the waitlist row is still missing.
 *
 * Sign-up collects an email and a name and stores them on User, but this row
 * historically carried only the phone — so the admin waitlist read "no email on
 * file" for people whose address we already held one table over, and invites
 * had to re-derive it from the account.
 *
 * Only ever fills blanks: a value already on the row wins, because it may have
 * been curated by an admin or imported from a roster.
 */
async function backfillGatedContactDetails(params: {
  phone: string;
  name: string;
  email: string | null;
}): Promise<void> {
  const { phone, name, email } = params;
  if (email !== null) {
    try {
      await prisma.waitlist.updateMany({
        where: { phone, OR: [{ email: null }, { email: '' }] },
        data: { email },
      });
    } catch (error) {
      // Waitlist.email is UNIQUE. Another row (an earlier signup, or a manual
      // roster import) may already own this address; that row is canonical, so
      // leave this one email-less rather than failing the gate check.
      if (!isUniqueConstraintError(error)) throw error;
      log.info('Skipped waitlist email backfill: address already on another row', { phone });
    }
  }
  if (name !== '') {
    await prisma.waitlist.updateMany({ where: { phone, name: '' }, data: { name } });
  }
}
