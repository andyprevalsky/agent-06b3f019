import { Router, type Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { authenticate, type AuthRequest } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { submitFeedback } from './service';

const log = createLogger('Feedback');
const router = Router();

// POST /api/feedback - Submit user feedback (requires auth)
router.post(
  '/',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const userId = req.user.id;

    if (req.body === null || req.body === undefined || typeof req.body !== 'object') {
      res.status(400).json({ error: 'Feedback is required' });
      return;
    }

    const { feedback } = req.body;

    if (typeof feedback !== 'string' || feedback.trim() === '') {
      res.status(400).json({ error: 'Feedback is required' });
      return;
    }

    try {
      await submitFeedback(userId, feedback);
      res.json({ success: true });
    } catch (error) {
      log.error('Feedback submission error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to submit feedback' });
    }
  })
);

export default router;
