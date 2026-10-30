/**
 * Agents routes — thin controller layer.
 * Parse request, call service, send response.
 */

import { Router } from 'express';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { canReadBenchmarkArchive } from '../../providers/benchmarkHubStore';
import { getClientIP } from '../../providers/geoip';
import { asyncHandler } from '../../utils/asyncHandler';
import { createAgentSchema, searchAgentsQuerySchema, updateAgentSchema } from './types';
import * as routeGuards from './routes.guards';
import * as lifecycleService from './agentLifecycleService';
import * as controlService from './agentControlService';
import { pauseAtBrowserBudgetForUser } from './agentBudgetStopService';
import * as queryService from './agentQueryService';
import messageRoutes from './routes.messages';
import exploreEvidenceRoutes from './routes.exploreEvidence';
import batchRoutes from './routes.batch';
import statusRoutes from './routes.status';
import progressEstimateRoutes from './routes.progressEstimate';
import archiveRoutes from './routes.archive';
import reportBugRoutes from './routes.reportBug';
import phoneRoutes from './routes.phone';
import codeAgentRoutes from './routes.codeAgents';
import rootPreviewRoutes from './routes.rootPreview';
import agentMessageRoutes from './routes.agentMessages';
import { handleRouteError, noCacheHeaders } from './routes.helpers';

const router = Router();

const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

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
  '/search',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      noCacheHeaders(res);
      if (req.userId === undefined) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const { q } = searchAgentsQuerySchema.parse(req.query);
      res.json(await queryService.searchAgents(req.userId, q));
    } catch (error) {
      handleRouteError(res, error, 'Failed to search agents');
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

router.use('/', codeAgentRoutes);
router.use('/', rootPreviewRoutes);
router.use('/', archiveRoutes);
router.use('/', reportBugRoutes);

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
        browserToolCallId:
          typeof req.query.browserToolCallId === 'string' ? req.query.browserToolCallId : undefined,
        // A worker's incremental poll is the agent's (or browser task's) own read.
        consumesAgentMessages: req.isInternal === true && since !== undefined,
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

router.use('/', exploreEvidenceRoutes);

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
      // The Rose Mac app's main process stamps its device id on renderer
      // requests; it is recorded as the agent's origin (C14 local code agents).
      const originDeviceHeader =
        req.isInternal === true ? undefined : req.header('x-rose-device-id');
      const result = await lifecycleService.createAgent(
        body,
        userId,
        req.isInternal === true,
        clientIP,
        routeGuards.isBenchmarkRequest(req),
        originDeviceHeader !== undefined ? { originDeviceHeader } : {}
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
router.use(progressEstimateRoutes);

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
  '/:id/browser-budget-stop',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    if (req.userId === undefined) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.json(await pauseAtBrowserBudgetForUser(req.params.id, req.userId, req.body));
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

// Mount message, attachment, signal, schema, and phone-recording routes
router.use(messageRoutes);
router.use(phoneRoutes);
router.use(agentMessageRoutes);

export default router;
