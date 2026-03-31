/**
 * People routes — thin controller layer.
 *
 * POST /api/people/search     - Semantic search for people by signals
 * POST /api/people             - Create or merge a person
 * GET  /api/people             - List people (paginated, sorted, searchable)
 * POST /api/people/messages    - Get message history for a person
 * GET  /api/people/messages/recent - Get recent messages across all people
 * GET  /api/people/:id         - Get a single person
 * DELETE /api/people/:id       - Delete a person
 */

import { type Response, Router } from 'express';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  searchPeople,
  createOrMergePerson,
  listPeople,
  getPersonById,
  deletePerson,
  getPersonMessages,
  getRecentMessages,
  ValidationError,
  NotFoundError,
} from './service';

const log = createLogger('People');
const router = Router();

function resolveUserId(req: AuthRequest): string | undefined {
  if (req.isInternal === true) {
    const header = req.headers['x-user-id'];
    return typeof header === 'string' ? header : undefined;
  }
  return req.user?.id;
}

/**
 * POST /api/people/search
 */
router.post(
  '/search',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const userId = resolveUserId(req);
      if (userId === undefined || userId === '') {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const limitStr = req.query.limit;
      const limit = typeof limitStr === 'string' ? parseInt(limitStr, 10) : undefined;
      const result = await searchPeople(userId, req.body, Number.isNaN(limit) ? undefined : limit);
      res.json(result);
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      log.error('Error searching people', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({
        error: 'Failed to search people',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
);

/**
 * POST /api/people
 */
router.post(
  '/',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user?.id;
      if (userId === undefined || userId === '') {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const result = await createOrMergePerson(userId, req.body);

      if (result.merged) {
        res.json({ person: result.person, merged: true, reason: result.reason });
      } else {
        res.status(201).json({ person: result.person, merged: false });
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      log.error('Error creating person', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({
        error: 'Failed to create person',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
);

/**
 * GET /api/people
 */
router.get(
  '/',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const userId = resolveUserId(req);
      if (userId === undefined || userId === '') {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const pageStr = req.query.page;
      const limitStr = req.query.limit;
      const result = await listPeople(userId, {
        page: typeof pageStr === 'string' ? parseInt(pageStr, 10) : undefined,
        limit: typeof limitStr === 'string' ? parseInt(limitStr, 10) : undefined,
        sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
        sortDirection: typeof req.query.sortDirection === 'string' ? req.query.sortDirection : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
      });

      res.json(result);
    } catch (error) {
      log.error('Error fetching people', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({
        error: 'Failed to fetch people',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
);

/**
 * POST /api/people/messages
 */
router.post(
  '/messages',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.isInternal === true ? (req.body.user_id as string | undefined) : req.user?.id;
      if (userId === undefined || userId === null || userId === '') {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const result = await getPersonMessages(userId, req.body);
      res.json(result);
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      log.error('Error fetching message history', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({
        error: 'Failed to fetch message history',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
);

/**
 * GET /api/people/messages/recent
 */
router.get(
  '/messages/recent',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const userId = resolveUserId(req);
      if (userId === undefined || userId === '') {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const limitStr = req.query.limit;
      const daysStr = req.query.days;
      const result = await getRecentMessages(userId, {
        limit: typeof limitStr === 'string' ? parseInt(limitStr, 10) : undefined,
        days: typeof daysStr === 'string' ? parseInt(daysStr, 10) : undefined,
      });

      res.json(result);
    } catch (error) {
      log.error('Error fetching recent messages', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({
        error: 'Failed to fetch recent messages',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
);

/**
 * GET /api/people/:id
 */
router.get(
  '/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user?.id;
      if (userId === undefined || userId === '') {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const person = await getPersonById(req.params.id, userId);
      res.json({ person });
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      log.error('Error fetching person', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({
        error: 'Failed to fetch person',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
);

/**
 * DELETE /api/people/:id
 */
router.delete(
  '/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user?.id;
      if (userId === undefined || userId === '') {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      await deletePerson(req.params.id, userId);
      res.json({ message: 'Person deleted successfully' });
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      log.error('Error deleting person', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({
        error: 'Failed to delete person',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
);

export default router;
