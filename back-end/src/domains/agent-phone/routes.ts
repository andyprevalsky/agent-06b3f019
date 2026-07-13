import { type Response, Router } from 'express';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { ToolSideEffectAlreadyStartedError } from '../../providers/toolSideEffects';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  AgentPhoneIdempotencyConflictError,
  AgentPhoneIdentityUnavailableError,
  AgentPhoneMessageValidationError,
  fetchAgentPhoneMessagesSince,
  sendOutboundAgentPhoneMessage,
} from './service';

const router = Router();
const hybrid = asyncHandler<HybridAuthRequest>(hybridAuth);

router.post(
  '/messages/send',
  hybrid,
  asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
    const userId = req.isInternal === true ? req.body.user_id : req.userId;
    if (typeof userId !== 'string' || userId === '') {
      res.status(401).json({ error: 'Unauthorized: user_id required' });
      return;
    }
    try {
      const receipt = await sendOutboundAgentPhoneMessage({
        userId,
        agentId: req.body.agent_id,
        idempotencyKey: req.body.idempotency_key,
        phoneNumber: req.body.phone_number,
        message: req.body.message,
      });
      res.json(receipt);
    } catch (error) {
      if (error instanceof AgentPhoneMessageValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof AgentPhoneIdentityUnavailableError) {
        res.status(409).json({ error: error.message });
        return;
      }
      if (
        error instanceof AgentPhoneIdempotencyConflictError ||
        error instanceof ToolSideEffectAlreadyStartedError
      ) {
        res.status(409).json({ error: error.message });
        return;
      }
      res.status(502).json({
        error: error instanceof Error ? error.message : 'AgentPhone message send failed',
      });
    }
  })
);

router.get(
  '/messages',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId =
      req.user?.id ?? (req.isInternal === true ? (req.headers['x-user-id'] as string) : undefined);
    if (userId === undefined || userId === null || userId === '') {
      return res
        .status(400)
        .json({ error: 'Missing user ID. Use JWT auth or x-user-id header with API key.' });
    }

    const sinceParam = req.query.since as string;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);
    if (sinceParam === undefined || sinceParam === null || sinceParam === '') {
      return res.status(400).json({ error: 'Missing required query param: since (ISO timestamp)' });
    }

    const since = new Date(sinceParam);
    if (Number.isNaN(since.getTime())) {
      return res.status(400).json({ error: 'Invalid since timestamp' });
    }

    const messages = await fetchAgentPhoneMessagesSince(userId, since, limit);
    return res.json({
      messages: messages.map((message) => ({
        id: message.id,
        from: message.from,
        to: message.to,
        body: message.body,
        channel: message.channel,
        date: message.receivedAt.toISOString(),
        credentialId: message.credentialId,
        credentialPhone: message.credentialPhone,
      })),
      count: messages.length,
      since: since.toISOString(),
    });
  })
);

export default router;
