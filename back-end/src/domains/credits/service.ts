import * as repo from './repo';
import {
  getUserUsage,
  getUpgradeOptions,
  createInitialCredit,
  ensureInviteMonthlyCredit,
} from '../../providers/credits';
import { createLogger } from '../../providers/logger';
import { isAdminUser } from '../../utils/adminAccess';

const log = createLogger('Credits');

/**
 * Get usage, tier, and upgrade options for a user.
 *
 * Admins (ADMIN_USER_IDS — Andy + Tamy) are never blocked by the free-credit / subscription gate.
 * We surface an additive `unlimited` flag (rather than faking the balance) that the worker credit
 * check honors so `has_credits` is always true for them. Blast radius = 2 userIds.
 *
 * Invite-code users are topped up to their recurring monthly allowance first, so
 * they clear the same credit checks without a subscription.
 */
export async function getUsageSummary(userId: string) {
  // Top up BEFORE reading the balance, so the grant rides the usage check the
  // front-end and worker already make — no scheduler, and no credit-gate change.
  await ensureInviteMonthlyCredit(userId);

  const [usage, subscription] = await Promise.all([
    getUserUsage(userId),
    repo.findSubscriptionByUserId(userId),
  ]);
  const tier = subscription?.subscriptionTier ?? null;

  return {
    total: usage.total,
    used: usage.used,
    remaining: usage.remaining,
    tier: tier,
    stripeLivemode: subscription?.stripeLivemode ?? null,
    upgradeOptions: getUpgradeOptions(tier),
    unlimited: isAdminUser(userId),
  };
}

/**
 * Ensure user record exists and create initial credit.
 */
export async function initializeCredits(userId: string) {
  // Ensure user exists in User table first
  let user = await repo.findUserById(userId);

  if (!user) {
    // Create user record if it doesn't exist
    user = await repo.createUser(userId);
    log.info('Created user record', { user_id: userId });
  }

  // Create initial credit
  const credit = await createInitialCredit(userId);

  return {
    success: true,
    credit: {
      amount: credit.amountCents,
      expirationDate: credit.expirationDate,
    },
  };
}

/**
 * Get subscription details for a user.
 */
export async function getSubscription(userId: string) {
  const subscription = await repo.findSubscriptionByUserId(userId);

  if (!subscription) {
    return {
      tier: null,
      currentPeriodEnd: null,
      upgradeOptions: getUpgradeOptions(null),
    };
  }

  return {
    tier: subscription.subscriptionTier,
    currentPeriodEnd: subscription.currentPeriodEnd,
    upgradeOptions: getUpgradeOptions(subscription.subscriptionTier),
  };
}

/**
 * Get token usage statistics aggregated by model.
 */
export async function getTokenStats(userId: string) {
  const agents = await repo.findAgentTokenStatsByUserId(userId);

  // Aggregate by model
  const modelStats = new Map<string, { tokens: number; tokensIn: number; tokensOut: number }>();
  let totalTokens = 0;

  for (const agent of agents) {
    const existing = modelStats.get(agent.model) || { tokens: 0, tokensIn: 0, tokensOut: 0 };
    modelStats.set(agent.model, {
      tokens: existing.tokens + agent.tokenCount,
      tokensIn: existing.tokensIn + agent.tokensIn,
      tokensOut: existing.tokensOut + agent.tokensOut,
    });
    totalTokens += agent.tokenCount;
  }

  // Convert to sorted array
  const topModels = Array.from(modelStats.entries())
    .map(([model, stats]) => ({
      model,
      tokens: stats.tokens,
      tokensIn: stats.tokensIn,
      tokensOut: stats.tokensOut,
      percentage: totalTokens > 0 ? Math.round((stats.tokens / totalTokens) * 100) : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5); // Top 5

  return {
    totalTokens,
    topModels,
  };
}
