import { Router } from 'express';
import { z } from 'zod';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import * as controlService from './agentControlService';
import { updateStatusSchema } from './types';
import { workerWriteGeneration } from '../../providers/codeResumeGeneration';
import { applyResumeCost } from './agentResumeCostService';

const log = createLogger('Agents');
const router = Router();
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

router.post(
  '/:id/workflow-replacement/bootstrap-ack',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    if (req.isInternal !== true) {
      res.status(403).json({ error: 'Internal workflow authentication required' });
      return;
    }
    const generation = await workerWriteGeneration(
      req.params.id,
      req.header('x-agent-workflow-generation')
    );
    if (generation === undefined || generation.length === 0) {
      res.status(400).json({ error: 'X-Agent-Workflow-Generation header is required' });
      return;
    }
    let restoredState;
    try {
      restoredState =
        req.body !== null &&
        typeof req.body === 'object' &&
        Object.keys(req.body as Record<string, unknown>).length > 0
          ? updateStatusSchema.parse(req.body)
          : undefined;
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid request body', details: error.issues });
        return;
      }
      throw error;
    }
    const result = await controlService.finalizeWorkflowReplacementBootstrap(
      req.params.id,
      generation,
      restoredState
    );
    if (result.outcome === 'not_found') {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    if (result.outcome === 'stale_generation') {
      res.status(409).json({ error: 'Workflow generation is no longer current' });
      return;
    }
    res.json({
      acknowledged: true,
      already_acknowledged: result.outcome === 'already_acknowledged',
      status: result.status,
    });
  })
);

router.patch(
  '/:id/status',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const body = updateStatusSchema.parse(req.body);
      const generation =
        req.isInternal === true
          ? ((await workerWriteGeneration(
              req.params.id,
              req.header('x-agent-workflow-generation')
            )) ?? req.params.id)
          : undefined;
      const updated = await controlService.updateAgentStatus(req.params.id, body, {}, generation);
      if (updated === null) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      res.json({
        agent_id: updated.id,
        status: updated.status,
        status_message: updated.statusMessage,
        progress: updated.progress,
        token_count: updated.tokenCount,
        tokens_in: updated.tokensIn,
        tokens_out: updated.tokensOut,
        context_size: updated.contextSize,
        message_count: updated.messageCount,
        updated_at: updated.updatedAt,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid request body', details: error.issues });
        return;
      }
      log.error('Failed to update agent status', {
        agent_id: req.params.id,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to update agent status' });
    }
  })
);

/**
 * POST /:id/resume-cost — a resume run's spend while its owner workflow is closed
 * (agentResumeCostService.ts). Internal workflow auth only.
 */
router.post(
  '/:id/resume-cost',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    if (req.isInternal !== true) {
      res.status(403).json({ error: 'Internal workflow authentication required' });
      return;
    }
    const result = await applyResumeCost(
      req.params.id,
      (req.body ?? {}) as Record<string, unknown>
    );
    if ('error' in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result);
  })
);

export default router;
