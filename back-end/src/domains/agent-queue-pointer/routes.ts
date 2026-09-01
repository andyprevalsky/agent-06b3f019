/**
 * Internal AgentQueuePointer read for cooperative Temporal cutover.
 *
 * Workers call GET /api/agent-queue-pointer (X-API-Key) at each run_agent
 * checkpoint to decide whether to continue_as_new onto the live generation.
 */
import { Router } from 'express';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import {
  getCurrentAgentQueue,
  readAgentQueuePointer,
} from '../../providers/agentQueuePointer';
import { asyncHandler } from '../../utils/asyncHandler';

const router = Router();
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

router.get(
  '/',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    // Workers authenticate with the shared backend API key (isInternal).
    // Do not expose the pointer to end-user JWT/API-key clients.
    if (req.isInternal !== true) {
      res.status(403).json({ error: 'Internal API key required' });
      return;
    }

    const row = await readAgentQueuePointer();
    const taskQueue = row?.taskQueue ?? (await getCurrentAgentQueue());
    res.json({
      taskQueue,
      surfaceHash: row?.surfaceHash ?? null,
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ?? null,
    });
  })
);

export default router;
