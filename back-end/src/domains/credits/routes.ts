/**
 * Credits & Subscriptions API Routes
 */

import { Router, type Response } from 'express';
import { authenticate, type AuthRequest } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import * as service from './service';

const log = createLogger('Credits');
const router = Router();

/**
 * GET /api/credits/usage
 * Check user's credit usage and remaining balance (FAST endpoint)
 * Supports both JWT auth and internal API key (for workers)
 */
router.get(
  '/usage',
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    try {
      let userId: string;

      // Check for internal API key (from worker)
      const apiKey = req.headers['x-api-key'] as string;
      const internalApiKey = process.env.BACKEND_API_KEY;

      if (typeof apiKey === 'string' && apiKey.length > 0 && apiKey === internalApiKey) {
        // Internal API call - userId from query param
        userId = req.query.userId as string;

        if (typeof userId !== 'string' || userId.length === 0) {
          res.status(400).json({ error: 'userId query parameter required for internal calls' });
          return;
        }
      } else {
        // User-authenticated call - use authenticate middleware inline
        const authHeader = req.headers.authorization;

        if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
          res.status(401).json({ error: 'Missing or invalid authorization header' });
          return;
        }

        // Apply authenticate middleware manually
        const authenticateMiddleware = authenticate;
        await new Promise<void>((resolve, reject) => {
          authenticateMiddleware(req as AuthRequest, res, (err?: unknown) => {
            if (err !== undefined && err !== null) reject(err);
            else resolve();
          });
        });

        if (!req.user) {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }

        userId = req.user.id; // From Supabase JWT
      }

      const result = await service.getUsageSummary(userId);
      res.json(result);
    } catch (error) {
      log.error('Error checking usage', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to check usage' });
    }
  })
);

/**
 * POST /api/credits/initialize
 * Create initial $5 credit for user (called on first login/signup)
 */
router.post(
  '/initialize',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const result = await service.initializeCredits(req.user.id);
      res.json(result);
    } catch (error) {
      log.error('Error initializing credits', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to initialize credits' });
    }
  })
);

/**
 * GET /api/credits/subscription
 * Get current subscription details
 */
router.get(
  '/subscription',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const result = await service.getSubscription(req.user.id);
      res.json(result);
    } catch (error) {
      log.error('Error fetching subscription', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to fetch subscription' });
    }
  })
);

/**
 * GET /api/credits/stats
 * Get token usage statistics by model
 */
router.get(
  '/stats',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const result = await service.getTokenStats(req.user.id);
      res.json(result);
    } catch (error) {
      log.error('Error fetching stats', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  })
);

export default router;
