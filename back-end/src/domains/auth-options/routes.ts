/**
 * Auth-options routes.
 */

import { Router } from 'express';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import { getAuthOptions, markSteelSessionAuthFailed } from './service';

const router = Router();
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);
const log = createLogger('AuthOptions');

router.get(
  '/',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const userId = req.userId;
      const realm = req.query.realm;
      if (typeof userId !== 'string' || userId === '') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      if (typeof realm !== 'string' || realm.trim() === '') {
        res.status(400).json({ error: 'realm query parameter is required' });
        return;
      }
      res.json(await getAuthOptions(userId, realm));
    } catch (error) {
      log.error('Failed to resolve auth options', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to resolve auth options' });
    }
  })
);

router.post(
  '/steel-sessions/:id/auth-failed',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const userId = req.userId;
      const body = req.body as Record<string, unknown>;
      const reason = body.reason;
      if (typeof userId !== 'string' || userId === '') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      if (typeof reason !== 'string' || reason.trim() === '') {
        res.status(400).json({ error: 'reason is required' });
        return;
      }

      const result = await markSteelSessionAuthFailed(userId, req.params.id, reason);
      if (result === null) {
        res.status(404).json({ error: 'Steel session auth not found' });
        return;
      }
      res.json({ steelSessionAuth: result });
    } catch (error) {
      log.error('Failed to mark Steel session auth failed', {
        steelSessionAuthId: req.params.id,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to mark Steel session auth failed' });
    }
  })
);

export default router;
