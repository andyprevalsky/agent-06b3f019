import { Router } from 'express';
import { requireCredentialMintSession } from '../../providers/credentialMintAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { authenticate, type AuthRequest } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import * as service from './service';
import { NotFoundError, ForbiddenError } from './service';

const log = createLogger('ApiKeys');
const router = Router();

/**
 * GET /api/api-keys
 * List all API keys for the authenticated user (masked)
 */
router.get(
  '/',
  authenticate,
  asyncHandler<AuthRequest>(async (req, res) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const result = await service.listKeys(req.user.id);
      res.json(result);
    } catch (error) {
      log.error('Error listing API keys', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to list API keys' });
    }
  })
);

/**
 * POST /api/api-keys
 * Generate a new API key for the authenticated user
 */
router.post(
  '/',
  authenticate,
  requireCredentialMintSession,
  asyncHandler<AuthRequest>(async (req, res) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const { name } = req.body;
      const result = await service.generateKey(req.user.id, name);

      // Return the full API key (only shown once)
      res.json(result);
    } catch (error) {
      if (error instanceof ForbiddenError) {
        res.status(403).json({
          error: 'Active subscription required',
          message: 'API access requires an active subscription. Visit roselabs.ai to subscribe.',
        });
        return;
      }
      log.error('Error generating API key', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to generate API key' });
    }
  })
);

/**
 * DELETE /api/api-keys/:id
 * Delete an API key
 */
router.delete(
  '/:id',
  authenticate,
  asyncHandler<AuthRequest>(async (req, res) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const result = await service.deleteKey(req.user.id, req.params.id);
      res.json(result);
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      log.error('Error deleting API key', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to delete API key' });
    }
  })
);

export default router;
