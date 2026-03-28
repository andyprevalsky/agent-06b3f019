/**
 * iMessage Queue Routes
 *
 * Enables agents to send iMessages via user's Mac app.
 * Flow: Agent queues message -> Mac app polls and pops -> AppleScript sends
 */

import { Router } from 'express';
import { authenticate, AuthRequest } from '../providers/auth';
import { prisma } from '../providers/database';

const router = Router();

/**
 * POST /api/imessage/queue
 * Auth: API Key (internal - called by agent worker)
 *
 * Adds an iMessage to the queue for the mac app to send.
 */
router.post('/queue', authenticate, async (req: AuthRequest, res) => {
  try {
    const { user_id, agent_id, phone_number, message } = req.body;

    if (!user_id || !agent_id || !phone_number || !message) {
      return res.status(400).json({
        error: 'user_id, agent_id, phone_number, and message are required',
      });
    }

    // Validate phone number format (basic E.164 check)
    if (!phone_number.match(/^\+[1-9]\d{1,14}$/)) {
      return res.status(400).json({
        error: 'phone_number must be in E.164 format (e.g., +19729777432)',
      });
    }

    const queueEntry = await prisma.imessageQueue.create({
      data: {
        userId: user_id,
        agentId: agent_id,
        phoneNumber: phone_number,
        message,
      },
    });

    console.log('[iMessage] Queued for sending', {
      id: queueEntry.id,
      userId: user_id,
      agentId: agent_id,
      phone: phone_number.substring(0, 4) + '****',
    });

    res.json({
      success: true,
      queue_id: queueEntry.id,
    });
  } catch (error) {
    console.error('[iMessage] Error queueing message:', error);
    res.status(500).json({ error: 'Failed to queue iMessage' });
  }
});

/**
 * GET /api/imessage/queue/pop
 * Auth: Bearer token (mac app - user-authenticated)
 *
 * Pops the next pending iMessage for the authenticated user.
 * Returns the message and deletes it from the queue in one atomic operation.
 */
router.get('/queue/pop', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Find and delete the oldest pending message in one transaction
    const message = await prisma.$transaction(async (tx) => {
      const oldest = await tx.imessageQueue.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });

      if (!oldest) {
        return null;
      }

      await tx.imessageQueue.delete({
        where: { id: oldest.id },
      });

      return oldest;
    });

    if (!message) {
      return res.json({ message: null });
    }

    console.log('[iMessage] Popped for sending', {
      id: message.id,
      phone: message.phoneNumber.substring(0, 4) + '****',
    });

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
    console.error('[iMessage] Error popping message:', error);
    res.status(500).json({ error: 'Failed to pop message' });
  }
});

export default router;
