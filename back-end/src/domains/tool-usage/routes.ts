/**
 * Tool-usage routes — thin controller layer.
 *
 * POST /api/tool-usage       - Save tool usage (internal service-to-service)
 * GET  /api/tool-usage/:agentId - Get tool usage for an agent
 */

import { type Response, Router } from 'express';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import {
  saveToolUsage,
  getToolUsageForAgent,
  AgentNotFoundError,
  AgentOwnershipError,
  AccessDeniedError,
} from './service';

const log = createLogger('ToolUsage');
const router = Router();

/**
 * Save tool usage
 * POST /api/tool-usage
 * Auth: API Key (internal service-to-service)
 */
router.post(
  '/',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const { agent_id, user_id, tool_name, total_cost_cents, usage_items } = req.body;

      // Validate required fields
      if (agent_id === undefined || agent_id === null || agent_id === '') {
        res.status(400).json({ error: 'agent_id is required' });
        return;
      }
      if (user_id === undefined || user_id === null || user_id === '') {
        res.status(400).json({ error: 'user_id is required' });
        return;
      }
      if (tool_name === undefined || tool_name === null || tool_name === '') {
        res.status(400).json({ error: 'tool_name is required' });
        return;
      }
      if (typeof total_cost_cents !== 'number') {
        res.status(400).json({ error: 'total_cost_cents must be a number' });
        return;
      }
      if (!Array.isArray(usage_items)) {
        res.status(400).json({ error: 'usage_items must be an array' });
        return;
      }

      const result = await saveToolUsage({
        agent_id,
        user_id,
        tool_name,
        total_cost_cents,
        usage_items,
      });

      res.status(201).json(result);
    } catch (error) {
      if (error instanceof AgentNotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error instanceof AgentOwnershipError) {
        res.status(403).json({ error: error.message });
        return;
      }

      log.error('Error saving tool usage', {
        agent_id: req.body?.agent_id,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to save tool usage' });
    }
  })
);

/**
 * Get tool usage for an agent
 * GET /api/tool-usage/:agentId
 * Auth: API Key or JWT (must own agent)
 */
router.get(
  '/:agentId',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const { agentId } = req.params;
      const userId = req.user?.id;

      const result = await getToolUsageForAgent(agentId, userId, req.isInternal === true);

      res.json(result);
    } catch (error) {
      if (error instanceof AgentNotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error instanceof AccessDeniedError) {
        res.status(403).json({ error: error.message });
        return;
      }

      log.error('Error fetching tool usage', {
        agent_id: req.params.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to fetch tool usage' });
    }
  })
);

export default router;
