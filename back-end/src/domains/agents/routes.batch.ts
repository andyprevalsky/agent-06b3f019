/**
 * POST /api/agents/batch — bulk create up to 200 agents in one HTTP call.
 * Used by the spawn_sub_agents_batch worker activity.
 *
 * Phase 1 is an atomic Prisma transaction (all-or-nothing). Phase 2 starts each
 * Temporal workflow in parallel via Promise.allSettled, relying on the SDK's
 * built-in gRPC retry interceptor for transient errors. See
 * agentBatchService.createAgentsBatch for the full design.
 */

import { TaskPathConflictError } from './agentTaskPath';
import { type Response, Router } from 'express';
import { z } from 'zod';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { getClientIP } from '../../providers/geoip';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import { StaleParentWorkflowGenerationError } from '../../providers/workflowGeneration';
import * as batchService from './agentBatchService';
import { WorldModelModeAccessError } from './agentExecutionMode';
import { AgentProjectNotFoundError } from './agentProject';
import { batchCreateAgentsSchema } from './types';
import { rejectAnonymousCreate, rejectGatedCreate } from './routes.guards';

const log = createLogger('AgentsBatch');
const router = Router();
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

function handleRouteError(res: Response, error: unknown, msg: string): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: 'Invalid request body', details: error.issues });
    return;
  }
  if (error instanceof StaleParentWorkflowGenerationError) {
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof TaskPathConflictError) {
    res.status(409).json({ error: error.message, task_path: error.taskPath });
    return;
  }
  if (error instanceof WorldModelModeAccessError) {
    res.status(403).json({ error: error.message });
    return;
  }
  if (error instanceof AgentProjectNotFoundError) {
    res.status(404).json({ error: error.message });
    return;
  }
  log.error(msg, { error: error instanceof Error ? error.message : String(error) });
  res.status(500).json({ error: msg });
}

router.post(
  '/',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const body = batchCreateAgentsSchema.parse(req.body);
      if (rejectAnonymousCreate(req, res, 'Login required to create agents')) return;
      if (await rejectGatedCreate(req, res)) return;
      const userId = req.userId ?? body.agents[0]?.user_id;
      if (userId === undefined || userId === null || userId === '') {
        res.status(401).json({ error: 'Unauthorized: user_id required' });
        return;
      }
      const clientIP = getClientIP(req);
      const results = await batchService.createAgentsBatch({
        bodies: body.agents,
        userId,
        isInternal: req.isInternal === true,
        clientIP,
      });
      // 207 Multi-Status: phase 1 (DB transaction) is all-or-nothing; if any
      // child's phase-2 workflow start failed, that child's row is FAILED in
      // results[i].status. Caller iterates results to attribute success/failure.
      const anyFailed = results.some((r) => r.status === 'FAILED');
      res.status(anyFailed ? 207 : 201).json({ results });
    } catch (error) {
      handleRouteError(res, error, 'Failed to batch-create agents');
    }
  })
);

export default router;
