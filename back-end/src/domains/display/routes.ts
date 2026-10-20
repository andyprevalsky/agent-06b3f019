/**
 * POST /api/display/:agentId — post images/videos inline in that agent's
 * trajectory (the `display` tool and the sandbox `rose-display` CLI).
 *
 * Auth:
 *   Bearer rdsp.<token>  sandbox CLI token scoped to ONE agent (403 for others)
 *   X-API-Key            agents worker (internal); X-User-Id must own the agent
 *   user JWT             the agent's owner
 */
import { Router, type NextFunction, type Response } from 'express';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { isDisplayToken, verifyDisplayToken } from '../../providers/display/displayToken';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service';
import { displayAgentIdSchema, displayRequestSchema } from './types';

const log = createLogger('DisplayRoutes');
const router = Router();

interface DisplayRequest extends HybridAuthRequest {
  displayTokenAgentId?: string;
}

/** Display token OR normal hybrid auth. */
function displayAuth(req: DisplayRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!isDisplayToken(bearer)) {
    void hybridAuth(req, res, next);
    return;
  }
  const check = verifyDisplayToken(bearer);
  if (!check.ok) {
    log.warn('Rejected display token', { reason: check.reason });
    res.status(401).json({ error: `Invalid display token (${check.reason})` });
    return;
  }
  req.userId = check.userId;
  req.isInternal = false;
  req.displayTokenAgentId = check.agentId;
  next();
}

router.post(
  '/:agentId',
  displayAuth,
  asyncHandler<DisplayRequest>(async (req, res) => {
    const agentId = displayAgentIdSchema.safeParse(req.params.agentId);
    if (!agentId.success) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    if (req.displayTokenAgentId !== undefined && req.displayTokenAgentId !== agentId.data) {
      res.status(403).json({ error: 'Display token is scoped to a different agent' });
      return;
    }
    const parsed = displayRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid body',
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      return;
    }
    const actorUserId = typeof req.userId === 'string' && req.userId.length > 0 ? req.userId : null;
    if (actorUserId === null && req.isInternal !== true) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    try {
      const result = await service.displayMedia({
        agentId: agentId.data,
        actorUserId,
        body: parsed.data,
        via:
          req.displayTokenAgentId !== undefined
            ? 'cli'
            : req.isInternal === true
              ? 'agent'
              : 'user',
      });
      res.status(result.posted_count > 0 ? 201 : 200).json(result);
    } catch (err) {
      if (err instanceof service.DisplayError) {
        res
          .status(err.status)
          .json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
        return;
      }
      throw err;
    }
  })
);

export default router;
