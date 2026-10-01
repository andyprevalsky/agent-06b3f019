/** Internal route for bounded, saved explore tool results after a parent timeout. */

import { Router } from 'express';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import * as exploreEvidenceService from './exploreEvidenceService';
import { noCacheHeaders } from './routes.helpers';

const router = Router();
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

router.get(
  '/:id/explore-tool-evidence',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    if (req.isInternal !== true || typeof req.userId !== 'string') {
      res.status(403).json({ error: 'Internal agent access required' });
      return;
    }
    const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : '';
    if (taskId.length < 1 || taskId.length > 128) {
      res.status(400).json({ error: 'Valid taskId is required' });
      return;
    }
    const results = await exploreEvidenceService.getExploreToolEvidence(
      req.params.id,
      req.userId,
      taskId
    );
    noCacheHeaders(res);
    res.json({ results });
  })
);

export default router;
