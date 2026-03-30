import { Router, Response } from 'express';
import { prisma } from '../providers/database';
import { authenticate, AuthRequest } from '../providers/auth';

const router = Router();

// POST /api/feedback - Submit user feedback (requires auth)
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const userId = req.user.id;

    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Feedback is required' });
    }

    const { feedback } = req.body;

    if (!feedback || typeof feedback !== 'string' || !feedback.trim()) {
      return res.status(400).json({ error: 'Feedback is required' });
    }

    await prisma.feedback.create({
      data: {
        userId,
        feedback: feedback.trim(),
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Feedback submission error:', error);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

export default router;
