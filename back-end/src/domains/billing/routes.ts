import { Router, type Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { authenticate, type AuthRequest } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import * as service from './service';
import { NotFoundError } from './service';

const log = createLogger('Billing');

const router = Router();

/**
 * GET /api/billing/portal
 * Returns a Stripe Customer Portal URL for the authenticated user
 * User can manage subscriptions, payment methods, and view invoices
 */
router.get(
  '/portal',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const result = await service.createPortalSession(req.user.id);
      res.json(result);
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({
          error: 'No subscription found',
          message: error.message,
        });
        return;
      }
      log.error('Error creating billing portal session', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to create billing portal session' });
    }
  })
);

/**
 * POST /api/billing/subscription-checkout
 * Returns a Stripe Checkout URL for starting a subscription. Supports both
 * authenticated users and internal worker calls with x-api-key + userId.
 */
router.post(
  '/subscription-checkout',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    try {
      const internalUserId =
        req.isInternal === true && typeof req.body?.userId === 'string'
          ? req.body.userId.trim()
          : undefined;
      const userId = req.isInternal === true ? internalUserId : req.user?.id;

      if (userId === undefined || userId === '') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const result = await service.createSubscriptionCheckoutSession(userId);
      res.json(result);
    } catch (error) {
      log.error('Error creating subscription checkout session', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to create subscription checkout session' });
    }
  })
);

export default router;
