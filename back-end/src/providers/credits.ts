/**
 * Credits & Usage Management
 *
 * Handles credit allocation, usage tracking, and balance calculations
 */

import { Prisma } from '@prisma/client';

import { prisma } from './database';
import { createLogger } from './logger';
import { retryWithBackoff } from './retry';

const log = createLogger('Credits');

/**
 * Creates initial $5 non-expiring credit for new users
 */
export async function createInitialCredit(userId: string) {
  // Check if user already has credits (avoid duplicates)
  const existingCredits = await prisma.credit.findFirst({
    where: { userId },
  });

  if (existingCredits) {
    log.info('User already has credits, skipping initial credit creation', { userId });
    return existingCredits;
  }

  // Create $1 non-expiring credit (100 cents) - PUBLIC BETA
  const credit = await prisma.credit.create({
    data: {
      userId,
      amountCents: 100, // $1.00 (PUBLIC BETA - was 500)
      expirationDate: null, // Never expires
    },
  });

  log.info('Created initial $1 credit', { userId });
  return credit;
}

/**
 * Monthly allowance granted to anyone who joined via an invite code — the
 * "free pro" grant. $30/month, expiring at the end of the calendar month.
 */
export const INVITE_MONTHLY_CREDIT_CENTS = 3000;

/** Start of the next UTC calendar month — the allowance's expiry AND its idempotency key. */
function startOfNextUtcMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

/**
 * Top up an invite-code user's monthly allowance.
 *
 * Invited users get a recurring $30/month instead of hitting the subscribe
 * gate: with a positive balance `remaining > 0`, so every existing credit check
 * (worker `has_credits`, agent resume) passes untouched. That is why this grants
 * CREDIT rather than faking a Subscription row — no Stripe identifiers are
 * invented and no downstream billing path changes behaviour.
 *
 * Deliberately lazy: it runs on the usage read the front-end and worker already
 * perform, so there is no scheduler to own. The grant expires at the month
 * boundary and that same boundary is the idempotency key, so repeated reads
 * inside a month are a no-op and each new month grants exactly once.
 *
 * No-ops for users without `usedInviteCode`.
 */
