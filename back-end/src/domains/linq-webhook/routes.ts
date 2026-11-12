import { Router, raw } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import {
  handleInboundLinq,
  InvalidSignatureError,
  InvalidPayloadError,
  WebhookUnavailableError,
} from './service';
import type { LinqSupervisorHandlers } from './types';

const log = createLogger('Linq Webhook');

export function createLinqWebhookRouter(supervisor: LinqSupervisorHandlers): Router {
  const router = Router();
  router.post(
    '/webhook',
    raw({ type: 'application/json', limit: '1mb', inflate: false }),
    asyncHandler(async (req, res) => {
      try {
        const header = (name: string): string | undefined => {
          const value = req.headers[name];
          return typeof value === 'string' ? value : undefined;
        };
        const result = await handleInboundLinq(
          {
            rawBody: Buffer.isBuffer(req.body) ? req.body : undefined,
            headers: {
              id: header('webhook-id'),
              timestamp: header('webhook-timestamp'),
              signature: header('webhook-signature'),
            },
          },
          supervisor
        );
        res.json(result);
      } catch (error) {
        if (error instanceof InvalidSignatureError) {
          res.status(403).json({ error: 'Invalid signature' });
          return;
        }
        if (error instanceof InvalidPayloadError) {
          res.status(400).json({ error: 'Invalid JSON' });
          return;
        }
        if (error instanceof WebhookUnavailableError) {
          res.status(503).json({ error: 'Webhook unavailable' });
          return;
        }
        log.error('Inbound processing failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: 'Internal server error' });
      }
    })
  );
  return router;
}
