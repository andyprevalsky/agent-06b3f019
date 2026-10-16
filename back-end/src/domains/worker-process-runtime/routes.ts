import { Router } from 'express';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { issueWorkerProcessRuntime } from './service';
import { PRIVATE_RUNTIME_HEADERS } from './config';
import type { WorkerRuntimeIssuer } from './types';

export function createWorkerProcessRuntimeRouter(
  issue: WorkerRuntimeIssuer = issueWorkerProcessRuntime
) {
  const router = Router();
  router.get(
    '/',
    asyncHandler<HybridAuthRequest>(hybridAuth),
    asyncHandler<HybridAuthRequest>(async (req, res) => {
      res.set(PRIVATE_RUNTIME_HEADERS);
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
