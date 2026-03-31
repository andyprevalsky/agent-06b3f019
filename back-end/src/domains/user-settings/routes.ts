/**
 * User-settings routes — thin controller layer.
 *
 * GET  /api/user-settings   - Get user data
 * PUT  /api/user-settings   - Update user data (upsert)
 * PATCH /api/user-settings  - Partially update user data
 */

import { type Response, Router } from 'express';
import { z } from 'zod';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import { getUserSettings, updateUserSettings, patchUserSettings, parseUpdateBody } from './service';

const log = createLogger('UserSettings');
const router = Router();

// GET /api/user-settings - Get user data
router.get(
  '/',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      // For internal calls (API key auth), get user_id from X-User-Id header
      // For user calls (JWT auth), get from req.user
      const userId = req.isInternal === true ? (req.headers['x-user-id'] as string) : req.user?.id;

      if (userId === undefined || userId === '') {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const result = await getUserSettings(userId);
      res.json(result);
    } catch (error) {
      log.error('Failed to fetch user data', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to fetch user data' });
    }
  })
);

// PUT /api/user-settings - Update user data (upsert)
router.put(
  '/',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const body = parseUpdateBody(req.body);
      const result = await updateUserSettings(userId, body);
      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid request body', details: error.errors });
        return;
      }
      log.error('Failed to update user data', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to update user data' });
    }
  })
);

// PATCH /api/user-settings - Partially update user data
router.patch(
  '/',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const body = parseUpdateBody(req.body);
      const result = await patchUserSettings(userId, body);
      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid request body', details: error.errors });
        return;
      }
      log.error('Failed to update user data', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to update user data' });
    }
  })
);

export default router;
