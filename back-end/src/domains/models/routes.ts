import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service';
import { createLogger } from '../../providers/logger';

const log = createLogger('Models');
const router = Router();

/**
 * DELETE /api/models/cache - Clear model cache (useful for testing)
 */
router.delete('/cache', (req: Request, res: Response) => {
  service.clearCache();
  res.json({ message: 'Model cache cleared' });
});

/**
 * GET /api/models - Get available OpenRouter models
 * Returns cached list of models sorted by provider and capability
 * Filters to only models that support tool use
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const result = await service.listModels();
      res.json(result);
    } catch (error) {
      log.error('Models endpoint error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        error: 'Failed to fetch models',
        details: errorMessage,
        hasOpenRouterKey:
          process.env.OPENROUTER_API_KEY !== undefined && process.env.OPENROUTER_API_KEY !== '',
      });
    }
  })
);

export default router;
