import { type Response, Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { createLogger } from '../../providers/logger';
import {
  fetchRecentInboundMessages,
  getImessageBridgeStatus,
  getDeliveryStatus,
  queueMessage,
  popNextMessage,
  recordImessageBridgeHeartbeat,
  recordDeliveryResult,
  IdempotencyConflictError,
  QueueEntryNotFoundError,
  StaleQueueClaimError,
  ValidationError,
} from './service';
import { MessageChannel } from './types';

const log = createLogger('iMessage');
const router = Router();
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

/**
 * POST /api/imessage/queue
 * Auth: API Key (internal - called by agent worker) or Bearer token
 *
 * Adds an iMessage to the queue for the mac app to send.
 * Internal callers (API key) may pass user_id in the body.
 * User-authenticated callers use their own userId.
 */
router.post(
  '/queue',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
    const { agent_id, phone_number, message, idempotency_key } = req.body;
    const userId = req.isInternal === true ? req.body.user_id : req.userId;

    if (userId === undefined || userId === '') {
      res.status(401).json({ error: 'Unauthorized: user_id required' });
      return;
    }

    try {
      const { entry, bridge } = await queueMessage(
        userId,
        agent_id,
        phone_number,
        message,
        idempotency_key
      );
      res.json({
        success: true,
        queue_id: entry.id,
        relay_connected: bridge.connected,
        relay_last_seen_at: bridge.lastSeenAt?.toISOString() ?? null,
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof IdempotencyConflictError) {
        res.status(409).json({ error: error.message });
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
 * Claims the next pending iMessage for the authenticated user.
 * The Mac app reports the send result through POST /queue/:id/result.
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
      const supportsAcknowledgements = req.get('X-iMessage-Delivery-Results') === 'v1';
      if (supportsAcknowledgements) {
        await recordImessageBridgeHeartbeat(userId);
      }
      const message = await popNextMessage(userId, supportsAcknowledgements);

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
          ...(supportsAcknowledgements ? { claim_token: message.claimToken } : {}),
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

/** GET /api/imessage/bridge/status
 * Auth: API key (benchmark/agent worker) or bearer token.
 */
router.get(
  '/bridge/status',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
    const userId = req.isInternal === true ? (req.headers['x-user-id'] as string) : req.userId;
    if (userId === undefined || userId === '') {
      res.status(401).json({ error: 'Unauthorized: user_id required' });
      return;
    }
    const status = await getImessageBridgeStatus(userId);
    res.json({
      connected: status.connected,
      last_seen_at: status.lastSeenAt?.toISOString() ?? null,
    });
  })
);

/** GET /api/imessage/queue/:id/status
 * Auth: API key (agent worker) or bearer token. Returns durable transport state.
 */
router.get(
  '/queue/:id/status',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
    const userId = req.isInternal === true ? (req.headers['x-user-id'] as string) : req.userId;
    if (userId === undefined || userId === '') {
      res.status(401).json({ error: 'Unauthorized: user_id required' });
      return;
    }
    try {
      const status = await getDeliveryStatus(userId, req.params.id);
      res.json({
        success: true,
        status: status.status,
        sent_at: status.sentAt?.toISOString() ?? null,
        failed_at: status.failedAt?.toISOString() ?? null,
        last_error: status.lastError,
        attempts: status.attempts,
        failures: status.failures,
      });
    } catch (error) {
      if (error instanceof QueueEntryNotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      throw error;
    }
  })
);

/** POST /api/imessage/queue/:id/result
 * Records whether the authenticated Mac app sent a claimed queue item.
 */
router.post(
  '/queue/:id/result',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (userId === undefined || userId === '') {
      res.status(401).json({ error: 'User not authenticated' });
      return;
    }

    try {
      const entry = await recordDeliveryResult(
        userId,
        req.params.id,
        req.body.claim_token,
        req.body.success,
        req.body.error
      );
      res.json({
        success: true,
        sent: entry.sentAt !== null,
        terminal_failure: entry.failedAt !== null,
        attempts: entry.attempts,
        failures: entry.failures,
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof QueueEntryNotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error instanceof StaleQueueClaimError) {
        res.status(409).json({ error: error.message });
        return;
      }
      throw error;
    }
  })
);

/**
 * GET /api/imessage/recent-inbound
 * Auth: API Key (internal — called by the browser-agent worker) or Bearer token.
 *
 * Returns recent inbound messages (`to = 'me'`) for the user, newest first.
 * Used by the browser agent's OTP relay to read codes that arrived over
 * iMessage/SMS. Query params: `since` (required ISO timestamp), `limit`
 * (1-100, default 50), `channel` (optional MessageChannel, e.g. IMESSAGE).
 */
router.get(
  '/recent-inbound',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    const userId =
      req.user?.id ?? (req.isInternal === true ? (req.headers['x-user-id'] as string) : undefined);
    if (userId === undefined || userId === '') {
      res
        .status(400)
        .json({ error: 'Missing user ID. Use JWT auth or x-user-id header with API key.' });
      return;
    }

    const sinceParam = req.query.since as string | undefined;
    if (sinceParam === undefined || sinceParam === '') {
      res.status(400).json({ error: 'Missing required query param: since (ISO timestamp)' });
      return;
    }
    const since = new Date(sinceParam);
    if (Number.isNaN(since.getTime())) {
      res.status(400).json({ error: 'Invalid since timestamp' });
      return;
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);

    const channelParam = (req.query.channel as string | undefined)?.toUpperCase();
    let channel: MessageChannel | undefined;
    if (channelParam !== undefined && channelParam !== '') {
      if (!(channelParam in MessageChannel)) {
        res.status(400).json({
          error: `Invalid channel. Must be one of: ${Object.values(MessageChannel).join(', ')}`,
        });
        return;
      }
      channel = channelParam as MessageChannel;
    }

    const messages = await fetchRecentInboundMessages({ userId, since, limit, channel });
    res.json({
      messages: messages.map((m) => ({
        id: m.id,
        from: m.from,
        to: m.to,
        body: m.body,
        channel: m.channel,
        date: m.date.toISOString(),
        personId: m.personId,
      })),
      count: messages.length,
      since: since.toISOString(),
    });
  })
);

export default router;
