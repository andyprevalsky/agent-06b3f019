/**
 * Credits & Usage Management
 * 
 * Handles credit allocation, usage tracking, and balance calculations
 */

import { prisma } from './prisma';

/**
 * Creates initial $5 non-expiring credit for new users
 */
export async function createInitialCredit(userId: string) {
  // Check if user already has credits (avoid duplicates)
  const existingCredits = await prisma.credit.findFirst({
    where: { userId }
  });

  if (existingCredits) {
    console.log(`User ${userId} already has credits, skipping initial credit creation`);
    return existingCredits;
  }

  // Create $5 non-expiring credit (500 cents)
  const credit = await prisma.credit.create({
    data: {
      userId,
      amountCents: 500, // $5.00
      expirationDate: null, // Never expires
    }
  });

  console.log(`✅ Created initial $5 credit for user ${userId}`);
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
        { expirationDate: { gt: now } } // Not yet expired
      ]
    }
  });

  const totalCents = credits.reduce((sum, credit) => {
    return sum + credit.amountCents;
  }, 0);

  return totalCents / 100; // Convert cents to dollars
}

/**
 * Calculate total usage cost for a user based on actual model pricing
 * Counts ALL agents (including deleted ones) - usage is usage regardless of deletion
 */
export async function calculateTotalUsage(userId: string): Promise<number> {
  // Get ALL agents for this user (including deleted)
  const agents = await prisma.agent.findMany({
    where: { userId },
    select: {
      tokensIn: true,
      tokensOut: true,
      tokenInPriceMicrodollars: true,
      tokenOutPriceMicrodollars: true,
    }
  });

  let totalCostMicrodollars = 0;
  
  for (const agent of agents) {
    // Calculate cost from actual pricing saved at agent creation
    // Formula: (tokens * microdollars_per_token) = total_microdollars
    if (agent.tokenInPriceMicrodollars && agent.tokensIn > 0) {
      totalCostMicrodollars += agent.tokensIn * agent.tokenInPriceMicrodollars;
    }
    
    if (agent.tokenOutPriceMicrodollars && agent.tokensOut > 0) {
      totalCostMicrodollars += agent.tokensOut * agent.tokenOutPriceMicrodollars;
    }
  }

  // Convert microdollars to dollars: microdollars / 1,000,000 = dollars
  return totalCostMicrodollars / 1_000_000;
}

/**
 * Get usage summary for a user (for the check usage endpoint)
 */
export async function getUserUsage(userId: string) {
  const [availableCredits, usedCredits] = await Promise.all([
    calculateAvailableCredits(userId),
    calculateTotalUsage(userId)
  ]);

  const remaining = Math.max(0, availableCredits - usedCredits);

  return {
    total: availableCredits,
    used: usedCredits,
    remaining: Math.round(remaining * 100) / 100, // Round to 2 decimal places
  };
}

/**
 * Check if user has sufficient credits to continue
 */
export async function hasCreditsRemaining(userId: string): Promise<boolean> {
  const usage = await getUserUsage(userId);
  return usage.remaining > 0;
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
    }
  });

  console.log(`✅ Added $${amountDollars} subscription credit for user ${userId}, expires ${expirationDate}`);
  return credit;
}

/**
 * Get current subscription tier for a user
 */
export async function getSubscriptionTier(userId: string): Promise<number | null> {
  const subscription = await prisma.subscription.findUnique({
    where: { userId }
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
  const allTiers = isProduction ? [
    // Production payment links
    { tier: 20, name: 'Agent Mini Cluster', url: 'https://buy.stripe.com/cNi7sL7HCfa59nPeBn5kk04' },
    { tier: 30, name: 'Agent Mini Cluster Pro', url: 'https://buy.stripe.com/eVq4gze607HD57zgJv5kk05' },
    { tier: 40, name: 'Agent Cluster', url: 'https://buy.stripe.com/28E4gz1je3rndE5bpb5kk06' },
    { tier: 50, name: 'Agent Cluster Pro', url: 'https://buy.stripe.com/5kQ00j1jefa5eI90Kx5kk07' },
    { tier: 100, name: 'Agent Mega Cluster', url: 'https://buy.stripe.com/fZu5kD4vq1jf0Rjal75kk08' },
    { tier: 200, name: 'Agent Mega Cluster Pro', url: 'https://buy.stripe.com/fZu3cvaTO8LH8jL8cZ5kk09' },
  ] : [
    // Test payment links for development
    { tier: 20, name: 'Agent Mini Cluster', url: 'https://buy.stripe.com/test_00w5kDge8e618jL1OB5kk00' },
    { tier: 30, name: 'Agent Mini Cluster Pro', url: 'https://buy.stripe.com/test_6oU9AT1je3rn9nPgJv5kk01' },
    { tier: 40, name: 'Agent Cluster', url: 'https://buy.stripe.com/test_8x2dR9aTO6Dz6bD0Kx5kk02' },
    { tier: 50, name: 'Agent Cluster Pro', url: 'https://buy.stripe.com/test_5kQ5kD6Dy4vr2Zr1OB5kk03' },
    { tier: 100, name: 'Agent Mega Cluster', url: 'https://buy.stripe.com/test_cNi7sL7HCfa59nPeBn5kk04' },
    { tier: 200, name: 'Agent Mega Cluster Pro', url: 'https://buy.stripe.com/test_eVq4gze607HD57zgJv5kk05' },
  ];

  if (currentTier === null || currentTier === 0) {
    // Free tier: show 20, 50, 100
    return allTiers.filter(t => [20, 50, 100].includes(t.tier));
  } else if (currentTier === 20) {
    // $20 tier: show 30, 40, 50
    return allTiers.filter(t => [30, 40, 50].includes(t.tier));
  } else if (currentTier === 40) {
    // $40 tier: show 50, 100, 200
    return allTiers.filter(t => [50, 100, 200].includes(t.tier));
  } else if (currentTier === 100) {
    // $100 tier: show only 200
    return allTiers.filter(t => t.tier === 200);
  } else if (currentTier === 200) {
    // $200 tier: no upgrades, contact support
    return [];
  }

  // For 30, 50, or other tiers, show next available options
  return allTiers.filter(t => t.tier > currentTier);
}

