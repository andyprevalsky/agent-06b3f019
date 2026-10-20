import { Router, type Response } from 'express';
import { authenticate, type AuthRequest } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service.linkedinSync';

const router = Router();

/** POST /api/integrations/linkedin/sync — record the spawned export agent. */
router.post(
  '/linkedin/sync',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.isInternal === true ? req.headers['x-user-id'] : req.user?.id;
    if (typeof userId !== 'string' || userId === '') {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const agentId = (req.body as { agent_id?: unknown } | undefined)?.agent_id;
    if (typeof agentId !== 'string' || agentId.trim() === '') {
      return res.status(400).json({ error: 'agent_id is required' });
    }
    try {
      return res.json(await service.startLinkedInSync(userId, agentId.trim()));
    } catch (error) {
      if (error instanceof service.LinkedInSyncAgentNotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      if (error instanceof service.LinkedInSyncAlreadyRunningError) {
        return res.status(409).json({ error: error.message, agent_id: error.agentId });
      }
      throw error;
    }
  })
);

export default router;
