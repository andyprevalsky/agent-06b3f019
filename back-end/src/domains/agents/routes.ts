/**
 * Agents routes — thin controller layer.
 * Parse request, call service, send response.
 */

import { type Response, Router } from 'express';
import { z } from 'zod';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { canReadBenchmarkArchive } from '../../providers/benchmarkHubStore';
import { getClientIP } from '../../providers/geoip';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import { StaleParentWorkflowGenerationError } from '../../providers/workflowGeneration';
import { createAgentSchema, updateAgentSchema } from './types';
import * as routeGuards from './routes.guards';
import * as lifecycleService from './agentLifecycleService';
import * as controlService from './agentControlService';
import * as queryService from './agentQueryService';
import { WorldModelModeAccessError } from './agentExecutionMode';
import messageRoutes from './routes.messages';
import batchRoutes from './routes.batch';
import alertRoutes from './routes.alerts';
import statusRoutes from './routes.status';

const log = createLogger('Agents');
const router = Router();

const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noCacheHeaders(res: Response): void {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

function handleRouteError(
  res: Response,
  error: unknown,
  msg: string,
  ctx?: Record<string, string>
): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: 'Invalid request body', details: error.issues });
    return;
  }
  if (error instanceof StaleParentWorkflowGenerationError) {
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof WorldModelModeAccessError) {
    res.status(403).json({ error: error.message });
    return;
  }
  log.error(msg, {
    ...ctx,
    error: error instanceof Error ? error.message : String(error),
  });
  res.status(500).json({ error: msg });
}

// ---------------------------------------------------------------------------
// Query routes
// ---------------------------------------------------------------------------

router.get(
  '/',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      noCacheHeaders(res);
      if (req.userId === undefined) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const result = await queryService.listAgents(req.userId);
      res.json(result);
    } catch (error) {
      handleRouteError(res, error, 'Failed to fetch agents');
    }
  })
);

router.get(
  '/tree',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const { busId } = req.query;
      if (typeof busId !== 'string' || busId === '') {
        res.status(400).json({ error: 'busId query parameter is required' });
        return;
      }
      res.json(await queryService.getAgentTree(busId, canReadBenchmarkArchive(req)));
    } catch (error) {
      handleRouteError(res, error, 'Failed to fetch agent tree');
    }
  })
);

router.use('/', alertRoutes);

router.get(
  '/:id',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      noCacheHeaders(res);
      const { userId, inspectionViewerUserId } = routeGuards.resolveAgentReadAccess(req);
      const rawSince = typeof req.query.since === 'string' ? new Date(req.query.since) : undefined;
      const since = rawSince && !isNaN(rawSince.getTime()) ? rawSince : undefined;
      const result = await queryService.getAgentDetail(req.params.id, {
        userId,
        since,
        allowBenchmarkArchive: canReadBenchmarkArchive(req),
        inspectionViewerUserId,
      });
      if (result === null) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      res.json(result);
    } catch (error) {
      handleRouteError(res, error, 'Failed to fetch agent', { agent_id: req.params.id });
    }
  })
);

router.get(
  '/:id/ancestors',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      res.json(await queryService.getAncestors(req.params.id));
    } catch (error) {
      handleRouteError(res, error, 'Failed to fetch ancestors', { agent_id: req.params.id });
    }
  })
);

router.get(
  '/:id/status',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const result = await queryService.getAgentStatus(req.params.id);
      if (result === null) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      res.json(result);
    } catch (error) {
      handleRouteError(res, error, 'Failed to get agent status', { agent_id: req.params.id });
    }
  })
);

// ---------------------------------------------------------------------------
// Lifecycle routes
// ---------------------------------------------------------------------------

router.post(
  '/',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const body = createAgentSchema.parse(req.body);
      if (routeGuards.rejectAnonymousCreate(req, res)) return;
      if (await routeGuards.rejectGatedCreate(req, res)) return;
      const userId = req.userId ?? body.user_id;
      if (userId === undefined || userId === null || userId === '') {
        res.status(401).json({ error: 'Unauthorized: user_id required' });
        return;
      }
      const clientIP = getClientIP(req);
      const result = await lifecycleService.createAgent(
        body,
        userId,
        req.isInternal === true,
        clientIP,
        routeGuards.isBenchmarkRequest(req)
      );
      res.status(201).json(result);
    } catch (error) {
      handleRouteError(res, error, 'Failed to create agent');
    }
  })
);

// Bulk create up to 200 agents in one HTTP call. Implementation lives in
// routes.batch.ts to keep this file under the lint budget.
router.use('/batch', batchRoutes);

router.delete(
  '/:id',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const userId = req.isInternal === true ? undefined : req.userId;
      const found = await lifecycleService.deleteAgent(req.params.id, userId);
      if (!found) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      res.status(204).send();
    } catch (error) {
      handleRouteError(res, error, 'Failed to delete agent', { agent_id: req.params.id });
    }
  })
);

router.use(statusRoutes);

router.patch(
  '/:id',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const userId = req.isInternal === true ? undefined : req.userId;
      const body = updateAgentSchema.parse(req.body);
      const generation =
        req.isInternal === true
          ? (req.header('x-agent-workflow-generation') ?? req.params.id)
          : undefined;
      const result = await controlService.updateAgentConfig(
        req.params.id,
        body,
        userId,
        generation
      );
      if ('error' in result) {
        const rb: Record<string, unknown> = { error: result.error };
        if ('current_cost_cents' in result) {
          rb.current_cost_cents = result.current_cost_cents;
        }
        res.status(result.status ?? 500).json(rb);
        return;
      }
      res.json(result);
    } catch (error) {
      handleRouteError(res, error, 'Failed to update agent', { agent_id: req.params.id });
    }
  })
);

router.post(
  '/:id/start-agent',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      if (req.userId === undefined) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const result = await controlService.startAgentMode(req.params.id, req.userId);
      if ('error' in result) {
        res.status(result.status ?? 500).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (error) {
      handleRouteError(res, error, 'Failed to start agent mode', { agent_id: req.params.id });
    }
  })
);

router.post(
  '/:id/pause',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      if (req.userId === undefined) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const result = await controlService.pauseAgentForUser(req.params.id, req.userId);
      if ('error' in result) {
        res.status(result.status ?? 500).json({ error: result.error });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      handleRouteError(res, error, 'Failed to pause agent', { agent_id: req.params.id });
    }
  })
);

router.post(
  '/:id/resume',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      if (req.userId === undefined) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const result = await controlService.resumeAgentForUser(req.params.id, req.userId);
      if ('error' in result) {
        res.status(result.status ?? 500).json({ error: result.error });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      handleRouteError(res, error, 'Failed to resume agent', { agent_id: req.params.id });
    }
  })
);

router.post(
  '/:id/restart',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const userId = req.isInternal === true ? undefined : req.userId;
      const result = await controlService.restartAgent(req.params.id, userId);
      if ('error' in result) {
        res.status(result.status ?? 500).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (error) {
      handleRouteError(res, error, 'Failed to restart agent', { agent_id: req.params.id });
    }
  })
);

// Mount message, attachment, signal, and schema routes
router.use(messageRoutes);

export default router;
