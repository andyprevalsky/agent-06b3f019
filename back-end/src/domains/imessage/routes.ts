import { type Response, Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { queueMessage, popNextMessage, ValidationError } from './service';

const log = createLogger('iMessage');
const router = Router();

/**
 * POST /api/imessage/queue
 * Auth: API Key (internal - called by agent worker)
 *
 * Adds an iMessage to the queue for the mac app to send.
 */
router.post(
  '/queue',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    const { user_id, agent_id, phone_number, message } = req.body;

    try {
      const entry = await queueMessage(user_id, agent_id, phone_number, message);
      res.json({
        success: true,
        queue_id: entry.id,
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      log.error('Error queueing message', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to queue iMessage' });
    }
  })
);

/**
 * GET /api/imessage/queue/pop
 * Auth: Bearer token (mac app - user-authenticated)
 *
 * Pops the next pending iMessage for the authenticated user.
 * Returns the message and deletes it from the queue in one atomic operation.
 */
router.get(
  '/queue/pop',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;

    if (userId === undefined || userId === '') {
      res.status(401).json({ error: 'User not authenticated' });
      return;
    }

    try {
      const message = await popNextMessage(userId);

      if (message === null) {
        res.json({ message: null });
        return;
      }

      res.json({
        message: {
          id: message.id,
          phone_number: message.phoneNumber,
          message: message.message,
          agent_id: message.agentId,
          created_at: message.createdAt.toISOString(),
        },
      });
    } catch (error) {
      log.error('Error popping message', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to pop message' });
    }
  })
);

export default router;
