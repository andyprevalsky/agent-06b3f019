import { Router, type Response } from 'express';
import { authenticateInternal, type AuthRequest } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service';
import type { NewWorldModelSessionRequest, WorldModelStepRequest } from './types';

// Internal-only: a WMH simulation shim for workers; any session id is steerable.
const router = Router();

router.get(
  '/',
  authenticateInternal,
  asyncHandler<AuthRequest>(async (_req: AuthRequest, res: Response) => {
    res.json(await service.listWorldModels());
  })
);

router.get(
  '/world_models',
  authenticateInternal,
  asyncHandler<AuthRequest>(async (_req: AuthRequest, res: Response) => {
    res.json(await service.listWorldModels());
  })
);

router.post(
  '/world_models/:worldModelName/sessions',
  authenticateInternal,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    const body = req.body as NewWorldModelSessionRequest;
    res.json(await service.createSession(req.params.worldModelName, body));
  })
);

router.post(
  '/world_models/:worldModelName/sessions/:sessionId/step',
  authenticateInternal,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    const body = req.body as WorldModelStepRequest;
    if (body.action === undefined || body.action === null) {
      res.status(400).json({ error: 'action is required' });
      return;
    }
    res.json(await service.stepSession(req.params.worldModelName, req.params.sessionId, body));
  })
);

export default router;
