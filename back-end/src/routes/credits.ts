/**
 * Credits & Subscriptions API Routes
 */

import express, { Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import {
  getUserUsage,
  getSubscriptionTier,
  getUpgradeOptions,
  createInitialCredit
} from '../lib/credits';
import { prisma } from '../lib/prisma';
import Stripe from 'stripe';
import { createLogger } from '../lib/logger';

const log = createLogger('Credits');
const router = express.Router();

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-02-24.acacia',
});

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

/**
 * GET /api/credits/usage
 * Check user's credit usage and remaining balance (FAST endpoint)
 * Supports both JWT auth and internal API key (for workers)
 */
router.get('/usage', async (req: AuthRequest, res: Response) => {
  try {
    let userId: string;

    // Check for internal API key (from worker)
    const apiKey = req.headers['x-api-key'] as string;
    const internalApiKey = process.env.BACKEND_API_KEY;

    if (apiKey && apiKey === internalApiKey) {
      // Internal API call - userId from query param
      userId = req.query.userId as string;
      
      if (!userId) {
        return res.status(400).json({ error: 'userId query parameter required for internal calls' });
      }
    } else {
      // User-authenticated call - use authenticate middleware inline
      const authHeader = req.headers.authorization;
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid authorization header' });
      }

      // Extract JWT and decode (simplified - you may want to use the authenticate middleware)
      // For now, we'll require authentication through the middleware
      // Let's apply authenticate middleware manually
      const authenticateMiddleware = authenticate;
      await new Promise((resolve, reject) => {
        authenticateMiddleware(req as any, res as any, (err: any) => {
          if (err) reject(err);
          else resolve(null);
        });
      });

      if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      userId = req.user.id; // From Supabase JWT
    }

    const [usage, tier] = await Promise.all([
      getUserUsage(userId),
      getSubscriptionTier(userId)
    ]);

    res.json({
      total: usage.total,
      used: usage.used,
      remaining: usage.remaining,
      tier: tier,
      upgradeOptions: getUpgradeOptions(tier)
    });
  } catch (error) {
    log.error('Error checking usage', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to check usage' });
  }
});

/**
 * POST /api/credits/initialize
 * Create initial $5 credit for user (called on first login/signup)
 */
router.post('/initialize', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = req.user.id;

    // Ensure user exists in User table first
    let user = await prisma.user.findUnique({
      where: { userId }
    });

    if (!user) {
      // Create user record if it doesn't exist
      user = await prisma.user.create({
        data: { userId }
      });
      log.info('Created user record', { user_id: userId });
    }

    // Create initial credit
    const credit = await createInitialCredit(userId);

    res.json({
      success: true,
      credit: {
        amount: credit.amountCents,
        expirationDate: credit.expirationDate
      }
    });
  } catch (error) {
    log.error('Error initializing credits', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to initialize credits' });
  }
});

/**
 * GET /api/credits/subscription
 * Get current subscription details
 */
router.get('/subscription', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = req.user.id;

    const subscription = await prisma.subscription.findUnique({
      where: { userId }
    });

    if (!subscription) {
      return res.json({
        tier: null,
        currentPeriodEnd: null,
        upgradeOptions: getUpgradeOptions(null)
      });
    }

    res.json({
      tier: subscription.subscriptionTier,
      currentPeriodEnd: subscription.currentPeriodEnd,
      upgradeOptions: getUpgradeOptions(subscription.subscriptionTier)
    });
  } catch (error) {
    log.error('Error fetching subscription', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

/**
 * GET /api/credits/stats
 * Get token usage statistics by model
 */
router.get('/stats', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = req.user.id;

    // Get all agents for this user (including deleted ones for historical accuracy)
    const agents = await prisma.agent.findMany({
      where: { userId },
      select: {
        model: true,
        tokenCount: true,
        tokensIn: true,
        tokensOut: true,
      },
    });

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

    res.json({
      totalTokens,
      topModels,
    });
  } catch (error) {
    log.error('Error fetching stats', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;

