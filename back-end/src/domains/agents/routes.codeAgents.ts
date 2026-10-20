/**
 * GET /api/agents/code-agents?root_ids=<comma-separated, max 50>
 *   → { code_agents: [{ code_agent_id, owner_agent_id, root_agent_id, provider,
 *                       status, title, created_at }] }
 *
 * Scoped to the caller: other users' roots return nothing.
 */
import { Router } from 'express';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { codeAgentsQuerySchema, listCodeAgents } from './agentCodeAgentsService';
import { handleRouteError } from './routes.helpers';

const router = Router();
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

router.get(
  '/code-agents',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const userId = req.userId;
      if (userId === undefined || userId === '') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const parsed = codeAgentsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          error: 'root_ids must list 1-50 agent ids',
          details: parsed.error.issues,
        });
        return;
      }
      res.json(await listCodeAgents(userId, parsed.data.root_ids));
    } catch (error) {
      handleRouteError(res, error, 'Failed to list code agents');
    }
  })
);

export default router;
