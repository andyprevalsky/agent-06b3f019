/** Internal routes used by the external agent-failure alert workflow. */

import { Router } from 'express';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import * as queryService from './agentQueryService';

const log = createLogger('AgentAlerts');
const router = Router();
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

router.get(
  '/:id/alert-context',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      if (req.isInternal !== true) {
        res.status(403).json({ error: 'Internal authentication required' });
        return;
      }
      const result = await queryService.getAgentAlertContext(req.params.id);
      if (result === null) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      res.json(result);
    } catch (error) {
      log.error('Failed to fetch agent alert context', {
        agent_id: req.params.id,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to fetch agent alert context' });
    }
  })
);

export default router;
