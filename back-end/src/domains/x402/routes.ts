/**
 * x402 Payment Routes for Rose Agent Bazaar
 *
 * Endpoints:
 * - POST /api/x402/topup - Add credits (x402 protected, min $0.05)
 * - GET /api/x402/agents/:id/status - Check agent status (public)
 *
 * Note: Agent creation is now unified at POST /api/agents with hybrid auth
 * (supports JWT, API key, or x402 payment)
 */

import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import * as service from './service';
import { TopupValidationError, AgentNotFoundError } from './service';

const log = createLogger('X402');
const router = Router();

/**
 * POST /api/x402/topup
 * Add credits to wallet account (x402 protected)
 *
 * Note: Agents automatically unpause when they poll and see credits are restored.
 * No need to manually update agent status here.
 */
router.post(
  '/topup',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const payment = (req as Request & { payment?: { amount?: string; payer?: string } }).payment;
      const result = await service.processTopup(payment);
      res.json(result);
    } catch (error) {
      if (error instanceof TopupValidationError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      log.error('x402 topup error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to process topup' });
    }
  })
);

/**
 * GET /api/x402/agents/:id/status
 * Get agent status (public - no auth required)
 */
router.get(
  '/agents/:id/status',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const agentId = req.params.id;
      const result = await service.getAgentStatus(agentId);
      res.json(result);
    } catch (error) {
      if (error instanceof AgentNotFoundError) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      log.error('x402 agent status error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to get agent status' });
    }
  })
);

export default router;
