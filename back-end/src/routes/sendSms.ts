import { Router } from 'express';
import { z } from 'zod';
import { logTruncate } from '../utils/log';
import { authenticate, AuthRequest } from '../providers/auth';
import { sendSms, getUserPhone } from '../providers/smsQueue';
import { prisma } from '../providers/database';
import {
  notifyAgentStarted,
  notifyPlannerMessage,
  notifyWriteLock,
  notifyCompletion,
  notifyCostLimit,
} from '../providers/smsSupervisor/outboundEvents';

const router = Router();

/**
 * Send SMS via Surge
 * POST /api/send-sms
 * Auth: API Key (internal - called by agent worker)
 *
 * Body:
 *   - phone_number: string (E.164 format, e.g., +19729777432)
 *   - message: string
 */
router.post('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const { phone_number, message } = req.body;

    if (!phone_number) {
      return res.status(400).json({ error: 'phone_number is required' });
    }

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const apiKey = process.env.SURGE_API_KEY;
    const accountId = process.env.SURGE_ACCOUNT_ID;

    if (!apiKey || !accountId) {
      console.error('Surge credentials not configured');
      return res.status(500).json({ error: 'Surge not configured' });
    }

    const response = await fetch(`https://api.surge.app/accounts/${accountId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: phone_number,
        body: message,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Surge API error:', response.status, logTruncate(errorText));
      return res.status(response.status).json({
        error: `Surge API error (${response.status})`,
        details: errorText,
      });
    }

    const result = (await response.json()) as { id: string; [key: string]: any };

    console.log('✅ SMS sent via Surge', {
      messageId: result.id,
      phone: phone_number.substring(0, 4) + '****',
    });

    res.json({
      success: true,
      message_id: result.id,
      phone_number: phone_number,
      provider: 'surge',
    });
  } catch (error) {
    console.error('Error sending SMS:', error);
    res.status(500).json({ error: 'Failed to send SMS' });
  }
});

/**
 * Direct SMS send (for welcome, completion - no queue)
 * POST /api/send-sms/direct
 * Auth: API Key (internal - called by agent worker)
 *
 * Body:
 *   - user_id: string
 *   - message: string
 */
router.post('/direct', authenticate, async (req: AuthRequest, res) => {
  try {
    const { user_id, message } = req.body;

    if (!user_id || !message) {
      return res.status(400).json({ error: 'user_id and message are required' });
    }

    const userPhone = await getUserPhone(user_id);
    if (!userPhone) {
      return res.status(400).json({ error: 'User has no phone number' });
    }

    const result = await sendSms(userPhone, message);

    console.log('[SMS] Direct send result', {
      userId: user_id,
      success: result.success,
    });

    res.json(result);
  } catch (error) {
    console.error('[SMS] Error in direct endpoint:', error);
    res.status(500).json({ error: 'Failed to send SMS' });
  }
});

/**
 * Lifecycle SMS notification endpoint
 * POST /api/send-sms/notify
 * Auth: API Key (internal - called by agent worker)
 *
 * Body:
 *   - user_id: string
 *   - event_type: string
 *   - agent_id: string
 *   - payload: object (event-specific data)
 */
const notifySchema = z.object({
  user_id: z.string(),
  event_type: z.enum([
    'agent_started',
    'planner_message',
    'write_lock',
    'completion',
    'cost_limit',
  ]),
  agent_id: z.string(),
  payload: z.record(z.any()).optional(),
});

router.post('/notify', authenticate, async (req: AuthRequest, res) => {
  const startTime = Date.now();

  try {
    const data = notifySchema.parse(req.body);

    console.log('[SMS Notify] Received', {
      userId: data.user_id,
      eventType: data.event_type,
      agentId: data.agent_id,
      payload: JSON.stringify(data.payload || {}).substring(0, 200),
    });

    // Skip SMS if agent has been deleted (race condition: activity completed after /clear)
    const agent = await prisma.agent.findUnique({
      where: { id: data.agent_id },
      select: { deletedAt: true },
    });
    if (agent?.deletedAt) {
      console.log('[SMS Notify] Agent deleted, skipping SMS', {
        agentId: data.agent_id,
        eventType: data.event_type,
      });
      return res.json({ success: true, skipped: true, reason: 'agent_deleted' });
    }

    const payload = data.payload || {};

    switch (data.event_type) {
      case 'agent_started':
        await notifyAgentStarted(data.user_id, {
          id: data.agent_id,
          goal: payload.goal || 'Unknown goal',
        });
        break;

      case 'planner_message':
        await notifyPlannerMessage(
          data.user_id,
          { id: data.agent_id },
          payload.message || '',
          payload.is_question || false
        );
        break;

      case 'write_lock':
        await notifyWriteLock(
          data.user_id,
          { id: data.agent_id },
          payload.question || '',
          payload.attention_request_id || '',
          payload.workflow_id || ''
        );
        break;

      case 'completion':
        await notifyCompletion(data.user_id, { id: data.agent_id }, payload.summary || '');
        break;

      case 'cost_limit':
        await notifyCostLimit(data.user_id, {
          id: data.agent_id,
          treeCostCents: payload.tree_cost_cents || 0,
          priceLimitCents: payload.price_limit_cents || 0,
        });
        break;
    }

    console.log('[SMS Notify] Processed', {
      eventType: data.event_type,
      agentId: data.agent_id,
      durationMs: Date.now() - startTime,
    });

    res.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('[SMS Notify] Validation error', {
        errors: error.errors,
        body: JSON.stringify(req.body).substring(0, 200),
      });
      return res.status(400).json({ error: 'Invalid request data', details: error.errors });
    }
    console.error('[SMS Notify] Error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      durationMs: Date.now() - startTime,
    });
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

export default router;
