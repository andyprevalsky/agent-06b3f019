/**
 * Granola integration routes (one-click OAuth via Granola's MCP server; meetings
 * sync into grep documents).
 *
 *   GET    /api/integrations/granola                 connection + sync status, document counts
 *   POST   /api/integrations/granola/oauth/start     { returnUrl } → { authorizeUrl }
 *   GET    /api/integrations/granola/oauth/callback  Granola redirects here; starts a sync
 *   POST   /api/integrations/granola/sync            start a sync now
 *   DELETE /api/integrations/granola                 disconnect and delete synced documents
 */

import { type Request, type Response, Router } from 'express';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  GranolaSignInError,
  completeGranolaSignIn,
  disconnectGranola,
  getGranolaStatus,
  startGranolaSignIn,
  syncGranolaUser,
} from '../../services/integrations/granolaSync';
import { BACKEND_BASE_URL } from './config';
import { isAllowedRedirectUrl, sendOAuthResult } from './oauthService';

const log = createLogger('Integrations');
const router = Router();

export const GRANOLA_REDIRECT_URI = `${BACKEND_BASE_URL}/api/integrations/granola/oauth/callback`;

function resolveUserId(req: AuthRequest): string | undefined {
  const id = req.isInternal === true ? req.headers['x-user-id'] : req.user?.id;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
}

/** Fire-and-forget: the sync outlives the request and records its own outcome. */
function startSync(userId: string): void {
  void syncGranolaUser(userId).catch((error: unknown) =>
    log.error('Granola background sync crashed', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    })
  );
}

router.get(
  '/granola',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = resolveUserId(req);
    if (userId === undefined) return res.status(401).json({ error: 'User not authenticated' });
    return res.json(await getGranolaStatus(userId));
  })
);

router.post(
  '/granola/oauth/start',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const userId = resolveUserId(req);
    if (userId === undefined) return res.status(401).json({ error: 'User not authenticated' });
    const returnUrl = (req.body as { returnUrl?: unknown } | undefined)?.returnUrl;
    if (
      returnUrl !== undefined &&
      (typeof returnUrl !== 'string' || !isAllowedRedirectUrl(returnUrl))
    ) {
      return res.status(400).json({ error: 'RETURN_URL_NOT_ALLOWED' });
    }
    try {
      const { authorizeUrl } = await startGranolaSignIn(userId, {
        redirectUri: GRANOLA_REDIRECT_URI,
        returnUrl: returnUrl ?? null,
      });
      return res.json({ authorizeUrl });
    } catch (error) {
      log.warn('Granola sign-in start failed', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(502).json({ error: 'GRANOLA_UNAVAILABLE' });
    }
  })
);

router.get(
  '/granola/oauth/callback',
  asyncHandler(async (req: Request, res: Response) => {
    const { code, state, error } = req.query;
    if (typeof error === 'string') {
      return sendOAuthResult(res, {
        title: 'Granola Connection',
        success: false,
        message: `Granola sign-in ${error}`,
      });
    }
    if (typeof code !== 'string' || typeof state !== 'string') {
      return sendOAuthResult(res, {
        title: 'Granola Connection',
        success: false,
        message: 'Missing Granola sign-in code',
      });
    }
    try {
      const result = await completeGranolaSignIn(state, code);
      startSync(result.userId);
      return sendOAuthResult(res, {
        title: 'Granola Connection',
        success: true,
        message: 'Granola connected',
        returnUrl: result.returnUrl,
      });
    } catch (err) {
      const message =
        err instanceof GranolaSignInError && err.code !== 'EXCHANGE_FAILED'
          ? err.message
          : 'Could not connect Granola. Please try again.';
      log.warn('Granola sign-in callback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return sendOAuthResult(res, {
        title: 'Granola Connection',
        success: false,
        message,
      });
    }
  })
);

router.post(
  '/granola/sync',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = resolveUserId(req);
    if (userId === undefined) return res.status(401).json({ error: 'User not authenticated' });
    const status = await getGranolaStatus(userId);
    if (!status.connected) return res.status(404).json({ error: 'GRANOLA_NOT_CONNECTED' });
    startSync(userId);
    return res.status(202).json(status);
  })
);

router.delete(
  '/granola',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = resolveUserId(req);
    if (userId === undefined) return res.status(401).json({ error: 'User not authenticated' });
    return res.json(await disconnectGranola(userId));
  })
);

export default router;
