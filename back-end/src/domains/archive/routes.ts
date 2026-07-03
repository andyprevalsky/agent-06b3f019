import { Router, type Response } from 'express';
import { authenticate, type AuthRequest } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service';
import type {
  AgentFinalizeRequest,
  AgentStartRequest,
  StoreEncryptedArtifactRequest,
} from './types';

const router = Router();

router.post(
  '/artifact',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    const body = req.body as StoreEncryptedArtifactRequest;
    if (typeof body.rootAgentId !== 'string' || typeof body.path !== 'string') {
      res.status(400).json({ error: 'rootAgentId and path are required' });
      return;
    }
    if (
      typeof body.ciphertextB64 !== 'string' ||
      typeof body.metadata !== 'object' ||
      body.metadata === null
    ) {
      res.status(400).json({ error: 'ciphertextB64 and metadata are required' });
      return;
    }
    const result = await service.storeWorkerArtifact(body);
    res.json(result);
  })
);

router.post(
  '/agent-start',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    const body = req.body as AgentStartRequest;
    if (typeof body.agentId !== 'string' || body.agentId === '') {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    const result = await service.captureAgentStart(body);
    res.json(result);
  })
);

router.post(
  '/agent-finalize',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    const body = req.body as AgentFinalizeRequest;
    if (typeof body.rootAgentId !== 'string' || body.rootAgentId === '') {
      res.status(400).json({ error: 'rootAgentId is required' });
      return;
    }
    const result = await service.finalizeAgent(body);
    res.json(result);
  })
);

export default router;
