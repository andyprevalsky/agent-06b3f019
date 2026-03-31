import { type Response, Router } from 'express';
import { z } from 'zod';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import { appendEntrySchema } from './types';
import { getMemory, appendEntry, MemoryLimitExceededError } from './service';

const log = createLogger('Memory');
const router = Router();

// GET /api/memory/:busId - Get shared memory for a run
router.get(
  '/:busId',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req: HybridAuthRequest, res: Response) => {
    try {
      const { busId } = req.params;
      const clientHash = req.query.hash as string | undefined;

      const result = await getMemory(busId, clientHash);

      if ('notModified' in result) {
        res.status(304).send();
        return;
      }

      res.json({
        content: result.content,
        hash: result.hash,
      });
    } catch (error) {
      log.error('GET error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to fetch shared memory' });
    }
  })
);

// POST /api/memory/:busId/append - Append entry to shared memory
router.post(
  '/:busId/append',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req: HybridAuthRequest, res: Response) => {
    try {
      const { busId } = req.params;
      const body = appendEntrySchema.parse(req.body);

      const result = await appendEntry(busId, body);

      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid request body', details: error.errors });
        return;
      }
      if (error instanceof MemoryLimitExceededError) {
        res.status(400).json({
          error: 'Memory limit exceeded',
          max_tokens: error.maxTokens,
          current_tokens: error.currentTokens,
        });
        return;
      }
      log.error('POST append error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to append to shared memory' });
    }
  })
);

export default router;