export async function ensureInviteMonthlyCredit(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { userId },
    select: { usedInviteCode: true },
  });
  if (user === null || user.usedInviteCode === null) return;

  const periodEnd = startOfNextUtcMonth();

  // check-then-insert must be ATOMIC: this runs on a hot read that the front-end
  // and every worker credit check hit, so concurrent requests can otherwise all
  // observe "not granted" and each insert their own $30. Serializable isolation
  // makes the losers abort with a serialization failure (P2034 / 40001) instead
  // of duplicating the grant. Retry the entire transaction so a failed commit
  // cannot make the following usage read report a missing allowance.
  try {
    const granted = await retryWithBackoff(
      () =>
        prisma.$transaction(
          async (tx) => {
            const alreadyGranted = await tx.credit.findFirst({
              where: {
                userId,
                amountCents: INVITE_MONTHLY_CREDIT_CENTS,
                expirationDate: periodEnd,
              },
              select: { id: true },
            });
            if (alreadyGranted !== null) return false;

            await tx.credit.create({
              data: { userId, amountCents: INVITE_MONTHLY_CREDIT_CENTS, expirationDate: periodEnd },
            });
            return true;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      {
        maxRetries: 5,
        initialBackoffMs: 10,
        component: 'Invite monthly credit',
        isRetryable: (error) => {
          const code = (error as { code?: string }).code;
          return code === 'P2034' || code === 'P2002';
        },
      }
    );
    if (granted) {
      log.info('Granted invite-code monthly credit', {
        userId,
        amountCents: INVITE_MONTHLY_CREDIT_CENTS,
        expiresAt: periodEnd.toISOString(),
      });
    }
  } catch (error) {
    log.error('Failed to grant invite-code monthly credit', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Even an exhausted conflict must not be swallowed. Returning here would let
    // getUsageSummary report a balance missing this user's allowance, which can
    // send an eligible invited user through the credit gate — the exact outcome
    // the allowance exists to prevent. Failing loudly is the safer mode: the
    // worker's usage check treats a non-200 as "don't override cache" (returns
    // None) rather than as zero credits, so a transient DB fault degrades to the
    // previous known state instead of a wrong out-of-credits verdict.
    throw error;
  }
}

/**
 * Calculate total available (non-expired) credits for a user
 * Returns amount in dollars (cents / 100)
 */
export async function calculateAvailableCredits(userId: string): Promise<number> {
  const now = new Date();

  const credits = await prisma.credit.findMany({
    where: {
      userId,
      OR: [
        { expirationDate: null }, // Non-expiring credits
        { expirationDate: { gt: now } }, // Not yet expired
      ],
    },
  });

  const totalCents = credits.reduce((sum, credit) => {
    return sum + credit.amountCents;
  }, 0);

  return totalCents / 100; // Convert cents to dollars
}

/**
 * Calculate total usage cost for a user.
 * All costs (LLM reasoning + tool usage) are tracked in ToolUsage records
 * with correct per-call pricing based on actual_model.
 * "-claude" suffix models have $0 cost (user's own Claude token).
 */
export async function calculateTotalUsage(userId: string): Promise<number> {
  const result = await prisma.toolUsage.aggregate({
    where: { userId },
    _sum: { totalCostCents: true },
  });

  const totalCostCents = result._sum.totalCostCents ?? 0;
  return totalCostCents / 100; // cents to dollars
}

/**
 * Get usage summary for a user (for the check usage endpoint)
 */
export async function getUserUsage(userId: string) {
  const [availableCredits, usedCredits] = await Promise.all([
    calculateAvailableCredits(userId),
    calculateTotalUsage(userId),
  ]);

  const remaining = Math.max(0, availableCredits - usedCredits);

  return {
    total: availableCredits,
    used: usedCredits,
    remaining: Math.round(remaining * 100) / 100, // Round to 2 decimal places
  };
}

/* c8 ignore start -- addSubscriptionCredit has no callers; hasCreditsRemaining gates resumes (directChatResume, agentMessageResume) */
/**
 * Check if user has sufficient credits to continue
 */
export async function hasCreditsRemaining(userId: string): Promise<boolean> {
  const usage = await getUserUsage(userId);
  return usage.remaining > 0;
}

/**
 * Creates signup bonus credit when anonymous user converts to real account.
 * This is separate from initial credit to ensure both bonuses are applied.
 */
export async function createSignupBonusCredit(userId: string) {
  const credit = await prisma.credit.create({
    data: {
      userId,
      amountCents: 100, // $1.00 signup bonus
      expirationDate: null, // Never expires
    },
  });

  log.info('Created $1 signup bonus credit', { userId });
  return credit;
}

/**
 * Add credit for a subscription (called when subscription is created/renewed)
 */
export async function addSubscriptionCredit(
  userId: string,
  amountDollars: number,
  expirationDate: Date
) {
  const credit = await prisma.credit.create({
    data: {
      userId,
      amountCents: amountDollars * 100, // Convert dollars to cents
      expirationDate,
    },
  });

  log.info('Added subscription credit', {
    userId,
    amountDollars,
    expirationDate: expirationDate.toISOString(),
  });
  return credit;
}
/* c8 ignore stop */

/**
 * Get current subscription tier for a user
 */
export async function getSubscriptionTier(userId: string): Promise<number | null> {
  const subscription = await prisma.subscription.findUnique({
    where: { userId },
  });

  return subscription?.subscriptionTier ?? null;
}

/**
 * Get upgrade options based on current tier
 */
export function getUpgradeOptions(currentTier: number | null): Array<{
  tier: number;
  name: string;
  url: string;
}> {
  const isProduction = process.env.NODE_ENV === 'production';

  // Canonical Rose Labs Pro ($30/mo) Payment Links on the Rose Labs Stripe
  // account. Higher tiers keep legacy ladder URLs for existing upgrade paths.
  const allTiers = isProduction
    ? [
        {
          tier: 30,
          name: 'Rose Labs Pro',
          url: 'https://buy.stripe.com/6oU00k2kK1vi8bLdL8bQY00',
        },
        { tier: 40, name: 'Agent Cluster', url: 'https://buy.stripe.com/28E4gz1je3rndE5bpb5kk06' },
        {
          tier: 50,
          name: 'Agent Cluster Pro',
          url: 'https://buy.stripe.com/5kQ00j1jefa5eI90Kx5kk07',
        },
        {
          tier: 100,
          name: 'Agent Mega Cluster',
          url: 'https://buy.stripe.com/fZu5kD4vq1jf0Rjal75kk08',
        },
        {
          tier: 200,
          name: 'Agent Mega Cluster Pro',
          url: 'https://buy.stripe.com/fZu3cvaTO8LH8jL8cZ5kk09',
        },
      ]
    : [
        {
          tier: 30,
          name: 'Rose Labs Pro',
          url: 'https://buy.stripe.com/test_5kQcN64tX2PccvS6dM9ws00',
        },
        {
          tier: 40,
          name: 'Agent Cluster',
          url: 'https://buy.stripe.com/test_8x2dR9aTO6Dz6bD0Kx5kk02',
        },
        {
          tier: 50,
          name: 'Agent Cluster Pro',
          url: 'https://buy.stripe.com/test_5kQ5kD6Dy4vr2Zr1OB5kk03',
        },
        {
          tier: 100,
          name: 'Agent Mega Cluster',
          url: 'https://buy.stripe.com/test_cNi7sL7HCfa59nPeBn5kk04',
        },
        {
          tier: 200,
          name: 'Agent Mega Cluster Pro',
          url: 'https://buy.stripe.com/test_eVq4gze607HD57zgJv5kk05',
        },
      ];

  if (currentTier === null || currentTier === 0) {
    // Free tier: base plan is $30/mo Rose Labs Pro
    return allTiers.filter((t) => [30, 50, 100].includes(t.tier));
  } else if (currentTier === 20) {
    // Legacy $20 subscribers can move onto the current $30 base or higher.
    return allTiers.filter((t) => [30, 40, 50].includes(t.tier));
  } else if (currentTier === 30) {
    // Current base plan: show next ladder steps
    return allTiers.filter((t) => [40, 50, 100].includes(t.tier));
  } else if (currentTier === 40) {
    // $40 tier: show 50, 100, 200
    return allTiers.filter((t) => [50, 100, 200].includes(t.tier));
  } else if (currentTier === 100) {
    // $100 tier: show only 200
    return allTiers.filter((t) => t.tier === 200);
  } else if (currentTier === 200) {
    // $200 tier: no upgrades, contact support
    return [];
  }

  // For 50 or other tiers, show next available options
  return allTiers.filter((t) => t.tier > currentTier);
}
