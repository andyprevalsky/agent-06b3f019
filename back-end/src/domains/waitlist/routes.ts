import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import * as service from './service';
import { ValidationError } from './service';

const log = createLogger('Waitlist');
const router = Router();

// POST /api/waitlist - Join the waitlist (no auth required)
router.post(
  '/',
  asyncHandler(async (req, res) => {
    try {
      const { name, email, variant } = req.body;
      const result = await service.joinWaitlist({ name, email, variant });
      res.json(result);
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      log.error('Waitlist join error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to join waitlist. Please try again.' });
    }
  })
);

export default router;
