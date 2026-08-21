/**
 * Agent archive routes — the sidebar's archived view.
 *
 * "Archive" is the existing soft delete: DELETE /api/agents/:id sets deletedAt
 * (see agentLifecycleService.deleteAgentRecursive) rather than removing rows,
 * so archived agents stay readable and restorable. That delete route lives in
 * routes.ts with the other lifecycle verbs; only listing and restoring live
 * here, split out to keep routes.ts inside the file-size budget.
 */

import { Router } from 'express';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { listArchivedAgentsQuerySchema } from './types';
import * as lifecycleService from './agentLifecycleService';
import * as queryService from './agentQueryService';
import { handleRouteError, noCacheHeaders } from './routes.helpers';

const router = Router();

const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

// Archived (soft-deleted) agents. Mounted before '/:id' in routes.ts so the
// literal path is not swallowed by the id param.
router.get(
  '/archived',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      noCacheHeaders(res);
      if (req.userId === undefined) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const { limit } = listArchivedAgentsQuerySchema.parse(req.query);
      res.json(await queryService.listArchivedAgents(req.userId, limit));
    } catch (error) {
      handleRouteError(res, error, 'Failed to fetch archived agents');
    }
  })
);

// Restore a soft-deleted agent. The run is NOT resumed — archiving already
// terminated its workflow and tore down its sessions.
router.post(
  '/:id/unarchive',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const userId = req.isInternal === true ? undefined : req.userId;
      const found = await lifecycleService.unarchiveAgent(req.params.id, userId);
      if (!found) {
        res.status(404).json({ error: 'Archived agent not found' });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      handleRouteError(res, error, 'Failed to unarchive agent', { agent_id: req.params.id });
    }
  })
);

export default router;
