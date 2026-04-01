/**
 * SMS Webhook Routes
 *
 * Handles inbound SMS from Surge. Routes through:
 * 1. Shortcode fast-path: "Approve XXXXX" bypasses LLM for instant write-lock approval
 * 2. SMS Supervisor Agent: Everything else goes through the LLM-powered supervisor
 */

import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import * as service from './service';
import { InvalidSignatureError, InvalidPayloadError } from './service';

const log = createLogger('SMS Webhook');

const router = Router();

/**
 * POST /api/sms/inbound - Surge webhook for inbound SMS (message.received)
 */
router.post(
  '/inbound',
  asyncHandler(async (req, res) => {
    try {
      const result = await service.handleInboundSms({
        body: req.body,
        rawBody: (req as unknown as { rawBody?: string }).rawBody,
        surgeSignatureHeader: req.headers['surge-signature'] as string | undefined,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof InvalidSignatureError) {
        res.status(403).json({ error: 'Invalid signature' });
        return;
      }
      if (error instanceof InvalidPayloadError) {
        res.status(400).json({ error: 'Invalid message format' });
        return;
      }
      log.error('Error processing inbound SMS', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  })
);

export default router;
