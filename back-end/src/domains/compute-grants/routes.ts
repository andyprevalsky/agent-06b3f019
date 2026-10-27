/**
 * HTTP surface for connected compute accounts (the FE chips).
 *
 * Exposes CONNECTIONS only. Grants are never returned: they churn on their own
 * and surfacing them would invite users to act on something already self-healing.
 */

import { Router, type Response } from 'express';
import { ZodError } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { createLogger } from '../../providers/logger';
import * as service from './service';
import { NotFoundError } from './service';
import { connectAccountSchema } from './types';
import {
  cancelConnectSession,
  ConnectError,
  pollConnectSession,
  startConnectSession,
} from './connectSession';

const log = createLogger('ComputeGrants');
const router = Router();

function mapError(error: unknown, res: Response): void {
  if (error instanceof ConnectError) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof NotFoundError) {
    res.status(404).json({ error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  log.error('route_error', { error: message });
  res.status(500).json({ error: 'Internal server error' });
}

/** GET /api/compute-accounts?provider=claude -- chips for the current user. */
router.get(
  '/',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = req.userId;
    if (userId === undefined) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const provider = typeof req.query.provider === 'string' ? req.query.provider : undefined;
    try {
      res.json({ accounts: await service.listConnectedAccounts(userId, provider) });
    } catch (error) {
      mapError(error, res);
    }
  })
);

/**
 * POST /api/compute-accounts -- connect an account, or refresh its session.
 *
 * Idempotent per (provider, accountId): calling it again updates that account
 * rather than creating a duplicate, and a fresh session clears needs_reconnect.
 */
router.post(
  '/',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = req.userId;
    if (userId === undefined) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const input = connectAccountSchema.parse(req.body);
      res.status(201).json(await service.connectAccount(userId, input));
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({ error: error.errors[0]?.message ?? 'Invalid request' });
        return;
      }
      mapError(error, res);
    }
  })
);

/**
 * DELETE /api/compute-accounts/:provider/:accountId -- remove one chip.
 *
 * Scoped to a single account so the others are provably untouched.
 */
router.delete(
  '/:provider/:accountId',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = req.userId;
    if (userId === undefined) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      await service.disconnectAccount(userId, req.params.provider, req.params.accountId);
      res.status(204).send();
    } catch (error) {
      mapError(error, res);
    }
  })
);

/**
 * POST /api/compute-accounts/connect -- open a cloud browser for sign-in.
 *
 * Returns a live-view URL the FE embeds. This is the only step needing a human:
 * every later mint runs unattended from the session captured here.
 */
router.post(
  '/connect',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = req.userId;
    if (userId === undefined) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const provider = typeof req.body?.provider === 'string' ? req.body.provider : '';
      res.status(201).json(await startConnectSession(userId, provider));
    } catch (error) {
      mapError(error, res);
    }
  })
);

/** GET /api/compute-accounts/connect/:connectId -- poll until sign-in completes. */
router.get(
  '/connect/:connectId',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = req.userId;
    if (userId === undefined) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      res.json(await pollConnectSession(userId, req.params.connectId));
    } catch (error) {
      mapError(error, res);
    }
  })
);

/**
 * DELETE /api/compute-accounts/connect/:connectId -- abandon a sign-in.
 *
 * Explicit cancel matters: a remote browser bills until released, and users
 * abandon sign-in far more often than they finish it.
 */
router.delete(
  '/connect/:connectId',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = req.userId;
    if (userId === undefined) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      await cancelConnectSession(userId, req.params.connectId);
      res.status(204).send();
    } catch (error) {
      mapError(error, res);
    }
  })
);

export default router;
