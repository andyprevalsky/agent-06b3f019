import { Router } from 'express';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { isRoseDevUser, ROSE_DEV_ONLY_BODY } from '../../utils/roseDevAccess';
import { getRootPreview } from './rootPreviewService';
import { noCacheHeaders } from './routes.helpers';

const router = Router();
router.get(
  '/:id/local-preview',
  asyncHandler<HybridAuthRequest>(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    noCacheHeaders(res);
    if (req.userId === undefined || req.userId === '') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    // Same preview privilege boundary as the existing task preview and handoff routes.
    if (!isRoseDevUser(req.userId)) {
      res.status(403).json(ROSE_DEV_ONLY_BODY);
      return;
    }
    const view = await getRootPreview(req.userId, req.params.id);
    if (!view) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json(view);
  })
);
export default router;
