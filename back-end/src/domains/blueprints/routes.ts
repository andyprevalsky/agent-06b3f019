/**
 * Blueprints routes -- thin controller layer.
 *
 * POST   /api/blueprints/search      - Search blueprints by goal similarity
 * POST   /api/blueprints             - Save a new blueprint
 * GET    /api/blueprints             - List user's blueprints
 * GET    /api/blueprints/by-goal     - Find blueprint by goal text
 * DELETE /api/blueprints/:id         - Delete a blueprint
 * PATCH  /api/blueprints/:id/feedback - Submit feedback for a blueprint
 */

import { type Request, type Response, Router } from 'express';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  searchByGoal,
  createBlueprint,
  listBlueprints,
  findByGoal,
  deleteBlueprint,
  submitFeedback,
  EmbeddingError,
} from './service';

const log = createLogger('Blueprints');
const router = Router();

/**
 * Search blueprints by goal similarity using embeddings
 * POST /api/blueprints/search
 * Auth: API Key (internal service-to-service)
 */
router.post(
  '/search',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const { goal, limit = 3, user_id } = req.body;
      const userId = req.isInternal === true ? (user_id as string | undefined) : req.user?.id;

      if (userId === undefined || userId === null) {
        res.status(401).json({ error: 'Unauthorized: user_id required' });
        return;
      }

      if (goal === undefined || goal === null || goal === '') {
        res.status(400).json({ error: 'Goal is required' });
        return;
      }

      const results = await searchByGoal(userId, goal as string, limit as number);
      res.json(results);
    } catch (error) {
      log.error('Blueprint search error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to search blueprints' });
    }
  })
);

/**
 * Save a new blueprint
 * POST /api/blueprints
 * Auth: API Key (internal service-to-service)
 */
router.post(
  '/',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const { title, blueprint, user_id } = req.body;
      const userId = req.isInternal === true ? (user_id as string | undefined) : req.user?.id;

      if (userId === undefined || userId === null) {
        res.status(401).json({ error: 'Unauthorized: user_id required' });
        return;
      }

      if (
        title === undefined ||
        title === null ||
        title === '' ||
        blueprint === undefined ||
        blueprint === null
      ) {
        res.status(400).json({ error: 'Title and blueprint are required' });
        return;
      }

      const saved = await createBlueprint(userId, title as string, blueprint);
      res.status(201).json(saved);
    } catch (error) {
      if (error instanceof EmbeddingError) {
        res.status(500).json({ error: 'Failed to generate embedding for blueprint' });
        return;
      }
      log.error('Blueprint save error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to save blueprint' });
    }
  })
);

/**
 * Get user's blueprints
 * GET /api/blueprints
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthRequest;
      const userId = authReq.user?.id;

      if (userId === undefined || userId === null) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const blueprints = await listBlueprints(userId);
      res.json(blueprints);
    } catch (error) {
      log.error('Blueprint list error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to list blueprints' });
    }
  })
);

/**
 * Find blueprint by goal text (for feedback association)
 * GET /api/blueprints/by-goal?goal=...
 * Auth: JWT
 */
router.get(
  '/by-goal',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user?.id;
      const { goal } = req.query;

      if (userId === undefined || userId === null) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      if (goal === undefined || goal === null || typeof goal !== 'string' || goal === '') {
        res.status(400).json({ error: 'Goal is required' });
        return;
      }

      const blueprint = await findByGoal(userId, goal);

      if (blueprint === null) {
        res.status(404).json({ error: 'Blueprint not found' });
        return;
      }

      res.json(blueprint);
    } catch (error) {
      log.error('Blueprint lookup error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to find blueprint' });
    }
  })
);

/**
 * Delete a blueprint
 * DELETE /api/blueprints/:id
 */
router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const authReq = req as AuthRequest;
      const userId = authReq.user?.id;

      if (userId === undefined || userId === null) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const result = await deleteBlueprint(id, userId);

      if (result === null) {
        res.status(404).json({ error: 'Blueprint not found' });
        return;
      }

      res.status(204).send();
    } catch (error) {
      log.error('Blueprint delete error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to delete blueprint' });
    }
  })
);

/**
 * Submit feedback for a blueprint
 * PATCH /api/blueprints/:id/feedback
 * Auth: JWT
 */
router.patch(
  '/:id/feedback',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const userId = req.user?.id;
      const { rating, issueType, comment, helpImprove, agentId } = req.body;

      if (userId === undefined || userId === null) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      if (
        rating === undefined ||
        rating === null ||
        (rating as number) < 1 ||
        (rating as number) > 5
      ) {
        res.status(400).json({ error: 'Rating must be between 1 and 5' });
        return;
      }

      const updated = await submitFeedback(id, userId, {
        rating: rating as number,
        issueType: issueType as string | undefined,
        comment: comment as string | undefined,
        helpImprove: helpImprove as boolean | undefined,
        agentId: agentId as string | undefined,
      });

      if (updated === null) {
        res.status(404).json({ error: 'Blueprint not found' });
        return;
      }

      res.json(updated);
    } catch (error) {
      log.error('Blueprint feedback error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to submit feedback' });
    }
  })
);

export default router;
