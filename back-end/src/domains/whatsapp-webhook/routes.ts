/**
 * WhatsApp Webhook Routes (Meta Cloud API)
 *
 *   GET  /api/whatsapp/webhook  — Meta subscription-verification handshake
 *   POST /api/whatsapp/webhook  — inbound messages + delivery receipts
 *
 * The inbound message path routes through the SAME SMS supervisor, so texting
 * Rose over WhatsApp behaves identically to SMS.
 */

import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import * as service from './service';
import { InvalidSignatureError } from './service';

const log = createLogger('WhatsApp Webhook');

const router = Router();

/**
 * GET /api/whatsapp/webhook — Meta verification handshake. Echoes `hub.challenge`
 * as plain text when `hub.verify_token` matches, else 403.
 */
router.get(
  '/webhook',
  asyncHandler(async (req, res) => {
    const challenge = service.handleWebhookVerification({
      mode: req.query['hub.mode'] as string | undefined,
      token: req.query['hub.verify_token'] as string | undefined,
      challenge: req.query['hub.challenge'] as string | undefined,
    });
    if (challenge === null) {
      res.status(403).send('Forbidden');
      return;
    }
    res.status(200).type('text/plain').send(challenge);
  })
);

/**
 * POST /api/whatsapp/webhook — inbound messages. Always ack 200 quickly (Meta
 * retries on non-2xx); supervisor work runs async.
 */
router.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    try {
      const result = await service.handleInboundWhatsApp({
        body: req.body,
        rawBody: (req as unknown as { rawBody?: string }).rawBody,
        signatureHeader: req.headers['x-hub-signature-256'] as string | undefined,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof InvalidSignatureError) {
        res.status(403).json({ error: 'Invalid signature' });
        return;
      }
      log.error('Error processing inbound WhatsApp', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  })
);

export default router;
