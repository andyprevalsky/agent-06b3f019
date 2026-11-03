import { Router } from 'express';
import { z } from 'zod';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { updateAgentProgressEstimate } from './agentProgressEstimateService';
import { updateProgressEstimateSchema } from './types';

const router = Router();
router.patch(
  '/:id/progress-estimate',
  asyncHandler<HybridAuthRequest>(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    if (req.isInternal !== true) {
      res.status(403).json({ error: 'Internal workflow authentication required' });
      return;
    }
    const generation = req.header('x-agent-workflow-generation');
    if (generation === undefined || generation.length === 0) {
      res.status(400).json({ error: 'X-Agent-Workflow-Generation header is required' });
      return;
    }
    try {
      const { progressEstimate } = updateProgressEstimateSchema.parse(req.body);
      const result = await updateAgentProgressEstimate(req.params.id, generation, progressEstimate);
      const status =
        result.outcome === 'not_found'
          ? 404
          : result.outcome === 'stale_generation' || result.outcome === 'unknown_task'
            ? 409
            : 200;
      res.status(status).json({ outcome: result.outcome });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid request body', details: error.issues });
        return;
      }
      throw error;
    }
  })
);
export default router;
