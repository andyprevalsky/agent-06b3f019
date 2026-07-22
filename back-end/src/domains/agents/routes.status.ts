import { Router } from 'express';
import { z } from 'zod';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import * as controlService from './agentControlService';
import { updateStatusSchema } from './types';

const log = createLogger('Agents');
const router = Router();
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

router.patch(
  '/:id/status',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const body = updateStatusSchema.parse(req.body);
      const generation =
        req.isInternal === true
          ? (req.header('x-agent-workflow-generation') ?? req.params.id)
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

export default router;
