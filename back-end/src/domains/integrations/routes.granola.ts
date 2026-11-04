/**
 * Granola integration routes (one-click OAuth via Granola's MCP server; meetings
 * sync into grep documents).
 *
 *   GET    /api/integrations/granola                 connection + sync status, document counts
 *   POST   /api/integrations/granola/oauth/start     { redirectUri } → { authorizeUrl }
 *   POST   /api/integrations/granola/oauth/complete  { code, state } from the frontend
 *                                                    callback page; starts a sync
 *   POST   /api/integrations/granola/sync            start a sync now
 *   DELETE /api/integrations/granola                 disconnect and delete synced documents
 */

import { type Response, Router } from 'express';
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
import { isAllowedRedirectUrl } from './oauthService';

const log = createLogger('Integrations');
const router = Router();


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

/**
 * Granola returns the browser to this Rose frontend page, which posts the code
 * to /oauth/complete with the user's own session. Only the frontend's own
 * callback path on an allowed origin is accepted.
 */
export const GRANOLA_CALLBACK_PATH = '/integrations/granola/callback';

function isAllowedGranolaRedirect(value: unknown): value is string {
  if (typeof value !== 'string' || !isAllowedRedirectUrl(value)) return false;
  try {
    const url = new URL(value);
    return url.pathname === GRANOLA_CALLBACK_PATH && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

router.post(
  '/granola/oauth/start',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const userId = resolveUserId(req);
    if (userId === undefined) return res.status(401).json({ error: 'User not authenticated' });
    const redirectUri = (req.body as { redirectUri?: unknown } | undefined)?.redirectUri;
    if (!isAllowedGranolaRedirect(redirectUri)) {
      return res.status(400).json({ error: 'REDIRECT_URI_NOT_ALLOWED' });
    }
    try {
      const { authorizeUrl } = await startGranolaSignIn(userId, { redirectUri });
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

router.post(
  '/granola/oauth/complete',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const userId = resolveUserId(req);
    if (userId === undefined) return res.status(401).json({ error: 'User not authenticated' });
    const body = (req.body ?? {}) as { code?: unknown; state?: unknown };
    if (typeof body.code !== 'string' || body.code === '' || typeof body.state !== 'string') {
      return res.status(400).json({ error: 'CODE_AND_STATE_REQUIRED' });
    }
    try {
      await completeGranolaSignIn(userId, body.state, body.code);
    } catch (err) {
      log.warn('Granola sign-in completion failed', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof GranolaSignInError) {
        const status = err.code === 'EXCHANGE_FAILED' ? 502 : 400;
        return res.status(status).json({ error: err.code, message: err.message });
      }
      throw err;
    }
    startSync(userId);
    return res.json(await getGranolaStatus(userId));
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
