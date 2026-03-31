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

export default router;
