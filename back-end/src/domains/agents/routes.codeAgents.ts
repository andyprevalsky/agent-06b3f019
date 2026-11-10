/**
 * GET /api/agents/code-agents?root_ids=<comma-separated, max 50>
 *   → { code_agents: [{ code_agent_id, owner_agent_id, root_agent_id, provider,
 *                       status, code_session_id, awaiting_parent, title,
 *                       created_at }] }
 *
 * Newest first, at most 50 per root. status: ACTIVE | COMPLETED | CLOSED |
 * ERROR | PAUSED (resumable: idle, user pause, waiting on its parent, usage
 * limit). awaiting_parent: { question, at } | null.
 *
 * Scoped to the caller: other users' roots return nothing.
 */
import { Router } from 'express';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  codeAgentsQuerySchema,
  listCodeAgents,
  renameCodeAgentForUser,
} from './agentCodeAgentsService';
import { handleRouteError } from './routes.helpers';

const router = Router();
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

// Caller → hybrid auth → owner-scoped task update → persisted sidebar title.
router.patch(
  '/code-agents/:taskId',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const userId = req.userId;
      if (userId === undefined || userId === '') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const body = req.body as { title?: unknown } | null;
      const title = typeof body?.title === 'string' ? body.title.trim() : '';
      if (title.length === 0 || title.length > 80) {
        res.status(400).json({ error: 'title must contain 1-80 characters' });
        return;
      }
      const renamed = await renameCodeAgentForUser(userId, req.params.taskId, title);
      if (renamed === null) {
        res.status(404).json({ error: 'Code agent not found' });
        return;
      }
      res.json(renamed);
    } catch (error) {
      handleRouteError(res, error, 'Failed to rename code agent');
    }
  })
);

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
