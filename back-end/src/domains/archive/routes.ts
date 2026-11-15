import { Router, type Response } from 'express';
import { authenticate, authenticateInternal, type AuthRequest } from '../../providers/auth';
import { callerCanAccessAgent } from '../../providers/agentAccess';
import { asyncHandler } from '../../utils/asyncHandler';
import { isBoundArchiveId } from '../../providers/llmArchiveRecord';
import * as service from './service';
import type {
  AgentFinalizeRequest,
  AgentStartRequest,
  StoreEncryptedArtifactRequest,
} from './types';

const router = Router();

router.post(
  '/artifacts',
  authenticateInternal,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    const posted = (req.body as { rootAgentId?: unknown } | null)?.rootAgentId;
    if (!isBoundArchiveId(posted)) {
      res.status(400).json({ error: 'Archive rootAgentId must be a bound root id' });
      return;
    }
    try {
      res.json(await service.storeWorkerArtifacts(req.body));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid archive batch';
      if (message.startsWith('Archive ') || message.startsWith('Unsupported archive ')) {
        res.status(400).json({ error: message });
        return;
      }
      throw error;
    }
  })
);

router.post(
  '/artifact',
  authenticateInternal,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    const body = req.body as StoreEncryptedArtifactRequest;
    if (typeof body.rootAgentId !== 'string' || typeof body.path !== 'string') {
      res.status(400).json({ error: 'rootAgentId and path are required' });
      return;
    }
    if (!isBoundArchiveId(body.rootAgentId)) {
      res.status(400).json({ error: 'Archive rootAgentId must be a bound root id' });
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
    try {
      const result = await service.storeWorkerArtifact(body);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid archive artifact';
      if (message.startsWith('Archive ')) {
        res.status(400).json({ error: message });
        return;
      }
      throw error;
    }
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
    if (!(await callerCanAccessAgent(req, body.agentId))) {
      res.status(403).json({ error: 'Agent not owned by caller' });
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
    if (!(await callerCanAccessAgent(req, body.rootAgentId))) {
      res.status(403).json({ error: 'Agent not owned by caller' });
      return;
    }
    const result = await service.finalizeAgent(body);
    res.json(result);
  })
);

export default router;
