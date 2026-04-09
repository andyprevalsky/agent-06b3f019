/**
 * Credits & Usage Management
 *
 * Handles credit allocation, usage tracking, and balance calculations
 */

import { prisma } from './database';
import { createLogger } from './logger';

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

/* c8 ignore start -- hasCreditsRemaining and addSubscriptionCredit have no callers in the codebase */
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

  // Use test links in development, prod links in production
  const allTiers = isProduction
    ? [
        // Production payment links
        {
          tier: 20,
          name: 'Agent Mini Cluster',
          url: 'https://buy.stripe.com/cNi7sL7HCfa59nPeBn5kk04',
        },
        {
          tier: 30,
          name: 'Agent Mini Cluster Pro',
          url: 'https://buy.stripe.com/eVq4gze607HD57zgJv5kk05',
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
        // Test payment links for development
        {
          tier: 20,
          name: 'Agent Mini Cluster',
          url: 'https://buy.stripe.com/test_00w5kDge8e618jL1OB5kk00',
        },
        {
          tier: 30,
          name: 'Agent Mini Cluster Pro',
          url: 'https://buy.stripe.com/test_6oU9AT1je3rn9nPgJv5kk01',
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
    // Free tier: show 20, 50, 100
    return allTiers.filter((t) => [20, 50, 100].includes(t.tier));
  } else if (currentTier === 20) {
    // $20 tier: show 30, 40, 50
    return allTiers.filter((t) => [30, 40, 50].includes(t.tier));
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

  // For 30, 50, or other tiers, show next available options
  return allTiers.filter((t) => t.tier > currentTier);
}
