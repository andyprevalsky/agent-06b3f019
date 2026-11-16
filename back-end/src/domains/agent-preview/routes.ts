import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import { getAgentPreview } from './service';

const log = createLogger('AgentPreview');
const router = Router();

/**
 * GET /api/agent-preview/:agentId
 *
 * Public (no auth): the link-preview fetcher for iMessage/Linq has no session.
 * Returns { title, state } only; 404 for unknown or deleted agents.
 */
router.get(
  '/:agentId',
  asyncHandler(async (req, res) => {
    const startedAt = Date.now();
    const preview = await getAgentPreview(req.params.agentId);
    res.set('Cache-Control', 'no-store');
    if (!preview) {
      res.status(404).json({ error: 'Agent not found' });
    } else {
      res.json(preview);
    }
    log.info('[AgentPreview] GET', {
      agentId: req.params.agentId,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  })
);

export default router;
