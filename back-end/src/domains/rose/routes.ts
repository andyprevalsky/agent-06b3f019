/**
 * Rose routes — thin controller layer.
 *
 * POST /v1/chat/completions — OpenRouter-compatible chat completions endpoint
 * GET  /v1/cost/:modelName  — Average cost for Rose model pools
 * POST /bench               — Benchmarking (temporarily disabled)
 */

import { Router, type Response } from 'express';
import type { AuthRequest } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  chatCompletion,
  calculateCost,
  UnknownModelError,
  UpstreamApiError,
  NoPricingError,
} from './service';
import { createLogger } from '../../providers/logger';

const log = createLogger('Rose');
const router = Router();

/**
 * POST /v1/chat/completions
 * OpenRouter-compatible chat completions endpoint
 * Routes to Cerebras API for rose-hyper, OpenRouter for other models
 */
router.post(
  '/chat/completions',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const { model, messages } = req.body as { model?: string; messages?: unknown[] };

      // Validate request
      if (model === undefined || model === '') {
        res.status(400).json({ error: 'Missing required field: model' });
        return;
      }
      if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: 'Missing or invalid required field: messages' });
        return;
      }

      const data = await chatCompletion(req.body);
      res.json(data);
    } catch (error) {
      if (error instanceof UnknownModelError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof UpstreamApiError) {
        res.status(error.statusCode).json({
          error: error.message,
          details: error.details,
        });
        return;
      }
      log.error('Rose endpoint error', {
        error: error instanceof Error ? error.message : String(error),
      });
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        error: 'Internal server error',
        details: errorMessage,
      });
    }
  })
);

/**
 * GET /v1/cost/:modelName
 * Calculate average cost for Rose model pools
 * Returns average of pool models rounded up to nearest $0.05
 * Also returns minimum context length from all models in pool
 */
router.get(
  '/cost/:modelName',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const result = await calculateCost(req.params.modelName);
      res.json(result);
    } catch (error) {
      if (error instanceof UnknownModelError) {
        res.status(404).json({ error: `Model not found: ${req.params.modelName}` });
        return;
      }
      if (error instanceof NoPricingError) {
        res.status(500).json({ error: error.message });
        return;
      }
      log.error('Cost calculation error', {
        error: error instanceof Error ? error.message : String(error),
      });
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        error: 'Failed to calculate cost',
        details: errorMessage,
      });
    }
  })
);

/**
 * POST /bench
 * Temporarily disabled while the heavy harnesses are excluded from builds.
 */
router.post('/bench', (_req: AuthRequest, res: Response) => {
  return res.status(503).json({
    error: 'Benchmarking temporarily disabled',
    detail: 'Bench harnesses were removed from the build to keep TypeScript memory usage low.',
  });
});

export default router;
