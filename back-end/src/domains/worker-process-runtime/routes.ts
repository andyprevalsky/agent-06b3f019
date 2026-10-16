import { Router } from 'express';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { getWorkerProcessRuntimeEnvelope } from '../../providers/workerProcessRecovery';

export function createWorkerProcessRuntimeRouter(issue = getWorkerProcessRuntimeEnvelope) {
  const router = Router();
  router.get(
    '/',
    asyncHandler<HybridAuthRequest>(hybridAuth),
    asyncHandler<HybridAuthRequest>(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.set('Pragma', 'no-cache');
      if (req.isInternal !== true) {
        res.status(403).json({ error: 'Internal API key required' });
        return;
      }
      try {
        res.json(await issue(req.query));
      } catch {
        res.status(409).json({ error: 'Private worker runtime is unavailable' });
      }
    })
  );
  return router;
}
export default createWorkerProcessRuntimeRouter();
