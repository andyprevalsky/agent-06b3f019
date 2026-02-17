import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import {
  sendSms,
  enqueueOrSendSms,
  handleAgentUnblocked,
  getUserPhone,
} from '../lib/smsQueue';
import { SMS_TEMPLATES } from '../lib/smsTemplates';

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

    const response = await fetch(
      `https://api.surge.app/accounts/${accountId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: phone_number,
          body: message,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Surge API error:', response.status, errorText);
      return res.status(response.status).json({
        error: `Surge API error (${response.status})`,
        details: errorText,
      });
    }

    const result = await response.json() as { id: string; [key: string]: any };

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
 * Queue-aware SMS for agent questions
 * POST /api/send-sms/queue
 * Auth: API Key (internal - called by agent worker)
 *
 * Body:
 *   - user_id: string
 *   - agent_id: string
 *   - workflow_id: string
 *   - question: string
 */
router.post('/queue', authenticate, async (req: AuthRequest, res) => {
  try {
    const { user_id, agent_id, workflow_id, question } = req.body;

    if (!user_id || !agent_id || !workflow_id || !question) {
      return res.status(400).json({
        error: 'user_id, agent_id, workflow_id, and question are required',
      });
    }

    const userPhone = await getUserPhone(user_id);
    if (!userPhone) {
      return res.status(400).json({ error: 'User has no phone number' });
    }

    const message = SMS_TEMPLATES.question(question);
    const result = await enqueueOrSendSms(user_id, agent_id, workflow_id, message, userPhone);

    console.log('[SMS] Queue endpoint result', {
      userId: user_id,
      agentId: agent_id,
      sent: result.sent,
      queued: result.queued,
    });

    res.json(result);
  } catch (error) {
    console.error('[SMS] Error in queue endpoint:', error);
    res.status(500).json({ error: 'Failed to queue SMS' });
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
 * Handle agent unblocked (removes from queue, triggers next)
 * POST /api/send-sms/unblock
 * Auth: API Key (internal - called by agent worker)
 *
 * Body:
 *   - user_id: string
 *   - agent_id: string
 */
router.post('/unblock', authenticate, async (req: AuthRequest, res) => {
  try {
    const { user_id, agent_id } = req.body;

    if (!user_id || !agent_id) {
      return res.status(400).json({ error: 'user_id and agent_id are required' });
    }

    const userPhone = await getUserPhone(user_id);
    if (!userPhone) {
      // No phone number - nothing in queue to clean up
      return res.json({ nextSent: false });
    }

    const result = await handleAgentUnblocked(user_id, agent_id, userPhone);

    console.log('[SMS] Unblock endpoint result', {
      userId: user_id,
      agentId: agent_id,
      nextSent: result.nextSent,
      nextAgentId: result.nextAgentId,
    });

    res.json(result);
  } catch (error) {
    console.error('[SMS] Error in unblock endpoint:', error);
    res.status(500).json({ error: 'Failed to handle unblock' });
  }
});

export default router;

