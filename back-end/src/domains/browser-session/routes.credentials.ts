/**
 * Realm-transition credential preparation route.
 *
 * POST /api/browser-session/:sessionId/prepare-auth
 */

import { type Response, type Router } from 'express';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import { prepareSessionCredentials, SessionNotFoundError } from './service';
import { prepareSessionCredentialsSchema } from './types';

const log = createLogger('BrowserSession');
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

export function registerBrowserCredentialRoutes(router: Router): void {
  router.post(
    '/:sessionId/prepare-auth',
    auth,
    asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
      try {
        const userId = req.userId;
        if (userId === undefined || userId === '') {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }
        const { target_url: targetUrl } = prepareSessionCredentialsSchema.parse(req.body);
        const result = await prepareSessionCredentials(req.params.sessionId, userId, targetUrl);
        res.json({ success: true, ...result });
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          res.status(404).json({ error: error.message });
          return;
        }
        log.error('Failed to prepare browser credentials', {
          sessionId: req.params.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Failed to prepare browser credentials',
        });
      }
    })
  );
}
