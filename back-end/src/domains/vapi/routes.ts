import { Router, type Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { authenticateInternal, type AuthRequest } from '../../providers/auth';
import * as service from './service';
import { VapiNotConfiguredError, VapiApiError } from './vapiClientService';
import holdRouter from './routesHold';
import type { CreateCallRequest } from './types';
import { createLogger } from '../../providers/logger';

const log = createLogger('Vapi');
const router = Router();

// Twilio/Vapi hold webhooks; each URL carries a per-session HMAC token.
router.use('/hold', holdRouter);

/**
 * Initiate an outbound phone call via Vapi
 * POST /api/vapi/call
 * Auth: API Key (internal - called by agent worker)
 *
 * Body:
 *   - to: string (E.164 format phone number)
 *   - system_prompt: string (LLM-defined behavior instructions)
 *   - output_schema: object (JSON Schema for structured data extraction)
 *
 * Returns: { call_id, status }
 */
router.post(
  '/call',
  authenticateInternal,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    try {
      const { to, system_prompt, output_schema, idempotency_key, user_id } =
        req.body as CreateCallRequest;

      // Validate input
      if (to === undefined || to === '') {
        res.status(400).json({ error: 'to (phone number) is required' });
        return;
      }
      if (system_prompt === undefined || system_prompt === '') {
        res.status(400).json({ error: 'system_prompt is required' });
        return;
      }
      if (output_schema === undefined || output_schema === null) {
        res.status(400).json({ error: 'output_schema is required' });
        return;
      }

      const result = await service.initiateCall({
        to,
        system_prompt,
        output_schema,
        idempotency_key,
        user_id,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof VapiNotConfiguredError) {
        res.status(500).json({ error: 'Vapi not configured' });
        return;
      }
      if (error instanceof VapiApiError) {
        res.status(error.statusCode).json({
          error: error.message,
          details: error.details,
        });
        return;
      }
      log.error('Error initiating Vapi call', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({ error: 'Failed to initiate call' });
    }
  })
);

/**
 * Poll call status from Vapi
 * GET /api/vapi/call/:id
 * Auth: API Key (internal - called by agent worker)
 *
 * Returns: Full Vapi call response (status, duration, transcript, structuredData, etc.)
 */
router.get(
  '/call/:id',
  authenticateInternal,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;

      if (id === undefined || id === '') {
        res.status(400).json({ error: 'call id is required' });
        return;
      }

      const result = await service.getCallStatus(id);
      res.json(result);
    } catch (error) {
      if (error instanceof VapiNotConfiguredError) {
        res.status(500).json({ error: 'Vapi not configured' });
        return;
      }
      if (error instanceof VapiApiError) {
        res.status(error.statusCode).json({
          error: error.message,
          details: error.details,
        });
        return;
      }
      log.error('Error polling Vapi call', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({ error: 'Failed to poll call status' });
    }
  })
);

export default router;
