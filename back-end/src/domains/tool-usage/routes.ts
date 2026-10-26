/**
 * Tool-usage routes — thin controller layer.
 *
 * POST /api/tool-usage                - Save tool usage (internal service-to-service)
 * GET  /api/tool-usage/tree/:agentId  - Get aggregated tool usage for agent tree
 * GET  /api/tool-usage/:agentId       - Get tool usage for a single agent
 */

import { type Response, Router } from 'express';
import { type AuthRequest, authenticate, authenticateInternal } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import {
  saveToolUsage,
  getToolUsageForAgent,
  getToolUsageForTree,
  AgentNotFoundError,
  AgentOwnershipError,
  AccessDeniedError,
  WorkflowGenerationMismatchError,
} from './service';

const log = createLogger('ToolUsage');
const router = Router();

function saveToolUsageValidationError(body: Record<string, unknown>): string | null {
  if (body.agent_id === undefined || body.agent_id === null || body.agent_id === '') {
    return 'agent_id is required';
  }
  if (body.user_id === undefined || body.user_id === null || body.user_id === '') {
    return 'user_id is required';
  }
  if (body.tool_name === undefined || body.tool_name === null || body.tool_name === '') {
    return 'tool_name is required';
  }
  if (!Number.isFinite(body.total_cost_cents) || Number(body.total_cost_cents) < 0) {
    return 'total_cost_cents must be a non-negative number';
  }
  if (!Array.isArray(body.usage_items)) return 'usage_items must be an array';
  if (
    body.operation_key !== undefined &&
    (typeof body.operation_key !== 'string' || body.operation_key.length < 1)
  ) {
    return 'operation_key must be a non-empty string';
  }
  const checkpoint = body.accounting_checkpoint;
  if (
    checkpoint !== undefined &&
    (typeof checkpoint !== 'object' ||
      checkpoint === null ||
      !['token_count', 'tokens_in', 'tokens_out', 'own_cost_cents'].every((field) => {
        const value = (checkpoint as Record<string, unknown>)[field];
        return Number.isFinite(value) && Number(value) >= 0;
      }))
  ) {
    return 'accounting_checkpoint fields must be non-negative numbers';
  }
  return null;
}

/**
 * Save tool usage
 * POST /api/tool-usage
 * Auth: API Key (internal service-to-service)
 */
router.post(
  '/',
  authenticateInternal,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const validationError = saveToolUsageValidationError(req.body as Record<string, unknown>);
      if (validationError !== null) {
        res.status(400).json({ error: validationError });
        return;
      }
      const {
        agent_id,
        user_id,
        tool_name,
        total_cost_cents,
        usage_items,
        operation_key,
        accounting_checkpoint,
      } = req.body;

      const result = await saveToolUsage({
        agent_id,
        user_id,
        tool_name,
        total_cost_cents,
        usage_items,
        operation_key,
        accounting_checkpoint,
        workflow_generation:
          req.isInternal === true
            ? (req.header('x-agent-workflow-generation') ?? agent_id)
            : undefined,
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
      if (error instanceof WorkflowGenerationMismatchError) {
        res.status(409).json({ error: error.message });
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
 * Get aggregated tool usage for an agent tree (root + all sub-agents)
 * GET /api/tool-usage/tree/:agentId
 * Auth: API Key or JWT (must own root agent)
 */
router.get(
  '/tree/:agentId',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const { agentId } = req.params;
      const userId = req.user?.id;

      const result = await getToolUsageForTree(agentId, userId, req.isInternal === true);

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

      log.error('Error fetching tree tool usage', {
        agent_id: req.params.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to fetch tree tool usage' });
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
